import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importPickedFiles, type PickedFilesDeps } from '../pickedFiles.js';
import { LibraryVault } from '../libraryVault.js';
import { GHOST_CINDY_DEPOSIT_MAX_BYTES } from '../../../shared/ghost.js';

// B2 production importer, tier: unit. Existing pick tests only cover dialog consent.
// Minimum failures: a normal file, an oversize sparse file, and cancellation during streaming.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-picked-files-'));
  roots.push(root);
  const vault = new LibraryVault({ rootDir: () => path.join(root, 'library'), ghostId: 'plugin' });
  await vault.open();
  const progress = vi.fn();
  const deposit = vi.fn(async (_id: string, file: string) => {
    expect(await fs.readFile(file)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    return { url: 'cindy-media://blobs/fixture.png' };
  });
  const deps: PickedFilesDeps = { tempRoot: root, usageBytes: async () => 0, deposit,
    importLibrary: async (_id, input) => {
      const result = await vault.importStream(input);
      return result.ok ? { ...result, ref: `library:${result.path}` } : result;
    }, progress: () => progress,
  };
  return { root, deps, deposit, progress };
}
// PR #7924: 42-character generated prefix left only 22 characters for a source name.
// Unit through importPickedFiles + real LibraryVault; old short-name fixture missed rejection.
it.each(['note.txt', 'quarterly-financial-report-2026-final.txt'])('streams %s into the actual Library and preserves its display name', async (name) => {
  const { root, deps, progress } = await fixture();
  const file = path.join(root, name); await fs.writeFile(file, 'user file');
  const result = await importPickedFiles(deps, 'plugin', [file], { into: 'library', assertCurrent() {} });
  expect(result).toMatchObject({ ok: true, files: [{ name, size: 9, mimeType: 'application/octet-stream' }] });
  if (!result.ok) throw new Error('failed');
  const saved = result.files![0]!;
  expect(saved).not.toHaveProperty('path');
  expect(await fs.readFile(path.join(root, 'library', saved.ref!.slice('library:'.length)), 'utf8')).toBe('user file');
  expect(saved.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(progress).toHaveBeenCalledWith(9, undefined, '正在导入文件');
});
it('stages media from a held handle, sniffs bytes and cleans the private staging directory', async () => {
  const { root, deps, deposit } = await fixture();
  const file = path.join(root, 'misleading.txt');
  await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(await importPickedFiles(deps, 'plugin', [file], { into: 'media', assertCurrent() {} })).toMatchObject({ ok: true, files: [{ mimeType: 'image/png' }] });
  expect(deposit).toHaveBeenCalledTimes(1);
  expect((await fs.readdir(root)).filter(name => name.startsWith('cindy-pick-'))).toEqual([]);
  await fs.truncate(file, GHOST_CINDY_DEPOSIT_MAX_BYTES + 1);
  expect(await importPickedFiles(deps, 'plugin', [file], { into: 'media', assertCurrent() {} })).toMatchObject({ ok: false, errorCode: 'TOO_LARGE', limitBytes: GHOST_CINDY_DEPOSIT_MAX_BYTES });
  expect(deposit).toHaveBeenCalledTimes(1);
});

// Same deposit_media byte rules: an ID3 tag beyond the initial probe must not hide a valid MPEG frame.
it('uses the shared bounded MP3 probe for a picked audio file with embedded artwork', async () => {
  const { root, deps } = await fixture();
  const tagSize = 65536;
  const bytes = Buffer.alloc(tagSize + 14);
  bytes.set([0x49, 0x44, 0x33, 4, 0, 0, (tagSize >>> 21) & 127, (tagSize >>> 14) & 127, (tagSize >>> 7) & 127, tagSize & 127]);
  bytes.set([0xff, 0xfb, 0x90, 0x64], tagSize + 10);
  const file = path.join(root, 'audio.mp3'); await fs.writeFile(file, bytes);
  deps.deposit = async (_id, staged, mime) => { expect(mime).toBe('audio/mpeg'); expect(await fs.readFile(staged)).toEqual(bytes); return { url: 'cindy-media://blobs/audio.mp3' }; };
  expect(await importPickedFiles(deps, 'plugin', [file], { into: 'media', assertCurrent() {} })).toMatchObject({ ok: true, files: [{ mimeType: 'audio/mpeg' }] });
});
