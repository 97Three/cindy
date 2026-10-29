import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { redact } from '../log-upload/redact';
import { throwIpcError } from '../utils/ipcValidate';

export const TRACE_ARTIFACT_NAMES = [
  'report.json',
  'chromium-trace.json',
  'main.cpuprofile',
  'renderer.cpuprofile',
] as const;
export type TraceArtifactName = (typeof TRACE_ARTIFACT_NAMES)[number];
export interface TraceArtifact {
  name: TraceArtifactName;
  bytes: Buffer;
}
export const MAX_TRACE_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_TRACE_TOTAL_BYTES = 128 * 1024 * 1024;

/** Only the recording directory selected by main, never paths supplied by a renderer. */
export async function readTraceArtifacts(directory: string): Promise<TraceArtifact[]> {
  const root = await realpath(directory);
  const files: TraceArtifact[] = [];
  let total = 0;
  for (const name of TRACE_ARTIFACT_NAMES) {
    const filename = path.join(root, name);
    let info;
    try {
      info = await lstat(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || (await realpath(filename)) !== filename)
      throwIpcError('LOG_UPLOAD_FAILED', 'Recording file is not a regular local file');
    total += info.size;
    if (info.size > MAX_TRACE_FILE_BYTES || total > MAX_TRACE_TOTAL_BYTES)
      throwIpcError(
        'LOG_UPLOAD_FAILED',
        'Recording exceeds upload limit; local files are preserved',
      );
    const handle = await open(filename, 'r');
    try {
      const opened = await handle.stat();
      if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size)
        throwIpcError('LOG_UPLOAD_FAILED', 'Recording changed before upload');
      const bytes = Buffer.alloc(info.size + 1);
      let read = 0;
      while (read < bytes.length) {
        const next = await handle.read(bytes, read, Math.min(64 * 1024, bytes.length - read), read);
        if (!next.bytesRead) break;
        read += next.bytesRead;
      }
      const after = await handle.stat();
      if (read !== info.size || after.mtimeMs !== info.mtimeMs || after.size !== info.size)
        throwIpcError('LOG_UPLOAD_FAILED', 'Recording changed during upload preparation');
      files.push({ name, bytes: bytes.subarray(0, read) });
    } finally {
      await handle.close();
    }
  }
  return files;
}

/** Preserve every event/sample/field. Redact values rather than raw JSON so replacements
 * cannot corrupt trace syntax. Yield while walking large recordings. */
export async function redactTraceArtifact(bytes: Buffer): Promise<Buffer> {
  const root: unknown = JSON.parse(bytes.toString('utf8'));
  if (!root || typeof root !== 'object')
    throwIpcError('LOG_UPLOAD_FAILED', 'Recording is not a JSON object');
  const stack: Array<Record<string, unknown> | unknown[]> = [root as Record<string, unknown>];
  const sensitiveKeys = new Map<string, boolean>();
  const strings = new Map<string, string>();
  let visited = 0;
  while (stack.length) {
    const node = stack.pop()!;
    const array = Array.isArray(node);
    for (const key of Object.keys(node)) {
      if (++visited % 256 === 0) await setImmediate();
      const record = node as Record<string, unknown>;
      const value = record[key];
      let sensitive = false;
      if (!array) {
        sensitive =
          sensitiveKeys.get(key) ??
          (() => {
            const probe = JSON.stringify({ [key]: 'redaction-probe' });
            const result = redact(probe) !== probe;
            if (sensitiveKeys.size < 256) sensitiveKeys.set(key, result);
            return result;
          })();
      }
      if (sensitive) record[key] = '<redacted:sensitive-field>';
      else if (typeof value === 'string') {
        const cleaned = strings.get(value) ?? redact(value);
        if (strings.size < 1024 && value.length <= 1024) strings.set(value, cleaned);
        record[key] = cleaned;
      } else if (value && typeof value === 'object') stack.push(value as Record<string, unknown>);
    }
  }
  return Buffer.from(JSON.stringify(root));
}
