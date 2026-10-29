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
 *   owner 私有目录并在每个作业上强制;宿主重启后先恢复上次策略与配对再接受连接,
 *   没有可用缓存时桥接在收到插件策略前拒绝页面作业,并向插件索要策略;
 * - native host 在插件沙箱外运行且全账号共用一份注册,只为官方 Cindy Chrome 安装
 *   (见 OFFICIAL_NATIVE_HOSTS,宿主唯一点名具体插件的地方);
 * - 转交请求只投递给声明该扩展的插件(沙箱内处理),宿主不解释其业务内容。
 *
 * 纯逻辑 + 依赖注入(规则 14):ghost 查询、管子投递、目录与桥接工厂在
 * cindy-brain/index.ts 组装时注入。
 */

import crypto from 'node:crypto';
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

/**
 * Native Messaging hosts run outside the plugin sandbox and every Cindy on the account shares
 * their registration, so only the official Cindy Chrome plugin may install one, under its own
 * name. It must also declare its bundled Node program, which the install confirmation already
 * presents as running unsandboxed. Any other declaration is ignored: the bridge still runs and
 * the extension falls back to pairing.
 */
const OFFICIAL_NATIVE_HOSTS: ReadonlyMap<string, string> = new Map([
  ['my-browser', 'com.makecindy.browser'],
]);

export function mayInstallNativeHost(ghost: InstalledGhost): boolean {
  const name = ghost.manifest.browserExtension?.nativeHost?.name;
  return (
    name !== undefined &&
    ghost.namespace == null &&
    OFFICIAL_NATIVE_HOSTS.get(ghost.manifest.id) === name &&
    ghost.manifest.node !== undefined
  );
}

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
  /** Bumped per setPolicy; only the newest request may persist, however long older ones waited. */
  policyRevision: number;
  /** Last applied policy and paired clients, persisted together. */
  saved: SavedBrowserExtensionState;
  /** Serialises cache writes so an older write cannot land after a newer one. */
  writes: Promise<void>;
}

interface SavedBrowserExtensionState {
  policy: BrowserExtensionPolicy | null;
  trustedClients: unknown[];
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
    if (needs.nativeHost && !mayInstallNativeHost(ghost))
      this.deps.log?.warn('browser extension native host ignored: only the official plugin may install one', {
        instanceId,
        hostName: needs.nativeHost.name,
      });
    const native = needs.nativeHost && mayInstallNativeHost(ghost)
      ? (this.deps.createNativeBinding ?? createNativeBinding)({
          hostName: needs.nativeHost.name,
          binaryDir: path.join(ghost.dir, needs.nativeHost.binary),
        })
      : null;
    const bridge = (this.deps.createBridge ?? ((options) => new BrowserExtensionBridge(options)))({
      ghostId: ghost.manifest.id,
      awaitPolicy: true,
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
      policyRevision: 0,
      saved: { policy: null, trustedClients: [] },
      writes: Promise.resolve(),
    };
    entry.ready = (async () => {
      const saved = await this.readSaved(instanceId);
      let restored = false;
      if (saved) {
        entry.saved = saved;
        try {
          // Paired clients first, so an extension paired before the restart is not sent back to
          // pairing while the plugin is still starting.
          bridge.setTrustedClients(saved.trustedClients);
        } catch (err) {
          this.deps.log?.warn('browser extension saved pairings rejected', {
            instanceId,
            error: errorText(err),
          });
        }
        if (saved.policy) {
          try {
            await bridge.setPolicy(saved.policy);
            restored = true;
          } catch (err) {
            this.deps.log?.warn('browser extension saved policy rejected; waiting for the plugin', {
              instanceId,
              error: errorText(err),
            });
          }
        }
      }
      await bridge.start();
      // Without a usable cached policy the bridge refuses page jobs; ask the plugin to push its
      // stored permissions now instead of at its next tool call.
      if (!restored) void this.requestPolicy(instanceId);
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
    if (delivered)
      this.deps.log?.info('browser extension relay delivered to plugin', {
        instanceId,
        id: notice.id,
      });
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
          const revision = ++entry.policyRevision;
          const applied = await entry.bridge.setPolicy(policy);
          if ((applied.ok || applied.applied === true) && revision === entry.policyRevision)
            await this.persist(entry, { policy });
          return applied as GhostPipeBrowserExtensionResult;
        }
        case 'setTrustedClients': {
          let applied: { ok: true };
          try {
            applied = entry.bridge.setTrustedClients(req.clients);
          } catch (err) {
            return fail('INVALID_REQUEST', errorText(err));
          }
          await this.persist(entry, { trustedClients: Array.isArray(req.clients) ? req.clients : [] });
          return applied;
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

  /** Saved permissions and pairings; null when missing or unreadable (treated as unknown). */
  private async readSaved(instanceId: string): Promise<SavedBrowserExtensionState | null> {
    try {
      const raw = JSON.parse(await fs.readFile(this.policyFile(instanceId), 'utf8')) as {
        version?: unknown;
        policy?: unknown;
        trustedClients?: unknown;
      };
      if (raw?.version !== 1) return null;
      let policy: BrowserExtensionPolicy | null = null;
      if (raw.policy !== undefined) {
        try {
          policy = normalizeBrowserExtensionPolicy(raw.policy);
        } catch {
          policy = null;
        }
      }
      return {
        policy,
        trustedClients: Array.isArray(raw.trustedClients) ? raw.trustedClients : [],
      };
    } catch {
      return null;
    }
  }

  private persist(entry: Entry, change: Partial<SavedBrowserExtensionState>): Promise<void> {
    entry.saved = { ...entry.saved, ...change };
    const snapshot = entry.saved;
    entry.writes = entry.writes.then(() => this.writeSaved(entry.instanceId, snapshot));
    return entry.writes;
  }

  private async writeSaved(instanceId: string, saved: SavedBrowserExtensionState): Promise<void> {
    const file = this.policyFile(instanceId);
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(
        tmp,
        JSON.stringify({
          version: 1,
          ...(saved.policy ? { policy: saved.policy } : {}),
          trustedClients: saved.trustedClients,
        }),
        { mode: 0o600 },
      );
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      this.deps.log?.warn('browser extension policy not persisted', {
        instanceId,
        error: errorText(err),
      });
    }
  }

  /** Ask the plugin to push its stored permissions: wake it when offline, else send a request. */
  private async requestPolicy(instanceId: string): Promise<void> {
    const payload = { type: 'event', name: 'browser-extension-policy-request' };
    try {
      if (this.deps.sendToGhost(instanceId, payload)) return;
      if (this.deps.wake && (await this.deps.wake(instanceId))) this.deps.sendToGhost(instanceId, payload);
    } catch (err) {
      this.deps.log?.warn('browser extension policy request failed', {
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
