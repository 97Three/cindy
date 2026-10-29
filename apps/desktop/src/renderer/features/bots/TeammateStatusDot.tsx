import { useTranslation } from 'react-i18next';
import { TEAMMATE_AVATAR, type TeammateStatus } from '@cindy/maker-shared/teammate-status';
import { cn } from '@/lib/utils';

const COLOR: Record<Exclude<TeammateStatus, 'idle'>, string> = {
  awaiting: 'var(--card-status-awaiting)', error: 'var(--card-status-error)',
  running: 'var(--status-bar-accent)', done: 'var(--card-status-done)', unread: 'var(--bot-unread-bg)',
};

/** One fixed solid point, including while running. No changing glyph or outer progress ring. */
export function TeammateStatusDot({ status, selected = false }: { status: TeammateStatus; selected?: boolean }) {
  const { t } = useTranslation();
  if (status === 'idle') return null;
  const label = t(`bots.avatarStatus.${status}`);
  return <span role="img" aria-label={label} title={label} data-teammate-status={status}
    className={cn('absolute -bottom-px -right-px rounded-full border-solid',
      selected ? 'border-sidebar-item-active' : 'border-sidebar')}
    style={{ width: TEAMMATE_AVATAR.dot + 2 * TEAMMATE_AVATAR.border,
      height: TEAMMATE_AVATAR.dot + 2 * TEAMMATE_AVATAR.border,
      borderWidth: TEAMMATE_AVATAR.border, backgroundColor: COLOR[status] }} />;
}
