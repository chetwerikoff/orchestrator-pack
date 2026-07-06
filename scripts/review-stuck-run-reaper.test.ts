import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AO_REVIEW_FAIL_STALE_PATH,
  DEFAULT_STUCK_AGE_FLOOR_SECONDS,
  FAIL_STALE_UPSTREAM_ISSUE,
  buildFailStalePath,
  classifyStuckSameHeadCandidate,
  computeRunAgeSeconds,
  evaluateFailStaleInvocation,
  formatClassifiedAlertLine,
  justInTimeRevalidate,
  probeReviewerPaneLiveness,
  runStuckRunReaperTick,
} from '../docs/review-stuck-run-reaper.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'tests/fixtures/review-stuck-run-reaper');
const capturesDir = path.join(repoRoot, 'tests/external-output-references/captures/ao-0-10-review-api');

function loadFixture(name: string) {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as Record<string, unknown>;
}

const nowMs = Date.parse('2026-07-06T09:00:00.000Z');
const sessionId = 'orchestrator-pack-7';
const headSha = 'abc123def4567890abcdef1234567890abcdef12';

type FailStaleInvokerContext = {
  sessionId: string;
  runId: string;
  targetSha: string;
  prUrl: string;
};

type ReaperAction = {
  classification?: string;
  paneLiveness?: string;
  recovery?: Record<string, unknown>;
};

type ReaperTickResult = {
  ok: boolean;
  actions: ReaperAction[];
  upstream?: string | null;
};

async function runReaperTick(input: Record<string, unknown>): Promise<ReaperTickResult> {
  return (await runStuckRunReaperTick(input)) as ReaperTickResult;
}

