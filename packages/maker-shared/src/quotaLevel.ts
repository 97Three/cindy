/**
 * How full a quota is, for every surface that colors one: the macOS menu bar panel, the
 * iPhone widgets, the Desktop usage card, chip and model picker, and the mobile model picker
 * and session menu. One rule, so a window never reads yellow in one place and red in another.
 *
 * Judged on what is left in the tightest window: 30% or less is `warn` (yellow), 10% or less
 * is `crit` (red). A provider's own verdict can only raise the level: a warning is at least
 * `warn`, an exceeded or rejected limit is `crit`.
 */

export type QuotaLevel = 'normal' | 'warn' | 'crit';

export const QUOTA_WARN_REMAINING_PERCENT = 30;
export const QUOTA_CRIT_REMAINING_PERCENT = 10;

const RANK: Record<QuotaLevel, number> = { normal: 0, warn: 1, crit: 2 };

export function quotaLevelFromRemaining(remainingPercent: number): QuotaLevel {
  if (!Number.isFinite(remainingPercent)) return 'normal';
  if (remainingPercent <= QUOTA_CRIT_REMAINING_PERCENT) return 'crit';
  if (remainingPercent <= QUOTA_WARN_REMAINING_PERCENT) return 'warn';
  return 'normal';
}

export function quotaLevelFromUsed(usedPercent: number): QuotaLevel {
  return Number.isFinite(usedPercent) ? quotaLevelFromRemaining(100 - usedPercent) : 'normal';
}

/**
 * A provider's severity string ("warning", "allowed_warning", "exceeded", "rejected",
 * "critical"…) as a level. Anything other than empty or "normal" is at least a warning, so a
 * new upstream value is never shown as normal.
 */
export function quotaLevelFromSeverity(severity: string | null | undefined): QuotaLevel {
  const value = severity?.trim().toLowerCase() ?? '';
  if (!value || value === 'normal') return 'normal';
  if (/exceed|critical|reject|blocked|limit_reached/.test(value)) return 'crit';
  return 'warn';
}

export function strongerQuotaLevel(...levels: QuotaLevel[]): QuotaLevel {
  return levels.reduce<QuotaLevel>((max, level) => (RANK[level] > RANK[max] ? level : max), 'normal');
}
