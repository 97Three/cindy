/**
 * 导入执行：可中断、可续、可重复。
 *
 * - 每次导入一个请求编号；逐条进度写进账号私有目录的回执，退出或崩溃后下次打开导入页时续上；
 * - 同时最多导入 2 条；单条失败不影响其它条；
 * - 每条分步：建隐藏任务 → 复制原生资料（原生续做）→ 写消息 → 验证能接着做 → 显示任务；
 * - 「可以继续」以实际加载结果为准：原生副本加载失败就退回交接方式，同样能继续；
 * - 读取失败才算没导入成功：删除这次建的隐藏任务，不留半截任务。
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow } from 'electron';

import { activeOwnerScopeKey, getActiveDataOwnerPushStamp, ownerScopedUserDataPath } from '../appSessionState.js';
import { recordPrRefsForImportedMessages } from '../git-context/prRefsStore.js';
import { getDbClient } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import { resolveNewTaskDefaultModelRoute } from '../maker-host/model-route-guard-live.js';
import { getRemoteNewMakerDefaults, getSelectedNewMakerRoute } from '../maker-host/newMakerDefaultsCache.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { SESSION_IMPORT_PROGRESS_CHANNEL } from '../../shared/sessionImport.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import { buildImportHandoffMarker } from './handoff.js';
import { invalidateImportScan, resolveSourceSessions } from './scan.js';
import { adapterFor } from './sources/index.js';
import type {
  ImportItemIssue,
  ImportItemView,
  ImportJobView,
  NativeHarness,
  NativeMaterialization,
  SourceSession,
} from './types.js';
import { createMessageSink, runImportTx, writeImportCards } from './writer.js';

const log = createLogger('session-import');
const CONCURRENCY = 2;
const PROGRESS_THROTTLE_MS = 150;

class ImportEmptyError extends Error {
  constructor() {
    super('source produced no messages');
  }
}

interface Job {
  view: ImportJobView;
  owner: string;
  keys: string[];
  controller: AbortController;
  lastEmit: number;
  emitTimer: NodeJS.Timeout | null;
}

const jobs = new Map<string, Job>();
const recoveredOwners = new Set<string>();

function receiptDir(): string {
  return ownerScopedUserDataPath('session-imports');
}

function persist(job: Job): void {
  try {
    fs.mkdirSync(receiptDir(), { recursive: true });
    atomicWriteFileSync(path.join(receiptDir(), `${job.view.requestId}.json`), JSON.stringify({ keys: job.keys, view: job.view }));
  } catch (err) {
    log.warn('session import receipt write failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

function emit(job: Job, force = false): void {
  const now = Date.now();
  const send = () => {
    job.lastEmit = Date.now();
    job.emitTimer = null;
    const stamp = getActiveDataOwnerPushStamp();
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        if (stamp === undefined) win.webContents.send(SESSION_IMPORT_PROGRESS_CHANNEL, job.view);
        else win.webContents.send(SESSION_IMPORT_PROGRESS_CHANNEL, job.view, stamp);
      } catch { /* window going away */ }
    }
    for (const listener of progressListeners) listener(job.view);
  };
  if (force || now - job.lastEmit >= PROGRESS_THROTTLE_MS) {
    if (job.emitTimer) clearTimeout(job.emitTimer);
    send();
  } else if (!job.emitTimer) {
    job.emitTimer = setTimeout(send, PROGRESS_THROTTLE_MS - (now - job.lastEmit));
  }
}

