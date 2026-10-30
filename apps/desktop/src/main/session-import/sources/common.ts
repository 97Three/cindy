/** 各来源适配器共用的小工具。只处理通用形态，来源格式细节留在各自适配器里。 */

import { constants as fsConstants, promises as fsp, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { NormalizedMessage } from '../types.js';

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

/** 同步判断目录是否存在（给 decodeDashedPath 逐段试探用）。 */
export function dirExistsSync(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
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

/**
 * 把「路径分隔符被替换成 -」的目录名还原成磁盘上真实存在的路径（Cursor、Qwen 等用这种转码）。
 * `-` 在原路径里也可能出现，所以逐段试探：每一段要么开始新目录，要么与上一段用 `-` 连起来，
 * 只沿着磁盘上存在的前缀继续。找不到返回 null。
 */
export function decodeDashedPath(name: string, exists: (p: string) => boolean): string | null {
  const tokens = name.replace(/^-+/, '').split('-').filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const leading = process.platform === 'win32' && /^[A-Za-z]$/.test(tokens[0]!) ? `${tokens.shift()}:` : '';
  let best: string | null = null;
  let budget = 4000;
  const walk = (i: number, current: string, segment: string): void => {
    if (best || budget-- <= 0) return;
    if (i === tokens.length) {
      const full = `${current}/${segment}`;
      if (exists(full)) best = full;
      return;
    }
    const token = tokens[i]!;
    // 先试与当前段相连（目录名里本来就有 -），再试开新段。
    walk(i + 1, current, `${segment}-${token}`);
    const closed = `${current}/${segment}`;
    if (exists(closed)) walk(i + 1, closed, token);
  };
  walk(1, leading, tokens[0]!);
  return best;
}

/** 环境变量里的目录（展开开头的 ~）；未设置返回 null。 */
export function envDir(name: string, homeDir: string): string | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  return path.resolve(raw.replace(/^~(?=$|[\\/])/, homeDir));
}

/**
 * 其他工具的 SQLite 库：先拷一份快照再打开（APFS 上是写时复制，几乎不占时间与空间），
 * 原库与它的 -wal / -shm 一个字节都不动，也不和正在运行的工具抢锁。用完调用 dispose。
 */
export async function snapshotSqlite(dbPath: string): Promise<{ file: string; dispose: () => Promise<void> } | null> {
  if (!(await fileExists(dbPath))) return null;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-import-'));
  const file = path.join(dir, path.basename(dbPath));
  const dispose = async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      await fsp.copyFile(`${dbPath}${suffix}`, `${file}${suffix}`, fsConstants.COPYFILE_FICLONE).catch((err: NodeJS.ErrnoException) => {
        if (suffix === '' || err.code !== 'ENOENT') throw err;
      });
    }
    return { file, dispose };
  } catch (err) {
    await dispose();
    throw err;
  }
}

export interface ImageLike {
  mimeType: string;
  base64Data?: string;
}

/**
 * Anthropic 风格的内容块（text / thinking / tool_use / tool_result / image）→ 统一消息。
 * Factory 等「与 Claude Code 相似」的来源共用；Claude Code 自己的解析仍在 claude.ts。
 */
