/**
 * user-browser-backend.test — 用户浏览器执行端对 BrowserControlRequest 的翻译。
 *
 * 测试价值
 * - 生产入口与可观察结果:UserBrowserBackend.call;MCP 层看到的 status / tabs / open /
 *   snapshot / act / extract 数据形状,以及不支持操作的明确拒绝。
 * - 规则依据:2026-10-27 融合决定——扩展权限不扩大、能力不足明确拒绝、不悄悄换浏览器;
 *   扩展按 URL 寻址,页面跳转须报 PAGE_CHANGED 而不是猜新页。
 * - 现有覆盖缺口:新后端。
 * - 最小失败输入:未装页面控制插件;多连接未指定 profile;标签页 URL 与记录不一致;
 *   evaluate 不带 domRead。
 * - tier:unit(假桥接);实测耗时 < 1 秒。
 */

import { describe, expect, it, vi } from 'vitest';

import type { BrowserControlRequest } from '@cindy/browser-control-runtime';

import { UserBrowserBackend, type UserBrowserPageControl } from '../user-browser-backend';

type Tab = { id: number; url: string; title?: string; active?: boolean; redacted?: boolean };

function fakeControl(options: { clients?: string[]; tabs?: Record<string, Tab[]> } = {}) {
  const clients = options.clients ?? ['client-aaaaaaaa'];
  const tabs = options.tabs ?? {
    [clients[0]]: [{ id: 7, url: 'https://example.test/a', title: 'A', active: true }],
  };
  const jobs: Array<[string, Record<string, unknown>]> = [];
  const responses = new Map<
    string,
    (payload: Record<string, unknown>) => Record<string, unknown>
  >();
  const bridge = {
    connectedClients: () =>
      clients.map((id) => ({
        id,
        browser: 'chrome',
        version: '0.4.23',
        protocolVersion: '0.4.13',
        connected: true,
      })),
    status: async () => ({
      ok: true,
      port: 18810,
      extension_ids: ['a'.repeat(32)],
      pending: 0,
      clients: clients.map((id) => ({
        id,
        browser: 'chrome',
        version: '0.4.23',
        protocolVersion: '0.4.13',
        connected: true,
      })),
    }),
    act: vi.fn(async (action: string, payload: Record<string, unknown>) => {
      jobs.push([action, payload]);
      const scripted = responses.get(action);
      if (scripted) return scripted(payload);
      if (action === 'tabs') return { ok: true, tabs: tabs[payload.browser as string] ?? [] };
      if (action === 'navigate') return { ok: true, url: payload.url };
      return { ok: true, url: payload.url, execution: 'executed', note: 'dispatched' };
    }),
  };
  const control: UserBrowserPageControl = {
    bridge: bridge as unknown as UserBrowserPageControl['bridge'],
    ghostId: 'my-browser',
    pluginName: 'Cindy Chrome',
  };
  return { control, jobs, responses, tabs };
}