const progressListeners = new Set<(view: ImportJobView) => void>();
/** 远程（手机）等其它入口订阅进度。 */
export function onImportProgress(listener: (view: ImportJobView) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

/** 同一来源任务得到同一个 Cindy 任务 id（中断重试据此续上）。 */
export function importSessionId(source: string, sourceSessionId: string): string {
  const hex = createHash('sha256').update(`${source}\0${sourceSessionId}`).digest('hex').slice(0, 24);
  return `imp-${source}-${hex}`;
}

async function pickSessionId(source: string, sourceSessionId: string): Promise<string> {
  const base = importSessionId(source, sourceSessionId);
  const row = await getDbClient().queryOne<{ status: string; hiddenAt: number | null }>(
    'SELECT status, hidden_at AS hiddenAt FROM sessions WHERE id = ?',
    [base],
  );
  // 之前导入的任务已被用户删除：用新 id 重新导入，不复活被删的那条。
  if (row && row.status === 'deleted' && row.hiddenAt === null) return `${base}-${Date.now().toString(36)}`;
  return base;
}

/** 目标引擎与模型：原生来源用同名引擎，其它来源用新任务默认引擎；模型按新建任务口径解析。 */
async function resolveRoute(native: NativeHarness | undefined): Promise<{
  agentKind: NativeHarness; model: string; providerId: string | null; effort: string; permissionMode: string;
}> {
  const selected = getSelectedNewMakerRoute(activeOwnerScopeKey());
  const selectedKind: NativeHarness | null = selected
    ? selected.harness === 'claude' ? 'cc' : selected.harness === 'codex' ? 'codex' : selected.harness === 'pi' ? 'pi' : null
    : null;
  const agentKind: NativeHarness = native ?? selectedKind ?? 'cc';
  const agent = agentKind === 'cc' ? 'claude-code' : agentKind;
  const draft = getRemoteNewMakerDefaults(agent);
  if (selected && selectedKind === agentKind && selected.model) {
    return {
      agentKind,
      model: selected.model,
      providerId: selected.providerId ?? null,
      effort: selected.effort ?? draft.effort ?? 'high',
      permissionMode: draft.permissionMode ?? 'auto',
    };
  }
  const route = await resolveNewTaskDefaultModelRoute(agent).catch(() => null);
  return {
    agentKind,
    model: draft.model ?? route?.model ?? '',
    providerId: draft.model ? (draft.providerId ?? null) : (route?.providerId ?? null),
    effort: draft.effort ?? 'high',
    permissionMode: draft.permissionMode ?? 'auto',
  };
}

function itemView(job: Job, key: string): ImportItemView {
  const item = job.view.items.find((i) => i.key === key);
  if (!item) throw new Error(`unknown import item ${key}`);
  return item;
}

async function dirExists(dir: string | null): Promise<boolean> {
  if (!dir) return false;
  const stat = await fsp.stat(dir).catch(() => null);
  return !!stat?.isDirectory();
}

async function importOne(job: Job, key: string, source: SourceSession): Promise<void> {
  const item = itemView(job, key);
  const adapter = adapterFor(source.source);
  if (!adapter) {
    Object.assign(item, { status: 'failed', issue: 'read-failed' });
    return;
  }
  if (source.unsupportedVersion) {
    Object.assign(item, { status: 'failed', issue: 'unsupported-version' });
    return;
  }
  const signal = job.controller.signal;
  item.status = 'running';
  emit(job);
  const sessionId = await pickSessionId(source.source, source.sourceSessionId);
  const route = await resolveRoute(adapter.native);
  const cwd = normalizeWorkingDirForStorage(source.cwd) ?? source.cwd;
  const now = Date.now();
  item.sessionId = sessionId;
  item.harness = route.agentKind;
  try {
    await runImportTx({
      action: 'begin',
      now,
      session: {
        id: sessionId,
        title: source.title,
        workingDir: cwd,
        workspaceKind: source.dialogue ? 'dialogue' : 'project',
        model: route.model || 'default',
        providerId: route.providerId,
        effort: route.effort,
        permissionMode: route.permissionMode,
        status: source.archived ? 'archived' : 'active',
        tokensUsed: 0,
        userSendAt: source.updatedAt,
        agentKind: route.agentKind,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      },
      record: {
        source: source.source,
        sourceSessionId: source.sourceSessionId,
        fingerprint: `${source.sizeBytes}:${source.updatedAt}`,
        version: source.unsupportedVersion ?? null,
        mode: adapter.native ? 'native' : 'handoff',
        originalCwd: source.cwd,
        requestId: job.view.requestId,
      },
    });

    let materialized: NativeMaterialization | null = null;
    if (adapter.native && adapter.materialize) {
      item.step = 'copy';
      emit(job);
      materialized = await adapter.materialize(source, { cindySessionId: sessionId, signal });
    }

    item.step = 'messages';
    emit(job);
    const sink = createMessageSink({
      sessionId,
      agentKind: adapter.native ? route.agentKind : null,
      startAt: source.createdAt || source.updatedAt || now,
      onWritten: (count) => {
        item.messagesWritten = count;
        emit(job);
      },
    });
    for await (const message of adapter.read(source, { cindySessionId: sessionId, nativeSessionId: materialized?.sdkSessionId, signal })) {
      if (signal.aborted) throw new Error('cancelled');
      await sink.push(message);
    }
    await sink.flush();
    item.messagesWritten = sink.written;
    // 一条都没读到：要么来源格式变了，要么原记录本来是空的。不留一个点开什么都没有的任务。
    if (sink.written === 0) throw new ImportEmptyError();
    void recordPrRefsForImportedMessages(sessionId, sink.prCandidates).catch(() => undefined);

    item.step = 'verify';
    emit(job);
    let mode: 'native' | 'handoff' = 'handoff';
    let marker: Awaited<ReturnType<typeof buildImportHandoffMarker>> | undefined;
    let sdkSessionId: string | null = null;
    let nativeIssue: ImportItemIssue | null = null;
    if (materialized && adapter.verify) {
      const outcome = await adapter.verify(materialized, source).catch((err) => ({
        ok: false as const,
        reason: 'native-unloadable' as const,
        detail: err instanceof Error ? err.message : String(err),
      }));
      if (outcome.ok) {
        mode = 'native';
        sdkSessionId = materialized.sdkSessionId;
      } else {
        nativeIssue = 'native-unloadable';
        log.warn('native copy failed verification, falling back to handoff', { key, detail: outcome.detail });
      }
    }
    await writeImportCards({
      sessionId,
      agentKind: adapter.native ? route.agentKind : null,
      firstCreatedAt: sink.firstCreatedAt,
      lastCreatedAt: sink.lastCreatedAt,
      meta: {
        source: source.source,
        sourceLabel: adapter.label,
        importedAt: now,
        originalCwd: source.cwd,
        mode,
        harness: route.agentKind,
      },
    });
    if (mode === 'handoff') {
      marker = await buildImportHandoffMarker({ sessionId, fromLabel: adapter.label, toHarness: route.agentKind });
    }
    const missingDir = !source.dialogue && !!source.cwd && !(await dirExists(source.cwd));
    await runImportTx({
      action: 'commit',
      sessionId,
      now: Date.now(),
      status: missingDir ? 'action' : 'ready',
      mode,
      issue: missingDir ? 'missing-dir' : nativeIssue,
      unhide: true,
      sessionPatch: { sdkSessionId },
      ...(marker ? { marker } : {}),
    });
    Object.assign(item, {
      status: missingDir ? 'action' : 'ready',
      step: null,
      mode,
      issue: missingDir ? 'missing-dir' : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cancelled = signal.aborted;
    log.warn('session import item failed', { key, cancelled, error: message });
    await runImportTx({ action: 'abort', sessionId }).catch(() => undefined);
    Object.assign(item, {
      status: cancelled ? 'cancelled' : 'failed',
      step: null,
      sessionId: null,
      issue: cancelled ? null : err instanceof ImportEmptyError ? 'empty' : (/ENOSPC/.test(message) ? 'disk-full' : 'read-failed'),
    });
  } finally {
    emit(job, true);
    persist(job);
  }
}

async function runJob(job: Job): Promise<void> {
  const sources = await resolveSourceSessions(job.keys).catch(() => new Map<string, SourceSession>());
  const queue = job.keys.filter((k) => {
    const item = itemView(job, k);
    if (item.status !== 'queued' && item.status !== 'running') return false;
    if (!sources.has(k)) {
      Object.assign(item, { status: 'failed', issue: 'not-found' });
      return false;
    }
    return true;
  });
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let key = queue.shift(); key; key = queue.shift()) {
      if (job.controller.signal.aborted) {
        Object.assign(itemView(job, key), { status: 'cancelled' });
        continue;
      }
      await importOne(job, key, sources.get(key)!);
    }
  });
  await Promise.all(workers);
  job.view.status = job.controller.signal.aborted ? 'cancelled' : 'done';
  job.view.finishedAt = Date.now();
  invalidateImportScan();
  persist(job);
  emit(job, true);
  log.info('session import job finished', {
    requestId: job.view.requestId,
    items: job.view.items.length,
    ready: job.view.items.filter((i) => i.status === 'ready').length,
    action: job.view.items.filter((i) => i.status === 'action').length,
    failed: job.view.items.filter((i) => i.status === 'failed').length,
  });
}

