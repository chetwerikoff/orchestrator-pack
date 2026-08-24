// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProcessSync } from '../kernel/subprocess.ts';
import { publishCurrentWorkerAssignment, resolveWorkerAssignmentStorePath, type WorkerAssignment } from '../lib/worker-assignment-store.ts';
import { commitPackReviewTerminal, initializePackReviewAuthority, recordPackReviewPublication } from '../pack-review-state.ts';
import type { RuntimeAdapter } from '../runtime/contracts.ts';
import { DeterministicRuntimeAdapter } from '../runtime/test-adapter.ts';
import { runSmokeAttempt } from '../worker-smoke-run.ts';
import { reconcilePostReviewSmoke, type PostReviewSmokeDependencies } from './post-review-smoke.ts';

const REPO = 'chetwerikoff/orchestrator-pack';
const ISSUE = 1418;
const PR = 1481;
const roots: string[] = [];
const ISSUE_BODY = `\`\`\`behavior-kind
action-producing
\`\`\`

\`\`\`complexity-tier
tier: T3
advisory-prior: T3
\`\`\`

\`\`\`smoke-test-plan
scenarios:
  - action: force a pre-action fence failure | expected: no lifecycle reservation or spawn
\`\`\``;

const gh = vi.hoisted(() => ({ head: '' }));
vi.mock('../lib/gh-repo-resolve.mjs', () => ({
  ghApiJson: vi.fn((_command: string, endpoint: string) => {
    switch (endpoint) {
      case 'user': return { login: 'preaction-fixture' };
      case `repos/${REPO}/issues/${ISSUE}`: return {
        number: ISSUE,
        state: 'open',
        html_url: `https://github.com/${REPO}/issues/${ISSUE}`,
        body: ISSUE_BODY,
      };
      case `repos/${REPO}/pulls/${PR}`: return {
        number: PR,
        state: 'open',
        html_url: `https://github.com/${REPO}/pull/${PR}`,
        body: `Closes #${ISSUE}`,
        head: { sha: gh.head },
      };
      default: throw new Error(`unexpected fixture endpoint: ${endpoint}`);
    }
  }),
}));

type Fixture = ReturnType<typeof makeFixture>;
type RuntimeFixture = ReturnType<typeof makeRuntime>;
type FenceObservation = { reason?: string; actionEntered?: boolean };
type FenceMutation = () => void | (() => void) | Promise<void | (() => void)>;

