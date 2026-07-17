import assert from 'node:assert/strict';
import {
  BINDING_SOURCE_BACKFILL_RESOLVER,
  BINDING_SOURCE_PUSH_REGISTER,
  buildSessionBindingKey,
  createDefaultPrSessionBindingCache,
  registerPrSessionBindingRecord,
  resolvePrSessionBindingCachePath,
  resolveSessionPrBindingForConsumer,
} from '../../docs/pr-session-binding-cache.mjs';
import { resolveSessionPrBinding } from '../../docs/session-pr-binding-resolver.mjs';
import { resolveWorkerReportTrustedBindings } from '../../docs/worker-report-store.mjs';

const repoSlug = 'chetwerikoff/orchestrator-pack';
const nowMs = Date.parse('2026-07-17T00:00:00Z');
const ttlMs = 7 * 24 * 60 * 60 * 1000;
const headSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const url = (n) => `https://github.com/${repoSlug}/pull/${n}`;
const pr = (n, branch = `issue-${n}`) => ({ number: n, state: 'OPEN', repoSlug, headRefName: branch, headRefOid: headSha });
const session = (id, extra = {}) => ({ id, sessionId: id, role: 'worker', status: 'working', repoSlug, ...extra });
function cache(id, number, source = BINDING_SOURCE_PUSH_REGISTER, age = 0) {
  const store = createDefaultPrSessionBindingCache();
  assert.equal(registerPrSessionBindingRecord(store, { sessionId: id, prNumber: number, repoSlug, source, headSha }, nowMs - age).ok, true);
  return store;
}
function resolve(store, row, openPrs) {
  return resolveSessionPrBindingForConsumer({ store, repoSlug, session: row, openPrs, nowMs, writeBackfill: false });
}

assert.equal(resolveSessionPrBinding(session('url', { prs: [url(1)] }), [pr(1)]).prNumber, 1);
assert.equal(resolveSessionPrBinding(session('empty', { prs: [] }), [pr(1)]).bound, false);
assert.equal(resolveSessionPrBinding(session('many', { prs: [url(1), url(2)] }), [pr(1), pr(2)]).deferReason, 'ambiguous_session_prs');
assert.equal(resolveSessionPrBinding(session('retired', { displayName: '9', prNumber: 9, pr: '#9', prs: [] }), [pr(9)]).bound, false);

assert.equal(resolve(createDefaultPrSessionBindingCache(), session('c1'), []).reason, 'no_source');
assert.equal(resolve(createDefaultPrSessionBindingCache(), session('c2', { prs: [url(2)] }), [pr(2)]).prNumber, 2);
assert.equal(resolve(createDefaultPrSessionBindingCache(), session('c3', { prs: [url(3), url(30)] }), [pr(3), pr(30)]).reason, 'live_ambiguous');
assert.equal(resolve(cache('c4', 4), session('c4'), [pr(4)]).prNumber, 4);
assert.equal(resolve(cache('c5', 5), session('c5', { prs: [url(5)] }), [pr(5)]).reason, 'cache_hit_live_corroborated');
const cacheWins = resolve(cache('c6a', 6), session('c6a', { prs: [url(60)] }), [pr(6), pr(60)]);
assert.equal(cacheWins.prNumber, 6);
assert.equal(cacheWins.diagnostic.loser.source, 'live_prs');
const liveStore = cache('c6b', 6, BINDING_SOURCE_BACKFILL_RESOLVER);
assert.equal(resolve(liveStore, session('c6b', { prs: [url(61)] }), [pr(6), pr(61)]).prNumber, 61);
assert.equal(liveStore.records[buildSessionBindingKey(repoSlug, 'c6b')].prNumber, 61);
assert.equal(resolve(cache('c7', 7), session('c7', { prs: [url(7), url(70)] }), [pr(7), pr(70)]).prNumber, 7);
assert.equal(resolve(cache('c8', 8, BINDING_SOURCE_PUSH_REGISTER, ttlMs + 1), session('c8'), [pr(8)]).reason, 'stale_cache_no_live');
assert.equal(resolve(cache('c9', 9, BINDING_SOURCE_PUSH_REGISTER, ttlMs + 1), session('c9', { prs: [url(90)] }), [pr(9), pr(90)]).prNumber, 90);
assert.equal(resolve(cache('c10', 10, BINDING_SOURCE_PUSH_REGISTER, ttlMs + 1), session('c10', { prs: [url(10), url(100)] }), [pr(10), pr(100)]).reason, 'stale_cache_live_ambiguous');

const sessions = Array.from({ length: 5 }, (_, index) => session(`bulk-${index}`, index === 0 ? { prs: [url(101)] } : {}));
const bulk = resolveWorkerReportTrustedBindings({ sessions, openPrs: [pr(101)], repoSlug, bindingStore: cache('bulk-0', 101), writeBackfill: false });
assert.deepEqual(bulk.callCounts, { bulkSessionList: 1, sessionDetail: 0 });
assert.equal(Object.keys(bulk.bindingByKey).length, 5);
assert.equal(JSON.stringify(bulk).includes('trust_boundary_binding_unresolved'), false);
assert.equal(resolvePrSessionBindingCachePath({ AO_REPORT_STATE_SEED_STATE: 'seed.json' }), 'pr-session-binding-cache.json');
console.log('Issue #857 Node contract matrix: PASS');
