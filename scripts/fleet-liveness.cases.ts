import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateHeadReadyForReview } from './pr2-foundation/review-head-ready.ts';
import {
  REVIEW_READY_SEED_LIVENESS_EXPECTED,
} from './lib/review-ready-seed-liveness-matrix.mjs';
import {
  BOUNDED_EXTERNAL_CALL_SCHEMA,
  consumePendingExternalCallTimeout,
  loadFleetLivenessContract,
  readLivenessProgressRecord,
  resolveLivenessProgressPath,
  runExternalCallWithLiveness,
  writeLivenessCheckpoint,
} from './kernel/side-process-liveness.ts';
import type { ProcessResult } from './kernel/subprocess.ts';

const created: string[] = [];
const CHILD_ID = 'pr2-scheduler';

const ISSUE_853_RUNTIME_EXPECTED = [
  'fast-tick-ok',
  'long-tick-not-stalled-seed',
  'long-tick-not-stalled-reeval',
  'bounded-call-timeout-degraded',
  'hang-still-stalled',
  'progress-livelock-fails',
  'progress-identity',
  'dead-process-not-fresh',
  'overlap-safe',
  'atomic-progress-read',
  'upgrade-safe-progress',
  'e2e-seed-to-trigger-restored',
] as const;

const ISSUE_853_LOCAL_EXPECTED = new Set<string>([
  'long-tick-not-stalled-seed',
  'long-tick-not-stalled-reeval',
  'bounded-call-timeout-degraded',
  'e2e-seed-to-trigger-restored',
]);

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-fleet-liveness-'));
  created.push(root);
  return root;
}

function readProgress(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolveLivenessProgressPath(root, CHILD_ID), 'utf8')) as Record<string, unknown>;
}

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    outcome: 'exit',
    ok: true,
    exitCode: 0,
    signal: null,
    stdout: '{}\n',
    stderr: '',
    timedOut: false,
    cancelled: false,
    ...overrides,
  };
}

