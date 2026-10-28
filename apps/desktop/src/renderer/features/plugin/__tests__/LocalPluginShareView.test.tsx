/** @vitest-environment jsdom */
// Test value: recipient navigation must require login, wait for an install click,
// preserve cancellation and discard stale account reads. Public detail tests use
// market releases, not this fixed manual package. Unit tier: real view, fake IPC.
// Minimal inputs: one snapshot, a rejected consent and a delayed old-owner read.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createIpcError } from '../../../../shared/ipc-errors';
import { LocalPluginShareView } from '../LocalPluginShareView';
import type { CatalogDeviceControl } from '../PluginDevicePicker';

const io = vi.hoisted(() => ({ read: vi.fn(), install: vi.fn(), invoke: vi.fn(), confirm: vi.fn(), auth: {
  isAuthenticated: true, mode: 'cloud', dataOwnerId: 'owner', dataOwnerGeneration: 1,
} }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => io.auth }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: io.confirm }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const snapshotId = 's'.repeat(32);
const snapshot = { schemaVersion: 1, snapshotId, ghostId: 'shared-plugin', name: 'Shared Plugin', description: null, author: null,
  version: '1.0.0', sha256: 'a'.repeat(64), sizeBytes: 1024, createdAt: '2026-10-28T00:00:00.000Z', icon: null };
const ghost = { manifest: { id: 'shared-plugin' } };
beforeEach(() => {
  io.auth.isAuthenticated = true; io.auth.dataOwnerGeneration = 1;
  io.read.mockReset().mockResolvedValue(snapshot); io.install.mockReset().mockResolvedValue({ ghost });
  io.invoke.mockReset(); io.confirm.mockReset().mockResolvedValue(true);
  vi.stubGlobal('electronAPI', { platform: 'win32', getFullscreenState: async () => false, onFullscreenChange: () => () => {},
    deviceLink: { invoke: io.invoke },
    pluginMarket: { localShareDetail: io.read, installLocalShare: io.install } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const view = (onInstalled = vi.fn(), deviceControl?: CatalogDeviceControl) => <MemoryRouter><LocalPluginShareView snapshotId={snapshotId} deviceControl={deviceControl} onBack={vi.fn()} onInstalled={onInstalled} /></MemoryRouter>;

it('does not read a local share before login', () => {
  io.auth.isAuthenticated = false;
  render(view());
  expect(screen.getByRole('button', { name: 'sharing.localSignIn' })).toBeTruthy();
  expect(io.read).not.toHaveBeenCalled(); expect(io.install).not.toHaveBeenCalled();
});
it('only installs the visible fixed version after an explicit click', async () => {
  const installed = vi.fn(); render(view(installed));
  expect(await screen.findByText('v1.0.0')).toBeTruthy();
  expect(io.install).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'sharing.localInstallButton' }));
  await waitFor(() => expect(installed).toHaveBeenCalledWith(ghost));
  expect(io.install).toHaveBeenCalledWith(snapshotId, snapshot);
});
it('keeps a declined permission confirmation as cancellation without reporting installation', async () => {
  const installed = vi.fn(); io.install.mockRejectedValue(createIpcError('MUTATION_CANCELLED', 'Declined'));
  render(view(installed)); await screen.findByText('v1.0.0');
  fireEvent.click(screen.getByRole('button', { name: 'sharing.localInstallButton' }));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'sharing.localInstallButton' }).disabled).toBe(false));
  expect(installed).not.toHaveBeenCalled(); expect(screen.queryByRole('alert')).toBeNull();
});
it('does not show an old account response after a new account read finishes', async () => {
  let finish!: (value: typeof snapshot) => void;
  io.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const mounted = render(view());
  io.auth.dataOwnerGeneration++;
  io.read.mockResolvedValue({ ...snapshot, name: 'Current Owner Package' });
  mounted.rerender(view());
  await screen.findByText('Current Owner Package');
  await act(async () => { finish(snapshot); });
  expect(screen.queryByText('Shared Plugin')).toBeNull();
  expect(screen.getByText('Current Owner Package')).toBeTruthy();
});

const target = { deviceId: 'target-computer', name: 'Office Computer' };
const control = (online = true): CatalogDeviceControl => ({ selected: target, onSelect: vi.fn(),
  directory: { candidates: [], target: undefined, relayOnline: online, online } });
