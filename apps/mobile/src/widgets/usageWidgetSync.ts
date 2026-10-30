import { requireOptionalNativeModule } from 'expo-modules-core';
import type { DeviceView } from '@cindy/device-link';
import {
  DEVICE_LINK_USAGE_WIDGET_SNAPSHOT_CHANNEL,
  type MobileUsageWidgetSnapshot,
} from '@cindy/maker-shared/device-link-contract';

/**
 * What the iOS widgets read from the App Group. `update-desktop` is only written when every
 * reachable computer is too old to answer; a temporary failure keeps the last snapshot.
 */
export type UsageWidgetState =
  | { kind: 'snapshot'; receivedAtMs: number; deviceName: string; snapshot: MobileUsageWidgetSnapshot }
  | { kind: 'update-desktop'; receivedAtMs: number };

// Absent on binaries built before the widgets (OTA updates reach them too).
const native = requireOptionalNativeModule<{
  writeSnapshot(json: string): boolean;
  clearSnapshot(): void;
}>('CindyUsageWidgets');

export const usageWidgetsSupported = native !== null;

export function writeUsageWidgetState(state: UsageWidgetState): boolean {
  return native?.writeSnapshot(JSON.stringify(state)) ?? false;
}

export function clearUsageWidgetState(): void {
  native?.clearSnapshot();
}

const MOBILE_PLATFORMS = new Set(['ios', 'android', 'web']);

/** Online computers that allow remote control, macOS first (only it runs the menu bar panel). */
export function usageWidgetCandidates(devices: readonly DeviceView[]): DeviceView[] {
  return devices
    .filter(device => !device.isSelf && device.online && device.remoteControlEnabled
      && !MOBILE_PLATFORMS.has(device.platform ?? ''))
    .sort((a, b) => Number(b.platform === 'darwin') - Number(a.platform === 'darwin'));
}

type Invoke = <T>(deviceId: string, channel: string, args?: unknown[]) => Promise<T>;

function isChannelNotAllowed(error: unknown): boolean {
  // Covers both CHANNEL_NOT_ALLOWED and DEVICE_LINK_CHANNEL_NOT_ALLOWED, as code or message.
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  const message = error instanceof Error ? error.message : String(error);
  return `${code} ${message}`.includes('CHANNEL_NOT_ALLOWED');
}

function isSnapshot(value: unknown): value is MobileUsageWidgetSnapshot {
  const snapshot = value as Partial<MobileUsageWidgetSnapshot> | null;
  return !!snapshot && snapshot.version === 1 && Array.isArray(snapshot.sources)
    && !!snapshot.usage && Array.isArray(snapshot.usage.daily) && Array.isArray(snapshot.usage.days);
}

/**
 * Asks each candidate in turn and returns the first usable snapshot. Returns null when no
 * computer could answer this time (offline, panel off, transient error) so the caller keeps
 * whatever the widgets already show.
 */
export async function readUsageWidgetState(
  devices: readonly DeviceView[],
  invoke: Invoke,
  nowMs: () => number = Date.now,
): Promise<UsageWidgetState | null> {
  const candidates = usageWidgetCandidates(devices);
  let tooOld = 0;
  for (const device of candidates) {
    try {
      const result = await invoke<{ ok?: boolean; snapshot?: unknown }>(
        device.deviceId, DEVICE_LINK_USAGE_WIDGET_SNAPSHOT_CHANNEL, [],
      );
      if (result?.ok === true && isSnapshot(result.snapshot)) {
        return {
          kind: 'snapshot',
          receivedAtMs: nowMs(),
          deviceName: device.selfName || device.name,
          snapshot: result.snapshot,
        };
      }
    } catch (error) {
      if (isChannelNotAllowed(error)) tooOld += 1;
    }
  }
  return candidates.length > 0 && tooOld === candidates.length
    ? { kind: 'update-desktop', receivedAtMs: nowMs() }
    : null;
}
