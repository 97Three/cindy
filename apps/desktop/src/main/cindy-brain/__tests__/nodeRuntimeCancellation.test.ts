import { nodeSettingsAuthorization } from '../runtime/nodeSettingsAuthorization';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost';
import {
  GhostNodeRuntimeBroker,
  type NodeWorkerProcess,
  type GhostNodeRuntimeBrokerDeps,
} from '../nodeRuntimeBroker';

class Worker extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  pid = 42;
  requests: Array<{ id: string; method: string; cindy?: unknown }> = [];
  controls: Array<Record<string, unknown>> = [];
  listener?: (value: unknown) => void;
  constructor(autoSpawn = true) {
    super();
    this.stdin.on('data', (chunk) => this.requests.push(JSON.parse(String(chunk))));
    if (autoSpawn) queueMicrotask(() => this.emit('spawn'));
  }
  onControl(listener: (value: unknown) => void) {
    this.listener = listener;
  }
  sendControl(value: unknown) {
    this.controls.push(value as Record<string, unknown>);
    return true;
  }
  kill(signal = 'SIGTERM') {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

const brokers: GhostNodeRuntimeBroker[] = [];
afterEach(() => {
  for (const b of brokers.splice(0)) b.destroyAll();
});

function harness(
  autoSpawn = true,
  extra: Partial<GhostNodeRuntimeBrokerDeps> = {},
  identity?: { ghost?: InstalledGhost; requestId?: string },
) {
  const worker = new Worker();
  const children: Worker[] = [];
  const calls = new Map([
    ['call-a', new AbortController()],
    ['call-b', new AbortController()],
  ]);
  const ghost = identity?.ghost ?? {
    manifest: {
      id: 'test-plugin',
      name: 'Test',
      version: '1.0.0',
      network: { hosts: ['provider.example'] },
      node: {
        entry: 'worker.cjs',
        entries: ['child.cjs'],
        protocol: 'json-rpc-stdio',
        childSpawn: true,
      },
    },
    dir: path.resolve('test-plugin'),
    enabled: true,
  } as InstalledGhost;
  const requestId = identity?.requestId ?? ghost.manifest.id;
  const broker = new GhostNodeRuntimeBroker({
    ...extra,
    getGhost: extra.getGhost ?? (() => ghost),
    getCallSignal: extra.getCallSignal ?? ((id, callId) =>
      id === requestId ? (calls.get(callId)?.signal ?? null) : null),
    spawnProcess: () => {
      queueMicrotask(() => worker.emit('spawn'));
      return worker as NodeWorkerProcess;
    },
    spawnChildProcess: () => {
      const child = new Worker(autoSpawn);
      children.push(child);
      return child as NodeWorkerProcess;
    },
  });
  brokers.push(broker);
  const request = (callId?: string) =>
    broker.handleRequest(requestId, {
      type: 'node-request',
      method: 'tools/call',
      params: { name: 'login' },
      ...(callId ? { callId, cancelWithCall: true } : {}),
    });
  const spawn = (rpcId: string | undefined, reqId: string) =>
    worker.listener?.({
      type: 'spawn-child',
      reqId,
      entry: 'child.cjs',
      args: [],
      ...(rpcId ? { rpcId } : {}),
    });
  return { worker, children, calls, broker, request, spawn, ghost };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error('Expected lifecycle transition did not occur');
}

describe('Node cancellation boundaries', () => {
  it('stops a child cancelled before its ready handshake', async () => {
    const h = harness(false);
    const result = h.request('call-a');
    await until(() => h.worker.requests.length === 1);
    h.spawn(h.worker.requests[0].id, 'starting');
    await until(() => h.children.length === 1);
    h.calls.get('call-a')!.abort();
    expect(await result).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    await until(() => h.worker.controls.some((x) => x.reqId === 'starting'));
    expect(h.children[0].killed).toBe(true);
    expect(h.worker.controls.find((x) => x.reqId === 'starting')).toMatchObject({ ok: false });
    expect(h.worker.killed).toBe(false);
  });

  it('kills the cancelled request child and preserves another request in the same worker', async () => {
    const h = harness();
    const first = h.request('call-a');
    const second = h.request('call-b');
    await until(() => h.worker.requests.length === 2);
    const [a, b] = h.worker.requests;
    expect(a.cindy).toEqual({ cancelWithCall: true });
    h.spawn(a.id, 'spawn-a');
    h.spawn(b.id, 'spawn-b');
    await until(
      () => h.worker.controls.filter((x) => x.type === 'spawn-child-result').length === 2,
    );
    h.calls.get('call-a')!.abort();
    expect(await first).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    expect(h.children[0].killed).toBe(true);
    expect(h.children[1].killed).toBe(false);
    expect(h.worker.killed).toBe(false);
    h.spawn(a.id, 'late-spawn');
    await until(() => h.worker.controls.some((x) => x.reqId === 'late-spawn'));
    expect(h.children.length).toBe(2);
    expect(h.worker.controls.find((x) => x.reqId === 'late-spawn')).toMatchObject({ ok: false });
    h.worker.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { kept: true } }) + '\n',
    );
    expect(await second).toEqual({ ok: true, result: { kept: true } });
    expect(h.children[1].killed).toBe(true);
  });

  it('rejects stale bindings before starting a worker', async () => {
    const h = harness();
    expect(await h.request('missing')).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    h.calls.get('call-a')!.abort();
    expect(await h.request('call-a')).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    expect(h.worker.requests).toEqual([]);
  });

  it.each([undefined, false])('keeps legacy callId metadata nonbinding (opt-in: %s)', async cancelWithCall => {
    const h = harness();
    const result = h.broker.handleRequest('test-plugin', {
      type: 'node-request', method: 'background/start', callId: 'obsolete-call', cancelWithCall,
    });
    await until(() => h.worker.requests.length === 1);
    expect(h.worker.requests[0].cindy).toBeUndefined();
    h.spawn(undefined, 'background');
    await until(() => h.children.length === 1);
    h.worker.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: h.worker.requests[0].id, result: true }) + '\n');
    expect(await result).toEqual({ ok: true, result: true });
    expect(h.children[0].killed).toBe(false);
  });

  it('does not stop legacy autonomous children when an unbound RPC returns', async () => {
    const h = harness();
    const result = h.request();
    await until(() => h.worker.requests.length === 1);
    h.spawn(undefined, 'background');
    await until(() => h.worker.controls.some((x) => x.reqId === 'background'));
    const id = h.worker.requests[0].id;
    expect(h.worker.requests[0].cindy).toBeUndefined();
    h.worker.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: true }) + '\n');
    expect(await result).toEqual({ ok: true, result: true });
    expect(h.children[0].killed).toBe(false);
  });
});

