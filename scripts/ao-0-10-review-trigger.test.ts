import { execFileSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsHarness = vi.hoisted(() => ({
  actualRenameSync: undefined as typeof import('node:fs').renameSync | undefined,
  renameSync: vi.fn((source: string, destination: string) => {
    fsHarness.actualRenameSync!(source, destination);
  }),
}));
const cryptoHarness = vi.hoisted(() => ({
  actualRandomUUID: undefined as typeof import('node:crypto').randomUUID | undefined,
  randomUUID: vi.fn(() => cryptoHarness.actualRandomUUID!()),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsHarness.actualRenameSync = actual.renameSync;
  return { ...actual, renameSync: fsHarness.renameSync };
});
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  cryptoHarness.actualRandomUUID = actual.randomUUID;
  return { ...actual, randomUUID: cryptoHarness.randomUUID };
});

import {
  createPackReviewRun,
  getPackReviewRun,
  listPackReviewRuns,
  resolvePackReviewRunStoreRoot,
  setPackReviewRunTerminal,
  updatePackReviewRun,
} from './lib/pack-review-run-store.js';
import {
  resolveBindingFromCache,
  resolveTrustedRunnerPaths,
  startPackReview,
} from './pack-review-runner.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoots: string[] = [];
const originalEnv = { ...process.env };
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function runPwsh(script: string) {
  return execFileSync('pwsh', ['-NoProfile', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createRun(storeRoot: string, headSha = HEAD_A, surface = 'automatic') {
  return createPackReviewRun({
    storeRoot,
    projectId: 'orchestrator-pack',
    prNumber: 839,
    headSha,
    linkedSessionId: 'worker-839',
    startReason: surface,
    surface,
    trustedPackRoot: repoRoot,
    sourceRepoRoot: repoRoot,
  });
}

function useRealRename(): void {
  fsHarness.renameSync.mockReset();
  fsHarness.renameSync.mockImplementation((source, destination) => {
    fsHarness.actualRenameSync!(source, destination);
  });
}

function useRealRandomUUID(): void {
  cryptoHarness.randomUUID.mockReset();
  cryptoHarness.randomUUID.mockImplementation(() => cryptoHarness.actualRandomUUID!());
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function recordPath(storeRoot: string, runId: string): string {
  return path.join(resolvePackReviewRunStoreRoot({ storeRoot }), 'runs', `${runId}.json`);
}

function readRawRecord(recordFile: string): string {
  return readFileSync(recordFile, 'utf8');
}

function readRecordStatus(recordFile: string): string {
  return String((JSON.parse(readRawRecord(recordFile)) as { status?: unknown }).status ?? '');
}

beforeEach(() => {
  useRealRename();
  useRealRandomUUID();
});

afterEach(() => {
  useRealRename();
  useRealRandomUUID();
  process.env = { ...originalEnv };
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pack-owned review runner/store (Issue #839)', () => {
  it('contains no daemon review trigger/list path and retires the ao-review shim', () => {
    const adapter = readFileSync(path.join(repoRoot, 'scripts/lib/Invoke-AoReviewApi.ps1'), 'utf8');
    const runner = readFileSync(path.join(repoRoot, 'scripts/pack-review-runner.ts'), 'utf8');
    expect(adapter).not.toMatch(/\/api\/v1\/sessions\/.*\/reviews(?:\/trigger)?/);
    expect(adapter).not.toMatch(/Invoke-AoSessionReviewTrigger\s+-SessionId.*BaseUrl/);
    expect(runner).not.toMatch(/\bao\s+review\s+submit\b/);
    expect(existsSync(path.join(repoRoot, 'scripts/ao-review.ps1'))).toBe(false);
  });

  it('keeps the existing PowerShell consumer surface as thin pack-store glue', () => {
    const storeRoot = tempRoot('opk-review-adapter-');
    createRun(storeRoot);
    const adapterPath = path.join(repoRoot, 'scripts/lib/Invoke-AoReviewApi.ps1');
    process.env.PACK_REVIEW_RUN_STORE_ROOT = storeRoot;
    const output = runPwsh(`
      . '${adapterPath.replaceAll("'", "''")}'
      @(Get-AoReviewRunsFromWorkerSessions -Project 'orchestrator-pack').Count
    `).trim();
    expect(Number(output)).toBe(1);
  });

  it('resolves runner, reviewer, and store control surfaces from the trusted pack root', () => {
    const trusted = resolveTrustedRunnerPaths();
    expect(trusted.trustedPackRoot).toBe(path.resolve(repoRoot));
    expect(trusted.runnerPath).toBe(path.join(path.resolve(repoRoot), 'scripts/pack-review-runner.ts'));
    expect(trusted.reviewerPath).toBe(path.join(path.resolve(repoRoot), 'scripts/invoke-pack-review.ps1'));
    expect(trusted.claimPath).toBe(path.join(path.resolve(repoRoot), 'scripts/lib/Review-StartClaim.ps1'));
  });

  it('resolves a unique session binding and fails closed on ambiguity', () => {
    const root = tempRoot('opk-review-binding-');
    const cache = path.join(root, 'bindings.json');
    const row = {
      sessionId: 'worker-839',
      prNumber: 839,
      headSha: HEAD_A,
      repoSlug: 'chetwerikoff/orchestrator-pack',
      superseded: false,
    };
    writeFileSync(cache, JSON.stringify({ records: { one: row, duplicateAlias: row } }), 'utf8');
    expect(resolveBindingFromCache('worker-839', { ...process.env, AO_PR_SESSION_BINDING_CACHE: cache })).toMatchObject({
      prNumber: 839,
      headSha: HEAD_A,
    });

    writeFileSync(cache, JSON.stringify({ records: {
      one: row,
      conflict: { ...row, prNumber: 840 },
    } }), 'utf8');
    expect(() => resolveBindingFromCache('worker-839', { ...process.env, AO_PR_SESSION_BINDING_CACHE: cache }))
      .toThrow('binding ambiguous');
  });

  it.each([
    ['automatic/automatic', 'automatic', 'automatic'],
    ['manual/manual', 'manual', 'manual'],
    ['automatic/manual', 'automatic', 'manual'],
  ])('%s admits exactly one active run for the same PR/head', (_label, firstSurface, secondSurface) => {
    const storeRoot = tempRoot('opk-review-race-');
    const first = createRun(storeRoot, HEAD_A, firstSurface);
    const second = createRun(storeRoot, HEAD_A, secondSurface);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(listPackReviewRuns({ storeRoot })).toHaveLength(1);
  });

  it('keeps head A and head B as independent claim/store keys', () => {
    const storeRoot = tempRoot('opk-review-heads-');
    const first = createRun(storeRoot, HEAD_A);
    const second = createRun(storeRoot, HEAD_B);
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.run.key).not.toBe(second.run.key);
  });

  it('surfaces a disappeared stale runner as failed instead of indefinitely running', () => {
    const storeRoot = tempRoot('opk-review-stale-');
    process.env.PACK_REVIEW_RUN_STALE_MINUTES = '2';
    const created = createRun(storeRoot);
    const file = recordPath(storeRoot, created.run.id);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    record.status = 'running';
    record.latestRunStatus = 'running';
    record.runnerPid = 999_999_999;
    record.updatedAt = '2000-01-01T00:00:00.000Z';
    record.heartbeatAtUtc = record.updatedAt;
    writeFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    expect(listPackReviewRuns({ storeRoot })[0]).toMatchObject({
      status: 'failed',
      latestRunStatus: 'failed',
      stale: true,
      failureReason: 'runner_disappeared_stale',
    });
  });

  it('fails closed on corrupt and duplicate-active store records', () => {
    const storeRoot = tempRoot('opk-review-corrupt-');
    const created = createRun(storeRoot);
    const runsDir = path.join(resolvePackReviewRunStoreRoot({ storeRoot }), 'runs');
    writeFileSync(path.join(runsDir, 'prr-corrupt.json'), '{', 'utf8');
    expect(() => listPackReviewRuns({ storeRoot })).toThrow('corrupt pack review run record');
    rmSync(path.join(runsDir, 'prr-corrupt.json'));

    const duplicate = { ...created.run, id: 'prr-duplicate', runId: 'prr-duplicate' };
    writeFileSync(path.join(runsDir, 'prr-duplicate.json'), `${JSON.stringify(duplicate)}\n`, 'utf8');
    expect(() => listPackReviewRuns({ storeRoot })).toThrow('multiple active records');
  });

  it('completes without ao review submit and records an APPROVE GitHub review', async () => {
    const storeRoot = tempRoot('opk-review-clean-');
    const capture = path.join(storeRoot, 'github-review.json');
    process.env.OPK_VITEST_HARNESS = '1';
    process.env.PACK_REVIEW_GITHUB_REVIEW_CAPTURE_FILE = capture;
    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 839,
      headSha: HEAD_A,
      claimMode: 'preacquired',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureGithubReviewId: 83901,
      fixtureReviewStdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
    });
    expect(result).toMatchObject({ ok: true, status: 'up_to_date', githubReviewId: 83901 });
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toMatchObject({
      prNumber: 839,
      commitId: HEAD_A,
      event: 'APPROVE',
    });
    expect(listPackReviewRuns({ storeRoot })[0]).toMatchObject({ status: 'up_to_date', exitCode: 0 });
  });

  it('records terminal failed status when the reviewer exits nonzero', async () => {
    const storeRoot = tempRoot('opk-review-failed-');
    process.env.OPK_VITEST_HARNESS = '1';
    const result = await startPackReview({
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 839,
      headSha: HEAD_A,
      claimMode: 'preacquired',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureReviewStdout: 'review failed',
      fixtureReviewExitCode: 7,
    });
    expect(result.ok).toBe(false);
    expect(listPackReviewRuns({ storeRoot })[0]).toMatchObject({ status: 'failed', exitCode: 7 });
  });

  it('records terminal timed_out status when the reviewer times out', async () => {
    const storeRoot = tempRoot('opk-review-timeout-');
    process.env.OPK_VITEST_HARNESS = '1';
    const result = await startPackReview({
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 839,
      headSha: HEAD_A,
      claimMode: 'preacquired',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureReviewTimedOut: true,
    });
    expect(result.ok).toBe(false);
    expect(listPackReviewRuns({ storeRoot })[0]).toMatchObject({
      status: 'timed_out',
      latestRunStatus: 'timed_out',
      failureReason: 'reviewer_process_timeout',
    });
  });

  it('does not let a divergent reviewed-worktree runner/store override trusted control code', async () => {
    const storeRoot = tempRoot('opk-review-shadow-store-');
    const reviewedRoot = tempRoot('opk-review-shadow-worktree-');
    mkdirSync(path.join(reviewedRoot, 'scripts/lib'), { recursive: true });
    writeFileSync(path.join(reviewedRoot, 'scripts/pack-review-runner.ts'), 'throw new Error("shadow runner executed")', 'utf8');
    writeFileSync(path.join(reviewedRoot, 'scripts/lib/pack-review-run-store.ts'), 'throw new Error("shadow store executed")', 'utf8');
    process.env.OPK_VITEST_HARNESS = '1';
    const result = await startPackReview({
      storeRoot,
      sourceRepoRoot: reviewedRoot,
      prNumber: 839,
      headSha: HEAD_A,
      claimMode: 'preacquired',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureGithubReviewId: 83902,
      fixtureReviewStdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
    });
    expect(result.ok).toBe(true);
    expect(listPackReviewRuns({ storeRoot })[0]?.trustedPackRoot).toBe(path.resolve(repoRoot));
  });

  it('allows a new run after the previous run is terminal', () => {
    const storeRoot = tempRoot('opk-review-terminal-');
    const first = createRun(storeRoot);
    setPackReviewRunTerminal(first.run.id, 'failed', { exitCode: 1 }, { storeRoot });
    expect(createRun(storeRoot).created).toBe(true);
  });
});

describe('pack review-run record atomic replacement (Issue #861)', () => {
  it('positive-outcome: lands a terminal status through the public readers', () => {
    const storeRoot = tempRoot('opk-review-atomic-positive-');
    const created = createRun(storeRoot);
    fsHarness.renameSync.mockClear();

    setPackReviewRunTerminal(created.run.id, 'up_to_date', {}, {
      storeRoot,
      now: new Date('2026-07-16T08:01:00.000Z'),
    });

    expect(fsHarness.renameSync).toHaveBeenCalledTimes(1);
    expect(getPackReviewRun(created.run.id, { storeRoot })?.status).toBe('up_to_date');
    expect(listPackReviewRuns({ storeRoot })).toEqual([
      expect.objectContaining({
        id: created.run.id,
        status: 'up_to_date',
        latestRunStatus: 'up_to_date',
      }),
    ]);
  });

  it('keeps the prior parseable record when rename is interrupted before taking effect', () => {
    const storeRoot = tempRoot('opk-review-atomic-interrupt-');
    const created = createRun(storeRoot);
    const file = recordPath(storeRoot, created.run.id);
    const prior = readRawRecord(file);
    fsHarness.renameSync.mockReset();
    fsHarness.renameSync.mockImplementationOnce(() => {
      throw errno('EIO', 'simulated interruption before rename effect');
    });

    expect(() => updatePackReviewRun(created.run.id, {
      status: 'reviewing',
      latestRunStatus: 'reviewing',
    }, { storeRoot })).toThrow(/simulated interruption/);

    expect(existsSync(file)).toBe(true);
    expect(readRawRecord(file)).toBe(prior);
    expect(readRecordStatus(file)).toBe('queued');
    expect(readdirSync(path.dirname(file)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('retries the rename itself after transient contention without deleting the destination', () => {
    const storeRoot = tempRoot('opk-review-atomic-retry-');
    const created = createRun(storeRoot);
    const file = recordPath(storeRoot, created.run.id);
    const prior = readRawRecord(file);
    let observedDuringFailure = '';
    fsHarness.renameSync.mockReset();
    fsHarness.renameSync
      .mockImplementationOnce((_source, destination) => {
        observedDuringFailure = readFileSync(destination, 'utf8');
        throw errno('EBUSY', 'simulated transient contention');
      })
      .mockImplementation((source, destination) => {
        fsHarness.actualRenameSync!(source, destination);
      });

    updatePackReviewRun(created.run.id, {
      status: 'reviewing',
      latestRunStatus: 'reviewing',
    }, { storeRoot });

    expect(fsHarness.renameSync).toHaveBeenCalledTimes(2);
    expect(observedDuringFailure).toBe(prior);
    expect(readRecordStatus(file)).toBe('reviewing');
  });

  it('bounds transient retries, reports exhaustion, preserves a record, and releases the store lock', () => {
    const storeRoot = tempRoot('opk-review-atomic-exhausted-');
    const created = createRun(storeRoot);
    const file = recordPath(storeRoot, created.run.id);
    fsHarness.renameSync.mockReset();
    fsHarness.renameSync.mockImplementation(() => {
      throw errno('EPERM', 'simulated persistent contention');
    });

    expect(() => updatePackReviewRun(created.run.id, {
      status: 'reviewing',
      latestRunStatus: 'reviewing',
    }, { storeRoot })).toThrow(/rename_retry_exhausted code=EPERM attempts=4/);

    expect(fsHarness.renameSync).toHaveBeenCalledTimes(4);
    expect(existsSync(file)).toBe(true);
    expect(['queued', 'reviewing']).toContain(readRecordStatus(file));
    expect(existsSync(path.join(storeRoot, '.store-lock'))).toBe(false);

    useRealRename();
    expect(updatePackReviewRun(created.run.id, {
      status: 'reviewing',
      latestRunStatus: 'reviewing',
    }, { storeRoot }).status).toBe('reviewing');
  });

  it('keeps create-only collision behavior unchanged', () => {
    const storeRoot = tempRoot('opk-review-atomic-create-only-');
    const created = createRun(storeRoot);
    setPackReviewRunTerminal(created.run.id, 'up_to_date', {}, { storeRoot });
    const compact = created.run.id.slice('prr-'.length);
    const collisionUuid = [
      compact.slice(0, 8),
      compact.slice(8, 12),
      compact.slice(12, 16),
      compact.slice(16, 20),
      compact.slice(20),
    ].join('-') as `${string}-${string}-${string}-${string}-${string}`;
    cryptoHarness.randomUUID
      .mockImplementationOnce(() => '11111111-1111-4111-8111-111111111111')
      .mockImplementationOnce(() => collisionUuid);

    expect(() => createRun(storeRoot)).toThrow(
      `pack review run already exists: ${created.run.id}`,
    );
  });
});