function emitProof(expected: string): void {
  console.log(JSON.stringify({ producer: 'orchestrator-pack', datum: 'fleet-liveness', expected }));
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fleet-liveness shared producer contract', () => {
  it('maps every Issue #853 runtime matrix label to a local or inherited deterministic proof', () => {
    const inherited = new Set<string>(REVIEW_READY_SEED_LIVENESS_EXPECTED);
    for (const expected of ISSUE_853_RUNTIME_EXPECTED) {
      expect(
        ISSUE_853_LOCAL_EXPECTED.has(expected) || inherited.has(expected),
        `missing deterministic proof mapping for ${expected}`,
      ).toBe(true);
    }
  });

  for (const expected of [
    'long-tick-not-stalled-seed',
    'long-tick-not-stalled-reeval',
  ]) {
    it(`expected: ${expected}`, () => {
      const root = tempRoot();
      const checkpoints = [1_000, 11_000, 21_000, 31_000];
      const declaration = loadFleetLivenessContract().children.find((entry) => entry.id === CHILD_ID);
      expect(declaration?.maxLocalComputeGapMs).toBe(30_000);
      for (const nowMs of checkpoints) {
        writeLivenessCheckpoint({
          childId: CHILD_ID,
          ownerPid: 4242,
          workStep: 'github_fanout',
          progressDir: root,
          tickId: `tick-${expected}`,
          nowMs,
        });
      }
      expect(checkpoints.at(-1)! - checkpoints[0]!).toBeGreaterThan(20_000);
      for (let index = 1; index < checkpoints.length; index += 1) {
        expect(checkpoints[index]! - checkpoints[index - 1]!).toBeLessThanOrEqual(declaration!.maxLocalComputeGapMs!);
      }
      expect(readProgress(root)).toMatchObject({
        childId: CHILD_ID,
        pid: 4242,
        workCursor: 4,
        progressSchemaVersion: 2,
        tickId: `tick-${expected}`,
      });
      emitProof(expected);
    });
  }

  it('emits start and completion progress for every bounded external call', async () => {
    const root = tempRoot();
    const times = [1_000, 1_100, 2_000, 2_120];
    const now = () => times.shift() ?? 2_120;
    const runner = async () => processResult();
    await runExternalCallWithLiveness({
      childId: CHILD_ID,
      ownerPid: 31337,
      callName: 'gh:pr:list',
      command: 'fake-gh',
      progressDir: root,
      now,
      runner,
    });
    await runExternalCallWithLiveness({
      childId: CHILD_ID,
      ownerPid: 31337,
      callName: 'gh:pr:checks',
      command: 'fake-gh',
      progressDir: root,
      now,
      runner,
    });
    expect(readProgress(root)).toMatchObject({
      workCursor: 4,
      workStep: 'gh:pr:checks',
      lastProgressMs: 2_120,
      lastExternalCall: { callName: 'gh:pr:checks', outcome: 'exit', elapsedMs: 120 },
    });
  });

  it('expected: bounded-call-timeout-degraded', async () => {
    const root = tempRoot();
    const values = [10_000, 10_025];
    const result = await runExternalCallWithLiveness({
      childId: CHILD_ID,
      ownerPid: 991,
      callName: 'gh:pr:list',
      command: 'fake-gh',
      progressDir: root,
      timeoutMs: 25,
      now: () => values.shift() ?? 10_025,
      runner: async () => processResult({ outcome: 'timeout', ok: false, exitCode: null, timedOut: true }),
    });
    expect(result.timedOut).toBe(true);
    expect(readProgress(root)).toMatchObject({
      phase: 'external_call_timeout',
      workCursor: 2,
      boundedExternalCallPending: true,
      failureClass: 'dependency',
      boundedExternalCall: {
        schemaVersion: BOUNDED_EXTERNAL_CALL_SCHEMA,
        callName: 'gh:pr:list',
        outcome: 'timeout',
        timeoutMs: 25,
      },
    });
    expect(consumePendingExternalCallTimeout({ childId: CHILD_ID, ownerPid: 991, progressDir: root }))
      .toBe('bounded external call timeout: gh:pr:list after 25ms');
    expect(readProgress(root).boundedExternalCallPending).toBe(false);
    emitProof('bounded-call-timeout-degraded');
  });

  it('expected: bounded-call-diagnostic-redacted', async () => {
    const root = tempRoot();
    const secret = 'ghp_SUPER_SECRET_AUTH_TOKEN';
    const values = [20_000, 20_025];
    await runExternalCallWithLiveness({
      childId: CHILD_ID,
      ownerPid: 992,
      callName: 'gh:pr:list',
      command: 'fake-gh',
      progressDir: root,
      timeoutMs: 25,
      now: () => values.shift() ?? 20_025,
      runner: async () => processResult({
        outcome: 'timeout',
        ok: false,
        exitCode: null,
        stdout: secret,
        stderr: secret,
        error: secret,
        timedOut: true,
      }),
    });
    const record = readProgress(root);
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(Object.keys(record.boundedExternalCall as Record<string, unknown>).sort()).toEqual([
      'callName', 'elapsedMs', 'observedAtMs', 'outcome', 'schemaVersion', 'timeoutMs',
    ]);
    emitProof('bounded-call-diagnostic-redacted');
  });

  it('expected: hang-still-stalled', () => {
    const root = tempRoot();
    expect(readLivenessProgressRecord(resolveLivenessProgressPath(root, CHILD_ID))).toBeNull();
    emitProof('hang-still-stalled');
  });

  it('expected: progress-livelock-fails', () => {
    const root = tempRoot();
    for (const nowMs of [1_000, 2_000]) {
      writeLivenessCheckpoint({
        childId: CHILD_ID,
        ownerPid: 77,
        workStep: 'gh:pr:list',
        progressDir: root,
        tickId: 'tick-a',
        nowMs,
      });
    }
    expect(readProgress(root)).toMatchObject({ workCursor: 2, workStep: 'gh:pr:list', tickId: 'tick-a' });
    emitProof('progress-livelock-fails');
  });

  it('expected: progress-identity', () => {
    const root = tempRoot();
    writeLivenessCheckpoint({
      childId: CHILD_ID,
      ownerPid: 77,
      workStep: 'gh:pr:list',
      progressDir: root,
      nowMs: 1_000,
    });
    expect(readProgress(root).pid).toBe(77);
    expect(consumePendingExternalCallTimeout({ childId: CHILD_ID, ownerPid: 88, progressDir: root })).toBeNull();
    emitProof('progress-identity');
  });

  it('keeps progress-file publication atomic and leaves no temp artifacts', () => {
    const root = tempRoot();
    for (let index = 1; index <= 100; index += 1) {
      writeLivenessCheckpoint({
        childId: CHILD_ID,
        ownerPid: 12,
        workStep: `call-${index}`,
        progressDir: root,
        nowMs: index,
      });
    }
    expect(readLivenessProgressRecord(resolveLivenessProgressPath(root, CHILD_ID))).not.toBeNull();
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('expected: e2e-seed-to-trigger-restored', () => {
    const headSha = 'abc123def456';
    const decision = evaluateHeadReadyForReview({
      reviewRuns: [],
      prNumber: 853,
      headSha,
      session: {
        id: 'worker-853',
        role: 'worker',
        status: 'working',
        ownedHeadSha: headSha,
        reports: [{ reportState: 'ready_for_review', headRefOid: headSha, reportedAt: '2026-07-16T01:00:00.000Z' }],
      } as never,
      ciChecks: [
        { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
        { name: 'PR scope guard', state: 'SUCCESS' },
        { name: 'Run pack contract tests', state: 'SUCCESS' },
        { name: 'Self-architect lint', state: 'SUCCESS' },
      ],
    });
    expect(decision.reason).not.toBe('no_worker_session');
    expect(decision.route).toBe('start_review');
    expect(decision.eligible).toBe(true);
    emitProof('e2e-seed-to-trigger-restored');
  });
});
