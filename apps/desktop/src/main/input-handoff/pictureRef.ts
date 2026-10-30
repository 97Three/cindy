import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as blobStore from '../cindy-media/blobStore.js';
import * as imageCacheStore from '../imageCacheStore.js';

/**
 * Reads the screenshot an agent passes to ask_owner(kind="scan"): a local
 * image path (relative to the task folder) or a managed media URL. The bytes
 * only feed the host's QR reader; nothing from them goes back to the agent.
 */

const MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);

export type HandoffPictureRead =
  | { ok: true; bytes: Buffer }
  | { ok: false; errorCode: 'IMAGE_NOT_FOUND' | 'NOT_AN_IMAGE'; message: string };

const notFound = (): HandoffPictureRead => ({
  ok: false,
  errorCode: 'IMAGE_NOT_FOUND',
  message: 'Cindy cannot read that picture. Pass the path of a PNG or JPEG screenshot (absolute, or relative to the task folder), or a cindy-media:// URL.',
});

function localPath(ref: string, workingDir: string | undefined): string | null {
  try {
    if (ref.startsWith('cindy-media://')) return blobStore.parseBlobUrl(ref) ? blobStore.resolveSafe(ref).absPath : null;
    if (ref.startsWith('xdt-image://')) return imageCacheStore.resolveSafe(ref).absPath;
    if (ref.startsWith('file://')) return fileURLToPath(ref);
  } catch {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return null;
  if (path.isAbsolute(ref)) return ref;
  return workingDir ? path.resolve(workingDir, ref) : null;
}

export async function readHandoffPicture(ref: string, workingDir: string | undefined): Promise<HandoffPictureRead> {
  const file = localPath(ref.trim(), workingDir);
  if (!file) return notFound();
  const managed = ref.startsWith('cindy-media://') || ref.startsWith('xdt-image://');
  if (!managed && !IMAGE_EXT.has(path.extname(file).toLowerCase())) {
    return { ok: false, errorCode: 'NOT_AN_IMAGE', message: 'Pass a PNG or JPEG screenshot.' };
  }
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) return notFound();
    return { ok: true, bytes: await fs.readFile(file) };
  } catch {
    return notFound();
  }
}
