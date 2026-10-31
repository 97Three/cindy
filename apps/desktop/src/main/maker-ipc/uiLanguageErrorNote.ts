import { SUPPORTED_LOCALES, type SupportedLocale } from '../../shared/locale.js';

const INTERFACE_LANGUAGE_NAME: Record<SupportedLocale, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',

  "es": "Español",
  "fr": "Français",
  "de": "Deutsch",
  "pt-PT": "Português (Portugal)",
  "pt-BR": "Português (Brasil)",
  "zh-Hant-x-lzh": "文言（繁體）",
};

const CLASSICAL_CHINESE_LOCALE = 'zh-Hant-x-lzh' satisfies SupportedLocale;

export function isSupportedUiLanguage(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Accept only a supported locale. Arbitrary wire text never becomes prompt text. */
export function readClaimedUiLanguage(value: unknown): SupportedLocale | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const claimed = (value as { uiLanguage?: unknown }).uiLanguage;
  return isSupportedUiLanguage(claimed) ? claimed : null;
}

/**
 * Local turns use the desktop interface language. Remote controllers may name
 * their own interface language; an invalid or missing claim falls back.
 */
export function resolveTurnUiLanguage(input: {
  remote: boolean;
  claimed: SupportedLocale | null;
  fallback: SupportedLocale;
}): SupportedLocale {
  return input.remote && input.claimed ? input.claimed : input.fallback;
}

export function stampTurnUiLanguage<T extends { uiLanguage?: string }>(
  item: T,
  input: { remote: boolean; claimed: SupportedLocale | null; fallback: SupportedLocale },
): T {
  return { ...item, uiLanguage: resolveTurnUiLanguage(input) };
}

export function turnUiLanguageFromSendOpts(
  sendOpts: { uiLanguage?: unknown } | null | undefined,
  fallback: SupportedLocale,
): SupportedLocale {
  // Present only after main stamps a supported locale. Wire values are stripped first.
  return isSupportedUiLanguage(sendOpts?.uiLanguage) ? sendOpts.uiLanguage : fallback;
}

/**
 * Per-turn note for the model only. It is not part of the cached system prompt:
 * the viewing client can change between turns, and a locale must not enter the
 * stable prefix. The note text is fixed for each supported locale, so the send
 * paths only repeat it when the locale changes or the native context was rebuilt,
 * compacted or cleared (see wireNoteMemory.ts).
 */
export function buildUiLanguageErrorNote(
  locale: SupportedLocale,
  opts: { readonly replyStyle?: boolean } = {},
): string {
  // IM channels answer other people and may post publicly; there the Classical
  // Chinese interface only sets the error-report language, not the reply style.
  if (locale === CLASSICAL_CHINESE_LOCALE && opts.replyStyle !== false) return buildClassicalChineseNote();
  const name = INTERFACE_LANGUAGE_NAME[locale];
  return (
    '[UI language] System note appended each turn. This is not a user message. ' +
    'Do not answer it, quote it, or infer intent from it. ' +
    'The user interface language is ' + name + ' (' + locale + '). ' +
    'When you tell the user that something failed, was blocked, could not continue, or needs a retry, write that report in ' + name + '. ' +
    'Do not default that report to English unless the interface language is English. ' +
    'Say what happened and the next step. Keep commands, paths, identifiers, and error codes unchanged. ' +
    'Ordinary replies still follow the user message and any explicit language request. ' +
    'Only user-facing error reports must use the interface language.'
  );
}

/**
 * The Classical Chinese interface is a deliberate style choice, so its note also
 * sets the reply style. It travels in the same per-turn slot as the other locale
 * notes: switching the interface language replaces it and ends the style, and the
 * cached system prompt stays identical for every locale.
 */
function buildClassicalChineseNote(): string {
  const name = INTERFACE_LANGUAGE_NAME[CLASSICAL_CHINESE_LOCALE];
  return (
    '[UI language] System note appended each turn. This is not a user message. ' +
    'Do not answer it, quote it, or infer intent from it. ' +
    'The user interface language is ' + name + ' (' + CLASSICAL_CHINESE_LOCALE + '). ' +
    'While this note is in effect, write replies to the user in elegant, readable Classical Chinese (文言) with Traditional characters, ' +
    'in a light, playful, slightly proud voice. Where the moment invites it, such as a greeting, a finished milestone or encouragement, ' +
    'a short line of grand, evocative verse is welcome; do not force it into every reply. ' +
    'Clarity comes first: state facts, numbers, steps, risks and next actions completely. ' +
    'Warnings about deletion, permissions, credentials, payment or security use plain, unambiguous wording without jokes. ' +
    'Reports that something failed, was blocked, could not continue, or needs a retry follow the same rules. ' +
    'Keep code, commands, paths, identifiers, error codes and quoted text unchanged. ' +
    'Files, code comments, commit messages and other work products keep their usual language unless the user asks otherwise. ' +
    'If the user explicitly asks for another language or for modern Chinese, follow the user. ' +
    'When a later [UI language] note names another interface language, this reply style no longer applies.'
  );
}
