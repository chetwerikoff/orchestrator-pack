// @vitest-ci-lane light

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishCurrentWorkerAssignment, resolveWorkerAssignmentStorePath, type WorkerAssignment } from '../lib/worker-assignment-store.ts';
import {
  commitPackReviewTerminal,
  commitSmokeOrderingTransition,
  initializePackReviewAuthority,
  readPackReviewAuthority,
  recordPackReviewPublication,
  type PackReviewAuthorityOptions,
} from '../pack-review-state.ts';
import type { RuntimeAdapter } from '../runtime/contracts.ts';
import { DeterministicRuntimeAdapter } from '../runtime/test-adapter.ts';
import { reconcilePostReviewSmoke, type PostReviewSmokeDependencies } from './post-review-smoke.ts';
import { runSchedulerTick, type SchedulerBoundary, type SchedulerCurrentPr } from './scheduler.ts';

const REPOSITORY = 'chetwerikoff/orchestrator-pack';
const ISSUE = 1418;
const PR = 1481;
const HEAD = 'c'.repeat(40);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-scheduler-smoke-'));
  roots.push(root);
  return root;
}

function epochEnv(root: string): NodeJS.ProcessEnv {
  const authority = path.join(root, 'epoch.json');
  const epochId = 'epoch-1418-scheduler-smoke';
  const nonce = 'nonce-1418-scheduler-smoke';
  writeFileSync(authority, JSON.stringify({
    schemaVersion: 1,
    currentEpochId: epochId,
    records: [{
      epochId,
      nonce,
      hostId: 'host-test',
      repoRoot: process.cwd(),
      installedCommitSha: 'a'.repeat(40),
      snapshotDigests: {},
      importDigests: {},
      registryHash: 'a',
      preCommitLogDigest: 'b',
      commitAt: '2026-08-19T00:00:00.000Z',
    }],
  }), 'utf8');
  return {
    ...process.env,
    ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: authority,
    ORCHESTRATOR_CUTOVER_EPOCH_ID: epochId,
    ORCHESTRATOR_CUTOVER_NONCE: nonce,
  };
}

function settleReview(options: PackReviewAuthorityOptions) {
  const initial = initializePackReviewAuthority({ prNumber: PR, headSha: HEAD, tier: 'T3', options });
  const terminalContract = {
    schemaVersion: 1,
    terminalContractVersion: 2,
    terminalSource: 'normal',
    runId: 'review-run-1418',
    targetSha: HEAD,
    reviewVerdict: 'clean',
    findingCount: 0,
    findingsDigest: 'clean-findings-digest',
  } as const;
  const terminal = commitPackReviewTerminal({
    prNumber: PR,
    expectedTransitionSeq: initial.transitionSeq,
    terminal: terminalContract,
    status: 'up_to_date',
    findingCount: 0,
    options,
  });
  const publication = {
    headSha: HEAD,
    terminalRunId: terminalContract.runId,
    status: 'succeeded',
    publicationDigest: 'publication-digest',
    recordedAtUtc: '2026-08-19T00:01:00.000Z',
  } as const;
  return recordPackReviewPublication({
    prNumber: PR,
    expectedTransitionSeq: terminal.transitionSeq,
    publication,
    options,
  });
}

async function publishLocal(
  file: string,
  bindingKey: string,
  expectedCurrent?: Pick<WorkerAssignment, 'assignmentId' | 'generation'>,
): Promise<WorkerAssignment> {
  const result = await publishCurrentWorkerAssignment({
    repository: REPOSITORY,
    issueNumber: ISSUE,
    taskId: 'task-1418',
    file,
    provider: 'orca',
    kind: 'local',
    bindingKey,
    ...(expectedCurrent ? { expectedCurrent } : {}),
  });
  if (!result.ok) throw new Error(result.reason);
  return result.assignment;
}