export function anthropicBlocks(
  role: 'user' | 'assistant',
  content: unknown,
  key: string,
  createdAt: number,
): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  let part = 0;
  if (typeof content === 'string') {
    if (content.trim() && !(role === 'user' && isInjectedContextText(content))) {
      out.push({ key: `${key}-${part++}`, role, content, createdAt });
    }
    return out;
  }
  if (!Array.isArray(content)) return out;
  const texts: string[] = [];
  const images: ImageLike[] = [];
  const flushText = () => {
    const text = texts.join('\n\n').trim();
    texts.length = 0;
    if (!text && images.length === 0) return;
    if (role === 'user' && isInjectedContextText(text) && images.length === 0) return;
    out.push({ key: `${key}-${part++}`, role, content: text, ...(role === 'user' && images.length ? { images: images.splice(0) } : {}), createdAt });
  };
  for (const block of content) {
    if (typeof block === 'string') {
      texts.push(block);
      continue;
    }
    if (!isRecord(block)) continue;
    const type = str(block.type);
    if ((type === 'text' || type === 'input_text' || type === 'output_text') && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (type === 'image' && role === 'user') {
      const source = isRecord(block.source) ? block.source : null;
      const data = source ? str(source.data) : '';
      const mimeType = source ? firstNonEmpty(source.media_type, source.mediaType, source.mime_type) : '';
      if (data && mimeType) images.push({ mimeType, base64Data: data });
    } else if (type === 'thinking' || type === 'reasoning') {
      flushText();
      const text = firstNonEmpty(block.thinking, block.text);
      if (text) out.push({ key: `${key}-${part++}`, role: 'thinking', content: { text, durationMs: 0, isRedacted: false }, createdAt });
    } else if (type === 'tool_use' && role === 'assistant') {
      flushText();
      const toolUseId = str(block.id) || `${key}-${part}`;
      out.push({
        key: `${key}-${part++}`,
        role: 'tool_use',
        content: { toolUseId, toolName: str(block.name) || 'tool', input: parseMaybeJson(block.input ?? block.arguments) },
        toolUseId,
        createdAt,
      });
    } else if (type === 'tool_result') {
      flushText();
      const toolUseId = firstNonEmpty(block.tool_use_id, block.toolUseId, block.id);
      const text = stringifyOutput(block.content ?? block.output);
      if (toolUseId) out.push({ key: `${key}-${part++}`, role: 'tool_result', content: text, toolUseId, createdAt });
    }
  }
  flushText();
  return out;
}

/**
 * Google genai 风格的 parts（Gemini CLI、Qwen Code）：text / thought / functionCall /
 * functionResponse / inlineData。
 */
export function genaiParts(
  role: 'user' | 'assistant',
  parts: unknown,
  key: string,
  createdAt: number,
): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  if (typeof parts === 'string') return parts.trim() ? [{ key: `${key}-0`, role, content: parts, createdAt }] : out;
  const list = Array.isArray(parts) ? parts : isRecord(parts) ? [parts] : [];
  let part = 0;
  const texts: string[] = [];
  const images: ImageLike[] = [];
  const flushText = () => {
    const text = texts.join('').trim();
    texts.length = 0;
    if (!text && images.length === 0) return;
    out.push({ key: `${key}-${part++}`, role, content: text, ...(role === 'user' && images.length ? { images: images.splice(0) } : {}), createdAt });
  };
  for (const p of list) {
    if (typeof p === 'string') {
      texts.push(p);
      continue;
    }
    if (!isRecord(p)) continue;
    if (typeof p.text === 'string' && p.thought === true) {
      flushText();
      if (p.text.trim()) out.push({ key: `${key}-${part++}`, role: 'thinking', content: { text: p.text, durationMs: 0, isRedacted: false }, createdAt });
    } else if (typeof p.text === 'string') {
      texts.push(p.text);
    } else if (isRecord(p.inlineData) && role === 'user') {
      const mimeType = str(p.inlineData.mimeType);
      const data = str(p.inlineData.data);
      if (mimeType.startsWith('image/') && data) images.push({ mimeType, base64Data: data });
    } else if (isRecord(p.functionCall)) {
      flushText();
      const toolUseId = str(p.functionCall.id) || `${key}-${part}`;
      out.push({
        key: `${key}-${part++}`,
        role: 'tool_use',
        content: { toolUseId, toolName: str(p.functionCall.name) || 'tool', input: p.functionCall.args ?? null },
        toolUseId,
        createdAt,
      });
    } else if (isRecord(p.functionResponse)) {
      flushText();
      const toolUseId = str(p.functionResponse.id);
      const response = p.functionResponse.response;
      const text = isRecord(response) && 'output' in response ? stringifyOutput(response.output)
        : isRecord(response) && 'error' in response ? stringifyOutput(response.error) : stringifyOutput(response);
      if (toolUseId) out.push({ key: `${key}-${part++}`, role: 'tool_result', content: text, toolUseId, createdAt });
    }
  }
  flushText();
  return out;
}
