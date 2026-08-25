// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProcessSync } from './kernel/subprocess.ts';
import {
  reconcileStalePackReviewRuns,
  startPackReview,
} from './pack-review-runner.ts';
import {
  commitPackReviewTerminal,
  commitPackReviewTriage,
  commitSmokeOrderingTransition,
  initializePackReviewAuthority,
  observePackReviewHead,
  readPackReviewAuthority,
  selectPackReviewEvidence,
  stagePackReviewImmutableRecord,
} from './pack-review-state.ts';
import {
  createPackReviewRun,
  getPackReviewRun,
  listPackReviewRuns,
  setPackReviewRunTerminal,
  updatePackReviewRun,
  type PackReviewGptRoundRecord,
} from './lib/pack-review-run-store.ts';
import {
  formatPackGptSourceCommentEnvelope,
  type PackGptSourceIdentity,
} from './lib/pack-gpt-source-comment-contract.ts';
import type {
  PackGptSourceCommentTransport,
  PackGptSourceGithubComment,
} from './lib/pack-gpt-source-comment.ts';
import type {
  GithubReviewSummary,
  GithubReviewTransport,
} from './lib/github-review-reconciliation.ts';
import { computeBoundIssueSnapshotHash } from './lib/reverify-bound-issue-snapshot.ts';

const REPO = 'chetwerikoff/orchestrator-pack';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);
const FINAL_FIX_DIGEST = 'f'.repeat(64);
const PROJECT = 'orchestrator-pack';
const roots: string[] = [];
const originalEnv = { ...process.env };
const repoRoot = join(import.meta.dirname, '..');

function tempRoot(prefix = 'opk-1591-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function issueBody(tier: 'T1' | 'T2' = 'T1'): string {
  return [
    '```complexity-tier',
    `tier: ${tier}`,
    `advisory-prior: ${tier}`,
    '```',
    '',
    '```denylist',
    '# No Issue-specific denylist entries; repository policy remains authoritative.',
    '```',
  ].join('\n');
}

function harness(storeRoot: string): void {
  process.env.OPK_VITEST_HARNESS = '1';
  process.env.PACK_REVIEWER = 'codex';
  process.env.PACK_REVIEW_RUN_STALE_MINUTES = '2';
  process.env.OPK_BASE_DIR = join(storeRoot, 'base');
  process.env.OPK_REVIEW_CLAIM_DIR = join(storeRoot, 'base', 'projects', PROJECT, 'review-start-claims');
  process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR = join(storeRoot, 'bound-issue-snapshots');
}

function writeSuccessfulGhFixture(binRoot: string): void {
  if (process.platform === 'win32') {
    writeFileSync(join(binRoot, 'gh.cmd'), '@echo off\r\nexit /b 0\r\n', 'utf8');
    return;
  }
  const fixture = join(binRoot, 'gh');
  writeFileSync(fixture, '#!/usr/bin/env node\nprocess.exitCode = 0;\n', 'utf8');
  chmodSync(fixture, 0o755);
}

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...originalEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function normalStart(storeRoot: string, overrides: Record<string, unknown> = {}) {
  return startPackReview({
    projectId: PROJECT,
    storeRoot,
    sourceRepoRoot: repoRoot,
    prNumber: 1591,
    headSha: HEAD_A,
    fixtureCurrentPrHeadSha: HEAD_A,
    fixturePrState: 'OPEN',
    fixturePrBody: 'Closes #1591',
    fixturePostReviewHeadSha: HEAD_A,
    fixturePostReviewPrBody: 'Closes #1591',
    fixtureRepoSlug: REPO,
    fixtureIssueBody: issueBody(),
    fixtureIssueNumber: 1591,
    fixtureReviewStdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
    fixtureGithubReviewId: 1591,
    fixtureRequiredStatusWriter: async () => {},
    fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    claimMode: 'preacquired' as const,
    ...overrides,
  });
}

function directOperatorStart(storeRoot: string, headSha = HEAD_A): ReturnType<typeof runProcessSync> {
  const binRoot = tempRoot('opk-1591-gh-bin-');
  writeSuccessfulGhFixture(binRoot);
  const capture = join(storeRoot, `operator-${headSha.slice(0, 1)}-review.json`);
  return runProcessSync({
    command: process.execPath,
    args: [
      '--experimental-strip-types',
      join(repoRoot, 'scripts', 'pack-review-runner.ts'),
      'start',
      '--pr-number', '1591',
      '--head-sha', headSha,
      '--operator-repository', REPO,
      '--operator-issue-number', '1591',
      '--operator-reason', 'manual chat review',
    ],
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      OPK_VITEST_HARNESS: '1',
      PACK_REVIEWER: 'codex',
      PACK_REVIEW_GITHUB_REVIEW_CAPTURE_FILE: capture,
      PATH: `${binRoot}${delimiter}${process.env.PATH ?? ''}`,
    },
    input: JSON.stringify({
      projectId: PROJECT,
      storeRoot,
      sourceRepoRoot: repoRoot,
      fixtureCurrentPrHeadSha: headSha,
      fixturePrState: 'OPEN',
      fixturePrBody: 'Closes #1591',
      fixturePostReviewHeadSha: headSha,
      fixturePostReviewPrBody: 'Closes #1591',
      fixtureRepoSlug: REPO,
      fixtureIssueBody: issueBody(),
      fixtureIssueNumber: 1591,
      fixtureReviewStdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
      fixtureGithubReviewId: 1592,
    }),
  });
}

function parseLastJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)!) as Record<string, unknown>;
}

describe('Issue #1591 launcher-independent consuming semantics', () => {
  it('reuses a completed same-head review instead of creating an explicit-extra run', async () => {
    const storeRoot = tempRoot();
    harness(storeRoot);
    const first = await normalStart(storeRoot);
    expect(first.ok).toBe(true);
    expect(listPackReviewRuns({ projectId: PROJECT, storeRoot })).toHaveLength(1);

    const manual = directOperatorStart(storeRoot);
    const result = parseLastJson(manual.stdout);
    expect(result.created).toBe(false);
    expect(result.reused).toBe(true);
    expect(String(result.reason)).toMatch(/terminal_run_exists|claimed/);
    const runs = listPackReviewRuns({ projectId: PROJECT, storeRoot });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.automaticBudgetDisposition).toBe('consume');
  });

  it('does not let a manual/chat launch bypass final-cap admission on a new head', async () => {
    const storeRoot = tempRoot();
    harness(storeRoot);
    const first = await normalStart(storeRoot, {
      fixtureReviewStdout: JSON.stringify({
        verdict: 'findings',
        findingCount: 1,
        findings: [{ title: 'blocking', severity: 'blocking', filePath: 'scripts/pack-review-runner.ts' }],
      }),
      fixtureChangedPaths: ['scripts/pack-review-runner.ts'],
      fixtureBoundIssueSnapshotBytes: issueBody(),
    });
    expect(first.ok).toBe(true);
    expect(readPackReviewAuthority(1591, { storeRoot })?.cycle?.state).toBe('at_cap_open_findings');

    const manual = directOperatorStart(storeRoot, HEAD_B);
    const result = parseLastJson(manual.stdout);
    expect(result).toMatchObject({
      ok: false,
      created: false,
      reused: false,
      reason: 'at_cap_continuation_required',
    });
    expect(listPackReviewRuns({ projectId: PROJECT, storeRoot })).toHaveLength(1);
  });

  it('reads legacy non-consuming records but refuses to produce a new one', () => {
    const storeRoot = tempRoot();
    harness(storeRoot);
    const legacy = createPackReviewRun({
      projectId: PROJECT,
      storeRoot,
      prNumber: 1591,
      headSha: HEAD_A,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: REPO,
    }).run;
    const path = join(storeRoot, 'runs', `${legacy.id}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    raw.automaticBudgetDisposition = 'non_consuming_explicit';
    writeFileSync(path, `${JSON.stringify(raw)}\n`, 'utf8');
    expect(getPackReviewRun(legacy.id, { projectId: PROJECT, storeRoot })?.automaticBudgetDisposition)
      .toBe('non_consuming_explicit');

    expect(() => createPackReviewRun({
      projectId: PROJECT,
      storeRoot,
      prNumber: 1592,
      headSha: HEAD_B,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: REPO,
      automaticBudgetDisposition: 'non_consuming_explicit',
    })).toThrow(/legacy-read-only|cannot be produced/);
  });
});

type PublishedSource = { identity: PackGptSourceIdentity; payload: string };

function sourceComment(publication: PublishedSource, id: number): PackGptSourceGithubComment {
  const timestamp = '2026-08-24T00:00:00.000Z';
  const body = formatPackGptSourceCommentEnvelope(publication.identity, publication.payload);
  const pr = publication.identity.prNumber;
  return {
    id, body, actorLogin: 'browser-gpt-bot', createdAt: timestamp, updatedAt: timestamp,
    url: `https://github.com/${REPO}/pull/${pr}#issuecomment-${id}`,
    issueUrl: `https://api.github.com/repos/${REPO}/issues/${pr}`,
  };
}

function sourceTransport(publications: Map<string, PublishedSource>): PackGptSourceCommentTransport {
  const census = () => [...publications.values()].map((publication, index) => sourceComment(publication, 8000 + index));
  return {
    resolveActorLogin: async () => 'browser-gpt-bot',
    listComments: async () => census(),
    getComment: async (id) => {
      const comment = census().find((candidate) => candidate.id === id);
      if (!comment) throw new Error(`fixture source comment ${String(id)} missing`);
      return comment;
    },
  };
}

function finalReviewTransport(capture: { body: string; posts: number }): GithubReviewTransport {
  const reviews: GithubReviewSummary[] = [];
  return {
    resolveActorLogin: async () => 'pack-runner-bot',
    listReviews: async () => [...reviews],
    postReview: async ({ body, commitId }) => {
      capture.body = body;
      capture.posts += 1;
      const id = 9000 + capture.posts;
      const url = `https://github.com/${REPO}/pull/1591#pullrequestreview-${id}`;
      const review: GithubReviewSummary = {
        id, body, commitId, url,
        state: 'COMMENTED', userLogin: 'pack-runner-bot', submittedAt: new Date().toISOString(),
      };
      reviews.push(review);
      return { id, url };
    },
    dismissReview: async () => {},
  };
}

function threeSourceRound(startedAt: string): PackReviewGptRoundRecord {
  return {
    schema: 'pack-review-gpt-round/v1',
    reviewer: 'gpt',
    tier: 'T1',
    roundOrdinal: 1,
    cardinality: 3,
    issueNumber: 1591,
    boundIssueSnapshotDigest: computeBoundIssueSnapshotHash(issueBody()),
    sourceSlots: [1, 2, 3].map((ordinal) => ({
      slotId: `source-${String(ordinal).padStart(2, '0')}`,
      ordinal,
      lifecycle: ordinal === 3 ? 'planned' as const : 'invocation_started' as const,
      ...(ordinal === 3 ? {} : {
        invocationId: `11111111-1111-4111-8111-${String(ordinal).padStart(12, '0')}`,
        attemptOrdinal: 1,
        admissionStartedAtUtc: startedAt,
      }),
    })),
  };
}

function recoverableRun(storeRoot: string, startedAt: Date): {
  runId: string;
  publications: Map<string, PublishedSource>;
} {
  initializePackReviewAuthority({
    prNumber: 1591,
    headSha: HEAD_A,
    tier: 'T1',
    options: { storeRoot, now: startedAt },
  });
  const round = threeSourceRound(startedAt.toISOString());
  const created = createPackReviewRun({
    projectId: PROJECT,
    storeRoot,
    now: startedAt,
    prNumber: 1591,
    headSha: HEAD_A,
    linkedSessionId: 'worker-1591',
    trustedPackRoot: repoRoot,
    sourceRepoRoot: repoRoot,
    canonicalRepository: REPO,
    reviewRound: {
      ...round,
      sourceSlots: round.sourceSlots.map((slot) => ({ slotId: slot.slotId, ordinal: slot.ordinal, lifecycle: 'planned' })),
    },
  });
  updatePackReviewRun(created.run.id, {
    status: 'running',
    latestRunStatus: 'running',
    runnerPid: 2147483647,
    reviewRound: round,
  }, { projectId: PROJECT, storeRoot, now: startedAt });
  const publications = new Map<string, PublishedSource>();
  for (const slot of round.sourceSlots.slice(0, 2)) {
    publications.set(slot.slotId, {
      identity: {
        repository: REPO,
        prNumber: 1591,
        headSha: HEAD_A,
        runId: created.run.id,
        slotId: slot.slotId,
        invocationId: slot.invocationId!,
      },
      payload: 'NO_FINDINGS',
    });
  }
  return { runId: created.run.id, publications };
}

function reconcileInput(
  storeRoot: string,
  publications: Map<string, PublishedSource>,
  capture: { body: string; posts: number },
  headSha = HEAD_A,
) {
  return {
    repoSlug: REPO,
    sourceRepoRoot: repoRoot,
    projectId: PROJECT,
    storeRoot,
    prNumber: 1591,
    fixtureCurrentPrHeadSha: headSha,
    fixtureGptSourceCommentTransport: sourceTransport(publications),
    fixtureGithubReviewTransport: finalReviewTransport(capture),
    fixtureRequiredStatusWriter: async () => {},
    fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    fixtureIssueBody: issueBody(),
    fixtureIssueNumber: 1591,
    fixtureChangedPaths: ['scripts/pack-review-runner.ts'],
    fixtureBoundIssueSnapshotBytes: issueBody(),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Issue #1591 GitHub-first 3/3-or-timed-2/3 recovery', () => {
  it('hydrates 2/3 immediately but does not settle before the shared grace threshold', async () => {
    const storeRoot = tempRoot();
    harness(storeRoot);
    const { runId, publications } = recoverableRun(storeRoot, new Date());
    const capture = { body: '', posts: 0 };

    const result = await reconcileStalePackReviewRuns({
      ...reconcileInput(storeRoot, publications, capture),
      immediate: true,
    });
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId,
        terminalized: false,
        usableSourceCount: 2,
        graceExpired: false,
        reason: 'gpt_sources_waiting_for_grace:2/3',
      }),
    ]));
    const run = getPackReviewRun(runId, { projectId: PROJECT, storeRoot });
    expect(run?.status).toBe('running');
    expect(run?.reviewRound?.settledSourceCount).toBeUndefined();
    expect(capture.posts).toBe(0);
  });

  it('settles stale 2/3 degraded, publishes the marker, and commits one cap unit', async () => {
    const storeRoot = tempRoot();
    harness(storeRoot);
    const startedAt = new Date(Date.now() - 3 * 60_000);
    const { runId, publications } = recoverableRun(storeRoot, startedAt);
    const capture = { body: '', posts: 0 };

    const result = await reconcileStalePackReviewRuns(reconcileInput(storeRoot, publications, capture));
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId,
        recovered: true,
        degraded: true,
        settledSourceCount: 2,
      }),
    ]));
    const run = getPackReviewRun(runId, { projectId: PROJECT, storeRoot });
    expect(run?.reviewRound?.settledSourceCount).toBe(2);
    expect(run?.reviewVerdict).toBe('clean');
    expect(capture.posts).toBe(1);
    expect(capture.body).toContain('Sources: 2/3 (degraded after timeout)');
    const authority = readPackReviewAuthority(1591, { storeRoot });
    expect(authority?.cycle?.consumedHeadShas).toEqual([HEAD_A]);
    expect(authority?.smokeOrdering?.reviewSettledHeadSha).toBe(HEAD_A);
    expect(authority?.publication?.status).toBe('succeeded');
  });

  it('keeps a late third source audit-only after degraded settlement', async () => {
    const storeRoot = tempRoot();
    harness(storeRoot);
    const startedAt = new Date(Date.now() - 3 * 60_000);
    const { runId, publications } = recoverableRun(storeRoot, startedAt);
    const capture = { body: '', posts: 0 };
    await reconcileStalePackReviewRuns(reconcileInput(storeRoot, publications, capture));
    const settled = getPackReviewRun(runId, { projectId: PROJECT, storeRoot })!;
    const third = settled.reviewRound!.sourceSlots[2]!;
    expect(third.lifecycle).toBe('planned');

    publications.set(third.slotId, {
      identity: {
        repository: REPO,
        prNumber: 1591,
        headSha: HEAD_A,
        runId,
        slotId: third.slotId,
        invocationId: '33333333-3333-4333-8333-000000000003',
      },
      payload: 'NO_FINDINGS',
    });
    await reconcileStalePackReviewRuns({
      ...reconcileInput(storeRoot, publications, capture),
      immediate: true,
    });

    const after = getPackReviewRun(runId, { projectId: PROJECT, storeRoot });
    expect(after?.reviewRound?.settledSourceCount).toBe(2);
    expect(after?.reviewRound?.sourceSlots[2]?.lifecycle).toBe('planned');
    expect(capture.posts).toBe(1);
    expect(readPackReviewAuthority(1591, { storeRoot })?.cycle?.consumedHeadShas).toEqual([HEAD_A]);
  });

  it('keeps an in-flight third invocation audit-only when reconcile freezes 2/3', async () => {
    const storeRoot = tempRoot();
    harness(storeRoot);
    process.env.PACK_REVIEWER = 'gpt';
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/g-p-fixture/project';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));

    const publications = new Map<string, PublishedSource>();
    const capture = { body: '', posts: 0 };
    const thirdAtCensus = deferred();
    const releaseThird = deferred();
    const firstTwoTerminal = deferred();
    const terminalSlots = new Set<string>();
    const transport = sourceTransport(publications);

    const startPromise = startPackReview({
      projectId: PROJECT,
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1591,
      headSha: HEAD_A,
      fixtureCurrentPrHeadSha: HEAD_A,
      fixturePrState: 'OPEN',
      fixturePrBody: 'Closes #1591',
      fixturePostReviewHeadSha: HEAD_A,
      fixturePostReviewPrBody: 'Closes #1591',
      fixtureRepoSlug: REPO,
      fixtureIssueBody: issueBody(),
      fixtureIssueNumber: 1591,
      fixtureReviewStdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
      fixtureGptSourceCommentTransport: transport,
      fixtureBeforeGptSourceCommentCensus: async ({ slotId, identity }) => {
        if (slotId === 'source-03') {
          thirdAtCensus.resolve();
          await releaseThird.promise;
        }
        publications.set(slotId, { identity, payload: 'NO_FINDINGS' });
      },
      fixtureAfterGptSourceSlotTerminal: async ({ slotId }) => {
        if (slotId === 'source-01' || slotId === 'source-02') terminalSlots.add(slotId);
        if (terminalSlots.size === 2) firstTwoTerminal.resolve();
      },
      fixtureGithubReviewTransport: finalReviewTransport(capture),
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
      fixtureChangedPaths: ['scripts/pack-review-runner.ts'],
      fixtureBoundIssueSnapshotBytes: issueBody(),
      claimMode: 'preacquired',
    });

    await Promise.all([thirdAtCensus.promise, firstTwoTerminal.promise]);
    vi.setSystemTime(new Date('2026-08-24T00:03:00.000Z'));
    const reconciliation = await reconcileStalePackReviewRuns({
      ...reconcileInput(storeRoot, publications, capture),
      fixtureGptSourceCommentTransport: transport,
      immediate: true,
    });
    expect(reconciliation.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recovered: true,
        degraded: true,
        settledSourceCount: 2,
      }),
    ]));

    releaseThird.resolve();
    const started = await startPromise;
    expect(started).toMatchObject({ ok: true, recovered: true });
    expect(String(started.reason)).toMatch(/concurrent_reconcile_(settled|owns_delivery)/);

    const after = listPackReviewRuns({ projectId: PROJECT, storeRoot })[0]!;
    expect(after.reviewRound?.settledSourceCount).toBe(2);
    expect(after.reviewRound?.sourceSlots[2]?.lifecycle).toBe('invocation_started');
    expect(after.reviewRound?.sourceSlots.filter((slot) => (
      slot.lifecycle === 'terminal'
      && (slot.terminalClass === 'complete_clean' || slot.terminalClass === 'complete_findings')
    ))).toHaveLength(2);
    expect(capture.posts).toBe(1);
    expect(readPackReviewAuthority(1591, { storeRoot })?.cycle?.consumedHeadShas).toEqual([HEAD_A]);
  });

  it('settles 3/3 when source 03 persists before the degraded freeze commits', async () => {
    const storeRoot = tempRoot();
    harness(storeRoot);
    process.env.PACK_REVIEWER = 'gpt';
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/g-p-fixture/project';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));

    const publications = new Map<string, PublishedSource>();
    const capture = { body: '', posts: 0 };
    const thirdAtCensus = deferred();
    const releaseThird = deferred();
    const firstTwoTerminal = deferred();
    const thirdTerminal = deferred();
    const freezeObserved = deferred();
    const releaseFreeze = deferred();
    const releaseStarterAggregate = deferred();
    const terminalSlots = new Set<string>();
    const transport = sourceTransport(publications);

    const startPromise = startPackReview({
      projectId: PROJECT,
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1591,
      headSha: HEAD_A,
      fixtureCurrentPrHeadSha: HEAD_A,
      fixturePrState: 'OPEN',
      fixturePrBody: 'Closes #1591',
      fixturePostReviewHeadSha: HEAD_A,
      fixturePostReviewPrBody: 'Closes #1591',
      fixtureRepoSlug: REPO,
      fixtureIssueBody: issueBody(),
      fixtureIssueNumber: 1591,
      fixtureReviewStdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
      fixtureGptSourceCommentTransport: transport,
      fixtureBeforeGptSourceCommentCensus: async ({ slotId, identity }) => {
        if (slotId === 'source-03') {
          thirdAtCensus.resolve();
          await releaseThird.promise;
        }
        publications.set(slotId, { identity, payload: 'NO_FINDINGS' });
      },
      fixtureAfterGptSourceSlotTerminal: async ({ slotId }) => {
        if (slotId === 'source-01' || slotId === 'source-02') terminalSlots.add(slotId);
        if (terminalSlots.size === 2) firstTwoTerminal.resolve();
        if (slotId === 'source-03') thirdTerminal.resolve();
      },
      fixtureBeforeGptAggregateSettlement: async () => {
        await releaseStarterAggregate.promise;
      },
      fixtureGithubReviewTransport: finalReviewTransport(capture),
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
      fixtureChangedPaths: ['scripts/pack-review-runner.ts'],
      fixtureBoundIssueSnapshotBytes: issueBody(),
      claimMode: 'preacquired',
    });

    await Promise.all([thirdAtCensus.promise, firstTwoTerminal.promise]);
    vi.setSystemTime(new Date('2026-08-24T00:03:00.000Z'));
    const reconcilePromise = reconcileStalePackReviewRuns({
      ...reconcileInput(storeRoot, publications, capture),
      fixtureGptSourceCommentTransport: transport,
      fixtureBeforeGptRoundFreeze: async ({ usableSourceCount }) => {
        expect(usableSourceCount).toBe(2);
        freezeObserved.resolve();
        await releaseFreeze.promise;
      },
      immediate: true,
    });

    await freezeObserved.promise;
    releaseThird.resolve();
    await thirdTerminal.promise;
    releaseFreeze.resolve();
    const reconciliation = await reconcilePromise;
    releaseStarterAggregate.resolve();
    const started = await startPromise;

    expect(reconciliation.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recovered: true,
        degraded: false,
        settledSourceCount: 3,
      }),
    ]));
    expect(started).toMatchObject({ ok: true, recovered: true });
    const after = listPackReviewRuns({ projectId: PROJECT, storeRoot })[0]!;
    expect(after.reviewRound?.settledSourceCount).toBe(3);
    expect(after.reviewRound?.sourceSlots.filter((slot) => (
      slot.lifecycle === 'terminal'
      && (slot.terminalClass === 'complete_clean' || slot.terminalClass === 'complete_findings')
    ))).toHaveLength(3);
    expect(capture.posts).toBe(1);
    expect(capture.body).not.toContain('degraded after timeout');
    expect(readPackReviewAuthority(1591, { storeRoot })?.cycle?.consumedHeadShas).toEqual([HEAD_A]);
  });

  it('recovers a frozen 2/3 quorum after a crash before aggregate persistence', async () => {
    const storeRoot = tempRoot();
    harness(storeRoot);
    const startedAt = new Date(Date.now() - 3 * 60_000);
    const { runId, publications } = recoverableRun(storeRoot, startedAt);
    const capture = { body: '', posts: 0 };

    await expect(reconcileStalePackReviewRuns({
      ...reconcileInput(storeRoot, publications, capture),
      fixtureAfterGptRoundFreeze: async ({ settledSourceCount }) => {
        expect(settledSourceCount).toBe(2);
        throw new Error('fixture_crash_after_gpt_round_freeze');
      },
    })).rejects.toThrow(/fixture_crash_after_gpt_round_freeze/);

    const frozen = getPackReviewRun(runId, { projectId: PROJECT, storeRoot });
    expect(frozen?.reviewRound?.settledSourceCount).toBe(2);
    expect(frozen?.reviewVerdict).toBeUndefined();
    expect(capture.posts).toBe(0);

    const resumed = await reconcileStalePackReviewRuns(reconcileInput(storeRoot, publications, capture));
    expect(resumed.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId,
        recovered: true,
        degraded: true,
        settledSourceCount: 2,
      }),
    ]));
    const after = getPackReviewRun(runId, { projectId: PROJECT, storeRoot });
    expect(after?.reviewVerdict).toBe('clean');
    expect(after?.reviewRound?.settledSourceCount).toBe(2);
    expect(capture.posts).toBe(1);
  });

  it('leaves <2/3 stale recovery incomplete with a concrete next action', async () => {
    const storeRoot = tempRoot();
    harness(storeRoot);
    const startedAt = new Date(Date.now() - 3 * 60_000);
    const { runId, publications } = recoverableRun(storeRoot, startedAt);
    publications.delete('source-02');
    const capture = { body: '', posts: 0 };

    const result = await reconcileStalePackReviewRuns(reconcileInput(storeRoot, publications, capture));
    expect(result.results.some((row) => row.runId === runId && typeof row.nextAction === 'string')).toBe(true);
    const run = getPackReviewRun(runId, { projectId: PROJECT, storeRoot });
    expect(run?.reviewVerdict).toBeUndefined();
    expect(capture.posts).toBe(0);
  });
});