function runtimeFor(bindingKey: string, workspacePath: string): RuntimeAdapter {
  const adapter = new DeterministicRuntimeAdapter();
  const spawned = adapter.spawnWorker({ title: 'issue-1418-worker', command: 'cursor-agent', workspace: workspacePath });
  if (spawned.status !== 'ok') throw new Error('test worker spawn failed');
  Object.defineProperty(adapter, 'resolveAssignmentWorker', {
    configurable: true,
    value: vi.fn((selector: { bindingKey?: string }) => (
      selector.bindingKey === bindingKey
        ? { status: 'ok' as const, value: { kind: 'resolved' as const, worker: spawned.value } }
        : { status: 'ok' as const, value: { kind: 'gone' as const } }
    )),
  });
  return adapter as unknown as RuntimeAdapter;
}

function smokeDependencies(input: {
  root: string;
  reviewStoreRoot: string;
  assignmentStorePath: string;
  adapter: RuntimeAdapter;
  runAttempt: NonNullable<PostReviewSmokeDependencies['runAttempt']>;
}): PostReviewSmokeDependencies {
  return {
    projectId: 'orchestrator-pack',
    repoRoot: process.cwd(),
    assignmentStorePath: input.assignmentStorePath,
    adapter: input.adapter,
    env: { ...process.env, PACK_REVIEW_RUN_STORE_ROOT: input.reviewStoreRoot },
    ciGreen: () => true,
    readIssueBody: async () => ['```complexity-tier', 'tier: T3', 'advisory-prior: T3', '```'].join('\n'),
    runAttempt: input.runAttempt,
  };
}

function currentPr(): SchedulerCurrentPr {
  return { number: PR, headRefOid: HEAD, state: 'OPEN', isDraft: false, body: `Closes #${ISSUE}` };
}

function schedulerBoundary(deps: PostReviewSmokeDependencies, start = vi.fn(async () => ({ ok: true }))): SchedulerBoundary {
  return {
    listCandidates: () => [{ sessionId: 'worker-1418', repoSlug: REPOSITORY, prNumber: PR, boundHeadSha: HEAD }],
    readCurrentPr: async () => currentPr(),
    readChecks: async () => [],
    listReviewRuns: () => [],
    start,
    reconcilePostReviewSmoke: async (candidate, fresh) => reconcilePostReviewSmoke({
      repoSlug: candidate.repoSlug,
      prNumber: candidate.prNumber,
      headSha: fresh.headRefOid,
      prBody: fresh.body ?? '',
    }, deps),
  };
}

function fixture() {
  const root = makeRoot();
  const reviewStoreRoot = path.join(root, 'review-store');
  const assignmentStorePath = resolveWorkerAssignmentStorePath('orchestrator-pack', {
    ...process.env,
    OPK_BASE_DIR: path.join(root, 'opk'),
  });
  return { root, reviewStoreRoot, assignmentStorePath, options: { storeRoot: reviewStoreRoot } satisfies PackReviewAuthorityOptions };
}

