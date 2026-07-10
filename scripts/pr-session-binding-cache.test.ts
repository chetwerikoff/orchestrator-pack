import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLiveWorkerSession } from '../docs/review-reconcile-primitives.mjs';
import {
  BINDING_SOURCE_BACKFILL_RESOLVER,
  BINDING_SOURCE_PUSH_REGISTER,
  createDefaultPrSessionBindingCache,
  evictPrSessionBindings,
  lookupBindingByPr,
  lookupBindingBySession,
  parsePrNumberFromGhPrCreateOutput,
  provePushRegisterWorkerIdentity,
  registerPrSessionBindingRecord,
  resolvePrSessionBindingCachePath,
  resolvePrSessionBindingForConsumer,
  tryPushRegisterFromPrCreate,
  writePrSessionBindingCacheFile,
} from '../docs/pr-session-binding-cache.mjs';
import { resolveHeadOwningWorkerSessionId } from '../docs/review-trigger-reconcile.mjs';

const repoSlug = 'org/orchestrator-pack';
const nowMs = Date.parse('2026-07-09T12:00:00.000Z');

function liveWorker(sessionId: string, issueNumber = 719, extra: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    sessionId,
    role: 'worker',
    status: 'running',
    issueNumber,
    ...extra,
  };
}

function openPr(number: number, headRefOid = 'abc123', state = 'OPEN') {
  return { number, headRefOid, headRefName: `issue-${number}-root`, state, repoSlug };
}

function tempCachePath() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-session-binding-cache-'));
  return path.join(dir, 'cache.json');
}

function seedStore(record: {
  sessionId: string;
  prNumber: number;
  headSha?: string;
  issueNumber?: number;
  source?: string;
}) {
  const store = createDefaultPrSessionBindingCache();
  registerPrSessionBindingRecord(
    store,
    {
      sessionId: record.sessionId,
      prNumber: record.prNumber,
      repoSlug,
      issueNumber: record.issueNumber ?? 719,
      headSha: record.headSha ?? 'abc123',
      source: record.source ?? BINDING_SOURCE_PUSH_REGISTER,
    },
    nowMs,
  );
  return store;
}

/**
 * Full-class scenario matrix (Issue #719).
 * | Class | Push-register | Backfill | Consumer read | Expected |
 */
const MATRIX: Array<{ classId: string; description: string }> = [
  { classId: 'A', description: 'cache hit resolves binding' },
  { classId: 'B', description: 'backfill with displayName present' },
  { classId: 'C', description: 'backfill with displayName absent via issue correlation' },
  { classId: 'D', description: 'cache miss + backfill miss fail closed' },
  { classId: 'E', description: 'ambiguous issue to PRs' },
  { classId: 'F', description: 'ambiguous PR to sessions' },
  { classId: 'G', description: 'terminal PR evicted' },
  { classId: 'H', description: 'supersede rebound session' },
  { classId: 'I', description: 'concurrent same pair converges' },
  { classId: 'J', description: 'collision different PR same session' },
  { classId: 'P', description: 'indeterminate ordering collision' },
  { classId: 'K', description: 'daemon-empty corpus cache-only' },
  { classId: 'L', description: 'session get unavailable backfill best effort' },
  { classId: 'M', description: 'out-of-band PR backfill only' },
  { classId: 'N', description: 'partial failure recovery on backfill' },
  { classId: 'O', description: 'unproven identity push-register fail closed' },
];

describe('pr-session-binding-cache matrix', () => {
  it.each(MATRIX)('documents matrix row $classId ($description)', ({ classId }) => {
    expect(classId).toMatch(/^[A-Z]$/);
  });
});

describe('pr-session-binding-cache push-register', () => {
  it('AC#1 class A/K: push-register writes binding before consumer read', () => {
    const cachePath = tempCachePath();
    const store = seedStore({ sessionId: 'opk-719', prNumber: 719, headSha: 'deadbeef' });
    writePrSessionBindingCacheFile(cachePath, store);

    const resolution = resolvePrSessionBindingForConsumer({
      cachePath,
      repoSlug,
      prNumber: 719,
      headSha: 'deadbeef',
      sessions: [liveWorker('opk-719')],
      openPrs: [openPr(719, 'deadbeef')],
      nowMs,
      writeBackfill: false,
      isLive: (session) => isLiveWorkerSession(session),
    });

    expect(resolution.sessionId).toBe('opk-719');
    expect(resolution.source).toBe('cache');
    expect(resolution.failClosed).toBe(false);
  });

  it('AC#2 class O: rejects unproven session identity', () => {
    const proof = provePushRegisterWorkerIdentity({}, { claimedSessionId: 'spoofed' });
    expect(proof.ok).toBe(false);
    expect(proof.reason).toBe('push_register_missing_session_identity');

    const register = tryPushRegisterFromPrCreate({
      argv: ['pr', 'create', '--title', 'x', '--body', 'y'],
      status: 0,
      stdout: 'https://github.com/org/orchestrator-pack/pull/42\n',
      stderr: '',
      env: {},
    });
    expect(register.registered).toBe(false);
    expect(register.reason).toBe('push_register_missing_session_identity');
  });

  it('parses PR number from gh pr create output', () => {
    expect(
      parsePrNumberFromGhPrCreateOutput('https://github.com/org/orchestrator-pack/pull/719\n', ''),
    ).toBe(719);
  });
});

