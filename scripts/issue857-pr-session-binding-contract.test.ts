import { describe, expect, it } from 'vitest';

const resolver: any = await import('../docs/session-pr-binding-resolver.mjs');
const cacheContract: any = await import('../docs/pr-session-binding-cache.mjs');
const reportStore: any = await import('../docs/worker-report-store.mjs');

const repoSlug = 'org/repo';
const nowMs = Date.parse('2026-07-17T00:00:00.000Z');
const headSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const ttlMs = 7 * 24 * 60 * 60 * 1000;

function openPr(number: number, branch = `issue-${number}`, state = 'OPEN') {
  return { number, headRefName: branch, headRefOid: headSha, state, repoSlug };
}
function session(id: string, extra: Record<string, unknown> = {}) {
  return { id, sessionId: id, role: 'worker', status: 'running', repoSlug, ...extra };
}
const prUrl = (number: number) => `https://github.com/org/repo/pull/${number}`;

function cacheWith(sessionId: string, prNumber: number, source = cacheContract.BINDING_SOURCE_PUSH_REGISTER, ageMs = 0) {
  const store = cacheContract.createDefaultPrSessionBindingCache();
  cacheContract.registerPrSessionBindingRecord(store, { sessionId, prNumber, repoSlug, source, headSha }, nowMs - ageMs);
  return store;
}
function resolveCell(store: Record<string, unknown>, row: Record<string, unknown>, openPrs: Array<Record<string, unknown>>) {
  return cacheContract.resolveSessionPrBindingForConsumer({ store, repoSlug, session: row, openPrs, nowMs, writeBackfill: false });
}

describe('Issue #857 live session shape', () => {
  it('parses full PR URLs, leaves empty arrays unbound, and never picks index zero', () => {
    expect(resolver.resolveSessionPrBinding(session('one', { prs: [prUrl(1)] }), [openPr(1)])).toMatchObject({
      bound: true, prNumber: 1, bindingSource: 'live_prs',
    });
    expect(resolver.resolveSessionPrBinding(session('none', { prs: [] }), [openPr(1)])).toMatchObject({ bound: false });
    expect(resolver.resolveSessionPrBinding(session('many', { prs: [prUrl(1), prUrl(2)] }), [openPr(1), openPr(2)]).deferReason).toBe('ambiguous_session_prs');
  });

  it('ignores retired displayName/prNumber/.pr row fields', () => {
    const binding = resolver.resolveSessionPrBinding(session('retired', { displayName: '91', prNumber: 91, pr: '#91', prs: [] }), [openPr(91)]);
    expect(binding.bound).toBe(false);
    expect(resolver.shouldEnrichSessionDetailFromGet(session('retired'))).toBe(false);
    expect(resolver.buildSessionDetailsById([session('retired')], {})).toEqual({});
  });
});

