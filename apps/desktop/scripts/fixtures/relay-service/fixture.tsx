import { RelayServicePanel, useSelfHostedRelayState } from '../../../src/renderer/components/settings/RelayServicePanel';
import type { SelfHostedRelayCommand, SelfHostedRelayState } from '../../../src/shared/selfHostedRelay';
import { forbid, mountPage, subscription } from '../../ui-page/harness';

const deployment = {
  sshHostId: 'demo-server', address: '203.0.113.10', baseUrl: 'https://203.0.113.10', name: 'Test',
  relayVersion: '0.3.1', deployedAt: '2026-10-29T00:00:00Z', active: false, upgradeAvailable: false,
};

/** default:官方在用、服务器中转已部署未使用;server:正在用服务器中转;host:这台电脑当中转在用。 */
function initialState(name: string): SelfHostedRelayState {
  const server = name === 'server';
  const host = name === 'host';
  const recovering = name.startsWith('retry-') || name === 'join-error';
  const finishedAt = Date.now();
  return {
    available: true,
    mode: server || host ? 'self-hosted' : 'official',
    relay: server
      ? { name: 'Test', baseUrl: deployment.baseUrl, role: 'owner', origin: 'server' }
      : host
        ? { name: 'This computer', baseUrl: 'http://127.0.0.1:47820', role: 'owner', origin: 'host' }
        : null,
    issue: null,
    host: {
      enabled: host, running: host, error: null, port: 47820, listenAll: host, externalUrl: null,
      suggestedUrls: ['http://192.168.1.20:47820'],
    },
    deployment: { ...deployment, active: server, ...(recovering ? { relayVersion: '' } : {}) },
    deployJob: recovering ? {
      action: 'deploy', status: 'failed', step: 'runtime', error: 'DOWNLOAD_FAILED',
      startedAt: finishedAt - 15_000, finishedAt, serverChanged: true,
      target: { sshHostId: deployment.sshHostId, address: deployment.address, name: deployment.name, baseUrl: deployment.baseUrl },
      logs: [{ at: finishedAt - 15_000, step: 'check' }, { at: finishedAt - 14_000, step: 'runtime' }],
    } : null,
    bundledRelayVersion: '0.3.1',
    joinLink: null,
    pendingRequests: [],
    join: { status: 'idle' },
  };
}

function Page() {
  const controller = useSelfHostedRelayState(true);
  return <div className="mx-auto max-w-3xl p-4"><RelayServicePanel controller={controller} /></div>;
}

void mountPage({
  host: ctx => {
    let state = initialState(ctx.case);
    const recovering = ctx.case.startsWith('retry-') || ctx.case === 'join-error';
    return {
      selfHostedRelay: {
        command: async (command: SelfHostedRelayCommand) => {
          if (command.type === 'state') return { state };
          if (command.type === 'deployment-status') {
            const certificateExpiresAt = new Date(Date.now() + 5.5 * 86_400_000).toISOString();
            return { state, deploymentStatus: { online: true, devices: 3, onlineDevices: 2, certificateExpiresAt } };
          }
          if (recovering && command.type === 'check-server') {
            return ctx.case === 'retry-check-error'
              ? { state, check: { sshHostId: command.sshHostId, ok: false, error: 'PORT_BUSY_CONTAINER', detail: 'demo-nginx' } }
              : { state, check: { sshHostId: command.sshHostId, ok: true, system: 'Linux x86_64', plan: 'direct', existing: ctx.case === 'retry-replace' ? 'other' : 'mine' } };
          }
          if (recovering && command.type === 'deploy') {
            if (command.replaceExisting !== (ctx.case === 'retry-replace')) return forbid('unexpected relay replacement')();
            state = {
              ...state, mode: 'self-hosted',
              relay: { name: deployment.name, baseUrl: deployment.baseUrl, role: 'owner', origin: 'server' },
              deployment: { ...deployment, active: true },
              deployJob: { ...state.deployJob!, step: 'finish', status: 'done' },
            };
            return { state };
          }
          if (recovering && command.type === 'create-join-link') return { state, ...(ctx.case === 'join-error' ? { error: 'FAILED' } : {}) };
          return forbid(`selfHostedRelay.command:${command.type}`)();
        },
        onChanged: subscription('relayChanged'),
      },
      remoteSsh: {
        list: async () => ({ hosts: [{ config: { id: 'demo-server', displayName: 'demo-server', hostname: '203.0.113.10', user: 'root' } }] }),
      },
    };
  },
  render: () => <Page />,
});
