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
import { evaluateMergePolicy } from '../docs/merge-triage-gate.mjs';
import { runProcess } from './kernel/subprocess.ts';
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
  ambiguousSuccess?: boolean;
  delayedSuccessAfterFirstFailureRead?: boolean;
} = {}): {
  transport: OperatorMergeApprovalGithubTransport;
  statuses: OperatorMergeApprovalStatusRequest[];
  comments: string[];
  remoteState: () => 'success' | 'failure' | undefined;
  latestReads: () => number;
} {
  const statuses: OperatorMergeApprovalStatusRequest[] = [];
  const comments: string[] = [];
  let remoteState = options.initialRemoteState;
  let pendingLateSuccess = false;
  let latestReads = 0;
  return {
    statuses,
    comments,
    remoteState: () => remoteState,
    latestReads: () => latestReads,
    transport: {
      async postComment(request) {
        comments.push(request.body);
        if (options.failComment) throw new Error('injected comment failure');
      },
      async postStatus(request) {
        statuses.push(request);
        if (request.state === 'success' && options.ambiguousSuccess) {
          if (options.delayedSuccessAfterFirstFailureRead) {
            pendingLateSuccess = true;
          } else {
            remoteState = 'success';
          }
          throw new Error('injected timeout after GitHub accepted success');
        }
        remoteState = request.state;
      },
      async getLatestStatus() {
        latestReads += 1;
        if (pendingLateSuccess && latestReads === 2) {
          remoteState = 'success';
          pendingLateSuccess = false;
        }
        return remoteState
          ? { state: remoteState, context: 'orchestrator-pack/pack-review' }
          : null;
      },
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

function seedPackReview(findings: unknown[], reviewVerdict: 'clean' | 'findings' = 'findings'): string {
  const storeRoot = tempRoot();
  process.env.PACK_REVIEW_RUN_STORE_ROOT = storeRoot;
  const runsDir = join(storeRoot, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const now = '2026-07-20T12:10:00.000Z';
  const record = {
    schemaVersion: 1,
    id: 'prr-operator-approval-fixture',
    runId: 'prr-operator-approval-fixture',
    projectId: 'orchestrator-pack',
    key: `pr-933-${HEAD_A}`,
    prNumber: 933,
    targetSha: HEAD_A,
    headSha: HEAD_A,
    status: reviewVerdict === 'clean' ? 'up_to_date' : 'changes_requested',
    latestRunStatus: reviewVerdict === 'clean' ? 'up_to_date' : 'changes_requested',
    createdAt: now,
    updatedAt: now,
    completedAtUtc: now,
    reviewVerdict,
    findingCount: findings.length,
    findings,
    journalOutcome: { state: 'persisted' },
  };
  writeFileSync(join(runsDir, `${record.id}.json`), `${JSON.stringify(record)}\n`, 'utf8');
  return storeRoot;
}

function seedDeferredPackReview(): void {
  seedPackReview([{
    id: 'finding-defer-1',
    fingerprint: 'finding-defer-1',
    title: 'TOCTOU under concurrent head movement',
    body: 'When the head moves between validation and merge, revalidation is required.',
  }]);
}

function seedPendingInbox(stateRoot: string): void {
  const inboxPath = join(stateRoot, 'merge-triage', 'architect-inbox.jsonl');
  mkdirSync(dirname(inboxPath), { recursive: true });
  writeFileSync(inboxPath, `${JSON.stringify({
    schema_version: 1,
    adjudication_id: 'adj-pending-933',
    status: 'pending',
    pr_number: 933,
    head_sha: HEAD_A,
    finding_id: 'finding-pending-1',
    fingerprint: 'finding-pending-1',
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
      expect(evaluateMergePolicy(basePolicyInput(stateRoot))).toMatchObject({
        allow: false,
        reason: 'operator_merge_approval_unavailable',
        approvalReason: 'approval_malformed',
      });
    }
  });

  it.each(['0', '1', '2026-7-2', '2026-02-30T12:00:00.000Z'])(
    'rejects non-canonical createdAtUtc %s in both readers',
    (createdAtUtc) => {
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
      const malformed = { ...record, createdAtUtc };
      const path = operatorMergeApprovalRecordPath(933, { storeRoot });
      writeFileSync(path, `${JSON.stringify(malformed, null, 2)}\n`, 'utf8');
      setOperatorProcessEnvironment();

      expect(() => parseOperatorMergeApprovalRecord(malformed)).toThrow(/canonical UTC ISO timestamp/);
      expect(readOperatorMergeApproval({ storeRoot, prNumber: 933, headSha: HEAD_A })).toEqual({
        approved: false,
        reason: 'malformed',
      });
      expect(evaluateMergePolicy(basePolicyInput(stateRoot))).toMatchObject({
        allow: false,
        approvalReason: 'approval_malformed',
      });
    },
  );

  it('rejects a non-canonical revokedAtUtc in both readers', () => {
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
    const malformed = { ...record, revokedAtUtc: '1', revocationReason: 'revoked' };
    const path = operatorMergeApprovalRecordPath(933, { storeRoot });
    writeFileSync(path, `${JSON.stringify(malformed, null, 2)}\n`, 'utf8');
    setOperatorProcessEnvironment();

    expect(() => parseOperatorMergeApprovalRecord(malformed)).toThrow(/canonical UTC ISO timestamp/);
    expect(evaluateMergePolicy(basePolicyInput(stateRoot))).toMatchObject({
      allow: false,
      approvalReason: 'approval_malformed',
    });
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
  it('requires the real trusted operator process environment even for read-only show', () => {
    delete process.env.AO_SESSION_ID;
    delete process.env.AO_SESSION_KIND;
    expect(() => assertOperatorMergeApprovalSession()).toThrow(/AO_SESSION_KIND=operator/);
    setOperatorProcessEnvironment();
    expect(() => assertOperatorMergeApprovalSession()).not.toThrow();
  });

  it.each(['worker', 'coding'])('rejects an AO-managed %s CLI before writing state or invoking gh', async (kind) => {
    const storeRoot = tempRoot();
    const result = await runProcess({
      command: process.execPath,
      args: [
        '--experimental-strip-types',
        cliPath,
        ...approvalArgs(storeRoot),
      ],
      cwd: repoRoot,
      inheritParentEnv: true,
      env: {
        AO_SESSION_ID: `${kind}-session-933`,
        AO_SESSION_KIND: kind,
      },
      allowEmptyStdout: true,
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('forbidden inside an AO-managed session');
    expect(existsSync(join(storeRoot, 'pr-933.json'))).toBe(false);
  });

  it('ignores a forged injectable env and denies the real managed process before effects', async () => {
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
    expect(capture.statuses).toHaveLength(0);
    expect(capture.comments).toHaveLength(0);
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
    expect(capture.remoteState()).toBe('success');
  });

  it('overwrites a pre-existing remote success with verified failure when repeat publication fails', async () => {
    const storeRoot = tempRoot();
    const capture = captureTransport({ initialRemoteState: 'success', failComment: true });
    setOperatorProcessEnvironment();

    await expect(runOperatorMergeApprovalCommand(approvalArgs(storeRoot), {
      transport: capture.transport,
    })).rejects.toThrow(/approval publication failed/);

    expect(capture.statuses.map((request) => request.state)).toEqual(['failure']);
    expect(capture.latestReads()).toBeGreaterThanOrEqual(2);
    expect(capture.remoteState()).toBe('failure');
    expect(readOperatorMergeApproval({ storeRoot, prNumber: 933, headSha: HEAD_A })).toMatchObject({
      approved: false,
      reason: 'revoked',
    });
  });

  it('reconciles an applied-but-client-failed success with verified blocking status', async () => {
    const storeRoot = tempRoot();
    const capture = captureTransport({ ambiguousSuccess: true });
    setOperatorProcessEnvironment();

    await expect(runOperatorMergeApprovalCommand(approvalArgs(storeRoot), {
      transport: capture.transport,
    })).rejects.toThrow(/timeout after GitHub accepted success/);

    expect(capture.statuses.map((request) => request.state)).toEqual(['success', 'failure']);
    expect(capture.latestReads()).toBeGreaterThanOrEqual(2);
    expect(capture.remoteState()).toBe('failure');
    expect(readOperatorMergeApproval({ storeRoot, prNumber: 933, headSha: HEAD_A })).toMatchObject({
      approved: false,
      reason: 'revoked',
    });
  });

  it('detects a late ambiguous success and writes a newer verified failure', async () => {
    const storeRoot = tempRoot();
    const capture = captureTransport({
      ambiguousSuccess: true,
      delayedSuccessAfterFirstFailureRead: true,
    });
    setOperatorProcessEnvironment();

    await expect(runOperatorMergeApprovalCommand(approvalArgs(storeRoot), {
      transport: capture.transport,
    })).rejects.toThrow(/timeout after GitHub accepted success/);

    expect(capture.statuses.map((request) => request.state)).toEqual(['success', 'failure', 'failure']);
    expect(capture.latestReads()).toBeGreaterThanOrEqual(4);
    expect(capture.remoteState()).toBe('failure');
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
    expect(capture.latestReads()).toBeGreaterThanOrEqual(2);
    expect(capture.remoteState()).toBe('failure');
    expect(capture.comments).toHaveLength(0);
  });
});

describe('direct operator merge policy', () => {
  it('allows an active exact-head approval only when current findings are triage-deferred', () => {
    const stateRoot = tempRoot();
    const record = approveOperatorMerge({
      storeRoot: policyStoreRoot(stateRoot),
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'Explicit operator direct-merge command',
      actor: 'operator-test',
    });
    seedDeferredPackReview();
    setOperatorProcessEnvironment();

    expect(evaluateMergePolicy(basePolicyInput(stateRoot))).toMatchObject({
      allow: true,
      reason: 'operator_merge_approved',
      approvalId: record.approvalId,
      approvedHeadSha: HEAD_A,
      reviewRunId: 'prr-operator-approval-fixture',
    });
  });

  it('keeps a current-head BLOCK finding blocking despite an active approval', () => {
    const stateRoot = tempRoot();
    approveOperatorMerge({
      storeRoot: policyStoreRoot(stateRoot),
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'approve',
      actor: 'operator-test',
    });
    seedPackReview([{
      id: 'finding-block-1',
      fingerprint: 'finding-block-1',
      title: 'CI will fail',
      body: 'The current implementation cannot pass the required validation.',
    }]);
    setOperatorProcessEnvironment();

    expect(evaluateMergePolicy(basePolicyInput(stateRoot))).toMatchObject({
      allow: false,
      reason: 'operator_merge_block_findings',
      reviewRunId: 'prr-operator-approval-fixture',
    });
  });

  it('keeps pending architect adjudication blocking despite an active approval', () => {
    const stateRoot = tempRoot();
    approveOperatorMerge({
      storeRoot: policyStoreRoot(stateRoot),
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'approve',
      actor: 'operator-test',
    });
    seedDeferredPackReview();
    seedPendingInbox(stateRoot);
    setOperatorProcessEnvironment();

    expect(evaluateMergePolicy(basePolicyInput(stateRoot))).toMatchObject({
      allow: false,
      reason: 'operator_merge_pending_adjudication',
      pending: [expect.objectContaining({ adjudication_id: 'adj-pending-933' })],
    });
  });

  it('keeps an unclassified current finding pending despite an active approval', () => {
    const stateRoot = tempRoot();
    approveOperatorMerge({
      storeRoot: policyStoreRoot(stateRoot),
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'approve',
      actor: 'operator-test',
    });
    seedPackReview([{
      id: 'finding-pending-1',
      fingerprint: 'finding-pending-1',
      title: 'Ambiguous finding',
      body: 'This requires adjudication and has no defer marker.',
    }]);
    setOperatorProcessEnvironment();

    expect(evaluateMergePolicy(basePolicyInput(stateRoot))).toMatchObject({
      allow: false,
      reason: 'operator_merge_pending_adjudication',
      reviewRunId: 'prr-operator-approval-fixture',
    });
  });

  it('denies caller-supplied operator sessionKind when trusted environment is absent', () => {
    const stateRoot = tempRoot();
    approveOperatorMerge({
      storeRoot: policyStoreRoot(stateRoot),
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'approve',
      actor: 'operator-test',
    });
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
    approveOperatorMerge({
      storeRoot: policyStoreRoot(stateRoot),
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'Explicit operator direct-merge command',
      actor: 'operator-test',
    });
    setOperatorProcessEnvironment();

    expect(evaluateMergePolicy({ ...basePolicyInput(stateRoot), headSha: HEAD_B })).toMatchObject({
      allow: false,
      reason: 'operator_merge_approval_unavailable',
      approvalReason: 'approval_head_mismatch',
    });
    expect(evaluateMergePolicy({ ...basePolicyInput(stateRoot), repoSlug: 'other/repository' })).toMatchObject({
      allow: false,
      reason: 'operator_merge_approval_unavailable',
      approvalReason: 'approval_repository_mismatch',
    });
    expect(evaluateMergePolicy({ ...basePolicyInput(stateRoot), prNumber: 934 })).toMatchObject({
      allow: false,
      reason: 'operator_merge_approval_unavailable',
      approvalReason: 'approval_missing',
    });

    process.env.AO_SESSION_ID = 'worker-session-933';
    expect(evaluateMergePolicy({ ...basePolicyInput(stateRoot), sessionKind: 'operator' })).toMatchObject({
      allow: false,
      reason: 'operator_merge_approval_unavailable',
      approvalReason: 'ao_managed_session_forbidden',
    });
  });

  it('denies a revoked exact-head approval', () => {
    const stateRoot = tempRoot();
    const storeRoot = policyStoreRoot(stateRoot);
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
