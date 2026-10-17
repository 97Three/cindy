import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../../shared/ghost.js';
import { resolveGithubAuthRecovery } from '../githubRecoveryHost.js';
import type { AuthRecoveryRequest } from '../host.js';

// Unit: exercise the production wiring and real githubConnection with a synthetic
// fetch. Policy tests alone cannot prove credential precedence or owner isolation.
const h = vi.hoisted(() => ({
  owner: 1, boundary: false, trusted: true, ghost: null as InstalledGhost | null,
  readGh: vi.fn<() => Promise<string | null>>(), readSecret: vi.fn(), fetch: vi.fn(),
}));
vi.mock('../../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'test-owner', generation: h.owner }),
  isAppSessionBoundaryPending: () => h.boundary,
}));
vi.mock('../../../cindy-brain/index.js', () => ({
  getGhostManager: () => ({ list: () => h.ghost ? [h.ghost] : [] }),
  getGhostSetupAssessment: () => ({ state: 'ready' }),
  isGhostAvailableForActiveSession: () => true,
}));
vi.mock('../../../cindy-brain/GhostManager.js', () => ({ isCindyOfficialTrustInfo: () => h.trusted }));
vi.mock('../../../cindy-brain/ghostWorkdirPrefs.js', () => ({ isGhostDisabledForWorkdir: () => false }));
vi.mock('../../../localDb/ipc/sessions.js', () => ({
  getSessionFsSnapshot: async () => ({ workingDir: '/project', remoteHostId: null }),
}));
vi.mock('../../../git-context/ghCliTokenSource.js', () => ({
  getSharedGhCliTokenSource: () => ({ readToken: h.readGh }),
}));
vi.mock('../../../maker-host/outbound-fetch.js', () => ({ outboundFetch: h.fetch }));
vi.mock('../../../secrets/providerSecretStore.js', () => ({ readGhostSecret: h.readSecret }));

const request: AuthRecoveryRequest = {
  sessionId: 'task', prompt: "Password for 'https://someone@github.com':",
  asker: { program: 'git', command: 'git push origin main', gitOrigin: 'https://github.com' },
};
beforeEach(() => {
  vi.clearAllMocks();
  h.owner = 1; h.boundary = false; h.trusted = true;
  h.ghost = {
    manifest: { schemaVersion: 3, id: 'cindy-github', name: 'GitHub', version: '1.0.0', kind: 'chip', entry: 'index.js',
      tools: [{ name: 'list_tools' }, { name: 'call_tool' }], network: { hosts: ['api.github.com'], secrets: [{
        key: 'test_gh_connection', source: 'gh-cli', label: 'GitHub',
        inject: { header: 'Authorization', format: 'Bearer {value}', hosts: ['api.github.com'] },
      }] } },
    dir: '/tmp/cindy-github', namespace: null, enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  } as InstalledGhost;
  h.readGh.mockResolvedValue('synthetic-gh-token');
  h.readSecret.mockReturnValue('synthetic-pat');
  h.fetch.mockImplementation(async () => new Response(JSON.stringify({ login: 'test-user' }), { status: 200 }));
});

describe('GitHub recovery host wiring', () => {
  it('uses the saved gh login and exposes only recovery guidance', async () => {
    const result = await resolveGithubAuthRecovery(request);
    expect(result).toContain('CINDY_AUTH_ALTERNATIVE_AVAILABLE');
    expect(result).not.toContain('synthetic-gh-token');
    expect(result).not.toContain('test-user');
    expect(h.readSecret).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledWith('https://api.github.com/user', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer synthetic-gh-token' }), redirect: 'error',
    }));
  });

  it('falls back only to the selected installation and its declared secret key', async () => {
    h.readGh.mockResolvedValue(null);
    const result = await resolveGithubAuthRecovery(request);
    expect(result).toContain('CINDY_AUTH_ALTERNATIVE_AVAILABLE');
    expect(result).not.toContain('synthetic-pat');
    expect(h.readSecret).toHaveBeenCalledWith('cindy-github', 'test_gh_connection');
    expect(h.fetch).toHaveBeenCalledWith('https://api.github.com/user', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer synthetic-pat' }),
    }));
  });

  it.each(['untrusted', 'unknown-contract', 'owner-boundary'])('does not read credentials for %s', async (reason) => {
    if (reason === 'untrusted') h.trusted = false;
    if (reason === 'unknown-contract') h.ghost!.manifest.network = undefined;
    if (reason === 'owner-boundary') h.boundary = true;
    expect(await resolveGithubAuthRecovery(request)).toBeNull();
    expect(h.readGh).not.toHaveBeenCalled();
    expect(h.readSecret).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('does not use an old-owner credential after an asynchronous read', async () => {
    h.readGh.mockImplementation(async () => { h.owner = 2; return 'synthetic-old-token'; });
    expect(await resolveGithubAuthRecovery(request)).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.readSecret).not.toHaveBeenCalled();
  });

  it('retains the original authentication flow on rejection without exposing response bodies', async () => {
    h.fetch.mockImplementation(async () => new Response('synthetic private rejection', { status: 401 }));
    expect(await resolveGithubAuthRecovery(request)).toBeNull();
  });
});