describe('production scheduler post-review smoke composition', () => {
  it('does zero smoke work before authoritative review completion', async () => {
    const f = fixture();
    initializePackReviewAuthority({ prNumber: PR, headSha: HEAD, tier: 'T3', options: f.options });
    const runAttempt = vi.fn(async () => 0);
    const deps = smokeDependencies({
      ...f,
      adapter: new DeterministicRuntimeAdapter() as unknown as RuntimeAdapter,
      runAttempt,
    });

    await runSchedulerTick(schedulerBoundary(deps), epochEnv(f.root));
    expect(runAttempt).not.toHaveBeenCalled();
  });

  it('enters exact-local smoke once through runSchedulerTick after review completion and green CI', async () => {
    const f = fixture();
    settleReview(f.options);
    const assignment = await publishLocal(f.assignmentStorePath, 'dispatch-1418');
    const adapter = runtimeFor(assignment.bindingKey, path.join(f.root, 'worker-worktree'));
    let effects = 0;
    const runAttempt: NonNullable<PostReviewSmokeDependencies['runAttempt']> = async (_options, deps) => {
      const fenced = await deps.startFence!(() => { effects += 1; });
      expect(fenced.ok).toBe(true);
      return 0;
    };
    const start = vi.fn(async () => ({ ok: true }));

    const result = await runSchedulerTick(schedulerBoundary(smokeDependencies({ ...f, adapter, runAttempt }), start), epochEnv(f.root));
    expect(result).toMatchObject({ attempted: 1, started: 0, skipped: 1 });
    expect(effects).toBe(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('does not duplicate smoke on repeated scheduler reconciliation after smoke ordering is terminal', async () => {
    const f = fixture();
    settleReview(f.options);
    const assignment = await publishLocal(f.assignmentStorePath, 'dispatch-repeat');
    const adapter = runtimeFor(assignment.bindingKey, path.join(f.root, 'worker-repeat'));
    let effects = 0;
    const runAttempt: NonNullable<PostReviewSmokeDependencies['runAttempt']> = async (_options, deps) => {
      const fenced = await deps.startFence!(() => { effects += 1; });
      expect(fenced.ok).toBe(true);
      const authority = readPackReviewAuthority(PR, f.options);
      if (!authority) throw new Error('review authority missing');
      const started = commitSmokeOrderingTransition({
        prNumber: PR,
        expectedTransitionSeq: authority.transitionSeq,
        actor: 'independent',
        headSha: HEAD,
        status: 'started',
        options: f.options,
      });
      commitSmokeOrderingTransition({
        prNumber: PR,
        expectedTransitionSeq: started.transitionSeq,
        actor: 'independent',
        headSha: HEAD,
        status: 'passed',
        options: f.options,
      });
      return 0;
    };
    const boundary = schedulerBoundary(smokeDependencies({ ...f, adapter, runAttempt }));
    const env = epochEnv(f.root);

    await runSchedulerTick(boundary, env);
    await runSchedulerTick(boundary, env);
    expect(effects).toBe(1);
  });

  it('keeps reassignment before the final fence at proven zero-attempt through the scheduler caller', async () => {
    const f = fixture();
    settleReview(f.options);
    const assignment = await publishLocal(f.assignmentStorePath, 'dispatch-g');
    const adapter = runtimeFor(assignment.bindingKey, path.join(f.root, 'worker-g'));
    let effects = 0;
    const runAttempt: NonNullable<PostReviewSmokeDependencies['runAttempt']> = async (_options, deps) => {
      await publishLocal(f.assignmentStorePath, 'dispatch-g-plus-1', {
        assignmentId: assignment.assignmentId,
        generation: assignment.generation,
      });
      const fenced = await deps.startFence!(() => { effects += 1; });
      expect(fenced).toMatchObject({ ok: false, actionEntered: false });
      return 1;
    };

    const result = await runSchedulerTick(
      schedulerBoundary(smokeDependencies({ ...f, adapter, runAttempt })),
      epochEnv(f.root),
    );
    expect(result).toMatchObject({ attempted: 1, started: 0, skipped: 1 });
    expect(effects).toBe(0);
  });

  it('preserves partial-start semantics when failure happens after smoke action entry', async () => {
    const f = fixture();
    settleReview(f.options);
    const assignment = await publishLocal(f.assignmentStorePath, 'dispatch-partial');
    const adapter = runtimeFor(assignment.bindingKey, path.join(f.root, 'worker-partial'));
    let effects = 0;
    const runAttempt: NonNullable<PostReviewSmokeDependencies['runAttempt']> = async (_options, deps) => {
      const fenced = await deps.startFence!(() => { effects += 1; });
      expect(fenced.ok).toBe(true);
      return 1;
    };

    const result = await runSchedulerTick(
      schedulerBoundary(smokeDependencies({ ...f, adapter, runAttempt })),
      epochEnv(f.root),
    );
    expect(result).toMatchObject({ attempted: 1, started: 0, skipped: 1 });
    expect(effects).toBe(1);
  });
});
