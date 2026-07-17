import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BINDING_SOURCE_BACKFILL_RESOLVER,
  BINDING_SOURCE_CLAIM_PR,
  BINDING_SOURCE_PUSH_REGISTER,
  DEFAULT_BINDING_MAX_RECORDS,
  PR_SESSION_BINDING_CACHE_SCHEMA_VERSION,
  buildPrBindingKey,
  buildSessionBindingKey,
  createDefaultPrSessionBindingCache,
  evictPrSessionBindings,
  isGhPrCreateArgv,
  lookupBindingByPr,
  lookupBindingBySession,
  parsePrNumberFromGhPrCreateOutput,
  readPrSessionBindingCacheFile,
  registerPrSessionBindingRecord,
  resolvePrSessionBindingForConsumer,
  writePrSessionBindingCacheFile,
  writePrSessionBindingCacheFileWithCas,
} from '../docs/pr-session-binding-cache.mjs';

const resolveBinding = resolvePrSessionBindingForConsumer as unknown as (
  input: Record<string, unknown>,
) => any;
const repoSlug = 'chetwerikoff/orchestrator-pack';
const nowMs = Date.parse('2026-07-17T12:00:00Z');
const dayMs = 24 * 60 * 60 * 1000;
const tempDirs: string[] = [];

const headFor = (number: number) => number.toString(16).padStart(40, '0');
const prUrl = (number: number) => `https://github.com/${repoSlug}/pull/${number}`;
const openPr = (number: number, head = headFor(number), state = 'OPEN') => ({
  number,
  headRefOid: head,
  headRefName: `issue-${number}`,
  state,
  repoSlug,
});
const worker = (
  id: string,
  issueNumber: number,
  prs: string[] = [],
  extra: Record<string, unknown> = {},
) => ({
  id,
  sessionId: id,
  name: id,
  role: 'worker',
  status: 'working',
  issueNumber,
  branch: `issue-${issueNumber}`,
  repoSlug,
  prs,
  ...extra,
});

function cachePath(name = 'cache.json'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'opk-857-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function seededStore(
  source: any,
  sessionId = 'cache-owner',
  prNumber = 901,
  updatedAt = nowMs,
) {
  const store = createDefaultPrSessionBindingCache();
  const result = registerPrSessionBindingRecord(
    store,
    {
      sessionId,
      prNumber,
      repoSlug,
      headSha: headFor(prNumber),
      source,
    },
    updatedAt,
  );
  expect(result.ok).toBe(true);
  return store;
}

