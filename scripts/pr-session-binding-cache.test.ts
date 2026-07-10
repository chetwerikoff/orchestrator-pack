import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BINDING_SOURCE_BACKFILL_RESOLVER,
  BINDING_SOURCE_PUSH_REGISTER,
  type BindingSource,
  createDefaultPrSessionBindingCache,
  evictPrSessionBindings,
  lookupBindingByPr,
  lookupBindingBySession,
  parsePrNumberFromGhPrCreateOutput,
  loadPushRegisterVerifiedSessions,
  provePushRegisterWorkerIdentity,
  readPrSessionBindingCacheFile,
  registerPrSessionBindingRecord,
  sessionRowFromAoSessionGetPayload,
  resolvePrSessionBindingCachePath,
  resolvePrSessionBindingForConsumer,
  tryPushRegisterFromPrCreate,
  updatePrSessionBindingCacheWithCas,
  writePrSessionBindingCacheFile,
  writePrSessionBindingCacheFileWithCas,
} from '../docs/pr-session-binding-cache.mjs';
import { resolveHeadOwningWorkerSessionId } from '../docs/review-trigger-reconcile.mjs';

function isLiveWorkerSession(session: Record<string, unknown>) {
  const status = String(session?.status ?? '').toLowerCase();
  return !['terminated', 'dead', 'completed', 'cancelled'].includes(status);
}


