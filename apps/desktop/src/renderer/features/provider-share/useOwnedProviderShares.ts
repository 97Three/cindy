import { useEffect, useState } from 'react';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { providerShareManagementCommand } from '@/features/provider-group/providerManagement';

type SharedProviders = ReadonlyMap<string | null, ReadonlySet<string>>;
const EMPTY: SharedProviders = new Map();

/** Settings-only classification; null identifies this computer, other keys identify my other computers. */
export function useOwnedProviderShares(deviceIds: readonly string[]): SharedProviders {
  const owner = getDataOwnerGeneration();
  const devicesKey = JSON.stringify([...new Set(deviceIds)].sort());
  const [snapshot, setSnapshot] = useState<{ owner: typeof owner; providers: SharedProviders } | null>(null);

  useEffect(() => {
    let disposed = false;
    const current = () => !disposed && isDataOwnerGenerationCurrent(owner);
    const hosts: (string | null)[] = [null, ...JSON.parse(devicesKey)];
    const inFlight = new Set<string | null>();
    const refreshAgain = new Set<string | null>();
    const load = async (deviceId: string | null) => {
      if (inFlight.has(deviceId)) {
        refreshAgain.add(deviceId);
        return;
      }
      if (!current()) return;
      if (deviceId ? !window.electronAPI?.providerGroup : !window.electronAPI?.providerShare) return;
      inFlight.add(deviceId);
      try {
        const state = await providerShareManagementCommand({ action: 'owned', range: 'month' }, deviceId ?? undefined);
        if (!current() || !state.ready) return;
        // A generated link or pending request alone is not an established share. Paused members still count.
        const ids = new Set(state.shares.filter(share => share.members.length > 0).map(share => share.providerId));
        setSnapshot(previous => {
          const providers = new Map(previous && previous.owner.dataOwnerId === owner.dataOwnerId
            && previous.owner.generation === owner.generation ? previous.providers : EMPTY);
          providers.set(deviceId, ids);
          return { owner, providers };
        });
      } catch {
        // Keep the last display classification on temporary failures or computers running an older version.
      } finally {
        inFlight.delete(deviceId);
        if (refreshAgain.delete(deviceId) && current()) void load(deviceId);
      }
    };
    const refresh = () => {
      if (document.visibilityState !== 'hidden') hosts.forEach(deviceId => { void load(deviceId); });
    };
    refresh();
    const off = window.electronAPI?.providerShare?.onOwnedChanged?.(() => { void load(null); });
    // Other computers do not push their sharing changes to this settings page.
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      off?.();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [owner, devicesKey]);

  return snapshot && snapshot.owner.dataOwnerId === owner.dataOwnerId
    && snapshot.owner.generation === owner.generation ? snapshot.providers : EMPTY;
}