/** 开始导入。返回请求编号；进度通过 SESSION_IMPORT_PROGRESS_CHANNEL 推送。 */
export async function startImport(keys: string[]): Promise<ImportJobView> {
  const unique = [...new Set(keys)];
  const sources = await resolveSourceSessions(unique);
  const view: ImportJobView = {
    requestId: randomUUID(),
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    items: unique.map((key) => {
      const s = sources.get(key);
      return {
        key,
        source: (s?.source ?? key.split(':')[0]) as ImportItemView['source'],
        title: s?.title ?? key,
        status: 'queued',
        step: null,
        messagesWritten: 0,
        mode: null,
        harness: null,
        issue: null,
        sessionId: null,
      };
    }),
  };
  const job: Job = { view, owner: activeOwnerScopeKey(), keys: unique, controller: new AbortController(), lastEmit: 0, emitTimer: null };
  jobs.set(view.requestId, job);
  persist(job);
  void runJob(job).catch((err) => log.warn('session import job crashed', { error: err instanceof Error ? err.message : String(err) }));
  return view;
}

export function cancelImport(requestId: string): boolean {
  const job = jobs.get(requestId);
  if (!job || job.view.status !== 'running') return false;
  job.controller.abort();
  return true;
}

/** 当前账号最近一次导入（界面重新打开时恢复进度/结果）。 */
export function latestImportJob(): ImportJobView | null {
  const owner = activeOwnerScopeKey();
  let latest: Job | null = null;
  for (const job of jobs.values()) {
    if (job.owner === owner && (!latest || job.view.startedAt > latest.view.startedAt)) latest = job;
  }
  return latest?.view ?? null;
}