interface SeedFinding {
  title?: string;
  severity?: string;
  filePath?: string;
}

function seedFinalCapContinuation(
  storeRoot: string,
  smoke: 'passed' | 'failed' = 'passed',
  findingPath: string | null = 'scripts/pack-review-runner.ts',
  extraFindings: SeedFinding[] = [],
) {
  const opts = { storeRoot, now: new Date('2026-08-24T00:00:00.000Z') };
  const findings: SeedFinding[] = [
    {
      title: 'blocking',
      severity: 'blocking',
      ...(findingPath ? { filePath: findingPath } : {}),
    },
    ...extraFindings,
  ];
  const run = createPackReviewRun({
    projectId: PROJECT,
    storeRoot,
    prNumber: 1591,
    headSha: HEAD_A,
    trustedPackRoot: repoRoot,
    sourceRepoRoot: repoRoot,
    canonicalRepository: REPO,
  }).run;
  setPackReviewRunTerminal(run.id, 'changes_requested', {
    reviewVerdict: 'findings',
    findingCount: findings.length,
    findings,
  }, { projectId: PROJECT, storeRoot });

  let authority = initializePackReviewAuthority({
    prNumber: 1591,
    headSha: HEAD_A,
    tier: 'T1',
    options: opts,
  });
  authority = commitPackReviewTerminal({
    prNumber: 1591,
    expectedTransitionSeq: authority.transitionSeq,
    terminal: {
      schemaVersion: 1,
      terminalContractVersion: 2,
      terminalSource: 'normal',
      runId: run.id,
      targetSha: HEAD_A,
      reviewVerdict: 'findings',
      findingCount: findings.length,
      findingsDigest: 'blocking-a',
    },
    status: 'changes_requested',
    findingCount: findings.length,
    options: opts,
  });
  authority = observePackReviewHead({
    prNumber: 1591,
    expectedTransitionSeq: authority.transitionSeq,
    headSha: HEAD_B,
    options: opts,
  });
  authority = commitSmokeOrderingTransition({
    prNumber: 1591,
    expectedTransitionSeq: authority.transitionSeq,
    actor: 'worker-owned',
    headSha: HEAD_B,
    status: 'started',
    options: opts,
  });
  authority = commitSmokeOrderingTransition({
    prNumber: 1591,
    expectedTransitionSeq: authority.transitionSeq,
    actor: 'worker-owned',
    headSha: HEAD_B,
    status: smoke,
    ...(smoke === 'failed' ? { failureKind: 'finding' as const } : {}),
    options: opts,
  });
  return { authority, opts, run };
}

