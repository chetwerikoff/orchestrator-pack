// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProcessSync } from '../kernel/subprocess.ts';
import {
  publishCurrentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
  type WorkerAssignment,
} from '../lib/worker-assignment-store.ts';
import {
  commitPackReviewTerminal,
  initializePackReviewAuthority,
  recordPackReviewPublication,
  type PackReviewAuthorityOptions,
} from '../pack-review-state.ts';
import type { RuntimeAdapter } from '../runtime/contracts.ts';
import { DeterministicRuntimeAdapter } from '../runtime/test-adapter.ts';
import { runSmokeAttempt } from '../worker-smoke-run.ts';
import {
  reconcilePostReviewSmoke,
  type PostReviewSmokeDependencies,
} from './post-review-smoke.ts';

const REPOSITORY = 'chetwerikoff/orchestrator-pack';
const ISSUE = 1418;
const PR = 1481;
const roots: string[] = [];

const ghFixture = vi.hoisted(() => ({ issueBody: '', headSha: '' }));

vi.mock('../lib/gh-repo-resolve.mjs', () => ({
  ghApiJson: vi.fn((_command: string, endpoint: string) => {
    if (endpoint === 'user') return { login: 'fixture-publisher' };
    if (endpoint === `repos/${REPOSITORY}/issues/${ISSUE}`) {
      return {
        number: ISSUE,
        state: 'open',
        html_url: `https://github.com/${REPOSITORY}/issues/${ISSUE}`,
        body: ghFixture.issueBody,
      };
    }
    if (endpoint === `repos/${REPOSITORY}/pulls/${PR}`) {
      return {
        number: PR,
        state: 'open',
        html_url: `https://github.com/${REPOSITORY}/pull/${PR}`,
        body: `Closes #${ISSUE}`,
        head: { sha: ghFixture.headSha },
      };
    }
    throw new Error(`unexpected gh fixture endpoint: ${endpoint}`);
  }),
}));

function git(cwd: string, args: readonly string[]): string {
  const result = runProcessSync({
    command: 'git',
    args: [...args],
    cwd,
    inheritParentEnv: true,
  });
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error || result.exitCode}`);
  }
  return result.stdout.trim();
}

function issueBody(): string {
  return [
    '```behavior-kind',
    'action-producing',
    '```',
    '',
    '```complexity-tier',
    'tier: T3',
    'advisory-prior: T3',
    '```',
    '',
    '```smoke-test-plan',
    'scenarios:',
    '  - action: verify pre-action failure fixture | expected: zero smoke attempt',
    '```',
  ].join('\n');
}

function fixture(): {
  root: string;
  workspace: string;
  headSha: string;
  reviewStoreRoot: string;
  receiptRoot: string;
  assignmentStorePath: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-post-review-preaction-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  git(workspace, ['init']);
  git(workspace, ['config', 'user.name', 'Smoke Preaction Fixture']);
  git(workspace, ['config', 'user.email', 'smoke-preaction@example.invalid']);
  git(workspace, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(workspace, '.gitignore'), '.orca-worker-smoke/\n', 'utf8');
  writeFileSync(path.join(workspace, 'fixture.txt'), 'fixture\n', 'utf8');
  git(workspace, ['add', '.gitignore', 'fixture.txt']);
  git(workspace, ['commit', '-m', 'fixture']);
  git(workspace, ['remote', 'add', 'origin', `https://github.com/${REPOSITORY}.git`]);
  const headSha = git(workspace, ['rev-parse', 'HEAD']).toLowerCase();
  return {
    root,
    workspace,
    headSha,
    reviewStoreRoot: path.join(root, 'review-store'),
    receiptRoot: path.join(root, 'receipts'),
    assignmentStorePath: resolveWorkerAssignmentStorePath('orchestrator-pack', {
      ...process.env,
      OPK_BASE_DIR: root,
    }),
  };
}

