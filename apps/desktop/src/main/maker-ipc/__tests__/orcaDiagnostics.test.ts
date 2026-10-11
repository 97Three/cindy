import { describe, expect, it, vi } from 'vitest';

import {
  getOrcaWorkspaceInfoReadOnly,
  getOrcaWorkerDiagnosticStatusReadOnly,
  projectOrcaTurnErrorSummary,
  readOrcaWorkerOutputReadOnly,
  type OrcaDiagnosticsDeps,
} from '../orcaDiagnostics';

function createDeps(overrides: Partial<OrcaDiagnosticsDeps> = {}): OrcaDiagnosticsDeps {
  return {
    readActiveTeam: vi.fn(async () => ({
      id: 'team-1',
      leadSessionId: 'lead-1',
      status: 'active',
    })),
    listWorkersByLead: vi.fn(async () => [{
      id: 'worker-1',
      sessionId: 'worker-session-1',
      status: 'done',
      label: 'dev',
      role: 'developer',
      focused: true,
      idleSince: null,
      updatedAt: new Date(Date.now() - 1000).toISOString(),
      session: {
        agentKind: 'codex' as const,
        model: 'gpt-5.5',
        effort: 'high',
        workingDir: '/repo',
      },
    }]),
    getSessionStatus: vi.fn((sessionId) => sessionId === 'worker-session-1' ? 'not_running' : 'active'),
    getWorkerFlowStatus: vi.fn(async () => ({
      isWorking: false,
      willQueue: false,
      queuedCount: 0,
      queuePaused: false,
    })),
    readLatestAssistantMessage: vi.fn(async () => 'latest assistant output'),
    ...overrides,
  };
}

describe('orca diagnostics read-only helpers', () => {
  it('returns empty workspace info without reading workers when there is no active team', async () => {
    const deps = createDeps({
      readActiveTeam: vi.fn(async () => null),
      listWorkersByLead: vi.fn(async () => {
        throw new Error('listWorkersByLead should not be called without active team');
      }),
    });

    await expect(getOrcaWorkspaceInfoReadOnly(deps, 'lead-without-active-team')).resolves.toEqual({
      ok: true,
      workflow: null,
      ui_capacity: 1,
      worker_count: 0,
      workers: [],
    });

    expect(deps.readActiveTeam).toHaveBeenCalledWith('lead-without-active-team');
    expect(deps.listWorkersByLead).not.toHaveBeenCalled();
  });

  it('matches legacy workspace diagnostic fields', async () => {
    const deps = createDeps();

    const result = await getOrcaWorkspaceInfoReadOnly(deps, 'lead-1');

    expect(result).toMatchObject({
      ok: true,
      workflow: {
        workflow_id: 'team-1',
        lead_session_id: 'lead-1',
        status: 'active',
      },
      ui_capacity: 1,
      worker_count: 1,
      workers: [{
        worker_id: 'worker-1',
        session_id: 'worker-session-1',
        status: 'done',
        session_status: 'not_running',
        restored_from_storage: true,
        is_working: false,
        will_queue: false,
        queued_count: 0,
        queue_paused: false,
        label: 'dev',
        role: 'developer',
        agent_kind: 'codex',
        model: 'gpt-5.5',
        effort: 'high',
        focused: true,
        working_dir: '/repo',
      }],
    });
    if (!result.ok) throw new Error('expected ok result');
    expect(result.workers[0]?.idle_ms).toEqual(expect.any(Number));
  });

  it('reports an empty paused worker queue', async () => {
    const deps = createDeps({
      getWorkerFlowStatus: vi.fn(async () => ({
        isWorking: false,
        willQueue: true,
        queuedCount: 0,
        queuePaused: true,
      })),
    });

    await expect(getOrcaWorkspaceInfoReadOnly(deps, 'lead-1')).resolves.toMatchObject({
      ok: true,
      workers: [{ queued_count: 0, queue_paused: true }],
    });
  });

  it('reports a consuming queue entry even after the pending queue is empty', async () => {
    const deps = createDeps({
      getWorkerFlowStatus: vi.fn(async () => ({
        isWorking: true,
        willQueue: true,
        queuedCount: 1,
        queuePaused: false,
      })),
    });

    await expect(getOrcaWorkspaceInfoReadOnly(deps, 'lead-1')).resolves.toMatchObject({
      ok: true,
      workers: [{ is_working: true, queued_count: 1, queue_paused: false }],
    });
  });

  it('returns worker_status fields and accepts worker session id as diagnostic ref', async () => {
    const deps = createDeps();

    await expect(getOrcaWorkerDiagnosticStatusReadOnly(
      deps,
      'lead-1',
      'worker-session-1',
    )).resolves.toMatchObject({
      ok: true,
      worker_id: 'worker-1',
      session_id: 'worker-session-1',
      status: 'done',
      session_status: 'not_running',
      restored_from_storage: true,
    });
  });

  it('reads latest assistant output for read_worker', async () => {
    const deps = createDeps();

    await expect(readOrcaWorkerOutputReadOnly(deps, 'lead-1', 'worker-1')).resolves.toMatchObject({
      ok: true,
      worker_id: 'worker-1',
      session_id: 'worker-session-1',
      status: 'done',
      session_status: 'not_running',
      result: 'latest assistant output',
    });
    expect(deps.readLatestAssistantMessage).toHaveBeenCalledWith('worker-session-1');
  });

  it('reports this turn error for read_worker without changing result', async () => {
    const deps = createDeps({
      readLatestTurnError: vi.fn(async () => ({
        message: 'upstream rejected the request',
        reason: 'provider-upstream-error',
        sdkError: 'HTTP 401',
        createdAt: 1_770_000_000_000,
      })),
    });

    const result = await readOrcaWorkerOutputReadOnly(deps, 'lead-1', 'worker-1');

    expect(result).toMatchObject({
      ok: true,
      result: 'latest assistant output',
      turnError: {
        message: 'upstream rejected the request',
        reason: 'provider-upstream-error',
        sdkError: 'HTTP 401',
        createdAt: '2026-02-02T02:40:00.000Z',
      },
    });
    if (!result.ok) throw new Error('expected ok result');
    expect(result.turnError).not.toHaveProperty('toolLoop');
    expect(deps.readLatestTurnError).toHaveBeenCalledWith('worker-session-1');
  });

  it('returns turnError null when this turn has no error row', async () => {
    const deps = createDeps({
      readLatestTurnError: vi.fn(async () => null),
    });

    await expect(readOrcaWorkerOutputReadOnly(deps, 'lead-1', 'worker-1')).resolves.toMatchObject({
      ok: true,
      result: 'latest assistant output',
      turnError: null,
    });
  });

  it('keeps turnError null when readLatestTurnError is not injected', async () => {
    const deps = createDeps();
    expect(deps.readLatestTurnError).toBeUndefined();

    await expect(readOrcaWorkerOutputReadOnly(deps, 'lead-1', 'worker-1')).resolves.toMatchObject({
      ok: true,
      result: 'latest assistant output',
      turnError: null,
    });
  });

  it('does not leak turnError when the worker itself is missing', async () => {
    const deps = createDeps({
      listWorkersByLead: vi.fn(async () => []),
      readLatestTurnError: vi.fn(async () => ({ message: 'stale', createdAt: 0 })),
    });

    await expect(
      readOrcaWorkerOutputReadOnly(deps, 'lead-1', 'missing-worker'),
    ).resolves.toMatchObject({ ok: false, errorCode: 'WORKER_NOT_FOUND' });
    expect(deps.readLatestTurnError).not.toHaveBeenCalled();
  });
});

