import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
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

// Review #7970: the old fake returned frames without running Chromium's script,
// hiding the rejection of already-loaded WebM first frames with duration=Infinity.
// Unit tier: execute the real renderer program with only video/canvas APIs faked.
it.each([
  { duration: Infinity, time: 0, succeeds: true },
  { duration: NaN, time: 0, succeeds: true },
  { duration: 2, time: 0, succeeds: true },
  { duration: 2, time: 2, succeeds: false },
  { duration: Infinity, time: 1, succeeds: false },
])('checks frame $time with duration $duration', async ({ duration, time, succeeds }) => {
  const events = new EventTarget();
  const video = Object.assign(events, {
    duration,
    currentTime: 0,
    videoWidth: 64,
    videoHeight: 64,
    load() {
      events.dispatchEvent(new Event('loadeddata'));
    },
    removeAttribute() {},
  });
  const drawImage = vi.fn();
  state.execute.mockImplementation((script: string) =>
    runInNewContext(script, {
      document: {
        querySelector: () => video,
        createElement: () => ({
          getContext: () => ({ drawImage }),
          toDataURL: () => 'data:image/jpeg;base64,first-frame',
        }),
      },
    }),
  );
  const result = extractVideoFrames(Buffer.from('video'), 'video/webm', [time]);
  if (succeeds) {
    expect(await result).toEqual([
      { data: 'first-frame', mimeType: 'image/jpeg', time_seconds: 0 },
    ]);
    expect(drawImage).toHaveBeenCalledOnce();
  } else {
    await expect(result).rejects.toThrow('VIDEO_TIME_OUT_OF_RANGE');
    expect(drawImage).not.toHaveBeenCalled();
  }
  expect(state.windows[0].destroyed).toBe(true);
});
