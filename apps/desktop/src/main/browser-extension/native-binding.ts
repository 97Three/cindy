/**
 * 浏览器扩展的 Native Messaging 绑定(宿主侧):把插件包内的平台二进制复制到
 * Cindy 的私有目录,向各 Chromium 浏览器注册 host manifest,并在
 * `connections/<port>.json` 写入桥接的私有授权令牌。令牌只给本机的 native host
 * 读,不进扩展、不进插件 KV、不进 /health 结果。
 *
 * 文件布局与插件时期完全相同(`<App Support>/Cindy/browser-native/`),已安装
 * 用户升级后无需重新配对;插件与宿主交错更新期间,两份注册写的是同一份清单。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface NativeBindingOptions {
  /** 注册名(身份卡 browserExtension.nativeHost.name)。 */
  hostName: string;
  /** 包内平台二进制目录:`<binaryDir>/<platform>-<arch>/cindy-browser-native[.exe]`。 */
  binaryDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** 覆盖私有目录(测试用)。 */
  root?: string;
  /** 覆盖浏览器 profile 目录清单(测试用)。 */
  profiles?: string[];
  run?: (
    file: string,
    args: string[],
    options: { windowsHide: boolean; timeout: number },
  ) => Promise<unknown>;
}

export type NativeBindingState = 'preparing' | 'ready' | 'unavailable';

export interface NativeBinding {
  readonly token: string;
  install(
    port: number,
    extensionIds: readonly string[],
  ): Promise<{ ok: true } | { ok: false; error: 'NATIVE_BINDING_UNAVAILABLE'; reason: string }>;
  close(): Promise<void>;
  status(): NativeBindingState;
}

export function nativeBindingRoot(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
): string {
  const base =
    platform === 'darwin'
      ? path.join(home, 'Library/Application Support')
      : platform === 'win32'
        ? env.LOCALAPPDATA || path.join(home, 'AppData/Local')
        : path.join(home, '.local/share');
  return path.join(base, 'Cindy', 'browser-native');
}

