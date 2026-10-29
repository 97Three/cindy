import { validateCspDomains } from './appCsp.js';
/** First release with plugin pages; authoring floor, never a client install gate. */
export const PLUGIN_UI_MIN_CINDY_VERSION = '0.1.121-beta';
export interface GhostUiPage {
  html: string;
  csp?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[]; baseUriDomains?: string[] };
  prefersBorder?: boolean;
}
export interface GhostUiTool { page?: string; visibility?: ('model' | 'app')[] }
export interface GhostUiNeeds { pages: Record<string, GhostUiPage>; tools: Record<string, GhostUiTool> }
type UiManifest = { ui?: GhostUiNeeds; tools?: { name: string }[]; network?: { hosts: string[] } };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const safeKey = (key: string) => /^[a-z][a-z0-9_-]{0,63}$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key);
const cspKeys = ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const;
/** New hosts recognize ui; old hosts preserve the complete top-level declaration without authority. */
export function parseGhostUi(raw: unknown, tools: readonly { name: string }[], hosts: readonly string[], safePath: (value: unknown) => boolean): GhostUiNeeds | null {
  if (!object(raw) || !object(raw.pages) || !object(raw.tools) || !Object.keys(raw.tools).length ||
      Object.keys(raw.pages).length > 16 || Object.keys(raw.tools).length > 16) return null;
  for (const [id, page] of Object.entries(raw.pages)) {
    if (!safeKey(id) || !object(page) || !safePath(page.html) || typeof page.html !== 'string' || !/\.html?$/i.test(page.html) ||
        (page.prefersBorder !== undefined && typeof page.prefersBorder !== 'boolean')) return null;
    if (page.csp !== undefined) {
      if (!object(page.csp)) return null;
      for (const key of cspKeys) {
        const domains = page.csp[key];
        if (domains !== undefined && (!Array.isArray(domains) || domains.some(value => typeof value !== 'string'))) return null;
        try {
          const origins = validateCspDomains(page.csp[key] as string[] | undefined);
          for (const origin of origins) {
            const hostname = new URL(origin.replace(/:\*(\/?)$/, ':443$1')).hostname.toLowerCase();
            if (!hosts.some(pattern => hostname === pattern || (pattern.startsWith('*.') && hostname.endsWith(pattern.slice(1)) && hostname.length > pattern.length - 1))) return null;
          }
        } catch { return null; }
      }
    }
  }
  const names = new Set(tools.map(tool => tool.name));
  for (const [name, link] of Object.entries(raw.tools)) {
    if (!safeKey(name) || !names.has(name) || !object(link) ||
        (link.page !== undefined && (typeof link.page !== 'string' || !Object.hasOwn(raw.pages, link.page))) ||
        (link.visibility !== undefined && (!Array.isArray(link.visibility) || !link.visibility.length || link.visibility.some(v => v !== 'model' && v !== 'app')))) return null;
  }
  return raw as unknown as GhostUiNeeds;
}
function declaredUi(manifest: UiManifest): GhostUiNeeds | undefined {
  // Historical receipts retain unknown v3 fields; malformed declarations grant nothing.
  return parseGhostUi(manifest.ui, manifest.tools ?? [], manifest.network?.hosts ?? [], value => typeof value === 'string') ?? undefined;
}
export function pluginHasToolUi(manifest: UiManifest): boolean { return !!declaredUi(manifest); }
export function pluginToolVisible(manifest: UiManifest, name: string, audience: 'model' | 'app'): boolean {
  const link = declaredUi(manifest)?.tools[name];
  return link ? !link.visibility || link.visibility.includes(audience) : audience === 'model';
}
export function pluginUiDomains(manifest: UiManifest): string[] {
  return [...new Set(Object.values(declaredUi(manifest)?.pages ?? {}).flatMap(page => cspKeys.flatMap(key => page.csp?.[key] ?? [])))];
}
export function pluginUiPermissionsExpand(previous: UiManifest, next: UiManifest): boolean {
  const previousUi = declaredUi(previous), nextUi = declaredUi(next);
  for (const [id, page] of Object.entries(nextUi?.pages ?? {})) {
    const before = previousUi?.pages[id];
    if (!before || before.html !== page.html || cspKeys.some(key => page.csp?.[key]?.some(domain => !before.csp?.[key]?.includes(domain)))) return true;
  }
  return Object.keys(nextUi?.tools ?? {}).some(name => pluginToolVisible(next, name, 'app') && !pluginToolVisible(previous, name, 'app'));
}
