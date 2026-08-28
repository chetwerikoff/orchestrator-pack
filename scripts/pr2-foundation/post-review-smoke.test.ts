// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  publishCurrentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
  type WorkerAssignment,
} from '../lib/worker-assignment-store.ts';
import {
  commitPackReviewTerminal,
  commitPackReviewTriage,
  commitSmokeOrderingTransition,
  initializePackReviewAuthority,
  listPackReviewImmutableRecords,
  observePackReviewHead,
  recordPackReviewPublication,
  type PackReviewAuthorityDocument,
  type PackReviewAuthorityOptions,
  type PackReviewTier,
} from '../pack-review-state.ts';
import {
  createPackReviewRun,
  setPackReviewRunTerminal,
} from '../lib/pack-review-run-store.ts';
import type { RuntimeAdapter } from '../runtime/contracts.ts';
import { DeterministicRuntimeAdapter } from '../runtime/test-adapter.ts';
import {
  reconcilePostReviewSmoke,
  reviewStageDisposition,
  type PostReviewSmokeDependencies,
} from './post-review-smoke.ts';

const REPOSITORY = 'chetwerikoff/orchestrator-pack';
const ISSUE = 1418;
const PR = 1481;
const HEAD = 'c'.repeat(40);
const NEXT_HEAD = 'd'.repeat(40);
const roots: string[] = [];

function rootFixture(): {
  root: string;
  reviewStoreRoot: string;
  assignmentStorePath: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-post-review-smoke-test-'));
  roots.push(root);
  return {
    root,
    reviewStoreRoot: path.join(root, 'review-store'),
    assignmentStorePath: resolveWorkerAssignmentStorePath('orchestrator-pack', {
      ...process.env,
      OPK_BASE_DIR: root,
    }),
  };
}

function initializeReview(options: PackReviewAuthorityOptions, tier: PackReviewTier = 'T3') {
  return initializePackReviewAuthority({
    prNumber: PR,
    headSha: HEAD,
    tier,
    options,
  });
}

function settleReview(options: PackReviewAuthorityOptions) {
  const authority = initializeReview(options);
  const terminal = commitPackReviewTerminal({
    prNumber: PR,
    expectedTransitionSeq: authority.transitionSeq,
    terminal: {
      schemaVersion: 1,
      terminalContractVersion: 2,
      terminalSource: 'normal',
      runId: 'review-run-1418',
      targetSha: HEAD,
      reviewVerdict: 'clean',
      findingCount: 0,
      findingsDigest: 'clean-findings-digest',
    },
    status: 'up_to_date',
    findingCount: 0,
    options,
  });
  return recordPackReviewPublication({
    prNumber: PR,
    expectedTransitionSeq: terminal.transitionSeq,
    publication: {
      headSha: HEAD,
      terminalRunId: 'review-run-1418',
      status: 'succeeded',
      publicationDigest: 'publication-digest',
      recordedAtUtc: new Date().toISOString(),
    },
    options,
  });
}

function settleReviewAtCapDefer(options: PackReviewAuthorityOptions) {
  const authority = initializeReview(options, 'T1');
  const terminal = commitPackReviewTerminal({
    prNumber: PR,
    expectedTransitionSeq: authority.transitionSeq,
    terminal: {
      schemaVersion: 1,
      terminalContractVersion: 2,
      terminalSource: 'normal',
      runId: 'review-at-cap-1418',
      targetSha: HEAD,
      reviewVerdict: 'findings',
      findingCount: 1,
      findingsDigest: 'at-cap-findings-digest',
    },
    status: 'changes_requested',
    findingCount: 1,
    options,
  });
  const triaged = commitPackReviewTriage({
    prNumber: PR,
    expectedTransitionSeq: terminal.transitionSeq,
    triage: {
      verdict: 'DEFER',
      source: 'architect',
      findingSnapshotDigest: 'at-cap-findings-snapshot',
      committedAtUtc: new Date().toISOString(),
    },
    options,
  });
  return recordPackReviewPublication({
    prNumber: PR,
    expectedTransitionSeq: triaged.transitionSeq,
    publication: {
      headSha: HEAD,
      terminalRunId: 'review-at-cap-1418',
      status: 'succeeded',
      publicationDigest: 'at-cap-publication-digest',
      recordedAtUtc: new Date().toISOString(),
    },
    options,
  });
}

