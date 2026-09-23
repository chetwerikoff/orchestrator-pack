import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  evaluateReadiness,
  NOT_READY,
  READY_TO_MERGE,
  type ReadinessInput,
} from './pr2-foundation/readiness-evaluator.ts';

const HEAD = 'a'.repeat(40);

function readyInput(): ReadinessInput {
  return {
    target: {
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 926,
      taskId: 'task-integration',
      assignmentId: 'wa-integration',
      assignmentGeneration: 2,
      prNumber: 2084,
      headSha: HEAD,
    },
    pr: {
      open: true,
      expectedTarget: true,
      prNumber: 2084,
      headSha: HEAD,
    },
    workerReports: [{
      accepted: true,
      repoSlug: 'chetwerikoff/orchestrator-pack',
      assignment: {
        assignmentId: 'wa-integration',
        generation: 2,
        taskId: 'task-integration',
      },
      prNumber: 2084,
      headSha: HEAD,
      reportState: 'ready_for_review',
      reportedAtMs: 10,
    }],
    workerStatuses: [{
      assignmentId: 'wa-integration',
      assignmentGeneration: 2,
      taskId: 'task-integration',
      issueNumber: 926,
      repository: 'chetwerikoff/orchestrator-pack',
      kind: 'local',
      localCapability: 'available',
      derivedStatus: 'idle',
      winningSource: 'runtime',
      stale: false,
      killSwitchActive: false,
      siblingReadinessOk: true,
    }],
    requiredCi: { headSha: HEAD, state: 'success' },
    review: {
      obligation: 'complete',
      unresolvedRequiredFinding: false,
      atCapOpenFindings: false,
      atCapContinuationRequired: false,
    },
    smoke: { headSha: HEAD, state: 'pass' },
  };
}

describe('Issue #926 delegated integration readiness contract', () => {
  it('uses the canonical readiness evaluator for the exact current integration assignment', () => {
    const result = evaluateReadiness(readyInput());
    expect(result.state).toBe(READY_TO_MERGE);
    expect(result.ready).toBe(true);
    expect(result.failedPredicates).toEqual([]);
    expect(result.lifecycle?.report.assignment).toMatchObject({
      assignmentId: 'wa-integration',
      generation: 2,
      taskId: 'task-integration',
    });
  });

  it.each([
    ['required CI is not green', (input: ReadinessInput) => ({
      ...input,
      requiredCi: { ...input.requiredCi, state: 'pending' as const },
    }), 'required_ci_not_green_for_current_head'],
    ['review obligation is incomplete', (input: ReadinessInput) => ({
      ...input,
      review: { ...input.review, obligation: 'missing' as const },
    }), 'review_obligation_incomplete'],
    ['a required finding is unresolved', (input: ReadinessInput) => ({
      ...input,
      review: { ...input.review, unresolvedRequiredFinding: true },
    }), 'unresolved_required_review_finding'],
    ['open findings remain at cap', (input: ReadinessInput) => ({
      ...input,
      review: { ...input.review, atCapOpenFindings: true },
    }), 'at_cap_open_findings'],
    ['continuation is still required at cap', (input: ReadinessInput) => ({
      ...input,
      review: { ...input.review, atCapContinuationRequired: true },
    }), 'at_cap_continuation_required'],
    ['exact-head smoke is missing', (input: ReadinessInput) => ({
      ...input,
      smoke: { ...input.smoke, state: 'missing' as const },
    }), 'exact_head_smoke_not_passed'],
    ['the PR head drifts', (input: ReadinessInput) => ({
      ...input,
      pr: { ...input.pr, headSha: 'b'.repeat(40) },
    }), 'pr_head_mismatch'],
    ['the current assignment loses corroborated lifecycle', (input: ReadinessInput) => ({
      ...input,
      workerStatuses: input.workerStatuses.map((status) => ({
        ...status,
        assignmentGeneration: 3,
      })),
    }), 'accepted_worker_lifecycle_missing_or_conflicting'],
    ['the current integration lifecycle becomes blocking', (input: ReadinessInput) => ({
      ...input,
      workerReports: input.workerReports.map((report) => ({
        ...report,
        reportState: 'addressing_reviews',
      })),
    }), 'worker_lifecycle_blocker:addressing_reviews'],
  ])('fails closed when %s', (_name, mutate, predicate) => {
    const result = evaluateReadiness(mutate(readyInput()));
    expect(result.state).toBe(NOT_READY);
    expect(result.ready).toBe(false);
    expect(result.failedPredicates).toContain(predicate);
  });
});