describe('projectOrcaTurnErrorSummary', () => {
  it('redacts credentials in every outbound field', () => {
    const summary = projectOrcaTurnErrorSummary(
      {
        message: 'provider refused key=sk-liveabcdef123456 with Bearer eyJhbGciOiJIUzI1NiJ9 payload',
        reason: 'provider-upstream-error',
        sdkError: 'unauthorized token: sk-proj-QQQQQQQQQQQQQQQQQQQQ',
        toolLoop: { kind: 'consecutive', count: 3 },
      },
      1_770_000_000_000,
    );

    expect(summary).toEqual({
      message: 'provider refused key=[REDACTED_KEY] with Bearer [REDACTED] payload',
      reason: 'provider-upstream-error',
      // 「token:」规则排在裸 sk- 规则之前,故这里是 [REDACTED] 而不是 [REDACTED_KEY]。
      sdkError: 'unauthorized token: [REDACTED]',
      toolLoop: '{"kind":"consecutive","count":3}',
      createdAt: 1_770_000_000_000,
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('sk-liveabcdef123456');
    expect(serialized).not.toContain('sk-proj-QQQQQQQQQQQQQQQQQQQQ');
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('returns null for content without a usable message', () => {
    expect(projectOrcaTurnErrorSummary({ reason: 'x' }, 1)).toBeNull();
    expect(projectOrcaTurnErrorSummary({ message: '' }, 1)).toBeNull();
    expect(projectOrcaTurnErrorSummary(null, 1)).toBeNull();
    expect(projectOrcaTurnErrorSummary('not-an-object', 1)).toBeNull();
  });

  it('drops non-string optional fields instead of stringifying them', () => {
    const summary = projectOrcaTurnErrorSummary(
      { message: 'boom', reason: 42, sdkError: undefined, toolLoop: null },
      7,
    );
    expect(summary).toEqual({ message: 'boom', createdAt: 7 });
  });
});