async function publishLocal(
  file: string,
  bindingKey: string,
  expectedCurrent?: Pick<WorkerAssignment, 'assignmentId' | 'generation'>,
): Promise<WorkerAssignment> {
  const result = await publishCurrentWorkerAssignment({
    file,
    repository: REPOSITORY,
    issueNumber: ISSUE,
    taskId: 'task-1418',
    kind: 'local',
    provider: 'orca',
    bindingKey,
    role: 'worker',
    ...(expectedCurrent ? { expectedCurrent } : {}),
  });
  if (!result.ok) throw new Error(result.reason);
  return result.assignment;
}

async function publishRemote(
  file: string,
  bindingKey = 'remote-1418',
  expectedCurrent?: Pick<WorkerAssignment, 'assignmentId' | 'generation'>,
): Promise<WorkerAssignment> {
  const result = await publishCurrentWorkerAssignment({
    file,
    repository: REPOSITORY,
    issueNumber: ISSUE,
    taskId: 'task-1418',
    kind: 'remote',
    provider: 'browser-gpt',
    bindingKey,
    role: 'worker',
    ...(expectedCurrent ? { expectedCurrent } : {}),
  });
  if (!result.ok) throw new Error(result.reason);
  return result.assignment;
}

function runtimeFor(bindingKey: string, workspacePath: string): RuntimeAdapter {
  const base = new DeterministicRuntimeAdapter();
  const spawned = base.spawnWorker({
    title: 'issue-1418-worker',
    command: 'cursor-agent',
    workspace: workspacePath,
  });
  if (spawned.status !== 'ok') throw new Error('test worker spawn failed');
  Object.defineProperty(base, 'resolveAssignmentWorker', {
    configurable: true,
    value: vi.fn((selector: { bindingKey?: string }) => (
      selector.bindingKey === bindingKey
        ? { status: 'ok' as const, value: { kind: 'resolved' as const, worker: spawned.value } }
        : { status: 'ok' as const, value: { kind: 'gone' as const } }
    )),
  });
  return base as unknown as RuntimeAdapter;
}

function dependencies(input: {
  reviewStoreRoot: string;
  assignmentStorePath: string;
  adapter: RuntimeAdapter;
  runAttempt?: NonNullable<PostReviewSmokeDependencies['runAttempt']>;
}): PostReviewSmokeDependencies {
  return {
    projectId: 'orchestrator-pack',
    repoRoot: process.cwd(),
    assignmentStorePath: input.assignmentStorePath,
    adapter: input.adapter,
    env: { ...process.env, PACK_REVIEW_RUN_STORE_ROOT: input.reviewStoreRoot },
    ciGreen: () => true,
    readIssueBody: async () => [
      '```complexity-tier',
      'tier: T3',
      'advisory-prior: T3',
      '```',
    ].join('\n'),
    ...(input.runAttempt ? { runAttempt: input.runAttempt } : {}),
  };
}
function remoteActuationRecords(options: PackReviewAuthorityOptions) {
  return listPackReviewImmutableRecords('evidence', options)
    .filter((record) => (
      record.value
      && typeof record.value === 'object'
      && !Array.isArray(record.value)
      && (record.value as Record<string, unknown>).schema === 'local-smoke-actuation/v1'
    ));
}

