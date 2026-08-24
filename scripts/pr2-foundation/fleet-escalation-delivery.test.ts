import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess } from '../kernel/subprocess.ts';
import {
  OPERATOR_PRIMARY_PRE_ACTION_FAILURES,
  type OperatorPrimaryTargetFenceResult,
} from '../lib/operator-primary-target.ts';
import type { OperatorPublicationOutcome } from '../lib/operator-publication.ts';
import {
  bindOperatorPrimary,
  publishCurrentWorkerAssignment,
} from '../lib/worker-assignment-store.ts';
import type {
  RuntimeAdapter,
  RuntimeDispatchResult,
  RuntimeWorker,
  RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';
import {
  publishFleetReconciliationHandoff,
  type FleetReconciliationHandoff,
  type FleetReconciliationReason,
} from './fleet-reconciliation-handoff.ts';
import {
  canonicalFleetEscalationContent,
  closeFleetEscalationTargetFence,
  runFleetEscalationDelivery,
  type FleetEscalationInvocationResultV1,
  type FleetEscalationSchedulerIdentityV1,
} from './fleet-escalation-delivery.ts';
import { runFleetEscalationProof } from './fleet-escalation-proof.ts';
import { runSchedulerTick, type SchedulerBoundary } from './scheduler.ts';

const roots: string[] = [];
const projectId = 'orchestrator-pack';
const repository = 'chetwerikoff/orchestrator-pack';
const activationLineage = 'al-1260-test';
const schedulerGeneration = 'scheduler-generation-1260';
const reasons: readonly FleetReconciliationReason[] = [
  'target_unresolved',
  'target_stale',
  'observer_untrusted',
  'assignment_untrusted',
  'remote_not_applicable',
  'runtime_unavailable',
  'dispatch_unknown',
  'effect_untrusted',
];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-1260-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function expected(tickSequence: number): FleetEscalationSchedulerIdentityV1 {
  return { projectId, repository, activationLineage, schedulerGeneration, tickSequence };
}

function handoff(
  root: string,
  reason: FleetReconciliationReason = 'target_unresolved',
  tickSequence = 1,
  recordedAt = '2026-08-24T00:00:00.000Z',
  metadata: { taskId?: string; assignmentId?: string } = {},
): FleetReconciliationHandoff {
  const published = publishFleetReconciliationHandoff({
    file: path.join(root, `handoff-${tickSequence}-${reason}.json`),
    projectId,
    repository,
    activationLineage,
    schedulerGeneration,
    tickSequence,
    reason,
    role: 'worker',
    issueNumber: 1260,
    taskId: metadata.taskId ?? 'task-1260',
    assignmentId: metadata.assignmentId ?? 'assignment-1260',
    assignmentGeneration: 1,
    now: () => new Date(recordedAt),
  });
  if (!published.ok) throw new Error(published.reason);
  return published.record;
}

function epochEnv(root: string): NodeJS.ProcessEnv {
  const authority = path.join(root, 'epoch.json');
  const epochId = 'epoch-1260-test';
  const nonce = 'nonce-1260-test';
  writeFileSync(authority, JSON.stringify({
    schemaVersion: 1,
    currentEpochId: epochId,
    records: [{
      epochId,
      nonce,
      hostId: 'host-1260-test',
      repoRoot: process.cwd(),
      installedCommitSha: 'a'.repeat(40),
      snapshotDigests: {},
      importDigests: {},
      registryHash: 'a',
      preCommitLogDigest: 'b',
      commitAt: '2026-08-24T00:00:00.000Z',
    }],
  }), 'utf8');
  const schedulerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: authority,
    ORCHESTRATOR_CUTOVER_EPOCH_ID: epochId,
    ORCHESTRATOR_CUTOVER_NONCE: nonce,
  };
  return schedulerEnv;
}

function completeObserver(tickSequence: number) {
  return {
    result: 'census-published-observer-only' as const,
    status: 'complete' as const,
    snapshotCommitted: true,
    snapshotPath: '/tmp/observer-snapshot.json',
    schedulerGeneration,
    tickSequence,
    effectiveBudgetMs: 100,
    schedulerReturnedWithinBudget: true,
    staleCompletionRejected: false,
    fleetCapFailClosed: false,
    goneSemanticsClosed: true,
    exceptionCollisionRejected: false,
    zeroActuation: true as const,
  };
}

