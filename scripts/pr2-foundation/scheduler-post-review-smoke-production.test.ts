// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProcessSync } from '../kernel/subprocess.ts';
import { publishCurrentWorkerAssignment, resolveWorkerAssignmentStorePath, type WorkerAssignment } from '../lib/worker-assignment-store.ts';
import { readSmokeLifecycleRegistry } from '../lib/worker-smoke-lifecycle.ts';
import { commitPackReviewTerminal, initializePackReviewAuthority, recordPackReviewPublication, type PackReviewAuthorityOptions } from '../pack-review-state.ts';
import type { RuntimeAdapter, RuntimeWorker, RuntimeWorkerIdentity } from '../runtime/contracts.ts';
import { DeterministicRuntimeAdapter } from '../runtime/test-adapter.ts';
import { runSmokeAttempt } from '../worker-smoke-run.ts';
import { reconcilePostReviewSmoke, type PostReviewSmokeDependencies } from './post-review-smoke.ts';
import { createProductionPostReviewSmokeReconciler, runSchedulerTick, type SchedulerBoundary, type SchedulerCurrentPr } from './scheduler.ts';

const REPO = 'chetwerikoff/orchestrator-pack';
const TASK_ISSUE = 1418;
const TASK_PR = 1481;
const tempRoots: string[] = [];
const liveGh = vi.hoisted(() => ({ body: '', head: '' }));

vi.mock('../lib/gh-repo-resolve.mjs', () => ({
  ghApiJson: vi.fn((_command: string, endpoint: string) => {
    if (endpoint === 'user') return { login: 'scheduler-fixture' };
    if (endpoint.endsWith(`/issues/${TASK_ISSUE}`)) return { number: TASK_ISSUE, state: 'open', body: liveGh.body, html_url: `https://github.com/${REPO}/issues/${TASK_ISSUE}` };
    if (endpoint.endsWith(`/pulls/${TASK_PR}`)) return { number: TASK_PR, state: 'open', body: `Closes #${TASK_ISSUE}`, head: { sha: liveGh.head }, html_url: `https://github.com/${REPO}/pull/${TASK_PR}` };
    throw new Error(`unexpected scheduler fixture endpoint: ${endpoint}`);
  }),
}));

function gitAt(cwd: string, ...args: string[]): string {
  const result = runProcessSync({ command: 'git', args, cwd, inheritParentEnv: true });
  if (!result.ok) throw new Error(`fixture git failed: ${args.join(' ')}:${result.stderr || result.error || result.exitCode}`);
  return result.stdout.trim();
}

