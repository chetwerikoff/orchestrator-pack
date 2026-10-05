import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseArgs,
  resolvePackReviewReconcileRepository,
  startPackReview,
} from '../scripts/pack-review-runner.ts';
import { runExecuteIssueManagerBoundaryCli } from '../scripts/execute-issue-manager-boundary.ts';
import { getPackReviewRun } from '../scripts/lib/pack-review-run-store.ts';
import {
  formatPackGptSourceCommentEnvelope,
  type PackGptSourceIdentity,
} from '../scripts/lib/pack-gpt-source-comment-contract.ts';
import type {
  PackGptSourceCommentTransport,
  PackGptSourceGithubComment,
} from '../scripts/lib/pack-gpt-source-comment.ts';
import type {
  GithubReviewSummary,
  GithubReviewTransport,
} from '../scripts/lib/github-review-reconciliation.ts';

const REPO = 'chetwerikoff/orchestrator-pack';
const TARGET_REPO = 'chetwerikoff/leopoker';
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
  const root = mkdtempSync(join(tmpdir(), 'opk-2376-credentialed-'));
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

function sourceComment(publication: PublishedSource, id: number): PackGptSourceGithubComment {
  const timestamp = '2026-10-05T00:00:00Z';
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

function dynamicTransport(publications: Map<string, PublishedSource>): PackGptSourceCommentTransport {
  const census = (): PackGptSourceGithubComment[] => [...publications.values()].map(
    (publication, index) => sourceComment(publication, 5988302306 + index),
  );
  return {
    resolveActorLogin: async () => 'browser-gpt-bot',
    listComments: async () => census(),
    getComment: async (id) => {
      const selected = census().find((row) => row.id === id);
      if (!selected) throw new Error(`fixture comment ${String(id)} missing`);
      return selected;
    },
  };
}

function finalReviewTransport(counter: { posts: number }): GithubReviewTransport {
  const reviews: GithubReviewSummary[] = [];
  return {
    resolveActorLogin: async () => 'pack-runner-bot',
    listReviews: async () => [...reviews],
    postReview: async ({ body, commitId }) => {
      counter.posts += 1;
      const id = 237600 + counter.posts;
      const url = `https://github.com/${REPO}/pull/160#pullrequestreview-${id}`;
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

function invocationLogCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split(/\r?\n/u).filter((line) => line.trim()).length;
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #2376 credentialed source settlement', () => {
  it('settles the active three-slot published-source crash shape without resending review prompts', async () => {
    const storeRoot = tempRoot();
    const invocationLog = join(storeRoot, 'invocations.jsonl');
    process.env.OPK_VITEST_HARNESS = '1';
    process.env.PACK_REVIEWER = 'gpt';
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/g-fixture/project';
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const publications = new Map<string, PublishedSource>();
    const review = { posts: 0 };
    const statusWrites: Array<{ state?: string }> = [];
    const workerWrites: unknown[] = [];
    const transport = dynamicTransport(publications);
    const common = {
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber: 160,
      headSha: HEAD,
      tier: 'T1' as const,
      fixtureIssueBody: ISSUE_BODY,
      fixtureIssueNumber: 2376,
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
      fixtureGithubReviewTransport: finalReviewTransport(review),
      fixtureRequiredStatusWriter: async (request: { state?: string }) => { statusWrites.push(request); },
      fixtureWorkerNotifier: async (request: unknown) => {
        workerWrites.push(request);
        return { state: 'delivered' as const, reason: 'fixture' };
      },
      fixtureBeforeGptSourceCommentCensus: ({ identity }: { identity: PackGptSourceIdentity }) => {
        publications.set(identity.slotId, { identity, payload: 'NO_FINDINGS' });
      },
    };

    const first = await startPackReview({
      ...common,
      fixtureCrashAfterGptSourceCredentialedCount: 3,
    });
    expect(first).toMatchObject({
      ok: false,
      reason: 'fixture_crash_after_gpt_source_comment_credentialed',
    });
    expect(publications.size).toBe(3);
    expect(invocationLogCount(invocationLog)).toBe(3);

    const runId = String(first.runId);
    const beforeRecovery = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    expect(beforeRecovery?.status).toBe('running');
    expect(beforeRecovery?.reviewVerdict).toBeUndefined();

    const second = await startPackReview(common);

    expect(second.ok).toBe(true);
    expect(String(second.reason ?? '')).not.toBe('reply_recovery_required');
    expect(invocationLogCount(invocationLog)).toBe(3);
    expect(review.posts).toBe(1);
    expect(statusWrites.at(-1)?.state).toBe('success');
    expect(workerWrites).toHaveLength(1);

    const recovered = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    expect(recovered?.reviewVerdict).toBe('clean');
    expect(recovered?.findingCount).toBe(0);
    expect(recovered?.journalOutcome?.state).toBe('persisted');
    expect(recovered?.deliveryOutcomes.requiredStatus?.state).toBe('succeeded');
    expect(recovered?.reviewRound?.sourceSlots).toHaveLength(3);
    expect(recovered?.reviewRound?.sourceSlots.every((slot) => (
      slot.lifecycle === 'terminal'
      && slot.terminalClass === 'complete_clean'
      && (slot.terminalResult as Record<string, unknown>).source_comment_authority === 'credentialed_github'
    ))).toBe(true);

    const output: string[] = [];
    const errors: string[] = [];
    const code = runExecuteIssueManagerBoundaryCli([
      'classify',
      '--record',
      '/fixture/review-runner.json',
      '--repo',
      REPO,
      '--issue-number',
      '2376',
      '--source-revision',
      'r02',
      '--phase',
      'review',
      '--production-argv-json',
      JSON.stringify(['node', '--experimental-strip-types', 'scripts/pack-review-runner.ts', 'start']),
      '--pr-number',
      '160',
    ], {
      readFile: () => JSON.stringify(second),
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      currentArgv: ['node', 'scripts/execute-issue-manager-boundary.ts', 'classify'],
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: true,
      cause: 'execute_review_runner_completed',
      nextAction: null,
    });
  });

  it('keeps explicit reconcile repository selection authoritative over observed checkout repository', async () => {
    const parsed = parseArgs([
      '--source-repo-root',
      '/fixture/leopoker',
      '--repo-slug',
      TARGET_REPO,
      '--pr-number',
      '160',
      '--immediate',
    ]);
    expect(parsed).toMatchObject({
      sourceRepoRoot: '/fixture/leopoker',
      repoSlug: TARGET_REPO,
      prNumber: 160,
      immediate: true,
    });

    let observedReads = 0;
    const resolved = await resolvePackReviewReconcileRepository({
      sourceRepoRoot: String(parsed.sourceRepoRoot),
      explicitRepoSlug: String(parsed.repoSlug),
      selectedTarget: { repository: TARGET_REPO },
      resolveRepository: async () => {
        observedReads += 1;
        return REPO;
      },
    });

    expect(resolved).toBe(TARGET_REPO);
    expect(observedReads).toBe(0);
  });
});