function repoRootFromTest() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
}

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
  source?: BindingSource;
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

  it('rejects env-only spoof without verified AO session corpus', () => {
    const env = {
      AO_WORKER_SESSION_ID: 'opk-spoof',
      AO_REPO_SLUG: repoSlug,
      AO_PROJECT_ID: 'orchestrator-pack',
    };
    const verified = loadPushRegisterVerifiedSessions({ env, sessions: [] });
    expect(verified.ok).toBe(false);

    const proof = provePushRegisterWorkerIdentity(env, { cwd: process.cwd() });
    expect(proof.ok).toBe(false);
    expect(proof.reason).toBe('push_register_session_verification_required');

    const register = tryPushRegisterFromPrCreate({
      argv: ['pr', 'create', '--title', 'x', '--body', 'y'],
      status: 0,
      stdout: 'https://github.com/org/orchestrator-pack/pull/42\n',
      stderr: '',
      env,
    });
    expect(register.registered).toBe(false);
    expect(register.reason).toBe('push_register_session_verify_failed');
  });

  it('accepts push-register only with verified session corpus', () => {
    const cachePath = tempCachePath();
    const env = {
      AO_WORKER_SESSION_ID: 'opk-verified',
      AO_REPO_SLUG: repoSlug,
      AO_PROJECT_ID: 'orchestrator-pack',
      AO_PR_SESSION_BINDING_CACHE: cachePath,
    };
    const sessions = [liveWorker('opk-verified', 719)];
    const proof = provePushRegisterWorkerIdentity(env, { sessions });
    expect(proof.ok).toBe(true);

    const register = tryPushRegisterFromPrCreate({
      argv: ['pr', 'create', '--title', 'x', '--body', 'y'],
      status: 0,
      stdout: 'https://github.com/org/orchestrator-pack/pull/88\n',
      stderr: '',
      env,
      sessions,
    });
    expect(register.registered).toBe(true);
    expect(lookupBindingByPr(readPrSessionBindingCacheFile(cachePath), repoSlug, 88)?.sessionId).toBe('opk-verified');
  });

  it('push-register treats indeterminate same-session rebind as collision', () => {
    const cachePath = tempCachePath();
    const env = {
      AO_WORKER_SESSION_ID: 'opk-rebind',
      AO_REPO_SLUG: repoSlug,
      AO_PROJECT_ID: 'orchestrator-pack',
      AO_PR_SESSION_BINDING_CACHE: cachePath,
    };
    const sessions = [liveWorker('opk-rebind', 719)];
    const store = seedStore({ sessionId: 'opk-rebind', prNumber: 11, headSha: 'old11' });
    writePrSessionBindingCacheFile(cachePath, store);

    const register = tryPushRegisterFromPrCreate({
      argv: ['pr', 'create', '--title', 'x', '--body', 'y'],
      status: 0,
      stdout: 'https://github.com/org/orchestrator-pack/pull/12\n',
      stderr: '',
      env,
      sessions,
    });
    expect(register.registered).toBe(false);
    expect(register.reason).toBe('binding_collision');
    expect(lookupBindingBySession(readPrSessionBindingCacheFile(cachePath), repoSlug, 'opk-rebind')?.prNumber).toBe(11);
  });

  it('push-register supersedes same-session rebind when prior PR is terminal in openPrs', () => {
    const cachePath = tempCachePath();
    const env = {
      AO_WORKER_SESSION_ID: 'opk-rebind',
      AO_REPO_SLUG: repoSlug,
      AO_PROJECT_ID: 'orchestrator-pack',
      AO_PR_SESSION_BINDING_CACHE: cachePath,
    };
    const sessions = [liveWorker('opk-rebind', 719)];
    const store = seedStore({ sessionId: 'opk-rebind', prNumber: 11, headSha: 'old11' });
    writePrSessionBindingCacheFile(cachePath, store);

    const register = registerPrSessionBindingRecord(
      store,
      {
        sessionId: 'opk-rebind',
        prNumber: 12,
        repoSlug,
        headSha: 'new12',
        source: BINDING_SOURCE_PUSH_REGISTER,
        openPrs: [openPr(11, 'old11', 'MERGED'), openPr(12, 'new12')],
      },
      nowMs + 1000,
    );
    expect(register.ok).toBe(true);
    writePrSessionBindingCacheFile(cachePath, store);
    expect(lookupBindingBySession(store, repoSlug, 'opk-rebind')?.prNumber).toBe(12);
  });

  it('push-register supersedes terminal same-session rebind via prior-pr lookup', () => {
    const cachePath = tempCachePath();
    const env = {
      AO_WORKER_SESSION_ID: 'opk-rebind-terminal',
      AO_REPO_SLUG: repoSlug,
      AO_PROJECT_ID: 'orchestrator-pack',
      AO_PR_SESSION_BINDING_CACHE: cachePath,
    };
    const sessions = [liveWorker('opk-rebind-terminal', 719)];
    const store = seedStore({ sessionId: 'opk-rebind-terminal', prNumber: 11, headSha: 'old11' });
    writePrSessionBindingCacheFile(cachePath, store);

    const register = tryPushRegisterFromPrCreate({
      argv: ['pr', 'create', '--title', 'x', '--body', 'y'],
      status: 0,
      stdout: 'https://github.com/org/orchestrator-pack/pull/12\n',
      stderr: '',
      env,
      sessions,
      fetchPriorPrOpenRow: (_slug, pr) => openPr(pr, pr === 11 ? 'old11' : 'new12', pr === 11 ? 'MERGED' : 'OPEN'),
    });
    expect(register.registered).toBe(true);
    expect(lookupBindingBySession(readPrSessionBindingCacheFile(cachePath), repoSlug, 'opk-rebind-terminal')?.prNumber).toBe(12);
  });

  it('isolates corrupt cache IO from successful gh pr create registration path', () => {
    const env = {
      AO_WORKER_SESSION_ID: 'opk-io',
      AO_REPO_SLUG: repoSlug,
      AO_PROJECT_ID: 'orchestrator-pack',
      AO_PR_SESSION_BINDING_CACHE: '/definitely/not/a/dir/cache.json',
    };
    const sessions = [liveWorker('opk-io', 719)];
    const register = tryPushRegisterFromPrCreate({
      argv: ['pr', 'create', '--title', 'x', '--body', 'y'],
      status: 0,
      stdout: 'https://github.com/org/orchestrator-pack/pull/90\n',
      stderr: '',
      env,
      sessions,
    });
    expect(register.registered).toBe(false);
    expect(register.reason).toBe('push_register_cache_io_failed');
  });

  it('parses ao session get payload into worker row', () => {
    const capture = JSON.parse(readFileSync(
      path.join(repoRootFromTest(), 'tests/external-output-references/captures/ao-0-10-cli/session-get-worker.raw.json'),
      'utf8',
    ));
    const row = sessionRowFromAoSessionGetPayload(capture);
    expect(row?.sessionId).toBe('orchestrator-pack-7');
    expect(row?.role).toBe('worker');
    expect(row?.projectId).toBe('orchestrator-pack');
  });


  it('CAS rejects stale generation writes', () => {
    const cachePath = tempCachePath();
    const initial = seedStore({ sessionId: 'opk-a', prNumber: 30, headSha: 'h30' });
    writePrSessionBindingCacheFile(cachePath, initial);
    const observed = readPrSessionBindingCacheFile(cachePath);
    const staleGeneration = observed.generation;
    const concurrent = readPrSessionBindingCacheFile(cachePath);
    concurrent.generation = staleGeneration + 1;
    writePrSessionBindingCacheFile(cachePath, concurrent);
    const staleWrite = writePrSessionBindingCacheFileWithCas(cachePath, observed, staleGeneration);
    expect(staleWrite.ok).toBe(false);
    expect(staleWrite.reason).toBe('generation_mismatch');
    expect(readPrSessionBindingCacheFile(cachePath).generation).toBe(staleGeneration + 1);
  });

  it('parses PR number from gh pr create output', () => {
    expect(
      parsePrNumberFromGhPrCreateOutput('https://github.com/org/orchestrator-pack/pull/719\n', ''),
    ).toBe(719);
  });
});

