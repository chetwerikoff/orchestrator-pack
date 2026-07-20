import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFindingText,
  computeOpenFindingsSnapshotHash,
  evaluateMergePolicy,
  loadMarkerList,
  normalizeTriageText,
  sha256,
} from '../docs/merge-triage-gate.mjs';
import { runProcess } from './kernel/subprocess.ts';
import { classifyArgv } from './lib/gh-inventory-match.mjs';
import {
  approveOperatorMerge,
  operatorMergeApprovalRecordPath,
  parseOperatorMergeApprovalRecord,
  readOperatorMergeApproval,
  revokeOperatorMerge,
} from './lib/operator-merge-approval.ts';
import {
  assertOperatorMergeApprovalSession,
  runOperatorMergeApprovalCommand,
  type OperatorMergeApprovalGithubTransport,
  type OperatorMergeApprovalStatusSnapshot,
  type OperatorMergeApprovalStatusRequest,
  type RunOperatorMergeApprovalCommandOptions,
} from './operator-merge-approval.ts';

const roots: string[] = [];
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const REPO = 'chetwerikoff/orchestrator-pack';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repoRoot, 'scripts', 'operator-merge-approval.ts');
const originalEnv = { ...process.env };

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-operator-merge-approval-'));
  roots.push(root);
  return root;
}

function policyStoreRoot(stateRoot: string): string {
  return join(stateRoot, 'operator-merge-approvals', 'orchestrator-pack');
}

function setOperatorProcessEnvironment(): void {
  delete process.env.AO_SESSION_ID;
  process.env.AO_SESSION_KIND = 'operator';
}

function approvalArgs(storeRoot: string): string[] {
  return [
    'approve',
    '--pr-number', '933',
    '--head-sha', HEAD_A,
    '--repo-slug', REPO,
    '--reason', 'Explicit operator direct-merge command',
    '--store-root', storeRoot,
  ];
}

function revokeArgs(storeRoot: string): string[] {
  return [
    'revoke',
    '--pr-number', '933',
    '--head-sha', HEAD_A,
    '--repo-slug', REPO,
    '--reason', 'Operator revoked approval',
    '--store-root', storeRoot,
  ];
}

function captureTransport(options: {
  initialRemoteState?: 'success' | 'failure';
  failComment?: boolean;
  ambiguousSuccess?: 'applied' | 'late';
  failFirstFailureWrite?: boolean;
} = {}): {
  transport: OperatorMergeApprovalGithubTransport;
  statuses: OperatorMergeApprovalStatusRequest[];
  comments: string[];
  statusReads: OperatorMergeApprovalStatusSnapshot[];
  remoteStatus: () => OperatorMergeApprovalStatusSnapshot | null;
} {
  const statuses: OperatorMergeApprovalStatusRequest[] = [];
  const comments: string[] = [];
  const statusReads: OperatorMergeApprovalStatusSnapshot[] = [];
  let failedFailureWrites = 0;
  let lateSuccessPending = false;
  let remoteStatus: OperatorMergeApprovalStatusSnapshot | null = options.initialRemoteState
    ? {
        state: options.initialRemoteState,
        context: 'orchestrator-pack/pack-review',
        description: 'pre-existing pack review status',
      }
    : null;

  return {
    statuses,
    comments,
    statusReads,
    remoteStatus: () => remoteStatus,
    transport: {
      async postComment(request) {
        comments.push(request.body);
        if (options.failComment) throw new Error('injected comment failure');
      },
      async postStatus(request) {
        statuses.push(request);
        if (request.state === 'failure' && options.failFirstFailureWrite && failedFailureWrites === 0) {
          failedFailureWrites += 1;
          throw new Error('injected compensating failure write rejection');
        }
        if (request.state === 'success' && options.ambiguousSuccess === 'late') {
          lateSuccessPending = true;
          throw new Error('injected timeout before delayed GitHub success became visible');
        }
        remoteStatus = {
          state: request.state,
          context: 'orchestrator-pack/pack-review',
          description: request.description,
        };
        if (request.state === 'success' && options.ambiguousSuccess === 'applied') {
          throw new Error('injected timeout after GitHub accepted success');
        }
      },
      async readLatestStatus(): Promise<OperatorMergeApprovalStatusSnapshot | null> {
        if (lateSuccessPending) {
          lateSuccessPending = false;
          remoteStatus = {
            state: 'success',
            context: 'orchestrator-pack/pack-review',
            description: 'late success from ambiguous approval publication',
          };
        }
        if (remoteStatus) statusReads.push({ ...remoteStatus });
        return remoteStatus ? { ...remoteStatus } : null;
      },
      async waitForStatusVisibility() {},
    },
  };
}

