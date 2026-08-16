import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  reconcileStalePackReviewRuns,
  startPackReview,
} from '../pack-review-runner.ts';
import {
  createPackReviewRun,
  getPackReviewRun,
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

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-1435-source-runner-'));
  roots.push(root);
  return root;
}

function sentTerminal(): string {
  return JSON.stringify({
    schema: 'turn-result/v1',
    state: 'ok',
    scope: 'none',
    cause: 'completed_page_only',
    invocation_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    send_count: 1,
  });
}

function sourceComment(identity: PackGptSourceIdentity, id: number): PackGptSourceGithubComment {
  const timestamp = '2026-08-17T00:00:00Z';
  return {
    id,
    body: formatPackGptSourceCommentEnvelope(identity, 'NO_FINDINGS'),
    url: `https://github.com/${REPO}/pull/${identity.prNumber}#issuecomment-${id}`,
    issueUrl: `https://api.github.com/repos/${REPO}/issues/${identity.prNumber}`,
    actorLogin: 'browser-gpt-bot',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function dynamicTransport(
  identities: Map<string, PackGptSourceIdentity>,
): PackGptSourceCommentTransport {
  const census = (): PackGptSourceGithubComment[] => [...identities.values()].map((identity, index) => (
    sourceComment(identity, 5000 + index)
  ));
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

    const identities = new Map<string, PackGptSourceIdentity>();
    const transport = dynamicTransport(identities);
    const result = await startPackReview({
      ...baseStart(storeRoot, transport),
      fixtureAfterGptInvocationBound: ({ slotId, invocationId, round }) => {
        const slot = round.sourceSlots.find((row) => row.slotId === slotId)!;
        identities.set(slotId, {
          repository: REPO,
          prNumber: 1436,
          headSha: HEAD,
          runId: String((getPackReviewRunResultId(storeRoot))),
          slotId,
          invocationId,
        });
        expect(slot.invocationId).toBe(invocationId);
        expect(slot.lifecycle).toBe('invocation_started');
      },
      onRunStarted: ({ runId }) => {
        (globalThis as { __opk1435RunId?: string }).__opk1435RunId = runId;
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

  it('recovers the same stale run from already-published source comments without a reviewer resend', async () => {
    const storeRoot = tempRoot();
    process.env.OPK_VITEST_HARNESS = '1';
    const staleAt = new Date('2026-08-16T00:00:00Z');
    const created = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      now: staleAt,
      prNumber: 1436,
      headSha: HEAD,
      trustedPackRoot: process.cwd(),
      sourceRepoRoot: process.cwd(),
      canonicalRepository: REPO,
      reviewRound: threeSlotRound(),
    });
    const identities = new Map<string, PackGptSourceIdentity>();
    const startedRound: PackReviewGptRoundRecord = {
      ...created.run.reviewRound!,
      sourceSlots: created.run.reviewRound!.sourceSlots.map((slot, index) => {
        const invocationId = `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`;
        identities.set(slot.slotId, {
          repository: REPO,
          prNumber: 1436,
          headSha: HEAD,
          runId: created.run.id,
          slotId: slot.slotId,
          invocationId,
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

    const result = await reconcileStalePackReviewRuns({
      repoSlug: REPO,
      sourceRepoRoot: process.cwd(),
      projectId: 'orchestrator-pack',
      storeRoot,
      fixtureCurrentPrHeadSha: HEAD,
      fixtureGptSourceCommentTransport: dynamicTransport(identities),
      fixtureRequiredStatusWriter: async () => {},
      resolveRepositorySlug: async () => REPO,
    });

    expect(result.results).toContainEqual(expect.objectContaining({
      runId: created.run.id,
      recovered: true,
      reason: 'gpt_source_comments_recovered_for_resume',
    }));
    const recovered = getPackReviewRun(created.run.id, { projectId: 'orchestrator-pack', storeRoot });
    expect(recovered?.id).toBe(created.run.id);
    expect(recovered?.journalOutcome?.state).toBe('persisted');
    expect(recovered?.reviewVerdict).toBe('clean');
    expect(recovered?.reviewRound?.sourceSlots.every((slot) => slot.terminalClass === 'complete_clean')).toBe(true);
  });
});

function getPackReviewRunResultId(storeRoot: string): string {
  const explicit = (globalThis as { __opk1435RunId?: string }).__opk1435RunId;
  if (!explicit) throw new Error(`fixture run id unavailable for ${storeRoot}`);
  return explicit;
}
