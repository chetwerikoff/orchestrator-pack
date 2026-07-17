import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDefaultWorkerStatusStore,
  mergeGenerationVectorMax,
  recomputeWorkerStatusRow,
  resolveWorkerStatusSessionBinding,
  shouldReloadMixedGeneration,
} from '../scripts/lib/worker-status-store.mjs';

const NOW_MS = 1_700_000_000_000;
const REPO = 'chetwerikoff/orchestrator-pack';
const SESSION_ID = 'orchestrator-pack-137';
const PR_TARGET = 887;
const PR_UNRELATED = 869;
const HEAD = '667d79d8de35a5dcc4d70874c4326c4b06f35768';

type BindingRecord = {
  schemaVersion: number;
  sessionId: string;
  prNumber: number;
  issueNumber: number;
  headSha: string;
  repoSlug: string;
  source: string;
  lastUpdatedMs: number;
  superseded: boolean;
};

function writeBindingCache(cachePath: string, records: BindingRecord[], generation = 45) {
  const recordMap: Record<string, BindingRecord> = {};
  for (const record of records) {
    recordMap[`${record.repoSlug}|session:${record.sessionId}`] = record;
    recordMap[`${record.repoSlug}|pr:${record.prNumber}`] = record;
  }
  writeFileSync(cachePath, `${JSON.stringify({
    schemaVersion: 1,
    lastUpdatedMs: Math.max(...records.map((record) => record.lastUpdatedMs)),
    generation,
    records: recordMap,
  })}\n`);
}

function targetRecord(overrides: Partial<BindingRecord> = {}): BindingRecord {
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    prNumber: PR_TARGET,
    issueNumber: 874,
    headSha: HEAD,
    repoSlug: REPO,
    source: 'push_register',
    lastUpdatedMs: NOW_MS - 1_000,
    superseded: false,
    ...overrides,
  };
}

function liveRecomputeInput({
  cachePath,
  stateDirCachePath,
  repoSlug = REPO,
  cwd = '/tmp/non-checkout-cwd',
  sessionStatus = 'merged',
  osLiveness = { status: 'pane-gone', dead: true },
  openPrOrder = [PR_UNRELATED, PR_TARGET] as number[],
  existingRow = null as Record<string, unknown> | null,
  writerGenerationVector = {
    repoTickGeneration: 5,
    reportStoreGeneration: 217,
    journalCursor: 30,
    bindingCacheGeneration: 0,
  },
}) {
  const openPrs = openPrOrder.map((number) => ({
    number,
    state: 'OPEN',
    headRefOid: number === PR_TARGET ? HEAD : `head${number}`,
    headRefName: number === PR_TARGET
      ? `ao/${SESSION_ID}/worker-status-cache`
      : `agent/issue-${number}`,
  }));
  const store = existingRow
    ? createDefaultWorkerStatusStore({ records: { [SESSION_ID]: existingRow } })
    : undefined;
  return {
    session: {
      id: SESSION_ID,
      sessionId: SESSION_ID,
      role: 'worker',
      status: sessionStatus,
      issueId: 874,
      displayName: '874',
    },
    openPrs,
    githubSnapshot: { openPrs },
    repoSlug,
    bindingCachePath: cachePath,
    cwd,
    nowMs: NOW_MS,
    osLiveness,
    env: {
      AO_PR_SESSION_BINDING_CACHE: cachePath,
      ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR: stateDirCachePath,
    },
    store,
    writerGenerationVector,
    github: {
      prOpen: true,
      headSha: HEAD,
      reviewRuns: [],
      ciChecks: [],
      requiredCheckNames: [],
      requiredCheckLookupFailed: false,
    },
  };
}

