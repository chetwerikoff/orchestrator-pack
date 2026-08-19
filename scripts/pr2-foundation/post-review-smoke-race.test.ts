// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
import { readSmokeLifecycleRegistry } from '../lib/worker-smoke-lifecycle.ts';
import {
  commitPackReviewTerminal,
  initializePackReviewAuthority,
  recordPackReviewPublication,
  type PackReviewAuthorityOptions,
} from '../pack-review-state.ts';
import type {
  RuntimeAdapter,
  RuntimeWorker,
  RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';
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

const ghFixture = vi.hoisted(() => ({
  issueBody: '',
  headSha: '',
}));

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

function workspaceFixture(root: string): { workspace: string; headSha: string } {
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  git(workspace, ['init']);
  git(workspace, ['config', 'user.name', 'Smoke Race Fixture']);
  git(workspace, ['config', 'user.email', 'smoke-race@example.invalid']);
  git(workspace, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(workspace, '.gitignore'), '.orca-worker-smoke/\n', 'utf8');
  writeFileSync(path.join(workspace, 'fixture.txt'), 'fixture\n', 'utf8');
  git(workspace, ['add', '.gitignore', 'fixture.txt']);
  git(workspace, ['commit', '-m', 'fixture']);
  git(workspace, ['remote', 'add', 'origin', `https://github.com/${REPOSITORY}.git`]);
  return { workspace, headSha: git(workspace, ['rev-parse', 'HEAD']).toLowerCase() };
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
    '  - action: verify partial-start fixture | expected: no duplicate runtime spawn',
    '```',
  ].join('\n');
}

function rootFixture(): {
  root: string;
  reviewStoreRoot: string;
  assignmentStorePath: string;
  receiptRoot: string;
  workspace: string;
  headSha: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-post-review-smoke-race-'));
  roots.push(root);
  const { workspace, headSha } = workspaceFixture(root);
  return {
    root,
    reviewStoreRoot: path.join(root, 'review-store'),
    assignmentStorePath: resolveWorkerAssignmentStorePath('orchestrator-pack', {
      ...process.env,
      OPK_BASE_DIR: root,
    }),
    receiptRoot: path.join(root, 'receipts'),
    workspace,
    headSha,
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
      runId: 'review-run-1418-race',
      targetSha: headSha,
      reviewVerdict: 'clean',
      findingCount: 0,
      findingsDigest: 'clean-race-findings',
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
      terminalRunId: 'review-run-1418-race',
      status: 'succeeded',
      publicationDigest: 'race-publication',
      recordedAtUtc: new Date().toISOString(),
    },
    options,
  });
}

async function publishLocal(file: string, bindingKey: string): Promise<WorkerAssignment> {
  const result = await publishCurrentWorkerAssignment({
    file,
    repository: REPOSITORY,
    issueNumber: ISSUE,
    taskId: 'task-1418-race',
    kind: 'local',
    provider: 'orca',
    bindingKey,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.assignment;
}

type RuntimeHooks = {
  onResolve?: (ordinal: number) => void;
  wrapSmokeWorker?: (worker: RuntimeWorker) => RuntimeWorker;
};

function runtimeFor(
  bindingKey: string,
  workspacePath: string,
  hooks: RuntimeHooks = {},
): { adapter: RuntimeAdapter; smokeSpawnCount: () => number } {
  const base = new DeterministicRuntimeAdapter();
  const owner = base.spawnWorker({
    title: 'issue-1418-owner',
    command: 'cursor-agent',
    workspace: workspacePath,
  });
  if (owner.status !== 'ok') throw new Error('assignment owner spawn failed');

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
      hooks.onResolve?.(resolveOrdinal);
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
      value: { ready: true as const, workspacePath },
    })),
  });
  Object.defineProperty(base, 'spawnWorker', {
    configurable: true,
    value: vi.fn((input: Parameters<RuntimeAdapter['spawnWorker']>[0]) => {
      smokeSpawns += 1;
      const spawned = originalSpawn(input);
      if (spawned.status !== 'ok' || !hooks.wrapSmokeWorker) return spawned;
      return { status: 'ok' as const, value: hooks.wrapSmokeWorker(spawned.value) };
    }),
  });
  return {
    adapter: base as unknown as RuntimeAdapter,
    smokeSpawnCount: () => smokeSpawns,
  };
}

