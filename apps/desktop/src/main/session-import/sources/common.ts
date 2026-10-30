/** 各来源适配器共用的小工具。只处理通用形态，来源格式细节留在各自适配器里。 */

import { promises as fsp } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const s = str(value).trim();
    if (s) return s;
  }
  return '';
}

/** ISO 字符串、秒或毫秒时间戳统一成毫秒；无法识别返回 0。 */
export function toMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
  }
  if (typeof value === 'bigint' && value > 0) return toMs(Number(value));
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return toMs(n);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function makeTitle(text: string, fallback: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120) || fallback;
}

/**
 * 整条消息都是工具自动注入的上下文（`<environment_context>…</environment_context>`、
 * `# AGENTS.md instructions` 等），不是用户说的话。
 */
export function isInjectedContextText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^# AGENTS\.md instructions\b/.test(t)) return true;
  const m = t.match(/^<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>/i);
  if (!m) return false;
  return t.endsWith(`</${m[1]}>`);
}

/** 递归列出目录下符合条件的文件（带深度上限与 mtime），读取失败的目录跳过。 */
export async function walkFiles(
  root: string,
  match: (name: string, full: string) => boolean,
  opts: { maxDepth?: number; skipDir?: (name: string) => boolean } = {},
): Promise<Array<{ file: string; mtimeMs: number; size: number }>> {
  const out: Array<{ file: string; mtimeMs: number; size: number }> = [];
  const maxDepth = opts.maxDepth ?? 6;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (opts.skipDir?.(entry.name)) continue;
        await visit(full, depth + 1);
      } else if (entry.isFile() && match(entry.name, full)) {
        const stat = await fsp.stat(full).catch(() => null);
        if (stat) out.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
  };
  await visit(root, 0);
  return out;
}

export async function dirExists(p: string): Promise<boolean> {
  const stat = await fsp.stat(p).catch(() => null);
  return !!stat?.isDirectory();
}

export async function fileExists(p: string): Promise<boolean> {
  const stat = await fsp.stat(p).catch(() => null);
  return !!stat?.isFile();
}

/** 把文本类内容块（text / input_text / output_text）拼成纯文本。 */
export function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (isRecord(block) && typeof block.text === 'string'
      && (!block.type || ['text', 'input_text', 'output_text'].includes(str(block.type)))) {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

/** data:image/...;base64,xxx → { mimeType, base64Data } */
export function parseDataUrl(raw: string): { mimeType: string; base64Data: string } | null {
  const v = raw.trim();
  const comma = v.indexOf(',');
  if (!v.startsWith('data:') || comma < 0) return null;
  const parts = v.slice(5, comma).split(';').map((p) => p.trim().toLowerCase());
  if (!parts.includes('base64') || !parts[0]?.startsWith('image/')) return null;
  return { mimeType: parts[0], base64Data: v.slice(comma + 1) };
}

/** 尝试把 JSON 字符串参数解析成对象，失败保留原字符串。 */
export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  const t = value.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return value;
  try {
    return JSON.parse(t);
  } catch {
    return value;
  }
}

export function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (isRecord(value) && typeof value.content === 'string') return value.content;
  if (isRecord(value) && typeof value.output === 'string') return value.output;
  const text = blocksText(value);
  if (text) return text;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
