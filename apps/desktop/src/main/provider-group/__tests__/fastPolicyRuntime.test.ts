import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderGroupConfig } from '../../../shared/providerGroup.js';
import { hostSessionIdFor } from '../../remote-agent/host/sessionIdentity.js';

const state = vi.hoisted(() => ({
  owner: 'test',
  config: null as ProviderGroupConfig | null,
  subscription: true,
  old: new Set<string>(),
  offline: new Set<string>(),
  broken: new Set<string>(),
  beforeCaps: undefined as undefined | (() => Promise<void>),
  calls: [] as Array<{ device: string; command: Record<string, any> }>,
  notify: vi.fn(async () => {}),
}));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-fast-sync-'));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.owner,
  ownerScopedUserDataPath: (file: string) => path.join(temporary, state.owner, file),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: () => ({
    providers: [
      { id: 'openai', auth: { method: state.subscription ? 'oauth' : 'apiKey', native: 'codex' } },
    ],
  }),
}));
vi.mock('../../maker-host/subscription-fast-policy.js', () => ({
  notifySubscriptionFastPolicyChanged: () => state.notify(),
}));
vi.mock('../store.js', () => ({
  readProviderGroup: () => state.config,
  listProviderGroups: () => (state.config ? { openai: state.config } : {}),
}));
vi.mock('../../device-link/index.js', () => ({
  getSelfDeviceId: () => 'self',
  remoteBackgroundInvoke: async (
    device: string,
    _channel: string,
    args: Array<Record<string, any>>,
  ) => {
    const command = args[0];
    state.calls.push({ device, command });
    if (command.op === 'caps') await state.beforeCaps?.();
    if (state.broken.has(device)) throw Error('[LINK_NOT_OPEN] disconnected');
    if (state.offline.has(device))
      return { ok: false, error: { code: 'IPC_ERROR', message: 'offline' } };
    if (command.op === 'caps')
      return {
        ok: true,
        result: {
          version: 1,
          maxRuns: 10,
          uploadChunkBytes: 1024,
          maxPayloadBytes: 8192,
          ...(!state.old.has(device) ? { subscriptionFastPolicy: true } : {}),
        },
      };
    return { ok: true, result: { revision: command.revision, allowFast: command.allowFast } };
  },
}));
const runtime = await import('../fastPolicyRuntime.js');
const { groupFastPolicyStore } = await import('../fastPolicyStore.js');
let sequence = 0;
beforeEach(() => {
  state.owner = `owner-${++sequence}`;
  state.subscription = true;
  state.calls = [];
  state.old.clear();
  state.offline.clear();
  state.broken.clear();
  state.beforeCaps = undefined;
  state.notify.mockReset().mockResolvedValue(undefined);
  state.config = {
    strategy: 'least',
    autoSwitch: true,
    allowFast: false,
    members: ['one', 'two'].map((device) => ({
      key: `device:${device}:openai`,
      kind: 'device',
      agentDeviceId: device,
      providerId: 'openai',
      limit: 10,
      weight: 1,
      paused: false,
    })),
  };
});
afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

function blockCapabilitiesRequest() {
  let enter!: () => void;
  let unblock!: () => void;
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  state.beforeCaps = () => {
    enter();
    return blocked;
  };
  return {
    started,
    release() {
      state.beforeCaps = undefined;
      unblock();
    },
  };
}

