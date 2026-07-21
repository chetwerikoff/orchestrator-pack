import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  branchMatchesIssue,
  captureLeakReason,
  collectOpenPrSnapshot,
  resolveFoundationBinding,
  sanitizeAoSessions,
  sanitizerIdentity,
  validateAoPreflight,
  type AoSessionRow,
  type BindingCacheRecord,
  type OpenPrSnapshotRow,
} from './binding.ts';
import {
  CUTOVER_ROWS,
  FOUNDATION_DOC_ROWS,
  validateEstateSplit,
} from './contracts.ts';
import { DEFAULT_FOUNDATION_CONFIG, parseFoundationConfig } from './config.ts';
import { runSyntheticMigration } from './migration-journal.ts';
import {
  cleanupOwnedFixtureRoot,
  FOUNDATION_RUNTIME_CATALOG,
  validateRuntimeCatalog,
} from './runtime-catalog.ts';
import {
  assertFoundationInert,
  buildDormantScheduler,
  runDormantMergeActuator,
} from './scheduler.ts';
import { createTestRootRegistry } from './test-root.ts';

const testRoots = createTestRootRegistry();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function session(overrides: Partial<AoSessionRow> = {}): AoSessionRow {
  return {
    createdAt: '2026-07-20T00:00:00.000Z',
    harness: 'cursor',
    id: 'session-923',
    isTerminated: false,
    issueId: 923,
    lastActivityAt: '2026-07-20T00:10:00.000Z',
    projectId: 'orchestrator-pack',
    role: 'worker',
    status: 'working',
    updatedAt: '2026-07-20T00:10:00.000Z',
    ...overrides,
  };
}

function openPr(number: number, head = HEAD_A, branch = `issue-${number}`, draft = false): OpenPrSnapshotRow {
  return {
    repoSlug: 'chetwerikoff/orchestrator-pack',
    number,
    state: 'OPEN',
    isDraft: draft,
    headRefName: branch,
    headRefOid: head,
  };
}

function cache(overrides: Partial<BindingCacheRecord> = {}): BindingCacheRecord {
  return {
    sessionId: 'session-923',
    prNumber: 923,
    currentHeadSha: HEAD_A,
    source: 'claim_pr',
    boundAt: '2026-07-20T00:05:00.000Z',
    fresh: true,
    ...overrides,
  };
}

afterEach(() => {
  testRoots.cleanup();
});

describe('[AC1] inert foundation', () => {
  it('keeps scheduler, actuator, registry, supervisor, claims, stores, and starters inert', () => {
    const scheduler = buildDormantScheduler(DEFAULT_FOUNDATION_CONFIG);
    expect(scheduler).toMatchObject({ registered: false, running: false, claimAcquirer: false });
    expect(runDormantMergeActuator(DEFAULT_FOUNDATION_CONFIG)).toEqual({
      ok: true,
      executed: false,
      reason: 'foundation_inert',
    });
    expect(assertFoundationInert({
      registryChanged: false,
      supervisorChanged: false,
      schedulerRegistered: scheduler.registered,
      schedulerRunning: scheduler.running,
      schedulerClaimAcquirer: scheduler.claimAcquirer,
      activationEpochEnforced: false,
      liveStoreOpened: false,
      legacyStarterDisabled: false,
      nonNotificationRuntimeDelta: false,
      notificationTypedConfigLive: true,
      dormantTypedConfigReaderLive: false,
    })).toEqual({ ok: true, result: 'live-acquirers-unchanged' });
  });
});