function backend(control: UserBrowserPageControl | null) {
  return new UserBrowserBackend({
    getPageControl: () => control,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
}

const call = (b: UserBrowserBackend, req: Record<string, unknown>) =>
  b.call(req as unknown as BrowserControlRequest);

describe('UserBrowserBackend · 就绪与连接', () => {
  it('没有页面控制插件时 status 如实报告,动作按未配置拒绝', async () => {
    const b = backend(null);
    expect(await call(b, { action: 'status' })).toMatchObject({
      ok: true,
      data: { ready: false, configured: false, backend: 'user-browser' },
    });
    expect(await call(b, { action: 'tabs' })).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_NOT_CONFIGURED',
    });
  });

  it('扩展未连接时 status 未就绪、start 失败;已连接时列出连接与能力表', async () => {
    const none = fakeControl({ clients: [] });
    const b = backend(none.control);
    expect(await call(b, { action: 'status' })).toMatchObject({
      ok: true,
      data: { ready: false, configured: true, connected: false },
    });
    expect(await call(b, { action: 'start' })).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
    });
    const one = fakeControl();
    const ready = backend(one.control);
    expect(await call(ready, { action: 'status' })).toMatchObject({
      ok: true,
      data: {
        ready: true,
        connected: true,
        plugin: 'my-browser',
        capabilities: { evaluate: false, screenshot: false },
      },
    });
    expect(await call(ready, { action: 'doctor' })).toMatchObject({
      ok: true,
      data: { port: 18810 },
    });
    expect(await call(ready, { action: 'start', proxyServer: 'http://proxy' })).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
    });
    expect(await call(ready, { action: 'profiles' })).toMatchObject({
      ok: true,
      data: { profiles: [{ id: 'client-aaaaaaaa', browser: 'chrome' }] },
    });
  });

  it('多条连接且未指定 profile 时拒绝,不猜账号;profile 前缀可定位连接', async () => {
    const two = fakeControl({
      clients: ['client-aaaaaaaa', 'client-bbbbbbbb'],
      tabs: { 'client-bbbbbbbb': [{ id: 1, url: 'https://b.test/' }] },
    });
    const b = backend(two.control);
    expect(await call(b, { action: 'open', url: 'https://b.test/' })).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
    });
    expect(
      await call(b, { action: 'open', url: 'https://b.test/', profile: 'client-bbbb' }),
    ).toMatchObject({ ok: true, data: { browser: 'client-bbbbbbbb', url: 'https://b.test/' } });
  });
});

describe('UserBrowserBackend · 标签页与寻址', () => {
  it('tabs 映射稳定 targetId 与别名,保留被打码行;open 返回可用 targetId 并记住 label', async () => {
    const fake = fakeControl({
      tabs: {
        'client-aaaaaaaa': [
          { id: 7, url: 'https://example.test/a', title: 'A', active: true },
          { id: 9, url: '', redacted: true },
        ],
      },
    });
    const b = backend(fake.control);
    const listed = await call(b, { action: 'tabs' });
    expect(listed.ok).toBe(true);
    const tabs = (listed.data as { tabs: Array<Record<string, unknown>> }).tabs;
    expect(tabs[0]).toMatchObject({
      targetId: 'client-a:7',
      suggestedTargetId: 't1',
      tabId: 't1',
      url: 'https://example.test/a',
      title: 'A',
      active: true,
    });
    expect(tabs[1]).toMatchObject({ targetId: 'client-a:9', redacted: true });
    fake.tabs['client-aaaaaaaa'].push({ id: 11, url: 'https://example.test/b', title: 'B' });
    const opened = await call(b, {
      action: 'open',
      url: 'https://example.test/b',
      label: 'checkout',
    });
    expect(opened).toMatchObject({
      ok: true,
      data: {
        targetId: 'client-a:11',
        suggestedTargetId: 'checkout',
        label: 'checkout',
        url: 'https://example.test/b',
      },
    });
    expect(fake.jobs.find(([action]) => action === 'navigate')?.[1]).toMatchObject({
      url: 'https://example.test/b',
      browser: 'client-aaaaaaaa',
    });
    // navigate 可能落到另一个标签页:返回新 targetId 并标明替换。
    fake.tabs['client-aaaaaaaa'].push({ id: 12, url: 'https://example.test/c' });
    const navigated = await call(b, {
      action: 'navigate',
      targetId: 'checkout',
      url: 'https://example.test/c',
    });
    expect(navigated).toMatchObject({
      ok: true,
      data: { targetId: 'client-a:12', replacedTargetId: 'client-a:11' },
    });
  });

  it('标签页在两次调用之间跳转时报 PAGE_CHANGED 并刷新记录;关闭后提示重新选择', async () => {
    const fake = fakeControl();
    const b = backend(fake.control);
    await call(b, { action: 'tabs' });
    fake.tabs['client-aaaaaaaa'][0].url = 'https://example.test/moved';
    const changed = await call(b, { action: 'snapshot', targetId: 't1' });
    expect(changed).toMatchObject({
      ok: false,
      data: { error: 'PAGE_CHANGED', url: 'https://example.test/moved' },
    });
    expect(fake.jobs.some(([action]) => action === 'snapshot')).toBe(false);
    fake.tabs['client-aaaaaaaa'] = [];
    expect(await call(b, { action: 'snapshot', targetId: 't1' })).toMatchObject({
      ok: false,
      message: expect.stringContaining('已关闭'),
    });
    expect(await call(b, { action: 'snapshot', targetId: 'unknown' })).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
    });
  });
});

