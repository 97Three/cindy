import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { saveAppDownload } from '../downloadFile.js';

// Draft ui/download-file. Tier: unit. Minimum missing cases: embedded bytes,
// a granted file stream, dialog cancellation, and a revoked View before publication.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
it('saves embedded text only after the dialog confirms a sanitized name', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-app-download-')); roots.push(root);
  const showSaveDialog = vi.fn(async () => path.join(root, 'chosen.txt'));
  await saveAppDownload({ content: { type: 'resource', resource: { uri: 'file:///untrusted/NUL.txt', text: 'small' } },
    showSaveDialog, readGranted: vi.fn(), assertCurrent: async () => {}, signal: new AbortController().signal });
  expect(showSaveDialog).toHaveBeenCalledWith('download');
  expect(await fs.readFile(path.join(root, 'chosen.txt'), 'utf8')).toBe('small');
});
it('does not read a ResourceLink after cancellation and does not publish after revocation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-app-download-')); roots.push(root);
  const abort = new AbortController();
  const readGranted = vi.fn(async () => new Response('owned'));
  const input = { content: { type: 'resource_link' as const, name: 'report.txt', uri: 'library:report.txt' },
    readGranted, assertCurrent: async () => {}, signal: abort.signal };
  expect(await saveAppDownload({ ...input, showSaveDialog: async () => null })).toEqual({ isError: true });
  expect(readGranted).not.toHaveBeenCalled();
  await expect(saveAppDownload({ ...input, showSaveDialog: async () => { abort.abort(); return path.join(root, 'report.txt'); } })).rejects.toThrow();
  expect(await fs.readdir(root)).toEqual([]);
});
