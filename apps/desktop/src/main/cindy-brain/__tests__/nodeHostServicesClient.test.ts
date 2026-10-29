import { expect, it, vi } from 'vitest';
import { NodeHostServicesClient } from '../nodeHostServicesClient.js';
import { NodeRequestScopes } from '../nodeRequestScope.js';

// Standard unit: private-channel binding and cancellation had no coverage.
// A stale async continuation must never write credentials after its RPC ends.
it('binds only within the exact live RPC and rejects pending work on completion', async () => {
  const scopes = new NodeRequestScopes();
  const sent: any[] = [];
  const client = new NodeHostServicesClient(scopes, (value) => sent.push(value));
  expect(client.bind()).toBeUndefined();
  let bound!: NonNullable<ReturnType<typeof client.bind>>;
  scopes.feed(JSON.stringify({ id: '1', cindy: { cancelWithCall: true } }), () => {
    bound = client.bind()!;
  });
  const saved = bound.saveCredential('account', 'synthetic-value', 'app-test');
  expect(sent[0]).toMatchObject({
    type: 'credential-save',
    rpcId: '1',
    key: 'account',
    identity: 'app-test',
  });
  client.reply({ reqId: sent[0].reqId, ok: true, result: { saved: true, identity: 'app-test' } });
  expect(await saved).toEqual({ saved: true, identity: 'app-test' });
  const pending = bound.authenticatedFetch({ url: 'https://example.test' }, 'Bearer synthetic');
  const rejected = expect(pending).rejects.toThrow('NODE_HOST_OPERATION_FAILED');
  scopes.finish('1');
  client.finish('1');
  expect(bound.signal.aborted).toBe(true);
  await rejected;
  expect(() => bound.saveCredential('account', 'x', 'app')).toThrow();
  expect(sent).toHaveLength(2);
});
it('releases bounded pending requests on timeout', async () => {
  vi.useFakeTimers();
  try {
    const scopes = new NodeRequestScopes();
    const sent: any[] = [];
    const client = new NodeHostServicesClient(scopes, (value) => sent.push(value));
    let bound!: NonNullable<ReturnType<typeof client.bind>>;
    scopes.feed(JSON.stringify({ id: '2', cindy: { cancelWithCall: true } }), () => {
      bound = client.bind()!;
    });
    const pending = Array.from({ length: 8 }, () =>
      bound.saveCredential('account', 'x', 'app').catch((e) => e.message),
    );
    await expect(bound.saveCredential('account', 'x', 'app')).rejects.toThrow('NODE_HOST_BUSY');
    await vi.advanceTimersByTimeAsync(120000);
    expect(await Promise.all(pending)).toEqual(Array(8).fill('NODE_HOST_OPERATION_FAILED'));
    const retry = bound.saveCredential('account', 'x', 'app');
    client.reply({ reqId: sent.at(-1).reqId, ok: true, result: { saved: true } });
    await expect(retry).resolves.toEqual({ saved: true });
  } finally {
    vi.useRealTimers();
  }
});