describe('UserBrowserBackend · 读取与动作', () => {
  it('snapshot 把扩展的元素行转成 ref 表与可读快照', async () => {
    const fake = fakeControl();
    const ref = 'c'.repeat(32);
    fake.responses.set('snapshot', (payload) => ({
      ok: true,
      url: payload.url,
      title: 'A',
      text: 'Hello page',
      elements: `[${ref}] button Submit\n[${'d'.repeat(32)}] a`,
      truncated: false,
    }));
    const b = backend(fake.control);
    await call(b, { action: 'tabs' });
    const snap = await call(b, {
      action: 'snapshot',
      targetId: 'client-a:7',
      selector: 'main',
      maxChars: 512,
    });
    expect(snap).toMatchObject({
      ok: true,
      data: {
        format: 'ai',
        targetId: 'client-a:7',
        url: 'https://example.test/a',
        refs: { [ref]: { role: 'button', name: 'Submit' }, ['d'.repeat(32)]: { role: 'a' } },
        untrusted_content: true,
      },
    });
    const snapshot = (snap.data as { snapshot: string }).snapshot;
    expect(snapshot).toContain('# A');
    expect(snapshot).toContain('Hello page');
    expect(snapshot).toContain(`- button "Submit" [ref=${ref}]`);
    expect(fake.jobs.at(-1)).toEqual([
      'snapshot',
      {
        url: 'https://example.test/a',
        browser: 'client-aaaaaaaa',
        maxChars: 512,
        selector: 'main',
      },
    ]);
  });

  it('click / type / press / select / wait 翻译成扩展作业;不支持的 kind 明确拒绝', async () => {
    const fake = fakeControl();
    const b = backend(fake.control);
    await call(b, { action: 'tabs' });
    const base = { url: 'https://example.test/a', browser: 'client-aaaaaaaa' };
    expect(
      await call(b, { action: 'act', targetId: 't1', request: { kind: 'click', ref: 'r1' } }),
    ).toMatchObject({ ok: true, data: { kind: 'click', execution: 'executed' } });
    expect(fake.jobs.at(-1)).toEqual(['click', { ...base, ref: 'r1' }]);
    await call(b, {
      action: 'act',
      request: { kind: 'fill', targetId: 't1', selector: 'input', text: 'hi', submit: true },
    });
    expect(fake.jobs.at(-1)).toEqual([
      'type',
      { ...base, selector: 'input', text: 'hi', submit: true },
    ]);
    await call(b, { action: 'act', targetId: 't1', request: { kind: 'press', key: 'Enter' } });
    expect(fake.jobs.at(-1)).toEqual(['press', { ...base, key: 'Enter' }]);
    await call(b, {
      action: 'act',
      targetId: 't1',
      request: { kind: 'select', selector: 'select', values: ['x'] },
    });
    expect(fake.jobs.at(-1)).toEqual(['select', { ...base, selector: 'select', values: ['x'] }]);
    await call(b, {
      action: 'act',
      targetId: 't1',
      request: { kind: 'wait', selector: '.ready', timeoutMs: 5000 },
    });
    expect(fake.jobs.at(-1)).toEqual([
      'text',
      { ...base, selector: '.ready', waitFor: '.ready', waitMs: 5000, maxChars: 256 },
    ]);
    expect(
      await call(b, { action: 'act', targetId: 't1', request: { kind: 'wait', timeMs: 1 } }),
    ).toMatchObject({ ok: true, data: { kind: 'wait', waitedMs: 1 } });
    for (const request of [
      { kind: 'click', ref: 'r1', doubleClick: true },
      { kind: 'drag', startRef: 'a', endRef: 'b' },
      { kind: 'evaluate', fn: '() => 1' },
      { kind: 'wait', fn: '() => true' },
      { kind: 'click', query: { role: 'button' } },
    ]) {
      expect(await call(b, { action: 'act', targetId: 't1', request })).toMatchObject({
        ok: false,
        errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
        message: expect.stringContaining('专用浏览器'),
      });
    }
    for (const action of [
      'screenshot',
      'pdf',
      'console',
      'upload',
      'dialog',
      'requests',
      'responseBody',
      'focus',
      'close',
      'recipeCommand',
    ]) {
      expect(await call(b, { action, targetId: 't1' })).toMatchObject({
        ok: false,
        errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
      });
    }
    expect(
      fake.jobs.filter(
        ([action]) => !['tabs', 'click', 'type', 'press', 'select', 'text'].includes(action),
      ),
    ).toEqual([]);
  });

  it('声明式读取走扩展 extract:字段映射、结果包装;登录墙检测如实报告不可用', async () => {
    const fake = fakeControl();
    fake.responses.set('extract', (payload) => ({
      ok: true,
      url: payload.url,
      count: 1,
      records: [{ title: 'T', link: 'https://example.test/x' }],
      truncated: false,
    }));
    const b = backend(fake.control);
    await call(b, { action: 'tabs' });
    const extracted = await call(b, {
      action: 'act',
      targetId: 't1',
      request: {
        kind: 'evaluate',
        fn: 'ignored',
        domRead: {
          kind: 'extract',
          extract: {
            from: '.row',
            multiple: true,
            limit: 5,
            fields: { title: 'h3', link: { selector: 'a', type: 'href' }, self: { attr: 'title' } },
          },
        },
      },
    });
    expect(extracted).toMatchObject({
      ok: true,
      data: { result: { ok: true, count: 1, records: [{ title: 'T' }] }, untrusted_content: true },
    });
    expect(fake.jobs.at(-1)).toEqual([
      'extract',
      {
        url: 'https://example.test/a',
        browser: 'client-aaaaaaaa',
        fields: {
          title: 'h3',
          link: { selector: 'a', attr: 'href' },
          self: { selector: ':self', attr: 'title' },
        },
        from: '.row',
        multiple: true,
        limit: 5,
        maxChars: 6000,
      },
    ]);
    // Bug regression: a whole-page read (`body` / `:scope`, no `from`) came back
    // null because the extension resolves fields against document.body and only
    // knows ':self'; a single-record `from` was ignored for the same reason.
    await call(b, {
      action: 'act',
      targetId: 't1',
      request: {
        kind: 'evaluate',
        fn: 'ignored',
        domRead: {
          kind: 'extract',
          extract: { fields: { page: 'body', self: { selector: ':scope' }, rows: 'tr' } },
        },
      },
    });
    expect(fake.jobs.at(-1)?.[1]).toMatchObject({
      fields: { page: ':self', self: { selector: ':self' }, rows: 'tr' },
    });
    expect(fake.jobs.at(-1)?.[1]).not.toHaveProperty('from');
    await call(b, {
      action: 'act',
      targetId: 't1',
      request: {
        kind: 'evaluate',
        fn: 'ignored',
        domRead: { kind: 'extract', extract: { from: 'main', fields: { text: {} } } },
      },
    });
    expect(fake.jobs.at(-1)?.[1]).toMatchObject({
      selector: 'main',
      fields: { text: { selector: ':self' } },
    });
    expect(fake.jobs.at(-1)?.[1]).not.toHaveProperty('from');
    expect(
      await call(b, {
        action: 'act',
        targetId: 't1',
        request: {
          kind: 'evaluate',
          fn: 'x',
          domRead: { kind: 'extract', extract: { fields: { body: { type: 'html' } } } },
        },
      }),
    ).toMatchObject({ ok: false, errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST' });
    const wall = await call(b, {
      action: 'act',
      targetId: 't1',
      request: { kind: 'evaluate', fn: 'x', domRead: { kind: 'login-wall' } },
    });
    expect(wall).toMatchObject({
      ok: true,
      data: { result: { password: false, code: false, unavailable: true } },
    });
    expect(
      fake.jobs.filter(
        ([action, payload]) =>
          action === 'extract' && (payload.fields as Record<string, unknown>).password,
      ),
    ).toEqual([]);
  });
});
