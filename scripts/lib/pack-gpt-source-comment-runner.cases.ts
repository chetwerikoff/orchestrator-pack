import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isRetryablePackReviewZeroSendCollision,
  reconcileStalePackReviewRuns,
  startPackReview,
} from '../pack-review-runner.ts';
import {
  createPackReviewRun,
  getPackReviewRun,
  setPackReviewRunTerminal,
  updatePackReviewRun,
  type PackReviewGptRoundRecord,
} from './pack-review-run-store.ts';
import {
  formatPackGptSourceCommentEnvelope,
  type PackGptSourceIdentity,
} from './pack-gpt-source-comment-contract.ts';
import type {
  PackGptSourceCommentTransport,
  PackGptSourceGithubComment,
} from './pack-gpt-source-comment.ts';
import { buildGptReviewPrompt } from './pack-pr-review-contract.ts';
import type {
  GithubReviewSummary,
  GithubReviewTransport,
} from './github-review-reconciliation.ts';

const REPO = 'chetwerikoff/orchestrator-pack';
const HEAD = 'a'.repeat(40);
const ISSUE_BODY = [
  '```complexity-tier',
  'tier: T1',
  'advisory-prior: T1',
  '```',
].join('\n');
const originalEnv = { ...process.env };
const roots: string[] = [];

type PublishedSource = {
  identity: PackGptSourceIdentity;
  payload: string;
};

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-1435-source-runner-'));
  roots.push(root);
  return root;
}

function sentTerminal(invocationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'): string {
  return JSON.stringify({
    schema: 'turn-result/v1',
    state: 'ok',
    scope: 'none',
    cause: 'completed_page_only',
    invocation_id: invocationId,
    send_count: 1,
  });
}

function zeroSendTerminal(invocationId: string): string {
  return JSON.stringify({
    schema: 'turn-result/v1',
    state: 'profile_busy',
    scope: 'profile',
    cause: 'profile_busy',
    invocation_id: invocationId,
    send_count: 0,
  });
}

function findingSourcePayload(code = 'GPT-1435'): string {
  return JSON.stringify({
    findings: [{
      type: 'quality',
      code,
      severity: 'blocking',
      path: 'scripts/pack-review-runner.ts',
      summary: 'fixture blocking finding',
      source: 'gpt-browser',
    }],
  });
}

