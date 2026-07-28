import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
  recordPackReviewPendingStatus,
  type PackReviewRequiredStatusRequest,
} from './lib/pack-review-delivery.js';
import {
  createPackReviewRun,
  getPackReviewRun,
  isPackReviewRunStale,
  listPackReviewRuns,
  terminalizePackReviewStaleRun,
  updatePackReviewRun,
} from './lib/pack-review-run-store.js';
import {
  reconcileStalePackReviewRuns,
  resolveRepositorySlug,
  startPackReview,
} from './pack-review-runner.js';

const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO_A = 'fixture/orchestrator-pack';
const REPO_B = 'fixture/other-repo';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const tempRoots: string[] = [];
const originalEnv = { ...process.env };

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function harnessEnv(storeRoot: string, capture: string): void {
  process.env.OPK_VITEST_HARNESS = '1';
  process.env.PACK_REVIEW_RUN_STALE_MINUTES = '2';
  process.env.PACK_REVIEW_REQUIRED_STATUS_CAPTURE_FILE = capture;
  process.env.PACK_REVIEWER = 'codex';
}

function seedActiveStaleRun(storeRoot: string, options: {
  prNumber?: number;
  headSha?: string;
  canonicalRepository?: string;
  sourceRepoRoot?: string;
  runnerPid?: number;
  heartbeatAtUtc?: string;
} = {}) {
  const created = createPackReviewRun({
    projectId: 'orchestrator-pack',
    storeRoot,
    prNumber: options.prNumber ?? 1067,
    headSha: options.headSha ?? HEAD_A,
    linkedSessionId: 'worker-1067',
    startReason: 'test',
    surface: 'pack-review-stale-reconcile-test',
    trustedPackRoot: repoRoot,
    sourceRepoRoot: options.sourceRepoRoot ?? repoRoot,
    canonicalRepository: options.canonicalRepository ?? REPO_A,
  });
  const staleTime = new Date(Date.now() - 15 * 60_000);
  updatePackReviewRun(created.run.id, {
    status: 'running',
    latestRunStatus: 'running',
    runnerPid: options.runnerPid ?? 9_999_999,
    heartbeatAtUtc: options.heartbeatAtUtc ?? staleTime.toISOString(),
  }, { projectId: 'orchestrator-pack', storeRoot, now: staleTime });
  return created.run.id;
}

function markRunStale(storeRoot: string, runId: string, runnerPid = 9_999_999): void {
  const staleTime = new Date(Date.now() - 15 * 60_000);
  updatePackReviewRun(runId, {
    status: 'running',
    latestRunStatus: 'running',
    runnerPid,
  }, { projectId: 'orchestrator-pack', storeRoot, now: staleTime });
}