describe('review-stuck-run-reaper (Issue #624)', () => {
  it('classifies stuck_same_head when running, absent pane, and age at or above floor', () => {
    const listPayload = loadFixture('stuck-same-head-absent-pane.json');
    const run = {
      ...(listPayload.reviews as Array<{ latestRun: Record<string, unknown> }>)[0].latestRun,
      linkedSessionId: sessionId,
    };
    const result = classifyStuckSameHeadCandidate({
      run,
      headSha,
      prUrl: 'https://github.com/chetwerikoff/orchestrator-pack/pull/624',
      paneLiveness: 'absent',
      ageFloorSeconds: 600,
      nowMs,
    });
    expect(result.classification).toBe('stuck_same_head');
    expect(result.ageSeconds).toBeGreaterThanOrEqual(600);
  });

  it('does not classify stuck when age is below the configured floor', () => {
    const listPayload = loadFixture('below-age-floor.json');
    const run = {
      ...(listPayload.reviews as Array<{ latestRun: Record<string, unknown> }>)[0].latestRun,
      linkedSessionId: sessionId,
    };
    const result = classifyStuckSameHeadCandidate({
      run,
      headSha,
      paneLiveness: 'absent',
      ageFloorSeconds: 600,
      nowMs,
    });
    expect(result.classification).toBe('no_op');
    expect(result.reason).toBe('below_age_floor');
  });

  it('never classifies stuck_same_head when pane is healthy even above age floor', () => {
    const listPayload = loadFixture('healthy-pane-long-review.json');
    const run = {
      ...(listPayload.reviews as Array<{ latestRun: Record<string, unknown> }>)[0].latestRun,
      linkedSessionId: sessionId,
    };
    const result = classifyStuckSameHeadCandidate({
      run,
      headSha,
      paneLiveness: 'healthy',
      ageFloorSeconds: 60,
      nowMs,
    });
    expect(result.classification).toBe('no_op');
    expect(result.reason).toBe('healthy_pane');
  });

  it('emits alert-only classification when pane liveness is unknown', async () => {
    const listPayload = loadFixture('unknown-pane-liveness.json');
    const tick = await runReaperTick({
      workerSessions: [{ id: sessionId, role: 'worker' }],
      listPayloads: { [sessionId]: listPayload },
      paneByHandle: { 'review-orchestrator-pack-7': 'unknown' },
      config: { ageFloorSeconds: 600 },
      nowMs,
      failStaleSurfaceAvailable: true,
    });
    expect(tick.actions).toContainEqual(
      expect.objectContaining({
        classification: 'stuck_same_head_alert_only',
        paneLiveness: 'unknown',
      }),
    );
    const action = tick.actions.find((row) => row.classification === 'stuck_same_head_alert_only');
    expect(action?.recovery).toMatchObject({ invoke: false });
  });

  it('formats parseable supervisor alert lines with required fields', () => {
    const line = formatClassifiedAlertLine({
      classification: 'stuck_same_head_alert_only',
      sessionId,
      prUrl: 'https://github.com/chetwerikoff/orchestrator-pack/pull/624',
      runId: 'rr-624-unknown-1',
      targetSha: headSha,
      ageSeconds: 3600,
      paneLiveness: 'unknown',
    });
    expect(line).toContain('classification=stuck_same_head_alert_only');
    expect(line).toContain(`sessionId=${sessionId}`);
    expect(line).toContain('prUrl=https://github.com/chetwerikoff/orchestrator-pack/pull/624');
    expect(line).toContain('runId=rr-624-unknown-1');
    expect(line).toContain(`targetSha=${headSha}`);
    expect(line).toContain('ageSeconds=3600');
    expect(line).toContain('paneLiveness=unknown');
  });

  it('does not invoke fail-stale-run when upstream surface is absent', async () => {
    const listPayload = loadFixture('stuck-same-head-absent-pane.json');
    const invocations: unknown[] = [];
    const tick = await runReaperTick({
      workerSessions: [{ id: sessionId, role: 'worker' }],
      listPayloads: { [sessionId]: listPayload },
      paneByHandle: { 'review-orchestrator-pack-7': 'absent' },
      config: { ageFloorSeconds: 600 },
      nowMs,
      failStaleSurfaceAvailable: false,
      failStaleInvoker: async (ctx: FailStaleInvokerContext) => {
        invocations.push(ctx);
        return { ok: true };
      },
    });
    expect(tick.upstream).toBe(FAIL_STALE_UPSTREAM_ISSUE);
    expect(invocations).toHaveLength(0);
    expect(tick.actions[0]?.recovery).toMatchObject({
      invoke: false,
      reason: 'fail_stale_surface_absent',
    });
  });

  it('invokes fail-stale-run after JIT revalidation when surface exists', async () => {
    const listPayload = loadFixture('stuck-same-head-absent-pane.json');
    const invocations: Array<Record<string, unknown>> = [];
    let refreshCalls = 0;
    const tick = await runReaperTick({
      workerSessions: [{ id: sessionId, role: 'worker' }],
      listPayloads: { [sessionId]: listPayload },
      paneByHandle: { 'review-orchestrator-pack-7': 'absent' },
      config: { ageFloorSeconds: 600 },
      nowMs,
      failStaleSurfaceAvailable: true,
      refreshListPayload: async () => {
        refreshCalls += 1;
        return listPayload;
      },
      refreshPaneProbe: async () => ({ paneLiveness: 'absent' }),
      failStaleInvoker: async (ctx: FailStaleInvokerContext) => {
        invocations.push(ctx);
        return { ok: true, reason: '200' };
      },
    });
    expect(refreshCalls).toBeGreaterThanOrEqual(1);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      sessionId,
      runId: 'rr-624-stuck-1',
      targetSha: headSha,
    });
    expect(tick.actions[0]?.recovery).toMatchObject({ invoked: true, ok: true });
  });

  it('aborts recovery when JIT revalidation finds a healthy pane', async () => {
    const listPayload = loadFixture('stuck-same-head-absent-pane.json');
    const jit = await justInTimeRevalidate({
      prior: { prNumber: 624, runId: 'rr-624-stuck-1' },
      headSha,
      refreshListPayload: async () => listPayload,
      paneProbe: async () => ({ paneLiveness: 'healthy' }),
    });
    expect(jit.ok).toBe(false);
    expect(jit.reason).toBe('pane_became_healthy');
  });

  it('aborts fail-stale when JIT refresh shows run already terminal (TOCTOU)', async () => {
    const stalePayload = loadFixture('stuck-same-head-absent-pane.json');
    const freshPayload = JSON.parse(JSON.stringify(stalePayload)) as {
      reviews: Array<{ latestRun: Record<string, unknown> }>;
    };
    freshPayload.reviews[0].latestRun.status = 'complete';
    const invocations: unknown[] = [];
    const tick = await runReaperTick({
      workerSessions: [{ id: sessionId, role: 'worker' }],
      listPayloads: { [sessionId]: stalePayload },
      paneByHandle: { 'review-orchestrator-pack-7': 'absent' },
      config: { ageFloorSeconds: 600 },
      nowMs,
      failStaleSurfaceAvailable: true,
      refreshListPayload: async () => freshPayload,
      refreshPaneProbe: async () => ({ paneLiveness: 'absent' }),
      failStaleInvoker: async (ctx: FailStaleInvokerContext) => {
        invocations.push(ctx);
        return { ok: true };
      },
    });
    expect(invocations).toHaveLength(0);
    expect(tick.actions[0]?.recovery).toMatchObject({
      invoke: false,
      reason: 'jit_abort',
      detail: 'run_no_longer_running',
    });
  });

  it('aborts fail-stale when JIT pane re-probe returns healthy despite stale scan map', async () => {
    const listPayload = loadFixture('stuck-same-head-absent-pane.json');
    const invocations: unknown[] = [];
    const tick = await runReaperTick({
      workerSessions: [{ id: sessionId, role: 'worker' }],
      listPayloads: { [sessionId]: listPayload },
      paneByHandle: { 'review-orchestrator-pack-7': 'absent' },
      config: { ageFloorSeconds: 600 },
      nowMs,
      failStaleSurfaceAvailable: true,
      refreshListPayload: async () => listPayload,
      refreshPaneProbe: async () => ({ paneLiveness: 'healthy' }),
      failStaleInvoker: async (ctx: FailStaleInvokerContext) => {
        invocations.push(ctx);
        return { ok: true };
      },
    });
    expect(invocations).toHaveLength(0);
    expect(tick.actions[0]?.recovery).toMatchObject({
      invoke: false,
      reason: 'jit_abort',
      detail: 'pane_became_healthy',
    });
  });

  it('prevents duplicate recovery for the same run when single-flight is busy', async () => {
    const listPayload = loadFixture('stuck-same-head-absent-pane.json');
    let calls = 0;
    const tick = await runReaperTick({
      workerSessions: [{ id: sessionId, role: 'worker' }],
      listPayloads: { [sessionId]: listPayload },
      paneByHandle: { 'review-orchestrator-pack-7': 'absent' },
      config: { ageFloorSeconds: 600 },
      nowMs,
      failStaleSurfaceAvailable: true,
      inFlightRecoveries: new Set([`${sessionId}:rr-624-stuck-1`]),
      failStaleInvoker: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(calls).toBe(0);
    expect(tick.actions[0]?.recovery).toMatchObject({ reason: 'single_flight_busy' });
  });

  it('probeReviewerPaneLiveness treats tmux missing as absent and exists as healthy', () => {
    expect(
      probeReviewerPaneLiveness({
        reviewerHandleId: 'review-orchestrator-pack-7',
        tmuxExists: () => 'missing',
      }).paneLiveness,
    ).toBe('absent');
    expect(
      probeReviewerPaneLiveness({
        reviewerHandleId: 'review-orchestrator-pack-7',
        tmuxExists: () => 'exists',
      }).paneLiveness,
    ).toBe('healthy');
    expect(
      probeReviewerPaneLiveness({
        reviewerHandleId: 'review-orchestrator-pack-7',
        tmuxExists: () => 'unavailable',
      }).paneLiveness,
    ).toBe('unknown');
  });

  it('prefers tmux absence over stale session runtime alive (daemon restart)', () => {
    const result = probeReviewerPaneLiveness({
      reviewerHandleId: 'review-orchestrator-pack-7',
      sessions: [{ id: 'review-orchestrator-pack-7', status: 'working', runtime: 'alive' }],
      tmuxExists: () => 'missing',
    });
    expect(result).toMatchObject({ paneLiveness: 'absent', reason: 'tmux_session_missing' });
  });

  it('awaits async pane probes before scan classification', async () => {
    const listPayload = loadFixture('stuck-same-head-absent-pane.json');
    const tick = await runReaperTick({
      workerSessions: [{ id: sessionId, role: 'worker' }],
      listPayloads: { [sessionId]: listPayload },
      paneByHandle: {},
      paneProbe: async () => ({ paneLiveness: 'absent' }),
      config: { ageFloorSeconds: 600 },
      nowMs,
      failStaleSurfaceAvailable: false,
    });
    expect(tick.actions[0]?.classification).toBe('stuck_same_head');
    expect(tick.actions[0]?.paneLiveness).toBe('absent');
  });

  it('aborts JIT recovery when a new same-head run id superseded the scanned run', async () => {
    const stalePayload = loadFixture('stuck-same-head-absent-pane.json');
    const freshPayload = JSON.parse(JSON.stringify(stalePayload)) as {
      reviews: Array<{ latestRun: Record<string, unknown> }>;
    };
    freshPayload.reviews[0].latestRun.id = 'rr-624-stuck-replacement';
    freshPayload.reviews[0].latestRun.runId = 'rr-624-stuck-replacement';
    const invocations: unknown[] = [];
    const tick = await runReaperTick({
      workerSessions: [{ id: sessionId, role: 'worker' }],
      listPayloads: { [sessionId]: stalePayload },
      paneByHandle: { 'review-orchestrator-pack-7': 'absent' },
      config: { ageFloorSeconds: 600 },
      nowMs,
      failStaleSurfaceAvailable: true,
      refreshListPayload: async () => freshPayload,
      refreshPaneProbe: async () => ({ paneLiveness: 'absent' }),
      failStaleInvoker: async (ctx: FailStaleInvokerContext) => {
        invocations.push(ctx);
        return { ok: true };
      },
    });
    expect(invocations).toHaveLength(0);
    expect(tick.actions[0]?.recovery).toMatchObject({
      invoke: false,
      reason: 'jit_abort',
      detail: 'run_id_changed',
    });
  });

  it('aborts JIT recovery when refreshed run is below the age floor', async () => {
    const stalePayload = loadFixture('stuck-same-head-absent-pane.json');
    const freshPayload = JSON.parse(JSON.stringify(stalePayload)) as {
      reviews: Array<{ latestRun: Record<string, unknown> }>;
    };
    freshPayload.reviews[0].latestRun.updatedAt = '2026-07-06T08:59:30.000Z';
    const invocations: unknown[] = [];
    const tick = await runReaperTick({
      workerSessions: [{ id: sessionId, role: 'worker' }],
      listPayloads: { [sessionId]: stalePayload },
      paneByHandle: { 'review-orchestrator-pack-7': 'absent' },
      config: { ageFloorSeconds: 600 },
      nowMs,
      failStaleSurfaceAvailable: true,
      refreshListPayload: async () => freshPayload,
      refreshPaneProbe: async () => ({ paneLiveness: 'absent' }),
      failStaleInvoker: async (ctx: FailStaleInvokerContext) => {
        invocations.push(ctx);
        return { ok: true };
      },
    });
    expect(invocations).toHaveLength(0);
    expect(tick.actions[0]?.recovery).toMatchObject({
      invoke: false,
      reason: 'jit_abort',
      detail: 'below_age_floor',
    });
  });

  it('binds fail-stale path to AO 0.10 session-scoped reviews surface', () => {
    expect(AO_REVIEW_FAIL_STALE_PATH).toContain('/reviews/runs/');
    expect(buildFailStalePath(sessionId, 'rr-624-stuck-1')).toBe(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/reviews/runs/${encodeURIComponent('rr-624-stuck-1')}/fail-stale`,
    );
  });

  it('replays capture-backed session reviews list shape for age computation', () => {
    const capture = JSON.parse(readFileSync(path.join(capturesDir, 'session-reviews-list.raw.json'), 'utf8')) as {
      reviews: Array<{ latestRun: Record<string, unknown> }>;
    };
    const run = capture.reviews[0].latestRun;
    run.updatedAt = '2026-07-06T08:00:00.000Z';
    expect(computeRunAgeSeconds(run, nowMs)).toBeGreaterThanOrEqual(3600);
    expect(evaluateFailStaleInvocation({
      classification: 'stuck_same_head',
      paneLiveness: 'absent',
      failStaleSurfaceAvailable: false,
    })).toMatchObject({ invoke: false, upstream: FAIL_STALE_UPSTREAM_ISSUE });
    expect(DEFAULT_STUCK_AGE_FLOOR_SECONDS).toBe(600);
  });
});
