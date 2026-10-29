import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { extractVideoFrames } from '../videoInspection';

// Entry: extractVideoFrames. Unit tier, fake Electron only: a stalled/failed
// decoder must release its hidden window; real MP4/WebM pixels are smoke-tested.
const state = vi.hoisted(() => ({
  load: vi.fn(),
  execute: vi.fn(),
  windows: [] as Array<{ destroyed: boolean; options: unknown }>,
}));
vi.mock('electron', () => ({
  BrowserWindow: class {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
      executeJavaScript: state.execute,
    });
    constructor(readonly options: unknown) {
      state.windows.push(this);
    }
    loadURL = state.load;
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  },
}));
beforeEach(() => {
  state.windows.length = 0;
  state.load.mockReset().mockResolvedValue(undefined);
  state.execute.mockReset().mockResolvedValue([{ data: 'frame' }]);
});
afterEach(() => {
  vi.useRealTimers();
});

it('returns extracted frames and destroys the invisible sandbox', async () => {
  expect(await extractVideoFrames(Buffer.from('video'), 'video/mp4', [0])).toEqual([
    { data: 'frame' },
  ]);
  expect(state.windows[0].destroyed).toBe(true);
  expect(state.windows[0].options).toMatchObject({
    show: false,
    focusable: false,
    webPreferences: { sandbox: true, nodeIntegration: false, webSecurity: true },
  });
});
it.each(['load', 'execute'] as const)('destroys the window when %s fails', async (step) => {
  state[step].mockRejectedValue(new Error('decoder unavailable'));
  await expect(extractVideoFrames(Buffer.from('video'), 'video/mp4', [0])).rejects.toThrow();
  expect(state.windows[0].destroyed).toBe(true);
});
it('bounds stalled decoding and destroys the window at timeout', async () => {
  vi.useFakeTimers();
  state.execute.mockImplementation(() => new Promise(() => {}));
  const result = expect(extractVideoFrames(Buffer.from('video'), 'video/mp4', [0])).rejects.toThrow(
    'VIDEO_DECODE_TIMEOUT',
  );
  await vi.advanceTimersByTimeAsync(20_000);
  await result;
  expect(state.windows[0].destroyed).toBe(true);
});