async function writePendingForRun(storeRoot: string, runId: string, capture: string): Promise<void> {
  const run = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
  if (!run) throw new Error(`missing run ${runId}`);
  await recordPackReviewPendingStatus({
    projectId: 'orchestrator-pack',
    storeRoot,
    run,
    writeRequiredStatus: async (request) => {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      mkdirSync(path.dirname(capture), { recursive: true });
      writeFileSync(capture, `${JSON.stringify(request)}\n`);
    },
  });
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pack review stale reconciliation (Issue #1067)', () => {
  it('durably terminalizes an active stale run on reconcile (AC1)', async () => {
    const storeRoot = tempRoot('opk-1067-terminalize-');
    const capture = path.join(storeRoot, 'status.json');
    harnessEnv(storeRoot, capture);
    const runId = seedActiveStaleRun(storeRoot);
    await writePendingForRun(storeRoot, runId, capture);
    markRunStale(storeRoot, runId);

    const before = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    expect(before?.status).toBe('running');
    expect(isPackReviewRunStale(before!)).toBe(true);

    const result = await reconcileStalePackReviewRuns({
      repoSlug: REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
    });

    expect(result.results).toEqual([expect.objectContaining({
      runId,
      terminalized: true,
      statusReconciled: true,
    })]);

    const persisted = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    expect(persisted).toMatchObject({
      status: 'failed',
      latestRunStatus: 'failed',
      failureReason: 'runner_disappeared_stale',
      prNumber: 1067,
      targetSha: HEAD_A,
    });
    const status = JSON.parse(readFileSync(capture, 'utf8')) as PackReviewRequiredStatusRequest;
    expect(status.state).toBe('error');
    expect(status.context).toBe(PACK_REVIEW_REQUIRED_STATUS_CONTEXT);
  });

  it('leaves store and status writer untouched on list/status observation (AC2)', async () => {
    const storeRoot = tempRoot('opk-1067-read-purity-');
    const runId = seedActiveStaleRun(storeRoot);
    const beforeBytes = readFileSync(
      path.join(storeRoot, 'runs', `${runId}.json`),
      'utf8',
    );

    listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot });
    const projected = listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })[0];
    expect(projected?.status).toBe('failed');

    const afterBytes = readFileSync(
      path.join(storeRoot, 'runs', `${runId}.json`),
      'utf8',
    );
    expect(afterBytes).toBe(beforeBytes);
    expect(getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot })?.status).toBe('running');
  });

  it('stores canonical repository identity and rejects cross-repository reconciliation (AC3)', async () => {
    const storeRoot = tempRoot('opk-1067-repo-identity-');
    const capture = path.join(storeRoot, 'status.json');
    harnessEnv(storeRoot, capture);
    const runId = seedActiveStaleRun(storeRoot, { canonicalRepository: REPO_A });
    await writePendingForRun(storeRoot, runId, capture);
    markRunStale(storeRoot, runId);

    const created = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    expect(created?.canonicalRepository).toBe(REPO_A);

    expect(() => updatePackReviewRun(runId, {
      canonicalRepository: REPO_B,
    }, { projectId: 'orchestrator-pack', storeRoot })).not.toThrow();
    expect(getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot })?.canonicalRepository).toBe(REPO_A);

    markRunStale(storeRoot, runId);
    const mismatch = await reconcileStalePackReviewRuns({
      repoSlug: REPO_B,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
    });
    expect(mismatch.results[0]).toMatchObject({
      runId,
      terminalized: false,
      statusReconciled: false,
      reason: 'repository_mismatch',
    });
    expect(getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot })?.status).toBe('running');
  });

  it('resolves legacy repository identity from sourceRepoRoot when canonical field is absent (AC3)', async () => {
    const storeRoot = tempRoot('opk-1067-legacy-repo-');
    const capture = path.join(storeRoot, 'status.json');
    harnessEnv(storeRoot, capture);
    const runId = seedActiveStaleRun(storeRoot);
    const recordPath = path.join(storeRoot, 'runs', `${runId}.json`);
    const legacy = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    delete legacy.canonicalRepository;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(recordPath, `${JSON.stringify(legacy)}\n`);
    await writePendingForRun(storeRoot, runId, capture);
    markRunStale(storeRoot, runId);

    const result = await reconcileStalePackReviewRuns({
      repoSlug: REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
      resolveRepositorySlug: async () => REPO_A,
    });
    expect(result.results[0]).toMatchObject({ statusReconciled: true });
  });

  it('terminalizes stale runs on later same-repository start without list/status reads (AC4, AC7)', async () => {
    const storeRoot = tempRoot('opk-1067-next-start-');
    const staleCapture = path.join(storeRoot, 'stale-status.json');
    const startCapture = path.join(storeRoot, 'start-status.json');
    harnessEnv(storeRoot, staleCapture);
    const staleRunId = seedActiveStaleRun(storeRoot);
    await writePendingForRun(storeRoot, staleRunId, staleCapture);
    markRunStale(storeRoot, staleRunId);

    const stdout = JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] });
    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1067,
      headSha: HEAD_B,
      fixturePostReviewHeadSha: HEAD_B,
      claimMode: 'preacquired',
      fixtureRepoSlug: REPO_A,
      fixtureReviewStdout: stdout,
      fixtureRequiredStatusWriter: async (request) => {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(startCapture, `${JSON.stringify(request)}\n`);
      },
    });

    expect(result.ok).toBe(true);
    const staleRun = getPackReviewRun(staleRunId, { projectId: 'orchestrator-pack', storeRoot });
    expect(staleRun).toMatchObject({
      status: 'failed',
      failureReason: 'runner_disappeared_stale',
      targetSha: HEAD_A,
    });
    const staleStatus = JSON.parse(readFileSync(staleCapture, 'utf8')) as PackReviewRequiredStatusRequest;
    expect(staleStatus.state).toBe('error');
  });

  it('explicit reconcile alone completes stale pending status without starting a review (AC5)', async () => {
    const storeRoot = tempRoot('opk-1067-explicit-reconcile-');
    const capture = path.join(storeRoot, 'status.json');
    harnessEnv(storeRoot, capture);
    const runId = seedActiveStaleRun(storeRoot);
    await writePendingForRun(storeRoot, runId, capture);
    markRunStale(storeRoot, runId);

    const result = await reconcileStalePackReviewRuns({
      repoSlug: REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
    });
    expect(result.results[0]?.statusReconciled).toBe(true);

    const repeat = await reconcileStalePackReviewRuns({
      repoSlug: REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
    });
    expect(repeat.results[0]).toMatchObject({ reason: 'status_already_reconciled' });
    const status = JSON.parse(readFileSync(capture, 'utf8')) as PackReviewRequiredStatusRequest;
    expect(status.state).toBe('error');
  });

  it('does not overwrite a newer same-head run required status (AC6)', async () => {
    const storeRoot = tempRoot('opk-1067-newer-run-');
    const staleCapture = path.join(storeRoot, 'stale.json');
    const newerCapture = path.join(storeRoot, 'newer.json');
    harnessEnv(storeRoot, staleCapture);
    const staleRunId = seedActiveStaleRun(storeRoot);
    await writePendingForRun(storeRoot, staleRunId, staleCapture);
    markRunStale(storeRoot, staleRunId);

    const newer = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1067,
      headSha: HEAD_A,
      linkedSessionId: 'worker-newer',
      startReason: 'newer',
      surface: 'pack-review-stale-reconcile-test',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: REPO_A,
    });
    await recordPackReviewPendingStatus({
      projectId: 'orchestrator-pack',
      storeRoot,
      run: newer.run,
      writeRequiredStatus: async (request) => {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(newerCapture, `${JSON.stringify(request)}\n`);
      },
    });

    const result = await reconcileStalePackReviewRuns({
      repoSlug: REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
    });
    expect(result.results[0]).toMatchObject({
      runId: staleRunId,
      statusReconciled: false,
      reason: 'newer_run_authoritative',
    });
    const newerStatus = JSON.parse(readFileSync(newerCapture, 'utf8')) as PackReviewRequiredStatusRequest;
    expect(newerStatus.state).toBe('pending');
  });

  it('resumes required-status reconciliation after local terminalization only (AC8)', async () => {
    const storeRoot = tempRoot('opk-1067-interrupted-');
    const capture = path.join(storeRoot, 'status.json');
    harnessEnv(storeRoot, capture);
    const runId = seedActiveStaleRun(storeRoot);
    await writePendingForRun(storeRoot, runId, capture);
    markRunStale(storeRoot, runId);

    terminalizePackReviewStaleRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    expect(getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
      status: 'failed',
      failureReason: 'runner_disappeared_stale',
    });

    const resumed = await reconcileStalePackReviewRuns({
      repoSlug: REPO_A,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
    });
    expect(resumed.results[0]?.statusReconciled).toBe(true);
    const status = JSON.parse(readFileSync(capture, 'utf8')) as PackReviewRequiredStatusRequest;
    expect(status.state).toBe('error');
  });

  it('persists bounded failureReason for reviewer failures with noisy stdout/stderr (AC10)', async () => {
    const storeRoot = tempRoot('opk-1067-failure-hygiene-');
    const capture = path.join(storeRoot, 'status.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = path.join(storeRoot, 'invocations.jsonl');

    const sentinel = 'npm ERR! lifecycle helper --invoke-pack-review.ps1 --secret-argv-token';
    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1067,
      headSha: HEAD_A,
      claimMode: 'preacquired',
      fixtureRepoSlug: REPO_A,
      fixtureReviewStdout: sentinel,
      fixtureReviewExitCode: 1,
    });

    expect(result.ok).toBe(false);
    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    expect(run?.failureReason).toBe('reviewer_process_failed');
    expect(run?.failureReason).not.toContain('npm ERR!');
    expect(run?.failureReason).not.toContain('invoke-pack-review.ps1');
  });

  it('exports resolveRepositorySlug for production legacy identity resolution', () => {
    expect(typeof resolveRepositorySlug).toBe('function');
  });
});