export function createNativeBinding(options: NativeBindingOptions): NativeBinding {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const root = options.root ?? nativeBindingRoot(platform, home, env);
  const token = crypto.randomBytes(32).toString('hex');
  const run = options.run ?? (promisify(execFile) as NativeBindingOptions['run']);
  let config: string | null = null;
  let state: NativeBindingState = 'preparing';

  async function privateDirectory(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('NATIVE_PATH_UNSAFE');
    if (platform !== 'win32') await fs.chmod(dir, 0o700);
  }

  async function atomic(file: string, data: string | Buffer, mode = 0o600): Promise<void> {
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.writeFile(tmp, data, { flag: 'wx', mode });
      await fs.rename(tmp, file);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  function browserProfiles(): string[] {
    return (
      options.profiles ??
      (platform === 'darwin'
        ? [
            'Google/Chrome',
            'Google/Chrome for Testing',
            'Chromium',
            'Microsoft Edge',
            'BraveSoftware/Brave-Browser',
          ].map((p) => path.join(home, 'Library/Application Support', p))
        : [
            'google-chrome',
            'google-chrome-for-testing',
            'chromium',
            'microsoft-edge',
            'BraveSoftware/Brave-Browser',
          ].map((p) => path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), p)))
    );
  }

  /**
   * Withdraw the browser registrations once no Cindy still serves a connection. The registration
   * is shared by every Cindy on this account (release and dev builds, both editions), and each
   * running one keeps its own `connections/<port>.json`; removing it while another is live would
   * cut that one off until it restarts.
   */
  async function unregisterIfUnused(): Promise<void> {
    const live = await fs.readdir(path.join(root, 'connections')).catch(() => null);
    if (live === null || live.some((name) => name.endsWith('.json'))) return;
    const binaryName = 'cindy-browser-native' + (platform === 'win32' ? '.exe' : '');
    const ours = path.join(root, binaryName);
    if (platform === 'win32') {
      const reg = path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'reg.exe');
      for (const vendor of ['Google\\Chrome', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser']) {
        await run!(
          reg,
          ['DELETE', 'HKCU\\Software\\' + vendor + '\\NativeMessagingHosts\\' + options.hostName, '/f'],
          { windowsHide: true, timeout: 10000 },
        ).catch(() => undefined);
      }
      await fs.rm(path.join(root, options.hostName + '.json'), { force: true });
      return;
    }
    for (const profile of browserProfiles()) {
      const file = path.join(profile, 'NativeMessagingHosts', options.hostName + '.json');
      const registered = await fs.readFile(file, 'utf8').catch(() => null);
      // Leave a registration that now points somewhere else (another installer took the name).
      let target: unknown = null;
      try {
        target = registered === null ? null : (JSON.parse(registered) as { path?: unknown }).path;
      } catch {
        target = null;
      }
      if (target === ours) await fs.rm(file, { force: true });
    }
  }

  async function install(port: number, extensionIds: readonly string[]) {
    try {
      await privateDirectory(root);
      await privateDirectory(path.join(root, 'connections'));
      const binaryName = 'cindy-browser-native' + (platform === 'win32' ? '.exe' : '');
      const source = path.join(options.binaryDir, platform + '-' + arch, binaryName);
      const binary = path.join(root, binaryName);
      // 内容相同时不替换正在运行的 Windows 映像。
      const content = await fs.readFile(source);
      const old = await fs.readFile(binary).catch(() => null);
      if (!old?.equals(content)) await atomic(binary, content, 0o700);
      const manifest = {
        name: options.hostName,
        description: 'Cindy browser automatic key binding',
        path: binary,
        type: 'stdio',
        allowed_origins: extensionIds.map((id) => 'chrome-extension://' + id + '/'),
      };
      if (platform === 'win32') {
        const file = path.join(root, options.hostName + '.json');
        await atomic(file, JSON.stringify(manifest));
        const reg = path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'reg.exe');
        for (const vendor of [
          'Google\\Chrome',
          'Microsoft\\Edge',
          'BraveSoftware\\Brave-Browser',
        ]) {
          await run!(
            reg,
            [
              'ADD',
              'HKCU\\Software\\' + vendor + '\\NativeMessagingHosts\\' + options.hostName,
              '/ve',
              '/t',
              'REG_SZ',
              '/d',
              file,
              '/f',
            ],
            { windowsHide: true, timeout: 10000 },
          );
        }
      } else {
        for (const profile of browserProfiles()) {
          const dir = path.join(profile, 'NativeMessagingHosts');
          await privateDirectory(dir);
          await atomic(path.join(dir, options.hostName + '.json'), JSON.stringify(manifest));
        }
      }
      config = path.join(root, 'connections', port + '.json');
      await atomic(config, JSON.stringify({ token }));
      state = 'ready';
      return { ok: true as const };
    } catch (e) {
      state = 'unavailable';
      const code = (e as NodeJS.ErrnoException)?.code;
      const reason =
        code && ['EACCES', 'EPERM', 'ENOENT', 'EROFS', 'EBUSY'].includes(code)
          ? code
          : (e as Error)?.message === 'NATIVE_PATH_UNSAFE'
            ? 'NATIVE_PATH_UNSAFE'
            : 'INSTALL_FAILED';
      return { ok: false as const, error: 'NATIVE_BINDING_UNAVAILABLE' as const, reason };
    }
  }

  async function close(): Promise<void> {
    if (!config) return;
    const data = await fs.readFile(config, 'utf8').catch(() => '');
    // 只删自己写的授权;同端口被另一实例接管时保留它的令牌。
    if (data === JSON.stringify({ token })) await fs.rm(config, { force: true });
    config = null;
    await unregisterIfUnused().catch(() => undefined);
  }

  return { token, install, close, status: () => state };
}
