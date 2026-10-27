/**
 * UserBrowserBackend — 把用户正在使用的浏览器(经随包浏览器扩展)接成 Browser Use
 * 的第三个控制目标。
 *
 * 与另外两个后端的差别:
 * - 页面活在用户自己的 Chrome / Edge 里,带着用户本人的登录态;Cindy 不启停它;
 * - 执行端是扩展在隔离世界里的固定函数,没有 debugger、任意脚本、网络读取、截图、
 *   上传与原生弹窗。不支持的 action 明确拒绝并指向专用浏览器,绝不悄悄换目标;
 * - 每个作业都经桥接按插件保存的站点策略守门(读默认开放公网,交互按站点授权,
 *   本机与私网一律拒绝),结果脱敏后才回到这里。
 *
 * 寻址:扩展当前按精确 URL 寻址标签页,这里维护 targetId ↔ {连接, tabId, url} 的
 * 映射,把 Browser Use 的 targetId / 别名 / label 翻译成作业的 url;页面在
 * 两次调用之间跳转时,扩展报 PAGE_CHANGED,这里刷新映射后原样上报,不猜新页。
 */

import type {
  BrowserExtensionBridge,
  BrowserExtensionClientInfo,
  BrowserExtensionJobResult,
} from '../../browser-extension/bridge.js';
import type { BackendRequest, BackendResult, BrowserBackend } from './types.js';

export interface UserBrowserPageControl {
  bridge: BrowserExtensionBridge;
  ghostId: string;
  pluginName: string;
}

export interface UserBrowserBackendOptions {
  /** 声明 browserExtension.pageControl 的插件桥接;null = 没有这样的插件(或未启用)。 */
  getPageControl(): UserBrowserPageControl | null;
  logger: {
    info(message: string, meta?: unknown): void;
    warn(message: string, meta?: unknown): void;
  };
  now?(): number;
}

interface TargetRecord {
  targetId: string;
  alias: string;
  label?: string;
  clientId: string;
  tabId: number;
  url: string;
  title?: string;
}

export const USER_BROWSER_UNSUPPORTED_HINT =
  '用户浏览器执行端不支持此操作;需要时请明确告知用户并改用 Cindy 专用浏览器(external),不要自行切换。';

/** 用户浏览器执行端的能力表(供 MCP 层在调用前拒绝,与 status 一并告知模型)。 */
export const USER_BROWSER_CAPABILITIES = Object.freeze({
  evaluate: false,
  screenshot: false,
  network: false,
  upload: false,
  dialog: false,
  console: false,
  pdf: false,
  focus: false,
  close: false,
  trustedInput: false,
});

function actionFailed(
  action: BackendRequest['action'],
  message: string,
  errorCode: BackendResult['errorCode'] = 'BROWSER_RUNTIME_ACTION_FAILED',
): BackendResult {
  return { ok: false, action, errorCode, message };
}

function actionOk(action: BackendRequest['action'], data: unknown): BackendResult {
  return { ok: true, action, status: 200, data };
}

function unsupported(action: BackendRequest['action'], what: string): BackendResult {
  return actionFailed(
    action,
    `${what}:${USER_BROWSER_UNSUPPORTED_HINT}`,
    'BROWSER_RUNTIME_INVALID_REQUEST',
  );
}

const NOT_CONFIGURED_MESSAGE =
  '没有已启用的浏览器扩展插件提供页面控制(安装并启用 Cindy Chrome 插件后再选择「我的浏览器」)。';