function runDirectories(workspace: string): string[] {
  const root = path.join(workspace, '.orca-worker-smoke', 'runs');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function configureSmokeEnv(fixture: ReturnType<typeof rootFixture>): void {
  vi.stubEnv('PACK_REVIEW_RUN_STORE_ROOT', fixture.reviewStoreRoot);
  vi.stubEnv('WORKER_SMOKE_RECEIPT_ROOT', fixture.receiptRoot);
  vi.stubEnv('PACK_EXECUTOR_SMOKE_ROUTINE_AGENT', 'cursor');
  vi.stubEnv('PACK_EXECUTOR_SMOKE_ROUTINE_MODEL', 'fixture-routine');
  vi.stubEnv('PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT', 'medium');
  vi.stubEnv('PACK_EXECUTOR_SMOKE_COMPLEX_AGENT', 'cursor');
  vi.stubEnv('PACK_EXECUTOR_SMOKE_COMPLEX_MODEL', 'fixture-complex');
  vi.stubEnv('PACK_EXECUTOR_SMOKE_COMPLEX_EFFORT', 'high');
}

function dependencies(
  fixture: ReturnType<typeof rootFixture>,
  adapter: RuntimeAdapter,
  body: string,
): PostReviewSmokeDependencies {
  const dryRunAttempt: NonNullable<PostReviewSmokeDependencies['runAttempt']> = (options, smokeDeps) =>
    runSmokeAttempt({ ...options, dryRun: true }, smokeDeps);
  return {
    projectId: 'orchestrator-pack',
    repoRoot: fixture.workspace,
    assignmentStorePath: fixture.assignmentStorePath,
    adapter,
    env: { ...process.env, PACK_REVIEW_RUN_STORE_ROOT: fixture.reviewStoreRoot },
    ciGreen: () => true,
    readIssueBody: async () => body,
    runAttempt: dryRunAttempt,
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

function preBindFailureWorker(worker: RuntimeWorker): RuntimeWorker {
  const source = worker.identity;
  let idReads = 0;
  const identity = {} as RuntimeWorkerIdentity;
  Object.defineProperties(identity, {
    runtime: { enumerable: true, value: source.runtime },
    generation: { enumerable: true, value: source.generation },
    id: {
      enumerable: true,
      get: () => {
        idReads += 1;
        if (idReads === 1) throw new Error('post-spawn-pre-terminal-binding-fixture');
        return source.id;
      },
    },
  });
  return { ...worker, identity };
}

afterEach(() => {
  vi.unstubAllEnvs();
  ghFixture.issueBody = '';
  ghFixture.headSha = '';
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #1418 r10 partial smoke-start production races', () => {
  it('keeps a post-reservation failure attempted and blocks later duplicate lifecycle admission', async () => {
    const fixture = rootFixture();
    configureSmokeEnv(fixture);
    const body = issueBody();
    ghFixture.issueBody = body;
    ghFixture.headSha = fixture.headSha;
    const reviewOptions: PackReviewAuthorityOptions = { storeRoot: fixture.reviewStoreRoot };
    settleReview(fixture.headSha, reviewOptions);
    const assignment = await publishLocal(fixture.assignmentStorePath, 'dispatch-post-reservation');

    const authorityFile = path.join(fixture.reviewStoreRoot, 'authority', `pr-${PR}.json`);
    let savedAuthority = '';
    const runtime = runtimeFor(assignment.bindingKey, fixture.workspace, {
      onResolve: (ordinal) => {
        if (ordinal !== 2) return;
        savedAuthority = readFileSync(authorityFile, 'utf8');
        writeFileSync(authorityFile, '{corrupt-after-final-revalidation\n', 'utf8');
      },
    });
    const deps = dependencies(fixture, runtime.adapter, body);

    const first = await reconcilePostReviewSmoke(candidate(fixture.headSha), deps);

    expect(first.handled).toBe(true);
    expect(first.attempted).toBe(true);
    expect(runtime.smokeSpawnCount()).toBe(0);
    const afterFirst = runDirectories(fixture.workspace);
    expect(afterFirst).toHaveLength(1);
    expect(readSmokeLifecycleRegistry(afterFirst[0]!)).toMatchObject({
      spawnState: 'ambiguous_unbound',
      issueNumber: ISSUE,
      prNumber: PR,
      headSha: fixture.headSha,
    });

    expect(savedAuthority).not.toBe('');
    writeFileSync(authorityFile, savedAuthority, 'utf8');
    const second = await reconcilePostReviewSmoke(candidate(fixture.headSha), deps);

    expect(second.handled).toBe(true);
    expect(runtime.smokeSpawnCount()).toBe(0);
    expect(runDirectories(fixture.workspace)).toEqual(afterFirst);
  });

  it('keeps a post-spawn/pre-bind failure attempted and prevents a second runtime spawn', async () => {
    const fixture = rootFixture();
    configureSmokeEnv(fixture);
    const body = issueBody();
    ghFixture.issueBody = body;
    ghFixture.headSha = fixture.headSha;
    const reviewOptions: PackReviewAuthorityOptions = { storeRoot: fixture.reviewStoreRoot };
    settleReview(fixture.headSha, reviewOptions);
    const assignment = await publishLocal(fixture.assignmentStorePath, 'dispatch-post-spawn');
    const runtime = runtimeFor(assignment.bindingKey, fixture.workspace, {
      wrapSmokeWorker: preBindFailureWorker,
    });
    const deps = dependencies(fixture, runtime.adapter, body);

    const first = await reconcilePostReviewSmoke(candidate(fixture.headSha), deps);

    expect(first.handled).toBe(true);
    expect(first.attempted).toBe(true);
    expect(runtime.smokeSpawnCount()).toBe(1);
    const afterFirst = runDirectories(fixture.workspace);
    expect(afterFirst).toHaveLength(1);
    const firstRegistry = readSmokeLifecycleRegistry(afterFirst[0]!);
    expect(firstRegistry).toBeDefined();
    expect(firstRegistry?.spawnState).not.toBe('clean');

    const second = await reconcilePostReviewSmoke(candidate(fixture.headSha), deps);

    expect(second.handled).toBe(true);
    expect(runtime.smokeSpawnCount()).toBe(1);
    expect(runDirectories(fixture.workspace)).toEqual(afterFirst);
  });
});
