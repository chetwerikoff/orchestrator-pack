// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120

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
  commitSmokeOrderingTransition,
  initializePackReviewAuthority,
  recordPackReviewPublication,
  type PackReviewAuthorityOptions,
} from '../pack-review-state.ts';
import type { RuntimeAdapter } from '../runtime/contracts.ts';
import { DeterministicRuntimeAdapter } from '../runtime/test-adapter.ts';
import {
  reconcilePostReviewSmoke,
  type PostReviewSmokeDependencies,
} from './post-review-smoke.ts';

const REPOSITORY = 'chetwerikoff/orchestrator-pack';
const ISSUE = 1418;
const PR = 1481;
const HEAD = 'c'.repeat(40);
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

function initializeReview(options: PackReviewAuthorityOptions) {
  return initializePackReviewAuthority({
    prNumber: PR,
    headSha: HEAD,
    tier: 'T3',
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
    ...(expectedCurrent ? { expectedCurrent } : {}),
  });
  if (!result.ok) throw new Error(result.reason);
  return result.assignment;
}

async function publishRemote(file: string): Promise<WorkerAssignment> {
  const result = await publishCurrentWorkerAssignment({
    file,
    repository: REPOSITORY,
    issueNumber: ISSUE,
    taskId: 'task-1418',
    kind: 'remote',
    provider: 'browser-gpt',
    bindingKey: 'remote-1418',
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

  it('treats G to G+1 reassignment before fence entry as proven zero-attempt', async () => {
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

  it('keeps remote ownership local-smoke-free and requires explicit local reassignment', async () => {
    const fixture = rootFixture();
    const options: PackReviewAuthorityOptions = { storeRoot: fixture.reviewStoreRoot };
    settleReview(options);
    await publishRemote(fixture.assignmentStorePath);
    const adapter = new DeterministicRuntimeAdapter() as unknown as RuntimeAdapter;
    const runAttempt = vi.fn(async () => 0);

    const result = await reconcilePostReviewSmoke(candidate, dependencies({
      ...fixture,
      adapter,
      runAttempt,
    }));

    expect(result).toEqual({
      handled: true,
      attempted: false,
      reason: 'post_review_smoke_remote_assignment_requires_local_reassignment',
    });
    expect(runAttempt).not.toHaveBeenCalled();
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
