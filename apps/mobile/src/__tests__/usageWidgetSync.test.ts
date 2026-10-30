import { describe, expect, it, vi } from 'vitest';
import type { DeviceView } from '@cindy/device-link';
import { DEVICE_LINK_USAGE_WIDGET_SNAPSHOT_CHANNEL } from '@cindy/maker-shared/device-link-contract';

vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));

const { readUsageWidgetState } = await import('@/widgets/usageWidgetSync');

function device(deviceId: string, patch: Partial<DeviceView> = {}): DeviceView {
  return {
    deviceId, name: deviceId, platform: 'darwin', appVersion: '1', lastSeenAt: null,
    online: true, busy: false, remoteControlEnabled: true, isSelf: false, ...patch,
  };
}

const snapshot = { version: 1, sources: [], usage: { scope: 'all', days: [], daily: [] }, strings: {} };

// The widgets keep their last snapshot unless a computer answered: only "every reachable
// computer is too old" may replace it with the update prompt.
describe('readUsageWidgetState', () => {
  it('asks Macs first and skips this phone, offline and remote-off devices', async () => {
    const asked: string[] = [];
    const invoke = vi.fn(async (deviceId: string, channel: string) => {
      asked.push(deviceId);
      expect(channel).toBe(DEVICE_LINK_USAGE_WIDGET_SNAPSHOT_CHANNEL);
      return { ok: true, snapshot };
    });
    const state = await readUsageWidgetState([
      device('pc', { platform: 'win32' }),
      device('phone', { platform: 'ios', isSelf: true }),
      device('off', { online: false }),
      device('locked', { remoteControlEnabled: false }),
      device('mac'),
    ], invoke as never, () => 7);
    expect(asked).toEqual(['mac']);
    expect(state).toMatchObject({ kind: 'snapshot', deviceName: 'mac', receivedAtMs: 7 });
  });

  it('prompts for an update only when every reachable computer lacks the channel', async () => {
    const tooOld = Object.assign(new Error('[CHANNEL_NOT_ALLOWED] not allowed'), { code: 'CHANNEL_NOT_ALLOWED' });
    const allOld = await readUsageWidgetState([device('a'), device('b')], (async () => { throw tooOld; }) as never, () => 1);
    expect(allOld).toEqual({ kind: 'update-desktop', receivedAtMs: 1 });

    const mixed = vi.fn()
      .mockRejectedValueOnce(tooOld)
      .mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    expect(await readUsageWidgetState([device('a'), device('b')], mixed as never)).toBeNull();
  });
});
