import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  type FleetEscalationSchedulerIdentityV1,
} from './fleet-escalation-delivery.ts';
import { runFleetEscalationProof } from './fleet-escalation-proof.ts';

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
    taskId: 'task-1260',
    assignmentId: 'assignment-1260',
    assignmentGeneration: 1,
    now: () => new Date(recordedAt),
  });
  if (!published.ok) throw new Error(published.reason);
  return published.record;
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

  it('proof CLI emits exactly one terminal JSON record and no external-send evidence', () => {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/pr2-foundation/fleet-escalation-proof.ts'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
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
