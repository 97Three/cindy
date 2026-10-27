/**
 * browserExtensionSlot.ts — 浏览器扩展槽(browserExtension,2026-10-27)。
 * ---------------------------------------------------------------------------
 * 插件随包携带一个浏览器扩展时,由宿主承接扩展的连接:为每个**已装、启用、声明
 * browserExtension** 的插件各开一份本机桥接(BrowserExtensionBridge),复制并注册
 * 它的 Native Messaging host,把扩展发起的请求(翻译、字幕…)经管子转交给插件,
 * 并把插件的作业、策略与配对身份推送转给桥接。声明 pageControl 的扩展同时成为
 * Browser Use 的「我的浏览器」执行端(user-browser 后端经 getPageControl 取桥接)。
 *
 * 安全模型:
 * - 资格审:已装、启用、声明 browserExtension;停用/卸载/换版即关桥接,在途作业
 *   按 BRIDGE_STOPPED 作废,不留排队作业;
 * - 身份:允许连接的扩展 id 来自身份卡(装入时展示并钉死),宿主代码里不出现任何
 *   具体插件名;native host 的授权令牌只写本机私有连接文件;
 * - 策略归插件:站点策略由插件保存并推送(setPolicy),宿主只缓存、持久化到
 *   owner 私有目录并在每个作业上强制;宿主重启后先恢复上次策略再接受连接,
 *   没有策略时按线协议默认值(读开放公网、交互开放,本机/私网拒绝);
 * - 转交请求只投递给声明该扩展的插件(沙箱内处理),宿主不解释其业务内容。
 *
 * 纯逻辑 + 依赖注入(规则 14):ghost 查询、管子投递、目录与桥接工厂在
 * cindy-brain/index.ts 组装时注入。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  BrowserExtensionBridge,
  type BrowserExtensionBridgeOptions,
  type BrowserExtensionRelayNotice,
} from '../browser-extension/bridge.js';
import {
  createNativeBinding,
  type NativeBinding,
  type NativeBindingOptions,
} from '../browser-extension/native-binding.js';
import {
  defaultBrowserExtensionPolicy,
  normalizeBrowserExtensionPolicy,
  type BrowserExtensionPolicy,
} from '../browser-extension/policy.js';
import {
  ghostInstallApprovalToken,
  type GhostPipeBrowserExtensionResult,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import type { UserBrowserPageControl } from '../mcp-integrations/browser-backend/user-browser-backend.js';

export interface BrowserExtensionSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /** 把转交事件投到插件逻辑页;false = 逻辑页不在线。 */
  sendToGhost(ghostId: string, payload: unknown): boolean;
  /** 逻辑页不在线时拉起它(订阅网关同款);缺省不拉起。 */
  wake?(ghostId: string): Promise<boolean>;
  /** 策略缓存目录(owner 私有);切换账号后目录变化,桥接按新目录重启。 */
  policyDir(): string;
  /** 当前数据所有者标识;变化时所有桥接重建(策略不跨账号)。 */
  ownerScopeKey(): string;
  createBridge?(options: BrowserExtensionBridgeOptions): BrowserExtensionBridge;
  createNativeBinding?(options: NativeBindingOptions): NativeBinding;
  now?(): number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface Entry {
  instanceId: string;
  signature: string;
  ghost: InstalledGhost;
  bridge: BrowserExtensionBridge;
  native: NativeBinding | null;
  ready: Promise<void>;
  closing: boolean;
}

function fail(
  errorCode: Extract<GhostPipeBrowserExtensionResult, { ok: false }>['errorCode'],
  message: string,
): GhostPipeBrowserExtensionResult {
  return { ok: false, errorCode, message };
}

function entrySignature(ghost: InstalledGhost, ownerScopeKey: string): string {
  return JSON.stringify([
    ownerScopeKey,
    ghost.dir,
    ghost.manifest.version,
    ghostInstallApprovalToken(ghost.approval),
    ghost.manifest.browserExtension,
  ]);
}

/** 浏览器扩展槽:按插件启停桥接 → 转交扩展请求 → 承接插件的作业/策略推送 → 提供页面控制桥接。 */
export class GhostBrowserExtensionSlot {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  constructor(private readonly deps: BrowserExtensionSlotDeps) {}

