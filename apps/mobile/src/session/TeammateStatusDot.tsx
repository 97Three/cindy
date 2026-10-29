import { useCallback, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { TEAMMATE_AVATAR, resolveTeammateStatus, type TeammateStatus } from '@cindy/maker-shared/teammate-status';
import { useTheme, radius } from '@/theme';
import { remoteSessionStore } from './remoteSessionStore';

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

export function TeammateStatusDot({ status }: { status: TeammateStatus }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  if (status === 'idle') return null;
  const color = { running: colors.statusAccent, awaiting: colors.statusAwaiting,
    done: colors.statusDone, error: colors.statusError, unread: colors.botUnread }[status];
  return <View testID={`teammate.status.${status}`} accessibilityRole="image"
    accessibilityLabel={t(`devices.companions.avatarStatus.${status}`)}
    style={{ position: 'absolute', right: -1, bottom: -1, padding: TEAMMATE_AVATAR.border,
      borderRadius: radius.pill, backgroundColor: colors.surface }}>
    <View style={{ width: TEAMMATE_AVATAR.dot, height: TEAMMATE_AVATAR.dot,
      borderRadius: radius.pill, backgroundColor: color }} />
  </View>;
}