function remoteHost(supported = true) {
  io.invoke.mockImplementation(async (_device, channel, [request]) => {
    if (String(channel).includes('manifest')) return { collections: [{ id: 'plugins', actions: [{ id: 'management:snapshot' }] }] };
    if (request.actionId === 'management:snapshot') return { effects: [], result: { version: 1, ghosts: [],
      market: { items: [], customSourceNames: [], unavailableCustomSourceNames: [] }, ...(supported ? { localShares: true } : {}) } };
    const operationId = request.input.operationId;
    if (request.actionId === 'management:begin') return { effects: [], result: { operationId, phase: 'confirmation', consent: {
      requestId: 'consent-request', initiator: 'user', origin: 'local-file', facts: { kind: 'install', name: snapshot.name, version: snapshot.version, permissions: [] },
    } } };
    return { effects: [], result: { operationId, phase: 'succeeded' } };
  });
}
it('installs on the chosen device with its consent receipt and never invokes local installation', async () => {
  remoteHost(); const installed = vi.fn(); render(view(installed, control()));
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'sharing.localInstallButton' });
  await waitFor(() => expect(button.disabled).toBe(false));
  vi.useFakeTimers();
  try {
    await act(async () => { fireEvent.click(button); });
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(installed).toHaveBeenCalledWith();
  } finally { vi.useRealTimers(); }
  expect(io.install).not.toHaveBeenCalled();
  expect(io.invoke.mock.calls.every(([id]) => id === target.deviceId)).toBe(true);
  expect(io.invoke.mock.calls.find(([, , [r]]) => r.actionId === 'management:begin')?.[2][0].input)
    .toMatchObject({ kind: 'install-share', expectedSnapshot: snapshot });
  expect(io.confirm).toHaveBeenCalledOnce();
});
it.each([false, true])('keeps an offline or unsupported device selected without installing locally (%s)', async online => {
  remoteHost(false); render(view(vi.fn(), control(online)));
  await screen.findByText('v1.0.0');
  if (online) await screen.findByText('sharing.localTargetUnsupported');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'sharing.localInstallButton' }).disabled).toBe(true);
  expect(screen.getByText(target.name)).toBeTruthy();
  expect(io.install).not.toHaveBeenCalled();
});

it('reads the original receipt after an ambiguous begin without sending another install', async () => {
  remoteHost();
  const host = io.invoke.getMockImplementation()!;
  io.invoke.mockImplementation(async (...args) => {
    if (args[2][0].actionId === 'management:begin') throw new Error('Connection closed after send');
    return host(...args);
  });
  const installed = vi.fn(); render(view(installed, control()));
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'sharing.localInstallButton' });
  await waitFor(() => expect(button.disabled).toBe(false));
  vi.useFakeTimers();
  try {
    await act(async () => { fireEvent.click(button); });
    expect(screen.getByText('settings.ghosts.remote.unknown')).toBeTruthy();
    expect(installed).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(installed).toHaveBeenCalledOnce();
    const requests = io.invoke.mock.calls.map(([, , [r]]) => r);
    const begin = requests.filter(r => r.actionId === 'management:begin');
    expect(begin).toHaveLength(1);
    expect(requests.find(r => r.actionId === 'management:operation')?.input.operationId).toBe(begin[0].input.operationId);
    expect(io.install).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('cancels only the original target when the receiver leaves and discards its late result', async () => {
  remoteHost();
  const host = io.invoke.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  let originalId = '';
  io.invoke.mockImplementation(async (...args) => {
    if (args[2][0].actionId === 'management:begin') {
      originalId = args[2][0].input.operationId;
      return new Promise(resolve => { finish = resolve; });
    }
    return host(...args);
  });
  const installed = vi.fn(); const mounted = render(view(installed, control()));
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'sharing.localInstallButton' });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(originalId).not.toBe(''));
  mounted.unmount();
  expect(io.invoke.mock.calls.find(([, , [r]]) => r.actionId === 'management:cancel')).toMatchObject([
    target.deviceId, expect.any(String), [{ input: { operationId: originalId } }],
  ]);
  await act(async () => { finish({ effects: [], result: { operationId: originalId, phase: 'succeeded' } }); });
  expect(installed).not.toHaveBeenCalled();
  expect(io.install).not.toHaveBeenCalled();
});