  /** 装/卸/启停/换版广播后调用;幂等,只对发生变化的插件启停桥接。 */
  reconcile(ghosts: InstalledGhost[]): void {
    if (this.disposed) return;
    const ownerScopeKey = this.deps.ownerScopeKey();
    const wanted = new Map<string, InstalledGhost>();
    for (const ghost of ghosts) {
      if (!ghost.enabled || !ghost.manifest.browserExtension) continue;
      wanted.set(installedGhostStoragePart(ghost), ghost);
    }
    for (const [instanceId, entry] of this.entries) {
      const ghost = wanted.get(instanceId);
      if (!ghost || entrySignature(ghost, ownerScopeKey) !== entry.signature)
        void this.stop(instanceId);
    }
    for (const [instanceId, ghost] of wanted) {
      if (!this.entries.has(instanceId)) this.start(instanceId, ghost, ownerScopeKey);
    }
  }

  private start(instanceId: string, ghost: InstalledGhost, ownerScopeKey: string): void {
    const needs = ghost.manifest.browserExtension!;
    const native = needs.nativeHost
      ? (this.deps.createNativeBinding ?? createNativeBinding)({
          hostName: needs.nativeHost.name,
          binaryDir: path.join(ghost.dir, needs.nativeHost.binary),
        })
      : null;
    const bridge = (this.deps.createBridge ?? ((options) => new BrowserExtensionBridge(options)))({
      ghostId: ghost.manifest.id,
      installedVersion: ghost.manifest.version,
      extensionIds: needs.extensionIds,
      ...(native ? { nativeToken: native.token } : {}),
      onRelay: (notice) => void this.relay(instanceId, notice),
      ...(this.deps.now ? { now: this.deps.now } : {}),
      ...(this.deps.log ? { log: this.deps.log } : {}),
    });
    const entry: Entry = {
      instanceId,
      signature: entrySignature(ghost, ownerScopeKey),
      ghost,
      bridge,
      native,
      ready: Promise.resolve(),
      closing: false,
    };
    entry.ready = (async () => {
      const saved = await this.readPolicy(instanceId);
      if (saved) {
        try {
          await bridge.setPolicy(saved);
        } catch (err) {
          this.deps.log?.warn('browser extension saved policy rejected; using defaults', {
            instanceId,
            error: errorText(err),
          });
        }
      }
      await bridge.start();
      if (native) {
        const installed = await native.install(bridge.listeningPort, needs.extensionIds);
        if (!installed.ok)
          this.deps.log?.warn('browser extension native binding unavailable', {
            instanceId,
            reason: installed.reason,
          });
      }
      this.deps.log?.info('browser extension bridge ready', {
        instanceId,
        port: bridge.listeningPort,
        pageControl: needs.pageControl === true,
      });
    })().catch((err) => {
      this.deps.log?.warn('browser extension bridge failed to start', {
        instanceId,
        error: errorText(err),
      });
    });
    this.entries.set(instanceId, entry);
  }

  private async stop(instanceId: string): Promise<void> {
    const entry = this.entries.get(instanceId);
    if (!entry || entry.closing) return;
    entry.closing = true;
    this.entries.delete(instanceId);
    await entry.ready;
    await entry.bridge.close();
    await entry.native?.close();
    this.deps.log?.info('browser extension bridge stopped', { instanceId });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }

  // ── 转交:扩展 → 插件 ────────────────────────────────────────────────────

  private async relay(instanceId: string, notice: BrowserExtensionRelayNotice): Promise<void> {
    const entry = this.entries.get(instanceId);
    if (!entry) return;
    const payload = {
      type: 'event',
      name: 'browser-extension-relay',
      id: notice.id,
      clientId: notice.clientId,
      request: notice.request,
      ts: (this.deps.now ?? Date.now)(),
    };
    let delivered = this.deps.sendToGhost(instanceId, payload);
    if (!delivered && this.deps.wake) {
      try {
        delivered =
          (await this.deps.wake(instanceId)) && this.deps.sendToGhost(instanceId, payload);
      } catch (err) {
        this.deps.log?.warn('browser extension relay wake failed', {
          instanceId,
          error: errorText(err),
        });
      }
    }
    if (!delivered) {
      this.deps.log?.warn('browser extension relay undeliverable; plugin logic page offline', {
        instanceId,
        id: notice.id,
      });
      entry.bridge.relayResult(notice.id, { ok: false, error: 'PLUGIN_UNAVAILABLE' });
    }
  }

  // ── 管子上行:插件 → 桥接 ────────────────────────────────────────────────

