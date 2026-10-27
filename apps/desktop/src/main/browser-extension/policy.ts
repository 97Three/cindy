/**
 * 浏览器扩展站点策略(宿主侧实现)。
 *
 * 与扩展内的 policy 实现是同一套语义:扩展在页面侧再查一遍,宿主在分发作业前
 * 查一遍,两侧都必须对同一 URL 给出同样的结论。改动任何判据时两侧一起改。
 *
 * - READ 动作默认开放公网,INTERACT 动作按 interact.allow / block 守门;
 * - 只接受无内嵌凭证的公网 http(s) URL,本机与私网地址一律拒绝(扩展不是
 *   内网入口;Browser Use 的专用浏览器才允许本机可达的内网);
 * - 交给模型之前的每个 URL 都过 redactUrl:OAuth code、重置令牌、implicit-flow
 *   fragment 与 Basic Auth userinfo 不离开本机。
 */

export const BROWSER_EXTENSION_READ_ACTIONS = [
  'tabs',
  'navigate',
  'snapshot',
  'extract',
  'text',
  'content',
] as const;
export const BROWSER_EXTENSION_INTERACT_ACTIONS = [
  'click',
  'type',
  'press',
  'select',
  'hover',
  'scroll',
] as const;
export const BROWSER_EXTENSION_EXTRACT_ATTRIBUTES = [
  'href',
  'src',
  'datetime',
  'title',
  'alt',
  'aria-label',
  'role',
] as const;

export type BrowserExtensionReadAction = (typeof BROWSER_EXTENSION_READ_ACTIONS)[number];
export type BrowserExtensionInteractAction = (typeof BROWSER_EXTENSION_INTERACT_ACTIONS)[number];
export type BrowserExtensionAction = BrowserExtensionReadAction | BrowserExtensionInteractAction;

export interface BrowserExtensionPolicy {
  read: { block: string[] };
  interact: { allow: string[]; block: string[] };
}

export interface BrowserExtensionPolicyDenial {
  ok: false;
  error: string;
  message: string;
  host?: string;
  execution: 'not_executed';
}

export type BrowserExtensionPolicyVerdict =
  { ok: true; host?: string } | BrowserExtensionPolicyDenial;

export function isBrowserExtensionReadAction(
  action: unknown,
): action is BrowserExtensionReadAction {
  return (BROWSER_EXTENSION_READ_ACTIONS as readonly unknown[]).includes(action);
}

export function isBrowserExtensionInteractAction(
  action: unknown,
): action is BrowserExtensionInteractAction {
  return (BROWSER_EXTENSION_INTERACT_ACTIONS as readonly unknown[]).includes(action);
}

export function defaultBrowserExtensionPolicy(): BrowserExtensionPolicy {
  return { read: { block: [] }, interact: { allow: ['*'], block: [] } };
}

export function normalizeBrowserExtensionHost(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a domain, for example example.test.');
  const text = value.trim().toLowerCase();
  const exact = text.startsWith('=');
  const raw = exact ? text.slice(1) : text.replace(/^\*\./, '');
  if (/^\[[0-9a-f:.]+\]$/.test(raw)) {
    const host = new URL('https://' + raw).hostname;
    if (isLocalBrowserHost(host)) throw new Error('Local and private addresses are not supported.');
    return (exact ? '=' : '') + host;
  }
  if (!raw || /[\s/@:?#\\]/.test(raw))
    throw new Error('Enter a domain only, without a URL, port or path.');
  const host = new URL('https://' + raw).hostname;
  // eslint-disable-next-line no-control-regex
  if (host !== raw && !/[^\x00-\x7f]/.test(raw)) throw new Error('Invalid domain.');
  if (
    host.length > 253 ||
    !host.includes('.') ||
    host.endsWith('.') ||
    host.split('.').some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
  ) {
    throw new Error('Invalid domain.');
  }
  if (isLocalBrowserHost(host)) throw new Error('Local and private addresses are not supported.');
  return (exact ? '=' : '') + host;
}

function publicLiteral(ip: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a !== 0 &&
      a !== 10 &&
      a !== 127 &&
      a < 224 &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && b === 168) &&
      !(a === 100 && b >= 64 && b <= 127)
    );
  }
  try {
    const host = new URL('http://[' + ip + ']/').hostname.slice(1, -1);
    const [first, second] = host.split(':').map((x) => parseInt(x || '0', 16));
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      first !== 0x2002 &&
      first !== 0x3fff &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    );
  } catch {
    return false;
  }
}

