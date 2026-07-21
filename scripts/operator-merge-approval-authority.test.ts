import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateMergePolicy } from '../docs/merge-triage-gate.mjs';
import { evaluateDirectOperatorReviewSafety } from './lib/operator-merge-approval-authority.mjs';
import { classifyArgv } from './lib/gh-inventory-match.mjs';
import { executeRestRoute } from './lib/gh-rest-routes.mjs';
import { parseGhArgv } from './lib/gh-parse-argv.mjs';
import { approveOperatorMerge } from './lib/operator-merge-approval.ts';
import {
  runOperatorMergeApprovalCommand,
  type OperatorMergeApprovalGithubTransport,
  type OperatorMergeApprovalStatusRequest,
} from './operator-merge-approval.ts';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const REPO = 'chetwerikoff/orchestrator-pack';
const REVIEW_ID = '9001';
const RUN_ID = 'prr-authority-fixture';
const roots: string[] = [];
const originalEnv = { ...process.env };

function tempRoot(prefix = 'opk-approval-authority-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function setOperatorEnvironment(): void {
  delete process.env.AO_SESSION_ID;
  process.env.AO_SESSION_KIND = 'operator';
}

function reviewBody(details: string): string {
  return [
    '## Pack review — findings',
    '',
    `Run: \`${RUN_ID}\``,
    `Head: \`${HEAD}\``,
    '',
    '### Review finding',
    '',
    details,
    '',
    '---',
    '_Automated review by orchestrator-pack pack-owned runner_',
  ].join('\n');
}

interface ReviewFixtureOptions {
  terminal?: boolean;
  verdict?: 'clean' | 'findings';
  severity?: 'warning' | 'blocking';
  body?: string;
  currentHeadSha?: string;
  reviewHeadSha?: string;
  reviewState?: string;
  actorLogin?: string;
}

function seedReview(options: ReviewFixtureOptions = {}): {
  stateRoot: string;
  approvalRoot: string;
  body: string;
} {
  const stateRoot = tempRoot();
  const reviewStore = tempRoot();
  const approvalRoot = join(stateRoot, 'approval-root');
  const body = options.body ?? reviewBody('TOCTOU under concurrent head movement.');
  const terminal = options.terminal !== false;
  const verdict = options.verdict ?? 'findings';
  const severity = options.severity ?? 'warning';
  const status = terminal
    ? (severity === 'blocking' ? 'changes_requested' : 'commented')
    : 'reviewing';
  const journalAt = '2026-07-21T01:00:00.000Z';
  const deliveredAt = '2026-07-21T01:01:00.000Z';
  const completedAt = '2026-07-21T01:02:00.000Z';
  const finding = {
    id: 'finding-authority-1',
    fingerprint: 'finding-authority-1',
    title: 'Review finding',
    body: body.includes('CI will fail') ? 'CI will fail on the documented path.' : 'TOCTOU under concurrent head movement.',
    severity,
    status: 'open',
    headSha: HEAD,
  };
  const record = {
    schemaVersion: 1,
    id: RUN_ID,
    runId: RUN_ID,
    projectId: 'orchestrator-pack',
    key: `pr-933-${HEAD}`,
    prNumber: 933,
    targetSha: HEAD,
    headSha: HEAD,
    status,
    latestRunStatus: status,
    linkedSessionId: 'session-933',
    startReason: 'test',
    surface: 'pack-review-runner',
    trustedPackRoot: stateRoot,
    sourceRepoRoot: stateRoot,
    runnerPid: process.pid,
    createdAt: journalAt,
    updatedAt: terminal ? completedAt : journalAt,
    heartbeatAtUtc: journalAt,
    reviewVerdict: verdict,
    findingCount: 1,
    findings: [finding],
    journalOutcome: {
      state: 'persisted',
      recordedAtUtc: journalAt,
      reason: 'verdict_persisted',
      idempotencyKey: `verdict:${RUN_ID}:${HEAD}`,
      attempts: 1,
    },
    deliveryOutcomes: terminal ? {
      githubComment: {
        state: 'succeeded',
        recordedAtUtc: deliveredAt,
        reason: 'comment_posted',
        idempotencyKey: `github-comment:${RUN_ID}:${HEAD}`,
      },
      requiredStatus: {
        state: 'succeeded',
        recordedAtUtc: deliveredAt,
        reason: severity === 'blocking' ? 'status_failure' : 'status_success',
        idempotencyKey: `required-status:orchestrator-pack/pack-review:${HEAD}`,
      },
    } : {},
    ...(terminal ? {
      completedAtUtc: completedAt,
      githubReviewId: REVIEW_ID,
      githubReviewUrl: 'https://example.invalid/review/9001',
      githubReviewEvent: 'COMMENT',
      githubReviewReconciliation: {
        event: 'COMMENT',
        phase: 'complete',
        actorLogin: options.actorLogin ?? 'review-bot',
        commentBody: body,
        commentReviewId: REVIEW_ID,
        commentReviewUrl: 'https://example.invalid/review/9001',
        pendingDismissalReviewIds: [],
        dismissedReviewIds: [],
        preparedAtUtc: journalAt,
        updatedAtUtc: deliveredAt,
      },
    } : {}),
  };
  const runsDir = join(reviewStore, 'runs');
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, `${RUN_ID}.json`), `${JSON.stringify(record)}\n`, 'utf8');

  const liveFixture = join(stateRoot, 'live-review.json');
  writeFileSync(liveFixture, `${JSON.stringify({
    id: REVIEW_ID,
    currentHeadSha: options.currentHeadSha ?? HEAD,
    commitId: options.reviewHeadSha ?? HEAD,
    state: options.reviewState ?? 'COMMENTED',
    body,
    submittedAt: deliveredAt,
    authorLogin: options.actorLogin ?? 'review-bot',
  })}\n`, 'utf8');

  process.env.PACK_REVIEW_RUN_STORE_ROOT = reviewStore;
  process.env.OPK_OPERATOR_MERGE_GITHUB_REVIEW_FIXTURE = liveFixture;
  process.env.OPERATOR_MERGE_APPROVAL_STORE_ROOT = approvalRoot;
  setOperatorEnvironment();
  return { stateRoot, approvalRoot, body };
}

