/**
 * iPhone home-screen widget snapshot, projected from the menu bar view.
 *
 * Pure: the widget shows exactly what the macOS panel shows (same sources, order, masking
 * and money basis), so it reuses the built view instead of reading usage a second time.
 */

import type {
  MobileUsageWidgetSnapshot,
  MobileUsageWidgetSource,
} from '@cindy/maker-shared/device-link-contract';

import type { MenubarView } from '../../shared/menubarQuota.js';
import { familyLogo, MENUBAR_CINDY_LOGO } from './logos.js';
import type { MenubarFamily } from './snapshot.js';

const WIDGET_DAYS = 30;
const FAMILIES: MenubarFamily[] = ['claude', 'codex', 'grok', 'kimi'];

/** Panel strings the widget needs, plus the short duration templates for live countdowns. */
const UI_KEYS = [
  'today', 'dailyAverage', 'paid', 'tokenUnit', 'noUsage', 'scopeLocal', 'scopeAll',
  'monthScopeLocal', 'monthScopeAll', 'updatedJustNow', 'updatedMinutes', 'updatedHours', 'updatedDays',
  'harness.claude-code', 'harness.codex', 'harness.pi',
];
const DURATION_KEYS = ['daysHours', 'days', 'hoursMinutes', 'hours', 'minutes'];

export function buildUsageWidgetSnapshot(
  view: MenubarView,
  nowMs: number,
  raw: (key: string) => string | null,
): MobileUsageWidgetSnapshot | null {
  if (view.gate) return null;
  const logoOf = new Map<string, MobileUsageWidgetSource['logo']>(
    FAMILIES.map(family => [familyLogo(family), family]),
  );
  logoOf.set(MENUBAR_CINDY_LOGO, 'cindy');
  const sources: MobileUsageWidgetSource[] = [];
  for (const cell of view.sources) {
    // Pay-as-you-go and unread sources have no level; the panel lists them as rows, not tubes.
    if (cell.kind === 'payg' || cell.fill === null) continue;
    sources.push({
      id: cell.id,
      kind: cell.kind,
      name: cell.name,
      logo: logoOf.get(cell.logoSvg) ?? null,
      monogram: [...cell.name.trim()][0]?.toUpperCase() ?? '?',
      value: cell.value,
      unit: cell.valueUnit,
      label: cell.valueLabel,
      level: cell.level,
      fill: cell.fill,
      reserve: cell.reserve,
      emphasized: cell.emphasized,
      when: cell.when,
      resetsAtMs: cell.resetsAtMs ?? null,
    });
  }
  const scope = view.settings.scope;
  const data = view.usage.scopes[scope] ?? view.usage.scopes.all;
  const count = Math.min(view.usage.days.length, data?.daily.length ?? 0, WIDGET_DAYS);
  const strings: Record<string, string> = {};
  for (const key of UI_KEYS) {
    const value = view.strings[key];
    if (value !== undefined) strings[key] = value;
  }
  for (const key of DURATION_KEYS) {
    const value = raw(`menubar.durationShort.${key}`);
    if (value !== null) strings[`durationShort.${key}`] = value;
  }
  return {
    version: 1,
    generatedAtMs: nowMs,
    updatedAtMs: view.updatedAtMs,
    locale: view.locale,
    moneySymbol: view.moneySymbol,
    sources,
    usage: {
      scope,
      days: count > 0 ? view.usage.days.slice(-count) : [],
      daily: count > 0 && data ? data.daily.slice(-count).map(day => ({
        money: day.money,
        paid: day.paid,
        tokens: day.tokens,
      })) : [],
    },
    strings,
  };
}