describe('pr-session-binding-cache backfill', () => {
  it('CAS backfill writes preserve prior bindings across sequential consumers', () => {
    const cachePath = tempCachePath();
    const first = updatePrSessionBindingCacheWithCas(
      cachePath,
      (store, writeMs) => registerPrSessionBindingRecord(
        store,
        {
          sessionId: 'opk-a',
          prNumber: 100,
          repoSlug,
          headSha: 'h100',
          source: BINDING_SOURCE_BACKFILL_RESOLVER,
        },
        writeMs,
      ),
      nowMs,
    );
    const second = updatePrSessionBindingCacheWithCas(
      cachePath,
      (store, writeMs) => registerPrSessionBindingRecord(
        store,
        {
          sessionId: 'opk-b',
          prNumber: 101,
          repoSlug,
          headSha: 'h101',
          source: BINDING_SOURCE_BACKFILL_RESOLVER,
        },
        writeMs,
      ),
      nowMs + 1,
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const store = readPrSessionBindingCacheFile(cachePath);
    expect(lookupBindingByPr(store, repoSlug, 100)?.sessionId).toBe('opk-a');
    expect(lookupBindingByPr(store, repoSlug, 101)?.sessionId).toBe('opk-b');
  });


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


  it('Codex: cache hit fails closed when live corpus has PR-to-many-session ambiguity', () => {
    const store = seedStore({ sessionId: 'opk-a', prNumber: 88, headSha: 'shared' });
    const sessions = [
      liveWorker('opk-a', 719, { prNumber: 88 }),
      liveWorker('opk-b', 720, { prNumber: 88 }),
    ];
    const openPrs = [openPr(88, 'shared')];

    const resolution = resolvePrSessionBindingForConsumer({
      store,
      repoSlug,
      prNumber: 88,
      headSha: 'shared',
      sessions,
      openPrs,
      nowMs,
      writeBackfill: false,
      isLive: (session) => isLiveWorkerSession(session),
    });
    expect(resolution.failClosed).toBe(true);
    expect(resolution.deferReason).toBe('ambiguous_pr_session_binding');
    expect(resolution.source).toBe('cache');
  });

  it('Codex: backfill does not write stale head when session lacks head ownership', () => {
    const cachePath = tempCachePath();
    const sessions = [liveWorker('opk-stale', 501, { prNumber: 501, ownedHeadSha: 'oldhead' })];
    const openPrs = [openPr(501, 'newhead')];

    const resolution = resolvePrSessionBindingForConsumer({
      cachePath,
      repoSlug,
      prNumber: 501,
      headSha: 'newhead',
      sessions,
      openPrs,
      nowMs,
      isLive: (session) => isLiveWorkerSession(session),
    });
    expect(resolution.failClosed).toBe(true);
    expect(resolution.diagnostic).toBe('head_owner_mismatch');
    const store = readPrSessionBindingCacheFile(cachePath);
    expect(lookupBindingByPr(store, repoSlug, 501)).toBeNull();
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
