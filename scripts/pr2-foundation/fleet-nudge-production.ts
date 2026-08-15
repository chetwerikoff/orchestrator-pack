import type { RuntimeAdapter } from '../runtime/contracts.ts';
import { sameRuntimeWorker } from '../runtime/contracts.ts';
import type { WorkerAssignment } from '../lib/worker-assignment-store.ts';
import { assignmentStillCurrent } from '../lib/worker-assignment-store.ts';
import type { ResolvedWorkerAssignment } from '../lib/worker-assignment-runtime.ts';
import {
  acquireS2OneShotWorkerNudgeClaim,
  finalizeS2OneShotWorkerNudgeClaim,
  markS2OneShotWorkerNudgeSendAttempted,
  persistWorkerNudgeMessageHash,
  pruneS2OneShotWorkerNudgeClaims,
  releaseS2OneShotWorkerNudgeClaim,
  workerNudgeClaimNamespace,
  type S2OneShotWorkerNudgeClaimHandle,
} from './worker-nudge-claim-store.ts';
import {
  admitS2FleetNudgeJournal,
  finalizeS2FleetNudgeJournal,
  type S2FleetNudgeJournalHandle,
} from './worker-dispatch-journal.ts';
import { resolveWorkerMessageDispatchJournalPath } from './wake-supervisor-state-root.ts';
import type {
  FleetNudgeEffects,
  FleetNudgeEpisode,
  FleetNudgeClaimHandle,
  FleetNudgeJournalHandle,
  RuntimeFleetNudgeBinding,
} from './fleet-nudge-actuator.ts';
import type { FleetAssignmentBinding } from './fleet-assignment-binding.ts';

interface ProductionBinding {
  readonly safe: FleetAssignmentBinding;
  readonly assignment: WorkerAssignment;
}

function claim(handle: FleetNudgeClaimHandle): S2OneShotWorkerNudgeClaimHandle {
  return handle.opaque as S2OneShotWorkerNudgeClaimHandle;
}

function journal(handle: FleetNudgeJournalHandle): S2FleetNudgeJournalHandle {
  return handle.opaque as S2FleetNudgeJournalHandle;
}

export function createProductionFleetNudgeEffects(input: {
  readonly projectId: string;
  readonly assignmentStorePath: string;
  readonly adapter: RuntimeAdapter;
  readonly resolvedAssignments: readonly ResolvedWorkerAssignment[];
  readonly fleetBindings: readonly FleetAssignmentBinding[];
  readonly assertEpoch: () => void;
  readonly env?: NodeJS.ProcessEnv;
}): FleetNudgeEffects {
  const pairs = new Map<string, ProductionBinding>();
  for (const safe of input.fleetBindings) {
    const resolved = input.resolvedAssignments.find((candidate) =>
      candidate.assignment.assignmentId === safe.assignmentId
      && candidate.assignment.generation === safe.assignmentGeneration
      && sameRuntimeWorker(candidate.worker.identity, safe.worker));
    if (resolved) pairs.set(safe.unitRef, { safe, assignment: resolved.assignment });
  }
  const claimNamespace = workerNudgeClaimNamespace(input.projectId);
  const journalPath = resolveWorkerMessageDispatchJournalPath({ env: input.env ?? process.env });

  const resolvePair = (unitRef: string): ProductionBinding | null => pairs.get(unitRef) ?? null;

  return {
    resolveTarget: (episode) => {
      const pair = resolvePair(episode.unitRef);
      if (!pair) return { status: 'target_unresolved' as const };
      if (!assignmentStillCurrent(input.assignmentStorePath, pair.assignment)) {
        return { status: 'target_stale' as const };
      }
      const binding: RuntimeFleetNudgeBinding = {
        ...episode,
        issueNumber: pair.safe.issueNumber,
        worker: pair.safe.worker,
      };
      return { status: 'resolved' as const, binding };
    },
    revalidate: (binding) => {
      const pair = resolvePair(binding.unitRef);
      if (!pair || pair.safe.issueNumber !== binding.issueNumber
        || !assignmentStillCurrent(input.assignmentStorePath, pair.assignment)) {
        return { status: 'revalidation_failed' as const };
      }
      const current = input.adapter.findWorker(binding.worker);
      return current.status === 'ok'
        && current.value !== null
        && sameRuntimeWorker(current.value.identity, binding.worker)
        ? { status: 'valid' as const }
        : { status: 'revalidation_failed' as const };
    },
    acquireClaim: async (episode, options) => {
      const result = await acquireS2OneShotWorkerNudgeClaim({
        projectId: episode.projectId,
        issueNumber: episode.issueNumber,
        schedulerGeneration: episode.schedulerGeneration,
        tickSequence: episode.tickSequence,
        transitionIdentity: episode.transitionIdentity,
        unitRef: episode.unitRef,
        eligibleClass: episode.eligibleClass,
        surface: 'pr2-scheduler',
        namespace: claimNamespace,
        deadlineMs: options.deadlineMs,
      });
      if (!result.acquired) {
        return {
          status: result.reason === 'claim_terminal' ? 'claim_terminal' as const : 'claim_untrusted' as const,
        };
      }
      return { status: 'acquired' as const, handle: { opaque: result } };
    },
    persistMessageHash: (handle, message, options) =>
      persistWorkerNudgeMessageHash(claim(handle), message, { deadlineMs: options.deadlineMs }),
    admitJournal: async (episode, message, options) => {
      const result = await admitS2FleetNudgeJournal({
        journalPath,
        episode: episode as FleetNudgeEpisode,
        message,
        deadlineMs: options.deadlineMs,
      });
      return result.status === 'admitted'
        ? { status: 'admitted' as const, handle: { opaque: result.handle } }
        : { status: 'claim_untrusted' as const };
    },
    markSendAttempted: (handle, options) =>
      markS2OneShotWorkerNudgeSendAttempted(claim(handle), {
        deadlineMs: options.deadlineMs,
        settlementDeadlineMs: options.settlementDeadlineMs,
      }),
    releaseClaim: (handle, options) =>
      releaseS2OneShotWorkerNudgeClaim(claim(handle), { deadlineMs: options.deadlineMs }),
    dispatch: (binding, message, options) => input.adapter.dispatchInput(
      { worker: binding.worker, text: message },
      { timeoutMs: Math.max(1, options.deadlineMs - Date.now()) },
    ),
    finalizeClaim: (handle, phase, options) =>
      finalizeS2OneShotWorkerNudgeClaim(
        claim(handle),
        phase,
        {},
        { deadlineMs: options.deadlineMs },
      ),
    finalizeJournal: (handle, outcome, options) =>
      finalizeS2FleetNudgeJournal(journal(handle), outcome, { deadlineMs: options.deadlineMs }),
    assertEpoch: input.assertEpoch,
    pruneClaims: ({ schedulerGeneration, tickSequence, deadlineMs }) => {
      pruneS2OneShotWorkerNudgeClaims({
        namespace: claimNamespace,
        schedulerGeneration,
        tickSequence,
        deadlineMs,
      });
    },
  };
}
