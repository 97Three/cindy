/**
 * browserExtensionSlot.test — 浏览器扩展槽(browserExtension)的假 deps 单测。
 *
 * 测试价值
 * - 生产入口与可观察结果:GhostBrowserExtensionSlot.reconcile / handleRequest / getPageControl;
 *   桥接按插件启停、native host 注册、策略持久化与恢复、转交事件投递与离线回退。
 * - 规则依据:docs/dev-rules/plugin-security-and-authoring.md(能力声明即授权边界;
 *   停用/卸载即休眠)与 2026-10-27 桥接迁入宿主的决定(翻译等转交必须到达插件)。
 * - 现有覆盖缺口:新槽。
 * - 最小失败输入:未声明能力的插件发请求;策略文件存在但桥接未恢复;逻辑页离线且拉起失败。
 * - tier:unit(假桥接、临时目录);实测耗时 < 1 秒。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  BrowserExtensionBridgeOptions,
  BrowserExtensionRelayNotice,
} from '../../browser-extension/bridge';
import { defaultBrowserExtensionPolicy } from '../../browser-extension/policy';
import type { InstalledGhost } from '../../../shared/ghost';
import { GhostBrowserExtensionSlot, type BrowserExtensionSlotDeps } from '../browserExtensionSlot';

const CHROME_ID = 'a'.repeat(32);

function extGhost(
  options: {
    id?: string;
    enabled?: boolean;
    declare?: boolean;
    pageControl?: boolean;
    nativeHost?: boolean;
    version?: string;
  } = {},
): InstalledGhost {
  const id = options.id ?? 'ext-ghost';
  return {
    manifest: {
      schemaVersion: 3,
      id,
      name: 'Ext Ghost',
      version: options.version ?? '1.0.0',
      entry: 'main.js',
      ...(options.declare !== false
        ? {
            browserExtension: {
              protocol: 'cindy-browser-extension/3',
              extensionIds: [CHROME_ID],
              ...(options.nativeHost !== false
                ? { nativeHost: { name: 'com.example.browser', binary: 'native-host/bin' } }
                : {}),
              ...(options.pageControl !== false ? { pageControl: true as const } : {}),
            },
          }
        : {}),
    },
    dir: `/fake/${id}`,
    instanceKey: `_root__${id}`,
    enabled: options.enabled ?? true,
    approval: { state: 'approved', revision: 1 },
  } as unknown as InstalledGhost;
}

class FakeBridge {
  started = false;
  closed = false;
  listeningPort = 0;
  policy = defaultBrowserExtensionPolicy();
  calls: Array<[string, unknown[]]> = [];
  constructor(readonly options: BrowserExtensionBridgeOptions) {}
  async start() {
    this.started = true;
    this.listeningPort = 18810;
  }
  async close() {
    this.closed = true;
  }
  async status() {
    return {
      ok: true as const,
      version: '0',
      protocol: 3,
      port: this.listeningPort,
      extension_connected: true,
      extension_ids: [CHROME_ID],
      policy: this.policy,
      pending: 0,
      clients: [],
    };
  }
  connectedClients() {
    return [];
  }
  async act(action: unknown, payload: unknown) {
    this.calls.push(['act', [action, payload]]);
    return { ok: true, text: 'hello' };
  }
  async setPolicy(policy: unknown) {
    this.calls.push(['setPolicy', [policy]]);
    this.policy = policy as typeof this.policy;
    return { ok: true as const, policy: this.policy };
  }
  setTrustedClients(clients: unknown) {
    this.calls.push(['setTrustedClients', [clients]]);
    return { ok: true as const };
  }
  relayActive(id: string) {
    this.calls.push(['relayActive', [id]]);
    return { ok: true as const, active: true };
  }
  relayProgress(id: string, progress: unknown) {
    this.calls.push(['relayProgress', [id, progress]]);
    return { ok: true as const };
  }
  relayResult(id: string, result: unknown) {
    this.calls.push(['relayResult', [id, result]]);
    return { ok: true as const };
  }
  emitRelay(notice: BrowserExtensionRelayNotice) {
    this.options.onRelay?.(notice);
  }
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeSlot(
  overrides: Partial<BrowserExtensionSlotDeps> = {},
  ghosts: InstalledGhost[] = [extGhost()],
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-browser-extension-slot-'));
  dirs.push(dir);
  const bridges: FakeBridge[] = [];
  const natives: Array<{
    token: string;
    install: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    status: () => 'ready';
  }> = [];
  const sent: Array<[string, unknown]> = [];
  const deps: BrowserExtensionSlotDeps = {
    getGhost: (id) => ghosts.find((g) => g.instanceKey === id || g.manifest.id === id) ?? null,
    sendToGhost: vi.fn((ghostId, payload) => {
      sent.push([ghostId, payload]);
      return true;
    }),
    policyDir: () => dir,
    ownerScopeKey: () => 'owner-a',
    createBridge: (options) => {
      const bridge = new FakeBridge(options);
      bridges.push(bridge);
      return bridge as unknown as ReturnType<NonNullable<BrowserExtensionSlotDeps['createBridge']>>;
    },
    createNativeBinding: () => {
      const native = {
        token: 'f'.repeat(64),
        install: vi.fn(async () => ({ ok: true as const })),
        close: vi.fn(async () => undefined),
        status: () => 'ready' as const,
      };
      natives.push(native);
      return native;
    },
    ...overrides,
  };
  const slot = new GhostBrowserExtensionSlot(deps);
  // 桥接就绪链里有真实文件读取(恢复策略),给几个事件循环周期让它落定。
  const settle = () => new Promise((r) => setTimeout(r, 25));
  return { slot, deps, bridges, natives, sent, dir, ghosts, settle };
}

describe('browserExtensionSlot · 桥接随花名册启停', () => {
  it('已启用且声明能力的插件各开一份桥接并注册 native host;停用即关;换版即重建', async () => {
    const ghosts = [
      extGhost(),
      extGhost({ id: 'plain', declare: false }),
      extGhost({ id: 'off', enabled: false }),
    ];
    const { slot, bridges, natives, settle } = await makeSlot({}, ghosts);
    slot.reconcile(ghosts);
    await settle();
    expect(bridges).toHaveLength(1);
    expect(bridges[0].options).toMatchObject({
      ghostId: 'ext-ghost',
      installedVersion: '1.0.0',
      extensionIds: [CHROME_ID],
      nativeToken: 'f'.repeat(64),
    });
    expect(bridges[0].started).toBe(true);
    expect(natives[0].install).toHaveBeenCalledWith(18810, [CHROME_ID]);
    expect(slot.getPageControl()).toMatchObject({ ghostId: 'ext-ghost', pluginName: 'Ext Ghost' });
    // 幂等:同一份花名册不重建。
    slot.reconcile(ghosts);
    await settle();
    expect(bridges).toHaveLength(1);
    // 换版:关旧开新。
    const upgraded = [extGhost({ version: '1.1.0' })];
    slot.reconcile(upgraded);
    await settle();
    expect(bridges[0].closed).toBe(true);
    expect(natives[0].close).toHaveBeenCalledOnce();
    expect(bridges).toHaveLength(2);
    expect(bridges[1].options.installedVersion).toBe('1.1.0');
    // 停用:关掉,不再提供页面控制。
    slot.reconcile([extGhost({ version: '1.1.0', enabled: false })]);
    await settle();
    expect(bridges[1].closed).toBe(true);
    expect(slot.getPageControl()).toBeNull();
  });

  it('没有 pageControl 的声明只做通道,不成为 Browser Use 执行端', async () => {
    const ghosts = [extGhost({ pageControl: false, nativeHost: false })];
    const { slot, bridges, natives, settle } = await makeSlot({}, ghosts);
    slot.reconcile(ghosts);
    await settle();
    expect(bridges).toHaveLength(1);
    expect(bridges[0].options.nativeToken).toBeUndefined();
    expect(natives).toHaveLength(0);
    expect(slot.getPageControl()).toBeNull();
  });
});

describe('browserExtensionSlot · 管子上行', () => {
  it('未声明能力 / 未启用的插件一律 PERMISSION_DENIED;桥接未就绪 HOST_NOT_READY', async () => {
    const ghosts = [
      extGhost(),
      extGhost({ id: 'plain', declare: false }),
      extGhost({ id: 'off', enabled: false }),
    ];
    const { slot } = await makeSlot({}, ghosts);
    expect(await slot.handleRequest('_root__plain', { kind: 'status' })).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    expect(await slot.handleRequest('_root__off', { kind: 'status' })).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    expect(await slot.handleRequest('_root__ext-ghost', { kind: 'status' })).toMatchObject({
      ok: false,
      errorCode: 'HOST_NOT_READY',
    });
  });

  it('status / act / setPolicy / setTrustedClients / relay* 原样转给桥接;策略落盘并在重启后恢复', async () => {
    const { slot, bridges, dir, ghosts, settle } = await makeSlot();
    slot.reconcile(ghosts);
    await settle();
    const id = '_root__ext-ghost';
    expect(await slot.handleRequest(id, 'nope')).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(await slot.handleRequest(id, { kind: 'status' })).toMatchObject({
      ok: true,
      port: 18810,
      host: true,
      nativeBinding: 'ready',
    });
    expect(
      await slot.handleRequest(id, {
        kind: 'act',
        action: 'text',
        payload: { url: 'https://example.test' },
      }),
    ).toMatchObject({ ok: true, text: 'hello' });
    expect(bridges[0].calls.at(-1)).toEqual(['act', ['text', { url: 'https://example.test' }]]);
    expect(
      await slot.handleRequest(id, { kind: 'setPolicy', policy: { read: { block: 'bad' } } }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    const policy = {
      read: { block: ['blocked.test'] },
      interact: { allow: ['example.test'], block: [] },
    };
    expect(await slot.handleRequest(id, { kind: 'setPolicy', policy })).toMatchObject({
      ok: true,
      policy,
    });
    expect(
      JSON.parse(await fs.readFile(path.join(dir, encodeURIComponent(id) + '.json'), 'utf8')),
    ).toEqual({ version: 1, policy });
    expect(await slot.handleRequest(id, { kind: 'setTrustedClients', clients: [] })).toEqual({
      ok: true,
    });
    expect(await slot.handleRequest(id, { kind: 'relayActive', id: 'r1' })).toEqual({
      ok: true,
      active: true,
    });
    expect(
      await slot.handleRequest(id, {
        kind: 'relayProgress',
        id: 'r1',
        progress: { stage: 'model' },
      }),
    ).toEqual({ ok: true });
    expect(
      await slot.handleRequest(id, { kind: 'relayResult', id: 'r1', result: { ok: true } }),
    ).toEqual({ ok: true });
    expect(await slot.handleRequest(id, { kind: 'relayResult' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(await slot.handleRequest(id, { kind: 'mystery' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    // 重启(新槽、同目录):先恢复上次策略再 start。
    const again = await makeSlot({ policyDir: () => dir });
    again.slot.reconcile(again.ghosts);
    await again.settle();
    expect(again.bridges[0].calls[0]).toEqual(['setPolicy', [policy]]);
    expect(again.bridges[0].started).toBe(true);
  });
});

describe('browserExtensionSlot · 转交扩展请求', () => {
  it('在线直接投递;离线先拉起再投递;仍失败则回 PLUGIN_UNAVAILABLE 给扩展', async () => {
    let online = true;
    const wake = vi.fn(async () => {
      online = true;
      return true;
    });
    const { slot, bridges, sent, ghosts, settle, deps } = await makeSlot({
      sendToGhost: vi.fn((ghostId, payload) => {
        if (!online) return false;
        sent.push([ghostId, payload]);
        return true;
      }),
      wake,
    });
    slot.reconcile(ghosts);
    await settle();
    const notice = {
      id: 'req-1',
      clientId: 'client-1',
      request: { op: 'translate', source: { url: '', title: '' }, text: 'hi' },
    };
    bridges[0].emitRelay(notice);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe('_root__ext-ghost');
    expect(sent[0][1]).toMatchObject({
      type: 'event',
      name: 'browser-extension-relay',
      id: 'req-1',
      clientId: 'client-1',
      request: notice.request,
    });
    online = false;
    bridges[0].emitRelay({ ...notice, id: 'req-2' });
    await settle();
    expect(wake).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(2);
    online = false;
    wake.mockResolvedValueOnce(false);
    bridges[0].emitRelay({ ...notice, id: 'req-3' });
    await settle();
    expect(sent).toHaveLength(2);
    expect(bridges[0].calls.at(-1)).toEqual([
      'relayResult',
      ['req-3', { ok: false, error: 'PLUGIN_UNAVAILABLE' }],
    ]);
    expect(deps.sendToGhost).toHaveBeenCalled();
  });
});
