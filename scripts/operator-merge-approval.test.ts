import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateMergePolicy } from '../docs/merge-triage-gate.mjs';
import {
  approveOperatorMerge,
  operatorMergeApprovalRecordPath,
  readOperatorMergeApproval,
  revokeOperatorMerge,
} from './lib/operator-merge-approval.ts';

const roots: string[] = [];
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const REPO = 'chetwerikoff/orchestrator-pack';

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-operator-merge-approval-'));
  roots.push(root);
  return root;
}

function policyStoreRoot(stateRoot: string): string {
  return join(stateRoot, 'operator-merge-approvals', 'orchestrator-pack');
}

afterEach(() => {
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
    })).toEqual({
      approved: false,
      reason: 'malformed',
    });

    const names = readdirSync(storeRoot);
    expect(names).toEqual(['pr-933.json']);
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

  it('fails closed on malformed state instead of treating it as approval', () => {
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

describe('direct operator merge policy', () => {
  it('allows only an active exact-head approval for an operator session', () => {
    const stateRoot = tempRoot();
    const record = approveOperatorMerge({
      storeRoot: policyStoreRoot(stateRoot),
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'Explicit operator direct-merge command',
      actor: 'operator-test',
    });

    expect(evaluateMergePolicy({
      stateRoot,
      projectId: 'orchestrator-pack',
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      sessionKind: 'operator',
      directOperatorMerge: true,
    })).toMatchObject({
      allow: true,
      reason: 'operator_merge_approved',
      approvalId: record.approvalId,
      approvedHeadSha: HEAD_A,
    });
  });

  it('denies missing, head-mismatched, repository-mismatched, and worker consumption', () => {
    const stateRoot = tempRoot();
    approveOperatorMerge({
      storeRoot: policyStoreRoot(stateRoot),
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      reason: 'Explicit operator direct-merge command',
      actor: 'operator-test',
    });

    const base = {
      stateRoot,
      projectId: 'orchestrator-pack',
      repoSlug: REPO,
      prNumber: 933,
      sessionKind: 'operator',
      directOperatorMerge: true,
    };
    expect(evaluateMergePolicy({ ...base, headSha: HEAD_B })).toMatchObject({
      allow: false,
      reason: 'operator_merge_approval_unavailable',
      approvalReason: 'approval_malformed',
    });
    expect(evaluateMergePolicy({ ...base, repoSlug: 'other/repository', headSha: HEAD_A })).toMatchObject({
      allow: false,
      reason: 'operator_merge_approval_unavailable',
      approvalReason: 'approval_malformed',
    });
    expect(evaluateMergePolicy({ ...base, sessionKind: 'worker', headSha: HEAD_A })).toMatchObject({
      allow: false,
      reason: 'operator_merge_approval_unavailable',
      approvalReason: 'session_kind_not_operator',
    });
    expect(evaluateMergePolicy({ ...base, prNumber: 934, headSha: HEAD_A })).toMatchObject({
      allow: false,
      reason: 'operator_merge_approval_unavailable',
      approvalReason: 'approval_missing',
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

    expect(evaluateMergePolicy({
      stateRoot,
      projectId: 'orchestrator-pack',
      repoSlug: REPO,
      prNumber: 933,
      headSha: HEAD_A,
      sessionKind: 'operator',
      directOperatorMerge: true,
    })).toMatchObject({
      allow: false,
      reason: 'operator_merge_approval_unavailable',
      approvalReason: 'approval_revoked',
    });
  });
});