const candidate = {
  repoSlug: REPOSITORY,
  prNumber: PR,
  headSha: HEAD,
  prBody: `Closes #${ISSUE}`,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #1418 post-review smoke reconciliation', () => {
  it('performs zero smoke work before authoritative review completion', async () => {
    const fixture = rootFixture();
    const options: PackReviewAuthorityOptions = { storeRoot: fixture.reviewStoreRoot };
    initializeReview(options);
    const runAttempt = vi.fn(async () => 0);

    const result = await reconcilePostReviewSmoke(candidate, dependencies({
      ...fixture,
      adapter: new DeterministicRuntimeAdapter() as unknown as RuntimeAdapter,
      runAttempt,
    }));

    expect(result).toEqual({ handled: false, attempted: false, reason: 'smoke_ordering_review_unsettled' });
    expect(runAttempt).not.toHaveBeenCalled();
    expect(remoteActuationRecords(options)).toHaveLength(0);
  });

  it('enters smoke exactly once through the exact current local assignment fence', async () => {
    const fixture = rootFixture();
    const options: PackReviewAuthorityOptions = { storeRoot: fixture.reviewStoreRoot };
    settleReview(options);
    const assignment = await publishLocal(fixture.assignmentStorePath, 'dispatch-1418');
    const workspacePath = path.join(fixture.root, 'worker-worktree');
    const adapter = runtimeFor(assignment.bindingKey, workspacePath);
    let effects = 0;
    const runAttempt: NonNullable<PostReviewSmokeDependencies['runAttempt']> = async (smokeOptions, smokeDeps) => {
      expect(smokeOptions.repoRoot).toBe(workspacePath);
      const fenced = await smokeDeps.startFence!(() => {
        effects += 1;
        return 'started';
      });
      expect(fenced).toEqual({ ok: true, value: 'started' });
      return 0;
    };

    const result = await reconcilePostReviewSmoke(candidate, dependencies({
      ...fixture,
      adapter,
      runAttempt,
    }));

    expect(result).toEqual({ handled: true, attempted: true, reason: 'post_review_smoke_completed', exitCode: 0 });
    expect(effects).toBe(1);
  });

  it('admits smoke after authoritative at-cap architect DEFER', async () => {
    const fixture = rootFixture();
    const options: PackReviewAuthorityOptions = { storeRoot: fixture.reviewStoreRoot };
    const settled = settleReviewAtCapDefer(options);
    expect(settled.cycle).toMatchObject({
      state: 'at_cap_open_findings',
      reviewStageComplete: true,
    });
    const assignment = await publishLocal(fixture.assignmentStorePath, 'dispatch-at-cap-defer');
    const adapter = runtimeFor(assignment.bindingKey, path.join(fixture.root, 'worker-at-cap-defer'));
    let effects = 0;
    const runAttempt: NonNullable<PostReviewSmokeDependencies['runAttempt']> = async (_smokeOptions, smokeDeps) => {
      const fenced = await smokeDeps.startFence!(() => {
        effects += 1;
      });
      expect(fenced.ok).toBe(true);
      return 0;
    };

    const result = await reconcilePostReviewSmoke(candidate, dependencies({
      ...fixture,
      adapter,
      runAttempt,
    }));

    expect(result).toEqual({ handled: true, attempted: true, reason: 'post_review_smoke_completed', exitCode: 0 });
    expect(effects).toBe(1);
  });

  it('continues smoke on the new head after a smoke finding without reopening automatic review', async () => {
    const fixture = rootFixture();
    const options: PackReviewAuthorityOptions = { storeRoot: fixture.reviewStoreRoot };
    const settled = settleReview(options);
    const started = commitSmokeOrderingTransition({
      prNumber: PR,
      expectedTransitionSeq: settled.transitionSeq,
      actor: 'independent',
      headSha: HEAD,
      status: 'started',
      options,
    });
    const failed = commitSmokeOrderingTransition({
      prNumber: PR,
      expectedTransitionSeq: started.transitionSeq,
      actor: 'independent',
      headSha: HEAD,
      status: 'failed',
      failureKind: 'finding',
      options,
    });
    const next = observePackReviewHead({
      prNumber: PR,
      expectedTransitionSeq: failed.transitionSeq,
      headSha: NEXT_HEAD,
      options,
    });
    expect(next.cycle?.reviewStageComplete).toBe(true);
    expect(next.smokeOrdering?.independent).toMatchObject({
      headSha: NEXT_HEAD,
      status: 'failed',
      failureHeadSha: HEAD,
    });

    const assignment = await publishLocal(fixture.assignmentStorePath, 'dispatch-smoke-fix-head');
    const adapter = runtimeFor(assignment.bindingKey, path.join(fixture.root, 'worker-smoke-fix-head'));
    let effects = 0;
    const runAttempt: NonNullable<PostReviewSmokeDependencies['runAttempt']> = async (smokeOptions, smokeDeps) => {
      expect(smokeOptions.headSha).toBe(NEXT_HEAD);
      const fenced = await smokeDeps.startFence!(() => {
        effects += 1;
      });
      expect(fenced.ok).toBe(true);
      return 0;
    };
    const nextCandidate = { ...candidate, headSha: NEXT_HEAD };

    const result = await reconcilePostReviewSmoke(nextCandidate, dependencies({
      ...fixture,
      adapter,
      runAttempt,
    }));

    expect(result).toEqual({ handled: true, attempted: true, reason: 'post_review_smoke_completed', exitCode: 0 });
    expect(effects).toBe(1);
  });

  it('treats local G to local G+1 reassignment before fence entry as proven zero-attempt', async () => {
    const fixture = rootFixture();
    const options: PackReviewAuthorityOptions = { storeRoot: fixture.reviewStoreRoot };
    settleReview(options);
    const assignment = await publishLocal(fixture.assignmentStorePath, 'dispatch-g');
    const adapter = runtimeFor(assignment.bindingKey, path.join(fixture.root, 'worker-g'));
    let effects = 0;
    const runAttempt: NonNullable<PostReviewSmokeDependencies['runAttempt']> = async (_smokeOptions, smokeDeps) => {
      await publishLocal(fixture.assignmentStorePath, 'dispatch-g-plus-1', {
        assignmentId: assignment.assignmentId,
        generation: assignment.generation,
      });
      const fenced = await smokeDeps.startFence!(() => {
        effects += 1;
      });
      expect(fenced).toEqual({ ok: false, reason: 'assignment_stale', actionEntered: false });
      return 1;
    };

    const result = await reconcilePostReviewSmoke(candidate, dependencies({
      ...fixture,
      adapter,
      runAttempt,
    }));

    expect(result).toEqual({ handled: true, attempted: false, reason: 'post_review_smoke_preaction_failed', exitCode: 1 });
    expect(effects).toBe(0);
    expect(remoteActuationRecords(options)).toHaveLength(0);
  });

  it('records remote G+1 as not-applicable when it wins before the final smoke fence', async () => {
    const fixture = rootFixture();
    const options: PackReviewAuthorityOptions = { storeRoot: fixture.reviewStoreRoot };
    settleReview(options);
    const local = await publishLocal(fixture.assignmentStorePath, 'dispatch-local-g');
    const adapter = runtimeFor(local.bindingKey, path.join(fixture.root, 'worker-local-g'));
    let remote!: WorkerAssignment;
    let effects = 0;
    const runAttempt: NonNullable<PostReviewSmokeDependencies['runAttempt']> = async (_smokeOptions, smokeDeps) => {
      remote = await publishRemote(
        fixture.assignmentStorePath,
        'remote-g-plus-1',
        { assignmentId: local.assignmentId, generation: local.generation },
      );
      const fenced = await smokeDeps.startFence!(() => {
        effects += 1;
      });
      expect(fenced).toEqual({
        ok: false,
        reason: 'remote_assignment_requires_local_reassignment',
        actionEntered: false,
      });
      return 1;
    };

    const result = await reconcilePostReviewSmoke(candidate, dependencies({
      ...fixture,
      adapter,
      runAttempt,
    }));

    expect(result).toEqual({
      handled: true,
      attempted: false,
      reason: 'post_review_smoke_remote_assignment_requires_local_reassignment',
      exitCode: 1,
    });
    expect(effects).toBe(0);
    const records = remoteActuationRecords(options);
    expect(records).toHaveLength(1);
    expect(records[0]?.value).toMatchObject({
      schema: 'local-smoke-actuation/v1',
      disposition: 'not_applicable',
      reason: 'remote_assignment_no_runtime_managed_local_workspace',
      repository: REPOSITORY,
      issueNumber: ISSUE,
      prNumber: PR,
      headSha: HEAD,
      assignment: {
        assignmentId: remote.assignmentId,
        generation: remote.generation,
        kind: 'remote',
        provider: 'browser-gpt',
      },
    });
  });

  it('preserves post-entry failure as an attempted smoke', async () => {
    const fixture = rootFixture();
    const options: PackReviewAuthorityOptions = { storeRoot: fixture.reviewStoreRoot };
    settleReview(options);
    const assignment = await publishLocal(fixture.assignmentStorePath, 'dispatch-post-entry');
    const adapter = runtimeFor(assignment.bindingKey, path.join(fixture.root, 'worker-post-entry'));
    let effects = 0;
    const runAttempt: NonNullable<PostReviewSmokeDependencies['runAttempt']> = async (_smokeOptions, smokeDeps) => {
      const fenced = await smokeDeps.startFence!(() => {
        effects += 1;
        throw new Error('post-entry-fixture-failure');
      });
      expect(fenced).toEqual({ ok: false, reason: 'assignment_fence_failed', actionEntered: true });
      return 1;
    };

    const result = await reconcilePostReviewSmoke(candidate, dependencies({
      ...fixture,
      adapter,
      runAttempt,
    }));

    expect(result).toEqual({ handled: true, attempted: true, reason: 'post_review_smoke_failed', exitCode: 1 });
    expect(effects).toBe(1);
  });

  it('keeps remote ownership local-smoke-free, durable, idempotent, and blocked on local reassignment', async () => {
    const fixture = rootFixture();
    const options: PackReviewAuthorityOptions = { storeRoot: fixture.reviewStoreRoot };
    settleReview(options);
    const remote = await publishRemote(fixture.assignmentStorePath);
    const adapter = new DeterministicRuntimeAdapter() as unknown as RuntimeAdapter;
    const runAttempt = vi.fn(async () => 0);
    const deps = dependencies({ ...fixture, adapter, runAttempt });

    const first = await reconcilePostReviewSmoke(candidate, deps);
    const second = await reconcilePostReviewSmoke(candidate, deps);

    expect(first).toEqual({
      handled: true,
      attempted: false,
      reason: 'post_review_smoke_remote_assignment_requires_local_reassignment',
    });
    expect(second).toEqual(first);
    expect(runAttempt).not.toHaveBeenCalled();
    const records = remoteActuationRecords(options);
    expect(records).toHaveLength(1);
    expect(records[0]?.value).toMatchObject({
      schema: 'local-smoke-actuation/v1',
      disposition: 'not_applicable',
      reason: 'remote_assignment_no_runtime_managed_local_workspace',
      assignment: {
        assignmentId: remote.assignmentId,
        generation: remote.generation,
        kind: 'remote',
      },
    });
  });

  it('does not duplicate smoke after the same exact head already passed', async () => {
    const fixture = rootFixture();
    const options: PackReviewAuthorityOptions = { storeRoot: fixture.reviewStoreRoot };
    const settled = settleReview(options);
    const started = commitSmokeOrderingTransition({
      prNumber: PR,
      expectedTransitionSeq: settled.transitionSeq,
      actor: 'independent',
      headSha: HEAD,
      status: 'started',
      options,
    });
    commitSmokeOrderingTransition({
      prNumber: PR,
      expectedTransitionSeq: started.transitionSeq,
      actor: 'independent',
      headSha: HEAD,
      status: 'passed',
      options,
    });
    const runAttempt = vi.fn(async () => 0);

    const result = await reconcilePostReviewSmoke(candidate, dependencies({
      ...fixture,
      adapter: new DeterministicRuntimeAdapter() as unknown as RuntimeAdapter,
      runAttempt,
    }));

    expect(result).toEqual({ handled: true, attempted: false, reason: 'independent_smoke_already_passed' });
    expect(runAttempt).not.toHaveBeenCalled();
  });
});