function runGit(cwd: string, ...args: string[]): string {
  const result = runProcessSync({ command: 'git', args, cwd, inheritParentEnv: true });
  if (!result.ok) throw new Error(`fixture git failed: ${args.join(' ')}: ${result.stderr || result.error || result.exitCode}`);
  return result.stdout.trim();
}

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-preaction-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const commands = [
    ['init'],
    ['config', 'user.name', 'Preaction Fixture'],
    ['config', 'user.email', 'preaction@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
  ];
  for (const args of commands) runGit(workspace, ...args);
  writeFileSync(path.join(workspace, '.gitignore'), '.orca-worker-smoke/\n', 'utf8');
  writeFileSync(path.join(workspace, 'fixture.txt'), 'fixture\n', 'utf8');
  runGit(workspace, 'add', '.gitignore', 'fixture.txt');
  runGit(workspace, 'commit', '-m', 'fixture');
  runGit(workspace, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`);
  return {
    root,
    workspace,
    headSha: runGit(workspace, 'rev-parse', 'HEAD').toLowerCase(),
    reviewRoot: path.join(root, 'review'),
    receiptRoot: path.join(root, 'receipts'),
    assignmentFile: resolveWorkerAssignmentStorePath('orchestrator-pack', { ...process.env, OPK_BASE_DIR: root }),
  };
}

function completeReview(input: Fixture): void {
  const options = { storeRoot: input.reviewRoot };
  const initial = initializePackReviewAuthority({ prNumber: PR, headSha: input.headSha, tier: 'T3', options });
  const terminal = commitPackReviewTerminal({
    prNumber: PR,
    expectedTransitionSeq: initial.transitionSeq,
    status: 'up_to_date',
    findingCount: 0,
    terminal: {
      schemaVersion: 1,
      terminalContractVersion: 2,
      terminalSource: 'normal',
      runId: 'preaction-review-run',
      targetSha: input.headSha,
      reviewVerdict: 'clean',
      findingCount: 0,
      findingsDigest: 'preaction-clean',
    },
    options,
  });
  recordPackReviewPublication({
    prNumber: PR,
    expectedTransitionSeq: terminal.transitionSeq,
    publication: {
      headSha: input.headSha,
      terminalRunId: 'preaction-review-run',
      status: 'succeeded',
      publicationDigest: 'preaction-published',
      recordedAtUtc: new Date().toISOString(),
    },
    options,
  });
}

async function setLocalAssignment(
  input: Fixture,
  bindingKey: string,
  expectedCurrent?: Pick<WorkerAssignment, 'assignmentId' | 'generation'>,
): Promise<WorkerAssignment> {
  const publication = await publishCurrentWorkerAssignment({
    file: input.assignmentFile,
    repository: REPO,
    issueNumber: ISSUE,
    taskId: 'preaction-task',
    kind: 'local',
    provider: 'orca',
    bindingKey,
    role: 'worker',
    ...(expectedCurrent ? { expectedCurrent } : {}),
  });
  if (!publication.ok) throw new Error(publication.reason);
  return publication.assignment;
}

function makeRuntime(input: Fixture, bindingKey: string, failResolveOrdinal?: number) {
  const adapter = new DeterministicRuntimeAdapter();
  const owner = adapter.spawnWorker({ title: 'preaction-owner', command: 'cursor-agent', workspace: input.workspace });
  if (owner.status !== 'ok') throw new Error('fixture owner spawn failed');
  const originalSpawn = adapter.spawnWorker.bind(adapter);
  let resolves = 0;
  let smokeSpawns = 0;
  Object.defineProperty(adapter, 'resolveAssignmentWorker', {
    configurable: true,
    value: vi.fn((selector: { bindingKey?: string }) => {
      if (selector.bindingKey !== bindingKey) return { status: 'ok' as const, value: { kind: 'gone' as const } };
      resolves += 1;
      if (resolves === failResolveOrdinal) {
        return { status: 'failed' as const, operation: 'resolve_assignment_worker' as const, reason: 'fixture-authority-unavailable' };
      }
      return { status: 'ok' as const, value: { kind: 'resolved' as const, worker: owner.value } };
    }),
  });
  Object.defineProperty(adapter, 'readiness', {
    configurable: true,
    value: vi.fn(() => ({ status: 'ok' as const, value: { ready: true as const, workspacePath: input.workspace, headSha: input.headSha } })),
  });
  Object.defineProperty(adapter, 'spawnWorker', {
    configurable: true,
    value: vi.fn((request: Parameters<RuntimeAdapter['spawnWorker']>[0]) => {
      smokeSpawns += 1;
      return originalSpawn(request);
    }),
  });
  return { adapter: adapter as unknown as RuntimeAdapter, spawnCount: () => smokeSpawns };
}

function baseDependencies(input: Fixture, runtime: RuntimeFixture): PostReviewSmokeDependencies {
  return {
    projectId: 'orchestrator-pack',
    repoRoot: input.workspace,
    assignmentStorePath: input.assignmentFile,
    adapter: runtime.adapter,
    env: { ...process.env, PACK_REVIEW_RUN_STORE_ROOT: input.reviewRoot },
    ciGreen: () => true,
    readIssueBody: async () => ISSUE_BODY,
    runAttempt: (options, deps) => runSmokeAttempt({ ...options, dryRun: true }, deps),
  };
}

function candidate(input: Fixture) {
  return { repoSlug: REPO, prNumber: PR, headSha: input.headSha, prBody: `Closes #${ISSUE}` };
}

function runs(input: Fixture): string[] {
  const directory = path.join(input.workspace, '.orca-worker-smoke', 'runs');
  return existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];
}

function withFenceMutation(
  base: PostReviewSmokeDependencies,
  mutate: FenceMutation,
  observation: FenceObservation,
): PostReviewSmokeDependencies {
  return {
    ...base,
    runAttempt: (options, deps) => runSmokeAttempt({ ...options, dryRun: true }, {
      ...deps,
      startFence: async (action) => {
        const fence = deps.startFence;
        if (!fence) throw new Error('fixture missing production start fence');
        const cleanup = await mutate();
        try {
          const result = await fence(action);
          if (!result.ok) {
            observation.reason = result.reason;
            observation.actionEntered = result.actionEntered;
          }
          return result;
        } finally {
          cleanup?.();
        }
      },
    }),
  };
}