export function isLocalBrowserHost(host: string): boolean {
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  const ip =
    host.startsWith('[') && host.endsWith(']')
      ? host.slice(1, -1)
      : host.includes(':')
        ? host
        : /^\d+\.\d+\.\d+\.\d+$/.test(host)
          ? host
          : null;
  if (ip) return !publicLiteral(ip);
  return !host.includes('.');
}

export function browserExtensionHostMatches(host: string, pattern: string): boolean {
  return (
    pattern === '*' ||
    (pattern.startsWith('=')
      ? host === pattern.slice(1)
      : host === pattern || host.endsWith('.' + pattern))
  );
}

export function normalizeBrowserExtensionPolicy(input: unknown): BrowserExtensionPolicy {
  const p = input as {
    read?: { block?: unknown };
    interact?: { allow?: unknown; block?: unknown };
  } | null;
  if (!p || !p.read || !p.interact)
    throw new Error('Invalid policy. Reload settings before saving.');
  const list = (items: unknown, wildcard = false): string[] => {
    if (!Array.isArray(items) || items.length > 200)
      throw new Error('Each policy list must contain at most 200 domains.');
    return [
      ...new Set(
        items.map((h) => (wildcard && h === '*' ? '*' : normalizeBrowserExtensionHost(h))),
      ),
    ];
  };
  return {
    read: { block: list(p.read.block) },
    interact: { allow: list(p.interact.allow, true), block: list(p.interact.block ?? []) },
  };
}

export function checkBrowserExtensionPolicy(
  policy: BrowserExtensionPolicy,
  action: unknown,
  url: unknown,
): BrowserExtensionPolicyVerdict {
  const deny = (error: string, message: string, host?: string): BrowserExtensionPolicyDenial => ({
    ok: false,
    error,
    message,
    ...(host !== undefined ? { host } : {}),
    execution: 'not_executed',
  });
  if (!isBrowserExtensionReadAction(action) && !isBrowserExtensionInteractAction(action)) {
    return deny('INVALID_ACTION', 'Choose a supported browser action.');
  }
  if (action === 'tabs') return { ok: true };
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    return deny('INVALID_URL', 'Provide a full HTTP or HTTPS URL.');
  }
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    isLocalBrowserHost(u.hostname.replace(/\.$/, ''))
  ) {
    return deny(
      'URL_NOT_ALLOWED',
      'Only public HTTP/HTTPS URLs without embedded credentials are supported.',
    );
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (policy.read.block.some((p) => browserExtensionHostMatches(host, p))) {
    return deny(
      'READ_BLOCKED',
      'This site is on the read block list. Review the site policy in plugin settings.',
      host,
    );
  }
  if (
    isBrowserExtensionInteractAction(action) &&
    (!policy.interact.allow.some((p) => browserExtensionHostMatches(host, p)) ||
      policy.interact.block.some((p) => browserExtensionHostMatches(host, p)))
  ) {
    return deny(
      'INTERACT_NOT_ALLOWED',
      'Ask the user to allow this exact site before clicking, typing or searching.',
      host,
    );
  }
  return { ok: true, host };
}

export interface BrowserExtensionJobPayload {
  url?: string;
  browser?: string;
  limit?: number;
  maxChars?: number;
  waitMs?: number;
  host?: string;
  selector?: string;
  from?: string;
  ref?: string;
  text?: string;
  key?: string;
  waitFor?: string;
  emptySelector?: string;
  after?: string;
  values?: string[];
  fields?: Record<string, string | { selector: string; attr?: string }>;
  multiple?: boolean;
  submit?: boolean;
  [key: string]: unknown;
}

