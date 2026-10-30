import { useEffect, useState } from 'react';
import { isSharedTaskPeer } from '@cindy/device-link';
import { CONTROLLED_MODEL_CATALOG_CHANNEL, CONTROLLED_MODEL_CATALOG_CHANGED, type ControlledModelLocation } from '../../shared/controlledModelCatalog';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { extractIpcError } from '@/utils/ipcError';
import { evictControlledDeviceProviders, refreshControlledDeviceProviders } from './useDeviceProviders';
import { evictControlledDeviceCapabilities, refreshControlledDeviceCapabilities } from './useAgentCapabilities';

const EMPTY_LOCATIONS: ControlledModelLocation[] = [];

/** The task host discovers sources; no intersection with the controller's shares/devices. */
export function useControlledModelLocations(deviceId: string | null | undefined, selfDeviceId?: string | null) {
  const owner = getDataOwnerGeneration();
  const [snapshot, setSnapshot] = useState<{
    deviceId: string; owner: typeof owner; locations: ControlledModelLocation[] | undefined;
  } | null>(null);
  useEffect(() => {
    if (!deviceId || isSharedTaskPeer(deviceId)) return;
    const link = window.electronAPI?.deviceLink;
    if (!link) return;
    let active = true;
    let revision = 0;
    let pending = false;
    let queued = false;
    let available = true;
    let supported = false;
    let sourceIds = new Set<string>();
    const presenceStates = new Map<string, string>();
    const invalidate = () => {
      revision++;
      evictControlledDeviceProviders(deviceId);
      evictControlledDeviceCapabilities(deviceId);
      setSnapshot(current => current?.deviceId === deviceId && current.owner === owner
        ? { ...current, locations: [] } : null);
    };
    const refresh = async () => {
      if (!active || pending || !available || !isDataOwnerGenerationCurrent(owner)) return;
      pending = true;
      const request = ++revision;
      const current = () => active && request === revision && isDataOwnerGenerationCurrent(owner);
      try {
        const raw = await link.invoke(deviceId, CONTROLLED_MODEL_CATALOG_CHANNEL, [{ op: 'locations' }]);
        if (!current()) return;
        const value = raw as { locations?: unknown } | null;
        if (!value || !Array.isArray(value.locations)) throw new Error('Invalid model locations');
        const locations = value.locations.filter((entry): entry is ControlledModelLocation =>
          !!entry && typeof entry === 'object'
          && typeof entry.agentDeviceId === 'string' && entry.agentDeviceId.length > 0
          && typeof entry.name === 'string');
        supported = true;
        sourceIds = new Set(locations.map(location => location.agentDeviceId));
        setSnapshot({ deviceId, owner, locations });
        refreshControlledDeviceProviders(deviceId);
        refreshControlledDeviceCapabilities(deviceId);
      } catch (error) {
        if (!current()) return;
        const code = extractIpcError(error)?.code;
        // Old hosts keep their existing direct-read behavior. Network failures do
        // not switch a previously supported host back to the controller's grants.
        if (!supported && (code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' || code === 'NOT_FOUND' || code === 'UNSUPPORTED_CAPABILITY')) {
          setSnapshot({ deviceId, owner, locations: undefined });
        } else if (supported) {
          setSnapshot({ deviceId, owner, locations: [] });
        }
      } finally {
        pending = false;
        if (queued && active) { queued = false; void refresh(); }
      }
    };
    const reload = () => {
      invalidate();
      if (pending) queued = true;
      else void refresh();
    };
    const offStatus = link.onStatusChanged?.(({ status }) => {
      available = status === 'online';
      reload();
    });
    const offPresence = link.onPresenceChanged?.(presence => {
      const signature = `${presence.online}:${presence.remoteControlEnabled}`;
      if (presenceStates.get(presence.deviceId) === signature) return;
      presenceStates.set(presence.deviceId, signature);
      if (presence.deviceId === deviceId) {
        available = presence.online && presence.remoteControlEnabled;
        reload();
      } else if (available) reload();
    });
    const offReset = link.onPeerLinkReset?.(event => {
      if (event.deviceId === deviceId || sourceIds.has(event.deviceId)) reload();
    });
    const offControl = link.onControlTargetChanged?.(event => {
      if (event.deviceId === deviceId) { available = event.enabled; reload(); }
    });
    const offPush = link.onRemotePush?.(event => {
      if (((event.channel === 'maker:provider:changed' || event.channel === 'maker:agents:changed')
        && (event.deviceId === deviceId || sourceIds.has(event.deviceId)))
        || (event.deviceId === deviceId && event.channel === CONTROLLED_MODEL_CATALOG_CHANGED)) reload();
    });
    // A does not receive its own broadcasts through B. Its local notifications
    // must also refresh catalogs routed through B, without using A's local grants.
    const reloadLocalSource = () => {
      if (selfDeviceId && isDataOwnerGenerationCurrent(owner)
        && (!supported || sourceIds.has(selfDeviceId))) reload();
    };
    const offProviders = window.electronAPI?.maker?.onProvidersChanged?.(reloadLocalSource);
    const offAgents = window.electronAPI?.maker?.onAgentsChanged?.(reloadLocalSource);
    window.addEventListener('focus', reload);
    void refresh();
    return () => {
      active = false;
      offStatus?.(); offPresence?.(); offReset?.(); offControl?.(); offPush?.();
      offProviders?.(); offAgents?.();
      window.removeEventListener('focus', reload);
    };
  }, [deviceId, selfDeviceId, owner]);
  if (!deviceId || isSharedTaskPeer(deviceId) || !window.electronAPI?.deviceLink) return undefined;
  // Until discovery completes, retain the saved source instead of temporarily
  // calibrating its model against B's local catalog. Only proven old hosts fall back.
  return snapshot && snapshot.deviceId === deviceId && snapshot.owner === owner ? snapshot.locations : EMPTY_LOCATIONS;
}