describe('Node private authorization bridge', () => {
  it('cannot promote legacy callId metadata into an authorization capability', async () => {
    const open = vi.fn(), session = vi.fn(() => 'trusted-session');
    const h = harness(true, { getCallSessionId: session, openAuthorization: open });
    const result = h.broker.handleRequest('test-plugin', {
      type: 'node-request', method: 'legacy', callId: 'call-a',
    });
    await until(() => h.worker.requests.length === 1);
    const id = h.worker.requests[0].id;
    h.worker.listener?.({
      type: 'plugin-authorize', reqId: 'forged-opt-in', rpcId: id,
      request: { kind: 'browser', url: 'https://provider.example/activate' },
    });
    expect(h.worker.controls.find(x => x.reqId === 'forged-opt-in')).toMatchObject({ ok: false });
    expect(session).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    h.worker.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: 'original-completion' }) + '\n');
    expect(await result).toEqual({ ok: true, result: 'original-completion' });
  });

  it('routes generic device codes privately and keeps setup completion tied to the Node result', async () => {
    const finish = vi.fn(),
      dispose = vi.fn();
    const open = vi.fn(
      (input: Parameters<NonNullable<GhostNodeRuntimeBrokerDeps['openAuthorization']>>[0]) => {
        expect(input.sessionId).toBe('trusted-session');
        expect(input.request).toEqual({
          kind: 'device',
          url: 'https://provider.example/activate',
          userCode: '123456789',
        });
        return {
          opened: Promise.resolve(),
          result: Promise.resolve({ kind: 'opened' as const }),
          finish,
          dispose,
        };
      },
    );
    const h = harness(true, { getCallSessionId: () => 'trusted-session', openAuthorization: open });
    const result = h.request('call-a');
    await until(() => h.worker.requests.length === 1);
    const id = h.worker.requests[0].id;
    h.worker.listener?.({
      type: 'plugin-authorize',
      reqId: 'generic',
      rpcId: id,
      request: { kind: 'device', url: 'https://provider.example/activate', userCode: '123456789' },
    });
    await until(() => h.worker.controls.some((x) => x.reqId === 'generic'));
    expect(h.worker.controls.find((x) => x.reqId === 'generic')).toEqual({
      type: 'plugin-authorize-result',
      reqId: 'generic',
      ok: true,
      result: { kind: 'opened' },
    });
    expect(finish).not.toHaveBeenCalled();
    h.worker.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }) + '\n');
    expect(await result).toEqual({ ok: true, result: { ok: true } });
    expect(finish).toHaveBeenCalledWith(true);
    expect(JSON.stringify(h.worker.requests)).not.toContain('123456789');
  });

  it('does not revive a cancelled generic request when its private callback arrives late', async () => {
    let receive!: (value: { kind: 'opened' }) => void;
    const waiting = new Promise<{ kind: 'opened' }>((r) => {
      receive = r;
    });
    const finish = vi.fn(),
      dispose = vi.fn();
    const h = harness(true, {
      getCallSessionId: () => 'trusted-session',
      openAuthorization: () => ({ opened: Promise.resolve(), result: waiting, finish, dispose }),
    });
    const result = h.request('call-a');
    await until(() => h.worker.requests.length === 1);
    const id = h.worker.requests[0].id;
    h.worker.listener?.({
      type: 'plugin-authorize',
      reqId: 'generic',
      rpcId: id,
      request: { kind: 'browser', url: 'https://provider.example/qr' },
    });
    h.calls.get('call-a')!.abort();
    expect(await result).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    receive({ kind: 'opened' });
    await until(() => h.worker.controls.some((x) => x.reqId === 'generic'));
    expect(h.worker.controls.find((x) => x.reqId === 'generic')).toMatchObject({ ok: false });
    expect(dispose).toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('applies the same declared target check to generic browser requests', async () => {
    const open = vi.fn();
    const h = harness(true, { getCallSessionId: () => 'trusted-session', openAuthorization: open });
    const result = h.request('call-a');
    await until(() => h.worker.requests.length === 1);
    h.worker.listener?.({
      type: 'plugin-authorize',
      reqId: 'generic',
      rpcId: h.worker.requests[0].id,
      request: { kind: 'browser', url: 'https://untrusted.example/qr' },
    });
    expect(open).not.toHaveBeenCalled();
    expect(await result).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
  });

  it('rejects an undeclared browser target and cancels the bound request', async () => {
    const open = vi.fn();
    const h = harness(true, {
      getCallSessionId: () => 'trusted-session',
      openDeviceAuthorization: open,
    });
    const result = h.request('call-a');
    await until(() => h.worker.requests.length === 1);
    h.worker.listener?.({
      type: 'device-authorize',
      reqId: 'untrusted-target',
      rpcId: h.worker.requests[0].id,
      url: 'https://untrusted.example/device',
    });
    expect(h.worker.controls.find((x) => x.reqId === 'untrusted-target')).toMatchObject({
      ok: false,
    });
    expect(open).not.toHaveBeenCalled();
    expect(await result).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
  });

  it('binds to Main task identity, rejects unbound/duplicate control frames, and cancels only its child after opened', async () => {
    let input!: Parameters<NonNullable<GhostNodeRuntimeBrokerDeps['openDeviceAuthorization']>>[0];
    const dispose = vi.fn();
    const finish = vi.fn();
    const open = vi.fn((value: typeof input) => {
      input = value;
      return { opened: Promise.resolve(), finish, dispose };
    });
    const h = harness(true, {
      getCallSessionId: (g, id) =>
        g === 'test-plugin' && id === 'call-a' ? 'trusted-session' : null,
      openDeviceAuthorization: open,
    });
    const first = h.request('call-a');
    const second = h.request('call-b');
    await until(() => h.worker.requests.length === 2);
    const [a, b] = h.worker.requests;
    h.spawn(a.id, 'spawn-a');
    h.spawn(b.id, 'spawn-b');
    await until(
      () => h.worker.controls.filter((x) => x.type === 'spawn-child-result').length === 2,
    );
    const frame = {
      type: 'device-authorize',
      reqId: 'authorize-a',
      rpcId: a.id,
      url: 'https://provider.example/device?code=synthetic',
    };
    h.worker.listener?.({ ...frame, reqId: 'forged', rpcId: b.id });
    expect(open).not.toHaveBeenCalled();
    h.worker.listener?.(frame);
    await until(() => h.worker.controls.some((x) => x.reqId === 'authorize-a'));
    expect(h.worker.controls.find((x) => x.reqId === 'authorize-a')).toMatchObject({ ok: true });
    expect(input.sessionId).toBe('trusted-session');
    expect(input.ghost.id).toBe('test-plugin');
    input.assertCurrent();
    h.worker.listener?.({ ...frame, reqId: 'duplicate' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(h.worker.controls.find((x) => x.reqId === 'duplicate')).toMatchObject({ ok: false });
    input.cancel();
    expect(await first).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    expect(dispose).toHaveBeenCalled();
    expect(() => input.assertCurrent()).toThrow();
    expect(h.children[0].killed).toBe(true);
    expect(h.children[1].killed).toBe(false);
    h.worker.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: a.id, result: { ok: true } }) + '\n',
    );
    expect(finish).not.toHaveBeenCalled();
    h.worker.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { ok: true } }) + '\n',
    );
    await second;
  });

  it('looks up remote authorization by physical instance id, not manifest ghostId', async () => {
    const storagePart = '_ns__acme__test-plugin';
    const orgGhost = {
      manifest: {
        id: 'test-plugin',
        name: 'Test',
        version: '1.0.0',
        network: { hosts: ['provider.example'] },
        node: {
          entry: 'worker.cjs',
          entries: ['child.cjs'],
          protocol: 'json-rpc-stdio',
          childSpawn: true,
        },
      },
      namespace: 'acme',
      dir: '/fake/_ns/acme/test-plugin',
      enabled: true,
    } as InstalledGhost;
    let input!: Parameters<NonNullable<GhostNodeRuntimeBrokerDeps['openDeviceAuthorization']>>[0];
    const open = vi.fn((value: typeof input) => {
      input = value;
      return { opened: Promise.resolve(), finish: vi.fn(), dispose: vi.fn() };
    });
    const h = harness(
      true,
      {
        getGhost: (id) => (id === storagePart ? orgGhost : null),
        getCallSessionId: (g, id) =>
          g === storagePart && id === 'call-a' ? 'trusted-session' : null,
        openDeviceAuthorization: open,
      },
      { ghost: orgGhost, requestId: storagePart },
    );
    const result = h.request('call-a');
    await until(() => h.worker.requests.length === 1);
    h.worker.listener?.({
      type: 'device-authorize',
      reqId: 'authorize-ns',
      rpcId: h.worker.requests[0].id,
      url: 'https://provider.example/device',
    });
    await until(() => h.worker.controls.some((x) => x.reqId === 'authorize-ns'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(h.worker.controls.find((x) => x.reqId === 'authorize-ns')).toMatchObject({ ok: true });
    expect(input.ghost.id).toBe(storagePart);
    expect(input.sessionId).toBe('trusted-session');
    input.assertCurrent();
    h.worker.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: h.worker.requests[0].id, result: { ok: true } }) + '\n',
    );
    expect(await result).toEqual({ ok: true, result: { ok: true } });
  });

  it.each([true, false])(
    'finishes the authorization before invalidating its binding (CLI ok=%s)',
    async (ok) => {
      let assertCurrent!: () => void;
      const finish = vi.fn((value: boolean) => {
        assertCurrent();
        expect(value).toBe(ok);
      });
      const h = harness(true, {
        getCallSessionId: () => 'trusted-session',
        openDeviceAuthorization: (input) => {
          assertCurrent = input.assertCurrent;
          return { opened: Promise.resolve(), finish, dispose: () => {} };
        },
      });
      const result = h.request('call-a');
      await until(() => h.worker.requests.length === 1);
      const id = h.worker.requests[0].id;
      h.worker.listener?.({
        type: 'device-authorize',
        reqId: 'a',
        rpcId: id,
        url: 'https://provider.example/device',
      });
      await until(() => h.worker.controls.some((x) => x.reqId === 'a'));
      h.worker.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { structuredContent: { ok }, isError: !ok },
        }) + '\n',
      );
      await result;
      expect(finish).toHaveBeenCalledWith(ok);
      expect(() => assertCurrent()).toThrow();
    },
  );
});