const DISCONNECTED_MESSAGE =
  '浏览器扩展未连接:请在用户的 Chrome / Edge 中安装并启用 Cindy 扩展,保持 Cindy 运行;连接后重新查询 status。';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class UserBrowserBackend implements BrowserBackend {
  readonly kind = 'user-browser' as const;
  private readonly targets = new Map<string, TargetRecord>();
  private nextAlias = 1;
  private disposed = false;

  constructor(private readonly opts: UserBrowserBackendOptions) {}

  async call(request: BackendRequest): Promise<BackendResult> {
    if (this.disposed)
      return actionFailed(
        request.action,
        'user browser backend disposed',
        'BROWSER_RUNTIME_UNAVAILABLE',
      );
    try {
      return await this.dispatch(request);
    } catch (err) {
      this.opts.logger.warn('user-browser backend call threw', {
        action: request.action,
        err: err instanceof Error ? err.message : String(err),
      });
      return actionFailed(request.action, err instanceof Error ? err.message : String(err));
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.targets.clear();
  }

  // ── 分发 ────────────────────────────────────────────────────────────────

  private async dispatch(req: BackendRequest): Promise<BackendResult> {
    switch (req.action) {
      case 'status':
        return this.handleStatus(req);
      case 'doctor':
        return this.handleStatus(req, true);
      case 'start':
        return this.handleStart(req);
      case 'stop':
        return actionOk(req.action, {
          ready: true,
          backend: this.kind,
          note: '用户浏览器由用户自己启停,Cindy 不关闭它。',
        });
      case 'profiles':
        return this.handleProfiles(req);
      case 'tabs':
        return this.handleTabs(req);
      case 'open':
      case 'navigate':
        return this.handleOpen(req);
      case 'snapshot':
        return this.handleSnapshot(req);
      case 'act':
        return this.handleAct(req);
      case 'focus':
        return unsupported(req.action, '切换活动标签页');
      case 'close':
        return unsupported(req.action, '关闭标签页');
      case 'screenshot':
        return unsupported(req.action, '截图');
      case 'pdf':
        return unsupported(req.action, '导出 PDF');
      case 'console':
        return unsupported(req.action, '读取控制台');
      case 'upload':
        return unsupported(req.action, '上传文件');
      case 'dialog':
        return unsupported(req.action, '处理原生弹窗');
      case 'requests':
      case 'responseBody':
        return unsupported(req.action, '读取网络请求');
      case 'recipeCommand':
        return unsupported(req.action, '原始协议命令(OpenCLI 适配器)');
      default:
        return actionFailed(
          req.action,
          `action '${String(req.action)}' is not supported by the user browser backend`,
          'BROWSER_RUNTIME_INVALID_REQUEST',
        );
    }
  }

  // ── 连接解析 ────────────────────────────────────────────────────────────

  private control(
    action: BackendRequest['action'],
  ): { ok: true; control: UserBrowserPageControl } | { ok: false; result: BackendResult } {
    const control = this.opts.getPageControl();
    if (!control)
      return {
        ok: false,
        result: actionFailed(action, NOT_CONFIGURED_MESSAGE, 'BROWSER_RUNTIME_NOT_CONFIGURED'),
      };
    return { ok: true, control };
  }

  private connectedClients(control: UserBrowserPageControl): BrowserExtensionClientInfo[] {
    return control.bridge.connectedClients();
  }

  /** 选连接:显式 profile(连接 id)优先;只有一条连接时直接用;多条且未指定时拒绝,不猜账号。 */
  private pickClient(
    action: BackendRequest['action'],
    control: UserBrowserPageControl,
    profile: string | undefined,
  ): { ok: true; clientId: string } | { ok: false; result: BackendResult } {
    const clients = this.connectedClients(control);
    if (clients.length === 0)
      return {
        ok: false,
        result: actionFailed(action, DISCONNECTED_MESSAGE, 'BROWSER_RUNTIME_UNAVAILABLE'),
      };
    if (profile) {
      const found = clients.find((c) => c.id === profile || c.id.startsWith(profile));
      if (!found)
        return {
          ok: false,
          result: actionFailed(
            action,
            `未找到浏览器连接 ${profile};用 profiles 查看当前连接`,
            'BROWSER_RUNTIME_INVALID_REQUEST',
          ),
        };
      return { ok: true, clientId: found.id };
    }
    if (clients.length === 1) return { ok: true, clientId: clients[0].id };
    return {
      ok: false,
      result: actionFailed(
        action,
        `有 ${clients.length} 个浏览器连接;请用 profile 指定连接 id(见 profiles),不要猜测账号`,
        'BROWSER_RUNTIME_INVALID_REQUEST',
      ),
    };
  }

  private failureResult(
    action: BackendRequest['action'],
    job: BrowserExtensionJobResult,
  ): BackendResult {
    const error = typeof job.error === 'string' ? job.error : 'BROWSER_EXTENSION_FAILED';
    const message = typeof job.message === 'string' ? job.message : '浏览器扩展操作失败';
    const execution = job.execution;
    return {
      ok: false,
      action,
      errorCode:
        error === 'EXTENSION_DISCONNECTED' || error === 'BRIDGE_PORTS_BUSY'
          ? 'BROWSER_RUNTIME_UNAVAILABLE'
          : 'BROWSER_RUNTIME_ACTION_FAILED',
      message: `${error}:${message}`,
      data: {
        error,
        ...(typeof execution === 'string' ? { execution } : {}),
        ...(job.clients ? { clients: job.clients } : {}),
        ...(job.reason ? { reason: job.reason } : {}),
      },
    };
  }

  // ── 目标表 ──────────────────────────────────────────────────────────────

  private targetKey(clientId: string, tabId: number): string {
    return `${clientId.slice(0, 8)}:${tabId}`;
  }

  private register(
    clientId: string,
    tab: { id: number; url: string; title?: string },
    label?: string,
  ): TargetRecord {
    const targetId = this.targetKey(clientId, tab.id);
    let record = this.targets.get(targetId);
    if (!record) {
      record = {
        targetId,
        alias: `t${this.nextAlias++}`,
        clientId,
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
      };
      this.targets.set(targetId, record);
    } else {
      record.url = tab.url;
      record.title = tab.title ?? record.title;
    }
    if (label) {
      for (const other of this.targets.values())
        if (other !== record && other.label === label) delete other.label;
      record.label = label;
    }
    return record;
  }

  private resolveTarget(id: string | undefined): TargetRecord | null {
    if (!id) return null;
    const direct = this.targets.get(id);
    if (direct) return direct;
    for (const record of this.targets.values()) {
      if (record.alias === id || record.label === id) return record;
    }
    const prefixed = [...this.targets.values()].filter((record) => record.targetId.startsWith(id));
    return prefixed.length === 1 ? prefixed[0] : null;
  }

  private describe(record: TargetRecord): Record<string, unknown> {
    return {
      targetId: record.targetId,
      suggestedTargetId: record.label ?? record.alias,
      tabId: record.alias,
      ...(record.label ? { label: record.label } : {}),
      url: record.url,
      ...(record.title !== undefined ? { title: record.title } : {}),
      browser: record.clientId,
    };
  }

  /** 扩展按精确 URL 寻址:作业前先核对标签页仍在原 URL,不在就刷新映射并如实报告。 */
  private async locate(
    action: BackendRequest['action'],
    control: UserBrowserPageControl,
    id: string | undefined,
  ): Promise<{ ok: true; record: TargetRecord } | { ok: false; result: BackendResult }> {
    const record = this.resolveTarget(id);
    if (!record) {
      return {
        ok: false,
        result: actionFailed(
          action,
          id
            ? `未知 targetId ${id};先用 tabs 或 open 取得标签页`
            : 'targetId required(用 tabs 列出或 open 打开后再操作)',
          'BROWSER_RUNTIME_INVALID_REQUEST',
        ),
      };
    }
    const listed = await control.bridge.act('tabs', { browser: record.clientId, limit: 100 });
    if (listed.ok && Array.isArray(listed.tabs)) {
      const current = (
        listed.tabs as Array<{ id?: unknown; url?: unknown; title?: unknown; redacted?: boolean }>
      ).find((t) => t.id === record.tabId);
      if (!current) {
        this.targets.delete(record.targetId);
        return {
          ok: false,
          result: actionFailed(
            action,
            `标签页 ${record.targetId} 已关闭;用 tabs 重新选择`,
            'BROWSER_RUNTIME_INVALID_REQUEST',
          ),
        };
      }
      if (current.redacted) {
        return {
          ok: false,
          result: actionFailed(
            action,
            `标签页 ${record.targetId} 当前页面不允许读取(站点策略或本机地址)`,
            'BROWSER_RUNTIME_INVALID_REQUEST',
          ),
        };
      }
      if (typeof current.url === 'string' && current.url !== record.url) {
        const previous = record.url;
        record.url = current.url;
        record.title = typeof current.title === 'string' ? current.title : record.title;
        return {
          ok: false,
          result: {
            ...actionFailed(
              action,
              `PAGE_CHANGED:标签页已从 ${previous} 跳转到 ${current.url};先 snapshot 再继续,不要沿用旧 ref`,
              'BROWSER_RUNTIME_ACTION_FAILED',
            ),
            data: { error: 'PAGE_CHANGED', ...this.describe(record) },
          },
        };
      }
    }
    return { ok: true, record };
  }

  // ── 各 action ───────────────────────────────────────────────────────────

  private async handleStatus(req: BackendRequest, doctor = false): Promise<BackendResult> {
    const control = this.opts.getPageControl();
    if (!control) {
      return actionOk(req.action, {
        ready: false,
        backend: this.kind,
        running: false,
        configured: false,
        message: NOT_CONFIGURED_MESSAGE,
        capabilities: USER_BROWSER_CAPABILITIES,
      });
    }
    const status = await control.bridge.status();
    if (!status.ok) {
      return actionOk(req.action, {
        ready: false,
        backend: this.kind,
        running: false,
        configured: true,
        plugin: control.ghostId,
        error: status.error,
        message: status.message,
        capabilities: USER_BROWSER_CAPABILITIES,
      });
    }
    const clients = status.clients
      .filter((c) => c.connected)
      .map((c) => ({
        id: c.id,
        browser: c.browser,
        version: c.version,
        protocolVersion: c.protocolVersion,
      }));
    return actionOk(req.action, {
      ready: clients.length > 0,
      running: clients.length > 0,
      backend: this.kind,
      configured: true,
      plugin: control.ghostId,
      pluginName: control.pluginName,
      connected: clients.length > 0,
      clients,
      ...(clients.length === 0 ? { message: DISCONNECTED_MESSAGE } : {}),
      capabilities: USER_BROWSER_CAPABILITIES,
      ...(doctor
        ? {
            port: status.port,
            extensionIds: status.extension_ids,
            pending: status.pending,
            targets: this.targets.size,
          }
        : {}),
    });
  }

  private async handleStart(req: BackendRequest): Promise<BackendResult> {
    if (req.proxyServer !== undefined || req.proxyAllowedHostnames !== undefined) {
      return actionFailed(
        req.action,
        '用户浏览器执行端不支持指定代理;需要代理时改用 Cindy 专用浏览器',
        'BROWSER_RUNTIME_INVALID_REQUEST',
      );
    }
    const gate = this.control(req.action);
    if (!gate.ok) return gate.result;
    const clients = this.connectedClients(gate.control);
    if (clients.length === 0)
      return actionFailed(req.action, DISCONNECTED_MESSAGE, 'BROWSER_RUNTIME_UNAVAILABLE');
    return actionOk(req.action, { ready: true, backend: this.kind, connected: true });
  }

  private handleProfiles(req: BackendRequest): BackendResult {
    const gate = this.control(req.action);
    if (!gate.ok) return gate.result;
    const profiles = this.connectedClients(gate.control).map((c) => ({
      id: c.id,
      name: c.id,
      browser: c.browser,
      version: c.version,
      connected: c.connected,
    }));
    return actionOk(req.action, {
      backend: this.kind,
      profiles,
      note: 'profile 是浏览器连接 id;同一浏览器的多个用户配置各是一条连接。它不携带按站点的登录信号。',
    });
  }

  private async handleTabs(req: BackendRequest): Promise<BackendResult> {
    const gate = this.control(req.action);
    if (!gate.ok) return gate.result;
    const clients = this.connectedClients(gate.control).filter(
      (c) => !req.profile || c.id === req.profile || c.id.startsWith(req.profile),
    );
    if (clients.length === 0)
      return actionFailed(req.action, DISCONNECTED_MESSAGE, 'BROWSER_RUNTIME_UNAVAILABLE');
    const tabs: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const client of clients) {
      const listed = await gate.control.bridge.act('tabs', {
        browser: client.id,
        limit: Math.min(100, Math.max(1, req.limit ?? 50)),
      });
      if (!listed.ok) return this.failureResult(req.action, listed);
      for (const tab of (Array.isArray(listed.tabs) ? listed.tabs : []) as Array<
        Record<string, unknown>
      >) {
        if (typeof tab.id !== 'number') continue;
        if (tab.redacted || typeof tab.url !== 'string') {
          tabs.push({
            targetId: this.targetKey(client.id, tab.id),
            redacted: true,
            browser: client.id,
            ...(tab.status ? { status: tab.status } : {}),
            ...(tab.error ? { error: tab.error } : {}),
          });
          continue;
        }
        const record = this.register(client.id, {
          id: tab.id,
          url: tab.url,
          title: typeof tab.title === 'string' ? tab.title : undefined,
        });
        seen.add(record.targetId);
        tabs.push({
          ...this.describe(record),
          active: tab.active === true,
          ...(tab.status ? { status: tab.status } : {}),
        });
      }
    }
    // 已关闭的标签页从映射里清掉,别名不复用。
    for (const [targetId, record] of this.targets) {
      if (clients.some((c) => c.id === record.clientId) && !seen.has(targetId))
        this.targets.delete(targetId);
    }
    return actionOk(req.action, {
      backend: this.kind,
      tabs,
      note: '这些是用户浏览器里当前打开的标签页;只在需要时操作,不要关闭或重排它们。',
    });
  }

  /** open / navigate:扩展按 URL 复用或新开后台标签页并等待加载;结果映射为 targetId。 */
  private async handleOpen(req: BackendRequest): Promise<BackendResult> {
    const gate = this.control(req.action);
    if (!gate.ok) return gate.result;
    const url =
      typeof req.url === 'string'
        ? req.url
        : typeof req.targetUrl === 'string'
          ? req.targetUrl
          : undefined;
    if (!url) return actionFailed(req.action, 'url required', 'BROWSER_RUNTIME_INVALID_REQUEST');
    const existing = req.action === 'navigate' ? this.resolveTarget(req.targetId) : null;
    const picked = this.pickClient(req.action, gate.control, req.profile ?? existing?.clientId);
    if (!picked.ok) return picked.result;
    const navigated = await gate.control.bridge.act('navigate', { url, browser: picked.clientId });
    if (!navigated.ok) return this.failureResult(req.action, navigated);
    const actualUrl = typeof navigated.url === 'string' ? navigated.url : url;
    const listed = await gate.control.bridge.act('tabs', { browser: picked.clientId, limit: 100 });
    const tab =
      listed.ok && Array.isArray(listed.tabs)
        ? (
            listed.tabs as Array<{
              id?: unknown;
              url?: unknown;
              title?: unknown;
              redacted?: boolean;
            }>
          ).find(
            (t) =>
              !t.redacted && typeof t.id === 'number' && (t.url === actualUrl || t.url === url),
          )
        : undefined;
    if (!tab || typeof tab.id !== 'number' || typeof tab.url !== 'string') {
      return {
        ...actionOk(req.action, {
          backend: this.kind,
          url: actualUrl,
          note: '页面已打开,但未能在标签页列表里定位到它;用 tabs 重新选择 targetId。',
        }),
      };
    }
    const record = this.register(
      picked.clientId,
      { id: tab.id, url: tab.url, title: typeof tab.title === 'string' ? tab.title : undefined },
      typeof req.label === 'string' ? req.label : undefined,
    );
    return actionOk(req.action, {
      backend: this.kind,
      ...this.describe(record),
      ...(existing && existing.targetId !== record.targetId
        ? {
            replacedTargetId: existing.targetId,
            note: '扩展按 URL 寻址:导航落在一个(新的或复用的)标签页上,后续请用返回的 targetId。',
          }
        : {}),
    });
  }

  private async handleSnapshot(req: BackendRequest): Promise<BackendResult> {
    const gate = this.control(req.action);
    if (!gate.ok) return gate.result;
    const located = await this.locate(req.action, gate.control, req.targetId);
    if (!located.ok) return located.result;
    if (req.frame) return unsupported(req.action, '按 frame 快照');
    const maxChars = Math.min(30000, Math.max(256, req.maxChars ?? 6000));
    const job = await gate.control.bridge.act('snapshot', {
      url: located.record.url,
      browser: located.record.clientId,
      maxChars,
      ...(typeof req.selector === 'string' ? { selector: req.selector } : {}),
    });
    if (!job.ok) return this.failureResult(req.action, job);
    const record = located.record;
    if (typeof job.url === 'string') record.url = job.url;
    if (typeof job.title === 'string') record.title = job.title;
    const refs: Record<string, { role: string; name?: string }> = {};
    const elementLines: string[] = [];
    for (const line of String(job.elements ?? '').split('\n')) {
      const match = /^\[([a-f0-9]{32})\] (\S+) ?(.*)$/.exec(line);
      if (!match) continue;
      const [, ref, role, name] = match;
      refs[ref] = { role, ...(name ? { name } : {}) };
      elementLines.push(`- ${role}${name ? ` "${name}"` : ''} [ref=${ref}]`);
    }
    const text = typeof job.text === 'string' ? job.text : '';
    const lines = [
      ...(record.title ? [`# ${record.title}`] : []),
      ...(text ? text.split('\n') : []),
      ...(elementLines.length ? ['', '## interactive', ...elementLines] : []),
    ];
    const snapshot = lines.join('\n');
    return actionOk(req.action, {
      format: 'ai',
      backend: this.kind,
      targetId: record.targetId,
      url: record.url,
      ...(record.title ? { title: record.title } : {}),
      snapshot,
      refs,
      stats: {
        lines: lines.length,
        chars: snapshot.length,
        refs: Object.keys(refs).length,
        interactive: Object.keys(refs).length,
      },
      truncated: job.truncated === true,
      untrusted_content: true,
    });
  }

  private async handleAct(req: BackendRequest): Promise<BackendResult> {
    const request = req.request;
    if (!request)
      return actionFailed(req.action, 'act requires request', 'BROWSER_RUNTIME_INVALID_REQUEST');
    const gate = this.control(req.action);
    if (!gate.ok) return gate.result;
    const targetId = request.targetId ?? req.targetId;
    if (
      request.kind === 'wait' &&
      typeof request.timeMs === 'number' &&
      !request.selector &&
      !request.loadState &&
      !request.url &&
      !request.textGone &&
      !request.fn
    ) {
      await sleep(Math.min(30000, Math.max(0, request.timeMs)));
      return actionOk(req.action, {
        backend: this.kind,
        kind: 'wait',
        waitedMs: Math.min(30000, Math.max(0, request.timeMs)),
      });
    }
    const located = await this.locate(req.action, gate.control, targetId);
    if (!located.ok) return located.result;
    const record = located.record;
    const bridge = gate.control.bridge;
    const base = { url: record.url, browser: record.clientId };
    switch (request.kind) {
      case 'click':
      case 'hover':
      case 'press':
      case 'select':
      case 'type':
      case 'fill': {
        if (
          request.kind === 'click' &&
          (request.doubleClick ||
            request.button ||
            request.modifiers?.length ||
            request.x !== undefined)
        ) {
          return unsupported(req.action, '双击、右键、修饰键或坐标点击');
        }
        if (request.query) return unsupported(req.action, '语义元素查询(query)');
        if (
          (request.kind === 'type' || request.kind === 'fill') &&
          typeof request.text !== 'string'
        ) {
          return actionFailed(
            req.action,
            'type/fill requires text',
            'BROWSER_RUNTIME_INVALID_REQUEST',
          );
        }
        const kind = request.kind === 'fill' ? 'type' : request.kind;
        const job = await bridge.act(kind, {
          ...base,
          ...(request.ref ? { ref: request.ref } : {}),
          ...(request.selector ? { selector: request.selector } : {}),
          ...(typeof request.text === 'string' ? { text: request.text } : {}),
          ...(request.submit ? { submit: true } : {}),
          ...(request.key ? { key: request.key } : {}),
          ...(request.values ? { values: request.values } : {}),
        });
        if (!job.ok) return this.failureResult(req.action, job);
        if (typeof job.url === 'string') record.url = job.url;
        return actionOk(req.action, {
          backend: this.kind,
          targetId: record.targetId,
          kind: request.kind,
          execution: job.execution ?? 'executed',
          url: record.url,
          note: job.note,
        });
      }
      case 'wait':
        return this.handleWait(req, record, bridge);
      case 'evaluate':
        return this.handleDomRead(req, record, bridge);
      case 'clickCoords':
      case 'drag':
      case 'resize':
      case 'saveResource':
      case 'close':
        return unsupported(req.action, `act:${request.kind}`);
      default:
        return actionFailed(
          req.action,
          `unsupported act kind ${String(request.kind)}`,
          'BROWSER_RUNTIME_INVALID_REQUEST',
        );
    }
  }

  private async handleWait(
    req: BackendRequest,
    record: TargetRecord,
    bridge: BrowserExtensionBridge,
  ): Promise<BackendResult> {
    const request = req.request!;
    if (request.fn || request.textGone) return unsupported(req.action, 'wait.fn / wait.textGone');
    const timeoutMs = Math.min(30000, Math.max(100, request.timeoutMs ?? 15000));
    const started = (this.opts.now ?? Date.now)();
    if (request.selector) {
      const job = await bridge.act('text', {
        url: record.url,
        browser: record.clientId,
        selector: request.selector,
        waitFor: request.selector,
        waitMs: Math.min(15000, timeoutMs),
        maxChars: 256,
      });
      if (!job.ok) return this.failureResult(req.action, job);
      return actionOk(req.action, {
        backend: this.kind,
        targetId: record.targetId,
        kind: 'wait',
        selector: request.selector,
        waitedMs: (this.opts.now ?? Date.now)() - started,
      });
    }
    if (request.loadState) {
      const job = await bridge.act('navigate', { url: record.url, browser: record.clientId });
      if (!job.ok) return this.failureResult(req.action, job);
      return actionOk(req.action, {
        backend: this.kind,
        targetId: record.targetId,
        kind: 'wait',
        loadState: request.loadState,
        url: job.url ?? record.url,
      });
    }
    if (request.url) {
      const deadline = started + timeoutMs;
      for (;;) {
        const listed = await bridge.act('tabs', { browser: record.clientId, limit: 100 });
        const current =
          listed.ok && Array.isArray(listed.tabs)
            ? (listed.tabs as Array<{ id?: unknown; url?: unknown }>).find(
                (t) => t.id === record.tabId,
              )
            : undefined;
        if (typeof current?.url === 'string' && current.url.includes(request.url)) {
          record.url = current.url;
          return actionOk(req.action, {
            backend: this.kind,
            targetId: record.targetId,
            kind: 'wait',
            url: current.url,
          });
        }
        if ((this.opts.now ?? Date.now)() >= deadline)
          return actionFailed(
            req.action,
            `等待 ${timeoutMs}ms 后标签页仍未到达包含 ${request.url} 的地址`,
          );
        await sleep(250);
      }
    }
    if (typeof request.timeMs === 'number') {
      await sleep(Math.min(30000, Math.max(0, request.timeMs)));
      return actionOk(req.action, {
        backend: this.kind,
        targetId: record.targetId,
        kind: 'wait',
        waitedMs: request.timeMs,
      });
    }
    return actionFailed(
      req.action,
      'wait requires selector、loadState、url 或 timeMs',
      'BROWSER_RUNTIME_INVALID_REQUEST',
    );
  }

  /** evaluate 只接受声明式读取(extract / login-wall);任意 fn 不进用户浏览器。 */
  private async handleDomRead(
    req: BackendRequest,
    record: TargetRecord,
    bridge: BrowserExtensionBridge,
  ): Promise<BackendResult> {
    const domRead = (
      req.request as { domRead?: { kind?: string; extract?: Record<string, unknown> } }
    ).domRead;
    if (!domRead) return unsupported(req.action, '任意页面脚本(evaluate.fn)');
    if (domRead.kind === 'login-wall') {
      // The extension refuses to read password / one-time-code fields at all (they are sensitive
      // fields), so a declarative probe cannot tell "absent" from "present but withheld". Report
      // the check as unavailable instead of a false negative; the snapshot text still shows the
      // sign-in page to the agent, and the user's own browser normally carries their sign-ins.
      return actionOk(req.action, {
        backend: this.kind,
        targetId: record.targetId,
        result: { password: false, code: false, unavailable: true },
        note: '用户浏览器执行端不读取密码/验证码字段,无法做登录墙检测;以快照内容判断是否需要登录。',
      });
    }
    if (domRead.kind !== 'extract' || !domRead.extract)
      return unsupported(req.action, '未知的声明式读取');
    const spec = domRead.extract as {
      from?: string;
      multiple?: boolean;
      limit?: number;
      fields: Record<string, string | { selector?: string; attr?: string; type?: string }>;
    };
    // The MCP contract resolves field selectors against `document` (or the `from`
    // container) and lets a field omit its selector to read the container itself.
    // The extension resolves them against document.body (or the row) and spells the
    // container as ':self'. Translate the document-level spellings so a whole-page
    // read (`body`, `:scope`) is not silently null.
    const mapSelector = (selector: string | undefined): string => {
      const trimmed = selector?.trim();
      if (!trimmed || trimmed === ':scope' || trimmed === ':self') return ':self';
      if (!spec.from && /^(html|body)$/i.test(trimmed)) return ':self';
      return trimmed;
    };
    const fields: Record<string, string | { selector: string; attr?: string }> = {};
    for (const [name, field] of Object.entries(spec.fields)) {
      if (typeof field === 'string') {
        fields[name] = mapSelector(field);
        continue;
      }
      if (field.type === 'html') return unsupported(req.action, 'extract type:"html"');
      const selector = mapSelector(field.selector);
      if (field.type === 'href') fields[name] = { selector, attr: 'href' };
      else if (field.attr) fields[name] = { selector, attr: field.attr };
      else fields[name] = { selector };
    }
    // Single record: `from` is the extension's root (`selector`); it only reads
    // `from` as a row selector in multiple mode.
    const scope = spec.multiple
      ? { multiple: true as const, ...(spec.from ? { from: spec.from } : {}) }
      : spec.from
        ? { selector: spec.from }
        : {};
    const job = await bridge.act('extract', {
      url: record.url,
      browser: record.clientId,
      fields,
      ...scope,
      ...(spec.limit ? { limit: Math.min(100, Math.max(1, spec.limit)) } : {}),
      maxChars: Math.min(30000, Math.max(256, req.maxChars ?? 6000)),
    });
    if (!job.ok) {
      const error = String(job.error ?? '');
      if (error === 'INVALID_ARGS') {
        return actionOk(req.action, {
          backend: this.kind,
          targetId: record.targetId,
          result: {
            ok: false,
            error: String(job.message ?? 'invalid extract spec'),
            count: 0,
            records: [],
          },
        });
      }
      return this.failureResult(req.action, job);
    }
    if (typeof job.url === 'string') record.url = job.url;
    const records = spec.multiple
      ? Array.isArray(job.records)
        ? job.records
        : []
      : [job.record ?? {}];
    return actionOk(req.action, {
      backend: this.kind,
      targetId: record.targetId,
      url: record.url,
      result: { ok: true, count: records.length, records },
      ...(job.truncated === true ? { truncated: true } : {}),
      ...(job.cursorFound !== undefined ? { cursorFound: job.cursorFound } : {}),
      untrusted_content: true,
    });
  }
}
