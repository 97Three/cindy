import { BrowserWindow } from 'electron';

/** Decode only the supplied bytes in a disposable, invisible Chromium sandbox.
 * No preload, file access, network, persistent partition or external codec tool.
 */
export async function extractVideoFrames(
  buffer: Buffer,
  mimeType: string,
  times: number[],
): Promise<Array<{ data: string; mimeType: string; time_seconds: number }>> {
  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 360,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      plugins: false,
      navigateOnDragDrop: false,
      backgroundThrottling: false,
      partition: 'media-inspection',
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  win.webContents.session.setPermissionCheckHandler(() => false);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = async () => {
      await win.loadURL(
        'data:text/html,' +
          encodeURIComponent(
            '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; media-src data:; script-src \'none\'"><video muted></video>',
          ),
      );
      // Values are JSON literals evaluated only in this host-created empty page.
      return await win.webContents.executeJavaScript(`(async () => {
        const video = document.querySelector('video');
        const wait = (event, start) => new Promise((resolve, reject) => {
          const done = () => { cleanup(); resolve(); };
          const fail = () => { cleanup(); reject(new Error('VIDEO_DECODE_FAILED')); };
          const cleanup = () => { video.removeEventListener(event, done); video.removeEventListener('error', fail); };
          video.addEventListener(event, done, { once: true });
          video.addEventListener('error', fail, { once: true });
          start();
        });
        await wait('loadeddata', () => { video.src = ${JSON.stringify(`data:${mimeType};base64,${buffer.toString('base64')}`)}; video.load(); });
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext('2d');
        const frames = [];
        for (const time of ${JSON.stringify(times)}) {
          if (!Number.isFinite(video.duration) || time >= video.duration) throw new Error('VIDEO_TIME_OUT_OF_RANGE');
          if (video.currentTime !== time) await wait('seeked', () => { video.currentTime = time; });
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          frames.push({ data: canvas.toDataURL('image/jpeg', 0.8).split(',')[1], mimeType: 'image/jpeg', time_seconds: time });
        }
        video.removeAttribute('src'); video.load();
        return frames;
      })()`);
    };
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('VIDEO_DECODE_TIMEOUT')), 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (!win.isDestroyed()) win.destroy();
  }
}