function selectNoIntersectionEvidence(
  storeRoot: string,
  authority: NonNullable<ReturnType<typeof readPackReviewAuthority>>,
  resolution: {
    findingCount?: number;
    blockingFindingCount?: number;
    unresolvedBlockingFindingCount?: number;
  } = {},
) {
  const expectedEvidenceKey = 'final-fix-current-head';
  const evidenceId = `mte-${expectedEvidenceKey}`;
  const findingCount = resolution.findingCount ?? 1;
  const blockingFindingCount = resolution.blockingFindingCount ?? 1;
  const unresolvedBlockingFindingCount = resolution.unresolvedBlockingFindingCount ?? 0;
  const staged = stagePackReviewImmutableRecord({
    kind: 'evidence',
    key: evidenceId,
    value: {
      schema: 'merge-triage-evidence/v1',
      evidenceId,
      expectedEvidenceKey,
      pathId: 'scope-denylist-current-head/v1',
      producer: 'scripts/merge-triage-evidence.ts',
      tuple: {
        prNumber: 1591,
        cycleId: authority.cycle!.cycleId,
        currentHeadSha: authority.currentHeadSha,
      },
      changedPaths: ['scripts/pack-review-runner.ts'],
      denylistPatterns: [],
      matchedPaths: [],
      predicateResult: 'no_intersection',
      findingResolution: {
        findingSnapshotDigest: FINAL_FIX_DIGEST,
        priorReviewedHeadSha: HEAD_A,
        currentHeadSha: authority.currentHeadSha,
        findingCount,
        blockingFindingCount,
        nonBlockingFindingCount: findingCount - blockingFindingCount,
        unresolvedBlockingFindingCount,
        resolutionBasis: 'explicit_current_head_finding_selection',
        predicateResult: unresolvedBlockingFindingCount === 0 ? 'resolved' : 'unresolved',
      },
      producedAtUtc: '2026-08-24T00:00:00.000Z',
    },
    options: { storeRoot },
  });
  return selectPackReviewEvidence({
    prNumber: 1591,
    expectedTransitionSeq: authority.transitionSeq,
    expectedEvidenceKey,
    selectedEvidenceId: evidenceId,
    selectedEvidenceDigest: staged.digest,
    options: { storeRoot },
  });
}