/** 校验一个作业载荷(与扩展侧 validate 同判据);非法时抛出人话错误。 */
export function validateBrowserExtensionJob(
  action: unknown,
  input: unknown = {},
): BrowserExtensionJobPayload {
  if (!isBrowserExtensionReadAction(action) && !isBrowserExtensionInteractAction(action)) {
    throw new Error('Unsupported browser action.');
  }
  const payload = (
    input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  ) as BrowserExtensionJobPayload;
  if (action !== 'tabs' && (typeof payload.url !== 'string' || payload.url.length > 8192)) {
    throw new Error('Provide a full URL of at most 8192 characters.');
  }
  if (
    payload.browser != null &&
    (typeof payload.browser !== 'string' || payload.browser.length > 128)
  ) {
    throw new Error('Invalid browser connection id.');
  }
  if (
    payload.limit != null &&
    (!Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 100)
  ) {
    throw new Error('Limit must be 1–100.');
  }
  if (
    payload.maxChars != null &&
    (!Number.isInteger(payload.maxChars) || payload.maxChars < 256 || payload.maxChars > 30000)
  ) {
    throw new Error('maxChars must be 256–30000.');
  }
  if (
    payload.waitMs != null &&
    (!Number.isInteger(payload.waitMs) || payload.waitMs < 0 || payload.waitMs > 15000)
  ) {
    throw new Error('waitMs must be 0–15000.');
  }
  if (payload.host != null) normalizeBrowserExtensionHost(payload.host);
  for (const key of [
    'selector',
    'from',
    'ref',
    'text',
    'key',
    'waitFor',
    'emptySelector',
    'after',
  ] as const) {
    const value = payload[key];
    if (
      value != null &&
      (typeof value !== 'string' || value.length > (key === 'text' ? 16000 : 2000))
    ) {
      throw new Error('Invalid ' + key + '.');
    }
  }
  if (
    ['click', 'type', 'select', 'hover'].includes(action as string) &&
    !payload.ref &&
    !payload.selector
  ) {
    throw new Error('Provide a fresh snapshot ref or CSS selector.');
  }
  if (action === 'type' && typeof payload.text !== 'string') {
    throw new Error('Typing requires text (an empty string clears the field).');
  }
  if (action === 'press' && !payload.key) throw new Error('Provide the key to press.');
  if (
    action === 'select' &&
    (!Array.isArray(payload.values) ||
      payload.values.length > 100 ||
      payload.values.some((v) => typeof v !== 'string' || v.length > 2000))
  ) {
    throw new Error('Provide an array of option values.');
  }
  if (action === 'extract') {
    const fields = payload.fields;
    if (
      !fields ||
      typeof fields !== 'object' ||
      Array.isArray(fields) ||
      !Object.keys(fields).length ||
      Object.keys(fields).length > 30
    ) {
      throw new Error('Extract requires 1–30 fields.');
    }
    // 与扩展侧同判据:字段名不得含控制字符。
    // eslint-disable-next-line no-control-regex
    if (Object.keys(fields).some((k) => !k || k.length > 32 || /[\x00-\x1f]/.test(k))) {
      throw new Error('Field names must contain 1–32 printable characters.');
    }
    for (const spec of Object.values(fields)) {
      const invalid =
        typeof spec === 'string'
          ? !spec || spec.length > 2000
          : !spec ||
            typeof spec.selector !== 'string' ||
            !spec.selector ||
            spec.selector.length > 2000 ||
            (spec.attr != null &&
              !(BROWSER_EXTENSION_EXTRACT_ATTRIBUTES as readonly string[]).includes(spec.attr));
      if (invalid) {
        throw new Error(
          'Each field needs a CSS selector; attr may only be href, src, datetime, title, alt, aria-label or role.',
        );
      }
    }
    if (payload.after != null && !payload.multiple)
      throw new Error('after requires multiple records.');
  }
  return payload;
}

// ── URL 脱敏(与扩展侧逐字同判据)──────────────────────────────────────────

