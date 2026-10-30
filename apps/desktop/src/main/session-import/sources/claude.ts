/**
 * Claude Code 来源适配器（原生续做）。
 *
 * - 历史：`<CLAUDE_CONFIG_DIR 或 ~/.claude>/projects/<目录转码>/<会话编号>.jsonl`；
 *   子 Agent 与大输出放在同名旁挂目录 `<会话编号>/`（subagents/、tool-results/）；
 * - 识别：以文件名为会话编号（Claude Code 自己按文件名恢复）；
 * - 复制：Cindy 的 Claude Code 也写在同一个 ~/.claude 下，所以副本必须换一个新编号，
 *   旁挂目录一并复制并改写编号，原文件不动；
 * - Cindy 自己的内部复核会话（review channel）只计数。
 */

import { createReadStream, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sanitizeClaudeProjectKey } from '@cindy/maker-core';

import { claudeConfigDir } from '../../remote-agent/controller/projectFiles.js';

import { stripCompleteIdeOpenedFileBlocks } from '../../maker-host/imported-user-content.js';
import { migrationNativeContext } from '../../session-share/migrationNativeContext.js';
import { writeMigratedTranscript } from '../../session-share/migrationTranscriptWriter.js';
import { parseJsonLine, readLines } from '../lineReader.js';
import type {
  NativeMaterialization,
  NormalizedImage,
  NormalizedMessage,
  ReadContext,
  SourceAdapter,
  SourceListResult,
  SourceSession,
  VerifyOutcome,
} from '../types.js';
import { firstNonEmpty, isRecord, makeTitle, num, str, toMs, walkFiles } from './common.js';

const HEAD_MAX_BYTES = 384 * 1024;
const HEAD_MAX_LINES = 400;
const SESSION_ID = /^[0-9a-fA-F-]{20,}$/;

interface ClaudeLocator {
  file: string;
}

/** Claude Code 的 projects 根目录（尊重 CLAUDE_CONFIG_DIR，与 Cindy 运行 Claude Code 时一致）。 */
export function resolveClaudeProjectsRoot(): string {
  return path.join(claudeConfigDir(), 'projects');
}

function sessionIdFromFile(file: string): string {
  return path.basename(file, '.jsonl');
}

function isSyntheticUserText(content: string): boolean {
  const t = content.trimStart();
  return t.startsWith('<local-command-caveat>') || t.startsWith('<command-name>')
    || t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-stderr>')
    || t.startsWith('<task-notification>');
}

export function claudeUserText(content: unknown): string {
  if (typeof content === 'string') {
    const text = stripCompleteIdeOpenedFileBlocks(content);
    return isSyntheticUserText(text) ? '' : text;
  }
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type === 'tool_result') continue;
    if ((block.type === 'text' || block.type === 'input_text') && typeof block.text === 'string') {
      parts.push(stripCompleteIdeOpenedFileBlocks(block.text));
    }
  }
  return parts.join('\n\n');
}

