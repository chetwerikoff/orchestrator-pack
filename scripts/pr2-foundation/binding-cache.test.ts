import { describe, expect, it } from 'vitest';
import {
  resolveFoundationBinding,
  validateBindingCacheRecord,
  type AoSessionRow,
  type BindingCacheRecord,
  type OpenPrSnapshotRow,
} from './binding.ts';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function session(): AoSessionRow {
  return {
    createdAt: '2026-07-20T00:00:00.000Z',
    harness: 'cursor',
    id: 'session-current',
    isTerminated: false,
    issueId: 923,
    lastActivityAt: '2026-07-20T00:10:00.000Z',
    projectId: 'orchestrator-pack',
    role: 'worker',
    status: 'working',
    updatedAt: '2026-07-20T00:10:00.000Z',
  };
}

function pr(head = HEAD_A, branch = 'issue-923'): OpenPrSnapshotRow {
  return {
    repoSlug: 'chetwerikoff/orchestrator-pack',
    number: 923,
    state: 'OPEN',
    isDraft: false,
    headRefName: branch,
    headRefOid: head,
  };
}

function foreignCache(fresh: boolean): BindingCacheRecord {
  return {
    sessionId: 'session-foreign',
    prNumber: 923,
    currentHeadSha: HEAD_B,
    source: 'claim_pr',
    boundAt: '2026-07-20T00:05:00.000Z',
    fresh,
  };
}

const base = {
  session: session(),
  configuredRepo: 'chetwerikoff/orchestrator-pack',
  now: '2026-07-20T01:00:00.000Z',
};

describe('[AC2] binding cache session identity', () => {
  it('rejects malformed or foreign cache records before trust ranking', () => {
    expect(validateBindingCacheRecord(foreignCache(true), 'session-current')).toEqual({
      ok: false,
      reason: 'cache_session_mismatch',
    });
    expect(validateBindingCacheRecord({ ...foreignCache(true), extra: true }, 'session-current')).toEqual({
      ok: false,
      reason: 'cache_shape_invalid',
    });
  });

  it.each([true, false])('never binds a foreign cache with no live candidate (fresh=%s)', (fresh) => {
    expect(resolveFoundationBinding({
      ...base,
      openPrs: [],
      cache: foreignCache(fresh),
    })).toMatchObject({
      bound: false,
      classId: 'B1',
      sessionId: 'session-current',
      reason: 'no_source',
      context: { rejectedCache: { reason: 'cache_session_mismatch' } },
    });
  });

  it.each([true, false])('uses the current live candidate instead of a foreign cache (fresh=%s)', (fresh) => {
    expect(resolveFoundationBinding({
      ...base,
      openPrs: [pr()],
      cache: foreignCache(fresh),
    })).toMatchObject({
      bound: true,
      classId: 'B2',
      sessionId: 'session-current',
      prNumber: 923,
      currentHeadSha: HEAD_A,
      source: 'issue_correlation',
      retainedConflict: { rejectedCache: { reason: 'cache_session_mismatch' } },
    });
  });

  it.each([true, false])('keeps ambiguity fail-closed instead of returning a foreign cache (fresh=%s)', (fresh) => {
    expect(resolveFoundationBinding({
      ...base,
      openPrs: [pr(HEAD_A), pr(HEAD_B, 'feat/923')],
      cache: foreignCache(fresh),
    })).toMatchObject({
      bound: false,
      classId: 'B3',
      sessionId: 'session-current',
      reason: 'live_ambiguous',
      context: {
        rejectedCache: { reason: 'cache_session_mismatch' },
      },
    });
  });
});