function targetUnresolvedNudge(tickSequence: number) {
  return {
    result: 'target-binding-unresolved-fail-closed' as const,
    status: 'complete' as const,
    schedulerGeneration,
    tickSequence,
    effectiveS2BudgetMs: 100,
    settlementReserveMs: 10,
    candidateOrder: ['unit-1260'],
    outcomes: [{ unitRef: 'unit-1260', class: 'idle' as const, outcome: 'target_unresolved' as const }],
    claimStarts: 0,
    sendAttempts: 0,
    dispatched: 0,
    returnedWithinBudget: true,
    targetBindingAvailable: false,
  };
}

function syntheticEscalation(
  publication: FleetEscalationInvocationResultV1['publication'],
  tickSequence = 1,
  reason: FleetReconciliationReason = 'target_unresolved',
): FleetEscalationInvocationResultV1 {
  const attempted = publication !== 'not_attempted';
  return {
    schema: 'fleet-escalation-invocation-result/v1',
    result: 'operator-escalation-only',
    ...expected(tickSequence),
    decision: attempted ? 'publish_attempted' : 'invalid_target',
    publication,
    reconciliationDecision: 'orchestrator_required',
    reason,
    invocationId: `synthetic-${publication}-${tickSequence}`,
    route: 'operator-primary',
    contentDigest: attempted ? 'd'.repeat(64) : null,
    contentBytes: attempted ? 128 : 0,
    attemptCount: attempted ? 1 : 0,
    diagnostics: [],
    retryAuthority: 'none',
  };
}

function worker(): RuntimeWorker {
  return {
    identity: { runtime: 'orca', id: 'operator-1260', generation: 'generation-1260' },
    workspacePath: '/test/operator-1260',
    title: null,
    provenance: 'internal',
  };
}

function sameIdentity(left: RuntimeWorkerIdentity, right: RuntimeWorkerIdentity): boolean {
  return left.runtime === right.runtime && left.id === right.id && left.generation === right.generation;
}

function adapterFixture(input: {
  dispatch?: RuntimeDispatchResult;
  throwDispatch?: boolean;
  bindingKey?: string;
} = {}): { adapter: RuntimeAdapter; calls: { dispatch: number; forbidden: number } } {
  const target = worker();
  const calls = { dispatch: 0, forbidden: 0 };
  const adapter: RuntimeAdapter = {
    id: 'orca',
    readiness: () => ({ status: 'ok', value: { ready: true, workspacePath: target.workspacePath } }),
    listWorkers: () => ({ status: 'ok', value: [target] }),
    findWorkerById: (id) => ({ status: 'ok', value: id === target.identity.id ? target : null }),
    findWorker: (identity) => ({ status: 'ok', value: sameIdentity(identity, target.identity) ? target : null }),
    resolveAssignmentWorker: ({ provider, bindingKey }) => ({
      status: 'ok',
      value: provider === 'orca' && bindingKey === (input.bindingKey ?? 'binding-1260')
        ? { kind: 'resolved', worker: target }
        : { kind: 'gone' },
    }),
    spawnWorker: () => {
      calls.forbidden += 1;
      return { status: 'failed', operation: 'spawn_worker', reason: 'forbidden' };
    },
    dispatchInput: () => {
      calls.dispatch += 1;
      if (input.throwDispatch) throw new Error('synthetic_dispatch_throw');
      return input.dispatch ?? { status: 'dispatched' };
    },
    readBoundedOutput: () => ({ status: 'failed', operation: 'read_bounded_output', reason: 'unused' }),
    liveness: ({ worker: identity }) => ({ status: 'unknown', worker: identity }),
    stopWorker: () => {
      calls.forbidden += 1;
      return { status: 'failed', operation: 'stop_worker', reason: 'forbidden' };
    },
    removeWorkspace: () => {
      calls.forbidden += 1;
      return { status: 'failed', operation: 'remove_workspace', reason: 'forbidden' };
    },
  };
  return { adapter, calls };
}

async function operatorAssignment(root: string): Promise<string> {
  const file = path.join(root, 'worker-assignments.json');
  const published = await publishCurrentWorkerAssignment({
    file,
    projectId,
    repository,
    issueNumber: 1260,
    taskId: 'operator-task-1260',
    kind: 'local',
    provider: 'orca',
    bindingKey: 'binding-1260',
    role: 'orchestrator',
    now: () => new Date('2026-08-24T00:00:00.000Z'),
  });
  if (!published.ok) throw new Error(published.reason);
  const bound = await bindOperatorPrimary({
    file,
    taskId: published.assignment.taskId,
    bindingKey: published.assignment.bindingKey,
  });
  if (!bound.ok) throw new Error(bound.reason);
  return file;
}