describe('Issue #1777 post-review admission parity', () => {
  const OBSERVED_PR = 1740;
  const OBSERVED_HEAD = 'ce99d1e63aef156f8846483f77c426f7adeadcf0';
  const EARLIER_HEAD = 'c2cb38bfc7108d3887788bb3b4563fcf90ab3c1f';
  const OTHER_HEAD = 'f'.repeat(40);
  const OPENED_AT = '2026-08-27T12:00:00.000Z';
  const RUN_AT = '2026-08-27T12:00:01.000Z';
  const PRIOR_RUN_AT = '2026-08-27T11:59:59.000Z';

  type IndependentState = NonNullable<NonNullable<PackReviewAuthorityDocument['smokeOrdering']>['independent']>;
  type RunShape = {
    automaticBudgetDisposition?: 'consume' | 'non_consuming_explicit';
    stale?: boolean;
    createdAt?: string;
    failureReason?: string;
  };
  type AuthorityShape = {
    terminalStatus?: string;
    consumedHeadShas?: string[];
    reviewSettledHeadSha?: string;
    independent?: IndependentState;
    triageVerdict?: 'BLOCK';
    reviewStageComplete?: boolean;
    reviewStartConsumed?: boolean;
  };
  type MatrixCase = {
    id: string;
    expected: string;
    build: (derived: boolean) => PackReviewAuthorityDocument;
    runs: readonly (RunShape | null)[];
    requestedHead?: string;
    derived?: readonly boolean[];
  };

  function authorityFor(shape: AuthorityShape = {}): PackReviewAuthorityDocument {
    const cycle: NonNullable<PackReviewAuthorityDocument['cycle']> = {
      cycleId: 'cycle-observed-1740',
      state: 'open',
      frozenTier: 'T3',
      frozenCap: 2,
      capMapVersion: 'legacy-frozen',
      frozenMapOrigin: 'persisted-open-cycle',
      openedAtUtc: OPENED_AT,
      consumedHeadShas: shape.consumedHeadShas ?? [],
    };
    if (shape.reviewStageComplete) {
      cycle.reviewStageComplete = true;
      cycle.reviewStageCompletedAtUtc = RUN_AT;
    }
    if (shape.reviewStartConsumed) cycle.reviewStartConsumed = true;

    const authority: PackReviewAuthorityDocument = {
      schemaVersion: 1,
      prNumber: OBSERVED_PR,
      transitionSeq: 0,
      phase: 'head_observed',
      currentHeadSha: OBSERVED_HEAD,
      updatedAtUtc: OPENED_AT,
      cycle,
      smokeOrdering: {
        workerOwned: {
          headSha: OBSERVED_HEAD,
          status: 'passed',
          updatedAtUtc: RUN_AT,
        },
      },
    };
    if (shape.reviewSettledHeadSha) {
      authority.smokeOrdering!.reviewSettledHeadSha = shape.reviewSettledHeadSha;
    }
    if (shape.independent) authority.smokeOrdering!.independent = shape.independent;
    if (shape.terminalStatus) {
      authority.terminal = {
        runId: 'terminal-' + shape.terminalStatus,
        digest: 'd'.repeat(64),
        targetSha: OBSERVED_HEAD,
        reviewVerdict: ['clean', 'up_to_date', 'commented'].includes(shape.terminalStatus) ? 'clean' : 'findings',
        terminalSource: 'normal',
        automaticBudgetDisposition: 'consume',
        reviewStatus: shape.terminalStatus,
      };
    }
    if (shape.triageVerdict) {
      authority.triage = {
        verdict: shape.triageVerdict,
        source: 'architect',
        findingSnapshotDigest: 'finding-snapshot',
        committedAtUtc: RUN_AT,
      };
    }
    return authority;
  }

  function matrixCase(
    id: string,
    expected: string,
    build: MatrixCase['build'],
    runs: MatrixCase['runs'],
    requestedHead?: string,
    derived?: readonly boolean[],
  ): MatrixCase {
    return { id, expected, build, runs, requestedHead, derived };
  }

  const MATRIX: readonly MatrixCase[] = [
    matrixCase('A1 full observed #1740 run-store-only consumed start', 'admit',
      (flag) => authorityFor({ reviewStageComplete: flag, reviewStartConsumed: flag }), [{}]),
    matrixCase('A2 observed fixture without consuming run', 'smoke_ordering_review_unsettled',
      (flag) => authorityFor({ reviewStageComplete: flag, reviewStartConsumed: flag }), [null]),
    matrixCase('A3 failed terminal consumes start', 'admit',
      (flag) => authorityFor({ terminalStatus: 'failed', reviewStageComplete: flag, reviewStartConsumed: !flag }), [null]),
    matrixCase('A4 error terminal consumes start', 'admit',
      (flag) => authorityFor({ terminalStatus: 'error', reviewStageComplete: flag, reviewStartConsumed: !flag }), [null]),
    matrixCase('A5 changes_requested terminal consumes start', 'admit',
      (flag) => authorityFor({ terminalStatus: 'changes_requested', reviewStageComplete: flag, reviewStartConsumed: !flag }), [null]),
    matrixCase('A6 cap itself proves consumption', 'admit',
      (flag) => authorityFor({ consumedHeadShas: ['1'.repeat(40), '2'.repeat(40)], reviewStageComplete: flag, reviewStartConsumed: !flag }), [null]),
    matrixCase('A7 below cap without terminal or run evidence', 'smoke_ordering_review_unsettled',
      (flag) => authorityFor({ consumedHeadShas: ['1'.repeat(40)], reviewStageComplete: flag, reviewStartConsumed: flag }), [null]),
    matrixCase('A8 production failed-run failure reasons consume start', 'admit',
      (flag) => authorityFor({ reviewStageComplete: flag, reviewStartConsumed: !flag }),
      [{ failureReason: 'reviewer_output_malformed:invalid_terminal_payload' }, { failureReason: 'stale_head_before_terminal' }]),
    matrixCase('A9 stale or explicit non-consuming run cannot admit', 'smoke_ordering_review_unsettled',
      (flag) => authorityFor({ reviewStageComplete: flag, reviewStartConsumed: flag }),
      [{ stale: true }, { automaticBudgetDisposition: 'non_consuming_explicit' }]),
    matrixCase('A10 exact-head successful settlement admits', 'admit',
      () => authorityFor({ terminalStatus: 'up_to_date', reviewSettledHeadSha: OBSERVED_HEAD, reviewStageComplete: true }), [null], undefined, [true]),
    matrixCase('A11 prior-head settlement does not settle current head', 'smoke_ordering_review_unsettled',
      (flag) => authorityFor({ reviewSettledHeadSha: EARLIER_HEAD, reviewStageComplete: flag, reviewStartConsumed: flag }), [null]),
    matrixCase('A12 requested head differs from authority current head', 'smoke_ordering_head_mismatch',
      (flag) => authorityFor({ reviewStageComplete: flag, reviewStartConsumed: flag }), [{}], OTHER_HEAD),
    matrixCase('A13 same-head independent finding requires a new head', 'smoke_ordering_independent_same_head_forbidden',
      (flag) => authorityFor({
        reviewStageComplete: flag,
        reviewStartConsumed: flag,
        independent: {
          startedEver: true,
          headSha: OBSERVED_HEAD,
          status: 'failed',
          failureKind: 'finding',
          failureHeadSha: OBSERVED_HEAD,
          updatedAtUtc: RUN_AT,
        },
      }), [{}]),
    matrixCase('A14 started or passed independent smoke cannot continue on another head', 'smoke_ordering_independent_head_forbidden',
      (flag) => authorityFor({
        reviewStageComplete: flag,
        reviewStartConsumed: flag,
        independent: {
          startedEver: true,
          headSha: EARLIER_HEAD,
          status: 'passed',
          updatedAtUtc: RUN_AT,
        },
      }), [{}]),
    matrixCase('A15 unresolved blocking triage remains fail closed', 'smoke_ordering_review_unsettled',
      (flag) => authorityFor({ terminalStatus: 'failed', triageVerdict: 'BLOCK', reviewStageComplete: flag, reviewStartConsumed: true }), [{}]),
    matrixCase('A16 prior-cycle same-PR run cannot admit', 'smoke_ordering_review_unsettled',
      (flag) => authorityFor({ reviewStageComplete: flag, reviewStartConsumed: flag }), [{ createdAt: PRIOR_RUN_AT }]),
  ];

  function persistFixture(authority: PackReviewAuthorityDocument, run: RunShape | null) {
    const fixture = rootFixture();
    const authorityRoot = path.join(fixture.reviewStoreRoot, 'authority');
    mkdirSync(authorityRoot, { recursive: true });
    writeFileSync(
      path.join(authorityRoot, 'pr-' + authority.prNumber + '.json'),
      JSON.stringify(authority) + '\n',
      'utf8',
    );
    if (run) {
      const now = new Date(run.createdAt ?? RUN_AT);
      const created = createPackReviewRun({
        projectId: 'orchestrator-pack',
        storeRoot: fixture.reviewStoreRoot,
        prNumber: OBSERVED_PR,
        headSha: EARLIER_HEAD,
        trustedPackRoot: fixture.root,
        sourceRepoRoot: fixture.root,
        automaticBudgetDisposition: 'consume',
        now,
      });
      setPackReviewRunTerminal(
        created.run.id,
        'failed',
        {
          failureReason: run.failureReason ?? 'stale_head_before_terminal',
          ...(run.stale ? { stale: true } : {}),
        },
        { projectId: 'orchestrator-pack', storeRoot: fixture.reviewStoreRoot, now },
      );
      if (run.automaticBudgetDisposition === 'non_consuming_explicit') {
        const legacyPath = path.join(fixture.reviewStoreRoot, 'runs', created.run.id + '.json');
        const legacyRecord = JSON.parse(readFileSync(legacyPath, 'utf8')) as Record<string, unknown>;
        legacyRecord.automaticBudgetDisposition = 'non_consuming_explicit';
        writeFileSync(legacyPath, JSON.stringify(legacyRecord) + '\n', 'utf8');
      }
    }
    return fixture;
  }

  it.each(MATRIX)('$id', ({ expected, build, runs, requestedHead, derived }) => {
    for (const flag of derived ?? [false, true]) {
      for (const run of runs) {
        const fixture = persistFixture(build(flag), run);
        const result = reviewStageDisposition({
          prNumber: OBSERVED_PR,
          headSha: requestedHead ?? OBSERVED_HEAD,
          projectId: 'orchestrator-pack',
          env: { ...process.env, PACK_REVIEW_RUN_STORE_ROOT: fixture.reviewStoreRoot },
        });
        if (expected === 'admit') {
          expect(result).toEqual({
            kind: 'smoke_candidate',
            reason: 'review_stage_complete_smoke_admitted',
          });
          continue;
        }
        expect(result.reason).toBe(expected);
        expect(result.kind).toBe(
          expected === 'smoke_ordering_review_unsettled' ? 'review_pending' : 'smoke_blocked',
        );
      }
    }
  });

  it.each([
    ['started', 'independent_smoke_in_progress'],
    ['passed', 'independent_smoke_already_passed'],
  ] as const)('maps canonical same-head %s refusal after owner decision', (status, reason) => {
    const fixture = persistFixture(authorityFor({
      independent: {
        startedEver: true,
        headSha: OBSERVED_HEAD,
        status,
        updatedAtUtc: RUN_AT,
      },
    }), null);
    expect(reviewStageDisposition({
      prNumber: OBSERVED_PR,
      headSha: OBSERVED_HEAD,
      projectId: 'orchestrator-pack',
      env: { ...process.env, PACK_REVIEW_RUN_STORE_ROOT: fixture.reviewStoreRoot },
    })).toEqual({ kind: 'smoke_blocked', reason });
  });
});