describe('[AC2] capture-faithful binding', () => {
  it('validates AO 0.10.3 preflight and deterministic sanitization', () => {
    const raw = [session()];
    const sanitizedA = sanitizeAoSessions(raw);
    const sanitizedB = sanitizeAoSessions(raw);
    expect(sanitizedA).toEqual(sanitizedB);
    expect(captureLeakReason(sanitizedA)).toBeNull();
    expect(sanitizerIdentity(sanitizedA)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(validateAoPreflight({
      command: 'ao session ls --json',
      appStateVersion: '0.10.3',
      sessions: raw,
      sanitizerId: sanitizerIdentity(sanitizedA),
    })).toMatchObject({ ok: true, fleetCount: 1 });
    expect(validateAoPreflight({
      command: 'ao session ls --json',
      appStateVersion: '0.10.3',
      sessions: [],
      sanitizerId: 'sha256:test',
    })).toEqual({ ok: false, reason: 'preflight_empty_fleet' });
    expect(validateAoPreflight({
      command: 'ao session ls --json',
      appStateVersion: '0.10.4',
      sessions: raw,
      sanitizerId: 'sha256:test',
    })).toEqual({ ok: false, reason: 'preflight_version_unverifiable' });
  });

  it('performs exactly one configured-repo bulk PR read and fails closed on missing draft evidence', async () => {
    let reads = 0;
    const snapshot = await collectOpenPrSnapshot('chetwerikoff/orchestrator-pack', async () => {
      reads += 1;
      return [openPr(923), openPr(924, HEAD_B, 'issue-924', true)];
    });
    expect(reads).toBe(1);
    expect(snapshot).toHaveLength(2);
    await expect(collectOpenPrSnapshot('chetwerikoff/orchestrator-pack', async () => [{
      ...openPr(923),
      isDraft: undefined,
    }])).rejects.toThrow('invalid_open_pr_snapshot');
  });

  it('accepts only supported branch forms', () => {
    const supported = ['feat/923', 'feat/issue-923', 'opk-923', 'issue-923', 'agent/issue-923-foundation'];
    expect(supported.every((branch) => branchMatchesIssue(branch, 923))).toBe(true);
    expect(branchMatchesIssue('feature/unrelated', 923)).toBe(false);
  });

  it('closes the B1-B10 binding matrix', () => {
    const base = {
      session: session(),
      configuredRepo: 'chetwerikoff/orchestrator-pack',
      now: '2026-07-20T01:00:00.000Z',
    };
    expect(resolveFoundationBinding({ ...base, openPrs: [] })).toMatchObject({ classId: 'B1', bound: false });
    expect(resolveFoundationBinding({ ...base, openPrs: [openPr(923)] })).toMatchObject({ classId: 'B2', bound: true, currentHeadSha: HEAD_A });
    expect(resolveFoundationBinding({ ...base, openPrs: [openPr(923), openPr(923, HEAD_B, 'feat/923')] })).toMatchObject({ classId: 'B3', bound: false, reason: 'live_ambiguous' });
    expect(resolveFoundationBinding({ ...base, openPrs: [], cache: cache() })).toMatchObject({ classId: 'B4', bound: true });
    expect(resolveFoundationBinding({ ...base, openPrs: [openPr(923)], cache: cache() })).toMatchObject({ classId: 'B5', bound: true, corroborated: true });
    expect(resolveFoundationBinding({ ...base, openPrs: [openPr(923, HEAD_B)], cache: cache() })).toMatchObject({ classId: 'B6', bound: true, source: 'claim_pr' });
    expect(resolveFoundationBinding({ ...base, openPrs: [openPr(923), openPr(923, HEAD_B, 'feat/923')], cache: cache() })).toMatchObject({ classId: 'B7', bound: true });
    expect(resolveFoundationBinding({ ...base, openPrs: [], cache: cache({ fresh: false }) })).toMatchObject({ classId: 'B8', bound: false });
    expect(resolveFoundationBinding({ ...base, openPrs: [openPr(923, HEAD_B)], cache: cache({ fresh: false }) })).toMatchObject({ classId: 'B9', bound: true, currentHeadSha: HEAD_B });
    expect(resolveFoundationBinding({ ...base, openPrs: [openPr(923), openPr(923, HEAD_B, 'feat/923')], cache: cache({ fresh: false }) })).toMatchObject({ classId: 'B10', bound: false });
  });
});

describe('[AC3] typed config authority', () => {
  it('defaults only absent optional keys and rejects malformed or unknown values', () => {
    expect(parseFoundationConfig({})).toEqual({ ok: true, config: DEFAULT_FOUNDATION_CONFIG });
    expect(parseFoundationConfig({ notification: { timeoutMs: '30000' } })).toEqual({
      ok: false,
      reason: 'invalid_config',
      path: 'notification.timeoutMs',
    });
    expect(parseFoundationConfig({ scheduler: { surprise: true } })).toEqual({
      ok: false,
      reason: 'unknown_config_key',
      path: 'scheduler.surprise',
    });
    const enabled = parseFoundationConfig({ actuator: { enabled: true } });
    expect(enabled).toMatchObject({ ok: true, config: { actuator: { enabled: true } } });
    expect(runDormantMergeActuator(enabled.ok ? enabled.config : DEFAULT_FOUNDATION_CONFIG).executed).toBe(false);
  });
});

describe('[AC4] pure TypeScript journal-compatible notification', () => {
  it('contains no PowerShell and invokes the canonical dispatch journal CLI', () => {
    const files = [
      'scripts/lib/pack-review-worker-notification.ts',
      'scripts/pr2-foundation/worker-notification.ts',
      'scripts/pr2-foundation/worker-dispatch-journal.ts',
    ];
    const source = files.map((file) => readFileSync(path.join(repoRoot, file), 'utf8')).join('\n');
    expect(source).not.toMatch(/\bpwsh\b/i);
    expect(source).not.toMatch(/\.ps1\b/i);
    expect(source).toContain('worker-message-dispatch-observe.mjs');
    expect(source).toContain('admitDispatchJournalRecord');
    expect(source).toContain('finalizeDispatchJournalRecord');
  });
});

describe('[AC5] synthetic migration journal', () => {
  it.each([
    'before_prepare',
    'after_prepare',
    'before_import',
    'after_import',
    'before_commit',
    'after_commit',
  ] as const)('recovers exactly once after %s', (crashAt) => {
    const root = testRoots.create(`opk-pr2-migration-${crashAt}-`);
    const source = path.join(root, 'source.json');
    const target = path.join(root, 'target.json');
    const journal = path.join(root, 'journal.json');
    writeFileSync(source, '{"records":[1,2,3]}\n', 'utf8');
    const first = runSyntheticMigration({
      journalPath: journal,
      sourcePath: source,
      targetPath: target,
      fixtureRoot: root,
      journalKey: `J-${crashAt}`,
      crashAt,
    });
    expect(first.ok).toBe(false);
    const recovered = runSyntheticMigration({
      journalPath: journal,
      sourcePath: source,
      targetPath: target,
      fixtureRoot: root,
      journalKey: `J-${crashAt}`,
    });
    expect(recovered).toMatchObject({ ok: true, record: { state: 'committed' } });
    expect(readFileSync(target, 'utf8')).toBe('{"records":[1,2,3]}\n');
    const replay = runSyntheticMigration({
      journalPath: journal,
      sourcePath: source,
      targetPath: target,
      fixtureRoot: root,
      journalKey: `J-${crashAt}`,
    });
    expect(replay).toMatchObject({ ok: true, reason: 'already_committed', replayed: true });
  });

  it('rejects torn journals and any live-root import before opening live contents', () => {
    const root = testRoots.create('opk-pr2-migration-negative-');
    const source = path.join(root, 'source.json');
    const target = path.join(root, 'target.json');
    const journal = path.join(root, 'journal.json');
    writeFileSync(source, '{}\n', 'utf8');
    writeFileSync(journal, '{torn', 'utf8');
    expect(runSyntheticMigration({
      journalPath: journal,
      sourcePath: source,
      targetPath: target,
      fixtureRoot: root,
      journalKey: 'J-torn',
    })).toEqual({ ok: false, reason: 'corrupt_journal' });
    const live = testRoots.create('opk-live-store-');
    const liveSource = path.join(live, 'secret.json');
    writeFileSync(liveSource, 'must-not-open', 'utf8');
    expect(runSyntheticMigration({
      journalPath: path.join(root, 'safe-journal.json'),
      sourcePath: liveSource,
      targetPath: path.join(root, 'safe-target.json'),
      fixtureRoot: root,
      liveStoreRoots: [live],
      journalKey: 'J-live',
    })).toEqual({ ok: false, reason: 'foundation_live_import_forbidden' });
  });
});

describe('[AC6] trusted runtime catalog and platform guard', () => {
  it('rejects omissions and classification downgrades', () => {
    expect(validateRuntimeCatalog(FOUNDATION_RUNTIME_CATALOG, FOUNDATION_RUNTIME_CATALOG)).toEqual({ ok: true });
    expect(validateRuntimeCatalog(FOUNDATION_RUNTIME_CATALOG, FOUNDATION_RUNTIME_CATALOG.slice(1))).toMatchObject({
      ok: false,
      reason: 'catalog_surface_omitted',
    });
    const downgraded = FOUNDATION_RUNTIME_CATALOG.map((row) => row.id === 'worker-notification'
      ? { ...row, classification: 'dormant' as const }
      : row);
    expect(validateRuntimeCatalog(FOUNDATION_RUNTIME_CATALOG, downgraded)).toMatchObject({
      ok: false,
      reason: 'candidate_catalog_downgrade',
    });
  });

  it('allows cleanup only for an identity-stable owned regular directory on Linux', () => {
    const root = testRoots.create('opk-pr2-cleanup-');
    const target = path.join(root, 'owned', 'candidate');
    mkdirSync(target, { recursive: true });
    const before = statSync(target);
    expect(cleanupOwnedFixtureRoot({
      target,
      ownedRoot: path.join(root, 'owned'),
      enabled: true,
      platform: 'linux',
      beforeIdentity: { dev: before.dev, ino: before.ino },
    })).toEqual({ ok: true, reason: 'owned_fixture_deleted' });
    expect(existsSync(target)).toBe(false);

    const unsupported = path.join(root, 'owned', 'unsupported');
    mkdirSync(unsupported, { recursive: true });
    expect(cleanupOwnedFixtureRoot({
      target: unsupported,
      ownedRoot: path.join(root, 'owned'),
      enabled: true,
      platform: 'win32',
    })).toEqual({ ok: false, reason: 'unsupported_platform_cleanup_disabled' });
    expect(lstatSync(unsupported).isDirectory()).toBe(true);
  });
});

describe('[AC7] estate split', () => {
  it('validates the real manifest and filesystem denominator', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, 'scripts/estate-cut/issue-906.manifest.json'), 'utf8'),
    ) as { rows?: Array<{ path: string; terminalState: string; replacementOwner?: string }> };
    const denominator = (manifest.rows ?? []).filter((row) =>
      (FOUNDATION_DOC_ROWS as readonly string[]).includes(row.path)
      || (CUTOVER_ROWS as readonly string[]).includes(row.path),
    );
    expect(validateEstateSplit(denominator)).toEqual({ ok: true, result: 'foundation-16-cutover-6' });
    for (const file of FOUNDATION_DOC_ROWS) {
      expect(existsSync(path.join(repoRoot, file))).toBe(false);
    }
    for (const file of CUTOVER_ROWS) {
      expect(existsSync(path.join(repoRoot, file))).toBe(true);
    }
  });
});
