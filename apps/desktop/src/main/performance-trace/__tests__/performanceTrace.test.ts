import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerformanceTraceController, type TraceControllerDeps } from '../controller';
import { projectCpuProfile, projectTraceEvent, type TraceReport } from '../report';
import { measureTraceOperation, setTraceOperationObserver } from '../measure';
import { createTraceCommandHandler } from '../ipc';
import type { IpcMainInvokeEvent } from 'electron';
import { submitPerformanceReport } from '../upload';
import type { LogUploadMeta } from '../../log-upload/types';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readTraceArtifacts, TRACE_ARTIFACT_NAMES, type TraceArtifact } from '../artifacts';
import { restorePerformanceFiles } from '../restore';

/** Test value: production recording lifecycle and upload projection. User-requested diagnostics
 * must preserve local evidence on failure and isolate owners. Full-file uploads retain all
 * samples while redacting recognizable secrets; restoration verifies checksums and completeness.
 * Existing log-upload tests cover logs only, not recordings/profiles. Minimal failures: concurrent
 * start/stop, a rejected upload, owner change, or one profiler frame/event with a secret field.
 * Minimal new failure: a missing chunk/marker, failed final request, or secret in a raw profile.
 * Tier: unit, injected clocks/network/profilers; bounded files in an isolated OS temp directory.
 * Standalone Vitest run: 0.54s on Windows (2026-10-29); test execution 94ms.
 */
function fixture() {
  let now = 1000,
    owner = 'alice:1';
  const reports: TraceReport[] = [];
  const stop = vi.fn(async () => ({ profiles: [], partial: false }));
  const deps: TraceControllerDeps = {
    now: () => now,
    owner: () => owner,
    reportId: () => 'ABCD-EFGH',
    environment: () => ({ appVersion: 'test', platform: 'win32', arch: 'x64' }),
    begin: vi.fn(async () => ({ stop })),
    save: vi.fn(async (report) => {
      reports.push(structuredClone(report));
    }),
    upload: vi.fn(async () => {}),
    reveal: vi.fn(async () => {}),
    changed: vi.fn(),
  };
  return {
    controller: new PerformanceTraceController(deps),
    deps,
    stop,
    reports,
    advance: (value: number) => {
      now += value;
    },
    owner: (value: string) => {
      owner = value;
    },
  };
}
afterEach(() => {
  setTraceOperationObserver(null);
  vi.useRealTimers();
});

describe('performance recording', () => {
  it('records only during a capture, preserves timeline data, and saves once on concurrent stops', async () => {
    const f = fixture();
    const event = {
      at: 1000,
      kind: 'input',
      label: 'keydown',
      durationMs: 80,
      text: 'private text',
    };
    f.controller.events([event]);
    await f.controller.start();
    f.controller.events([event]);
    f.advance(100);
    await Promise.all([f.controller.stop(), f.controller.stop()]);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.reports).toHaveLength(1);
    expect(f.reports[0]).toMatchObject({
      durationMs: 100,
      scope: 'local-desktop',
      remoteHostCaptured: false,
      events: [{ at: 1000, kind: 'input', label: 'keydown', durationMs: 80 }],
    });
    expect(JSON.stringify(f.reports)).not.toContain('private text');
  });
  it('rejects overlapping starts and stops automatically without uploading', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.deps.begin).mockImplementationOnce(async () => {
      f.advance(10_000);
      return { stop: f.stop };
    });
    await f.controller.start();
    await expect(f.controller.start()).rejects.toThrow('PRECONDITION_FAILED');
    f.advance(50_000);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(f.controller.snapshot()).toMatchObject({ phase: 'ready', durationMs: 60_000 });
    expect(f.deps.upload).not.toHaveBeenCalled();
  });
  it('waits for an already-saving capture when the application closes', async () => {
    const f = fixture();
    let finish!: () => void;
    f.stop.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ profiles: [], partial: false });
        }),
    );
    await f.controller.start();
    const stopping = f.controller.stop();
    let closed = false;
    const closing = f.controller.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await Promise.all([stopping, closing]);
    expect(f.reports).toHaveLength(1);
    expect(closed).toBe(true);
  });
  it('keeps the same report id and local evidence after failed upload, then retries once', async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    vi.mocked(f.deps.upload).mockRejectedValueOnce(new Error('offline'));
    await expect(f.controller.upload('slow typing')).rejects.toThrow('offline');
    expect(f.controller.snapshot()).toMatchObject({
      phase: 'ready',
      reportId: 'ABCD-EFGH',
      uploaded: false,
    });
    await f.controller.reveal();
    await f.controller.upload('slow typing');
    await f.controller.upload('slow typing');
    expect(f.deps.reveal).toHaveBeenCalledWith('ABCD-EFGH');
    expect(f.deps.upload).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot().uploaded).toBe(true);
  });
  it('hides old-owner results and rejects upload and reveal after switching accounts', async () => {
    const f = fixture();
    await f.controller.start();
    f.owner('bob:2');
    await f.controller.close();
    expect(f.controller.snapshot()).toMatchObject({ phase: 'idle', reportId: null });
    await expect(f.controller.upload('')).rejects.toThrow('PRECONDITION_FAILED');
    await expect(f.controller.reveal()).rejects.toThrow('PRECONDITION_FAILED');
    expect(f.deps.upload).not.toHaveBeenCalled();
  });
  // Review regression: reveal must not open the old owner's files after an awaited save.
  // The preceding owner test only switches before invocation; this unit suspends the save.
  it('rejects revealing old-owner files when the account changes during saving', async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    let finishSave!: () => void;
    vi.mocked(f.deps.save).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const revealing = f.controller.reveal();
    const rejected = expect(revealing).rejects.toThrow('PRECONDITION_FAILED');
    f.owner('bob:2');
    finishSave();
    await rejected;
    expect(f.deps.reveal).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ phase: 'idle', reportId: null });
  });
  it('recovers a failed start and retains partial results if a profiler fails at stop', async () => {
    const f = fixture();
    vi.mocked(f.deps.begin).mockRejectedValueOnce(new Error('busy'));
    await expect(f.controller.start()).rejects.toThrow('busy');
    expect(f.controller.snapshot().phase).toBe('idle');
    await f.controller.start();
    f.stop.mockRejectedValueOnce(new Error('renderer gone'));
    await f.controller.stop();
    expect(f.reports[0].partial).toBe(true);
    expect(f.controller.snapshot().phase).toBe('ready');
  });
  it('retries saving the in-memory report after disk write failure', async () => {
    const f = fixture();
    await f.controller.start();
    vi.mocked(f.deps.save).mockRejectedValueOnce(new Error('disk full'));
    await expect(f.controller.stop()).rejects.toThrow('disk full');
    expect(f.controller.snapshot()).toMatchObject({ phase: 'ready', partial: true });
    await f.controller.reveal();
    expect(f.reports).toHaveLength(1);
  });
});