function invocation(
  evidence: FleetReconciliationHandoff | null,
  assignmentStorePath: string,
  adapter: RuntimeAdapter,
  tickSequence = 1,
  invocationId = 'invocation-1260',
) {
  return {
    evidence,
    committedReadBack: evidence !== null,
    expected: expected(tickSequence),
    assignmentStorePath,
    selectAdapter: async () => adapter,
    invocationId,
  } as const;
}

describe('fleet escalation delivery', () => {
  it('derives byte-identical canonical content from equivalent durable evidence', () => {
    const root = tempRoot();
    const first = canonicalFleetEscalationContent(handoff(root, 'target_unresolved', 1, '2026-08-24T00:00:00.000Z'));
    const second = canonicalFleetEscalationContent(handoff(root, 'target_unresolved', 1, '2026-08-24T00:01:00.000Z'));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.text).toBe(second?.text);
    expect(first?.digest).toBe(second?.digest);
    expect(first?.text).not.toContain('recordedAtUtc');
    expect(first?.text).not.toContain('invocation');
    expect(first?.bytes).toBeLessThanOrEqual(4_096);
  });

  it('fails closed before target resolution for digest-valid credential/token/authenticated-URL metadata', async () => {
    const root = tempRoot();
    let adapterSelections = 0;
    const sensitive = [
      { taskId: 'Bearer synthetic-secret-token' },
      { taskId: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890' },
      { taskId: 'token=synthetic-secret' },
      { assignmentId: 'https://user:password@example.invalid/reconciliation' },
    ];
    for (const [index, metadata] of sensitive.entries()) {
      const tickSequence = index + 1;
      const evidence = handoff(root, 'target_unresolved', tickSequence, '2026-08-24T00:00:00.000Z', metadata);
      expect(canonicalFleetEscalationContent(evidence)).toBeNull();
      const result = await runFleetEscalationDelivery({
        evidence,
        committedReadBack: true,
        expected: expected(tickSequence),
        assignmentStorePath: path.join(root, 'unused-assignments.json'),
        selectAdapter: async () => {
          adapterSelections += 1;
          return adapterFixture().adapter;
        },
        invocationId: `sensitive-${index}`,
      });
      expect(result).toMatchObject({
        decision: 'invalid_evidence',
        publication: 'not_attempted',
        attemptCount: 0,
      });
      expect(result.diagnostics).toContain('content_invalid');
    }
    expect(adapterSelections).toBe(0);
  });

  it('rejects uncommitted, corrupted, and mismatched evidence before target resolution', async () => {
    const root = tempRoot();
    const base = handoff(root);
    let adapterSelections = 0;
    const selectAdapter = async () => {
      adapterSelections += 1;
      return adapterFixture().adapter;
    };
    const cases = [
      { evidence: base, committedReadBack: false, expected: expected(1) },
      { evidence: { ...base, payloadDigest: '0'.repeat(64) }, committedReadBack: true, expected: expected(1) },
      { evidence: base, committedReadBack: true, expected: { ...expected(1), repository: 'other/repository' } },
    ];
    for (const row of cases) {
      const result = await runFleetEscalationDelivery({
        ...row,
        assignmentStorePath: path.join(root, 'unused-assignments.json'),
        selectAdapter,
        invocationId: 'invalid-evidence',
      });
      expect(result.decision).toBe('invalid_evidence');
      expect(result.publication).toBe('not_attempted');
      expect(result.attemptCount).toBe(0);
    }
    expect(adapterSelections).toBe(0);
  });

  it('inherits every current orchestrator_required reason without re-derivation', async () => {
    const root = tempRoot();
    const assignmentStorePath = await operatorAssignment(root);
    const fixture = adapterFixture();
    for (let index = 0; index < reasons.length; index += 1) {
      const reason = reasons[index]!;
      const tickSequence = index + 1;
      const result = await runFleetEscalationDelivery(invocation(
        handoff(root, reason, tickSequence),
        assignmentStorePath,
        fixture.adapter,
        tickSequence,
        `reason-${reason}`,
      ));
      expect(result.reason).toBe(reason);
      expect(result.decision).toBe('publish_attempted');
      expect(result.publication).toBe('submitted');
      expect(result.attemptCount).toBe(1);
      expect(result.retryAuthority).toBe('none');
    }
    expect(fixture.calls.dispatch).toBe(reasons.length);
    expect(fixture.calls.forbidden).toBe(0);
  });

  it.each([
    [{ status: 'dispatched' } as RuntimeDispatchResult, 'submitted'],
    [{ status: 'send_failed', reason: 'definite-no-send' } as RuntimeDispatchResult, 'pre_dispatch_failure'],
    [{ status: 'dispatch_unknown', reason: 'unknown-submit-truth' } as RuntimeDispatchResult, 'ambiguous'],
  ] as const)('preserves one publication attempt for %j', async (dispatch, expectedPublication) => {
    const root = tempRoot();
    const assignmentStorePath = await operatorAssignment(root);
    const fixture = adapterFixture({ dispatch });
    const result = await runFleetEscalationDelivery(invocation(
      handoff(root),
      assignmentStorePath,
      fixture.adapter,
    ));
    expect(result.publication).toBe(expectedPublication);
    expect(result.attemptCount).toBe(1);
    expect(fixture.calls.dispatch).toBe(1);
  });

  it('closes a synchronous publication throw as ambiguous without retry', async () => {
    const root = tempRoot();
    const assignmentStorePath = await operatorAssignment(root);
    const fixture = adapterFixture({ throwDispatch: true });
    const result = await runFleetEscalationDelivery(invocation(
      handoff(root),
      assignmentStorePath,
      fixture.adapter,
    ));
    expect(result.decision).toBe('publish_attempted');
    expect(result.publication).toBe('ambiguous');
    expect(result.attemptCount).toBe(1);
    expect(result.retryAuthority).toBe('none');
    expect(result.diagnostics).toContain('publication_threw');
    expect(fixture.calls.dispatch).toBe(1);
  });

  it('closes every landed pre-action target refusal as a zero-attempt invalid target', () => {
    const root = tempRoot();
    const canonical = canonicalFleetEscalationContent(handoff(root));
    if (!canonical) throw new Error('canonical_fixture_failed');
    for (const reason of OPERATOR_PRIMARY_PRE_ACTION_FAILURES) {
      const fence: OperatorPrimaryTargetFenceResult<OperatorPublicationOutcome> = {
        ok: false,
        actionEntered: false,
        reason,
      };
      const result = closeFleetEscalationTargetFence(expected(1), 'pre-action', canonical, fence);
      expect(result.decision).toBe('invalid_target');
      expect(result.publication).toBe('not_attempted');
      expect(result.attemptCount).toBe(0);
      expect(result.diagnostics).toContain(reason);
    }
  });

  it('uses the real target producer to refuse an absent binding before publication', async () => {
    const root = tempRoot();
    const fixture = adapterFixture();
    const result = await runFleetEscalationDelivery(invocation(
      handoff(root),
      path.join(root, 'absent-worker-assignments.json'),
      fixture.adapter,
    ));
    expect(result.decision).toBe('invalid_target');
    expect(result.publication).toBe('not_attempted');
    expect(result.attemptCount).toBe(0);
    expect(result.diagnostics).toContain('binding_absent');
    expect(fixture.calls.dispatch).toBe(0);
  });

  it.each(['action_failed', 'action_result_invalid'] as const)(
    'conservatively closes entered %s as ambiguous with no retry',
    (reason) => {
      const root = tempRoot();
      const canonical = canonicalFleetEscalationContent(handoff(root));
      if (!canonical) throw new Error('canonical_fixture_failed');
      const fence: OperatorPrimaryTargetFenceResult<OperatorPublicationOutcome> = {
        ok: false,
        actionEntered: true,
        reason,
      };
      const result = closeFleetEscalationTargetFence(expected(1), 'entered-failure', canonical, fence);
      expect(result.decision).toBe('publish_attempted');
      expect(result.publication).toBe('ambiguous');
      expect(result.attemptCount).toBe(1);
      expect(result.retryAuthority).toBe('none');
    },
  );

  it('permits duplicate explicit invocations without adding retry or dedup authority', async () => {
    const root = tempRoot();
    const assignmentStorePath = await operatorAssignment(root);
    const evidence = handoff(root);
    const fixture = adapterFixture();
    const first = await runFleetEscalationDelivery(invocation(
      evidence,
      assignmentStorePath,
      fixture.adapter,
      1,
      'explicit-1',
    ));
    const second = await runFleetEscalationDelivery(invocation(
      evidence,
      assignmentStorePath,
      fixture.adapter,
      1,
      'explicit-2',
    ));
    expect(first.contentDigest).toBe(second.contentDigest);
    expect(first.invocationId).not.toBe(second.invocationId);
    expect(fixture.calls.dispatch).toBe(2);
    expect(first.retryAuthority).toBe('none');
    expect(second.retryAuthority).toBe('none');
  });

  it.each(['timeout', 'throw'] as const)(
    'routes observer %s handoff through S3 exactly once and returns the caller-visible result',
    async (mode) => {
      const root = tempRoot();
      let handoffCalls = 0;
      let escalationCalls = 0;
      let cancelCalls = 0;
      const boundary: SchedulerBoundary = {
        projectId,
        repository,
        activationLineage,
        schedulerIntervalMs: 4,
        listCandidates: () => { throw new Error('review_loop_must_not_run'); },
        readCurrentPr: async () => { throw new Error('read_pr_must_not_run'); },
        readChecks: async () => { throw new Error('read_checks_must_not_run'); },
        listReviewRuns: () => [],
        start: async () => { throw new Error('start_must_not_run'); },
        fleetObserver: {
          schedulerGeneration,
          getEffectiveBudgetMs: () => 1,
          cancel: () => { cancelCalls += 1; },
          tick: mode === 'timeout'
            ? async () => new Promise<never>(() => {})
            : async () => { throw new Error('synthetic_observer_throw'); },
        },
        publishHandoff: ({ reason, tickSequence }) => {
          handoffCalls += 1;
          const record = handoff(root, reason, tickSequence);
          return { ok: true, record };
        },
        fleetEscalation: async ({ evidence, expected: identity }) => {
          escalationCalls += 1;
          expect(evidence?.reason).toBe('observer_untrusted');
          expect(identity.tickSequence).toBe(1);
          return syntheticEscalation('submitted', identity.tickSequence, 'observer_untrusted');
        },
      };
      const result = await runSchedulerTick(boundary, epochEnv(root));
      expect(result).toMatchObject({
        attempted: 0,
        started: 0,
        skipped: 0,
        orchestratorRequired: true,
        fleetEscalation: {
          reason: 'observer_untrusted',
          publication: 'submitted',
          attemptCount: 1,
        },
      });
      expect(handoffCalls).toBe(1);
      expect(escalationCalls).toBe(1);
      expect(cancelCalls).toBe(1);
    },
  );

  it('returns the S3 result when S2 fails after the admitted handoff instead of throwing it away', async () => {
    const root = tempRoot();
    let escalationCalls = 0;
    const boundary: SchedulerBoundary = {
      projectId,
      repository,
      activationLineage,
      listCandidates: () => { throw new Error('review_loop_must_not_run'); },
      readCurrentPr: async () => { throw new Error('read_pr_must_not_run'); },
      readChecks: async () => { throw new Error('read_checks_must_not_run'); },
      listReviewRuns: () => [],
      start: async () => { throw new Error('start_must_not_run'); },
      fleetObserver: {
        schedulerGeneration,
        tick: async (input) => completeObserver(input.tickSequence ?? 1),
      },
      fleetNudgeActuator: {
        tick: async (input) => ({
          result: 'observer-untrusted',
          status: 'failed',
          schedulerGeneration,
          tickSequence: input.tickSequence,
          effectiveS2BudgetMs: 1,
          settlementReserveMs: 1,
          candidateOrder: [],
          outcomes: [],
          claimStarts: 0,
          sendAttempts: 0,
          dispatched: 0,
          returnedWithinBudget: true,
          targetBindingAvailable: false,
        }),
      },
      publishHandoff: ({ reason, tickSequence }) => ({
        ok: true,
        record: handoff(root, reason, tickSequence),
      }),
      fleetEscalation: async ({ expected: identity }) => {
        escalationCalls += 1;
        return syntheticEscalation('submitted', identity.tickSequence, 'observer_untrusted');
      },
    };
    const result = await runSchedulerTick(boundary, epochEnv(root));
    expect(result).toMatchObject({
      attempted: 0,
      started: 0,
      skipped: 0,
      orchestratorRequired: true,
      fleetNudge: { status: 'failed', result: 'observer-untrusted' },
      fleetEscalation: { publication: 'submitted', attemptCount: 1 },
    });
    expect(escalationCalls).toBe(1);
  });

  it('keeps review candidate order, reads, decisions, counters, and start sequence independent of S3 outcome', async () => {
    const outcomes = [
      syntheticEscalation('submitted'),
      syntheticEscalation('pre_dispatch_failure'),
      syntheticEscalation('ambiguous'),
      syntheticEscalation('not_attempted'),
    ];
    let baselineEvents: string[] | undefined;
    for (const outcome of outcomes) {
      const root = tempRoot();
      const events: string[] = [];
      const head = 'c'.repeat(40);
      const boundary: SchedulerBoundary = {
        projectId,
        repository,
        activationLineage,
        listCandidates: () => {
          events.push('listCandidates');
          return [{ sessionId: 'worker-1260', repoSlug: repository, prNumber: 1609, boundHeadSha: head }];
        },
        readCurrentPr: async () => {
          events.push('readCurrentPr');
          return { number: 1609, headRefOid: head, state: 'OPEN', isDraft: false, body: 'Closes #1260' };
        },
        readChecks: async () => {
          events.push('readChecks');
          return [
            { name: 'verify orchestrator-pack structure', state: 'success' },
            { name: 'pr scope guard', state: 'success' },
            { name: 'run pack contract tests', state: 'success' },
            { name: 'self-architect lint', state: 'success' },
          ];
        },
        listReviewRuns: () => {
          events.push('listReviewRuns');
          return [];
        },
        start: async () => {
          events.push('start');
          return { ok: true };
        },
        fleetObserver: {
          schedulerGeneration,
          tick: async (input) => {
            events.push('fleetObserver');
            return completeObserver(input.tickSequence ?? 1);
          },
        },
        fleetNudgeActuator: {
          tick: async (input) => {
            events.push('fleetNudge');
            return targetUnresolvedNudge(input.tickSequence);
          },
        },
        publishHandoff: ({ reason, tickSequence }) => {
          events.push('publishHandoff');
          return { ok: true, record: handoff(root, reason, tickSequence) };
        },
        fleetEscalation: async () => {
          events.push('fleetEscalation');
          return outcome;
        },
      };
      const result = await runSchedulerTick(boundary, epochEnv(root));
      expect(result).toMatchObject({ attempted: 1, started: 1, skipped: 0 });
      if (baselineEvents === undefined) baselineEvents = [...events];
      else expect(events).toEqual(baselineEvents);
    }
  });

  it('returns the production-wired proof through the real scheduler result surface', async () => {
    const proof = await runFleetEscalationProof();
    expect(proof.schema).toBe('fleet-escalation-proof/v1');
    expect(proof.datum).toBe('$.fleetEscalation.result');
    expect(proof.expected).toBe('operator-escalation-only');
    expect(proof.productionBoundary).toBe('scheduler-to-current-operator-publication-seam');
    expect(proof.resultSurface).toBe('runSchedulerTick-return');
    expect(proof.fleetEscalation.result).toBe('operator-escalation-only');
    expect(proof.publication).toBe('submitted');
    expect(proof.attemptCount).toBe(1);
    expect(proof.forbiddenActuatorCalls).toBe(0);
    expect(proof.aoOrPowerShellCalls).toBe(0);
    expect(proof.retryAuthority).toBe('none');
    expect('evidenceRecording' in proof.fleetEscalation).toBe(false);
  });

  it('proof CLI emits exactly one terminal JSON record and no external-send evidence', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ['--experimental-strip-types', 'scripts/pr2-foundation/fleet-escalation-proof.ts'],
      cwd: process.cwd(),
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs: 30_000,
    });
    expect(result.ok).toBe(true);
    expect(result.stderr).toBe('');
    const lines = result.stdout.trim().split(/\r?\n/u);
    expect(lines).toHaveLength(1);
    const proof = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(proof.schema).toBe('fleet-escalation-proof/v1');
    expect(proof.producer).toBe('orchestrator-pack');
    expect(proof.datum).toBe('$.fleetEscalation.result');
    expect(proof.expected).toBe('operator-escalation-only');
    expect(proof.forbiddenActuatorCalls).toBe(0);
    expect(proof.aoOrPowerShellCalls).toBe(0);
    expect(proof.retryAuthority).toBe('none');
  });

  it('keeps production S3 source on the single landed publication seam', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'scripts/pr2-foundation/fleet-escalation-delivery.ts'),
      'utf8',
    );
    expect(source.match(/publishOperatorMessageOnce\(/gu)).toHaveLength(1);
    expect(source).not.toContain('.ps1');
    expect(source).not.toContain('spawnWorker(');
    expect(source).not.toContain('stopWorker(');
    expect(source).not.toContain('removeWorkspace(');
    expect(source).not.toContain('startPackReview(');
    expect(source).not.toContain('evidenceRecording');
  });
});