async function readyCase(bindingKey: string, failResolveOrdinal?: number) {
  const input = makeFixture();
  vi.stubEnv('PACK_REVIEW_RUN_STORE_ROOT', input.reviewRoot);
  vi.stubEnv('WORKER_SMOKE_RECEIPT_ROOT', input.receiptRoot);
  vi.stubEnv('PACK_EXECUTOR_SMOKE_COMPLEX_AGENT', 'cursor');
  vi.stubEnv('PACK_EXECUTOR_SMOKE_COMPLEX_MODEL', 'preaction-model');
  vi.stubEnv('PACK_EXECUTOR_SMOKE_COMPLEX_EFFORT', 'high');
  gh.head = input.headSha;
  completeReview(input);
  const assignment = await setLocalAssignment(input, bindingKey);
  const runtime = makeRuntime(input, assignment.bindingKey, failResolveOrdinal);
  return { input, assignment, runtime, deps: baseDependencies(input, runtime) };
}

function expectZeroAttempt(result: Awaited<ReturnType<typeof reconcilePostReviewSmoke>>, runtime: RuntimeFixture, input: Fixture): void {
  expect(result).toMatchObject({ handled: true, attempted: false });
  expect(runtime.spawnCount()).toBe(0);
  expect(runs(input)).toHaveLength(0);
}

afterEach(() => {
  vi.unstubAllEnvs();
  gh.head = '';
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #1418 r10 production pre-action fence failures', () => {
  it('keeps final runtime-authority unavailability pre-action and smoke-free', async () => {
    const { input, runtime, deps } = await readyCase('preaction-runtime-unavailable', 2);
    const result = await reconcilePostReviewSmoke(candidate(input), deps);
    expectZeroAttempt(result, runtime, input);
  });

  it('keeps assignment_store_busy pre-action and smoke-free', async () => {
    const { input, runtime, deps } = await readyCase('preaction-busy');
    const observation: FenceObservation = {};
    const lockPath = `${input.assignmentFile}.lock`;
    const admissionPath = path.join(input.workspace, '.orca-worker-smoke', 'admission.lock.json');
    let admissionObservedBeforeFence = false;
    const busy = withFenceMutation(deps, () => {
      admissionObservedBeforeFence = existsSync(admissionPath);
      mkdirSync(path.dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: 'busy', acquiredAtMs: Date.now() })}\n`);
      return () => rmSync(lockPath, { force: true });
    }, observation);
    const result = await reconcilePostReviewSmoke(candidate(input), busy);
    expect(observation).toEqual({ reason: 'assignment_store_busy', actionEntered: false });
    expect(admissionObservedBeforeFence).toBe(true);
    expect(existsSync(admissionPath)).toBe(false);
    expectZeroAttempt(result, runtime, input);
  });

  it('keeps assignment_stale pre-action and smoke-free', async () => {
    const { input, assignment, runtime, deps } = await readyCase('preaction-stale-g');
    const observation: FenceObservation = {};
    const stale = withFenceMutation(deps, async () => {
      await setLocalAssignment(input, 'preaction-stale-g-plus-1', {
        assignmentId: assignment.assignmentId,
        generation: assignment.generation,
      });
    }, observation);
    const result = await reconcilePostReviewSmoke(candidate(input), stale);
    expect(observation).toEqual({ reason: 'assignment_stale', actionEntered: false });
    expectZeroAttempt(result, runtime, input);
  });

  it('uses generic assignment_fence_failed as zero attempt only with observed non-entry', async () => {
    const { input, runtime, deps } = await readyCase('preaction-generic');
    const observation: FenceObservation = {};
    const storeDirectory = path.dirname(input.assignmentFile);
    const backup = `${storeDirectory}.backup`;
    const unavailable = withFenceMutation(deps, () => {
      renameSync(storeDirectory, backup);
      writeFileSync(storeDirectory, 'not-a-directory\n');
      return () => {
        rmSync(storeDirectory, { force: true });
        renameSync(backup, storeDirectory);
      };
    }, observation);
    const result = await reconcilePostReviewSmoke(candidate(input), unavailable);
    expect(observation).toEqual({ reason: 'assignment_fence_failed', actionEntered: false });
    expectZeroAttempt(result, runtime, input);
  });
});