describe('group owner to executor enforcement handshake', () => {
  // #7848, unit: use the real sync/store and a failed peer, advancing virtual
  // polling time. Existing tests cover in-flight coalescing, not later retries
  // or the policy file's unchanged mtime after each unsuccessful poll.
  it('backs off failed peers up to five minutes without rewriting unchanged policy on polls', async () => {
    // Only virtualize the retry clock: filesystem lock mtimes use real Date.
    vi.useFakeTimers({ toFake: ['performance', 'setInterval', 'clearInterval'] });
    state.offline.add('one');
    await runtime.syncGroupFastPolicy('openai');
    const file = path.join(temporary, state.owner, 'provider-group-fast-policy.json');
    const timestamp = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, timestamp, timestamp);
    const stop = runtime.startGroupFastPolicySync();
    const attempts = (device: string) =>
      state.calls.filter((call) => call.device === device && call.command.op === 'caps').length;
    let count = 1;
    try {
      for (const delay of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]) {
        // Drain each poll's real filesystem work before advancing to the next.
        for (let elapsed = 5_000; elapsed < delay; elapsed += 5_000) {
          await vi.advanceTimersByTimeAsync(5_000);
          await runtime.syncGroupFastPolicy('openai');
          expect(attempts('one')).toBe(count);
        }
        await vi.advanceTimersByTimeAsync(5_000);
        await runtime.syncGroupFastPolicy('openai');
        expect(attempts('one')).toBe(++count);
        expect(attempts('two')).toBe(1);
        expect(fs.statSync(file).mtimeMs).toBe(timestamp.getTime());
        expect(runtime.groupFastPolicyPending('openai')).toBe(true);
      }
      state.offline.clear();
      await vi.advanceTimersByTimeAsync(300_000);
      await runtime.syncGroupFastPolicy('openai');
      expect(runtime.groupFastPolicyPending('openai')).toBe(false);
      expect(attempts('one')).toBe(count + 1);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(attempts('one')).toBe(count + 1);
    } finally {
      stop();
      await runtime.syncGroupFastPolicy('openai');
    }
  });

  it('sends new revisions and removed-member releases immediately despite previous failures', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    state.offline.add('one');
    await runtime.syncGroupFastPolicy('openai');
    const revision = groupFastPolicyStore.outgoing().openai.revision;
    state.config!.allowFast = true;
    await runtime.syncGroupFastPolicy('openai');
    expect(state.calls.filter(({ device }) => device === 'one')).toHaveLength(2);
    expect(groupFastPolicyStore.outgoing().openai.revision).toBe(revision + 1);
    state.config!.members = state.config!.members.slice(1);
    await runtime.syncGroupFastPolicy('openai');
    expect(state.calls.filter(({ device }) => device === 'one')).toHaveLength(3);
    expect(groupFastPolicyStore.outgoing().openai.targets.one).toBe(-1);
    state.offline.clear();
    await runtime.syncGroupFastPolicy('openai');
    expect(state.calls.filter(({ device }) => device === 'one')).toHaveLength(3);
    vi.advanceTimersByTime(5_000);
    await runtime.syncGroupFastPolicy('openai');
    expect(state.calls).toContainEqual({
      device: 'one',
      command: { op: 'fast-policy', group: 'openai', allowFast: true, revision: revision + 2 },
    });
    expect(groupFastPolicyStore.outgoing().openai.targets).not.toHaveProperty('one');
    expect(runtime.groupFastPolicyPending('openai')).toBe(false);
  });

  it('does not carry failed-peer cooldown into a different owner with the same group and revision', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    state.broken.add('one');
    await runtime.syncGroupFastPolicy('openai');
    await runtime.syncGroupFastPolicy('openai');
    expect(state.calls.filter(({ device }) => device === 'one')).toHaveLength(1);
    state.owner = `other-${state.owner}`;
    await runtime.syncGroupFastPolicy('openai');
    expect(state.calls.filter(({ device }) => device === 'one')).toHaveLength(2);
    expect(groupFastPolicyStore.outgoing().openai.targets.two).toBe(1);
  });

  it('coalesces repeated sync requests while the same offline revision is in flight', async () => {
    const caps = blockCapabilitiesRequest();
    // Only one remote endpoint makes the blocked request count unambiguous.
    state.config!.members = state.config!.members.slice(0, 1);
    state.offline.add('one');
    const pending = [runtime.syncGroupFastPolicy('openai')];
    try {
      // The request starts after durable writes and lock release; wait for that
      // event under the test deadline, without a shorter wall-clock poll.
      await Promise.race([caps.started, pending[0]]);
      expect(state.calls).toHaveLength(1);
      pending.push(...Array.from({ length: 5 }, () => runtime.syncGroupFastPolicy('openai')));
      caps.release();
      await Promise.all(pending);
      expect(state.calls).toHaveLength(1);
      expect(runtime.groupFastPolicyPending('openai')).toBe(true);
    } finally {
      caps.release();
      await Promise.all(pending);
    }
  });

  it('reports a changed setting as pending before it has been sent to executors', async () => {
    await runtime.syncGroupFastPolicy('openai');
    expect(runtime.groupFastPolicyPending('openai')).toBe(false);
    state.config!.allowFast = true;
    expect(runtime.groupFastPolicyPending('openai')).toBe(true);
  });

  it('still applies a newer setting requested while an earlier revision is in flight', async () => {
    const caps = blockCapabilitiesRequest();
    state.config!.members = state.config!.members.slice(0, 1);
    const pending = [runtime.syncGroupFastPolicy('openai')];
    try {
      await Promise.race([caps.started, pending[0]]);
      expect(state.calls).toHaveLength(1);
      state.config!.allowFast = true;
      pending.push(runtime.syncGroupFastPolicy('openai'));
      caps.release();
      await Promise.all(pending);
      expect(
        state.calls
          .filter(({ command }) => command.op === 'fast-policy')
          .map(({ command }) => command.allowFast),
      ).toEqual([false, true]);
      expect(runtime.groupFastPolicyPending('openai')).toBe(false);
    } finally {
      caps.release();
      await Promise.all(pending);
    }
  });

  it('intersects a relay source with the executor local group and releases it even without a local member', async () => {
    const relay = 'abcdefghijklmnop';
    const task = hostSessionIdFor(`upstream\0relay:${relay}`, 'task');
    await groupFastPolicyStore.receive(
      'upstream',
      {
        group: 'outer',
        revision: 1,
        allowFast: true,
        binding: { sessionId: 'task', relay },
      },
      'self',
      () => {},
    );
    await runtime.bindLocalHostedGroupFastPolicy('openai', task);
    expect(groupFastPolicyStore.allows(task)).toBe(false);
    state.config!.allowFast = true;
    await runtime.syncGroupFastPolicy('openai');
    expect(groupFastPolicyStore.allows(task)).toBe(true);
    await groupFastPolicyStore.receive(
      'upstream',
      { group: 'outer', revision: 2, allowFast: false },
      'self',
      () => {},
    );
    expect(groupFastPolicyStore.allows(task)).toBe(false);
  });

  it('keeps offline and old executors pending, retries after recovery, and releases removed members with a newer revision', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    state.old.add('one');
    state.offline.add('two');
    await runtime.syncGroupFastPolicy('openai');
    expect(runtime.groupFastPolicyPending('openai')).toBe(true);
    state.old.clear();
    state.offline.clear();
    vi.advanceTimersByTime(5_000);
    await runtime.syncGroupFastPolicy('openai');
    expect(runtime.groupFastPolicyPending('openai')).toBe(false);
    const revision = groupFastPolicyStore.outgoing().openai.revision;
    state.config!.members = state.config!.members.slice(1);
    state.calls = [];
    await runtime.syncGroupFastPolicy('openai');
    expect(state.calls).toContainEqual({
      device: 'one',
      command: expect.objectContaining({
        op: 'fast-policy',
        allowFast: true,
        revision: revision + 1,
      }),
    });
    expect(state.calls).toContainEqual({
      device: 'two',
      command: expect.objectContaining({
        op: 'fast-policy',
        allowFast: false,
        revision: revision + 1,
      }),
    });
    expect(runtime.groupFastPolicyPending('openai')).toBe(false);
  });

  it('does not grant a direct route before an old executor can enforce a prohibition', async () => {
    state.old.add('one');
    await expect(
      runtime.bindGroupFastPolicy({
        group: 'openai',
        deviceId: 'one',
        sessionId: 'task',
        controllerDeviceId: 'consumer',
      }),
    ).rejects.toThrow('REMOTE_AGENT_PEER_TOO_OLD');
    state.config!.allowFast = true;
    await expect(
      runtime.bindGroupFastPolicy({ group: 'openai', deviceId: 'one', sessionId: 'task' }),
    ).resolves.toBeUndefined();
  });

  it('reports an unreachable executor as unavailable, without marking it as an old version', async () => {
    state.offline.add('one');
    await expect(
      runtime.bindGroupFastPolicy({ group: 'openai', deviceId: 'one', sessionId: 'task' }),
    ).rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
  });

  it('normalizes thrown transport errors so automatic group selection can try another member', async () => {
    state.broken.add('one');
    await expect(
      runtime.bindGroupFastPolicy({ group: 'openai', deviceId: 'one', sessionId: 'task' }),
    ).rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
  });

  it('forgets an acknowledged release and does not contact that removed member on later toggles', async () => {
    await runtime.syncGroupFastPolicy('openai');
    state.config!.members = state.config!.members.slice(1);
    await runtime.syncGroupFastPolicy('openai');
    expect(groupFastPolicyStore.outgoing().openai.targets).not.toHaveProperty('one');
    state.offline.add('one');
    state.calls = [];
    state.config!.allowFast = true;
    await runtime.syncGroupFastPolicy('openai');
    expect(state.calls.some(({ device }) => device === 'one')).toBe(false);
    expect(runtime.groupFastPolicyPending('openai')).toBe(false);
  });

  it('shows local native failures as pending instead of acknowledging the whole group', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    state.config!.members.push({
      key: 'local',
      kind: 'local',
      agentDeviceId: null,
      providerId: 'openai',
      limit: 10,
      weight: 1,
      paused: false,
    });
    state.notify.mockRejectedValue(Error('native busy'));
    await expect(runtime.syncGroupFastPolicy('openai')).rejects.toThrow('native busy');
    expect(runtime.groupFastPolicyPending('openai')).toBe(true);
    state.notify.mockResolvedValue(undefined);
    vi.advanceTimersByTime(5_000);
    await runtime.syncGroupFastPolicy('openai');
    expect(runtime.groupFastPolicyPending('openai')).toBe(false);
  });

  it('does not touch custom API groups or their discovery/refresh paths', async () => {
    state.subscription = false;
    await runtime.syncGroupFastPolicy('openai');
    await runtime.bindGroupFastPolicy({ group: 'openai', deviceId: 'one', sessionId: 'task' });
    expect(state.calls).toEqual([]);
    expect(runtime.groupFastPolicyPending('openai')).toBe(false);
    expect(
      fs.existsSync(path.join(temporary, state.owner, 'provider-group-fast-policy.json')),
    ).toBe(false);
  });
});
