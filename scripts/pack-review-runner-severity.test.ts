import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emitAoReviewPayload,
  emitTerminalVerdictPayload,
  toAoFindings,
} from '../plugins/ao-codex-pr-reviewer/lib/emit.js';
import { parseCodexReviewOutput } from '../plugins/ao-codex-pr-reviewer/lib/review_jsonl.js';
import { scopeUnavailableWarningFinding } from '../plugins/ao-codex-pr-reviewer/lib/scope_context.js';
import type { StructuredFinding } from '../plugins/ao-codex-pr-reviewer/lib/types.js';
import { startPackReview } from './pack-review-runner.js';
import {
  selectActiveSameActorBlockingReviewIds,
  type GithubReviewCaptureAction,
  type GithubReviewSummary,
  type GithubReviewTransport,
} from './lib/github-review-reconciliation.js';
import { listPackReviewRuns } from './lib/pack-review-run-store.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoots: string[] = [];
const originalEnv = { ...process.env };
const HEAD_SHA = 'a'.repeat(40);
let nextReviewId = 86600;

interface GithubReviewFixture {
  id: number | string;
  state: string;
  user: { login: string };
  submitted_at: string;
  body?: string;
  commit_id?: string;
}

interface CaptureOptions {
  actorLogin?: string;
  priorReviews?: GithubReviewFixture[];
}

type CaptureAction = GithubReviewCaptureAction;

class FaultInjectingGithubTransport implements GithubReviewTransport {
  readonly actions: GithubReviewCaptureAction[] = [];
  readonly reviews: GithubReviewSummary[];
  postMode: 'ok' | 'fail-before-accept' | 'invalid-after-accept' | 'timeout-after-accept' = 'ok';
  failListAfterAcceptedPostOnce = false;
  private nextId = 9900;

  constructor(readonly actorLogin: string, reviews: GithubReviewSummary[]) {
    this.reviews = reviews.map((review) => ({ ...review }));
  }

  async resolveActorLogin(): Promise<string> {
    return this.actorLogin;
  }

  async listReviews(): Promise<GithubReviewSummary[]> {
    if (this.failListAfterAcceptedPostOnce) {
      this.failListAfterAcceptedPostOnce = false;
      throw new Error('injected review-list outage after accepted post');
    }
    return this.reviews.map((review) => ({ ...review }));
  }