function settleReview(headSha: string, options: PackReviewAuthorityOptions): void {
  const authority = initializePackReviewAuthority({
    prNumber: PR,
    headSha,
    tier: 'T3',
    options,
  });
  const terminal = commitPackReviewTerminal({
    prNumber: PR,
    expectedTransitionSeq: authority.transitionSeq,
    terminal: {
      schemaVersion: 1,
      terminalContractVersion: 2,
      terminalSource: 'normal',
      runId: 'review-run-1418-preaction',
      targetSha: headSha,
      reviewVerdict: 'clean',
      findingCount: 0,
      findingsDigest: 'preaction-clean-findings',
    },
    status: 'up_to_date',
    findingCount: 0,
    options,
  });
  recordPackReviewPublication({
    prNumber: PR,
    expectedTransitionSeq: terminal.transitionSeq,
    publication: {
      headSha,
      terminalRunId: 'review-run-1418-preaction',
      status: 'succeeded',
      publicationDigest: 'preaction-publication',
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
    taskId: 'task-1418-preaction',
    kind: 'local',
    provider: 'orca',
    bindingKey,
    ...(expectedCurrent ? { expectedCurrent } : {}),
  });
  if (!result.ok) throw new Error(result.reason);
  return result.assignment;
}

function runtimeFor(
  bindingKey: string,
  workspacePath: string,
  failResolveAtOrdinal?: number,
): { adapter: RuntimeAdapter; smokeSpawnCount: () => number } {
  const base = new DeterministicRuntimeAdapter();
  const owner = base.spawnWorker({
    title: 'issue-1418-owner',
    command: 'cursor-agent',
    workspace: workspacePath,
  });
  if (owner.status !== 'ok') throw new Error('assignment owner spawn failed');
  const headSha = git(workspacePath, ['rev-parse', 'HEAD']).toLowerCase();
  let resolveOrdinal = 0;
  let smokeSpawns = 0;
  const originalSpawn = base.spawnWorker.bind(base);

  Object.defineProperty(base, 'resolveAssignmentWorker', {
    configurable: true,
    value: vi.fn((selector: { bindingKey?: string }) => {
      if (selector.bindingKey !== bindingKey) {
        return { status: 'ok' as const, value: { kind: 'gone' as const } };
      }
      resolveOrdinal += 1;
      if (resolveOrdinal === failResolveAtOrdinal) {
        return {
          status: 'failed' as const,
          operation: 'resolve_assignment_worker' as const,
          reason: 'fixture-runtime-authority-unavailable',
        };
      }
      return {
        status: 'ok' as const,
        value: { kind: 'resolved' as const, worker: owner.value },
      };
    }),
  });
  Object.defineProperty(base, 'readiness', {
    configurable: true,
    value: vi.fn(() => ({
      status: 'ok' as const,
      value: { ready: true as const, workspacePath, headSha },
    })),
  });
  Object.defineProperty(base, 'spawnWorker', {
    configurable: true,
    value: vi.fn((input: Parameters<RuntimeAdapter['spawnWorker']>[0]) => {
      smokeSpawns += 1;
      return originalSpawn(input);
    }),
  });
  return {
    adapter: base as unknown as RuntimeAdapter,
    smokeSpawnCount: () => smokeSpawns,
  };
}

function configureEnv(input: ReturnType<typeof fixture>): void {
  vi.stubEnv('PACK_REVIEW_RUN_STORE_ROOT', input.reviewStoreRoot);
  vi.stubEnv('WORKER_SMOKE_RECEIPT_ROOT', input.receiptRoot);
  vi.stubEnv('PACK_EXECUTOR_SMOKE_ROUTINE_AGENT', 'cursor');
  vi.stubEnv('PACK_EXECUTOR_SMOKE_ROUTINE_MODEL', 'fixture-routine');
  vi.stubEnv('PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT', 'medium');
  vi.stubEnv('PACK_EXECUTOR_SMOKE_COMPLEX_AGENT', 'cursor');
  vi.stubEnv('PACK_EXECUTOR_SMOKE_COMPLEX_MODEL', 'fixture-complex');
  vi.stubEnv('PACK_EXECUTOR_SMOKE_COMPLEX_EFFORT', 'high');
}

function dependencies(
  input: ReturnType<typeof fixture>,
  adapter: RuntimeAdapter,
  body: string,
): PostReviewSmokeDependencies {
  return {
    projectId: 'orchestrator-pack',
    repoRoot: input.workspace,
    assignmentStorePath: input.assignmentStorePath,
    adapter,
    env: { ...process.env, PACK_REVIEW_RUN_STORE_ROOT: input.reviewStoreRoot },
    ciGreen: () => true,
    readIssueBody: async () => body,
    runAttempt: (options, smokeDeps) => runSmokeAttempt({ ...options, dryRun: true }, smokeDeps),
  };
}

function candidate(headSha: string) {
  return {
    repoSlug: REPOSITORY,
    prNumber: PR,
    headSha,
    prBody: `Closes #${ISSUE}`,
  };
}

function runDirectories(workspace: string): string[] {
  const root = path.join(workspace, '.orca-worker-smoke', 'runs');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
}

afterEach(() => {
  vi.unstubAllEnvs();
  ghFixture.issueBody = '';
  ghFixture.headSha = '';
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #1418 r10 pre-action smoke fence classes', () => {
  it('treats runtime authority unavailable during final fenced re-resolution as zero attempt', async () => {
    const input = fixture();
    configureEnv(input);
    const body = issueBody();
    ghFixture.issueBody = body;
    ghFixture.headSha = input.headSha;
    settleReview(input.headSha, { storeRoot: input.reviewStoreRoot });
    const assignment = await publishLocal(input.assignmentStorePath, 'dispatch-runtime-unavailable');
    const runtime = runtimeFor(assignment.bindingKey, input.workspace, 2);

    const result = await reconcilePostReviewSmoke(
      candidate(input.headSha),
      dependencies(input, runtime.adapter, body),
    );

    expect(result).toMatchObject({ handled: true, attempted: false });
    expect(runtime.smokeSpawnCount()).toBe(0);
    expect(runDirectories(input.workspace)).toHaveLength(0);
  });

  it('treats assignment_store_busy before fence action entry as zero attempt', async () => {
    const input = fixture();
    configureEnv(input);
    const body = issueBody();
    ghFixture.issueBody = body;
    ghFixture.headSha = input.headSha;
    settleReview(input.headSha, { storeRoot: input.reviewStoreRoot });
    const assignment = await publishLocal(input.assignmentStorePath, 'dispatch-busy');
    const runtime = runtimeFor(assignment.bindingKey, input.workspace);
    const base = dependencies(input, runtime.adapter, body);
    let observed: unknown;
    const lockPath = `${input.assignmentStorePath}.lock`;
    const deps: PostReviewSmokeDependencies = {
      ...base,
      runAttempt: (options, smokeDeps) => runSmokeAttempt(
        { ...options, dryRun: true },
        {
          ...smokeDeps,
          startFence: async (action) => {
            mkdirSync(path.dirname(lockPath), { recursive: true });
            writeFileSync(lockPath, `${JSON.stringify({
              schemaVersion: 1,
              pid: process.pid,
              nonce: 'preaction-busy-fixture',
              acquiredAtMs: Date.now(),
            })}\n`, 'utf8');
            try {
              observed = await smokeDeps.startFence!(action);
              return observed as Awaited<ReturnType<NonNullable<typeof smokeDeps.startFence>>>;
            } finally {
              rmSync(lockPath, { force: true });
            }
          },
        },
      ),
    };

    const result = await reconcilePostReviewSmoke(candidate(input.headSha), deps);

    expect(observed).toEqual({ ok: false, reason: 'assignment_store_busy', actionEntered: false });
    expect(result).toMatchObject({ handled: true, attempted: false });
    expect(runtime.smokeSpawnCount()).toBe(0);
    expect(runDirectories(input.workspace)).toHaveLength(0);
  });

  it('treats assignment_stale before fence action entry as zero attempt', async () => {
    const input = fixture();
    configureEnv(input);
    const body = issueBody();
    ghFixture.issueBody = body;
    ghFixture.headSha = input.headSha;
    settleReview(input.headSha, { storeRoot: input.reviewStoreRoot });
    const assignment = await publishLocal(input.assignmentStorePath, 'dispatch-stale-g');
    const runtime = runtimeFor(assignment.bindingKey, input.workspace);
    const base = dependencies(input, runtime.adapter, body);
    let observed: unknown;
    const deps: PostReviewSmokeDependencies = {
      ...base,
      runAttempt: (options, smokeDeps) => runSmokeAttempt(
        { ...options, dryRun: true },
        {
          ...smokeDeps,
          startFence: async (action) => {
            await publishLocal(input.assignmentStorePath, 'dispatch-stale-g-plus-1', {
              assignmentId: assignment.assignmentId,
              generation: assignment.generation,
            });
            observed = await smokeDeps.startFence!(action);
            return observed as Awaited<ReturnType<NonNullable<typeof smokeDeps.startFence>>>;
          },
        },
      ),
    };

    const result = await reconcilePostReviewSmoke(candidate(input.headSha), deps);

    expect(observed).toEqual({ ok: false, reason: 'assignment_stale', actionEntered: false });
    expect(result).toMatchObject({ handled: true, attempted: false });
    expect(runtime.smokeSpawnCount()).toBe(0);
    expect(runDirectories(input.workspace)).toHaveLength(0);
  });

  it('accepts assignment_fence_failed as zero attempt only with positive non-entry evidence', async () => {
    const input = fixture();
    configureEnv(input);
    const body = issueBody();
    ghFixture.issueBody = body;
    ghFixture.headSha = input.headSha;
    settleReview(input.headSha, { storeRoot: input.reviewStoreRoot });
    const assignment = await publishLocal(input.assignmentStorePath, 'dispatch-generic-nonentry');
    const runtime = runtimeFor(assignment.bindingKey, input.workspace);
    const base = dependencies(input, runtime.adapter, body);
    let observed: unknown;
    const storeDirectory = path.dirname(input.assignmentStorePath);
    const backupDirectory = `${storeDirectory}.preaction-backup`;
    const deps: PostReviewSmokeDependencies = {
      ...base,
      runAttempt: (options, smokeDeps) => runSmokeAttempt(
        { ...options, dryRun: true },
        {
          ...smokeDeps,
          startFence: async (action) => {
            renameSync(storeDirectory, backupDirectory);
            writeFileSync(storeDirectory, 'not-a-directory\n', 'utf8');
            try {
              observed = await smokeDeps.startFence!(action);
              return observed as Awaited<ReturnType<NonNullable<typeof smokeDeps.startFence>>>;
            } finally {
              rmSync(storeDirectory, { force: true });
              renameSync(backupDirectory, storeDirectory);
            }
          },
        },
      ),
    };

    const result = await reconcilePostReviewSmoke(candidate(input.headSha), deps);

    expect(observed).toEqual({ ok: false, reason: 'assignment_fence_failed', actionEntered: false });
    expect(result).toMatchObject({ handled: true, attempted: false });
    expect(runtime.smokeSpawnCount()).toBe(0);
    expect(runDirectories(input.workspace)).toHaveLength(0);
  });
});