function resolve(input: {
  store?: any;
  cachePath?: string;
  sessions?: Array<Record<string, unknown>>;
  openPrs?: Array<Record<string, unknown>>;
  prNumber?: number;
  sessionId?: string;
  headSha?: string;
  nowMs?: number;
  writeBackfill?: boolean;
  openListAuthoritative?: boolean;
}) {
  return resolveBinding({
    repoSlug,
    prNumber: input.prNumber ?? 901,
    sessionId: input.sessionId ?? '',
    headSha: input.headSha ?? (input.prNumber === 0 ? '' : headFor(901)),
    sessions: input.sessions ?? [],
    openPrs: input.openPrs ?? [],
    nowMs: input.nowMs ?? nowMs,
    writeBackfill: input.writeBackfill ?? true,
    isLive: () => true,
    ...('store' in input ? { store: input.store } : {}),
    ...('cachePath' in input ? { cachePath: input.cachePath } : {}),
    ...('openListAuthoritative' in input
      ? { openListAuthoritative: input.openListAuthoritative }
      : {}),
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('10-cell cache × live binding matrix', () => {
  it('1 absent × absent => no_source', () => {
    expect(resolve({ store: createDefaultPrSessionBindingCache() })).toMatchObject({
      failClosed: true,
      reason: 'no_source',
    });
  });

  it('2 absent × live => live binding plus durable backfill', () => {
    const file = cachePath();
    const result = resolve({
      cachePath: file,
      sessions: [worker('live-owner', 901, [prUrl(901)])],
      openPrs: [openPr(901)],
    });

    expect(result).toMatchObject({
      failClosed: false,
      reason: 'live_hit_backfilled',
      source: 'live_prs',
      sessionId: 'live-owner',
      prNumber: 901,
    });
    expect(lookupBindingByPr(readPrSessionBindingCacheFile(file), repoSlug, 901)?.sessionId)
      .toBe('live-owner');
  });

  it('3 absent × ambiguous => live_ambiguous with attributable session', () => {
    const result = resolve({
      store: createDefaultPrSessionBindingCache(),
      sessions: [worker('live-owner', 901, [prUrl(901), prUrl(902)])],
      openPrs: [openPr(901), openPr(902)],
    });

    expect(result).toMatchObject({
      failClosed: true,
      reason: 'live_ambiguous',
      sessionId: 'live-owner',
    });
  });

  it('4 live cache × absent => cache', () => {
    expect(resolve({
      store: seededStore(BINDING_SOURCE_PUSH_REGISTER),
      openPrs: [openPr(901)],
    })).toMatchObject({
      failClosed: false,
      reason: 'cache_hit',
      sessionId: 'cache-owner',
    });
  });

  it('5 live cache × live agree => cache corroborated', () => {
    expect(resolve({
      store: seededStore(BINDING_SOURCE_PUSH_REGISTER),
      sessions: [worker('cache-owner', 901, [prUrl(901)])],
      openPrs: [openPr(901)],
    })).toMatchObject({
      reason: 'cache_hit_live_corroborated',
      liveCorroborated: true,
      sessionId: 'cache-owner',
    });
  });

  it('6 live cache × live conflict => source ladder records loser', () => {
    const pushWins = resolve({
      store: seededStore(BINDING_SOURCE_PUSH_REGISTER),
      sessions: [worker('live-owner', 901, [prUrl(901)])],
      openPrs: [openPr(901)],
    });
    expect(pushWins.reason).toBe('cache_won_conflict');
    expect(pushWins.sessionId).toBe('cache-owner');
    expect(pushWins.diagnostics[0]).toMatch(/^losing_live:/);

    const file = cachePath('conflict.json');
    writePrSessionBindingCacheFile(
      file,
      seededStore(BINDING_SOURCE_BACKFILL_RESOLVER),
    );
    const liveWins = resolve({
      cachePath: file,
      sessions: [worker('live-owner', 901, [prUrl(901)])],
      openPrs: [openPr(901)],
    });
    expect(liveWins.reason).toBe('live_won_conflict');
    expect(liveWins.sessionId).toBe('live-owner');
    expect(liveWins.diagnostics[0]).toMatch(/^losing_cache:/);
    const stored = readPrSessionBindingCacheFile(file);
    expect(lookupBindingByPr(stored, repoSlug, 901)?.sessionId).toBe('live-owner');
    expect(stored.records[buildSessionBindingKey(repoSlug, 'cache-owner')]?.superseded)
      .toBe(true);
  });

  it('7 live cache × ambiguous live => cache plus diagnostic', () => {
    const result = resolve({
      store: seededStore(BINDING_SOURCE_CLAIM_PR),
      sessions: [worker('live-owner', 901, [prUrl(901), prUrl(902)])],
      openPrs: [openPr(901), openPr(902)],
    });
    expect(result.reason).toBe('cache_hit_live_ambiguous');
    expect(result.sessionId).toBe('cache-owner');
    expect(result.diagnostics[0]).toMatch(/^live_ambiguous:/);
  });

  it('8 stale cache × absent => stale_cache_no_live and eviction', () => {
    const file = cachePath('stale.json');
    writePrSessionBindingCacheFile(
      file,
      seededStore(BINDING_SOURCE_PUSH_REGISTER, 'old-owner', 901, nowMs - 8 * dayMs),
    );
    const result = resolve({ cachePath: file });
    expect(result.reason).toBe('stale_cache_no_live');
    expect(lookupBindingByPr(readPrSessionBindingCacheFile(file), repoSlug, 901)).toBeNull();
  });

  it('9 stale cache × live => live replaces stale cache atomically', () => {
    const file = cachePath('stale-live.json');
    writePrSessionBindingCacheFile(
      file,
      seededStore(BINDING_SOURCE_PUSH_REGISTER, 'old-owner', 901, nowMs - 8 * dayMs),
    );
    const result = resolve({
      cachePath: file,
      sessions: [worker('live-owner', 901, [prUrl(901)])],
      openPrs: [openPr(901)],
    });
    expect(result.reason).toBe('stale_cache_replaced_by_live');
    expect(result.sessionId).toBe('live-owner');
    expect(lookupBindingByPr(readPrSessionBindingCacheFile(file), repoSlug, 901)?.sessionId)
      .toBe('live-owner');
  });

  it('10 stale cache × ambiguous live => stale_cache_live_ambiguous and eviction', () => {
    const file = cachePath('stale-ambiguous.json');
    writePrSessionBindingCacheFile(
      file,
      seededStore(BINDING_SOURCE_PUSH_REGISTER, 'old-owner', 901, nowMs - 8 * dayMs),
    );
    const result = resolve({
      cachePath: file,
      sessions: [worker('live-owner', 901, [prUrl(901), prUrl(902)])],
      openPrs: [openPr(901), openPr(902)],
    });
    expect(result).toMatchObject({
      reason: 'stale_cache_live_ambiguous',
      sessionId: 'live-owner',
    });
    expect(lookupBindingByPr(readPrSessionBindingCacheFile(file), repoSlug, 901)).toBeNull();
  });
});

describe('bidirectional and lifecycle contract', () => {
  it('resolves session → PR through the same cache entry point', () => {
    const result = resolve({
      store: seededStore(BINDING_SOURCE_PUSH_REGISTER, 'opk-1', 901),
      prNumber: 0,
      sessionId: 'opk-1',
      sessions: [worker('opk-1', 901, [prUrl(901)])],
      openPrs: [openPr(901)],
      headSha: '',
    });
    expect(result).toMatchObject({ sessionId: 'opk-1', prNumber: 901, failClosed: false });
  });

  it('treats terminal PR rows as stale without requiring authoritative omission', () => {
    const result = resolve({
      store: seededStore(BINDING_SOURCE_PUSH_REGISTER),
      openPrs: [openPr(901, headFor(901), 'MERGED')],
    });
    expect(result.reason).toBe('stale_cache_no_live');
  });

  it('keeps cache keys repo-scoped and schema v1 compatible', () => {
    const store = seededStore(BINDING_SOURCE_PUSH_REGISTER, 'opk-1', 901);
    expect(PR_SESSION_BINDING_CACHE_SCHEMA_VERSION).toBe(1);
    expect(store.schemaVersion).toBe(1);
    expect(store.records[buildPrBindingKey(repoSlug, 901)]).toBeDefined();
    expect(store.records[buildSessionBindingKey(repoSlug, 'opk-1')]).toBeDefined();
    expect(lookupBindingBySession(store, 'other/repo', 'opk-1')).toBeNull();
  });

  it('rejects stale-generation CAS writes', () => {
    const file = cachePath('cas.json');
    const initial = seededStore(BINDING_SOURCE_PUSH_REGISTER, 'opk-1', 901);
    writePrSessionBindingCacheFile(file, initial);
    const stale = readPrSessionBindingCacheFile(file);
    const concurrent = readPrSessionBindingCacheFile(file);
    concurrent.generation += 1;
    writePrSessionBindingCacheFile(file, concurrent);
    expect(writePrSessionBindingCacheFileWithCas(file, stale, stale.generation)).toMatchObject({
      ok: false,
      reason: 'generation_mismatch',
    });
  });

  it('evicts stale rows and stays within the bounded-memory cap under soak', () => {
    const store = createDefaultPrSessionBindingCache();
    for (let index = 1; index <= 900; index += 1) {
      registerPrSessionBindingRecord(
        store,
        {
          sessionId: `opk-${index}`,
          prNumber: index,
          repoSlug,
          headSha: headFor(index),
          source: BINDING_SOURCE_BACKFILL_RESOLVER,
          maxRecords: DEFAULT_BINDING_MAX_RECORDS,
        },
        nowMs + index,
      );
    }
    expect(Object.keys(store.records).length).toBeLessThanOrEqual(DEFAULT_BINDING_MAX_RECORDS);

    const summary = evictPrSessionBindings({
      store,
      openPrs: [],
      nowMs: nowMs + 10 * dayMs,
      openListAuthoritative: true,
      repoSlug,
    });
    expect(summary.recordCount).toBe(0);
  });
});

describe('push-register compatibility', () => {
  it('parses gh pr create output and argv without changing the write hook surface', () => {
    expect(parsePrNumberFromGhPrCreateOutput(
      `https://github.com/${repoSlug}/pull/901\n`,
      '',
    )).toBe(901);
    expect(isGhPrCreateArgv(['pr', 'create', '--title', 'x'])).toBe(true);
    expect(isGhPrCreateArgv(['pr', 'view', '901'])).toBe(false);
  });

  it('writes newline-terminated schema-compatible JSON', () => {
    const file = cachePath('format.json');
    writePrSessionBindingCacheFile(
      file,
      seededStore(BINDING_SOURCE_PUSH_REGISTER, 'opk-1', 901),
    );
    const raw = readFileSync(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw).schemaVersion).toBe(1);
  });
});
