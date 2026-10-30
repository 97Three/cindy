import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getPluginToolUi } from '@cindy/plugin-protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { AppServerConfig } from '../../mcp-apps/connection.js';
import type { InstalledGhost } from '../../../shared/ghost.js';
const state = vi.hoisted(() => ({
  owner: 'A',
  configs: new Map<string, () => AppServerConfig>(),
  reads: 0,
  realFiles: false,
}));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => state.owner }));
vi.mock('../../mcp-apps/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../mcp-apps/runtime.js')>();
  return {
    ...actual,
    replacePluginAppServers: (next: typeof state.configs) => {
      actual.replacePluginAppServers(next);
      state.configs = next;
    },
  };
});
vi.mock('../../cindy-brain/ghostContentTree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cindy-brain/ghostContentTree.js')>();
  return { resolveGhostContentPathSync: (...args: Parameters<typeof actual.resolveGhostContentPathSync>) => {
    state.reads++;
    if (state.realFiles) return actual.resolveGhostContentPathSync(...args);
    throw new Error('no file may be read');
  } };
});
import { resetAppServers } from '../../mcp-apps/runtime.js';
import { pagePermissionGrants } from '../../mcp-apps/pagePermissions.js';
import { refreshPluginApps, pluginAppServerId } from '../plugin-app-registry.js';
// Production registration entry, no Node process or network. Existing App host tests
// do not own plugin receipts. Minimal failure: missing ui fact or old owner callback.
// Tier: unit; mocks only external account/storage boundaries, real SDK discovery.
afterEach(() => {
  resetAppServers();
  state.owner = 'A';
  state.configs.clear();
  state.reads = 0;
  state.realFiles = false;
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

// PR #7924: list broadcasts discarded every remembered page approval. Unit through
// production refresh/registry + page grant store; previous tests mocked replacement.
// Minimum failure: refresh the unchanged approved package after granting one task/tool.
it('preserves unchanged page grants across localization and unrelated plugin updates', () => {
  const f = fixture();
  const other = { ...f.ghost, manifest: { ...f.ghost.manifest, id: 'other' } };
  const ghosts = [f.ghost, other];
  const refresh = () => refreshPluginApps(ghosts, {
    find: (id) => ghosts.find(g => g.manifest.id === id) ?? null,
    evidence: () => ({ packageSha256: 'hash' }), available: () => true,
  });
  refresh();
  const grant = { sessionId: 'task', serverId: pluginAppServerId(f.ghost), tool: 'open', revision: 'one', clearedAt: null };
  const otherGrant = { ...grant, serverId: pluginAppServerId(other) };
  pagePermissionGrants.allow('A', grant);
  pagePermissionGrants.allow('A', otherGrant);
  f.ghost.manifest.name = 'Localized title';
  refresh();
  expect(pagePermissionGrants.has('A', grant)).toBe(true);
  other.approval = { state: 'approved', revision: 'two' };
  refresh();
  expect(pagePermissionGrants.has('A', grant)).toBe(true);
  expect(pagePermissionGrants.has('A', otherGrant)).toBe(false);
  expect(pagePermissionGrants.has('A', { ...grant, tool: 'another' })).toBe(false);
  expect(pagePermissionGrants.has('A', { ...grant, sessionId: 'another' })).toBe(false);
});
it.each(['revision', 'resource-package', 'approval', 'instance', 'owner'] as const)(
  'revokes remembered page grants when %s changes', kind => {
    const f = fixture(); f.refresh();
    const grant = { sessionId: 'task', serverId: pluginAppServerId(f.ghost), tool: 'open', revision: 'one', clearedAt: null };
    pagePermissionGrants.allow('A', grant);
    if (kind === 'revision') f.setGhost({ ...f.ghost, approval: { state: 'approved', revision: 'two' } });
    if (kind === 'resource-package') { getPluginToolUi(f.ghost.manifest)!.resources[0].file = 'new.html'; f.setFingerprint(); }
    if (kind === 'approval') delete f.ghost.uiCapabilityApproved;
    if (kind === 'instance') f.setGhost({ ...f.ghost, namespace: 'another' });
    if (kind === 'owner') state.owner = 'B';
    f.refresh();
    expect(pagePermissionGrants.has('A', grant)).toBe(false);
  },
);

// #7924 / 4420763923: real SDK resources/read + disk file must honor the App host's
// 4 MiB contract. Prior tests never read HTML. Unit; 4 MiB is valid, +1 byte is not.
it('reads a 4 MiB plugin page and rejects an oversized resource', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-ui-resource-'));
  const client = new Client({ name: 'host', version: '1' });
  try {
    const f = fixture();
    f.ghost.dir = dir;
    state.realFiles = true;
    const html = 'x'.repeat(4 * 1024 * 1024);
    await fs.writeFile(path.join(dir, 'form.html'), html);
    f.refresh();
    await client.connect(state.configs.get(pluginAppServerId(f.ghost))!().plugin!.createTransport());
    expect((await client.readResource({ uri: 'ui://form' })).contents[0]).toMatchObject({ text: html });
    await fs.appendFile(path.join(dir, 'form.html'), 'x');
    await expect(client.readResource({ uri: 'ui://form' })).rejects.toThrow('MCP_APP_RESOURCE_UNAVAILABLE');
  } finally {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
