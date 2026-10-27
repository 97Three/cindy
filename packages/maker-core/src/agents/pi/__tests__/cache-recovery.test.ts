import { runInNewContext } from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PI_CACHE_RECOVERY_SOURCE } from '../cache-recovery-source.js';

// Unit: real generated provider wrapper, not a duplicate classifier. Protects
// opaque-400 recovery, one input budget, final hook comparison and TTL storage.
const model = { provider: 'fixture', id: 'wire', api: 'openai-completions', baseUrl: 'http://127.0.0.1/v1' };
const routeKey = 'a'.repeat(64);
const key = JSON.stringify(['connection', 'wire', routeKey]);
const body = { model: 'wire', messages: [{ role: 'user', content: 'OK' }], prompt_cache_key: 'cache', prompt_cache_retention: '24h' };
const failure = (text = '400: {"error":{"message":"opaque refusal","param":null,"type":"invalid_request_error"}}') => ({
  type: 'error', error: { role: 'assistant', content: [], stopReason: 'error', errorMessage: text, usage: { output: 0 } },
});
const success = { type: 'done', message: { stopReason: 'stop', content: [{ type: 'text', text: 'OK' }], usage: { input: 3, output: 1, cacheRead: 2 } } };
function fixture() {
  let now = 1000000000;
  const files = new Map<string, string>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const rules = [{ ...model, providerId: 'connection', routeKey }];
  files.set('/agent/pi-cache-compatibility.json', JSON.stringify(rules));
  let writeFails = false;
  const fs = {
    statSync: (name: string) => {
      if (!files.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { size: Buffer.byteLength(files.get(name)!), mtimeMs: 1000 };
    },
    readFileSync: (name: string) => { fs.statSync(name); return files.get(name); },
    writeFileSync: (name: string, text: string) => { if (writeFails) throw new Error('read-only'); files.set(name, text); },
    renameSync: (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
    rmSync: (name: string) => { files.delete(name); },
  };
  const api = runInNewContext(PI_CACHE_RECOVERY_SOURCE + '\ninstallCindyCacheRecovery(pi)', {
    pi: { on: (name: string, fn: (...args: any[]) => void) => handlers.set(name, fn) },
    process: { env: { PI_CODING_AGENT_DIR: '/agent', CINDY_PI_CACHE_COMPAT_FILE: '/compat.json' } },
    // The in-memory filesystem uses POSIX keys on every host, including Windows.
    ...fs, path: path.posix, createHash, randomUUID, Buffer, Date: { now: () => now }, homedir: () => '/home/fixture',
  });
  const fresh = () => handlers.get('input')!({ source: 'rpc' }, { isIdle: () => true });
  const interrupt = () => handlers.get('input')!({ source: 'rpc', streamingBehavior: 'steer' }, { isIdle: () => false });
  const sent: any[] = [];
  let invocation = 0;
  const request = async (events: any[] = [failure(), success], options: any = {}, prepare?: (n: number) => void, selectedModel = model) => {
    const invoke = async function* (opts: any) {
      const n = invocation++;
      prepare?.(n);
      try {
        const payload = await opts.onPayload(structuredClone(body), selectedModel);
        sent.push(payload);
      } catch (error) {
        yield failure(String(error));
        return;
      }
      const event = events[n] ?? events.at(-1);
      if (Array.isArray(event)) yield* event; else yield event;
    };
    const output = [];
    for await (const event of api.wrap(selectedModel, options, invoke)) output.push(event);
    return output;
  };
  return { api, handlers, fresh, interrupt, request, files, sent, clock: (value: number) => { now = value; },
    failWrites: () => { writeFails = true; }, record: () => JSON.parse(files.get('/compat.json') ?? '{"routes":{}}').routes[key] };
}

describe('Pi native cache recovery', () => {
  it.each(['openai-completions', 'openai-responses'])('keeps learned payload recovery without taking provider ownership on an older %s registry', api => {
    const h = fixture();
    const selected = { ...model, api };
    const rules = [{ ...selected, providerId: 'connection', routeKey }];
    h.files.set('/agent/pi-cache-compatibility.json', JSON.stringify(rules));
    h.fresh();
    const record = { supportsLongCacheRetention: false, learnedAt: 1000000000,
      expiresAt: 1086400000, evidence: 'opaque' };
    // Another session can learn after the last RPC input. Native continuation
    // has no new RPC input event, but must still consume the durable record.
    h.files.set('/compat.json', JSON.stringify({ routes: { [key]: record } }));
    const ctx = { model: selected, modelRegistry: { getProvider: vi.fn() } };
    const hook = h.handlers.get('before_provider_request')!;
    const payload = { ...body, service_tier: 'priority' };
    expect(hook?.({ payload }, ctx) ?? payload).toEqual({ model: 'wire', messages: body.messages, service_tier: 'priority' });
    expect(ctx.modelRegistry.getProvider).not.toHaveBeenCalled();
    expect(payload).toHaveProperty('prompt_cache_key', 'cache');
    // A newly loaded bridge reads the same durable record, not process memory.
    const restarted = fixture();
    restarted.files.set('/agent/pi-cache-compatibility.json', JSON.stringify(rules));
    restarted.files.set('/compat.json', h.files.get('/compat.json')!);
    restarted.fresh();
    const recovered = restarted.handlers.get('before_provider_request')!;
    expect(recovered({ payload }, ctx)).not.toHaveProperty('prompt_cache_key');
    expect(recovered({ payload }, { ...ctx, model: { ...selected, baseUrl: selected.baseUrl + '/other' } })).toBeUndefined();
    expect(recovered({ payload }, { ...ctx, modelRegistry: { ...ctx.modelRegistry, getRegisteredNativeProvider: vi.fn() } })).toBeUndefined();
    restarted.clock(1086400001);
    expect(recovered({ payload }, ctx)).toBeUndefined();
    expect(restarted.record()).toEqual(record);
  });

  it('preserves normal caching and bounds legacy records in the older registry payload hook', () => {
    const h = fixture();
    const ctx = { model, modelRegistry: {} };
    const hook = () => h.handlers.get('before_provider_request')?.({ payload: body }, ctx);
    h.fresh();
    expect(hook()).toBeUndefined();
    h.files.set('/compat.json', JSON.stringify({ routes: { [key]: { supportsLongCacheRetention: false } } }));
    h.clock(1001); h.fresh();
    expect(hook()).toEqual({ model: 'wire', messages: body.messages });
    h.clock(1000 + 7 * 86400000 + 1); h.fresh();
    expect(hook()).toBeUndefined();
  });

  it('does one final-payload comparison, learns only after generation, and preserves usage', async () => {
    const h = fixture(); h.fresh();
    const hook = vi.fn((payload: any) => ({ ...payload, third_party: 'preserved', service_tier: 'priority' }));
    const result = await h.request(undefined, { onPayload: hook });
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]).toHaveProperty('prompt_cache_retention', '24h');
    expect(h.sent[1]).toEqual({ model: 'wire', messages: body.messages, third_party: 'preserved', service_tier: 'priority' });
    expect(result).toEqual([success]);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(h.record()).toMatchObject({ evidence: 'opaque', learnedAt: 1000000000, expiresAt: 1086400000 });
    h.fresh(); await h.request([success]);
    expect(h.sent[2]).not.toHaveProperty('prompt_cache_key');
    h.clock(1086400001); h.fresh(); await h.request([success]);
    expect(h.sent[3]).toHaveProperty('prompt_cache_key');
  });

  it('stops after two 400s without learning; a new input carries cache again', async () => {
    const h = fixture(); h.fresh();
    expect(await h.request([failure(), failure()])).toEqual([expect.objectContaining({ error: expect.objectContaining({ cindyCacheRecoveryHandled: true }) })]);
    expect(h.sent).toHaveLength(2); expect(h.record()).toBeUndefined();
    await h.request([failure()]); // Native retry in the same input cannot refresh the budget.
    expect(h.sent).toHaveLength(3);
    expect(h.sent[2]).not.toHaveProperty('prompt_cache_key');
    h.fresh(); await h.request([success]);
    expect(h.sent[3]).toHaveProperty('prompt_cache_key');
  });

  it('treats an unfamiliar gateway error type as opaque without a vendor allowlist', async () => {
    const h = fixture(); h.fresh();
    await h.request([failure('400: {"error":{"type":"new_gateway_validation_shape","message":"请求不满足要求"}}'), success]);
    expect(h.sent).toHaveLength(2);
    expect(h.record()).toMatchObject({ evidence: 'opaque', expiresAt: 1086400000 });
  });

  it.each(['401: unauthorized', '429: limited', '500: broken', 'text says 400: failure',
    '400: {"error":{"param":"temperature","message":"invalid"}}',
    '400: {"error":{"code":"context_length_exceeded","message":"opaque"}}',
    '400: {"error":{"type":"authentication_error","message":"opaque"}}',
    '400: Invalid value for prompt_cache_retention', '400: 模型不存在'])('leaves known unrelated failures alone: %s', async text => {
    const h = fixture(); h.fresh(); await h.request([failure(text)]);
    expect(h.sent).toHaveLength(1); expect(h.record()).toBeUndefined();
  });

  it.each([
    'Validation: Unsupported parameter(s): temperature',
    'Unknown field: future_vendor_option',
    "Unsupported parameter(s): ['temperature']",
    "Unsupported parameter(s): ['prompt_cache_key', 'temperature']",
    'Unsupported parameters: prompt_cache_key, temperature',
    "Unsupported parameter(s): 'prompt_cache_key', 'future_vendor_option'",
    '未知请求字段：prompt_cache_key，temperature',
    "The parameter 'temperature' is not supported",
    '未知请求字段：temperature',
    '参数 temperature 不支持',
    'Unsupported parameter: prompt_cache_key; unsupported parameter: temperature',
  ])('does not trial an explicitly rejected other field without structured param: %s', async message => {
    const h = fixture(); h.fresh();
    await h.request([failure('400: ' + JSON.stringify({ error: { type: 'invalid_request_error', param: null, message } })), success]);
    expect(h.sent).toHaveLength(1);
    expect(h.record()).toBeUndefined();
  });

  it.each(['Validation: Unsupported parameter(s): prompt_cache_key',
    'Unsupported parameter: prompt_cache_retention.',
    "The parameter 'prompt_cache_key' is not supported",
    '未知请求字段：prompt_cache_retention',
    "Unsupported parameter(s): ['prompt_cache_key', 'prompt_cache_retention']",
    'Unsupported parameters: prompt_cache_key, prompt_cache_retention',
    "Unsupported parameter(s): 'prompt_cache_key', 'prompt_cache_retention'",
    'Unsupported parameter: prompt_cache_key, use prompt_cache_options instead',
    'Unsupported parameter: prompt_cache_key, please use a supported option',
    '未知请求字段：prompt_cache_key，请改用 prompt_cache_options',
  ])('still learns explicit cache rejection: %s', async message => {
    const h = fixture(); h.fresh();
    await h.request([failure('400: ' + JSON.stringify({ error: { param: null, message } })), success]);
    expect(h.sent).toHaveLength(2);
    expect(h.record()).toMatchObject({ evidence: 'explicit', expiresAt: 1604800000 });
  });

  it.each(['start', 'thinking_delta', 'toolcall_start'])('never retries after %s or a prior tool', async type => {
    const h = fixture(); h.fresh(); await h.request([[{ type }, failure()]]);
    expect(h.sent).toHaveLength(1); expect(h.record()).toBeUndefined();
    h.fresh(); h.handlers.get('tool_execution_start')!(); await h.request([failure()]);
    expect(h.sent).toHaveLength(2);
  });

  it('does not send a changed second request, even when the later payload hook changes it', async () => {
    const h = fixture(); h.fresh(); let n = 0;
    const result = await h.request(undefined, { onPayload: (p: any) => ({ ...p, temperature: n++ }) });
    expect(h.sent).toHaveLength(1);
    expect(result[0].error.errorMessage).toContain('opaque refusal');
    expect(h.record()).toBeUndefined();
  });

  it('respects stop and queued input while a payload hook is awaiting', async () => {
    for (const cancel of [true, false]) {
      const h = fixture(); h.fresh(); const controller = new AbortController(); let n = 0;
      await h.request(undefined, { signal: controller.signal, onPayload: async (p: any) => {
        if (++n === 2) { if (cancel) controller.abort(); else h.interrupt(); }
        return p;
      } });
      expect(h.sent).toHaveLength(1); expect(h.record()).toBeUndefined();
    }
  });

  it('does not retry when a later hook changes authentication even if the body is identical', async () => {
    const h = fixture(); h.fresh(); let n = 0;
    const headers = { authorization: 'fixture-a' };
    await h.request(undefined, { headers, onPayload: (payload: any) => {
      if (++n === 2) headers.authorization = 'fixture-b';
      return payload;
    } });
    expect(h.sent).toHaveLength(1);
    expect(h.record()).toBeUndefined();
  });

  it('does not learn from a stream failure or let a storage error undo a good response', async () => {
    const h = fixture(); h.fresh(); await h.request([failure(), [{ type: 'start' }, failure('stream error')]]);
    expect(h.record()).toBeUndefined();
    const good = fixture(); good.failWrites(); good.fresh();
    expect(await good.request()).toEqual([success]); expect(good.record()).toBeUndefined();
    good.fresh(); await good.request([success]);
    expect(good.sent[2]).not.toHaveProperty('prompt_cache_key');
  });

  it('gives explicit rejection a finite seven-day record and isolates protocols', async () => {
    const h = fixture(); h.fresh();
    await h.request([failure('400: {"code":"UNKNOWN_FIELD","data":{"field":"prompt_cache_key"}}'), success]);
    expect(h.record()).toMatchObject({ evidence: 'explicit', expiresAt: 1604800000 });
    expect(h.api.accepts({ ...model, api: 'openai-responses' })).toBe(false);
    expect(h.api.accepts({ ...model, baseUrl: model.baseUrl + '/changed' })).toBe(false);
  });

  it('preserves malformed files and bounds the lifetime of legacy records', async () => {
    const h = fixture(); h.files.set('/compat.json', '{bad'); h.fresh(); await h.request();
    expect(h.files.get('/compat.json')).toBe('{bad');
    const legacy = fixture(); legacy.files.set('/compat.json', JSON.stringify({ routes: { [key]: { supportsLongCacheRetention: false } } }));
    legacy.clock(1001); legacy.fresh(); await legacy.request([success]);
    expect(legacy.sent[0]).not.toHaveProperty('prompt_cache_key');
    legacy.clock(1000 + 7 * 86400000 + 1); legacy.fresh(); await legacy.request([success]);
    expect(legacy.sent[1]).toHaveProperty('prompt_cache_key');
  });

  it('ignores malformed route entries and invalid expiry instead of disabling cache forever', async () => {
    const h = fixture();
    const rules = JSON.parse(h.files.get('/agent/pi-cache-compatibility.json')!);
    h.files.set('/agent/pi-cache-compatibility.json', JSON.stringify([null, false, ...rules]));
    h.files.set('/compat.json', JSON.stringify({ routes: { [key]: { supportsLongCacheRetention: false, learnedAt: 1, evidence: 'opaque' } } }));
    h.fresh(); await h.request([success]);
    expect(h.sent[0]).toHaveProperty('prompt_cache_key');
  });
});
