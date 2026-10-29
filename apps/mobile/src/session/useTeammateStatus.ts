import { useCallback, useSyncExternalStore } from 'react';
import { resolveTeammateStatus, type TeammateStatus } from '@cindy/maker-shared/teammate-status';
import { remoteSessionStore } from './remoteSessionStore';

/** Runtime subscription stays separate from the display-only status point. */
export function useTeammateStatus(input: Parameters<typeof resolveTeammateStatus>[0] & {
  sessionId?: string | null; deviceId?: string;
}): TeammateStatus {
  const { sessionId, deviceId } = input;
  const snapshot = useCallback(() => !sessionId ? ''
    : remoteSessionStore.getPendingInteractions(sessionId, deviceId).length ? 'needs-interaction'
      : remoteSessionStore.getSessionLiveActivity(sessionId, deviceId)?.phase ?? '', [sessionId, deviceId]);
  const phase = useSyncExternalStore(remoteSessionStore.subscribe, snapshot);
  return resolveTeammateStatus({ ...input, activities: [...(input.activities ?? []), ...(phase ? [{ phase }] : [])] });
}