describe('Issue #857 ten-cell binding matrix', () => {
  it('1 absent + absent -> no_source', () => {
    expect(resolveCell(cacheContract.createDefaultPrSessionBindingCache(), session('s1'), [])).toMatchObject({ bound: false, reason: 'no_source', sessionId: 's1' });
  });
  it('2 absent + live -> live binding', () => {
    expect(resolveCell(cacheContract.createDefaultPrSessionBindingCache(), session('s2', { prs: [prUrl(2)] }), [openPr(2)])).toMatchObject({ bound: true, prNumber: 2, source: 'live' });
  });
  it('3 absent + ambiguous -> live_ambiguous', () => {
    expect(resolveCell(cacheContract.createDefaultPrSessionBindingCache(), session('s3', { prs: [prUrl(3), prUrl(4)] }), [openPr(3), openPr(4)])).toMatchObject({ bound: false, reason: 'live_ambiguous', sessionId: 's3' });
  });
  it('4 live cache + no live candidate -> cache', () => {
    expect(resolveCell(cacheWith('s4', 4), session('s4'), [openPr(4)])).toMatchObject({ bound: true, prNumber: 4, source: 'cache' });
  });
  it('5 cache/live agree -> corroborated cache', () => {
    expect(resolveCell(cacheWith('s5', 5), session('s5', { prs: [prUrl(5)] }), [openPr(5)])).toMatchObject({ bound: true, prNumber: 5, reason: 'cache_hit_live_corroborated' });
  });
  it('6a push_register cache wins and records losing live source', () => {
    const result = resolveCell(cacheWith('s6a', 6), session('s6a', { prs: [prUrl(60)] }), [openPr(6), openPr(60)]);
    expect(result).toMatchObject({ bound: true, prNumber: 6, reason: 'cache_conflict_won' });
    expect(result.diagnostic?.loser?.source).toBe('live_prs');
  });
  it('6b direct live prs wins over backfill cache and supersedes loser', () => {
    const store = cacheWith('s6b', 6, cacheContract.BINDING_SOURCE_BACKFILL_RESOLVER);
    const result = resolveCell(store, session('s6b', { prs: [prUrl(61)] }), [openPr(6), openPr(61)]);
    expect(result).toMatchObject({ bound: true, prNumber: 61, reason: 'live_conflict_won' });
    expect(store.records[cacheContract.buildSessionBindingKey(repoSlug, 's6b')].prNumber).toBe(61);
  });
  it('7 live cache + ambiguous live -> cache with diagnostic', () => {
    const result = resolveCell(cacheWith('s7', 7), session('s7', { prs: [prUrl(7), prUrl(70)] }), [openPr(7), openPr(70)]);
    expect(result).toMatchObject({ bound: true, prNumber: 7, source: 'cache' });
    expect(result.diagnostic?.liveReason).toBe('ambiguous_session_prs');
  });
  it('8 stale cache + absent -> stale_cache_no_live', () => {
    expect(resolveCell(cacheWith('s8', 8, cacheContract.BINDING_SOURCE_PUSH_REGISTER, ttlMs + 1), session('s8'), [openPr(8)])).toMatchObject({ bound: false, reason: 'stale_cache_no_live', sessionId: 's8' });
  });
  it('9 stale cache + live -> live outright', () => {
    expect(resolveCell(cacheWith('s9', 9, cacheContract.BINDING_SOURCE_PUSH_REGISTER, ttlMs + 1), session('s9', { prs: [prUrl(90)] }), [openPr(9), openPr(90)])).toMatchObject({ bound: true, prNumber: 90, source: 'live' });
  });
  it('10 stale cache + ambiguous -> stale_cache_live_ambiguous', () => {
    expect(resolveCell(cacheWith('s10', 10, cacheContract.BINDING_SOURCE_PUSH_REGISTER, ttlMs + 1), session('s10', { prs: [prUrl(10), prUrl(100)] }), [openPr(10), openPr(100)])).toMatchObject({ bound: false, reason: 'stale_cache_live_ambiguous', sessionId: 's10' });
  });
});

describe('Issue #857 bounded consumer integration', () => {
  it('resolves five sessions with one bulk corpus and zero per-session detail calls', () => {
    const sessions = Array.from({ length: 5 }, (_, index) => session(`bulk-${index}`, index === 0 ? { prs: [prUrl(101)] } : {}));
    const result = reportStore.resolveWorkerReportTrustedBindings({
      sessions, openPrs: [openPr(101)], repoSlug, bindingStore: cacheWith('bulk-0', 101),
      worktreeHeadBySession: { 'bulk-0': headSha }, writeBackfill: false,
    });
    expect(result.callCounts).toEqual({ bulkSessionList: 1, sessionDetail: 0 });
    expect(Object.keys(result.bindingByKey)).toHaveLength(5);
    expect(Object.values(result.bindingByKey).every((row: any) => row.source || row.reason)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('trust_boundary_binding_unresolved');
  });

  it('keeps canonical cache path precedence and relative seed semantics', () => {
    expect(cacheContract.resolvePrSessionBindingCachePath({ AO_PR_SESSION_BINDING_CACHE: 'explicit.json', AO_REPORT_STATE_SEED_STATE: 'ignored/seed.json' })).toBe('explicit.json');
    expect(cacheContract.resolvePrSessionBindingCachePath({ AO_REPORT_STATE_SEED_STATE: 'seed.json' })).toBe('pr-session-binding-cache.json');
  });

  it('attributes a target-session fail-closed cache conflict', () => {
    const result = cacheContract.resolvePrSessionBindingForConsumer({
      store: cacheWith('stale-owner', 111), repoSlug, prNumber: 111,
      sessions: [session('live-owner', { prs: [prUrl(111)] })], openPrs: [openPr(111)], nowMs, writeBackfill: false,
    });
    expect(result).toMatchObject({ failClosed: true, reason: 'binding_cache_conflict', sessionId: 'live-owner', conflictingSessionId: 'stale-owner' });
  });
});