const CREDENTIAL_WORDS = new Set([
  'code',
  'token',
  'secret',
  'key',
  'apikey',
  'password',
  'passwd',
  'pwd',
  'pass',
  'session',
  'sessionid',
  'sid',
  'state',
  'nonce',
  'auth',
  'authorization',
  'signature',
  'sig',
  'otp',
  'pin',
  'ticket',
  'assertion',
  'saml',
  'sso',
  'reset',
  'invite',
  'verifier',
  'challenge',
  'access',
  'refresh',
  'bearer',
  'unlock',
  'recover',
  'recovery',
  'magic',
  'invitation',
  'activation',
  'verification',
  'credential',
  'credentials',
]);
const CONTEXT_WORDS = new Set([
  'reset',
  'verify',
  'verification',
  'confirm',
  'confirmation',
  'activate',
  'activation',
  'invite',
  'magic',
  'auth',
  'authenticate',
  'authorize',
  'unlock',
  'recover',
  'recovery',
  'password',
  'passcode',
  'signin',
  'signup',
  'login',
  'callback',
  'redirect',
  'token',
]);
const MAX_DECODE_PASSES = 4;
const CREDENTIAL_MIN_LENGTH = 16;

function normalizeEncoding(text: string): string {
  let current = text;
  for (let i = 0; i < MAX_DECODE_PASSES; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) break;
    current = next;
  }
  return current;
}

const words = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const credentialKey = (key: string): boolean => {
  const decoded = normalizeEncoding(key);
  const parts = words(decoded.replace(/([a-z])([0-9])/g, '$1 $2'));
  return parts.length > 0 && parts.some((word) => CREDENTIAL_WORDS.has(word));
};

const opaque = (value: string): boolean =>
  value.length >= 32 && /^[A-Za-z0-9._~+/=-]+$/.test(value);

function redactSegments(path: string): string {
  const segments = path.split('/');
  let context = false;
  let changed = false;
  for (let i = 0; i < segments.length; i++) {
    const decoded = normalizeEncoding(segments[i]);
    const parts = words(decoded);
    if (parts.some((word) => CONTEXT_WORDS.has(word))) {
      context = true;
      const remainder = parts.filter((word) => !CONTEXT_WORDS.has(word)).join('');
      if (remainder.length >= CREDENTIAL_MIN_LENGTH) {
        segments[i] = 'REDACTED';
        changed = true;
      }
      continue;
    }
    if (context && decoded.length >= CREDENTIAL_MIN_LENGTH) {
      segments[i] = 'REDACTED';
      changed = true;
    }
  }
  return changed ? segments.join('/') : path;
}

function sanitizeNested(decoded: string): string {
  if (/^https?:\/\//i.test(decoded)) return redactBrowserUrl(decoded);
  if (decoded.startsWith('/')) return redactSegments(decoded);
  return decoded;
}

/** 交给模型前的最后一道门:页面 URL、标签页 URL、链接与提取字段里的凭证都在这里抹掉。 */
export function redactBrowserUrl<T>(raw: T): T;
export function redactBrowserUrl(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  let changed = false;
  if (u.username || u.password) {
    u.username = '';
    u.password = '';
    changed = true;
  }
  for (const [key, value] of [...u.searchParams]) {
    const decoded = normalizeEncoding(value);
    if (credentialKey(key) || opaque(decoded)) {
      u.searchParams.set(key, 'REDACTED');
      changed = true;
      continue;
    }
    const nested = sanitizeNested(decoded);
    if (nested !== decoded) {
      u.searchParams.set(key, nested);
      changed = true;
    }
  }
  const fragment = u.hash ? u.hash.slice(1) : '';
  if (fragment && normalizeEncoding(fragment).includes('=')) {
    u.hash = '#REDACTED';
    changed = true;
  } else if (fragment) {
    const redacted = redactSegments(fragment);
    if (redacted !== fragment) {
      u.hash = '#' + redacted;
      changed = true;
    }
  }
  const redactedPath = redactSegments(u.pathname);
  if (redactedPath !== u.pathname) {
    u.pathname = redactedPath;
    changed = true;
  }
  return changed ? u.href : raw;
}
