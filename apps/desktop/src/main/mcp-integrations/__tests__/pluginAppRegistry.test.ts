import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { AppServerConfig } from '../../mcp-apps/connection.js';
import type { InstalledGhost } from '../../../shared/ghost.js';
const state = vi.hoisted(() => ({
  owner: 'A',
  configs: new Map<string, () => AppServerConfig>(),
  reads: 0,
}));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => state.owner }));
vi.mock('../../mcp-apps/runtime.js', () => ({
  replacePluginAppServers: (next: typeof state.configs) => {
    state.configs = next;
  },
}));
vi.mock('../../cindy-brain/ghostContentTree.js', () => ({
  resolveGhostContentPathSync: () => {
    state.reads++;
    throw new Error('no file may be read');
  },
}));
import { refreshPluginApps, pluginAppServerId } from '../plugin-app-registry.js';
// Production registration entry, no Node process or network. Existing App host tests
// do not own plugin receipts. Minimal failure: missing ui fact or old owner callback.
// Tier: unit; mocks only external account/storage boundaries, real SDK discovery.
afterEach(() => {
  state.owner = 'A';
  state.configs.clear();
  state.reads = 0;
});
function fixture() {
  let ghost: InstalledGhost = {
    manifest: {
      schemaVersion: 3,
      id: 'planner',
      name: 'Planner',
      kind: 'chip',
      entry: 'main.js',
      version: '1',
      tools: [{ name: 'open', description: 'Open' }],
      mcpApps: { ui: { resources: [{
            uri: "ui://form",
            file: 'form.html'
        }], tools: { open: { resourceUri: "ui://form" } } } },
    },
    enabled: true,
    dir: '/fixture',
    approval: { state: 'approved', revision: 'one' },
    uiCapabilityApproved: true,
  };
  let fingerprint = 'hash',
    available = true;
  const refresh = () =>
    refreshPluginApps([ghost], {
      find: () => ghost,
      evidence: () => ({ packageSha256: fingerprint }),
      available: () => available,
    });
  return {
    ghost,
    refresh,
    setGhost: (next: InstalledGhost) => {
      ghost = next;
    },
    setFingerprint: () => {
      fingerprint = 'changed';
    },
    unavailable: () => {
      available = false;
    },
  };
}
it.each(['unapproved', 'disabled', 'invalid'] as const)(
  'does not register or read HTML for %s page authority',
  (kind) => {
    const f = fixture();
    if (kind === 'unapproved') delete f.ghost.uiCapabilityApproved;
    if (kind === 'disabled') f.ghost.enabled = false;
    if (kind === 'invalid') f.ghost.manifest.mcpApps = { ui: { resources: null, tools: null } } as never;
    f.refresh();
    expect(state.configs.size).toBe(0);
    expect(state.reads).toBe(0);
  },
);
it('discovers tools with the real SDK without reading HTML during registration or initialization', async () => {
  const f = fixture();
  f.refresh();
  const config = state.configs.get(pluginAppServerId(f.ghost))!();
  const client = new Client({ name: 'host', version: '1' });
  try {
    await client.connect(config.plugin!.createTransport());
    expect((await client.listTools()).tools[0]._meta?.ui).toMatchObject({
      resourceUri: 'ui://form',
    });
    expect(state.reads).toBe(0);
  } finally {
    await client.close();
  }
});
it.each(['owner', 'revision', 'package', 'disabled', 'boundary'] as const)(
  'rejects an existing virtual connection after %s changes',
  (kind) => {
    const f = fixture();
    f.refresh();
    const old = state.configs.get(pluginAppServerId(f.ghost))!();
    if (kind === 'owner') state.owner = 'B';
    if (kind === 'revision')
      f.setGhost({ ...f.ghost, approval: { state: 'approved', revision: 'two' } });
    if (kind === 'package') f.setFingerprint();
    if (kind === 'disabled') f.ghost.enabled = false;
    if (kind === 'boundary') f.unavailable();
    expect(() => old.plugin!.assertCurrent()).toThrow('MCP_APP_SERVER_CHANGED');
    if (kind === 'owner') {
      f.refresh();
      expect(() => state.configs.get(old.id)!().plugin!.assertCurrent()).not.toThrow();
      expect(() => old.plugin!.assertCurrent()).toThrow();
    }
  },
);
it('keeps organization and personal instances separate', () => {
  const { ghost } = fixture();
  expect(pluginAppServerId({ ...ghost, namespace: null })).not.toBe(
    pluginAppServerId({ ...ghost, namespace: 'xd' }),
  );
});