describe('report boundary', () => {
  it('checks sender authorization and recording window before starting or reading files', async () => {
    const f = fixture();
    let source = false;
    const authorize = vi.fn<() => void>(() => {
      throw new Error('untrusted sender');
    });
    const showFolder = vi.fn(async () => {});
    const handler = createTraceCommandHandler({
      controller: f.controller,
      authorize,
      isSource: () => source,
      selectSource: () => {
        source = true;
      },
      showFolder,
    });
    const event = {} as IpcMainInvokeEvent;
    await expect(handler(event, 'start', undefined)).rejects.toThrow('untrusted sender');
    expect(f.deps.begin).not.toHaveBeenCalled();
    authorize.mockImplementation(() => {});
    await expect(handler(event, { toString: () => 'start' }, undefined)).rejects.toThrow(
      'INVALID_PARAMS',
    );
    await expect(handler(event, 'start', 'x'.repeat(1001))).rejects.toThrow('INVALID_PARAMS');
    await handler(event, 'show-local', undefined);
    expect(showFolder).toHaveBeenCalledOnce();
    await handler(event, 'start', undefined);
    source = false;
    await expect(handler(event, 'stop', undefined)).rejects.toThrow('PRECONDITION_FAILED');
    source = true;
    await handler(event, 'stop', undefined);
    vi.mocked(f.deps.reveal).mockRejectedValueOnce(new Error('/Users/private/report.json'));
    await expect(handler(event, 'show-local', undefined)).rejects.toThrow(
      '[INTERNAL] Performance recording operation failed',
    );
  });
  it('projects only fixed event labels and bounded numeric timings', () => {
    const input = {
      at: 1200,
      kind: 'input',
      label: 'keydown',
      durationMs: 80,
      inputDelayMs: 50,
      processingMs: 10,
      key: 'secret',
      target: '/Users/private',
    };
    expect(projectTraceEvent(input, 1000, 2000)).toEqual({
      at: 1200,
      kind: 'input',
      label: 'keydown',
      durationMs: 80,
      inputDelayMs: 50,
      processingMs: 10,
    });
    for (const extra of [
      { label: 'secret' },
      { at: 0 },
      { durationMs: NaN },
      { kind: '__proto__' },
    ])
      expect(projectTraceEvent({ ...input, ...extra }, 1000, 2000)).toBeNull();
  });
  it('keeps bundled CPU stack locations and sample timing while removing external paths and arbitrary fields', () => {
    const profile = projectCpuProfile(
      {
        startTime: 100,
        endTime: 300,
        samples: [1, 2],
        timeDeltas: [100, 100],
        nodes: [
          {
            id: 1,
            callFrame: {
              functionName: 'parseMarkdown',
              url: 'http://localhost:5173/src/app.ts?secret=abc',
              lineNumber: 10,
              columnNumber: 5,
            },
            children: [2],
          },
          {
            id: 2,
            callFrame: {
              functionName: 'secretFunction',
              url: 'https://private.example/secret.js',
              lineNumber: 42,
              columnNumber: 7,
            },
          },
        ],
      },
      process.cwd(),
      'http://localhost:5173',
    );
    expect(profile.nodes[0].callFrame).toEqual({
      functionName: 'parseMarkdown',
      url: 'app.ts',
      lineNumber: 10,
      columnNumber: 5,
    });
    expect(profile.nodes[1].callFrame).toEqual({
      functionName: '(external or anonymous)',
      url: '',
      lineNumber: -1,
      columnNumber: -1,
    });
    expect(profile.samples).toEqual([1, 2]);
    expect(profile.timeDeltas).toEqual([100, 100]);
    expect(JSON.stringify(profile)).not.toMatch(/secret|private|localhost/);
  });
  it('requires consent before sending and checks owner again between upload batches', async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    const report = f.reports[0];
    report.events = Array.from({ length: 600 }, () => ({
      at: 1000,
      kind: 'input',
      label: 'keydown',
      durationMs: 80,
    }));
    let owner = 'alice',
      consent = false;
    const fetch = vi.fn(async () => {
      owner = 'bob';
      return new Response('', { status: 200 });
    });
    const deps = {
      owner: () => owner,
      gate: () =>
        consent
          ? { kind: 'allowed' as const }
          : { kind: 'denied' as const, reason: 'no-consent' as const },
      target: () => ({ project: 'fixture', logstore: 'fixture', endpointHost: 'invalid.example' }),
      meta: (uploadCode: string): LogUploadMeta => ({
        uploadCode,
        reason: 'manual',
        userId: 'fixture',
        deviceId: 'fixture',
        appVersion: 'test',
        region: 'global',
        platform: 'win32',
        arch: 'x64',
        osVersion: 'fixture',
        uiLanguage: 'en',
      }),
      fetch,
      artifacts: async () =>
        TRACE_ARTIFACT_NAMES.map((name) => ({
          name,
          bytes: Buffer.from(JSON.stringify(name === 'report.json' ? report : { samples: [1, 2] })),
        })),
    };
    await expect(submitPerformanceReport(deps, report, '')).rejects.toThrow(
      'PRIVACY_CONSENT_REQUIRED',
    );
    expect(fetch).not.toHaveBeenCalled();
    consent = true;
    await expect(submitPerformanceReport(deps, report, '')).rejects.toThrow('PRECONDITION_FAILED');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('uploads full files through the log sink and restores all samples with secrets redacted', async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    const report = f.reports[0];
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-performance-files-'));
    try {
      const original = {
        nodes: [
          {
            id: 1,
            callFrame: { functionName: 'render', url: 'file:///app/main.js', lineNumber: 42 },
          },
        ],
        samples: Array.from({ length: 30_100 }, () => 1),
        timeDeltas: Array.from({ length: 30_100 }, () => 4000),
        credentials: { token: 'test-only-secret' },
        email: 'fixture@example.invalid',
        nested: { 'x-api-key': 'another-test-only-secret' },
        payload: randomBytes(100_000).toString('base64'),
      };
      for (const name of TRACE_ARTIFACT_NAMES)
        await writeFile(
          path.join(directory, name),
          JSON.stringify(name === 'report.json' ? report : original),
        );
      await writeFile(path.join(directory, 'unrelated.txt'), 'must not upload');
      const artifacts = await readTraceArtifacts(directory);
      expect(artifacts.map((file) => file.name)).toEqual([...TRACE_ARTIFACT_NAMES]);
      const rows: unknown[] = [];
      const deps = uploadDeps(artifacts, rows);
      await submitPerformanceReport(deps, report, 'Authorization: Bearer fake-note-secret');
      expect(JSON.stringify(rows)).not.toContain('fake-note-secret');
      const restored = restorePerformanceFiles(
        [...rows].reverse().concat(rows[0]),
        report.reportId,
      );
      expect(restored.files.size).toBe(4);
      const profile = JSON.parse(restored.files.get('main.cpuprofile')!.toString());
      expect(profile.samples).toEqual(original.samples);
      expect(profile.timeDeltas).toEqual(original.timeDeltas);
      expect(profile.nodes).toEqual(original.nodes);
      expect(profile.payload).toBe(original.payload);
      expect(restored.files.get('main.cpuprofile')!.toString()).not.toMatch(
        /test-only-secret|fixture@example.invalid/,
      );
      expect(await readFile(path.join(directory, 'main.cpuprofile'), 'utf8')).toContain(
        'test-only-secret',
      );
      expect(rows.every((row) => Buffer.byteLength((row as { msg: string }).msg) < 20 * 1024)).toBe(
        true,
      );
      expect(() => restorePerformanceFiles(rows.slice(0, -1), report.reportId)).toThrow();
      expect(() =>
        restorePerformanceFiles(
          rows.filter((_, i) => i !== 2),
          report.reportId,
        ),
      ).toThrow();
      const tampered = structuredClone(rows) as Array<{ msg: string }>;
      const manifest = JSON.parse(tampered[0].msg);
      manifest.data.files[0].sha256 = '0'.repeat(64);
      tampered[0].msg = JSON.stringify(manifest);
      expect(() => restorePerformanceFiles(tampered, report.reportId)).toThrow(/checksum/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('retains local evidence after final-marker failure and retries with one independently complete attempt', async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    const report = f.reports[0];
    const artifacts = TRACE_ARTIFACT_NAMES.map((name) => ({
      name,
      bytes: Buffer.from(
        JSON.stringify(name === 'report.json' ? report : { nodes: [], samples: [] }),
      ),
    }));
    const rows: unknown[] = [];
    const deps = uploadDeps(artifacts, rows);
    const send = deps.fetch;
    deps.fetch = vi.fn(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (JSON.parse(body.__logs__[0].msg).data.kind === 'complete')
        return new Response('', { status: 503 });
      return send(url, init);
    });
    f.deps.upload = (r, note) => submitPerformanceReport(deps, r, note);
    await expect(f.controller.upload('note')).rejects.toThrow('LOG_UPLOAD_FAILED');
    expect(f.controller.snapshot()).toMatchObject({
      phase: 'ready',
      uploaded: false,
      reportId: report.reportId,
    });
    expect(() => restorePerformanceFiles(rows, report.reportId)).toThrow();
    deps.fetch = send;
    await f.controller.upload('note');
    expect(f.controller.snapshot().uploaded).toBe(true);
    expect(restorePerformanceFiles(rows, report.reportId).files.size).toBe(4);
    expect(
      new Set(rows.map((row) => JSON.parse((row as { msg: string }).msg).attemptId)).size,
    ).toBe(2);
  });
  it('rejects missing/invalid full files before any request and reports missing files for a partial recording', async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    const report = f.reports[0];
    const rows: unknown[] = [];
    const files: TraceArtifact[] = [
      { name: 'report.json', bytes: Buffer.from(JSON.stringify(report)) },
    ];
    const deps = uploadDeps(files, rows);
    await expect(submitPerformanceReport(deps, report, '')).rejects.toThrow('LOG_UPLOAD_FAILED');
    expect(deps.fetch).not.toHaveBeenCalled();
    report.partial = true;
    files[0].bytes = Buffer.from(JSON.stringify(report));
    await submitPerformanceReport(deps, report, '');
    expect(restorePerformanceFiles(rows, report.reportId).manifest.missing).toHaveLength(3);
  });
  it('measures selected IPC calls without changing return values, rejections or exposing arguments', async () => {
    const events: unknown[] = [];
    setTraceOperationObserver((e) => events.push(e));
    expect(measureTraceOperation('local-db:sessions:list', () => 42)).toBe(42);
    const error = new Error('original');
    await expect(
      measureTraceOperation('maker:list-agent-skills', () => Promise.reject(error)),
    ).rejects.toBe(error);
    measureTraceOperation('private-channel-name', () => 0);
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toMatch(/original|private-channel/);
  });
});

function uploadDeps(artifacts: TraceArtifact[], rows: unknown[]) {
  return {
    owner: () => 'owner',
    gate: () => ({ kind: 'allowed' as const }),
    target: () => ({ project: 'fixture', logstore: 'fixture', endpointHost: 'invalid.example' }),
    meta: (uploadCode: string): LogUploadMeta => ({
      uploadCode,
      reason: 'manual',
      userId: 'fixture',
      deviceId: 'fixture',
      appVersion: 'test',
      region: 'global',
      platform: 'win32',
      arch: 'x64',
      osVersion: 'fixture',
      uiLanguage: 'en',
    }),
    artifacts: async () => artifacts,
    fetch: vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(Buffer.byteLength(String(init?.body))).toBeLessThanOrEqual(1024 * 1024);
      rows.push(...body.__logs__);
      return new Response('', { status: 200 });
    }),
  };
}