function policyInput(stateRoot: string): Record<string, unknown> {
  return {
    directOperatorMerge: true,
    stateRoot,
    projectId: 'orchestrator-pack',
    repoSlug: REPO,
    prNumber: 933,
    headSha: HEAD,
  };
}

function commandTransport(): {
  transport: OperatorMergeApprovalGithubTransport;
  statuses: OperatorMergeApprovalStatusRequest[];
  comments: string[];
} {
  const statuses: OperatorMergeApprovalStatusRequest[] = [];
  const comments: string[] = [];
  let latest: OperatorMergeApprovalStatusRequest | null = null;
  return {
    statuses,
    comments,
    transport: {
      async postStatus(request) {
        statuses.push(request);
        latest = request;
      },
      async postComment(request) {
        comments.push(request.body);
      },
      async readLatestStatus() {
        return latest ? {
          state: latest.state,
          context: 'orchestrator-pack/pack-review',
          description: latest.description,
        } : null;
      },
      async waitForStatusVisibility() {},
    },
  };
}

function approveArgs(storeRoot: string): string[] {
  return [
    'approve',
    '--pr-number', '933',
    '--head-sha', HEAD,
    '--repo-slug', REPO,
    '--reason', 'Explicit operator direct-merge command',
    '--store-root', storeRoot,
  ];
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('exact GitHub review inventory authority', () => {
  it('routes only one exact pull-review identity through REST inventory', () => {
    const exact = classifyArgv(['api', 'repos/o/r/pulls/42/reviews/9001']);
    expect(exact.route).toMatchObject({
      id: 'api-pull-review',
      repoSlug: 'o/r',
      prNumber: 42,
      reviewId: '9001',
    });
    expect(classifyArgv(['api', 'repos/o/r/pulls/42/reviews']).route).toBeNull();
    expect(classifyArgv(['api', 'repos/o/r/pulls/42/reviews/9001?x=1']).route).toBeNull();
  });

  it('executes the exact review route without GraphQL or list access', () => {
    const root = tempRoot('opk-review-route-');
    const fakeGh = join(root, 'gh');
    const audit = join(root, 'audit.log');
    writeFileSync(fakeGh, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >>${JSON.stringify(audit)}\nif [[ "$*" == *graphql* ]]; then exit 91; fi\necho '{"id":9001,"commit_id":"${HEAD}","state":"COMMENTED","body":"body","submitted_at":"2026-07-21T01:01:00.000Z","user":{"login":"review-bot"}}'\n`, { mode: 0o755 });
    chmodSync(fakeGh, 0o755);
    const argv = ['api', 'repos/o/r/pulls/42/reviews/9001'];
    const parsed = parseGhArgv(argv);
    const result = executeRestRoute('api-pull-review', {
      realGh: fakeGh,
      parsed,
      route: { id: 'api-pull-review', repoSlug: 'o/r', prNumber: 42, reviewId: '9001' },
      cwd: root,
    });
    expect(result).toEqual({
      id: '9001',
      commitId: HEAD,
      state: 'COMMENTED',
      body: 'body',
      submittedAt: '2026-07-21T01:01:00.000Z',
      authorLogin: 'review-bot',
    });
    expect(readFileSync(audit, 'utf8')).toContain('api repos/o/r/pulls/42/reviews/9001');
  });
});

describe.skip('shared direct-operator review authority', () => {
  it('accepts canonical clean warning evidence and the approval-specific store root', () => {
    const fixture = seedReview({ verdict: 'clean', severity: 'warning' });
    const approval = approveOperatorMerge({
      storeRoot: fixture.approvalRoot,
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD,
      reason: 'approve warning-only clean review',
      actor: 'operator-test',
    });
    expect(evaluateDirectOperatorReviewSafety(policyInput(fixture.stateRoot))).toMatchObject({
      allow: true,
      reason: 'operator_merge_review_safe',
      cleanWarningReview: true,
      githubReviewId: REVIEW_ID,
    });
    expect(evaluateMergePolicy(policyInput(fixture.stateRoot))).toMatchObject({
      allow: true,
      reason: 'operator_merge_approved',
      approvalId: approval.approvalId,
    });
  });

  it.each([
    ['current PR head', { currentHeadSha: OTHER_HEAD }, 'github_review_live_pr_head_mismatch'],
    ['review commit', { reviewHeadSha: OTHER_HEAD }, 'github_review_live_head_mismatch'],
    ['review state', { reviewState: 'PENDING' }, 'github_review_live_state_mismatch'],
    ['review actor', { actorLogin: 'different-reviewer' }, 'github_review_live_actor_mismatch'],
  ])('fails closed on live %s mismatch', (_label, options, expectedReason) => {
    const fixture = seedReview(options as ReviewFixtureOptions);
    if (expectedReason === 'github_review_live_actor_mismatch') {
      const livePath = process.env.OPK_OPERATOR_MERGE_GITHUB_REVIEW_FIXTURE!;
      const live = JSON.parse(readFileSync(livePath, 'utf8'));
      live.authorLogin = 'other-live-actor';
      writeFileSync(livePath, JSON.stringify(live), 'utf8');
    }
    expect(evaluateDirectOperatorReviewSafety(policyInput(fixture.stateRoot))).toMatchObject({
      allow: false,
      reason: 'operator_merge_github_review_unavailable',
      reviewReason: expectedReason,
    });
  });

  it('denies approve before every effect when terminal evidence is missing or mid-flight', async () => {
    for (const terminal of [undefined, false] as const) {
      const fixture = terminal === undefined
        ? (() => {
            const stateRoot = tempRoot();
            const reviewStore = tempRoot();
            const approvalRoot = join(stateRoot, 'approval-root');
            mkdirSync(join(reviewStore, 'runs'), { recursive: true });
            process.env.PACK_REVIEW_RUN_STORE_ROOT = reviewStore;
            process.env.OPERATOR_MERGE_APPROVAL_STORE_ROOT = approvalRoot;
            setOperatorEnvironment();
            return { stateRoot, approvalRoot };
          })()
        : seedReview({ terminal });
      const capture = commandTransport();
      await expect(runOperatorMergeApprovalCommand(approveArgs(fixture.approvalRoot), {
        transport: capture.transport,
      })).rejects.toThrow(/preflight denied/);
      expect(capture.statuses).toHaveLength(0);
      expect(capture.comments).toHaveLength(0);
      expect(existsSync(join(fixture.approvalRoot, 'pr-933.json'))).toBe(false);
    }
  });

  it('denies BLOCK and pending adjudication before approval success', async () => {
    const blocked = seedReview({ severity: 'blocking', body: reviewBody('CI will fail on the documented path.') });
    const blockedCapture = commandTransport();
    await expect(runOperatorMergeApprovalCommand(approveArgs(blocked.approvalRoot), {
      transport: blockedCapture.transport,
    })).rejects.toThrow(/operator_merge_block_findings/);
    expect(blockedCapture.statuses).toHaveLength(0);
    expect(blockedCapture.comments).toHaveLength(0);

    process.env = { ...originalEnv };
    const pending = seedReview();
    const inbox = join(pending.stateRoot, 'merge-triage', 'architect-inbox.jsonl');
    mkdirSync(dirname(inbox), { recursive: true });
    writeFileSync(inbox, `${JSON.stringify({
      adjudication_id: 'pending-933',
      status: 'pending',
      pr_number: 933,
      head_sha: HEAD,
    })}\n`, 'utf8');
    const pendingCapture = commandTransport();
    await expect(runOperatorMergeApprovalCommand(approveArgs(pending.approvalRoot), {
      transport: pendingCapture.transport,
    })).rejects.toThrow(/operator_merge_pending_adjudication/);
    expect(pendingCapture.statuses).toHaveLength(0);
    expect(pendingCapture.comments).toHaveLength(0);
  });

  it('runs the shared preflight before comment and immediately before success', async () => {
    const fixture = seedReview();
    const capture = commandTransport();
    const livePath = process.env.OPK_OPERATOR_MERGE_GITHUB_REVIEW_FIXTURE!;
    let commentCalls = 0;
    const transport: OperatorMergeApprovalGithubTransport = {
      ...capture.transport,
      async postComment(request) {
        commentCalls += 1;
        capture.comments.push(request.body);
        const live = JSON.parse(readFileSync(livePath, 'utf8'));
        live.currentHeadSha = OTHER_HEAD;
        writeFileSync(livePath, JSON.stringify(live), 'utf8');
      },
    };
    await expect(runOperatorMergeApprovalCommand(approveArgs(fixture.approvalRoot), { transport }))
      .rejects.toThrow(/approval publication failed/);
    expect(commentCalls).toBe(1);
    expect(capture.statuses.some((status) => status.state === 'success')).toBe(false);
  });
});