function sourceComment(publication: PublishedSource, id: number): PackGptSourceGithubComment {
  const timestamp = '2026-08-17T00:00:00Z';
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

function dynamicTransport(
  publications: Map<string, PublishedSource>,
  counters?: { listCalls: number },
): PackGptSourceCommentTransport {
  const census = (): PackGptSourceGithubComment[] => [...publications.values()].map((publication, index) => (
    sourceComment(publication, 5000 + index)
  ));
  return {
    resolveActorLogin: async () => 'browser-gpt-bot',
    listComments: async () => {
      if (counters) counters.listCalls += 1;
      return census();
    },
    getComment: async (id) => {
      const selected = census().find((row) => row.id === id);
      if (!selected) throw new Error(`fixture comment ${String(id)} missing`);
      return selected;
    },
  };
}

function finalReviewTransport(counters: { posts: number }): GithubReviewTransport {
  const reviews: GithubReviewSummary[] = [];
  return {
    resolveActorLogin: async () => 'pack-runner-bot',
    listReviews: async () => [...reviews],
    postReview: async ({ body, commitId }) => {
      counters.posts += 1;
      const id = 9000 + counters.posts;
      const url = `https://github.com/${REPO}/pull/1436#pullrequestreview-${id}`;
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

function baseStart(storeRoot: string, transport: PackGptSourceCommentTransport) {
  return {
    projectId: 'orchestrator-pack',
    storeRoot,
    sourceRepoRoot: process.cwd(),
    prNumber: 1436,
    headSha: HEAD,
    tier: 'T1' as const,
    fixtureIssueBody: ISSUE_BODY,
    fixtureIssueNumber: 1435,
    fixtureCurrentPrHeadSha: HEAD,
    fixturePostReviewHeadSha: HEAD,
    fixturePrState: 'OPEN',
    fixtureRepoSlug: REPO,
    claimMode: 'preacquired' as const,
    fixtureReviewBySourceSlot: {
      'source-01': [{ stdout: sentTerminal() }],
      'source-02': [{ stdout: sentTerminal() }],
      'source-03': [{ stdout: sentTerminal() }],
    },
    fixtureGptSourceCommentTransport: transport,
    fixtureGithubReviewId: 9001,
    fixtureRequiredStatusWriter: async () => {},
    fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
  };
}

function threeSlotRound(): PackReviewGptRoundRecord {
  return {
    schema: 'pack-review-gpt-round/v1',
    reviewer: 'gpt',
    tier: 'T1',
    roundOrdinal: 1,
    cardinality: 3,
    issueNumber: 1435,
    boundIssueSnapshotDigest: 'fixture-snapshot',
    sourceSlots: [1, 2, 3].map((ordinal) => ({
      slotId: `source-${String(ordinal).padStart(2, '0')}`,
      ordinal,
      lifecycle: 'planned' as const,
    })),
  };
}

function startedStaleRun(storeRoot: string): {
  runId: string;
  publications: Map<string, PublishedSource>;
} {
  const staleAt = new Date('2026-08-16T00:00:00Z');
  const created = createPackReviewRun({
    projectId: 'orchestrator-pack',
    storeRoot,
    now: staleAt,
    prNumber: 1436,
    headSha: HEAD,
    linkedSessionId: 'worker-fixture',
    trustedPackRoot: process.cwd(),
    sourceRepoRoot: process.cwd(),
    canonicalRepository: REPO,
    reviewRound: threeSlotRound(),
  });
  const publications = new Map<string, PublishedSource>();
  const startedRound: PackReviewGptRoundRecord = {
    ...created.run.reviewRound!,
    sourceSlots: created.run.reviewRound!.sourceSlots.map((slot, index) => {
      const invocationId = `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`;
      const identity = {
        repository: REPO,
        prNumber: 1436,
        headSha: HEAD,
        runId: created.run.id,
        slotId: slot.slotId,
        invocationId,
      };
      publications.set(slot.slotId, {
        identity,
        payload: index === 0 ? findingSourcePayload() : 'NO_FINDINGS',
      });
      return {
        ...slot,
        lifecycle: 'invocation_started' as const,
        invocationId,
        attemptOrdinal: 1,
        admissionStartedAtUtc: staleAt.toISOString(),
      };
    }),
  };
  updatePackReviewRun(created.run.id, {
    status: 'running',
    latestRunStatus: 'running',
    runnerPid: 2147483647,
    reviewRound: startedRound,
  }, { projectId: 'orchestrator-pack', storeRoot, now: staleAt });
  return { runId: created.run.id, publications };
}

function invocationLogCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim()).length;
}

function receiptBackedRound(runId: string): PackReviewGptRoundRecord {
  return {
    ...threeSlotRound(),
    sourceSlots: threeSlotRound().sourceSlots.map((slot, index) => {
      const invocationId = `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`;
      const timestamp = '2026-08-17T00:00:00Z';
      return {
        ...slot,
        lifecycle: 'terminal' as const,
        invocationId,
        attemptOrdinal: 1,
        admissionStartedAtUtc: timestamp,
        terminalClass: 'complete_clean',
        terminalResult: {
          schema: 'turn-result/v1',
          state: 'ok',
          scope: 'none',
          cause: 'github_source_comment_credentialed',
          invocation_id: invocationId,
          send_count: 1,
          source_comment_authority: 'credentialed_github',
          source_comment_receipt: {
            repository: REPO,
            prNumber: 1436,
            headSha: HEAD,
            runId,
            slotId: slot.slotId,
            invocationId,
            commentId: 7000 + index,
            commentUrl: `https://github.com/${REPO}/pull/1436#issuecomment-${7000 + index}`,
            actorLogin: 'browser-gpt-bot',
            createdAt: timestamp,
            updatedAt: timestamp,
            bodySha256: '0'.repeat(64),
          },
        },
        payload: { verdict: 'clean', findingCount: 0, findings: [] },
      };
    }),
  };
}

function legacyBrowserOnlyRound(): PackReviewGptRoundRecord {
  return {
    ...threeSlotRound(),
    sourceSlots: threeSlotRound().sourceSlots.map((slot, index) => {
      const invocationId = `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`;
      return {
        ...slot,
        lifecycle: 'terminal' as const,
        invocationId,
        attemptOrdinal: 1,
        admissionStartedAtUtc: '2026-08-17T00:00:00Z',
        terminalClass: 'complete_clean',
        terminalResult: {
          schema: 'turn-result/v1',
          state: 'ok',
          scope: 'none',
          cause: 'completed_page_only',
          invocation_id: invocationId,
          send_count: 1,
        },
        payload: { verdict: 'clean', findingCount: 0, findings: [] },
      };
    }),
  };
}

function journaledRun(storeRoot: string, receiptBacked: boolean): string {
  const created = createPackReviewRun({
    projectId: 'orchestrator-pack',
    storeRoot,
    prNumber: 1436,
    headSha: HEAD,
    linkedSessionId: 'worker-fixture',
    trustedPackRoot: process.cwd(),
    sourceRepoRoot: process.cwd(),
    canonicalRepository: REPO,
    reviewRound: threeSlotRound(),
  });
  const reviewRound = receiptBacked
    ? receiptBackedRound(created.run.id)
    : legacyBrowserOnlyRound();
  setPackReviewRunTerminal(created.run.id, 'up_to_date', {
    reviewVerdict: 'clean',
    findingCount: 0,
    findings: [],
    reviewRound,
    journalOutcome: {
      state: 'persisted',
      recordedAtUtc: new Date().toISOString(),
      reason: 'fixture journaled verdict',
      idempotencyKey: `verdict:${created.run.id}:${HEAD}`,
      attempts: 1,
    },
  }, { projectId: 'orchestrator-pack', storeRoot });
  return created.run.id;
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pack runner GitHub-first GPT source authority (Issue #1435)', () => {
  it('completes from GitHub source comments even when browser stdout has no review payload', async () => {
    const storeRoot = tempRoot();
    process.env.OPK_VITEST_HARNESS = '1';
    process.env.PACK_REVIEWER = 'gpt';
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/g-fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const publications = new Map<string, PublishedSource>();
    const transport = dynamicTransport(publications);
    const result = await startPackReview({
      ...baseStart(storeRoot, transport),
      fixtureBeforeGptSourceCommentCensus: ({ identity }) => {
        publications.set(identity.slotId, { identity, payload: 'NO_FINDINGS' });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('up_to_date');
    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    expect(run?.reviewVerdict).toBe('clean');
    expect(run?.reviewRound?.sourceSlots.every((slot) => (
      slot.terminalClass === 'complete_clean'
      && (slot.terminalResult as Record<string, unknown>).source_comment_authority === 'credentialed_github'
    ))).toBe(true);
  });

  it('standalone reconcile recovers source comments and completes final review/status/worker delivery', async () => {
    const storeRoot = tempRoot();
    process.env.OPK_VITEST_HARNESS = '1';
    const { runId, publications } = startedStaleRun(storeRoot);
    const review = { posts: 0 };
    const statusWrites: unknown[] = [];
    const workerWrites: unknown[] = [];

    const result = await reconcileStalePackReviewRuns({
      repoSlug: REPO,
      sourceRepoRoot: process.cwd(),
      projectId: 'orchestrator-pack',
      storeRoot,
      fixtureCurrentPrHeadSha: HEAD,
      fixtureGptSourceCommentTransport: dynamicTransport(publications),
      fixtureGithubReviewTransport: finalReviewTransport(review),
      fixtureRequiredStatusWriter: async (request) => { statusWrites.push(request); },
      fixtureWorkerNotifier: async (request) => {
        workerWrites.push(request);
        return { state: 'delivered' as const, reason: 'fixture' };
      },
      resolveRepositorySlug: async () => REPO,
    });

    expect(result.results).toContainEqual(expect.objectContaining({
      runId,
      recovered: true,
      deliveryReason: 'completed',
      reason: 'gpt_source_comments_recovered_and_delivered',
    }));
    expect(review.posts).toBe(1);
    expect(statusWrites).toHaveLength(1);
    expect(workerWrites).toHaveLength(1);
    const recovered = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    expect(recovered?.id).toBe(runId);
    expect(recovered?.journalOutcome?.state).toBe('persisted');
    expect(recovered?.reviewVerdict).toBe('findings');
    expect(recovered?.deliveryOutcomes.githubComment?.state).toBe('succeeded');
    expect(recovered?.deliveryOutcomes.requiredStatus?.state).toBe('succeeded');
    expect(recovered?.deliveryOutcomes.workerNotification?.state).toBe('delivered');
  });

  it('restarts after credentialed publication before slot persistence without reviewer resend and preserves a finding plus lost browser return', async () => {
    const storeRoot = tempRoot();
    const invocationLog = join(storeRoot, 'invocations.jsonl');
    process.env.OPK_VITEST_HARNESS = '1';
    process.env.PACK_REVIEWER = 'gpt';
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/g-fixture/project';
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const publications = new Map<string, PublishedSource>();
    const review = { posts: 0 };
    const statusWrites: unknown[] = [];
    const workerWrites: unknown[] = [];
    const transport = dynamicTransport(publications);
    const common = {
      ...baseStart(storeRoot, transport),
      fixtureGithubReviewTransport: finalReviewTransport(review),
      fixtureRequiredStatusWriter: async (request: unknown) => { statusWrites.push(request); },
      fixtureWorkerNotifier: async (request: unknown) => {
        workerWrites.push(request);
        return { state: 'delivered' as const, reason: 'fixture' };
      },
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: '', exitCode: 13 }],
        'source-02': [{ stdout: sentTerminal() }],
        'source-03': [{ stdout: sentTerminal() }],
      },
      fixtureBeforeGptSourceCommentCensus: ({ identity }: { identity: PackGptSourceIdentity }) => {
        publications.set(identity.slotId, {
          identity,
          payload: identity.slotId === 'source-01' ? findingSourcePayload('GPT-LOST-RETURN') : 'NO_FINDINGS',
        });
      },
    };

    const first = await startPackReview({
      ...common,
      fixtureCrashAfterGptSourceCredentialedCount: 3,
    });
    expect(first.ok).toBe(false);
    expect(first.reason).toBe('fixture_crash_after_gpt_source_comment_credentialed');
    expect(invocationLogCount(invocationLog)).toBe(3);
    const runId = String(first.runId);
    const staleAt = new Date('2026-08-16T00:00:00Z');
    updatePackReviewRun(runId, {
      status: 'running',
      latestRunStatus: 'running',
      runnerPid: 2147483647,
    }, { projectId: 'orchestrator-pack', storeRoot, now: staleAt });

    const second = await startPackReview(common);
    expect(second.ok).toBe(true);
    expect(invocationLogCount(invocationLog)).toBe(3);
    expect(review.posts).toBe(1);
    expect(statusWrites.length).toBeGreaterThanOrEqual(1);
    expect(workerWrites).toHaveLength(1);
    const recovered = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    expect(recovered?.id).toBe(runId);
    expect(recovered?.reviewVerdict).toBe('findings');
    expect(recovered?.findingCount).toBe(1);
    expect(recovered?.reviewRound?.sourceSlots.every((slot) => slot.terminalClass === 'complete_clean'
      || slot.terminalClass === 'complete_findings')).toBe(true);
  });

  it('binds zero-send retry proof to the persisted invocation and treats mismatched terminal identity as census-only ambiguity', async () => {
    const storeRoot = tempRoot();
    const invocationLog = join(storeRoot, 'invocations.jsonl');
    process.env.OPK_VITEST_HARNESS = '1';
    process.env.PACK_REVIEWER = 'gpt';
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/g-fixture/project';
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const processResult = {
      outcome: 'exit' as const,
      ok: false,
      exitCode: 13,
      signal: null,
      stdout: zeroSendTerminal('wrong-invocation'),
      stderr: '',
      timedOut: false,
      cancelled: false,
    };
    expect(isRetryablePackReviewZeroSendCollision(processResult, 'expected-invocation')).toBe(false);

    const publications = new Map<string, PublishedSource>();
    const census = { listCalls: 0 };
    const transport = dynamicTransport(publications, census);
    const result = await startPackReview({
      ...baseStart(storeRoot, transport),
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: zeroSendTerminal('wrong-source-01'), exitCode: 13 }, { stdout: sentTerminal() }],
        'source-02': [{ stdout: zeroSendTerminal('wrong-source-02'), exitCode: 13 }, { stdout: sentTerminal() }],
        'source-03': [{ stdout: zeroSendTerminal('wrong-source-03'), exitCode: 13 }, { stdout: sentTerminal() }],
      },
      fixtureBeforeGptSourceCommentCensus: ({ identity }) => {
        publications.set(identity.slotId, { identity, payload: 'NO_FINDINGS' });
      },
    });

    expect(result.ok).toBe(true);
    expect(invocationLogCount(invocationLog)).toBe(3);
    expect(census.listCalls).toBeGreaterThanOrEqual(3);
    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    expect(run?.reviewRound?.sourceSlots.every((slot) => slot.attemptOrdinal === 1)).toBe(true);
  });

  it('refuses a legacy browser-only journal as delivery authority but resumes the same shape when every complete source has a credentialed receipt', async () => {
    process.env.OPK_VITEST_HARNESS = '1';
    process.env.PACK_REVIEWER = 'gpt';
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/g-fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const legacyRoot = tempRoot();
    const legacyRunId = journaledRun(legacyRoot, false);
    const legacyReview = { posts: 0 };
    const legacy = await startPackReview({
      ...baseStart(legacyRoot, dynamicTransport(new Map())),
      fixtureReviewTimedOut: true,
      fixtureGithubReviewTransport: finalReviewTransport(legacyReview),
    });
    expect(legacy.reason).not.toBe('resumed_journaled_delivery');
    expect(legacyReview.posts).toBe(0);
    expect(getPackReviewRun(legacyRunId, { projectId: 'orchestrator-pack', storeRoot: legacyRoot })?.githubReviewId).toBeUndefined();

    const receiptRoot = tempRoot();
    const receiptRunId = journaledRun(receiptRoot, true);
    const receiptReview = { posts: 0 };
    const statusWrites: unknown[] = [];
    const workerWrites: unknown[] = [];
    const resumed = await startPackReview({
      ...baseStart(receiptRoot, dynamicTransport(new Map())),
      fixtureGithubReviewTransport: finalReviewTransport(receiptReview),
      fixtureRequiredStatusWriter: async (request) => { statusWrites.push(request); },
      fixtureWorkerNotifier: async (request) => {
        workerWrites.push(request);
        return { state: 'delivered' as const, reason: 'fixture' };
      },
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.reason).toBe('resumed_journaled_delivery');
    expect(resumed.runId).toBe(receiptRunId);
    expect(receiptReview.posts).toBe(1);
    expect(statusWrites).toHaveLength(1);
    expect(workerWrites).toHaveLength(1);
  });

  it('states the one-attempt comment-create fence in the runner-bound Browser-GPT prompt', () => {
    const identity: PackGptSourceIdentity = {
      repository: REPO,
      prNumber: 1436,
      headSha: HEAD,
      runId: 'prr-fixture',
      slotId: 'source-01',
      invocationId: '44444444-4444-4444-8444-444444444444',
    };
    const prompt = buildGptReviewPrompt({
      prUrl: `https://github.com/${REPO}/pull/1436`,
      headSha: HEAD,
      sourceIdentity: identity,
      scope: {
        issueNumber: 1435,
        hasScope: false,
        issueConstraints: null,
        declaredPaths: [],
        declaredGlobs: [],
        unverifiedIssueConstraints: true,
      },
    });
    expect(prompt).toContain('at most one send-capable top-level');
    expect(prompt).toContain('never invoke comment creation again for this invocation');
    expect(prompt).toContain('runner-side GitHub census');
  });
});
