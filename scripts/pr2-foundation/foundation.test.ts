import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  branchMatchesIssue,
  captureLeakReason,
  collectOpenPrSnapshot,
  resolveFoundationBinding,
  sanitizeRuntimeWorkers,
  sanitizerIdentity,
  validateRuntimePreflight,
  type RuntimeWorkerRow,
  type BindingCacheRecord,
  type OpenPrSnapshotRow,
} from './binding.ts';
import { FileEpochAuthority } from '../lib/cutover/activation-epoch-authority.ts';
import { productionActivationBoundary } from '../lib/cutover/activation-transaction.ts';
import { foundationEvidenceDigest, writeDurableJson } from '../lib/cutover/activation-evidence.ts';
import {
  canonicalFoundationPaths,
  FOUNDATION_MIGRATION_JOURNAL_DIRECTORY,
  FOUNDATION_MIGRATION_JOURNAL_SUFFIX,
  observeFoundationInertProof,
  observeGreenfieldMigrationJournalAbsence,
  observeLocalHeartbeat,
} from '../lib/cutover/foundation-observation.ts';
import type { ActivationRequest, FoundationAdmissionEvidence } from '../lib/cutover/types.ts';
import { FOUNDATION_COMMIT } from '../pr2a/contracts.ts';
import { produceFoundationAdoptionEvidence } from '../cutover/foundation-adoption-producer.ts';
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

