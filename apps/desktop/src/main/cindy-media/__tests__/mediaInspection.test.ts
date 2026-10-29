import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../localDb/schema';
import type { DbClient } from '../../localDb/client/DbClient';
import { setCurrentDbClient, clearCurrentDbClient } from '../../localDb/client/current';
import { resolveSafe } from '../blobStore';
import { inspectMedia, previewGeneratedImages } from '../mediaInspection';
import * as compressor from '../../mcp-integrations/inlineImageCompressor';

// Production inspectMedia + real ledger queries/files. Existing generation tests
// never decoded the returned URL. Unit tier: scope revocation must drop pixels;
// a failed preview must retain the paid result. Video decoding is separately smoke-tested.
const state = vi.hoisted(() => ({ root: '', owner: 'owner', valid: true, pending: false }));
const extract = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => state.owner,
  isAppSessionBoundaryPending: () => state.pending,
}));
vi.mock('../videoInspection', () => ({ extractVideoFrames: extract }));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWNgYGD4D8UQBgAd9AP9JAD7OgAAAABJRU5ErkJggg==',
  'base64',
);
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
let db: Database.Database;
const context = { sessionId: 's', isCurrent: () => state.valid };
async function media(buffer = PNG, ext = 'png', owner = 's') {
  const hash = createHash('sha256').update(buffer).digest('hex');
  const url = `cindy-media://blobs/${hash}.${ext}`;
  const file = resolveSafe(url).absPath;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buffer);
  db.prepare('INSERT INTO media_refs VALUES (?, ?, ?)').run(hash, 'session-attachment', owner);
  return url;
}
beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-inspection-'));
  state.owner = 'owner';
  state.valid = true;
  state.pending = false;
  extract.mockReset().mockImplementation(async (_bytes, _mime, times: number[]) =>
    times.map((time) => ({
      data: PNG.toString('base64'),
      mimeType: 'image/png',
      time_seconds: time,
    })),
  );
  db = new Database(':memory:');
  db.exec(
    "CREATE TABLE sessions(id TEXT, status TEXT, cleared_at INTEGER); INSERT INTO sessions VALUES('s', 'active', NULL); CREATE TABLE media_refs(hash TEXT, ref_kind TEXT, ref_id TEXT);",
  );
  setCurrentDbClient({ drizzle: drizzle(db, { schema }) } as unknown as DbClient, 'owner');
});
afterEach(async () => {
  vi.restoreAllMocks();
  clearCurrentDbClient();
  db.close();
  await fs.rm(state.root, { recursive: true, force: true });
});

