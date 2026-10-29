import { RelayServicePanel, useSelfHostedRelayState } from '../../../src/renderer/components/settings/RelayServicePanel';
import type { SelfHostedRelayState } from '../../../src/shared/selfHostedRelay';
import { forbid, mountPage, subscription } from '../../ui-page/harness';

const deployment = {
  sshHostId: 'demo-server', address: '203.0.113.10', baseUrl: 'https://203.0.113.10', name: 'Test',
  relayVersion: '0.3.1', deployedAt: '2026-10-29T00:00:00Z', active: false, upgradeAvailable: false,
};

/** default:官方在用、服务器中转已部署未使用;server:正在用服务器中转;host:这台电脑当中转在用。 */
function initialState(name: string): SelfHostedRelayState {
  const server = name === 'server';
  const host = name === 'host';
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
    deployment: { ...deployment, active: server },
    deployJob: null,
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
    const state = initialState(ctx.case);
    return {
      selfHostedRelay: {
        command: async (command: { type: string }) => {
          if (command.type === 'state') return { state };
          if (command.type === 'deployment-status') {
            const certificateExpiresAt = new Date(Date.now() + 5.5 * 86_400_000).toISOString();
            return { state, deploymentStatus: { online: true, devices: 3, onlineDevices: 2, certificateExpiresAt } };
          }
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
