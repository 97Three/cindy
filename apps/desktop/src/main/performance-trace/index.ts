import { app, BrowserWindow, ipcMain, shell, type WebContents } from 'electron';
import { mkdir, writeFile, rename, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  PERFORMANCE_TRACE_CHANNEL,
  PERFORMANCE_TRACE_EVENTS_CHANNEL,
  PERFORMANCE_TRACE_STATE_CHANNEL,
} from '../../shared/performanceTrace';
import {
  activeOwnerScopeKey,
  onAppSessionInvalidated,
  ownerScopedUserDataPath,
} from '../appSessionState';
import { onQuit } from '../lifecycle';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../security/trustedAppRenderer';
import { throwIpcError } from '../utils/ipcValidate';
import { uploadPerformanceTraceReport } from '../log-upload';
import { generateUploadCode } from '../log-upload/uploadCode';
import { PerformanceTraceController, type TraceCapture } from './controller';
import { beginNativeTrace } from './capture';
import { createTraceCommandHandler } from './ipc';
import { readTraceArtifacts } from './artifacts';

let registered = false;

export function initPerformanceTraceService(): void {
  if (registered) return;
  registered = true;
  // Capture the owner's path at start; a later account switch must not redirect the save.
  const directories = new Map<string, string>();
  const directory = (id: string) => {
    const result = directories.get(id);
    if (!result) throw new Error('Unknown recording');
    return result;
  };
  let source: WebContents | null = null;
  const controller = new PerformanceTraceController({
    now: Date.now,
    owner: activeOwnerScopeKey,
    reportId: () => generateUploadCode((size) => crypto.randomBytes(size)),
    environment: () => ({
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
    }),
    changed: (state) => {
      if (
        source &&
        !source.isDestroyed() &&
        isTrustedAppRendererWindow(BrowserWindow.fromWebContents(source))
      )
        source.send(PERFORMANCE_TRACE_STATE_CHANNEL, state);
    },
    save: async (report) => {
      const dir = directory(report.reportId);
      await mkdir(dir, { recursive: true });
      const temporary = path.join(dir, 'report.json.tmp');
      await writeFile(temporary, JSON.stringify(report), { mode: 0o600 });
      await rename(temporary, path.join(dir, 'report.json'));
    },
    upload: (report, note) =>
      uploadPerformanceTraceReport(report, note, () =>
        readTraceArtifacts(directory(report.reportId)),
      ),
    reveal: async (id) => {
      shell.showItemInFolder(path.join(directory(id), 'report.json'));
    },
    begin: async (id, startedAt): Promise<TraceCapture> => {
      const root = ownerScopedUserDataPath('diagnostics', 'performance-traces');
      const dir = path.join(root, id);
      directories.clear();
      directories.set(id, dir);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // Only expired directories minted by this feature; exported copies are never touched.
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (
          !entry.isDirectory() ||
          !/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/.test(
            entry.name,
          )
        )
          continue;
        const old = path.join(root, entry.name);
        try {
          if (Date.now() - (await stat(old)).mtimeMs > 7 * 86400_000)
            await rm(old, { recursive: true, force: true });
        } catch {
          /* Retention failures must not prevent recording a new incident. */
        }
      }
      return beginNativeTrace({
        dir,
        source: source!,
        startedAt,
        getOwner: activeOwnerScopeKey,
        onSample: (sample) => controller.sample(sample),
        onEvent: (events) => controller.events(events),
        onStop: () => controller.close(),
      });
    },
  });
  ipcMain.handle(
    PERFORMANCE_TRACE_CHANNEL,
    createTraceCommandHandler({
      controller,
      authorize: assertTrustedAppRendererEvent,
      isSource: (event) => source === event.sender,
      selectSource: (event) => {
        source = event.sender;
      },
      showFolder: async () => {
        const root = ownerScopedUserDataPath('diagnostics', 'performance-traces');
        await mkdir(root, { recursive: true });
        if (await shell.openPath(root))
          throwIpcError('INTERNAL', 'Could not open local recordings');
      },
    }),
  );
  ipcMain.on(PERFORMANCE_TRACE_EVENTS_CHANNEL, (event, values: unknown) => {
    if (
      !isTrustedAppRendererEvent(event) ||
      event.sender !== source ||
      !Array.isArray(values) ||
      values.length > 100
    )
      return;
    controller.events(values);
  });
  onQuit('performance-trace', () => controller.close(), 'async');
  onAppSessionInvalidated(() => {
    void controller.close();
  });
}