describe('Issue #926 delegated integration tracked procedure', () => {
  const skill = readFileSync('.cursor/skills/merge-with-local-adoption/SKILL.md', 'utf8');
  const runbook = readFileSync('docs/orchestrator-delegated-integration.md', 'utf8');
  const executorRules = readFileSync('docs/chat-executor-rules.md', 'utf8');
  const repairRunbook = readFileSync('docs/pack-review-waiver-merge-runbook.md', 'utf8');
  const smokeSource = readFileSync('scripts/worker-smoke-run.ts', 'utf8');

  it('binds delegated admission to the production post-smoke readiness owner instead of a second checklist', () => {
    expect(smokeSource).toContain('export async function evaluatePostSmokeReadiness');
    expect(smokeSource).toContain('const assignment = currentWorkerAssignment');
    expect(smokeSource).toContain('const readiness = evaluateReadiness({');
    expect(smokeSource).toContain('unresolvedRequiredFinding: postSmokeReview.unresolvedRequiredFinding');
    expect(smokeSource).toContain("smoke: { headSha: target.headSha, state: 'pass' }");

    expect(skill).toContain('evaluatePostSmokeReadiness()');
    expect(skill).toContain('readiness.state === READY_TO_MERGE');
    expect(skill).toContain('Do not reconstruct readiness');
  });

  it('keeps dependency sequencing live, explicit, serialized, and no-effect while waiting', () => {
    expect(runbook).toContain('Resolve only explicit relationships into');
    expect(runbook).toContain('`merge_now` or `wait_for_dependency`');
    expect(runbook).toContain('A `wait_for_dependency` decision launches no');
    expect(runbook).toContain('If another delegated');
    expect(runbook).toContain('integration assignment for that checkout is still active, wait.');
    expect(runbook).toContain('re-read dependency, readiness,');
    expect(skill).toContain('Require no second active delegated integration assignment');
  });

  it('admits only stale or missing pack-review projection repair after production READY_TO_MERGE', () => {
    expect(repairRunbook).toContain('Orchestrator-delegated projection repair (not a waiver)');
    expect(repairRunbook).toContain('evaluatePostSmokeReadiness()');
    expect(repairRunbook).toContain('`readiness.state === READY_TO_MERGE`');
    expect(repairRunbook).toContain('status is FAILURE or absent');
    expect(repairRunbook).toContain('If the status is already SUCCESS, do nothing.');
    expect(skill).toContain('FAILURE or absent');
    expect(skill).toContain('SUCCESS needs no repair');
    expect(skill).not.toContain('unknown/inconsistent');
    expect(runbook).not.toContain('inconsistent');
  });

  it('keeps delegated authority narrower than direct-user override', () => {
    expect(executorRules).toContain('A delegated worker never inherits the direct-user override.');
    expect(skill).toContain('It never inherits direct-user overrides.');
    expect(skill).toContain('Delegated-integration mode must not enter this subsection.');
  });

  it('requires independent local adoption discovery and report-only operational outcomes', () => {
    expect(runbook).toContain('Local-adoption prose is a');
    expect(runbook).toContain('hint only');
    expect(runbook).toContain('changed paths/content');
    expect(runbook).toContain('live operator-machine state');
    expect(runbook).toContain('source paths/config/runbooks and live observations');
    expect(runbook).toContain('`operationally_complete` or `operationally_incomplete`');
    expect(runbook).toContain('neither value is');
    expect(runbook).toContain('persisted as a WorkerReport state or in a new durable outcome store');
  });

  it('keeps post-merge recovery component-owned and fail-closed', () => {
    expect(runbook).toContain('For a post-merge failure, stop further mutation');
    expect(runbook).toContain('Restore a task-owned local mutation only when the');
    expect(runbook).toContain("component's current supported runbook/CLI/API already defines a compatible");
    expect(runbook).toContain('reverse/restore operation with read-back');
    expect(runbook).toContain('Do not invent a generic');
    expect(runbook).toContain('rollback/snapshot service');
  });
});