describe('issue #854 live recompute binding cache (AC4 shape)', () => {
  it('resolves the target PR even when an unrelated open PR is iterated first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-854-order-'));
    try {
      const cachePath = join(dir, 'authoritative-cache.json');
      writeBindingCache(cachePath, [targetRecord()]);
      const binding = resolveWorkerStatusSessionBinding(liveRecomputeInput({
        cachePath,
        stateDirCachePath: join(dir, 'state-dir-miss'),
        openPrOrder: [PR_UNRELATED, PR_TARGET],
      }));
      expect(binding.ok).toBe(true);
      expect(binding.prNumber).toBe(PR_TARGET);
      expect(binding.bindingSource).toBe('binding_contract:cache');
      expect(binding.bindingCacheGeneration).toBe(45);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors AO_PR_SESSION_BINDING_CACHE over supervisor state-dir precedence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-854-precedence-'));
    try {
      const authoritativeCache = join(dir, 'authoritative-cache.json');
      const staleStateDir = join(dir, 'state-dir');
      writeBindingCache(authoritativeCache, [targetRecord()]);
      writeBindingCache(join(staleStateDir, 'pr-session-binding-cache.json'), [
        targetRecord({ sessionId: 'orchestrator-pack-999', prNumber: 999 }),
      ]);
      const binding = resolveWorkerStatusSessionBinding(liveRecomputeInput({
        cachePath: authoritativeCache,
        stateDirCachePath: staleStateDir,
      }));
      expect(binding.ok).toBe(true);
      expect(binding.prNumber).toBe(PR_TARGET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('threads authoritative repoSlug without checkout cwd metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-854-slug-'));
    try {
      const cachePath = join(dir, 'cache.json');
      writeBindingCache(cachePath, [targetRecord()]);
      const binding = resolveWorkerStatusSessionBinding(liveRecomputeInput({
        cachePath,
        stateDirCachePath: dir,
        repoSlug: REPO,
        cwd: '/tmp/non-checkout-cwd',
      }));
      expect(binding.ok).toBe(true);
      expect(binding.repoSlug).toBe(REPO);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses real OS liveness for terminated subjects and escapes degraded binding miss', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-854-liveness-'));
    try {
      const cachePath = join(dir, 'cache.json');
      writeBindingCache(cachePath, [targetRecord()]);
      const input = liveRecomputeInput({
        cachePath,
        stateDirCachePath: dir,
        sessionStatus: 'merged',
        osLiveness: { status: 'pane-gone', dead: true },
      });
      const binding = resolveWorkerStatusSessionBinding(input);
      expect(binding.ok).toBe(true);
      const row = recomputeWorkerStatusRow({ ...input, binding });
      expect(row.winningSource).toBe('os_liveness');
      expect(row.derivedStatus).toBe('dead');
      expect(row.degradedReason).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves bindingCacheGeneration across mixed-generation reload', () => {
    const existing = {
      sessionId: SESSION_ID,
      status: 'unknown',
      derivedStatus: 'unknown',
      winningSource: 'degraded',
      degradedReason: 'no_issue_binding',
      generationVector: {
        repoTickGeneration: 10,
        reportStoreGeneration: 5,
        reviewRunGeneration: 5,
        githubGeneration: 1,
        bindingCacheGeneration: 5,
      },
      lastUpdatedMs: NOW_MS - 60_000,
    };
    const writer = {
      repoTickGeneration: 5,
      reportStoreGeneration: 10,
      reviewRunGeneration: 5,
      githubGeneration: 1,
      bindingCacheGeneration: 46,
    };
    expect(shouldReloadMixedGeneration(existing, writer)).toBe(true);
    expect(mergeGenerationVectorMax(existing, writer)).toMatchObject({
      repoTickGeneration: 10,
      reportStoreGeneration: 10,
      bindingCacheGeneration: 46,
    });

    const dir = mkdtempSync(join(tmpdir(), 'opk-854-mixed-'));
    try {
      const cachePath = join(dir, 'cache.json');
      writeBindingCache(cachePath, [targetRecord()], 46);
      const input = liveRecomputeInput({
        cachePath,
        stateDirCachePath: dir,
        sessionStatus: 'working',
        osLiveness: { status: 'working', dead: false },
        existingRow: existing,
        writerGenerationVector: writer,
      });
      const binding = resolveWorkerStatusSessionBinding(input);
      expect(binding.ok).toBe(true);
      const result = recomputeWorkerStatusRow({ ...input, binding });
      expect(result.ok).toBe(true);
      expect(result.reloadedMixedGeneration).toBe(true);
      expect(result.row?.generationVector?.bindingCacheGeneration).toBe(46);
      expect(result.row?.winningSource).toBe('github_pr');
      expect(result.row?.derivedStatus).toBe('pr_open');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
