import { describe, expect, it } from 'vitest';
import {
  evaluateReadiness,
  READY_TO_MERGE,
  type ReadinessInput,
} from './readiness-evaluator.ts';

const head = 'a'.repeat(40);
const target = {
  repository: 'chetwerikoff/orchestrator-pack',
  issueNumber: 1419,
  taskId: 'task_1419',
  assignmentId: 'assignment_1419',
  assignmentGeneration: 3,
  prNumber: 1708,
  headSha: head,
} as const;

function readyInput(kind: 'local' | 'remote' = 'local'): ReadinessInput {
  return {
    target,
    pr: { open: true, expectedTarget: true, prNumber: target.prNumber, headSha: head },
    workerReports: [{
      accepted: true,
      repoSlug: target.repository,
      assignment: { assignmentId: target.assignmentId, generation: target.assignmentGeneration, taskId: target.taskId },
      prNumber: target.prNumber,
      headSha: head,
      reportState: 'ready_for_review',
      reportedAtMs: 100,
    }],
    workerStatuses: [{
      assignmentId: target.assignmentId,
      assignmentGeneration: target.assignmentGeneration,
      taskId: target.taskId,
      issueNumber: target.issueNumber,
      repository: target.repository,
      kind,
      localCapability: kind === 'local' ? 'available' : 'not_applicable',
      derivedStatus: kind === 'local' ? 'idle' : 'unknown',
      winningSource: kind === 'local' ? 'runtime' : 'worker_assignment',
      stale: false,
      degradedReason: '',
      killSwitchActive: false,
      siblingReadinessOk: true,
    }],
    requiredCi: { headSha: head, state: 'success' },
    review: {
      obligation: 'complete',
      unresolvedRequiredFinding: false,
      atCapOpenFindings: false,
      atCapContinuationRequired: false,
    },
    smoke: { headSha: head, state: 'pass' },
  };
}

describe('ReadinessEvaluator', () => {
  it('derives READY_TO_MERGE only from the complete current-fact predicate set', () => {
    const result = evaluateReadiness(readyInput());
    expect(result.state).toBe(READY_TO_MERGE);
    expect(result.ready).toBe(true);
    expect(result.failedPredicates).toEqual([]);
    expect(result.lifecycle?.state).toBe('ready_for_review');
  });

  it('accepts the landed remote WorkerStatus projection without inventing lifecycle state', () => {
    const input = readyInput('remote');
    expect(input.workerStatuses[0]?.derivedStatus).toBe('unknown');
    expect(evaluateReadiness(input).ready).toBe(true);
  });

  it.each(['working', 'pr_created', 'started', 'fixing_ci', 'addressing_reviews', 'blocked'])(
    'treats accepted %s WorkerReport lifecycle as a current material blocker',
    (state) => {
      const base = readyInput();
      const input: ReadinessInput = {
        ...base,
        workerReports: [{ ...base.workerReports[0], reportState: state }],
      };
      expect(evaluateReadiness(input).failedPredicates).toContain(`worker_lifecycle_blocker:${state}`);
    },
  );

  it('fails closed for stale or mismatched WorkerReport/WorkerStatus identity', () => {
    const base = readyInput();
    const stale: ReadinessInput = {
      ...base,
      workerReports: [{ ...base.workerReports[0], headSha: 'b'.repeat(40) }],
    };
    expect(evaluateReadiness(stale).failedPredicates).toContain('accepted_worker_lifecycle_missing_or_conflicting');

    const conflicting: ReadinessInput = {
      ...base,
      workerStatuses: [{ ...base.workerStatuses[0], stale: true }],
    };
    expect(evaluateReadiness(conflicting).failedPredicates).toContain('accepted_worker_lifecycle_missing_or_conflicting');
  });

  it('uses WorkerReportStore lifecycle as authority rather than WorkerStatus runtime status', () => {
    const base = readyInput();
    const input: ReadinessInput = {
      ...base,
      workerStatuses: [{ ...base.workerStatuses[0], derivedStatus: 'busy' }],
    };
    expect(evaluateReadiness(input).ready).toBe(true);
  });

  it('rejects duplicate current WorkerStatus corroboration instead of choosing a competing projection', () => {
    const base = readyInput();
    const input: ReadinessInput = {
      ...base,
      workerStatuses: [...base.workerStatuses, { ...base.workerStatuses[0] }],
    };
    expect(evaluateReadiness(input).failedPredicates).toContain('accepted_worker_lifecycle_missing_or_conflicting');
  });

  it('ignores unrelated assignment status rows and accepts exactly one matching corroboration', () => {
    const base = readyInput();
    const input: ReadinessInput = {
      ...base,
      workerStatuses: [
        ...base.workerStatuses,
        { ...base.workerStatuses[0], assignmentId: 'unrelated-assignment', localCapability: 'degraded', stale: true },
      ],
    };
    expect(evaluateReadiness(input).ready).toBe(true);
  });

  it('fails closed for degraded, kill-switched, or sibling-unready status projections', () => {
    const base = readyInput();
    for (const status of [
      { ...base.workerStatuses[0], degradedReason: 'target_unresolved' },
      { ...base.workerStatuses[0], killSwitchActive: true },
      { ...base.workerStatuses[0], siblingReadinessOk: false },
    ]) {
      const input: ReadinessInput = { ...base, workerStatuses: [status] };
      expect(evaluateReadiness(input).failedPredicates).toContain('accepted_worker_lifecycle_missing_or_conflicting');
    }
  });

  it('fails closed for missing/unknown current CI, review, cap, finding, or smoke facts', () => {
    const base = readyInput();
    const input: ReadinessInput = {
      ...base,
      requiredCi: { headSha: head, state: 'unknown' },
      review: {
        obligation: 'unknown',
        unresolvedRequiredFinding: 'unknown',
        atCapOpenFindings: 'unknown',
        atCapContinuationRequired: 'unknown',
      },
      smoke: { headSha: head, state: 'unknown' },
    };
    const failures = evaluateReadiness(input).failedPredicates;
    expect(failures).toContain('required_ci_not_green_for_current_head');
    expect(failures).toContain('review_obligation_incomplete');
    expect(failures).toContain('unresolved_required_review_finding');
    expect(failures).toContain('at_cap_open_findings');
    expect(failures).toContain('at_cap_continuation_required');
    expect(failures).toContain('exact_head_smoke_not_passed');
  });

  it('does not require optional direct-review finding ids or correlation metadata', () => {
    const input = readyInput();
    expect(Object.hasOwn(input.review, 'findingId')).toBe(false);
    expect(evaluateReadiness(input).ready).toBe(true);
  });
});