describe('Issue #1591 exact-head final-cap settlement', () => {
  it('does not infer semantic resolution merely because the blocking file was touched', async () => {
    const storeRoot = tempRoot();
    harness(storeRoot);
    const seeded = seedFinalCapContinuation(storeRoot);
    expect(seeded.authority.cycle?.state).toBe('at_cap_continuation_required');
    const runCount = listPackReviewRuns({ projectId: PROJECT, storeRoot }).length;

    const result = await reconcileStalePackReviewRuns({
      repoSlug: REPO,
      sourceRepoRoot: repoRoot,
      projectId: PROJECT,
      storeRoot,
      prNumber: 1591,
      immediate: true,
      fixtureCurrentPrHeadSha: HEAD_B,
      fixtureRequiredStatusWriter: async () => {},
      fixtureIssueBody: issueBody(),
      fixtureIssueNumber: 1591,
      fixtureChangedPaths: ['scripts/pack-review-runner.ts'],
      fixtureBoundIssueSnapshotBytes: issueBody(),
    });

    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        finalCapSettlement: true,
        settled: false,
        headSha: HEAD_B,
        reason: 'final_cap_settlement_incomplete',
        nextAction: 'complete the current-head finding-resolution evidence, then rerun scoped reconcile',
      }),
    ]));
    expect(listPackReviewRuns({ projectId: PROJECT, storeRoot })).toHaveLength(runCount);
    const authority = readPackReviewAuthority(1591, { storeRoot });
    expect(authority?.triage?.verdict).toBe('PENDING_ARCHITECT');
    expect(authority?.smokeOrdering?.reviewSettledHeadSha).not.toBe(HEAD_B);
    expect(authority?.cycle?.reviewStageComplete).not.toBe(true);
  });

  it('does not settle when worker smoke failed', async () => {
    const storeRoot = tempRoot();
    harness(storeRoot);
    seedFinalCapContinuation(storeRoot, 'failed');

    const result = await reconcileStalePackReviewRuns({
      repoSlug: REPO,
      sourceRepoRoot: repoRoot,
      projectId: PROJECT,
      storeRoot,
      prNumber: 1591,
      immediate: true,
      fixtureCurrentPrHeadSha: HEAD_B,
      fixtureRequiredStatusWriter: async () => {},
      fixtureIssueBody: issueBody(),
      fixtureIssueNumber: 1591,
    });
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        finalCapSettlement: true,
        settled: false,
        reason: 'final_cap_settlement_worker_smoke_required',
      }),
    ]));
  });

  it('keeps a valid pathless blocker incomplete until semantic resolution evidence exists', async () => {
    const storeRoot = tempRoot();
    harness(storeRoot);
    seedFinalCapContinuation(storeRoot, 'passed', null);

    const result = await reconcileStalePackReviewRuns({
      repoSlug: REPO,
      sourceRepoRoot: repoRoot,
      projectId: PROJECT,
      storeRoot,
      prNumber: 1591,
      immediate: true,
      fixtureCurrentPrHeadSha: HEAD_B,
      fixtureRequiredStatusWriter: async () => {},
      fixtureIssueBody: issueBody(),
      fixtureIssueNumber: 1591,
      fixtureChangedPaths: ['scripts/pack-review-runner.ts'],
      fixtureBoundIssueSnapshotBytes: issueBody(),
    });

    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        finalCapSettlement: true,
        settled: false,
        headSha: HEAD_B,
        reason: 'final_cap_settlement_incomplete',
      }),
    ]));
    const authority = readPackReviewAuthority(1591, { storeRoot });
    expect(authority?.triage?.verdict).toBe('PENDING_ARCHITECT');
    expect(authority?.smokeOrdering?.reviewSettledHeadSha).not.toBe(HEAD_B);
    expect(authority?.cycle?.reviewStageComplete).not.toBe(true);
  });

  it('binds explicit automatic final settlement to the exact head and does not cover a later commit', () => {
    const storeRoot = tempRoot();
    const seeded = seedFinalCapContinuation(storeRoot);
    let authority = selectNoIntersectionEvidence(storeRoot, seeded.authority);
    authority = commitPackReviewTriage({
      prNumber: 1591,
      expectedTransitionSeq: authority.transitionSeq,
      triage: {
        verdict: 'DEFER',
        source: 'automatic',
        findingSnapshotDigest: FINAL_FIX_DIGEST,
        committedAtUtc: '2026-08-24T00:01:00.000Z',
      },
      options: seeded.opts,
    });
    expect(authority.smokeOrdering?.reviewSettledHeadSha).toBe(HEAD_B);

    authority = observePackReviewHead({
      prNumber: 1591,
      expectedTransitionSeq: authority.transitionSeq,
      headSha: HEAD_C,
      options: seeded.opts,
    });
    expect(authority.currentHeadSha).toBe(HEAD_C);
    expect(authority.cycle?.state).toBe('at_cap_continuation_required');
    expect(authority.smokeOrdering?.reviewSettledHeadSha).not.toBe(HEAD_C);
  });

  it('accepts explicit current-head resolution for a pathless blocking finding', () => {
    const storeRoot = tempRoot();
    const seeded = seedFinalCapContinuation(storeRoot, 'passed', null);
    let authority = selectNoIntersectionEvidence(storeRoot, seeded.authority, {
      findingCount: 1,
      blockingFindingCount: 1,
      unresolvedBlockingFindingCount: 0,
    });
    authority = commitPackReviewTriage({
      prNumber: 1591,
      expectedTransitionSeq: authority.transitionSeq,
      triage: {
        verdict: 'DEFER',
        source: 'automatic',
        findingSnapshotDigest: FINAL_FIX_DIGEST,
        committedAtUtc: '2026-08-24T00:01:00.000Z',
      },
      options: seeded.opts,
    });
    expect(authority.smokeOrdering?.reviewSettledHeadSha).toBe(HEAD_B);
    expect(authority.cycle?.reviewStageComplete).toBe(true);
  });

  it('does not make an untouched warning part of the blocking settlement obligation', () => {
    const storeRoot = tempRoot();
    const seeded = seedFinalCapContinuation(
      storeRoot,
      'passed',
      'scripts/pack-review-runner.ts',
      [{ title: 'informational note', severity: 'warning', filePath: 'docs/orchestration-runbook.md' }],
    );
    let authority = selectNoIntersectionEvidence(storeRoot, seeded.authority, {
      findingCount: 2,
      blockingFindingCount: 1,
      unresolvedBlockingFindingCount: 0,
    });
    authority = commitPackReviewTriage({
      prNumber: 1591,
      expectedTransitionSeq: authority.transitionSeq,
      triage: {
        verdict: 'DEFER',
        source: 'automatic',
        findingSnapshotDigest: FINAL_FIX_DIGEST,
        committedAtUtc: '2026-08-24T00:01:00.000Z',
      },
      options: seeded.opts,
    });
    expect(authority.smokeOrdering?.reviewSettledHeadSha).toBe(HEAD_B);
    expect(authority.cycle?.reviewStageComplete).toBe(true);
  });

  it('rejects automatic DEFER when exact-head worker smoke failed', () => {
    const storeRoot = tempRoot();
    const seeded = seedFinalCapContinuation(storeRoot, 'failed');
    const authority = selectNoIntersectionEvidence(storeRoot, seeded.authority);
    expect(() => commitPackReviewTriage({
      prNumber: 1591,
      expectedTransitionSeq: authority.transitionSeq,
      triage: {
        verdict: 'DEFER',
        source: 'automatic',
        findingSnapshotDigest: FINAL_FIX_DIGEST,
        committedAtUtc: '2026-08-24T00:01:00.000Z',
      },
      options: seeded.opts,
    })).toThrow(/automatic DEFER requires final-cap continuation.*exact finding-resolution evidence/);
  });

  it('rejects automatic DEFER when explicit resolution still reports a blocking finding', () => {
    const storeRoot = tempRoot();
    const seeded = seedFinalCapContinuation(storeRoot);
    const authority = selectNoIntersectionEvidence(storeRoot, seeded.authority, {
      findingCount: 1,
      blockingFindingCount: 1,
      unresolvedBlockingFindingCount: 1,
    });
    expect(() => commitPackReviewTriage({
      prNumber: 1591,
      expectedTransitionSeq: authority.transitionSeq,
      triage: {
        verdict: 'DEFER',
        source: 'automatic',
        findingSnapshotDigest: FINAL_FIX_DIGEST,
        committedAtUtc: '2026-08-24T00:01:00.000Z',
      },
      options: seeded.opts,
    })).toThrow(/exact finding-resolution evidence/);
  });

  it('rejects automatic DEFER when the evidence is not bound to the finding snapshot', () => {
    const storeRoot = tempRoot();
    const seeded = seedFinalCapContinuation(storeRoot);
    const authority = selectNoIntersectionEvidence(storeRoot, seeded.authority);
    expect(() => commitPackReviewTriage({
      prNumber: 1591,
      expectedTransitionSeq: authority.transitionSeq,
      triage: {
        verdict: 'DEFER',
        source: 'automatic',
        findingSnapshotDigest: 'e'.repeat(64),
        committedAtUtc: '2026-08-24T00:01:00.000Z',
      },
      options: seeded.opts,
    })).toThrow(/exact finding-resolution evidence/);
  });
});

it('keeps the focused fixture self-contained', () => {
  expect(existsSync(repoRoot)).toBe(true);
});
