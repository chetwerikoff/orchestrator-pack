// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { mkdtempSync, rmSync } from 'node:fs';
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

    expect(result).toEqual({ handled: false, attempted: false, reason: 'review_stage_incomplete' });
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
  const OPENED_AT = '2026-08-27T12:00:00.000Z';
  const RUN_AT = '2026-08-27T12:00:01.000Z';

  function setup(withConsumingRun: boolean) {
    const fixture = rootFixture();
    const options: PackReviewAuthorityOptions = {
      storeRoot: fixture.reviewStoreRoot,
      now: new Date(OPENED_AT),
    };
    const retainedOpenCycle = {
      cycleId: 'cycle-observed-1740',
      state: 'open' as const,
      frozenTier: 'T3' as const,
      frozenCap: 2,
      openedAtUtc: OPENED_AT,
      consumedHeadShas: [],
    };
    let authority = initializePackReviewAuthority({
      prNumber: OBSERVED_PR,
      headSha: OBSERVED_HEAD,
      tier: 'T3',
      retainedOpenCycle,
      options,
    });
    authority = commitSmokeOrderingTransition({
      prNumber: OBSERVED_PR,
      expectedTransitionSeq: authority.transitionSeq,
      actor: 'worker-owned',
      headSha: OBSERVED_HEAD,
      status: 'started',
      options,
    });
    commitSmokeOrderingTransition({
      prNumber: OBSERVED_PR,
      expectedTransitionSeq: authority.transitionSeq,
      actor: 'worker-owned',
      headSha: OBSERVED_HEAD,
      status: 'passed',
      options,
    });

    if (withConsumingRun) {
      const created = createPackReviewRun({
        projectId: 'orchestrator-pack',
        storeRoot: fixture.reviewStoreRoot,
        prNumber: OBSERVED_PR,
        headSha: EARLIER_HEAD,
        trustedPackRoot: fixture.root,
        sourceRepoRoot: fixture.root,
        automaticBudgetDisposition: 'consume',
        now: new Date(RUN_AT),
      });
      setPackReviewRunTerminal(
        created.run.id,
        'failed',
        { failureReason: 'stale_head_before_terminal' },
        {
          projectId: 'orchestrator-pack',
          storeRoot: fixture.reviewStoreRoot,
          now: new Date(RUN_AT),
        },
      );
    }
    return fixture;
  }

  it.each([
    {
      withConsumingRun: true,
      expected: { kind: 'smoke_candidate', reason: 'review_stage_complete_smoke_admitted' },
    },
    {
      withConsumingRun: false,
      expected: { kind: 'review_pending', reason: 'review_stage_incomplete' },
    },
  ])('uses the canonical complete-input decision: $expected.kind', ({ withConsumingRun, expected }) => {
    const fixture = setup(withConsumingRun);
    expect(reviewStageDisposition({
      prNumber: OBSERVED_PR,
      headSha: OBSERVED_HEAD,
      projectId: 'orchestrator-pack',
      env: { ...process.env, PACK_REVIEW_RUN_STORE_ROOT: fixture.reviewStoreRoot },
    })).toEqual(expected);
  });
});

