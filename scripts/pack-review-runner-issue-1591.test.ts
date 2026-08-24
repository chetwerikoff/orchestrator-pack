// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

const REPO = 'chetwerikoff/orchestrator-pack';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);
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
    'packages/core/**',
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

afterEach(() => {
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

function directOperatorStart(storeRoot: string): ReturnType<typeof runProcessSync> {
  return runProcessSync({
    command: process.execPath,
    args: [
      '--experimental-strip-types',
      join(repoRoot, 'scripts', 'pack-review-runner.ts'),
      'start',
      '--pr-number', '1591',
      '--head-sha', HEAD_A,
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
    },
    input: JSON.stringify({
      projectId: PROJECT,
      storeRoot,
      sourceRepoRoot: repoRoot,
      fixtureCurrentPrHeadSha: HEAD_A,
      fixturePrState: 'OPEN',
      fixturePrBody: 'Closes #1591',
      fixturePostReviewHeadSha: HEAD_A,
      fixturePostReviewPrBody: 'Closes #1591',
      fixtureRepoSlug: REPO,
      fixtureIssueBody: issueBody(),
      fixtureIssueNumber: 1591,
      fixtureReviewStdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
      fixtureGithubReviewId: 1592,
      fixtureRequiredStatusWriter: async () => {},
    }),
  });
}

describe('Issue #1591 launcher-independent consuming semantics', () => {
  it('reuses a completed same-head review instead of creating an explicit-extra run', async () => {
    const storeRoot = tempRoot();
    harness(storeRoot);
    const first = await normalStart(storeRoot);
    expect(first.ok).toBe(true);
    expect(listPackReviewRuns({ projectId: PROJECT, storeRoot })).toHaveLength(1);

    const manual = directOperatorStart(storeRoot);
    const result = JSON.parse(manual.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)!) as Record<string, unknown>;
    expect(result.created).toBe(false);
    expect(result.reused).toBe(true);
    expect(String(result.reason)).toMatch(/terminal_run_exists|claimed/);
    const runs = listPackReviewRuns({ projectId: PROJECT, storeRoot });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.automaticBudgetDisposition).toBe('consume');
  });

  it('does not let a manual/chat launch bypass final-cap admission', async () => {
    const storeRoot = tempRoot();
    harness(storeRoot);
    const first = await normalStart(storeRoot, {
      fixtureReviewStdout: JSON.stringify({
        verdict: 'findings',
        findingCount: 1,
        findings: [{ title: 'blocking', severity: 'blocking' }],
      }),
      fixtureChangedPaths: ['scripts/pack-review-runner.ts'],
      fixtureBoundIssueSnapshotBytes: issueBody(),
    });
    expect(first.ok).toBe(true);
    expect(readPackReviewAuthority(1591, { storeRoot })?.cycle?.state).toBe('at_cap_open_findings');

    const manual = directOperatorStart(storeRoot);
    const result = JSON.parse(manual.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)!) as Record<string, unknown>;
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
    })).toThrow(/new runs must consume normal review budget/);
  });
});

type PublishedSource = { identity: PackGptSourceIdentity; payload: string };