describe('current-task media inspection', () => {
  it.each(['owner', 'clear', 'ref'] as const)(
    'drops the whole batch after %s changes while the second preview is compressed',
    async (change) => {
      const urls = await Promise.all(
        [1, 2].map((value) => media(Buffer.concat([PNG, Buffer.alloc(100_000, value)]))),
      );
      const compress = compressor.compressInlineImage;
      let calls = 0;
      vi.spyOn(compressor, 'compressInlineImage').mockImplementation(async (...args) => {
        const result = await compress(...args);
        if (++calls === 2) {
          if (change === 'owner') state.owner = 'next';
          if (change === 'clear') db.exec('UPDATE sessions SET cleared_at = 1');
          if (change === 'ref') db.exec('DELETE FROM media_refs');
        }
        return result;
      });
      const result = await previewGeneratedImages({ ok: true, xdt_image_urls: urls }, context);
      expect(calls).toBe(2);
      expect(result).toMatchObject({
        ok: true,
        xdt_image_urls: urls,
        preview_errors: expect.any(Array),
      });
      expect(result).not.toHaveProperty('modelImages');
    },
  );
  it('reads real image pixels without revealing a path or creating delivery fields', async () => {
    const url = await media();
    const result = await inspectMedia({ url }, context);
    expect(result).toEqual({
      ok: true,
      previews: [{ url, image_index: 0 }],
      modelImages: [{ data: PNG.toString('base64'), mimeType: 'image/png' }],
    });
    expect(JSON.stringify(result)).not.toContain(state.root);
  });
  it('rejects another task and arbitrary local/remote URLs before reading', async () => {
    const url = await media(PNG, 'png', 'other');
    expect(await inspectMedia({ url }, context)).toMatchObject({
      ok: false,
      errorCode: 'MEDIA_NOT_IN_TASK',
    });
    for (const url of [
      '/tmp/image.png',
      'https://example.test/image.png',
      'cindy-media://blobs/../../x',
    ]) {
      expect(await inspectMedia({ url }, context)).toMatchObject({
        ok: false,
        errorCode: 'INVALID_INPUT',
      });
    }
  });
  it('rejects changed bytes, missing files, and corrupt images without leaking paths', async () => {
    const url = await media();
    await fs.writeFile(resolveSafe(url).absPath, 'wrong bytes');
    expect(await inspectMedia({ url }, context)).toMatchObject({
      errorCode: 'MEDIA_SOURCE_CHANGED',
    });
    await fs.unlink(resolveSafe(url).absPath);
    expect(await inspectMedia({ url }, context)).toMatchObject({
      errorCode: 'MEDIA_PREVIEW_UNAVAILABLE',
    });
    const broken = await media(PNG.subarray(0, 20));
    const result = await inspectMedia({ url: broken }, context);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(state.root);
  });
  it('returns requested video frames with their times and no audio claim', async () => {
    const url = await media(MP4, 'mp4');
    const result = await inspectMedia({ url, timesSeconds: [0, 2, 4] }, context);
    expect(result).toMatchObject({
      ok: true,
      audio_included: false,
      previews: [
        { url, image_index: 0, time_seconds: 0 },
        { url, image_index: 1, time_seconds: 2 },
        { url, image_index: 2, time_seconds: 4 },
      ],
    });
    expect(extract).toHaveBeenCalledWith(MP4, 'video/mp4', [0, 2, 4]);
  });
  it.each(['owner', 'permission', 'clear', 'delete', 'ref', 'pending', 'db'] as const)(
    'drops video frames after %s changes during decoding',
    async (change) => {
      const url = await media(MP4, 'mp4');
      extract.mockImplementation(async () => {
        if (change === 'owner') state.owner = 'next';
        if (change === 'permission') state.valid = false;
        if (change === 'clear') db.exec('UPDATE sessions SET cleared_at = 1');
        if (change === 'delete') db.exec("UPDATE sessions SET status = 'deleted'");
        if (change === 'ref') db.exec('DELETE FROM media_refs');
        if (change === 'pending') state.pending = true;
        if (change === 'db') clearCurrentDbClient();
        return [{ data: PNG.toString('base64'), mimeType: 'image/png', time_seconds: 0 }];
      });
      const result = await inspectMedia({ url }, context);
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('modelImages');
    },
  );
  it('rejects invalid frame requests and reports decoder failure without diagnostics', async () => {
    const url = await media(MP4, 'mp4');
    for (const timesSeconds of [[], [-1], [NaN], [Infinity], [0, 1, 2, 3, 4]]) {
      expect(await inspectMedia({ url, timesSeconds }, context)).toMatchObject({
        errorCode: 'INVALID_INPUT',
      });
    }
    expect(extract).not.toHaveBeenCalled();
    extract.mockRejectedValue(new Error('/private/user/secret.mp4'));
    const result = await inspectMedia({ url }, context);
    expect(result).toMatchObject({ errorCode: 'VIDEO_PREVIEW_FAILED' });
    expect(JSON.stringify(result)).not.toContain('/private');
  });
  it('keeps generation success and all URLs when previews fail or exceed the batch budget', async () => {
    const good = await media();
    const bad = await media(Buffer.from('not an image'));
    const result = await previewGeneratedImages(
      { ok: true, status: 'completed', xdt_image_urls: [bad, good, good] },
      context,
    );
    expect(result).toMatchObject({
      ok: true,
      status: 'completed',
      xdt_image_urls: [bad, good, good],
      previews_omitted: [good],
      previews: [{ url: good, image_index: 0 }],
    });
    expect(result.modelImages).toHaveLength(1);
    expect(result.preview_errors).toHaveLength(1);
    clearCurrentDbClient();
    expect(
      await previewGeneratedImages({ ok: true, xdt_image_urls: [good] }, context),
    ).toMatchObject({ ok: true, xdt_image_urls: [good], preview_errors: expect.any(Array) });
  });
});
