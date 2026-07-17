import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveWorkerStatusSessionBinding } from '../scripts/lib/worker-status-store.mjs';

const NOW_MS = 1_700_000_000_000;
const REPO = 'chetwerikoff/orchestrator-pack';
const OTHER_REPO = 'owner/other';
const SESSION_ID = 'orchestrator-pack-137';
const PR_NUMBER = 887;
const HEAD = 'head887';

function bindingRecord({
  repoSlug = REPO,
  ageMs = 1_000,
  superseded = false,
  source = 'push_register',
} = {}) {
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    prNumber: PR_NUMBER,
    issueNumber: 874,
    headSha: HEAD,
    repoSlug,
    source,
    lastUpdatedMs: NOW_MS - ageMs,
    superseded,
  };
}

function writeCache(path, records = [bindingRecord()]) {
  const recordMap = {};
  for (const record of records) {
    recordMap[`${record.repoSlug}|session:${record.sessionId}`] = record;
    recordMap[`${record.repoSlug}|pr:${record.prNumber}`] = record;
  }
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    lastUpdatedMs: Math.max(...records.map((record) => record.lastUpdatedMs)),
    generation: 45,
    records: recordMap,
  })}\n`, 'utf8');
}

function input(cachePath) {
  return {
    session: {
      id: SESSION_ID,
      sessionId: SESSION_ID,
      role: 'worker',
      status: 'working',
      issueId: 874,
      displayName: '874',
    },
    openPrs: [{
      number: PR_NUMBER,
      state: 'OPEN',
      headRefOid: HEAD,
      headRefName: `ao/${SESSION_ID}/worker-status-cache`,
    }],
    env: { GITHUB_REPOSITORY: REPO },
    bindingCachePath: cachePath,
    nowMs: NOW_MS,
  };
}

function assertCacheHit(binding) {
  assert.equal(binding.ok, true);
  assert.equal(binding.prNumber, PR_NUMBER);
  assert.equal(binding.headSha, HEAD);
  assert.equal(binding.repoSlug, REPO);
  assert.equal(binding.bindingSource, 'binding_contract:cache');
  assert.equal(binding.bindingCacheGeneration, 45);
}

function run() {
  const dir = mkdtempSync(join(tmpdir(), 'opk-854-binding-cache-'));
  try {
    const cachePath = join(dir, 'pr-session-binding-cache.json');

    writeCache(cachePath);
    assertCacheHit(resolveWorkerStatusSessionBinding(input(cachePath)));

    writeCache(cachePath, [bindingRecord({ ageMs: 8 * 24 * 60 * 60 * 1_000 })]);
    const expired = resolveWorkerStatusSessionBinding(input(cachePath));
    assert.equal(expired.ok, false);
    assert.equal(expired.reason, 'no_issue_binding');
    assert.equal(expired.bindingSource, 'binding_contract:none');

    writeCache(cachePath, [bindingRecord({ superseded: true })]);
    const superseded = resolveWorkerStatusSessionBinding(input(cachePath));
    assert.equal(superseded.ok, false);
    assert.equal(superseded.reason, 'no_issue_binding');

    writeFileSync(cachePath, '{not-json', 'utf8');
    const unreadable = resolveWorkerStatusSessionBinding(input(cachePath));
    assert.equal(unreadable.ok, false);
    assert.equal(unreadable.reason, 'binding_cache_read_failed');
    assert.equal(unreadable.bindingSource, 'none');

    const legacyResolvable = input(cachePath);
    legacyResolvable.session.issueId = PR_NUMBER;
    legacyResolvable.session.displayName = String(PR_NUMBER);
    legacyResolvable.openPrs[0].headRefName = `issue-${PR_NUMBER}`;
    const unreadableNoLegacyFallback = resolveWorkerStatusSessionBinding(legacyResolvable);
    assert.equal(unreadableNoLegacyFallback.ok, false);
    assert.equal(unreadableNoLegacyFallback.reason, 'binding_cache_read_failed');
    assert.equal(unreadableNoLegacyFallback.bindingSource, 'none');
    assert.equal(readFileSync(cachePath, 'utf8'), '{not-json');

    writeCache(cachePath);
    const ambiguousRepo = input(cachePath);
    ambiguousRepo.env = {};
    ambiguousRepo.openPrs = [
      {
        number: PR_NUMBER,
        state: 'OPEN',
        headRefOid: HEAD,
        repoSlug: 'owner/first',
      },
      {
        number: PR_NUMBER + 1,
        state: 'OPEN',
        headRefOid: 'head888',
        repoSlug: 'owner/second',
      },
    ];
    const ambiguous = resolveWorkerStatusSessionBinding(ambiguousRepo);
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.reason, 'binding_cache_repo_ambiguous');
    assert.equal(ambiguous.bindingSource, 'none');

    writeCache(cachePath, [
      bindingRecord(),
      bindingRecord({
        repoSlug: OTHER_REPO,
        ageMs: 8 * 24 * 60 * 60 * 1_000,
        source: 'backfill_resolver',
      }),
    ]);
    const staleOtherRepo = input(cachePath);
    assertCacheHit(resolveWorkerStatusSessionBinding(staleOtherRepo));

    process.stdout.write(`${JSON.stringify({
      issue: 854,
      productionModule: 'scripts/lib/worker-status-store.mjs',
      sharedResolver: 'resolvePrSessionBindingForConsumer',
      cacheSource: 'push_register',
      scenarios: [
        'shared_cache_hit',
        'ttl_expired',
        'superseded',
        'unreadable',
        'unreadable_no_legacy_fallback',
        'multi_repo_ambiguous',
        'stale_other_repo_not_ambiguous',
      ],
    })}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

run();