// Protects the new private Host boundary (unit/DI): only a live, authorized method
// may persist a credential. Prior cancellation coverage had no credential writes.
describe('Node credential capture', () => {
  it('saves only after authorization, survives a new RPC, and never returns the secret', async () => {
    let stored: string | null = null;
    const write = vi.fn((_id: string, _key: string, value: string) => { stored = value; return true; });
    const h = harness(true, { saveSecret: write, readSecret: () => stored,
      getCallSessionId: () => 'session-a',
      openAuthorization: () => ({ result: Promise.resolve({ kind: 'opened' }), opened: Promise.resolve(),
        finish() {}, dispose() {} }),
    });
    const ghost = h.ghost;
    ghost.nodeCredentialCapabilityApproved = true;
    ghost.manifest.node!.secretBindings = [{ key: 'account', label: 'Account', methods: ['tools/call'], saveMethods: ['tools/call'] }];
    const request = h.request('call-a');
    await vi.waitFor(() => expect(h.worker.requests.length).toBe(1));
    const rpcId = h.worker.requests[0]!.id;
    const save = { type: 'credential-save', reqId: 'save1', rpcId, key: 'account', identity: 'app-test', value: 'synthetic-not-a-secret' };
    h.worker.listener?.(save);
    await vi.waitFor(() => expect(h.worker.controls).toContainEqual({ type: 'node-host-result', reqId: 'save1', ok: false }));
    expect(write).not.toHaveBeenCalled();
    h.worker.listener?.({ type: 'plugin-authorize', reqId: 'auth1', rpcId,
      request: { kind: 'device', url: 'https://provider.example/activate' } });
    await vi.waitFor(() => expect(h.worker.controls.some(x => x.type === 'plugin-authorize-result' && x.ok)).toBe(true));
    h.worker.listener?.({ ...save, reqId: 'save2' });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(JSON.parse(stored!)).toMatchObject({ nodeCredentialVersion: 1, identity: 'app-test', value: 'synthetic-not-a-secret' });
    expect(JSON.stringify(h.worker.controls)).not.toContain('synthetic-not-a-secret');
    h.worker.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: { identity: 'app-test', leaked: 'synthetic-not-a-secret' } }) + '\n');
    const result = await request;
    expect(JSON.stringify(result)).not.toContain('synthetic-not-a-secret');
    const next = h.request('call-b');
    await vi.waitFor(() => expect(h.worker.requests.length).toBe(2));
    expect(JSON.stringify(h.worker.requests[1]!.cindy)).toContain('synthetic-not-a-secret');
    h.calls.get('call-b')!.abort(); await next;
    h.worker.listener?.({ ...save, reqId: 'late' });
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('rejects wrong methods, entries, cancellation and unavailable storage without writes', async () => {
    const write = vi.fn(() => true);
    const h = harness(true, { saveSecret: write, getCallSessionId: () => 's' });
    const request = h.request('call-a');
    await vi.waitFor(() => expect(h.worker.requests.length).toBe(1));
    const rpcId = h.worker.requests[0]!.id;
    for (const key of ['undeclared', 'other']) h.worker.listener?.({ type: 'credential-save', reqId: key, rpcId, key,
      identity: 'app-test', value: 'synthetic' });
    h.calls.get('call-a')!.abort(); await request;
    expect(write).not.toHaveBeenCalled();
  });
});