vi.mock('../lib/cutover/activation-cordon.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/cutover/activation-cordon.ts')>();
  return {
    ...actual,
    findLegacySupervisorIdentities: () => [],
    findTypeScriptSupervisorIdentities: () => [],
  };
});

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function session(overrides: Partial<RuntimeWorkerRow> = {}): RuntimeWorkerRow {
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
    const sanitizedA = sanitizeRuntimeWorkers(raw);
    const sanitizedB = sanitizeRuntimeWorkers(raw);
    expect(sanitizedA).toEqual(sanitizedB);
    expect(captureLeakReason(sanitizedA)).toBeNull();
    expect(sanitizerIdentity(sanitizedA)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(validateRuntimePreflight({
      command: 'a\u006f session ls --json',
      appStateVersion: '0.10.3',
      sessions: raw,
      sanitizerId: sanitizerIdentity(sanitizedA),
    })).toMatchObject({ ok: true, fleetCount: 1 });
    expect(validateRuntimePreflight({
      command: 'a\u006f session ls --json',
      appStateVersion: '0.10.3',
      sessions: [],
      sanitizerId: 'sha256:test',
    })).toEqual({ ok: false, reason: 'preflight_empty_fleet' });
    expect(validateRuntimePreflight({
      command: 'a\u006f session ls --json',
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
  const source = [
    'scripts/lib/pack-review-worker-notification.ts',
    'scripts/pr2-foundation/worker-notification.ts',
    'scripts/pr2-foundation/worker-dispatch-journal.ts',
  ].map((file) => readFileSync(path.join(repoRoot, file), 'utf8')).join('\n');
  for (const forbidden of [/\bpwsh\b/i, /\.ps1\b/i]) {
    expect(source).not.toMatch(forbidden);
  }
  for (const required of [
    'worker-message-dispatch-observe',
    'admitDispatchJournalRecord',
    'finalizeDispatchJournalRecord',
  ]) {
    expect(source).toContain(required);
  }
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

  it.each(['prepared', 'imported', 'committed'] as const)(
    'refuses a canonical greenfield migration journal in %s state',
    (state) => {
      const root = testRoots.create(`opk-greenfield-journal-${state}-`);
      const journalDirectory = path.join(root, FOUNDATION_MIGRATION_JOURNAL_DIRECTORY);
      mkdirSync(journalDirectory, { recursive: true });
      writeJson(path.join(journalDirectory, `migration${FOUNDATION_MIGRATION_JOURNAL_SUFFIX}`), {
        schemaVersion: 1,
        journalKey: `greenfield-${state}`,
        sourcePath: path.join(root, 'source.json'),
        targetPath: path.join(root, 'target.json'),
        sourceDigest: 'sha256:source',
        ...(state === 'imported' || state === 'committed' ? { importedDigest: 'sha256:target' } : {}),
        archiveIdentity: 'sha256:archive',
        state,
        preparedAt: '2026-08-16T00:00:00.000Z',
        ...(state === 'imported' || state === 'committed'
          ? { importedAt: '2026-08-16T00:00:01.000Z' }
          : {}),
        ...(state === 'committed' ? { committedAt: '2026-08-16T00:00:02.000Z' } : {}),
      });
      expect(() => observeGreenfieldMigrationJournalAbsence(root))
        .toThrow('greenfield_migration_journal_present');
    },
  );

  it('refuses a recognizable but corrupt canonical greenfield migration journal', () => {
    const root = testRoots.create('opk-greenfield-journal-corrupt-');
    const journalDirectory = path.join(root, FOUNDATION_MIGRATION_JOURNAL_DIRECTORY);
    mkdirSync(journalDirectory, { recursive: true });
    writeFileSync(
      path.join(journalDirectory, `migration${FOUNDATION_MIGRATION_JOURNAL_SUFFIX}`),
      '{torn',
      'utf8',
    );
    expect(() => observeGreenfieldMigrationJournalAbsence(root))
      .toThrow('foundation_migration_journal_unobservable');
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
    expect(validateEstateSplit(denominator)).toEqual({ ok: true, result: 'foundation-15-cutover-6' });
    for (const file of FOUNDATION_DOC_ROWS) {
  const source = path.join(repoRoot, file);
  expect(existsSync(source), file).toBe(true);
}
    for (const file of CUTOVER_ROWS) {
      const row = denominator.find((candidate) => candidate.path === file);
      expect(row, file).toBeTruthy();
      expect(row?.terminalState, file).toBe('cutover-terminalized');
    }
  });
});

describe('[AC2] production foundation admission', () => {
  it('produces and independently admits clean greenfield evidence with a stale source mtime', async () => {
    const home = mkdtempSync(path.join(repoRoot, '.opk-1422-greenfield-home-'));
    const user = os.userInfo();
    vi.spyOn(os, 'userInfo').mockReturnValue({ ...user, homedir: home });
    const previousPath = process.env.PATH;
    const previousOverride = process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
    const previousAdapter = process.env.OPK_RUNTIME_ADAPTER;
    const sourcePath = path.join(repoRoot, 'scripts', 'pr2-foundation', 'config.ts');
    const sourceStat = statSync(sourcePath);
    const bin = path.join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    const runtimeCli = path.join(bin, 'orca');
    writeFileSync(runtimeCli, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({
      ok: true,
      result: {
        worktree: {
          path: repoRoot,
          head: '0'.repeat(40),
          linkedIssue: 1422,
        },
      },
    }))});\n`);
    chmodSync(runtimeCli, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
    delete process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
    delete process.env.OPK_RUNTIME_ADAPTER;
    try {
      utimesSync(sourcePath, new Date(Date.now() - 24 * 60 * 60_000), new Date(Date.now() - 24 * 60 * 60_000));
      const canonical = canonicalFoundationPaths(repoRoot);
      const paths = {
        stateRoot: canonical.stateRoot,
        stateDir: canonical.stateRoot,
        cordonPath: canonical.cordonPath,
        phaseOnePath: canonical.phaseOnePath,
        followupPath: canonical.followupPath,
        epochAuthorityPath: canonical.epochAuthorityPath,
        targetRegistryPath: path.join(repoRoot, 'scripts', 'orchestrator-side-process-registry.json'),
        projectedRegistryPath: canonical.projectedRegistryPath,
        snapshotDir: canonical.snapshotDir,
        supervisorStateDir: canonical.supervisorStateDir,
        foundationEvidencePath: canonical.evidencePath,
        configPath: canonical.configPath,
        appStatePath: canonical.appStatePath,
      };
      const hostId = os.hostname().trim();
      const result = await produceFoundationAdoptionEvidence({
        repoRoot,
        stateDir: canonical.stateRoot,
        configPath: canonical.configPath,
        appStatePath: canonical.appStatePath,
      });
      expect(result.evidence.greenfieldObservation?.mode).toBe('greenfield-observed');
      expect('appStateVersion' in result.evidence.preflight).toBe(false);
      expect(result.evidence.heartbeats[0]?.observedAt).toBeTruthy();
      const request = {
        epochId: 'greenfield-test-epoch',
        expectedOldEpochId: null,
        installedCommitSha: '0'.repeat(40),
        oldInstalledRevisionRoot: repoRoot,
        repoRoot,
        hostId,
        knownMemberRoster: [{ hostId }],
        paths,
      } as unknown as ActivationRequest;
      await expect(productionActivationBoundary.proveFoundationAdoption(request)).resolves.toMatchObject({
        activationMode: 'greenfield',
      });

      const tampered = {
        ...result.evidence,
        preflight: { ...result.evidence.preflight, appStateVersion: '0.10.4' },
      };
      const { observationDigest: _observationDigest, ...unsignedTampered } = tampered;
      writeDurableJson(canonical.evidencePath, {
        ...unsignedTampered,
        observationDigest: foundationEvidenceDigest(unsignedTampered),
      });
      await expect(productionActivationBoundary.proveFoundationAdoption(request))
        .rejects.toThrow('foundation_greenfield_artifact_claim_invalid');
    } finally {
      utimesSync(sourcePath, sourceStat.atime, sourceStat.mtime);
      rmSync(home, { recursive: true, force: true });
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousOverride === undefined) delete process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
      else process.env.OPK_WAKE_SUPERVISOR_STATE_DIR = previousOverride;
      if (previousAdapter === undefined) delete process.env.OPK_RUNTIME_ADAPTER;
      else process.env.OPK_RUNTIME_ADAPTER = previousAdapter;
      vi.restoreAllMocks();
    }
  });

  it('rejects fully hand-authored rehashed evidence after live preflight re-observation', async () => {
    const home = testRoots.create('opk-1422-production-home-');
    const user = os.userInfo();
    vi.spyOn(os, 'userInfo').mockReturnValue({ ...user, homedir: home });
    const previousPath = process.env.PATH;
    const bin = path.join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    const ao = path.join(bin, 'ao');
    const liveRow = {
      createdAt: new Date().toISOString(),
      harness: 'production-test',
      id: 'live-source',
      isTerminated: false,
      issueId: 1422,
      lastActivityAt: new Date().toISOString(),
      projectId: 'production-test',
      role: 'live',
      status: 'running',
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(ao, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ sessions: [liveRow] }))});\n`);
    chmodSync(ao, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
    const previousOverride = process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
    delete process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
    const previousAdapter = process.env.OPK_RUNTIME_ADAPTER;
    delete process.env.OPK_RUNTIME_ADAPTER;

    try {
      const canonical = canonicalFoundationPaths(repoRoot);
      mkdirSync(canonical.supervisorStateDir, { recursive: true });
      const config = {
        ...DEFAULT_FOUNDATION_CONFIG,
        notification: { ...DEFAULT_FOUNDATION_CONFIG.notification, runtimePath: 'ao' },
      };
      writeJson(canonical.configPath, config);
      writeJson(canonical.appStatePath, { version: '0.10.3' });
      const journalPath = path.join(canonical.stateRoot, 'migration-journal.json');
      writeJson(journalPath, {
        schemaVersion: 1,
        journalKey: 'issue-1422-production-test',
        sourcePath: path.join(home, 'source.json'),
        targetPath: path.join(home, 'target.json'),
        sourceDigest: 'sha256:source',
        importedDigest: 'sha256:target',
        archiveIdentity: 'sha256:archive',
        state: 'committed',
        preparedAt: '2026-08-16T00:00:00.000Z',
        importedAt: '2026-08-16T00:00:01.000Z',
        committedAt: '2026-08-16T00:00:02.000Z',
      });
      const paths = {
        stateRoot: canonical.stateRoot,
        stateDir: canonical.stateRoot,
        cordonPath: canonical.cordonPath,
        phaseOnePath: canonical.phaseOnePath,
        followupPath: canonical.followupPath,
        epochAuthorityPath: canonical.epochAuthorityPath,
        targetRegistryPath: path.join(repoRoot, 'scripts', 'orchestrator-side-process-registry.json'),
        projectedRegistryPath: canonical.projectedRegistryPath,
        snapshotDir: canonical.snapshotDir,
        supervisorStateDir: canonical.supervisorStateDir,
        foundationEvidencePath: canonical.evidencePath,
        configPath: canonical.configPath,
        appStatePath: canonical.appStatePath,
      };
      const hostId = os.hostname().trim();
      const request = {
        repoRoot,
        oldInstalledRevisionRoot: repoRoot,
        hostId,
        knownMemberRoster: [{ hostId }],
        paths,
      } as unknown as ActivationRequest;
      const inertProof = observeFoundationInertProof({ repoRoot, paths });
      const handAuthoredRows = sanitizeRuntimeWorkers([{ ...liveRow, role: 'hand-authored' }]);
      const unsigned: Omit<FoundationAdmissionEvidence, 'observationDigest'> = {
        schemaVersion: 1,
        issue: 923,
        foundationMergeCommitSha: FOUNDATION_COMMIT,
        producer: 'orchestrator-pack:foundation-adoption-producer',
        preflight: {
          command: 'a\u006f session ls --json',
          appStateVersion: '0.10.3',
          sessions: handAuthoredRows,
          sanitizerId: `sha256:${'1'.repeat(64)}`,
        },
        typedConfig: config,
        migrationJournalPaths: [path.resolve(journalPath)],
        runtimeCatalog: [...FOUNDATION_RUNTIME_CATALOG],
        inertProof,
        heartbeats: [observeLocalHeartbeat(hostId, 'c'.repeat(40), canonical.configPath)],
      };
      writeDurableJson(canonical.evidencePath, {
        ...unsigned,
        observationDigest: foundationEvidenceDigest(unsigned),
      });

      await expect(productionActivationBoundary.proveFoundationAdoption(request))
        .rejects.toThrow('foundation_evidence_observation_mismatch:preflight');
      expect(new FileEpochAuthority(canonical.epochAuthorityPath).read().currentEpochId).toBeNull();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousOverride === undefined) delete process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
      else process.env.OPK_WAKE_SUPERVISOR_STATE_DIR = previousOverride;
      if (previousAdapter === undefined) delete process.env.OPK_RUNTIME_ADAPTER;
      else process.env.OPK_RUNTIME_ADAPTER = previousAdapter;
      vi.restoreAllMocks();
    }
  });
});