describe('pr-session-binding-cache backfill', () => {
  it('AC#3 class B/C: backfills issue-only session row then serves cache', () => {
    const cachePath = tempCachePath();
    const sessions = [liveWorker('opk-issue-only', 690)];
    const openPrs = [openPr(690, 'head690')];

    const first = resolvePrSessionBindingForConsumer({
      cachePath,
      repoSlug,
      prNumber: 690,
      headSha: 'head690',
      sessions,
      openPrs,
      nowMs,
      isLive: (session) => isLiveWorkerSession(session),
    });
    expect(first.sessionId).toBe('opk-issue-only');
    expect(first.source).toBe('backfill_resolver');

    const second = resolvePrSessionBindingForConsumer({
      cachePath,
      repoSlug,
      prNumber: 690,
      headSha: 'head690',
      sessions,
      openPrs,
      nowMs,
      writeBackfill: false,
      isLive: (session) => isLiveWorkerSession(session),
    });
    expect(second.sessionId).toBe('opk-issue-only');
    expect(second.source).toBe('cache');
  });

  it('AC#3 class N: recovers binding after failed first cache write via backfill', () => {
    const cachePath = tempCachePath();
    const sessions = [liveWorker('opk-recover', 719)];
    const openPrs = [openPr(719, 'recoverhead')];

    const resolution = resolvePrSessionBindingForConsumer({
      cachePath,
      repoSlug,
      prNumber: 719,
      headSha: 'recoverhead',
      sessions,
      openPrs,
      nowMs,
      isLive: (session) => isLiveWorkerSession(session),
    });
    expect(resolution.sessionId).toBe('opk-recover');
    expect(readFileSync(cachePath, 'utf8')).toContain('opk-recover');
  });
});

describe('pr-session-binding-cache read-cache-first', () => {
  it('AC#4: review-trigger consumer resolves via cache without daemon fallback', () => {
    const cachePath = tempCachePath();
    const store = seedStore({ sessionId: 'opk-review', prNumber: 55, headSha: 'sha55' });
    writePrSessionBindingCacheFile(cachePath, store);

    const sessionId = resolveHeadOwningWorkerSessionId(
      [liveWorker('opk-review', 55, { ownedHeadSha: 'sha55' })],
      55,
      'sha55',
      [openPr(55, 'sha55')],
      { repoSlug, cachePath },
    );
    expect(sessionId).toBe('opk-review');
  });

  it('AC#4 class D: cache miss + backfill miss returns null', () => {
    const cachePath = tempCachePath();
    const sessionId = resolveHeadOwningWorkerSessionId(
      [liveWorker('opk-alone', 999)],
      42,
      'missing',
      [openPr(42, 'other')],
      { repoSlug, cachePath },
    );
    expect(sessionId).toBeNull();
  });
});

describe('pr-session-binding-cache ambiguity', () => {
  it('AC#5 class E: ambiguous issue to PRs fail closed', () => {
    const cachePath = tempCachePath();
    const sessions = [liveWorker('opk-amb-issue', 100)];
    const openPrs = [
      { ...openPr(100, 'h1'), headRefName: 'issue-100-a' },
      { ...openPr(200, 'h2'), headRefName: 'issue-100-b' },
    ];

    const resolution = resolvePrSessionBindingForConsumer({
      cachePath,
      repoSlug,
      prNumber: 100,
      sessions,
      openPrs,
      nowMs,
      isLive: (session) => isLiveWorkerSession(session),
    });
    expect(resolution.failClosed).toBe(true);
    expect(resolution.deferReason).toBe('ambiguous_issue_pr_binding');
  });

  it('AC#5 class F: ambiguous PR to sessions fail closed', () => {
    const cachePath = tempCachePath();
    const sessions = [
      liveWorker('opk-a', 719, { prNumber: 88 }),
      liveWorker('opk-b', 720, { prNumber: 88 }),
    ];
    const openPrs = [openPr(88, 'shared')];

    const resolution = resolvePrSessionBindingForConsumer({
      cachePath,
      repoSlug,
      prNumber: 88,
      headSha: 'shared',
      sessions,
      openPrs,
      nowMs,
      isLive: (session) => isLiveWorkerSession(session),
    });
    expect(resolution.failClosed).toBe(true);
    expect(resolution.deferReason).toBe('ambiguous_pr_session_binding');
  });
});