// Standard unit: a live authorization card is insufficient once its owner,
// installation, or vault fails. These are new write-boundary outcomes.
describe('private Host service revocation', () => {
  it.each(['owner', 'manifest', 'disabled', 'storage', 'approval'] as const)('does not report saved after %s changes', async mode => {
    let current = true;
    const write = vi.fn(() => mode !== 'storage');
    const h = harness(true, { saveSecret: write, readSecret: () => null,
      ownerScope: { capture: () => 'owner', isCurrent: () => current, isStable: () => current },
      getCallSessionId: () => 'session',
      openAuthorization: () => ({ result: Promise.resolve({ kind: 'opened' }), opened: Promise.resolve(), finish() {}, dispose() {} }),
    });
    h.ghost.nodeCredentialCapabilityApproved = true;
    h.ghost.manifest.node!.secretBindings = [{key:'account',label:'Account',methods:['tools/call'],saveMethods:['tools/call']}];
    const request=h.request('call-a'); await until(()=>h.worker.requests.length===1);
    const rpcId=h.worker.requests[0].id;
    h.worker.listener?.({type:'plugin-authorize',reqId:'auth',rpcId,request:{kind:'device',url:'https://provider.example/auth'}});
    await until(()=>h.worker.controls.some(x=>x.reqId==='auth'&&x.ok));
    if(mode==='owner')current=false;
    if(mode==='manifest')h.ghost.manifest.version='2.0.0';
    if(mode==='disabled')h.ghost.enabled=false;
    if(mode==='approval')delete h.ghost.nodeCredentialCapabilityApproved;
    h.worker.listener?.({type:'credential-save',reqId:'save',rpcId,key:'account',identity:'app',value:'synthetic-value'});
    await new Promise(r=>setImmediate(r));
    expect(write).toHaveBeenCalledTimes(mode==='storage'?1:0);
    expect(h.worker.controls.some(x=>x.reqId==='save'&&x.ok)).toBe(false);
    h.calls.get('call-a')!.abort(); await request;
  });
  it('binds upload to the real call and aborts it when the tool ends', async () => {
    let observedSignal!:AbortSignal;
    let release!:(value:unknown)=>void;
    const send=vi.fn<NonNullable<GhostNodeRuntimeBrokerDeps['authenticatedFetch']>>((_id, request, _auth, guard, signal)=>{guard();observedSignal=signal;expect(request.callId).toBe('call-a');return new Promise(resolve=>{release=resolve;});});
    const h=harness(true,{authenticatedFetch:send});const request=h.request('call-a');await until(()=>h.worker.requests.length===1);
    const rpcId=h.worker.requests[0].id;
    h.worker.listener?.({type:'authenticated-fetch',reqId:'upload',rpcId,authorization:'Bearer synthetic',request:{url:'https://provider.example/u',callId:'forged'}});
    await until(()=>send.mock.calls.length===1);
    h.calls.get('call-a')!.abort();await request;expect(observedSignal.aborted).toBe(true);release({ok:true});
    await new Promise(r=>setImmediate(r));expect(h.worker.controls.some(x=>x.reqId==='upload'&&x.ok)).toBe(false);
  });
});

