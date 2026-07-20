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

function operatorEnvironment(): NodeJS.ProcessEnv {
  return { AO_SESSION_KIND: 'operator' };
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
} = {}): {
  transport: OperatorMergeApprovalGithubTransport;
  statuses: OperatorMergeApprovalStatusRequest[];
  comments: string[];
  remoteState: () => 'success' | 'failure' | undefined;
} {
  const statuses: OperatorMergeApprovalStatusRequest[] = [];
  const comments: string[] = [];
  let remoteState = options.initialRemoteState;
  return {
    statuses,
    comments,
    remoteState: () => remoteState,
    transport: {
      async postComment(request) {
        comments.push(request.body);
        if (options.failComment) throw new Error('injected comment failure');
      },
      async postStatus(request) {
        statuses.push(request);
        remoteState = request.state;
        if (options.ambiguousSuccess && request.state === 'success') {
          throw new Error('injected timeout after GitHub accepted success');
        }
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
  it('requires the trusted operator environment even for read-only show', () => {
    expect(() => assertOperatorMergeApprovalSession({})).toThrow(/AO_SESSION_KIND=operator/);
    expect(() => assertOperatorMergeApprovalSession({ AO_SESSION_KIND: 'operator' })).not.toThrow();
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

  it('publishes an audited success for a normal operator approval', async () => {
    const storeRoot = tempRoot();
    const capture = captureTransport();
    const result = await runOperatorMergeApprovalCommand(approvalArgs(storeRoot), {
      env: operatorEnvironment(),
      transport: capture.transport,
    });

    expect(result.approval).toMatchObject({ event: 'operator_merge_approved', headSha: HEAD_A });
    expect(capture.comments).toHaveLength(1);
    expect(capture.statuses.map((request) => request.state)).toEqual(['success']);
    expect(capture.remoteState()).toBe('success');
  });

  it('overwrites a pre-existing remote success with failure when repeat publication fails', async () => {
    const storeRoot = tempRoot();
    const capture = captureTransport({ initialRemoteState: 'success', failComment: true });

    await expect(runOperatorMergeApprovalCommand(approvalArgs(storeRoot), {
      env: operatorEnvironment(),
      transport: capture.transport,
    })).rejects.toThrow(/approval publication failed/);

    expect(capture.statuses.map((request) => request.state)).toEqual(['failure']);
    expect(capture.remoteState()).toBe('failure');
    expect(readOperatorMergeApproval({ storeRoot, prNumber: 933, headSha: HEAD_A })).toMatchObject({
      approved: false,
      reason: 'revoked',
    });
  });

  it('reconciles an applied-but-client-failed success with a later blocking status', async () => {
    const storeRoot = tempRoot();
    const capture = captureTransport({ ambiguousSuccess: true });

    await expect(runOperatorMergeApprovalCommand(approvalArgs(storeRoot), {
      env: operatorEnvironment(),
      transport: capture.transport,
    })).rejects.toThrow(/timeout after GitHub accepted success/);

    expect(capture.statuses.map((request) => request.state)).toEqual(['success', 'failure']);
    expect(capture.remoteState()).toBe('failure');
    expect(readOperatorMergeApproval({ storeRoot, prNumber: 933, headSha: HEAD_A })).toMatchObject({
      approved: false,
      reason: 'revoked',
    });
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

    const result = await runOperatorMergeApprovalCommand(revokeArgs(storeRoot), {
      env: operatorEnvironment(),
      transport: capture.transport,
    });

    expect(result.approval).toMatchObject({ approved: false, reason: 'revoked' });
    expect(capture.statuses.map((request) => request.state)).toEqual(['failure']);
    expect(capture.remoteState()).toBe('failure');
    expect(capture.comments).toHaveLength(0);
  });
});

describe('direct operator merge policy', () => {
  it('allows only an active exact-head approval from trusted operator process environment', () => {
    const stateRoot = tempRoot();
    const record = approveOperatorMerge({
      storeRoot: policyStoreRoot(stateRoot),
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'Explicit operator direct-merge command',
      actor: 'operator-test',
    });
    setOperatorProcessEnvironment();

    expect(evaluateMergePolicy(basePolicyInput(stateRoot))).toMatchObject({
      allow: true,
      reason: 'operator_merge_approved',
      approvalId: record.approvalId,
      approvedHeadSha: HEAD_A,
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