function sourceComment(publication: PublishedSource, id: number): PackGptSourceGithubComment {
  const timestamp = '2026-08-24T00:00:00.000Z';
  return {
    id,
    body: formatPackGptSourceCommentEnvelope(publication.identity, publication.payload),
    url: `https://github.com/${REPO}/pull/${publication.identity.prNumber}#issuecomment-${id}`,
    issueUrl: `https://api.github.com/repos/${REPO}/issues/${publication.identity.prNumber}`,
    actorLogin: 'browser-gpt-bot',
    createdAt: timestamp,
    updatedAt: timestamp,
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
      reviews.push({
        id,
        state: 'COMMENTED',
        userLogin: 'pack-runner-bot',
        submittedAt: new Date().toISOString(),
        body,
        commitId,
        url,
      });
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
    boundIssueSnapshotDigest: 'fixture-1591',
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

function reconcileInput(storeRoot: string, publications: Map<string, PublishedSource>, capture: { body: string; posts: number }) {
  return {
    repoSlug: REPO,
    sourceRepoRoot: repoRoot,
    projectId: PROJECT,
    storeRoot,
    prNumber: 1591,
    fixtureCurrentPrHeadSha: HEAD_A,
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

  it('settles a stale 2/3 round degraded, publishes the marker, and consumes one cap unit', async () => {
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

describe('Issue #1591 exact-head final-cap settlement', () => {
  function seedContinuation(storeRoot: string) {
    const opts = { storeRoot, now: new Date('2026-08-24T00:00:00.000Z') };
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
        runId: 'final-review-a',
        targetSha: HEAD_A,
        reviewVerdict: 'findings',
        findingCount: 1,
        findingsDigest: 'blocking-a',
      },
      status: 'changes_requested',
      findingCount: 1,
      options: opts,
    });
    authority = observePackReviewHead({
      prNumber: 1591,
      expectedTransitionSeq: authority.transitionSeq,
      headSha: HEAD_B,
      options: opts,
    });
    return { authority, opts };
  }

  function selectNoIntersectionEvidence(storeRoot: string, authority: NonNullable<ReturnType<typeof readPackReviewAuthority>>) {
    const expectedEvidenceKey = 'final-fix-current-head';
    const evidenceId = `mte-${expectedEvidenceKey}`;
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
        denylistPatterns: ['packages/core/**'],
        matchedPaths: [],
        predicateResult: 'no_intersection',
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

  it('settles only after worker-owned PASS on the exact continuation head and does not cover a later head', () => {
    const storeRoot = tempRoot();
    const seeded = seedContinuation(storeRoot);
    let authority = seeded.authority;
    expect(authority.cycle?.state).toBe('at_cap_continuation_required');
    authority = commitSmokeOrderingTransition({
      prNumber: 1591,
      expectedTransitionSeq: authority.transitionSeq,
      actor: 'worker-owned',
      headSha: HEAD_B,
      status: 'started',
      options: seeded.opts,
    });
    authority = commitSmokeOrderingTransition({
      prNumber: 1591,
      expectedTransitionSeq: authority.transitionSeq,
      actor: 'worker-owned',
      headSha: HEAD_B,
      status: 'passed',
      options: seeded.opts,
    });
    authority = selectNoIntersectionEvidence(storeRoot, authority);
    authority = commitPackReviewTriage({
      prNumber: 1591,
      expectedTransitionSeq: authority.transitionSeq,
      triage: {
        verdict: 'DEFER',
        source: 'automatic',
        findingSnapshotDigest: 'final-fix',
        committedAtUtc: '2026-08-24T00:01:00.000Z',
      },
      options: seeded.opts,
    });
    expect(authority.smokeOrdering?.reviewSettledHeadSha).toBe(HEAD_B);
    expect(authority.cycle?.reviewStageComplete).toBe(true);

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

  it('rejects automatic final settlement when worker smoke failed', () => {
    const storeRoot = tempRoot();
    const seeded = seedContinuation(storeRoot);
    let authority = commitSmokeOrderingTransition({
      prNumber: 1591,
      expectedTransitionSeq: seeded.authority.transitionSeq,
      actor: 'worker-owned',
      headSha: HEAD_B,
      status: 'started',
      options: seeded.opts,
    });
    authority = commitSmokeOrderingTransition({
      prNumber: 1591,
      expectedTransitionSeq: authority.transitionSeq,
      actor: 'worker-owned',
      headSha: HEAD_B,
      status: 'failed',
      failureKind: 'finding',
      options: seeded.opts,
    });
    authority = selectNoIntersectionEvidence(storeRoot, authority);
    expect(() => commitPackReviewTriage({
      prNumber: 1591,
      expectedTransitionSeq: authority.transitionSeq,
      triage: {
        verdict: 'DEFER',
        source: 'automatic',
        findingSnapshotDigest: 'still-blocked',
        committedAtUtc: '2026-08-24T00:01:00.000Z',
      },
      options: seeded.opts,
    })).toThrow(/automatic DEFER requires final-cap continuation, exact-head worker smoke PASS, and canonical no-intersection evidence/);
  });
});