function newWorkspace(root: string): { path: string; head: string } {
  const workspace = path.join(root, 'runtime-worktree');
  mkdirSync(workspace, { recursive: true });
  for (const args of [
    ['init'], ['config', 'user.name', 'Production Smoke'], ['config', 'user.email', 'production-smoke@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
  ]) gitAt(workspace, ...args);
  writeFileSync(path.join(workspace, '.gitignore'), '.orca-worker-smoke/\n', 'utf8');
  writeFileSync(path.join(workspace, 'fixture.txt'), 'production scheduler smoke\n', 'utf8');
  gitAt(workspace, 'add', '.gitignore', 'fixture.txt');
  gitAt(workspace, 'commit', '-m', 'production-smoke-fixture');
  gitAt(workspace, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`);
  return { path: workspace, head: gitAt(workspace, 'rev-parse', 'HEAD').toLowerCase() };
}

function smokeIssueBody(): string {
  return '```behavior-kind\naction-producing\n```\n\n```complexity-tier\ntier: T3\nadvisory-prior: T3\n```\n\n```smoke-test-plan\nscenarios:\n  - action: exercise scheduler production start | expected: existing lifecycle records start\n```';
}

type Fixture = ReturnType<typeof makeFixture>;
function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-production-scheduler-smoke-'));
  tempRoots.push(root);
  const workspace = newWorkspace(root);
  const reviewRoot = path.join(root, 'review-authority');
  const assignmentFile = resolveWorkerAssignmentStorePath('orchestrator-pack', { ...process.env, OPK_BASE_DIR: path.join(root, 'state') });
  return { root, workspace: workspace.path, head: workspace.head, reviewRoot, assignmentFile, receiptRoot: path.join(root, 'receipts'), reviewOptions: { storeRoot: reviewRoot } satisfies PackReviewAuthorityOptions };
}

function completeReview(f: Fixture): void {
  const authority = initializePackReviewAuthority({ prNumber: TASK_PR, headSha: f.head, tier: 'T3', options: f.reviewOptions });
  const terminalRecord = {
    schemaVersion: 1, terminalContractVersion: 2, terminalSource: 'normal', runId: 'production-scheduler-review',
    targetSha: f.head, reviewVerdict: 'clean', findingCount: 0, findingsDigest: 'scheduler-production-clean',
  } as const;
  const terminal = commitPackReviewTerminal({ prNumber: TASK_PR, expectedTransitionSeq: authority.transitionSeq, terminal: terminalRecord, status: 'up_to_date', findingCount: 0, options: f.reviewOptions });
  recordPackReviewPublication({
    prNumber: TASK_PR, expectedTransitionSeq: terminal.transitionSeq, options: f.reviewOptions,
    publication: { headSha: f.head, terminalRunId: terminalRecord.runId, status: 'succeeded', publicationDigest: 'scheduler-production-publication', recordedAtUtc: '2026-08-19T00:01:00.000Z' },
  });
}

async function assignLocal(f: Fixture, bindingKey: string, previous?: Pick<WorkerAssignment, 'assignmentId' | 'generation'>): Promise<WorkerAssignment> {
  const result = await publishCurrentWorkerAssignment({
    file: f.assignmentFile, repository: REPO, issueNumber: TASK_ISSUE, taskId: 'task-production-smoke',
    kind: 'local', provider: 'orca', bindingKey, role: 'worker', ...(previous ? { expectedCurrent: previous } : {}),
  });
  if (!result.ok) throw new Error(result.reason);
  return result.assignment;
}

type Hooks = { resolve?: (count: number) => void; dispatch?: () => void; dispatchFails?: boolean; wrapSpawn?: (worker: RuntimeWorker) => RuntimeWorker };
function runtime(bindingKey: string, workspace: string, hooks: Hooks = {}) {
  const adapter = new DeterministicRuntimeAdapter();
  const owner = adapter.spawnWorker({ title: 'production-owner', command: 'cursor-agent', workspace });
  if (owner.status !== 'ok') throw new Error('production owner fixture failed');
  const originalSpawn = adapter.spawnWorker.bind(adapter);
  const originalDispatch = adapter.dispatchInput.bind(adapter);
  let resolutions = 0;
  let smokeSpawns = 0;
  Object.defineProperties(adapter, {
    resolveAssignmentWorker: { configurable: true, value: vi.fn((selector: { bindingKey?: string }) => {
      if (selector.bindingKey !== bindingKey) return { status: 'ok' as const, value: { kind: 'gone' as const } };
      hooks.resolve?.(++resolutions);
      return { status: 'ok' as const, value: { kind: 'resolved' as const, worker: owner.value } };
    }) },
    readiness: { configurable: true, value: vi.fn(() => ({ status: 'ok' as const, value: { ready: true as const, workspacePath: workspace, headSha: gitAt(workspace, 'rev-parse', 'HEAD').toLowerCase() } })) },
    spawnWorker: { configurable: true, value: vi.fn((input: Parameters<RuntimeAdapter['spawnWorker']>[0]) => {
      smokeSpawns += 1;
      const spawned = originalSpawn(input);
      return spawned.status === 'ok' && hooks.wrapSpawn ? { status: 'ok' as const, value: hooks.wrapSpawn(spawned.value) } : spawned;
    }) },
    dispatchInput: { configurable: true, value: vi.fn((input: Parameters<RuntimeAdapter['dispatchInput']>[0]) => {
      hooks.dispatch?.();
      return hooks.dispatchFails ? { status: 'send_failed' as const, reason: 'production-dispatch-fixture' } : originalDispatch(input);
    }) },
  });
  return { adapter: adapter as unknown as RuntimeAdapter, smokeSpawns: () => smokeSpawns };
}

function setSmokeEnv(f: Fixture): void {
  const values = {
    PACK_REVIEW_RUN_STORE_ROOT: f.reviewRoot, WORKER_SMOKE_RECEIPT_ROOT: f.receiptRoot,
    PACK_EXECUTOR_SMOKE_ROUTINE_AGENT: 'cursor', PACK_EXECUTOR_SMOKE_ROUTINE_MODEL: 'fixture-routine', PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT: 'medium',
    PACK_EXECUTOR_SMOKE_COMPLEX_AGENT: 'cursor', PACK_EXECUTOR_SMOKE_COMPLEX_MODEL: 'fixture-complex', PACK_EXECUTOR_SMOKE_COMPLEX_EFFORT: 'high',
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

function smokeDeps(f: Fixture, adapter: RuntimeAdapter): PostReviewSmokeDependencies {
  const body = smokeIssueBody();
  return {
    projectId: 'orchestrator-pack', repoRoot: f.workspace, assignmentStorePath: f.assignmentFile, adapter,
    env: { ...process.env, PACK_REVIEW_RUN_STORE_ROOT: f.reviewRoot }, ciGreen: () => true, readIssueBody: async () => body,
    runAttempt: (options, dependencies) => runSmokeAttempt({ ...options, dryRun: true }, dependencies),
  };
}

function candidatePr(f: Fixture): SchedulerCurrentPr { return { number: TASK_PR, headRefOid: f.head, state: 'OPEN', isDraft: false, body: `Closes #${TASK_ISSUE}` }; }
function boundary(f: Fixture, deps: PostReviewSmokeDependencies, smoke?: SchedulerBoundary['reconcilePostReviewSmoke']): SchedulerBoundary {
  const reconcile = smoke ?? ((candidate, fresh) => reconcilePostReviewSmoke({ repoSlug: candidate.repoSlug, prNumber: candidate.prNumber, headSha: fresh.headRefOid, prBody: fresh.body ?? '' }, deps));
  return {
    listCandidates: () => [{ sessionId: 'production-worker', repoSlug: REPO, prNumber: TASK_PR, boundHeadSha: f.head }],
    readCurrentPr: async () => candidatePr(f), readChecks: async () => [], listReviewRuns: () => [], start: async () => ({ ok: true }),
    reconcilePostReviewSmoke: reconcile,
  };
}

function schedulerEnv(root: string): NodeJS.ProcessEnv {
  const authority = path.join(root, 'epoch-authority.json');
  const epochId = 'production-smoke-epoch';
  const nonce = 'production-smoke-nonce';
  const record = { epochId, nonce, hostId: 'fixture-host', repoRoot: process.cwd(), installedCommitSha: 'a'.repeat(40), snapshotDigests: {}, importDigests: {}, registryHash: 'registry', preCommitLogDigest: 'log', commitAt: '2026-08-19T00:00:00.000Z' };
  writeFileSync(authority, JSON.stringify({ schemaVersion: 1, currentEpochId: epochId, records: [record] }), 'utf8');
  return { ...process.env, ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: authority, ORCHESTRATOR_CUTOVER_EPOCH_ID: epochId, ORCHESTRATOR_CUTOVER_NONCE: nonce };
}

function smokeRuns(workspace: string): string[] {
  const directory = path.join(workspace, '.orca-worker-smoke', 'runs');
  return existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(directory, entry.name)).sort() : [];
}

function workerWhoseFirstIdReadFails(worker: RuntimeWorker): RuntimeWorker {
  let reads = 0;
  const source = worker.identity;
  const identity = Object.create(null) as RuntimeWorkerIdentity;
  Object.defineProperty(identity, 'runtime', { enumerable: true, value: source.runtime });
  Object.defineProperty(identity, 'generation', { enumerable: true, value: source.generation });
  Object.defineProperty(identity, 'id', { enumerable: true, get() { if (++reads === 1) throw new Error('production-pre-bind-fixture'); return source.id; } });
  return { ...worker, identity };
}

afterEach(() => {
  vi.unstubAllEnvs();
  liveGh.body = '';
  liveGh.head = '';
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('scheduler production smoke uses the existing lifecycle surface', () => {
  it('records the real reservation/spawn/bind prefix through runSchedulerTick', async () => {
    const f = makeFixture(); setSmokeEnv(f); completeReview(f); liveGh.body = smokeIssueBody(); liveGh.head = f.head;
    const assignment = await assignLocal(f, 'production-prefix');
    let sawBound = false;
    const rt = runtime(assignment.bindingKey, f.workspace, { dispatchFails: true, dispatch: () => { sawBound = smokeRuns(f.workspace).some((run) => readSmokeLifecycleRegistry(run)?.spawnState === 'bound'); } });
    const result = await runSchedulerTick(boundary(f, smokeDeps(f, rt.adapter)), schedulerEnv(f.root));
    expect(result).toMatchObject({ attempted: 1, started: 0, skipped: 1 });
    expect(rt.smokeSpawns()).toBe(1);
    expect(sawBound).toBe(true);
  });

  it('starts zero lifecycle work when reassignment wins before the final fence', async () => {
    const f = makeFixture(); setSmokeEnv(f); completeReview(f); liveGh.body = smokeIssueBody(); liveGh.head = f.head;
    const assignment = await assignLocal(f, 'production-old-generation');
    const rt = runtime(assignment.bindingKey, f.workspace);
    const original = smokeDeps(f, rt.adapter);
    const raced: PostReviewSmokeDependencies = { ...original, runAttempt: async (options, dependencies) => {
      await assignLocal(f, 'production-new-generation', { assignmentId: assignment.assignmentId, generation: assignment.generation });
      return original.runAttempt!(options, dependencies);
    } };
    await runSchedulerTick(boundary(f, raced), schedulerEnv(f.root));
    expect(rt.smokeSpawns()).toBe(0);
    expect(smokeRuns(f.workspace)).toEqual([]);
  });

  it('keeps a post-reservation exception ambiguous and non-duplicating on the next scheduler tick', async () => {
    const f = makeFixture(); setSmokeEnv(f); completeReview(f); liveGh.body = smokeIssueBody(); liveGh.head = f.head;
    const assignment = await assignLocal(f, 'production-reservation-failure');
    const authorityFile = path.join(f.reviewRoot, 'authority', `pr-${TASK_PR}.json`);
    let validAuthority = '';
    const rt = runtime(assignment.bindingKey, f.workspace, { resolve: (count) => { if (count === 2) { validAuthority = readFileSync(authorityFile, 'utf8'); writeFileSync(authorityFile, '{broken-production-authority\n', 'utf8'); } } });
    const scheduler = boundary(f, smokeDeps(f, rt.adapter));
    const env = schedulerEnv(f.root);
    await runSchedulerTick(scheduler, env);
    const firstRuns = smokeRuns(f.workspace);
    expect(firstRuns).toHaveLength(1);
    expect(readSmokeLifecycleRegistry(firstRuns[0]!)).toMatchObject({ spawnState: 'ambiguous_unbound', headSha: f.head });
    expect(rt.smokeSpawns()).toBe(0);
    writeFileSync(authorityFile, validAuthority, 'utf8');
    await runSchedulerTick(scheduler, env);
    expect(rt.smokeSpawns()).toBe(0);
    expect(smokeRuns(f.workspace)).toEqual(firstRuns);
  });

  it('keeps post-spawn/pre-bind failure to one runtime spawn across scheduler reconciliation', async () => {
    const f = makeFixture(); setSmokeEnv(f); completeReview(f); liveGh.body = smokeIssueBody(); liveGh.head = f.head;
    const assignment = await assignLocal(f, 'production-pre-bind-failure');
    const rt = runtime(assignment.bindingKey, f.workspace, { wrapSpawn: workerWhoseFirstIdReadFails });
    const scheduler = boundary(f, smokeDeps(f, rt.adapter));
    const env = schedulerEnv(f.root);
    await runSchedulerTick(scheduler, env);
    const firstRuns = smokeRuns(f.workspace);
    expect(firstRuns).toHaveLength(1);
    expect(readSmokeLifecycleRegistry(firstRuns[0]!)?.spawnState).not.toBe('clean');
    expect(rt.smokeSpawns()).toBe(1);
    await runSchedulerTick(scheduler, env);
    expect(rt.smokeSpawns()).toBe(1);
    expect(smokeRuns(f.workspace)).toEqual(firstRuns);
  });

  it('re-selects RuntimeAdapter on each later smoke reconciliation after transient unavailability', async () => {
    const f = makeFixture(); completeReview(f);
    const adapter = new DeterministicRuntimeAdapter() as unknown as RuntimeAdapter;
    const selector = vi.fn().mockRejectedValueOnce(new Error('runtime temporarily unavailable')).mockResolvedValue(adapter);
    const reconcile = createProductionPostReviewSmokeReconciler({ projectId: 'orchestrator-pack', repoRoot: f.workspace, assignmentStorePath: f.assignmentFile, env: { ...process.env, PACK_REVIEW_RUN_STORE_ROOT: f.reviewRoot }, selectAdapter: selector });
    const placeholder = { projectId: 'orchestrator-pack', repoRoot: f.workspace, assignmentStorePath: f.assignmentFile, adapter } satisfies PostReviewSmokeDependencies;
    const scheduler = boundary(f, placeholder, reconcile);
    const env = schedulerEnv(f.root);
    await runSchedulerTick(scheduler, env);
    await runSchedulerTick(scheduler, env);
    expect(selector).toHaveBeenCalledTimes(2);
  });
});