  private entryFor(
    ghostId: string,
  ): { ok: true; entry: Entry } | { ok: false; result: GhostPipeBrowserExtensionResult } {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.browserExtension) {
      return {
        ok: false,
        result: fail(
          'PERMISSION_DENIED',
          '插件未申请浏览器扩展能力(browserExtension),或当前未启用',
        ),
      };
    }
    const entry = this.entries.get(installedGhostStoragePart(ghost)) ?? this.entries.get(ghostId);
    if (!entry)
      return { ok: false, result: fail('HOST_NOT_READY', '浏览器扩展桥接尚未就绪;稍后重试') };
    return { ok: true, entry };
  }

  async handleRequest(ghostId: string, payload: unknown): Promise<GhostPipeBrowserExtensionResult> {
    const gate = this.entryFor(ghostId);
    if (!gate.ok) return gate.result;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      return fail('INVALID_REQUEST', 'browser-extension-request 载荷必须是对象');
    const req = payload as Record<string, unknown>;
    const { entry } = gate;
    await entry.ready;
    try {
      switch (req.kind) {
        case 'status': {
          const status = await entry.bridge.status();
          if (!status.ok) return { ...status, errorCode: 'HOST_NOT_READY' };
          return {
            ...status,
            host: true,
            nativeBinding: entry.native ? entry.native.status() : 'unavailable',
          };
        }
        case 'act':
          return (await entry.bridge.act(
            req.action,
            req.payload ?? {},
          )) as GhostPipeBrowserExtensionResult;
        case 'setPolicy': {
          let policy: BrowserExtensionPolicy;
          try {
            policy = normalizeBrowserExtensionPolicy(req.policy);
          } catch (err) {
            return fail('INVALID_REQUEST', errorText(err));
          }
          const applied = await entry.bridge.setPolicy(policy);
          if (applied.ok || applied.applied === true)
            await this.writePolicy(entry.instanceId, policy);
          return applied as GhostPipeBrowserExtensionResult;
        }
        case 'setTrustedClients':
          try {
            return entry.bridge.setTrustedClients(req.clients);
          } catch (err) {
            return fail('INVALID_REQUEST', errorText(err));
          }
        case 'relayActive':
          if (typeof req.id !== 'string') return fail('INVALID_REQUEST', 'relayActive 需要 id');
          return entry.bridge.relayActive(req.id);
        case 'relayProgress':
          if (typeof req.id !== 'string') return fail('INVALID_REQUEST', 'relayProgress 需要 id');
          return entry.bridge.relayProgress(
            req.id,
            req.progress,
          ) as GhostPipeBrowserExtensionResult;
        case 'relayResult':
          if (typeof req.id !== 'string') return fail('INVALID_REQUEST', 'relayResult 需要 id');
          return entry.bridge.relayResult(req.id, req.result) as GhostPipeBrowserExtensionResult;
        default:
          return fail(
            'INVALID_REQUEST',
            `未知的 browser-extension-request kind ${JSON.stringify(req.kind)}`,
          );
      }
    } catch (err) {
      this.deps.log?.warn('browser extension request failed', {
        ghostId,
        kind: req.kind,
        error: errorText(err),
      });
      return fail('INTERNAL', errorText(err));
    }
  }

  // ── 页面控制:Browser Use 的「我的浏览器」执行端 ─────────────────────────

  getPageControl(): UserBrowserPageControl | null {
    for (const entry of this.entries.values()) {
      if (entry.ghost.manifest.browserExtension?.pageControl === true) {
        return {
          bridge: entry.bridge,
          ghostId: entry.ghost.manifest.id,
          pluginName: entry.ghost.manifest.name,
        };
      }
    }
    return null;
  }

  // ── 策略持久化 ──────────────────────────────────────────────────────────

  private policyFile(instanceId: string): string {
    return path.join(this.deps.policyDir(), encodeURIComponent(instanceId) + '.json');
  }

  private async readPolicy(instanceId: string): Promise<BrowserExtensionPolicy | null> {
    try {
      const raw = JSON.parse(await fs.readFile(this.policyFile(instanceId), 'utf8')) as {
        version?: unknown;
        policy?: unknown;
      };
      if (raw?.version !== 1) return null;
      return normalizeBrowserExtensionPolicy(raw.policy);
    } catch {
      return null;
    }
  }

  private async writePolicy(instanceId: string, policy: BrowserExtensionPolicy): Promise<void> {
    try {
      const file = this.policyFile(instanceId);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify({ version: 1, policy }), { mode: 0o600 });
      await fs.rename(tmp, file);
    } catch (err) {
      this.deps.log?.warn('browser extension policy not persisted', {
        instanceId,
        error: errorText(err),
      });
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { defaultBrowserExtensionPolicy };
