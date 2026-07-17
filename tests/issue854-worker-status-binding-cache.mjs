import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  recomputeWorkerStatusRow,
  resolveWorkerStatusSessionBinding,
} from '../scripts/lib/worker-status-store.mjs';

const NOW_MS = 1_700_000_000_000;
const REPO = 'chetwerikoff/orchestrator-pack';
const SESSION_ID = 'orchestrator-pack-137';
const PR_NUMBER = 887;
const HEAD = 'head887';

function bindingRecord({ ageMs = 1_000, superseded = false } = {}) {
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    prNumber: PR_NUMBER,
    issueNumber: 874,
    headSha: HEAD,
    repoSlug: REPO,
    source: 'push_register',
    lastUpdatedMs: NOW_MS - ageMs,
    superseded,
  };
}

function writeCache(path, options = {}) {
  const record = bindingRecord(options);
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    lastUpdatedMs: record.lastUpdatedMs,
    generation: 45,
    records: {
      [`${REPO}|session:${SESSION_ID}`]: record,
      [`${REPO}|pr:${PR_NUMBER}`]: record,
    },
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
      repoSlug: REPO,
    },
    openPrs: [{
      number: PR_NUMBER,
      state: 'OPEN',
      headRefOid: HEAD,
      headRefName: `ao/${SESSION_ID}/worker-status-cache`,
      repoSlug: REPO,
    }],
    repoSlug: REPO,
    bindingCachePath: cachePath,
    nowMs: NOW_MS,
  };
}

function assertUsableRow(binding) {
  const result = recomputeWorkerStatusRow({
    session: { id: SESSION_ID, status: 'working', repoSlug: REPO },
    binding,
    github: {
      prOpen: true,
      headSha: HEAD,
      reviewRuns: [],
      ciChecks: [],
      requiredCheckNames: [],
      requiredCheckLookupFailed: false,
    },
    osLiveness: { status: 'working' },
    writerGenerationVector: {
      writerSessionId: 'issue-854-regression',
      repoTickGeneration: 10,
      reportStoreGeneration: 20,
      journalCursor: 30,
      bindingCacheGeneration: binding.bindingCacheGeneration,
    },
    nowMs: NOW_MS,
  });

  assert.equal(result.ok, undefined);
  assert.equal(result.sessionId, SESSION_ID);
  assert.equal(result.derivedStatus, 'pr_open');
  assert.equal(result.winningSource, 'github_pr');
  assert.notEqual(result.winningSource, 'degraded');
}

function run() {
  const dir = mkdtempSync(join(tmpdir(), 'opk-854-binding-cache-'));
  try {
    const cachePath = join(dir, 'pr-session-binding-cache.json');

    writeCache(cachePath);
    const binding = resolveWorkerStatusSessionBinding(input(cachePath));
    assert.equal(binding.ok, true);
    assert.equal(binding.prNumber, PR_NUMBER);
    assert.equal(binding.headSha, HEAD);
    assert.equal(binding.bindingSource, 'binding_cache:push_register');
    assert.equal(binding.bindingCacheGeneration, 45);
    assertUsableRow(binding);

    writeCache(cachePath, { ageMs: 8 * 24 * 60 * 60 * 1_000 });
    const expired = resolveWorkerStatusSessionBinding(input(cachePath));
    assert.equal(expired.ok, false);
    assert.equal(expired.reason, 'no_issue_binding');
    assert.doesNotMatch(String(expired.bindingSource), /^binding_cache:/);

    writeCache(cachePath, { superseded: true });
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

    const storedText = readFileSync(cachePath, 'utf8');
    assert.equal(storedText, '{not-json');

    writeCache(cachePath);
    const ambiguousRepo = input(cachePath);
    delete ambiguousRepo.repoSlug;
    delete ambiguousRepo.session.repoSlug;
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

    process.stdout.write(`${JSON.stringify({
      issue: 854,
      productionModule: 'scripts/lib/worker-status-store.mjs',
      cacheSource: 'push_register',
      usableDerivedStatus: 'pr_open',
      winningSource: 'github_pr',
      scenarios: [
        'cache_hit',
        'ttl_expired',
        'superseded',
        'unreadable',
        'unreadable_no_legacy_fallback',
        'multi_repo_ambiguous',
      ],
    })}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

run();