export function importJob(requestId: string): ImportJobView | null {
  return jobs.get(requestId)?.view ?? null;
}

/**
 * 续上上次退出或崩溃时没做完的导入（每个账号进程内只做一次）。
 * 已完成的条目不重做；做到一半的条目从头再来——写入按行键幂等，复制按同一编号覆盖。
 */
export async function recoverInterruptedImports(): Promise<void> {
  const owner = activeOwnerScopeKey();
  if (recoveredOwners.has(owner)) return;
  recoveredOwners.add(owner);
  let names: string[] = [];
  try {
    names = (await fsp.readdir(receiptDir())).filter((n) => n.endsWith('.json'));
  } catch {
    return;
  }
  for (const name of names) {
    const raw = readAtomicFileSync(path.join(receiptDir(), name));
    if (!raw) continue;
    let parsed: { keys: string[]; view: ImportJobView };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      continue;
    }
    if (!parsed?.view || jobs.has(parsed.view.requestId)) continue;
    const view = parsed.view;
    if (view.status !== 'running') {
      // 已结束的结果保留在内存里，供界面查看；超过 7 天的回执清掉。
      if (view.finishedAt && Date.now() - view.finishedAt > 7 * 24 * 3600_000) {
        await fsp.rm(path.join(receiptDir(), name), { force: true }).catch(() => undefined);
        continue;
      }
      jobs.set(view.requestId, { view, owner, keys: parsed.keys, controller: new AbortController(), lastEmit: 0, emitTimer: null });
      continue;
    }
    for (const item of view.items) {
      if (item.status === 'running') Object.assign(item, { status: 'queued', step: null });
    }
    const job: Job = { view, owner, keys: parsed.keys, controller: new AbortController(), lastEmit: 0, emitTimer: null };
    jobs.set(view.requestId, job);
    log.info('resuming interrupted session import', { requestId: view.requestId });
    void runJob(job).catch(() => undefined);
  }
}

/** 是否有正在进行的导入（应用更新重启前提示用）。 */
export function hasRunningImport(): boolean {
  for (const job of jobs.values()) if (job.view.status === 'running') return true;
  return false;
}

/**
 * 「选择文件夹」：原文件夹不存在的任务换到用户选的目录。Pi 的续做副本首行记录了工作目录，
 * 需要按新目录重新复制；Claude Code / Codex 在续做时按任务目录定位，改任务目录即可。
 */
export async function relocateImportedSession(sessionId: string, workingDir: string): Promise<void> {
  if (!(await dirExists(workingDir))) throw Object.assign(new Error('folder does not exist'), { code: 'INVALID_PARAMS' });
  const record = await getDbClient().queryOne<{ source: string; sourceSessionId: string }>(
    'SELECT source, source_session_id AS sourceSessionId FROM session_imports WHERE session_id = ?',
    [sessionId],
  );
  if (!record) throw Object.assign(new Error('not an imported task'), { code: 'NOT_FOUND' });
  const dir = normalizeWorkingDirForStorage(workingDir) ?? workingDir;
  let sdkPatch: { sdkSessionId?: string } = {};
  if (record.source === 'pi') {
    const key = `pi:${record.sourceSessionId}`;
    const source = (await resolveSourceSessions([key])).get(key);
    const adapter = adapterFor('pi');
    if (source && adapter?.materialize) {
      sdkPatch = { sdkSessionId: (await adapter.materialize({ ...source, cwd: dir }, { cindySessionId: sessionId })).sdkSessionId };
    }
  }
  await runImportTx({
    action: 'commit',
    sessionId,
    now: Date.now(),
    status: 'ready',
    issue: null,
    unhide: true,
    sessionPatch: { ...sdkPatch, workingDir: dir },
  });
  for (const job of jobs.values()) {
    const item = job.view.items.find((i) => i.sessionId === sessionId);
    if (item) {
      Object.assign(item, { status: 'ready', issue: null });
      emit(job, true);
      persist(job);
    }
  }
}