/** Cindy 自己的本地复核会话（review channel），不是用户的任务。 */
function isInternalReviewText(text: string): boolean {
  const tag = text.trimStart().match(/^<channel\b[^>]*>/i)?.[0];
  if (!tag) return false;
  for (const m of tag.matchAll(/\bsource\s*=\s*(["'])([^"']+)\1/gi)) {
    const source = m[2]?.trim().toLowerCase();
    if (source === 'review-session-channel' || source === 'local-review') return true;
  }
  return false;
}

function xmlTag(content: string, tag: string): string {
  const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m?.[1]?.trim() ?? '';
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => isRecord(b) && (b.type === 'text' || b.type === 'output_text') && typeof b.text === 'string')
    .map((b) => (b as { text: string }).text)
    .join('\n');
}

function toolResults(content: unknown): Array<{ toolUseId: string; text: string }> {
  if (typeof content === 'string') {
    const t = content.trim();
    if (!t.startsWith('<task-notification>')) return [];
    const id = xmlTag(t, 'tool-use-id');
    return id ? [{ toolUseId: id, text: xmlTag(t, 'result') || xmlTag(t, 'summary') || t }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: Array<{ toolUseId: string; text: string }> = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_result') continue;
    const id = str(block.tool_use_id);
    const text = toolResultText(block.content);
    if (id && text) out.push({ toolUseId: id, text });
  }
  return out;
}

function userImages(content: unknown): NormalizedImage[] {
  if (!Array.isArray(content)) return [];
  const out: NormalizedImage[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'image' || !isRecord(block.source)) continue;
    if (str(block.source.type) !== 'base64') continue;
    const mimeType = firstNonEmpty(block.source.media_type, block.source.mime_type, block.source.mediaType, block.source.mimeType);
    const base64Data = str(block.source.data);
    if (mimeType && base64Data) out.push({ mimeType, base64Data });
  }
  return out;
}

function recordMeta(obj: Record<string, unknown>, fallbackSessionId: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const isAssistant = str(obj.type) === 'assistant';
  const sourceToolAssistantUuid = str(obj.sourceToolAssistantUUID);
  // transcript 父链与工具/子 Agent 归属是两张不同的图，分开记录（与 live 落库同口径）。
  const transcriptParentUuid = firstNonEmpty(
    obj.parentUuid, obj.parent_uuid, obj.logicalParentUuid, obj.logical_parent_uuid,
    !isAssistant ? sourceToolAssistantUuid : '',
  );
  const parentUuid = firstNonEmpty(
    obj.parent_tool_use_id, obj.parentToolUseId, obj.parentToolUseID,
    isAssistant ? sourceToolAssistantUuid : '',
  );
  const uuid = str(obj.uuid);
  if (uuid) meta.uuid = uuid;
  if (transcriptParentUuid) meta.transcriptParentUuid = transcriptParentUuid;
  if (parentUuid) meta.parentUuid = parentUuid;
  meta.sdkSessionId = firstNonEmpty(obj.sessionId, obj.session_id, fallbackSessionId);
  return meta;
}

function assistantMeta(obj: Record<string, unknown>, fallbackSessionId: string): Record<string, unknown> {
  const meta = recordMeta(obj, fallbackSessionId);
  const message = isRecord(obj.message) ? obj.message : {};
  const model = str(message.model);
  if (model) meta.model = model;
  const stopReason = firstNonEmpty(message.stop_reason, message.stopReason);
  if (stopReason) meta.stopReason = stopReason;
  const requestId = str(message.id);
  if (requestId) meta.requestId = requestId;
  if (isRecord(message.usage)) {
    const u = message.usage;
    meta.usage = {
      inputTokens: num(u.input_tokens) || undefined,
      outputTokens: num(u.output_tokens) || undefined,
      cacheReadInputTokens: num(u.cache_read_input_tokens) || undefined,
      cacheCreationInputTokens: num(u.cache_creation_input_tokens) || undefined,
    };
  }
  return meta;
}

/** 一行 Claude Code 记录 → Cindy 消息。行键 `<行号>-<序号>` 与旧导入（claude-import:）一致。 */
export function parseClaudeLine(obj: Record<string, unknown>, lineNo: number, sdkSessionId: string): NormalizedMessage[] {
  if (obj.isSidechain === true) return [];
  const type = str(obj.type);
  if ((type !== 'user' && type !== 'assistant') || !isRecord(obj.message)) return [];
  const createdAt = toMs(obj.timestamp) || Date.now();
  const content = obj.message.content;
  const out: NormalizedMessage[] = [];
  let part = 0;
  if (type === 'user') {
    const meta = recordMeta(obj, sdkSessionId);
    for (const r of toolResults(content)) {
      out.push({ key: `${lineNo}-${part++}`, role: 'tool_result', content: r.text, toolUseId: r.toolUseId, agentMeta: meta, createdAt });
    }
    const text = claudeUserText(content).trim();
    const images = userImages(content);
    if (text || images.length) {
      out.push({ key: `${lineNo}-${part++}`, role: 'user', content: text, images: images.length ? images : undefined, agentMeta: meta, createdAt });
    }
    return out;
  }
  if (!Array.isArray(content)) return [];
  const meta = assistantMeta(obj, sdkSessionId);
  for (const block of content) {
    if (!isRecord(block)) continue;
    const bt = str(block.type);
    if (bt === 'text' && typeof block.text === 'string' && block.text) {
      out.push({ key: `${lineNo}-${part++}`, role: 'assistant', content: block.text, agentMeta: meta, createdAt });
    } else if (bt === 'tool_use') {
      const toolUseId = str(block.id);
      out.push({
        key: `${lineNo}-${part++}`,
        role: 'tool_use',
        content: { toolUseId, toolName: str(block.name), input: block.input ?? null },
        toolUseId: toolUseId || null,
        agentMeta: meta,
        createdAt,
      });
    } else if (bt === 'thinking' && typeof block.thinking === 'string') {
      out.push({ key: `${lineNo}-${part++}`, role: 'thinking', content: { text: block.thinking, durationMs: 0, isRedacted: false }, agentMeta: meta, createdAt });
    } else if (bt === 'redacted_thinking') {
      out.push({ key: `${lineNo}-${part++}`, role: 'thinking', content: { text: '', durationMs: 0, isRedacted: true }, agentMeta: meta, createdAt });
    }
  }
  return out;
}

/** 头部有界读取：标题、工作目录；内部复核会话返回 internal。 */
async function headSummary(file: string): Promise<{ title: string; cwd: string; internal: boolean; ok: boolean }> {
  let title = '';
  let cwd = '';
  let saw = false;
  let lines = 0;
  for await (const line of readLines(file, { maxBytes: HEAD_MAX_BYTES })) {
    lines += 1;
    if (lines > HEAD_MAX_LINES && title) break;
    const obj = parseJsonLine(line);
    if (!obj || obj.isSidechain === true) continue;
    const lineCwd = str(obj.cwd);
    if (lineCwd) cwd = lineCwd;
    const type = str(obj.type);
    if (type !== 'user' && type !== 'assistant') continue;
    saw = true;
    if (type === 'user' && !title && isRecord(obj.message)) {
      const text = claudeUserText(obj.message.content).trim();
      if (text && isInternalReviewText(text)) return { title: '', cwd, internal: true, ok: true };
      if (text) title = makeTitle(text, '');
    }
    if (title && cwd) break;
  }
  return { title, cwd, internal: false, ok: saw };
}

async function list(): Promise<SourceListResult> {
  const root = resolveClaudeProjectsRoot();
  const files = await walkFiles(root, (name) => name.endsWith('.jsonl'), {
    maxDepth: 1,
    skipDir: (name) => name === 'subagents' || name === 'tool-results',
  });
  const sessions: SourceSession[] = [];
  let internalCount = 0;
  let unreadableCount = 0;
  for (const f of files) {
    const id = sessionIdFromFile(f.file);
    if (!SESSION_ID.test(id) || f.size === 0) continue;
    const head = await headSummary(f.file).catch(() => null);
    if (!head) { unreadableCount += 1; continue; }
    if (head.internal) { internalCount += 1; continue; }
    if (!head.ok) continue;
    const birth = (await fsp.stat(f.file).catch(() => null))?.birthtimeMs ?? f.mtimeMs;
    sessions.push({
      source: 'claude',
      sourceSessionId: id,
      title: head.title || 'Claude Code',
      cwd: head.cwd || null,
      createdAt: Math.floor(Math.min(birth, f.mtimeMs)),
      updatedAt: Math.floor(f.mtimeMs),
      archived: false,
      sizeBytes: f.size + (await sidecarSize(f.file)),
      locator: JSON.stringify({ file: f.file } satisfies ClaudeLocator),
    });
  }
  return { sessions, internalCount, unreadableCount };
}

async function sidecarSize(file: string): Promise<number> {
  const dir = path.join(path.dirname(file), sessionIdFromFile(file));
  const files = await walkFiles(dir, () => true, { maxDepth: 3 });
  return files.reduce((a, f) => a + f.size, 0);
}

async function* read(session: SourceSession, ctx: ReadContext): AsyncIterable<NormalizedMessage> {
  const { file } = JSON.parse(session.locator) as ClaudeLocator;
  let lineNo = 0;
  for await (const line of readLines(file, { signal: ctx.signal, onBytes: ctx.onBytes })) {
    lineNo += 1;
    const obj = parseJsonLine(line);
    if (!obj) continue;
    // 原生副本换了新编号：消息元数据里的会话编号同步改成新编号，与副本一致。
    if (ctx.nativeSessionId && str(obj.sessionId) === session.sourceSessionId) obj.sessionId = ctx.nativeSessionId;
    yield* parseClaudeLine(obj, lineNo, ctx.nativeSessionId ?? session.sourceSessionId);
  }
}

/** 导入副本的新编号：同一来源任务重复导入（中断重试）得到同一个编号。 */
export function claudeImportedSessionId(sourceSessionId: string): string {
  return migrationNativeContext(`session-import:claude:${sourceSessionId}`, [sourceSessionId]).id(sourceSessionId);
}

async function materialize(session: SourceSession): Promise<NativeMaterialization> {
  const { file } = JSON.parse(session.locator) as ClaudeLocator;
  const oldId = session.sourceSessionId;
  const context = migrationNativeContext(`session-import:claude:${oldId}`, [oldId]);
  const newId = context.id(oldId);
  const cwd = session.cwd || os.homedir();
  const targetDir = path.join(resolveClaudeProjectsRoot(), sanitizeClaudeProjectKey(cwd));
  const target = path.join(targetDir, `${newId}.jsonl`);
  await writeMigratedTranscript(createReadStream(file), target, { context, agent: 'cc' });
  // 旁挂目录：子 Agent 记录同样改写编号，其它文件原样复制。
  const sidecar = path.join(path.dirname(file), oldId);
  for (const f of await walkFiles(sidecar, () => true, { maxDepth: 3 })) {
    const rel = path.relative(sidecar, f.file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const dest = path.join(targetDir, newId, rel);
    await writeMigratedTranscript(
      createReadStream(f.file),
      dest,
      f.file.endsWith('.jsonl') ? { context, agent: 'cc' } : null,
    );
  }
  return { sdkSessionId: newId };
}

async function verify(m: NativeMaterialization, session: SourceSession): Promise<VerifyOutcome> {
  const cwd = session.cwd || os.homedir();
  const target = path.join(resolveClaudeProjectsRoot(), sanitizeClaudeProjectKey(cwd), `${m.sdkSessionId}.jsonl`);
  let sawOwnRecord = false;
  try {
    for await (const line of readLines(target, { maxBytes: HEAD_MAX_BYTES })) {
      const obj = parseJsonLine(line);
      if (!obj) continue;
      const type = str(obj.type);
      if ((type === 'user' || type === 'assistant') && str(obj.sessionId) === m.sdkSessionId) {
        sawOwnRecord = true;
        break;
      }
    }
  } catch (err) {
    return { ok: false, reason: 'native-unloadable', detail: err instanceof Error ? err.message : String(err) };
  }
  return sawOwnRecord ? { ok: true } : { ok: false, reason: 'native-unloadable', detail: 'copied transcript has no records for the new session id' };
}

export const claudeAdapter: SourceAdapter = {
  id: 'claude',
  label: 'Claude Code',
  native: 'cc',
  list,
  read,
  materialize,
  verify,
};
