import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FileEpochAuthority,
  buildEpochCommitCore,
} from '../lib/cutover/activation-epoch-authority.ts';
import {
  bindOperatorPrimary,
  publishCurrentWorkerAssignment,
} from '../lib/worker-assignment-store.ts';
import type {
  RuntimeAdapter,
  RuntimeWorker,
  RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';
import {
  publishFleetReconciliationHandoff,
} from './fleet-reconciliation-handoff.ts';
import {
  runFleetEscalationDelivery,
  type FleetEscalationInvocationResultV1,
} from './fleet-escalation-delivery.ts';
import {
  runSchedulerTick,
  schedulerActivationLineage,
  type SchedulerBoundary,
} from './scheduler.ts';

export const FLEET_ESCALATION_PROOF_SCHEMA = 'fleet-escalation-proof/v1' as const;

export interface FleetEscalationProofV1 {
  readonly schema: typeof FLEET_ESCALATION_PROOF_SCHEMA;
  readonly producer: 'orchestrator-pack';
  readonly datum: '$.fleetEscalation.result';
  readonly expected: 'operator-escalation-only';
  readonly productionBoundary: 'scheduler-to-current-operator-publication-seam';
  readonly resultSurface: 'runSchedulerTick-return';
  readonly fleetEscalation: FleetEscalationInvocationResultV1;
  readonly attemptCount: 0 | 1;
  readonly publication: FleetEscalationInvocationResultV1['publication'];
  readonly forbiddenActuatorCalls: number;
  readonly aoOrPowerShellCalls: 0;
  readonly retryAuthority: 'none';
}

function exactWorker(): RuntimeWorker {
  return {
    identity: {
      runtime: 'orca',
      id: 'proof-operator',
      generation: 'proof-generation',
    },
    workspacePath: '/proof/operator',
    title: null,
    provenance: 'internal',
  };
}

function sameIdentity(left: RuntimeWorkerIdentity, right: RuntimeWorkerIdentity): boolean {
  return left.runtime === right.runtime
    && left.id === right.id
    && left.generation === right.generation;
}

export async function runFleetEscalationProof(): Promise<FleetEscalationProofV1> {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-1260-proof-'));
  let forbiddenActuatorCalls = 0;
  let publicationCalls = 0;
  try {
    const epochAuthorityPath = path.join(root, 'epoch-authority.json');
    const epochId = 'epoch-1260-proof';
    const nonce = 'nonce-1260-proof';
    const authority = new FileEpochAuthority(epochAuthorityPath);
    authority.commit(null, buildEpochCommitCore({
      epochId,
      nonce,
      hostId: 'proof-host',
      repoRoot: process.cwd(),
      installedCommitSha: 'a'.repeat(40),
      snapshotDigests: {
        reconcile: 'proof-reconcile-snapshot',
        reevaluation: 'proof-reevaluation-snapshot',
        reportStateSeed: 'proof-report-seed-snapshot',
      },
      importDigests: {
        reconcile: 'proof-reconcile-import',
        reevaluation: 'proof-reevaluation-import',
        reportStateSeed: 'proof-report-seed-import',
      },
      registryHash: 'proof-registry-hash',
      preCommitLogDigest: 'proof-pre-commit-log',
      commitAt: '2026-08-24T00:00:00.000Z',
    }));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: epochAuthorityPath,
      ORCHESTRATOR_CUTOVER_EPOCH_ID: epochId,
      ORCHESTRATOR_CUTOVER_NONCE: nonce,
    };
    const activationLineage = schedulerActivationLineage({ epochId, nonce });
    const repository = 'chetwerikoff/orchestrator-pack';
    const projectId = 'orchestrator-pack';
    const assignmentStorePath = path.join(root, 'worker-assignments.json');
    const assignment = await publishCurrentWorkerAssignment({
      file: assignmentStorePath,
      projectId,
      repository,
      issueNumber: 1260,
      taskId: 'issue-1260-proof',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'proof-dispatch',
      role: 'orchestrator',
      now: () => new Date('2026-08-24T00:00:00.000Z'),
    });
    if (!assignment.ok) throw new Error(`proof_assignment_failed:${assignment.reason}`);
    const bound = await bindOperatorPrimary({
      file: assignmentStorePath,
      taskId: assignment.assignment.taskId,
      bindingKey: assignment.assignment.bindingKey,
    });
    if (!bound.ok) throw new Error(`proof_operator_binding_failed:${bound.reason}`);

    const worker = exactWorker();
    const adapter: RuntimeAdapter = {
      id: 'orca',
      readiness: () => ({ status: 'ok', value: { ready: true, workspacePath: worker.workspacePath } }),
      listWorkers: () => ({ status: 'ok', value: [worker] }),
      findWorkerById: (id) => ({ status: 'ok', value: id === worker.identity.id ? worker : null }),
      findWorker: (identity) => ({ status: 'ok', value: sameIdentity(identity, worker.identity) ? worker : null }),
      resolveAssignmentWorker: (input) => ({
        status: 'ok',
        value: input.provider === 'orca' && input.bindingKey === 'proof-dispatch'
          ? { kind: 'resolved', worker }
          : { kind: 'gone' },
      }),
      spawnWorker: () => {
        forbiddenActuatorCalls += 1;
        return { status: 'failed', operation: 'spawn_worker', reason: 'forbidden_in_proof' };
      },
      dispatchInput: ({ worker: target }) => {
        publicationCalls += 1;
        if (!sameIdentity(target, worker.identity)) {
          return { status: 'send_failed', reason: 'wrong_proof_target' };
        }
        return { status: 'dispatched' };
      },
      readBoundedOutput: () => ({ status: 'failed', operation: 'read_bounded_output', reason: 'unused_in_proof' }),
      liveness: ({ worker: target }) => ({ status: 'unknown', worker: target }),
      stopWorker: (target) => {
        forbiddenActuatorCalls += 1;
        return { status: 'failed', operation: 'stop_worker', reason: `forbidden_in_proof:${target.id}` };
      },
      removeWorkspace: () => {
        forbiddenActuatorCalls += 1;
        return { status: 'failed', operation: 'remove_workspace', reason: 'forbidden_in_proof' };
      },
    };

    const schedulerGeneration = 'scheduler-generation-proof';
    const handoffPath = path.join(root, 'fleet-reconciliation-handoff.json');
    const boundary: SchedulerBoundary = {
      projectId,
      repository,
      activationLineage,
      schedulerIntervalMs: 5_000,
      listCandidates: () => [],
      readCurrentPr: async () => { throw new Error('proof_read_pr_unreachable'); },
      readChecks: async () => { throw new Error('proof_read_checks_unreachable'); },
      listReviewRuns: () => [],
      start: async () => {
        forbiddenActuatorCalls += 1;
        return { ok: false, reason: 'forbidden_in_proof' };
      },
      fleetObserver: {
        schedulerGeneration,
        tick: async (input) => ({
          result: 'census-published-observer-only',
          status: 'complete',
          snapshotCommitted: true,
          snapshotPath: path.join(root, 'proof-observer-snapshot.json'),
          schedulerGeneration,
          tickSequence: input.tickSequence ?? 1,
          effectiveBudgetMs: 100,
          schedulerReturnedWithinBudget: true,
          staleCompletionRejected: false,
          fleetCapFailClosed: false,
          goneSemanticsClosed: true,
          exceptionCollisionRejected: false,
          zeroActuation: true,
        }),
      },
      fleetNudgeActuator: {
        tick: async (input) => ({
          result: 'target-binding-unresolved-fail-closed',
          status: 'complete',
          schedulerGeneration,
          tickSequence: input.tickSequence,
          effectiveS2BudgetMs: 100,
          settlementReserveMs: 10,
          candidateOrder: ['proof-unit'],
          outcomes: [{
            unitRef: 'proof-unit',
            class: 'idle',
            outcome: 'target_unresolved',
          }],
          claimStarts: 0,
          sendAttempts: 0,
          dispatched: 0,
          returnedWithinBudget: true,
          targetBindingAvailable: false,
        }),
      },
      publishHandoff: ({ reason, schedulerGeneration: generation, tickSequence }) => {
        const published = publishFleetReconciliationHandoff({
          file: handoffPath,
          projectId,
          repository,
          activationLineage,
          schedulerGeneration: generation,
          tickSequence,
          reason,
          role: 'orchestrator',
          issueNumber: 1260,
          taskId: assignment.assignment.taskId,
          assignmentId: assignment.assignment.assignmentId,
          assignmentGeneration: assignment.assignment.generation,
          now: () => new Date('2026-08-24T00:00:01.000Z'),
        });
        return published.ok
          ? { ok: true, record: published.record }
          : { ok: false, reason: published.reason };
      },
      fleetEscalation: (invocation) => runFleetEscalationDelivery({
        ...invocation,
        assignmentStorePath,
        selectAdapter: async () => adapter,
        invocationId: 'fleet-escalation-proof-invocation',
      }),
    };

    const schedulerResult = await runSchedulerTick(boundary, env);
    const fleetEscalation = schedulerResult.fleetEscalation;
    if (!fleetEscalation) throw new Error('proof_fleet_escalation_missing');
    if (fleetEscalation.result !== 'operator-escalation-only') {
      throw new Error(`proof_result_invalid:${fleetEscalation.result}`);
    }
    if (publicationCalls !== 1) throw new Error(`proof_publication_call_count:${publicationCalls}`);
    if (fleetEscalation.attemptCount !== 1) {
      throw new Error(`proof_attempt_count:${fleetEscalation.attemptCount}`);
    }
    if (fleetEscalation.publication !== 'submitted') {
      throw new Error(`proof_publication_result:${fleetEscalation.publication}`);
    }
    if (forbiddenActuatorCalls !== 0) {
      throw new Error(`proof_forbidden_actuator_calls:${forbiddenActuatorCalls}`);
    }

    return {
      schema: FLEET_ESCALATION_PROOF_SCHEMA,
      producer: 'orchestrator-pack',
      datum: '$.fleetEscalation.result',
      expected: 'operator-escalation-only',
      productionBoundary: 'scheduler-to-current-operator-publication-seam',
      resultSurface: 'runSchedulerTick-return',
      fleetEscalation,
      attemptCount: fleetEscalation.attemptCount,
      publication: fleetEscalation.publication,
      forbiddenActuatorCalls,
      aoOrPowerShellCalls: 0,
      retryAuthority: fleetEscalation.retryAuthority,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('fleet-escalation-proof.ts')) {
  runFleetEscalationProof()
    .then((record) => {
      process.stdout.write(`${JSON.stringify(record)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