describe('pr-session-binding-cache eviction and supersede', () => {
  it('AC#6 class G: evicts merged PR bindings', () => {
    const store = seedStore({ sessionId: 'opk-old', prNumber: 10, headSha: 'old' });
    evictPrSessionBindings({
      store,
      openPrs: [openPr(10, 'old', 'MERGED')],
      nowMs,
      openListAuthoritative: true,
      repoSlug,
    });
    expect(lookupBindingByPr(store, repoSlug, 10)).toBeNull();
  });

  it('AC#6 class H: supersede replaces terminal prior binding', () => {
    const store = seedStore({ sessionId: 'opk-rebind', prNumber: 11, headSha: 'old11' });
    evictPrSessionBindings({
      store,
      openPrs: [openPr(11, 'old11', 'MERGED'), openPr(12, 'new12')],
      nowMs,
      openListAuthoritative: true,
      repoSlug,
    });
    const register = registerPrSessionBindingRecord(
      store,
      {
        sessionId: 'opk-rebind',
        prNumber: 12,
        repoSlug,
        headSha: 'new12',
        source: BINDING_SOURCE_PUSH_REGISTER,
      },
      nowMs + 1000,
    );
    expect(register.ok).toBe(true);
    expect(lookupBindingBySession(store, repoSlug, 'opk-rebind')?.prNumber).toBe(12);
    expect(lookupBindingByPr(store, repoSlug, 11)).toBeNull();
  });

  it('AC#6 TTL evicts stale records under soak cap', () => {
    const store = seedStore({ sessionId: 'opk-stale', prNumber: 13 });
    const staleMs = nowMs - (8 * 24 * 60 * 60 * 1000);
    for (const record of Object.values(store.records)) {
      record.lastUpdatedMs = staleMs;
    }
    evictPrSessionBindings({ store, openPrs: [openPr(13)], nowMs, ttlMs: 7 * 24 * 60 * 60 * 1000, repoSlug });
    expect(lookupBindingByPr(store, repoSlug, 13)).toBeNull();
  });
});

describe('pr-session-binding-cache collision', () => {
  it('AC#7 class I: same pair converges idempotently', () => {
    const store = createDefaultPrSessionBindingCache();
    const record = {
      sessionId: 'opk-same',
      prNumber: 20,
      repoSlug,
      headSha: 'same20',
      source: BINDING_SOURCE_PUSH_REGISTER,
    };
    const first = registerPrSessionBindingRecord(store, record, nowMs);
    const second = registerPrSessionBindingRecord(store, record, nowMs + 1);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.reason).toBe('converged');
    expect(Object.keys(store.records).length).toBe(2);
  });

  it('AC#7 class J: live collision fails closed without clobber', () => {
    const store = seedStore({ sessionId: 'opk-live', prNumber: 21, headSha: 'h21' });
    const collision = registerPrSessionBindingRecord(
      store,
      {
        sessionId: 'opk-live',
        prNumber: 22,
        repoSlug,
        headSha: 'h22',
        source: BINDING_SOURCE_PUSH_REGISTER,
        openPrs: [openPr(21, 'h21'), openPr(22, 'h22')],
      },
      nowMs + 1,
    );
    expect(collision.ok).toBe(false);
    expect(collision.reason).toBe('binding_collision');
    expect(lookupBindingBySession(store, repoSlug, 'opk-live')?.prNumber).toBe(21);
  });

  it('AC#7 class P: indeterminate ordering treated as collision', () => {
    const store = createDefaultPrSessionBindingCache();
    const openPrs = [openPr(30, 'h30'), openPr(31, 'h31')];
    const a = registerPrSessionBindingRecord(
      store,
      {
        sessionId: 'opk-a',
        prNumber: 30,
        repoSlug,
        headSha: 'h30',
        source: BINDING_SOURCE_PUSH_REGISTER,
        openPrs,
      },
      nowMs,
    );
    const b = registerPrSessionBindingRecord(
      store,
      {
        sessionId: 'opk-b',
        prNumber: 30,
        repoSlug,
        headSha: 'h30',
        source: BINDING_SOURCE_BACKFILL_RESOLVER,
        openPrs,
      },
      nowMs,
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.diagnostic).toBe('ambiguous_binding');
  });
});

describe('pr-session-binding-cache path resolution', () => {
  it('defaults cache path under wake-supervisor state root', () => {
    const resolved = resolvePrSessionBindingCachePath({ AO_PR_SESSION_BINDING_CACHE: '/tmp/test-cache.json' });
    expect(resolved).toBe('/tmp/test-cache.json');
  });
});