function basePolicyInput(stateRoot: string) {
  return {
    stateRoot,
    projectId: 'orchestrator-pack',
    repoSlug: REPO,
    prNumber: 933,
    headSha: HEAD_A,
    directOperatorMerge: true,
  };
}

function packReviewStoreRoot(): string {
  const root = tempRoot();
  process.env.PACK_REVIEW_RUN_STORE_ROOT = root;
  mkdirSync(join(root, 'runs'), { recursive: true });
  return root;
}

function writePackReviewRecord(
  findings: unknown[],
  options: { terminal?: boolean; status?: 'up_to_date' | 'commented' | 'changes_requested' } = {},
): Record<string, unknown> {
  const root = packReviewStoreRoot();
  const terminal = options.terminal !== false;
  const status = options.status ?? (findings.length === 0 ? 'up_to_date' : 'commented');
  const reviewVerdict = findings.length === 0 ? 'clean' : 'findings';
  const runId = 'prr-operator-approval-fixture';
  const journalAt = '2026-07-20T12:10:00.000Z';
  const deliveredAt = '2026-07-20T12:11:00.000Z';
  const completedAt = '2026-07-20T12:12:00.000Z';
  const record: Record<string, unknown> = {
    schemaVersion: 1,
    id: runId,
    runId,
    projectId: 'orchestrator-pack',
    key: `pr-933-${HEAD_A}`,
    prNumber: 933,
    targetSha: HEAD_A,
    headSha: HEAD_A,
    status: terminal ? status : 'reviewing',
    latestRunStatus: terminal ? status : 'reviewing',
    linkedSessionId: 'session-933',
    startReason: 'test',
    surface: 'pack-review-runner',
    trustedPackRoot: repoRoot,
    sourceRepoRoot: repoRoot,
    runnerPid: process.pid,
    createdAt: journalAt,
    updatedAt: terminal ? completedAt : journalAt,
    heartbeatAtUtc: journalAt,
    reviewVerdict,
    findingCount: findings.length,
    findings,
    journalOutcome: {
      state: 'persisted',
      recordedAtUtc: journalAt,
      reason: 'verdict_persisted',
      idempotencyKey: `verdict:${runId}:${HEAD_A}`,
      attempts: 1,
    },
    deliveryOutcomes: terminal
      ? {
          githubComment: {
            state: 'succeeded',
            recordedAtUtc: deliveredAt,
            reason: 'comment_posted',
            idempotencyKey: `github-comment:${runId}:${HEAD_A}`,
          },
          requiredStatus: {
            state: 'succeeded',
            recordedAtUtc: deliveredAt,
            reason: status === 'changes_requested' ? 'status_failure' : 'status_success',
            idempotencyKey: `required-status:orchestrator-pack/pack-review:${HEAD_A}`,
          },
        }
      : {},
    ...(terminal
      ? {
          completedAtUtc: completedAt,
          githubReviewId: 'review-933',
          githubReviewUrl: 'https://example.invalid/review-933',
          githubReviewEvent: 'COMMENT',
          githubReviewReconciliation: {
            event: 'COMMENT',
            phase: 'complete',
            actorLogin: 'reviewer',
            commentBody: 'review',
            commentReviewId: 'review-933',
            commentReviewUrl: 'https://example.invalid/review-933',
            pendingDismissalReviewIds: [],
            dismissedReviewIds: [],
            preparedAtUtc: journalAt,
            updatedAtUtc: deliveredAt,
          },
        }
      : {}),
  };
  writeFileSync(join(root, 'runs', `${runId}.json`), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

function deferFinding(): Record<string, unknown> {
  return {
    id: 'defer-1',
    fingerprint: 'defer-1',
    status: 'open',
    headSha: HEAD_A,
    title: 'TOCTOU under concurrent head movement',
    body: 'When the head moves between validation and merge, exact-head revalidation is required.',
  };
}

function blockFinding(): Record<string, unknown> {
  return {
    id: 'block-1',
    fingerprint: 'block-1',
    status: 'open',
    headSha: HEAD_A,
    title: 'Parser error makes this exact head unsafe to merge',
    body: 'The documented path cannot start.',
  };
}

function writePendingAdjudication(stateRoot: string): void {
  const path = join(stateRoot, 'merge-triage', 'architect-inbox.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    schema_version: 1,
    adjudication_id: 'adj-pending-933',
    status: 'pending',
    pr_number: 933,
    head_sha: HEAD_A,
    finding_id: 'pending-1',
    fingerprint: 'pending-1',
  })}\n`, 'utf8');
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('operator merge approval store', () => {
  it('binds approval to one repository, PR, and exact head without inheriting across commits', () => {
    const storeRoot = tempRoot();
    const record = approveOperatorMerge({
      storeRoot,
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'Explicit operator direct-merge command',
      actor: 'operator-test',
      now: new Date('2026-07-20T12:00:00.000Z'),
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      event: 'operator_merge_approved',
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      actor: 'operator-test',
      createdAtUtc: '2026-07-20T12:00:00.000Z',
    });
    expect(readOperatorMergeApproval({
      storeRoot,
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
    })).toMatchObject({
      approved: true,
      reason: 'approved',
      record: { approvalId: record.approvalId },
    });
    expect(readOperatorMergeApproval({ storeRoot, prNumber: 933, headSha: HEAD_B })).toMatchObject({
      approved: false,
      reason: 'head_mismatch',
      record: { approvalId: record.approvalId, headSha: HEAD_A },
    });
    expect(readOperatorMergeApproval({
      storeRoot,
      repoSlug: 'other/repository',
      prNumber: 933,
      headSha: HEAD_A,
    })).toEqual({ approved: false, reason: 'malformed' });
    expect(readdirSync(storeRoot)).toEqual(['pr-933.json']);
  });

  it('revokes an exact-head approval and keeps it inactive on later reads', () => {
    const storeRoot = tempRoot();
    approveOperatorMerge({
      storeRoot,
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'approve',
      actor: 'operator-test',
    });

    expect(revokeOperatorMerge({
      storeRoot,
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'revalidation failed',
      now: new Date('2026-07-20T12:05:00.000Z'),
    })).toMatchObject({
      approved: false,
      reason: 'revoked',
      record: {
        revokedAtUtc: '2026-07-20T12:05:00.000Z',
        revocationReason: 'revalidation failed',
      },
    });
    expect(readOperatorMergeApproval({ storeRoot, prNumber: 933, headSha: HEAD_A })).toMatchObject({
      approved: false,
      reason: 'revoked',
    });
  });

  it('fails closed on malformed and one-sided revocation metadata in both readers', () => {
    const stateRoot = tempRoot();
    const storeRoot = policyStoreRoot(stateRoot);
    const record = approveOperatorMerge({
      storeRoot,
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'approve',
      actor: 'operator-test',
    });
    const path = operatorMergeApprovalRecordPath(933, { storeRoot });
    setOperatorProcessEnvironment();

    for (const malformed of [
      { ...record, revokedAtUtc: '2026-07-20T12:05:00.000Z' },
      { ...record, revocationReason: 'reason without timestamp' },
    ]) {
      writeFileSync(path, `${JSON.stringify(malformed, null, 2)}\n`, 'utf8');
      expect(() => parseOperatorMergeApprovalRecord(malformed)).toThrow(/both present or both absent/);
      expect(readOperatorMergeApproval({ storeRoot, prNumber: 933, headSha: HEAD_A })).toEqual({
        approved: false,
        reason: 'malformed',
      });
      expect(evaluateMergePolicy({ ...basePolicyInput(stateRoot), findings: [] })).toMatchObject({
        allow: false,
        reason: 'operator_merge_approval_unavailable',
        approvalReason: 'approval_malformed',
      });
    }
  });

  it('rejects non-canonical timestamps in both approval readers', () => {
    const stateRoot = tempRoot();
    const storeRoot = policyStoreRoot(stateRoot);
    const record = approveOperatorMerge({
      storeRoot,
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'approve',
      actor: 'operator-test',
      now: new Date('2026-07-20T12:00:00.000Z'),
    });
    const path = operatorMergeApprovalRecordPath(933, { storeRoot });
    setOperatorProcessEnvironment();

    for (const malformed of [
      { ...record, createdAtUtc: '0' },
      { ...record, createdAtUtc: '2026-7-2' },
      { ...record, createdAtUtc: '2026-07-20T12:00:00Z' },
      {
        ...record,
        revokedAtUtc: '2026-07-20T12:05:00Z',
        revocationReason: 'non-canonical revocation timestamp',
      },
    ]) {
      writeFileSync(path, `${JSON.stringify(malformed, null, 2)}\n`, 'utf8');
      expect(() => parseOperatorMergeApprovalRecord(malformed)).toThrow(/canonical UTC ISO timestamp/);
      expect(readOperatorMergeApproval({ storeRoot, prNumber: 933, headSha: HEAD_A })).toEqual({
        approved: false,
        reason: 'malformed',
      });
      expect(evaluateMergePolicy({ ...basePolicyInput(stateRoot), findings: [] })).toMatchObject({
        allow: false,
        reason: 'operator_merge_approval_unavailable',
        approvalReason: 'approval_malformed',
      });
    }
  });

  it('fails closed on a structurally incomplete record', () => {
    const storeRoot = tempRoot();
    const path = operatorMergeApprovalRecordPath(933, { storeRoot });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"schemaVersion":1,"event":"operator_merge_approved"}\n', 'utf8');
    expect(readOperatorMergeApproval({ storeRoot, prNumber: 933, headSha: HEAD_A })).toEqual({
      approved: false,
      reason: 'malformed',
    });
  });

  it('rejects partial SHAs and invalid PR identifiers before writing', () => {
    const storeRoot = tempRoot();
    expect(() => approveOperatorMerge({
      storeRoot,
      repoSlug: REPO,
      prNumber: 0,
      headSha: HEAD_A,
      reason: 'invalid',
    })).toThrow(/positive PR number/);
    expect(() => approveOperatorMerge({
      storeRoot,
      repoSlug: REPO,
      prNumber: 933,
      headSha: 'abc123',
      reason: 'invalid',
    })).toThrow(/full 40-hex head SHA/);
  });
});

describe('operator approval CLI authority and delivery', () => {
  it('keeps both status reconciliation reads on inventory-listed wrapper routes', () => {
    expect(classifyArgv([
      'pr', 'view', '933',
      '--repo', REPO,
      '--json', 'headRefOid,headRefName',
    ]).route?.id).toBe('pr-view');
    expect(classifyArgv([
      'pr', 'checks', '933',
      '--repo', REPO,
      '--json', 'name,state,bucket,link,startedAt,completedAt,workflow,description',
    ]).route?.id).toBe('pr-checks');
  });

  it('requires the real trusted operator environment even for read-only show', () => {
    delete process.env.AO_SESSION_ID;
    delete process.env.AO_SESSION_KIND;
    expect(() => assertOperatorMergeApprovalSession()).toThrow(/AO_SESSION_KIND=operator/);

    setOperatorProcessEnvironment();
    expect(() => assertOperatorMergeApprovalSession()).not.toThrow();

    process.env.AO_SESSION_ID = 'worker-session-933';
    expect(() => assertOperatorMergeApprovalSession()).toThrow(/forbidden inside an AO-managed session/);
  });

  it.each(['worker', 'coding'])('rejects an AO-managed %s CLI before writing state or invoking gh', async (kind) => {
    const storeRoot = tempRoot();
    const result = await runProcess({
      command: process.execPath,
      args: ['--experimental-strip-types', cliPath, ...approvalArgs(storeRoot)],
      cwd: repoRoot,
      inheritParentEnv: true,
      env: { AO_SESSION_ID: `${kind}-session-933`, AO_SESSION_KIND: kind },
      allowEmptyStdout: true,
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('forbidden inside an AO-managed session');
    expect(existsSync(join(storeRoot, 'pr-933.json'))).toBe(false);
  });

  it('does not let forged options.env bypass the real managed-session guard', async () => {
    const storeRoot = tempRoot();
    const capture = captureTransport();
    process.env.AO_SESSION_ID = 'worker-session-933';
    process.env.AO_SESSION_KIND = 'worker';
    const forgedOptions = {
      env: { AO_SESSION_KIND: 'operator' },
      transport: capture.transport,
    } as unknown as RunOperatorMergeApprovalCommandOptions;

    await expect(runOperatorMergeApprovalCommand(approvalArgs(storeRoot), forgedOptions))
      .rejects.toThrow(/forbidden inside an AO-managed session/);
    expect(existsSync(join(storeRoot, 'pr-933.json'))).toBe(false);
    expect(capture.comments).toHaveLength(0);
    expect(capture.statuses).toHaveLength(0);
  });

  it('publishes an audited success for a normal operator approval', async () => {
    const storeRoot = tempRoot();
    const capture = captureTransport();
    setOperatorProcessEnvironment();
    const result = await runOperatorMergeApprovalCommand(approvalArgs(storeRoot), {
      transport: capture.transport,
    });

    expect(result.approval).toMatchObject({ event: 'operator_merge_approved', headSha: HEAD_A });
    expect(capture.comments).toHaveLength(1);
    expect(capture.statuses.map((request) => request.state)).toEqual(['success']);
    expect(capture.remoteStatus()).toMatchObject({ state: 'success' });
  });

  it('overwrites a pre-existing remote success with its own verified failure', async () => {
    const storeRoot = tempRoot();
    const capture = captureTransport({ initialRemoteState: 'success', failComment: true });
    setOperatorProcessEnvironment();

    await expect(runOperatorMergeApprovalCommand(approvalArgs(storeRoot), {
      transport: capture.transport,
    })).rejects.toThrow(/approval publication failed/);

    const failure = capture.statuses.find((request) => request.state === 'failure');
    expect(failure?.description).toMatch(/\[opk-reconcile:[0-9a-f]{20}\]$/);
    expect(capture.statusReads).toHaveLength(2);
    expect(capture.statusReads.every((status) => status.description === failure?.description)).toBe(true);
    expect(capture.remoteStatus()).toMatchObject({ state: 'failure', description: failure?.description });
    expect(readOperatorMergeApproval({ storeRoot, prNumber: 933, headSha: HEAD_A })).toMatchObject({
      approved: false,
      reason: 'revoked',
    });
  });

  it('does not confirm compensation from a pre-existing failure when its first write is rejected', async () => {
    const storeRoot = tempRoot();
    const capture = captureTransport({
      initialRemoteState: 'failure',
      failComment: true,
      failFirstFailureWrite: true,
    });
    setOperatorProcessEnvironment();

    await expect(runOperatorMergeApprovalCommand(approvalArgs(storeRoot), {
      transport: capture.transport,
    })).rejects.toThrow(/approval publication failed/);

    const failures = capture.statuses.filter((request) => request.state === 'failure');
    expect(failures).toHaveLength(2);
    expect(capture.statusReads).toHaveLength(2);
    expect(capture.statusReads.every((status) => status.description === failures[1]?.description)).toBe(true);
    expect(capture.remoteStatus()).toMatchObject({
      state: 'failure',
      description: failures[1]?.description,
    });
  });

  it('reconciles an applied-but-client-failed success with its own blocking status', async () => {
    const storeRoot = tempRoot();
    const capture = captureTransport({ ambiguousSuccess: 'applied' });
    setOperatorProcessEnvironment();

    await expect(runOperatorMergeApprovalCommand(approvalArgs(storeRoot), {
      transport: capture.transport,
    })).rejects.toThrow(/timeout after GitHub accepted success/);

    expect(capture.statuses.map((request) => request.state)).toEqual(['success', 'failure']);
    const failure = capture.statuses[1];
    expect(capture.statusReads).toHaveLength(2);
    expect(capture.statusReads.every((status) => status.description === failure?.description)).toBe(true);
    expect(capture.remoteStatus()).toMatchObject({ state: 'failure', description: failure?.description });
  });

  it('retries after a delayed success supersedes the first compensating failure', async () => {
    const storeRoot = tempRoot();
    const capture = captureTransport({ ambiguousSuccess: 'late' });
    setOperatorProcessEnvironment();

    await expect(runOperatorMergeApprovalCommand(approvalArgs(storeRoot), {
      transport: capture.transport,
    })).rejects.toThrow(/delayed GitHub success/);

    expect(capture.statuses.map((request) => request.state)).toEqual(['success', 'failure', 'failure']);
    const lastFailure = capture.statuses[2];
    expect(capture.statusReads.at(-2)?.description).toBe(lastFailure?.description);
    expect(capture.statusReads.at(-1)?.description).toBe(lastFailure?.description);
    expect(capture.remoteStatus()).toMatchObject({ state: 'failure', description: lastFailure?.description });
  });

  it('repairs the remote status when revoke is retried for an already-revoked record', async () => {
    const storeRoot = tempRoot();
    approveOperatorMerge({
      storeRoot,
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'approve',
      actor: 'operator-test',
    });
    revokeOperatorMerge({
      storeRoot,
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'already revoked',
    });
    const capture = captureTransport({ initialRemoteState: 'success' });
    setOperatorProcessEnvironment();

    const result = await runOperatorMergeApprovalCommand(revokeArgs(storeRoot), {
      transport: capture.transport,
    });

    expect(result.approval).toMatchObject({ approved: false, reason: 'revoked' });
    expect(capture.statuses.map((request) => request.state)).toEqual(['failure']);
    expect(capture.statusReads).toHaveLength(2);
    expect(capture.remoteStatus()).toMatchObject({ state: 'failure' });
    expect(capture.comments).toHaveLength(0);
  });
});

describe('direct operator merge policy', () => {
  function approve(stateRoot: string): ReturnType<typeof approveOperatorMerge> {
    return approveOperatorMerge({
      storeRoot: policyStoreRoot(stateRoot),
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'Explicit operator direct-merge command',
      actor: 'operator-test',
    });
  }

  it('allows an active exact-head approval only with terminal delivered review evidence', () => {
    const stateRoot = tempRoot();
    const record = approve(stateRoot);
    writePackReviewRecord([deferFinding()]);
    setOperatorProcessEnvironment();

    expect(evaluateMergePolicy(basePolicyInput(stateRoot))).toMatchObject({
      allow: true,
      reason: 'operator_merge_approved',
      approvalId: record.approvalId,
      approvedHeadSha: HEAD_A,
      reviewRunId: 'prr-operator-approval-fixture',
    });
  });

  it('rejects a matching mid-flight journal row before GitHub review and status delivery complete', () => {
    const stateRoot = tempRoot();
    approve(stateRoot);
    writePackReviewRecord([deferFinding()], { terminal: false });
    setOperatorProcessEnvironment();

    expect(evaluateMergePolicy(basePolicyInput(stateRoot))).toMatchObject({
      allow: false,
      reason: 'operator_merge_review_findings_unavailable',
      reviewReason: 'pack_review_terminal_evidence_missing',
      evidenceReasons: expect.arrayContaining(['run_not_terminal']),
    });
  });

  it('keeps an active approval blocked by a terminal current-head BLOCK finding', () => {
    const stateRoot = tempRoot();
    approve(stateRoot);
    writePackReviewRecord([blockFinding()], { status: 'changes_requested' });
    setOperatorProcessEnvironment();

    expect(evaluateMergePolicy(basePolicyInput(stateRoot))).toMatchObject({
      allow: false,
      reason: 'operator_merge_block_findings',
      reviewRunId: 'prr-operator-approval-fixture',
      classifications: [{ verdict: 'BLOCK', findingId: 'block-1' }],
    });
  });

  it('keeps an active approval blocked by pending adjudication', () => {
    const stateRoot = tempRoot();
    approve(stateRoot);
    writePackReviewRecord([deferFinding()]);
    writePendingAdjudication(stateRoot);
    setOperatorProcessEnvironment();

    expect(evaluateMergePolicy(basePolicyInput(stateRoot))).toMatchObject({
      allow: false,
      reason: 'operator_merge_pending_adjudication',
      pending: [{ adjudication_id: 'adj-pending-933', status: 'pending' }],
    });
  });

  it('honors canonical resolved clearance instead of reclassifying the original BLOCK text', () => {
    const stateRoot = tempRoot();
    const record = approve(stateRoot);
    const findings = [blockFinding()];
    writePackReviewRecord(findings, { status: 'changes_requested' });
    const markerList = loadMarkerList();
    const normalizedTextHash = sha256(normalizeTriageText(buildFindingText(findings[0])));
    const token = 'resolved-token-933';
    const triageRoot = join(stateRoot, 'merge-triage');
    const clearanceDir = join(triageRoot, 'clearance');
    mkdirSync(clearanceDir, { recursive: true });
    writeFileSync(join(clearanceDir, `pr-933-${HEAD_A}.json`), `${JSON.stringify({
      schema_version: 1,
      terminal: 'merge_triage_cleared',
      pr_number: 933,
      head_sha: HEAD_A,
      gate_run_id: 'resolved-gate-933',
      marker_list_version: markerList.schemaVersion,
      marker_list_hash: markerList.markerListHash,
      open_findings_snapshot_hash: computeOpenFindingsSnapshotHash(findings),
    })}\n`, 'utf8');
    writeFileSync(join(triageRoot, 'verdict-journal.jsonl'), `${JSON.stringify({
      schema_version: 1,
      event: 'merge_triage_verdict',
      gate_run_id: 'resolved-gate-933',
      finding_id: 'block-1',
      fingerprint: 'block-1',
      pr_number: 933,
      head_sha: HEAD_A,
      verdict: 'DEFER',
      actor: 'architect',
      actor_session: 'architect-session-933',
      reason: 'architect_adjudication',
      adjudication_provenance_token_hash: sha256(token),
      normalized_text_hash: normalizedTextHash,
    })}\n`, 'utf8');
    writeFileSync(join(triageRoot, 'architect-tokens.json'), `${JSON.stringify({
      'adj-resolved-933': {
        tokenHash: sha256(token),
        normalizedTextHash,
      },
    })}\n`, 'utf8');
    setOperatorProcessEnvironment();

    expect(evaluateMergePolicy(basePolicyInput(stateRoot))).toMatchObject({
      allow: true,
      reason: 'operator_merge_approved',
      approvalId: record.approvalId,
      canonicalPolicyReason: 'merge_triage_cleared',
    });
  });

  it('denies caller-supplied operator sessionKind when trusted environment is absent', () => {
    const stateRoot = tempRoot();
    approve(stateRoot);
    delete process.env.AO_SESSION_KIND;
    delete process.env.AO_SESSION_ID;

    expect(evaluateMergePolicy({
      ...basePolicyInput(stateRoot),
      sessionKind: 'operator',
    })).toMatchObject({
      allow: false,
      reason: 'operator_merge_approval_unavailable',
      approvalReason: 'operator_session_kind_missing',
    });
  });

  it('denies missing, mismatched, and AO-managed consumption', () => {
    const stateRoot = tempRoot();
    approve(stateRoot);
    setOperatorProcessEnvironment();

    expect(evaluateMergePolicy({ ...basePolicyInput(stateRoot), headSha: HEAD_B })).toMatchObject({
      allow: false,
      approvalReason: 'approval_head_mismatch',
    });
    expect(evaluateMergePolicy({ ...basePolicyInput(stateRoot), repoSlug: 'other/repository' })).toMatchObject({
      allow: false,
      approvalReason: 'approval_repository_mismatch',
    });
    expect(evaluateMergePolicy({ ...basePolicyInput(stateRoot), prNumber: 934 })).toMatchObject({
      allow: false,
      approvalReason: 'approval_missing',
    });

    process.env.AO_SESSION_ID = 'worker-session-933';
    expect(evaluateMergePolicy({ ...basePolicyInput(stateRoot), sessionKind: 'operator' })).toMatchObject({
      allow: false,
      approvalReason: 'ao_managed_session_forbidden',
    });
  });

  it('denies a revoked exact-head approval', () => {
    const stateRoot = tempRoot();
    const storeRoot = policyStoreRoot(stateRoot);
    approve(stateRoot);
    revokeOperatorMerge({
      storeRoot,
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'revoked',
    });
    setOperatorProcessEnvironment();

    expect(evaluateMergePolicy(basePolicyInput(stateRoot))).toMatchObject({
      allow: false,
      reason: 'operator_merge_approval_unavailable',
      approvalReason: 'approval_revoked',
    });
  });
});