  async postReview(input: { event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES'; body: string; commitId: string }) {
    this.actions.push({ kind: 'post', event: input.event, body: input.body });
    if (this.postMode === 'fail-before-accept') {
      throw new Error('injected COMMENT POST failure before acceptance');
    }
    const id = this.nextId++;
    this.reviews.push({
      id,
      state: input.event === 'COMMENT' ? 'COMMENTED' : input.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED',
      userLogin: this.actorLogin,
      submittedAt: new Date(Date.parse('2026-07-16T12:00:00.000Z') + id).toISOString(),
      body: input.body,
      commitId: input.commitId,
      url: `fixture://review/${id}`,
    });
    if (this.postMode === 'invalid-after-accept') {
      throw new Error('GitHub PR review post returned invalid JSON: injected');
    }
    if (this.postMode === 'timeout-after-accept') {
      throw new Error('GitHub PR review post failed: timeout');
    }
    return { id, url: `fixture://review/${id}` };
  }

  async dismissReview(reviewId: number | string): Promise<void> {
    const review = this.reviews.find((entry) => String(entry.id) === String(reviewId));
    if (!review) throw new Error(`missing injected review ${reviewId}`);
    review.state = 'DISMISSED';
    this.actions.push({ kind: 'dismiss', reviewId, event: 'DISMISS' });
  }

  activeBlockingIds(): Array<number | string> {
    return selectActiveSameActorBlockingReviewIds(this.reviews, this.actorLogin);
  }
}

function reviewSummary(
  id: number,
  state: string,
  actorLogin: string,
  submittedAt: string,
  body = '',
): GithubReviewSummary {
  return { id, state, userLogin: actorLogin, submittedAt, body, commitId: HEAD_SHA, url: `fixture://review/${id}` };
}

async function runWithTransport(
  storeRoot: string,
  transport: GithubReviewTransport,
  fixtureReviewStdout: string,
) {
  process.env.OPK_VITEST_HARNESS = '1';
  return startPackReview({
    projectId: 'orchestrator-pack',
    storeRoot,
    sourceRepoRoot: repoRoot,
    prNumber: 866,
    headSha: HEAD_SHA,
    claimMode: 'preacquired',
    fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
    fixtureReviewStdout,
    fixtureGithubReviewTransport: transport,
  });
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function structuredFinding(
  severity: string,
  summary = `${severity} finding`,
  type: StructuredFinding['type'] = 'quality',
): StructuredFinding {
  return {
    type,
    code: `quality:${summary.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    severity,
    path: null,
    summary,
    details: `${summary} details`,
    source: 'codex-local',
  };
}

async function captureReview(
  fixtureReviewStdout: string,
  options: CaptureOptions = {},
): Promise<{
  event: string;
  body: string;
  status: unknown;
  dismissedReviewIds: Array<number | string>;
  actions: CaptureAction[];
}> {
  const storeRoot = tempRoot('opk-review-severity-');
  const capture = path.join(storeRoot, 'github-review.json');
  process.env.OPK_VITEST_HARNESS = '1';
  process.env.PACK_REVIEW_GITHUB_REVIEW_CAPTURE_FILE = capture;
  if (options.actorLogin) {
    process.env.PACK_REVIEW_GITHUB_ACTOR_LOGIN = options.actorLogin;
  } else {
    delete process.env.PACK_REVIEW_GITHUB_ACTOR_LOGIN;
  }
  if (options.priorReviews) {
    process.env.PACK_REVIEW_GITHUB_REVIEWS_FIXTURE = JSON.stringify(options.priorReviews);
  } else {
    delete process.env.PACK_REVIEW_GITHUB_REVIEWS_FIXTURE;
  }
  const result = await startPackReview({
    projectId: 'orchestrator-pack',
    storeRoot,
    sourceRepoRoot: repoRoot,
    prNumber: 866,
    headSha: HEAD_SHA,
    claimMode: 'preacquired',
    fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
    fixtureGithubReviewId: nextReviewId++,
    fixtureReviewStdout,
  });
  expect(result.ok).toBe(true);
  const posted = JSON.parse(readFileSync(capture, 'utf8')) as {
    event: string;
    body: string;
    dismissedReviewIds?: Array<number | string>;
    actions?: CaptureAction[];
  };
  return {
    ...posted,
    status: result.status,
    dismissedReviewIds: posted.dismissedReviewIds ?? [],
    actions: posted.actions ?? [],
  };
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('severity-aware pack GitHub review events (Issue #866)', () => {
  it('keeps a clean zero-finding payload as APPROVE', async () => {
    const posted = await captureReview(JSON.stringify({
      verdict: 'clean',
      findingCount: 0,
      findings: [],
    }));
    expect(posted.event).toBe('APPROVE');
    expect(posted.status).toBe('up_to_date');
  });

  it('posts COMMENT and records a non-blocking terminal status when every finding is warning or info', async () => {
    const posted = await captureReview(JSON.stringify({
      verdict: 'findings',
      findingCount: 2,
      findings: [
        { title: 'Warning', body: 'Worth noting', severity: 'warning' },
        { title: 'Information', body: 'Context only', severity: 'info' },
      ],
    }));
    expect(posted.event).toBe('COMMENT');
    expect(posted.status).toBe('commented');
  });

  it.each([
    ['an error finding', { verdict: 'findings', findingCount: 1, findings: [{ severity: 'error' }] }],
    ['a missing severity', { verdict: 'findings', findingCount: 1, findings: [{ title: 'Missing' }] }],
    ['an unrecognized severity', { verdict: 'findings', findingCount: 1, findings: [{ severity: 'future-value' }] }],
    ['mixed blocking and non-blocking findings', {
      verdict: 'findings',
      findingCount: 2,
      findings: [{ severity: 'warning' }, { severity: 'error' }],
    }],
    ['an empty findings verdict', { verdict: 'findings', findingCount: 0, findings: [] }],
  ])('fails closed to REQUEST_CHANGES for %s', async (_label, payload) => {
    const posted = await captureReview(JSON.stringify(payload));
    expect(posted.event).toBe('REQUEST_CHANGES');
    expect(posted.status).toBe('changes_requested');
  });

  it.each([
    ['null', null],
    ['string', 'malformed'],
    ['number', 7],
  ])('renders an explicit blocking diagnostic for a malformed %s finding element', async (_label, finding) => {
    const posted = await captureReview(JSON.stringify({
      verdict: 'findings',
      findingCount: 1,
      findings: [finding],
    }));
    expect(posted.event).toBe('REQUEST_CHANGES');
    expect(posted.status).toBe('changes_requested');
    expect(posted.body).toContain('### Malformed finding payload at index 1');
    expect(posted.body).toContain('The reviewer emitted a non-object finding; it was treated as blocking.');
  });

  it('uses the real producer shape for ordinary non-blocking findings', async () => {
    const stdout = emitAoReviewPayload(toAoFindings([
      structuredFinding('non-blocking', 'Ordinary observation'),
    ]));
    const posted = await captureReview(stdout);
    expect(posted.event).toBe('COMMENT');
    expect(posted.status).toBe('commented');
  });

  it('uses the real producer shape for ordinary blocking findings', async () => {
    const stdout = emitAoReviewPayload(toAoFindings([
      structuredFinding('blocking', 'Action required'),
    ]));
    const posted = await captureReview(stdout);
    expect(posted.event).toBe('REQUEST_CHANGES');
  });

  it('posts a clean verdict with the real scope-unavailable warning shape as COMMENT', async () => {
    const stdout = emitTerminalVerdictPayload({
      verdict: 'clean',
      findings: toAoFindings([
        scopeUnavailableWarningFinding('codex-local'),
      ]),
    });
    const posted = await captureReview(stdout);
    expect(posted.event).toBe('COMMENT');
    expect(posted.status).toBe('commented');
    expect(posted.body).toContain('Scope context unavailable');
  });

  it('posts COMMENT before dismissing the same pack actor previous REQUEST_CHANGES', async () => {
    const actorLogin = 'pack-reviewer';
    const priorReviews: GithubReviewFixture[] = [
      { id: 901, state: 'CHANGES_REQUESTED', user: { login: actorLogin }, submitted_at: '2026-07-16T10:00:00Z' },
      { id: 902, state: 'COMMENTED', user: { login: actorLogin }, submitted_at: '2026-07-16T10:05:00Z' },
    ];
    const posted = await captureReview(JSON.stringify({
      verdict: 'findings',
      findingCount: 1,
      findings: [{ title: 'Advisory', body: 'Non-blocking.', severity: 'warning' }],
    }), { actorLogin, priorReviews });

    expect(posted.event).toBe('COMMENT');
    expect(posted.dismissedReviewIds).toEqual([901]);
    expect(posted.actions).toHaveLength(2);
    expect(posted.actions[0]).toMatchObject({ kind: 'post', event: 'COMMENT' });
    expect(posted.actions[1]).toMatchObject({ kind: 'dismiss', reviewId: 901, event: 'DISMISS' });

    const activeStates = [
      ...priorReviews
        .filter((review) => !posted.dismissedReviewIds.includes(review.id))
        .map((review) => review.state),
      posted.event === 'COMMENT' ? 'COMMENTED' : posted.event,
    ];
    expect(activeStates).not.toContain('CHANGES_REQUESTED');
    expect(activeStates).toContain('COMMENTED');
  });

  it('dismisses every active same-actor blocker after a confirmed COMMENT in stable order', async () => {
    const actor = 'pack-reviewer';
    const transport = new FaultInjectingGithubTransport(actor, [
      reviewSummary(100, 'CHANGES_REQUESTED', actor, '2026-07-16T10:00:00Z'),
      reviewSummary(101, 'COMMENTED', actor, '2026-07-16T10:01:00Z'),
      reviewSummary(102, 'CHANGES_REQUESTED', actor, '2026-07-16T10:02:00Z'),
      reviewSummary(103, 'CHANGES_REQUESTED', 'other-reviewer', '2026-07-16T10:03:00Z'),
    ]);
    const storeRoot = tempRoot('opk-comment-multi-blocker-');
    const result = await runWithTransport(storeRoot, transport, JSON.stringify({
      verdict: 'findings',
      findingCount: 1,
      findings: [{ severity: 'warning', title: 'Advisory' }],
    }));
    expect(result).toMatchObject({ ok: true, status: 'commented' });
    expect(transport.actions.map((action) => [action.kind, action.reviewId ?? null])).toEqual([
      ['post', null],
      ['dismiss', 100],
      ['dismiss', 102],
    ]);
    expect(transport.activeBlockingIds()).toEqual([]);
    expect(selectActiveSameActorBlockingReviewIds(transport.reviews, 'other-reviewer')).toEqual([103]);
  });

  it('uses timestamps and effective approvals when selecting active same-actor blockers', () => {
    const actor = 'pack-reviewer';
    const reviews = [
      reviewSummary(1, 'CHANGES_REQUESTED', actor, '2026-07-16T10:00:00Z'),
      reviewSummary(2, 'COMMENTED', actor, '2026-07-16T10:01:00Z'),
      reviewSummary(3, 'APPROVED', actor, '2026-07-16T10:02:00Z'),
      reviewSummary(4, 'DISMISSED', actor, '2026-07-16T10:03:00Z'),
      reviewSummary(5, 'CHANGES_REQUESTED', actor, '2026-07-16T10:04:00Z'),
      reviewSummary(6, 'CHANGES_REQUESTED', 'other-reviewer', '2026-07-16T10:05:00Z'),
    ];
    expect(selectActiveSameActorBlockingReviewIds(reviews, actor)).toEqual([5]);
  });

  it('keeps GitHub blocking and records prepared recovery state when COMMENT POST fails before acceptance', async () => {
    const actor = 'pack-reviewer';
    const transport = new FaultInjectingGithubTransport(actor, [
      reviewSummary(200, 'CHANGES_REQUESTED', actor, '2026-07-16T10:00:00Z'),
    ]);
    transport.postMode = 'fail-before-accept';
    const storeRoot = tempRoot('opk-comment-post-fail-');
    const result = await runWithTransport(storeRoot, transport, JSON.stringify({
      verdict: 'findings',
      findingCount: 1,
      findings: [{ severity: 'warning' }],
    }));
    expect(result.ok).toBe(false);
    expect(transport.activeBlockingIds()).toEqual([200]);
    const run = listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })[0];
    expect(run?.githubReviewReconciliation).toMatchObject({ phase: 'prepared', event: 'COMMENT' });
  });

  it('recovers an accepted COMMENT from an invalid response before dismissing blockers', async () => {
    const actor = 'pack-reviewer';
    const transport = new FaultInjectingGithubTransport(actor, [
      reviewSummary(300, 'CHANGES_REQUESTED', actor, '2026-07-16T10:00:00Z'),
    ]);
    transport.postMode = 'invalid-after-accept';
    const storeRoot = tempRoot('opk-comment-invalid-response-');
    const result = await runWithTransport(storeRoot, transport, JSON.stringify({
      verdict: 'findings',
      findingCount: 1,
      findings: [{ severity: 'warning' }],
    }));
    expect(result).toMatchObject({ ok: true, status: 'commented' });
    expect(transport.actions[0]).toMatchObject({ kind: 'post', event: 'COMMENT' });
    expect(transport.actions[1]).toMatchObject({ kind: 'dismiss', reviewId: 300 });
    expect(transport.activeBlockingIds()).toEqual([]);
  });

  it('recovers an incomplete accepted COMMENT after process restart and only then dismisses blockers', async () => {
    const actor = 'pack-reviewer';
    const transport = new FaultInjectingGithubTransport(actor, [
      reviewSummary(400, 'CHANGES_REQUESTED', actor, '2026-07-16T10:00:00Z'),
    ]);
    transport.postMode = 'timeout-after-accept';
    transport.failListAfterAcceptedPostOnce = true;
    const storeRoot = tempRoot('opk-comment-restart-');
    const stdout = JSON.stringify({
      verdict: 'findings',
      findingCount: 1,
      findings: [{ severity: 'warning' }],
    });
    const first = await runWithTransport(storeRoot, transport, stdout);
    expect(first.ok).toBe(false);
    expect(transport.activeBlockingIds()).toEqual([400]);
    const pending = listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })[0];
    expect(pending?.githubReviewReconciliation).toMatchObject({ phase: 'prepared', event: 'COMMENT' });

    transport.postMode = 'ok';
    const recovered = await runWithTransport(storeRoot, transport, stdout);
    expect(recovered).toMatchObject({ ok: true, recovered: true, status: 'commented' });
    expect(transport.activeBlockingIds()).toEqual([]);
    const final = listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })[0];
    expect(final).toMatchObject({ status: 'commented', githubReviewEvent: 'COMMENT' });
    expect(final?.githubReviewReconciliation).toMatchObject({ phase: 'complete' });
  });

  it('maps an unrecognized reviewer severity to error and REQUEST_CHANGES', async () => {
    const findings = toAoFindings([
      structuredFinding('unexpected-severity', 'Unknown reviewer severity'),
    ]);
    expect(findings[0]?.severity).toBe('error');
    const posted = await captureReview(emitAoReviewPayload(findings));
    expect(posted.event).toBe('REQUEST_CHANGES');
  });

  it('maps a JSONL finding without priority or bracket to blocking and REQUEST_CHANGES', async () => {
    const parsed = parseCodexReviewOutput({
      findings: [{
        title: 'Finding without priority',
        body: 'The reviewer omitted both priority and a bracketed title prefix.',
      }],
      overall_correctness: 'patch is incorrect',
    }, 'codex-local', repoRoot);
    expect(parsed.kind).toBe('findings');
    if (parsed.kind !== 'findings') throw new Error('expected parsed findings');
    expect(parsed.findings[0]?.severity).toBe('blocking');
    const wireFindings = toAoFindings(parsed.findings);
    expect(wireFindings[0]?.severity).toBe('error');
    const posted = await captureReview(emitAoReviewPayload(wireFindings));
    expect(posted.event).toBe('REQUEST_CHANGES');
  });
});