// Settings onboarding previously needed a fabricated chat task. Exercise the real
// endpoint and broker together, including cancellation and the secret write boundary.
describe('settings device authorization', () => {
  function pageHarness() {
    const write = vi.fn(() => true);
    const card = vi.fn();
    const h = harness(true, { saveSecret: write, readSecret: () => null, openAuthorization: card });
    h.ghost.nodeCredentialCapabilityApproved = true;
    h.ghost.manifest.node!.secretBindings = [{key:'account',label:'Account',methods:['authorize'],saveMethods:['authorize'],settingsMethod:'authorize'}];
    const control = new AbortController();
    let current = true;
    const response = () => nodeSettingsAuthorization({ghost:()=>h.ghost,broker:()=>h.broker}, 'test-plugin',
      new Request('https://plugin.invalid/node-authorization/account', {method:'POST',body:'{}',signal:control.signal}),()=>current);
    const authorize = (id:string, url='https://provider.example/activate') => h.worker.listener?.({type:'plugin-authorize',reqId:'auth',rpcId:id,request:{kind:'device',url}});
    const save = (id:string,key='account') => h.worker.listener?.({type:'credential-save',reqId:'save',rpcId:id,key,identity:'app-test',value:'synthetic-page-secret'});
    return {...h,write,card,control,response,authorize,save,revoke:()=>{current=false;}};
  }
  it('rejects historical capture declarations without a Host approval record', async () => {
    const h = pageHarness();
    delete h.ghost.nodeCredentialCapabilityApproved;
    expect((await h.response()).status).toBe(403);
    expect(h.worker.requests).toEqual([]);
    expect(h.write).not.toHaveBeenCalled();
  });
  it('streams the QR link then a safe receipt without a Session or chat card',async()=>{
    const h=pageHarness();const response=await h.response();const reader=response.body!.getReader();
    await until(()=>h.worker.requests.length===1);const id=h.worker.requests[0].id;
    h.save(id);expect(h.write).not.toHaveBeenCalled();
    h.authorize(id);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('https://provider.example/activate');
    h.save(id);await until(()=>h.write.mock.calls.length===1);
    h.worker.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result:{ok:true,untrusted:'not-for-page'}})+'\n');
    const done=new TextDecoder().decode((await reader.read()).value);
    expect(done).toContain('"state":"saved"');expect(done).toContain('app-test');
    expect(done).not.toContain('synthetic-page-secret');expect(done).not.toContain('not-for-page');
    expect((await reader.read()).done).toBe(true);expect(h.card).not.toHaveBeenCalled();
  });
  it.each(['cancel','page','manifest','wrong-key'] as const)('rejects saving after %s',async mode=>{
    const h=pageHarness();const response=await h.response();const reader=response.body!.getReader();
    await until(()=>h.worker.requests.length===1);const id=h.worker.requests[0].id;h.authorize(id);await reader.read();
    if(mode==='cancel')h.control.abort();
    if(mode==='page')h.revoke();
    if(mode==='manifest')h.ghost.manifest.version='changed';
    h.save(id,mode==='wrong-key'?'other':'account');await new Promise(r=>setImmediate(r));
    expect(h.write).not.toHaveBeenCalled();await reader.cancel();
  });
  it('rejects an undeclared target and undeclared settings capability',async()=>{
    const h=pageHarness();const response=await h.response();const text=response.text();
    await until(()=>h.worker.requests.length===1);h.authorize(h.worker.requests[0].id,'https://outside.example/auth');
    expect(await text).not.toContain('outside.example');expect(h.write).not.toHaveBeenCalled();
    delete h.ghost.manifest.node!.secretBindings![0].settingsMethod;
    expect((await h.response()).status).toBe(403);
  });
  it('does not accept a settings authority through the ordinary pipe payload',async()=>{
    const h=pageHarness();
    const call=h.broker.handleRequest('test-plugin',{type:'node-request',method:'authorize',pageAuthorization:{key:'account'}});
    await until(()=>h.worker.requests.length===1);const id=h.worker.requests[0].id;h.authorize(id);h.save(id);
    expect(h.write).not.toHaveBeenCalled();
    h.worker.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result:{ok:true}})+'\n');await call;
  });
});
