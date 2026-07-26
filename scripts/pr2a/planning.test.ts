import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { stableStringify } from '../lib/cutover/stable-stringify.ts';
import { FileEpochAuthority } from '../lib/cutover/activation-epoch-authority.ts';
import { activateCutover, type ActivationBoundary } from '../lib/cutover/activation-transaction.ts';
import { createCordon, markImportBegun } from '../lib/cutover/activation-cordon.ts';
import { appendPhaseOne } from '../lib/cutover/activation-evidence.ts';
import { snapshotStores } from '../lib/cutover/activation-import.ts';
import { provePreImportRollbackSafe, recoverCommittedCutover } from '../lib/cutover/activation-recovery.ts';
import { runActivationPlatformPreflight } from '../lib/cutover/activation-platform-preflight.ts';
import { validateSchedulerRegistry } from '../lib/cutover/activation-registry-projection.ts';
import type { ActivationRequest, EpochCommitCore, ProcessIdentity } from '../lib/cutover/types.ts';
import { runSchedulerTick, type SchedulerBoundary } from '../pr2-foundation/scheduler.ts';
import { buildPlanningManifest } from './closed-world-scanner.ts';
import { D928, FOUNDATION_COMMIT } from './contracts.ts';
import { validatePlanningManifest } from './planning-validator.ts';

const reviewed = JSON.parse(readFileSync('scripts/pr2a/planning-manifest.json', 'utf8')) as {
  lineage: { planningCommit: string };
};

function reviewedPlanningManifest() {
  return buildPlanningManifest(reviewed.lineage.planningCommit);
}

describe('Issue #948 planning tooling bootstrap', () => {
  it('classifies every tracked file and closes the known target reverse references', () => {
    const manifest = reviewedPlanningManifest();
    expect(manifest.issue).toBe(948);
    expect(manifest.lineage.foundationCommit).toBe(FOUNDATION_COMMIT);
    expect(manifest.denominator.length).toBeGreaterThan(1000);
    expect(new Set(manifest.denominator.map((row) => row.path)).size).toBe(manifest.denominator.length);
    expect(manifest.unknown).toEqual([]);
    expect(manifest.dynamicUnsupported).toEqual([]);
    expect(manifest.references.some((row) => row.source === 'scripts/pack-review-runner.ts' && row.disposition === 'repoint')).toBe(true);
    expect(manifest.references.some((row) => row.source === 'scripts/check-side-process-launch-contract.ps1' && row.disposition === 'retire')).toBe(true);
    expect(validatePlanningManifest(manifest)).toEqual({ ok: true });
  });

  it('binds all four D928 members without authorizing their mutation', () => {
    const manifest = reviewedPlanningManifest();
    expect(Object.keys(manifest.d928Sha256).sort()).toEqual([...D928].sort());
    for (const target of D928) expect(manifest.plannedOperations.some((row) => row.path === target)).toBe(false);
  });

  it('censuses every top-level claim and lifecycle function with an overlap disposition', () => {
    const manifest = reviewedPlanningManifest();
    expect(manifest.lifecycle.length).toBeGreaterThanOrEqual(80);
    expect(manifest.lifecycle.every((row) => row.legacyProtocolDisposition && row.rolloutBoundary)).toBe(true);
    expect(manifest.lifecycle.some((row) => row.identity === 'Acquire-ReviewStartClaim')).toBe(true);
    expect(manifest.lifecycle.some((row) => row.identity === 'Confirm-ReviewStartClaimLaunchGate')).toBe(true);
  });
});

const repoRoot = path.resolve(process.cwd());
const roots: string[] = [];
const CLAIM_AUTHORITY = [
  'scripts/lib/review-start-claim-store.ts',
  'scripts/lib/review-start-claim-cli.ts',
  'scripts/pack-review-runner.ts',
];
const REQUIRED_CHECKS = [
  'verify orchestrator-pack structure',
  'pr scope guard',
  'run pack contract tests',
  'self-architect lint',
];

function governanceOnlyReference(source: string): boolean {
  const exact = ['scripts/pr2-foundation/contracts.ts', 'scripts/pr2-foundation/mutation-catalog.ts', 'scripts/pr2-foundation/mutation-behavior-probes.ts', 'scripts/pr2-foundation/mutation-semantic-gates.ts', 'scripts/lib/orchestrator-side-process-observer.ts', 'docs/launch-argv-registry.mjs', 'docs/orchestrator-message-registry.mjs', 'docs/review-start-preflight-shield.mjs'];
  return source.startsWith('scripts/pr2a/') || source.startsWith('scripts/estate-cut/') || exact.includes(source);
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opk-928-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function command(executable: string, args: string[], cwd = repoRoot): string {
  const result = runProcessSync({ command: executable, args, cwd, inheritParentEnv: true });
  if (!result.ok) throw new Error(`command_failed:${executable}:${result.stderr || result.error || result.exitCode}`);
  return result.stdout.trim();
}

function git(args: string[]): string {
  return command('git', ['-C', repoRoot, ...args]);
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function source(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

function activationFixture(): { request: ActivationRequest; boundary: ActivationBoundary; root: string } {
  const root = tempRoot();
  const state = path.join(root, 'state');
  const targetRegistry = path.join(root, 'target-registry.json');
  writeJson(targetRegistry, {
    schemaVersion: 2,
    requiredChildIds: ['pr2-scheduler'],
    children: [{ id: 'pr2-scheduler', runtime: 'node', script: 'pr2-foundation/scheduler.ts', sideEffecting: true, cadenceSeconds: 5 }],
  });
  const definitions = [
    ['reconcile', { lastTickMs: 1, degradedCi: {}, cycleState: {} }, ['lastTickMs', 'degradedCi', 'cycleState']],
    ['reevaluation', { watchEntries: {}, terminalTombstones: {}, lastUpdatedMs: 2 }, ['watchEntries', 'terminalTombstones', 'lastUpdatedMs']],
    ['reportStateSeed', { bindingByKey: {}, seededKeys: [], deferredScanKeys: [], githubSnapshot: {}, lastUpdatedMs: 3 }, ['bindingByKey', 'seededKeys', 'deferredScanKeys', 'githubSnapshot', 'lastUpdatedMs']],
  ] as const;
  const stores = definitions.map(([id, payload, coveredFields]) => {
    const sourcePath = path.join(root, `${id}.source.json`);
    const targetPath = path.join(root, `${id}.target.json`);
    writeJson(sourcePath, payload);
    return { id, sourcePath, targetPath, coveredFields };
  });
  const installedCommitSha = 'a'.repeat(40);
  const request: ActivationRequest = {
    epochId: 'epoch-928-test',
    expectedOldEpochId: null,
    hostId: 'test-host',
    repoRoot,
    installedCommitSha,
    oldInstalledRevisionRoot: root,
    legacySupervisorPid: 12345,
    knownMemberRoster: [{ hostId: 'test-host' }],
    stores,
    paths: {
      stateDir: state,
      cordonPath: path.join(state, 'cordon.json'),
      phaseOnePath: path.join(state, 'phase-one.json'),
      followupPath: path.join(state, 'followups.json'),
      epochAuthorityPath: path.join(state, 'epoch-authority.json'),
      targetRegistryPath: targetRegistry,
      projectedRegistryPath: path.join(state, 'projected-registry.json'),
      snapshotDir: path.join(root, 'snapshots'),
      supervisorStateDir: path.join(state, 'supervisor'),
      foundationEvidencePath: path.join(state, 'foundation-923-adoption.json'),
    },
  };
  const identity: ProcessIdentity = { pid: 12345, startTicks: '99', cmdline: [path.join(root, 'scripts', 'orchestrator-wake-supervisor.ps1')] };
  const boundary: ActivationBoundary = {
    preflight: () => ({ result: 'node22-linux-wsl2-preflight-pass', repoRoot, oldInstalledRevisionRoot: root, platform: 'linux', nodeMajor: 22 }),
    proveFoundationAdoption: () => ({ result: 'foundation-evidence-verified', evidencePath: request.paths.foundationEvidencePath, localHostId: request.hostId, oldInstalledCommitSha: '9'.repeat(40), heartbeatObservedAt: new Date().toISOString(), migrationJournalCount: 1, preflightSanitizerId: 'sha256:test' }),
    resolveBaseAndClosure: () => ({ baseRef: 'post-948-base', closure: { inputTree: 'tree-948', referenceCount: 2 } }),
    readLegacySupervisor: () => identity,
    captureLegacyWriters: () => [],
    drainLegacyWriters: async () => {
      if (!existsSync(request.paths.cordonPath)) throw new Error('cordon_not_first');
      return { writerWatermark: 'drained-test-watermark', drainedAt: new Date().toISOString() };
    },
    terminateLegacyProcesses: async () => {
      if (!existsSync(request.paths.cordonPath)) throw new Error('termination_before_cordon');
      return [identity.pid];
    },
    verifyLegacyProcessesGone: () => ({ supervisorAlive: false, writers: [] }),
    startTypeScriptSupervisor: async () => {
      const authority = new FileEpochAuthority(request.paths.epochAuthorityPath).read();
      if (authority.currentEpochId !== request.epochId) throw new Error('typescript_supervisor_before_cas');
      return { supervisorPid: 43210, childGeneration: 1 };
    },
  };
  return { request, boundary, root };
}

function committedEpoch(file: string, epochId = 'epoch-scheduler', nonce = 'nonce-scheduler'): void {
  const core: EpochCommitCore = {
    epochId,
    nonce,
    hostId: 'test-host',
    repoRoot,
    installedCommitSha: 'b'.repeat(40),
    snapshotDigests: { reconcile: 'r', reevaluation: 'e', reportStateSeed: 's' },
    importDigests: { reconcile: 'ir', reevaluation: 'ie', reportStateSeed: 'is' },
    registryHash: 'registry',
    preCommitLogDigest: 'phase-one',
    commitAt: new Date().toISOString(),
  };
  new FileEpochAuthority(file).commit(null, core);
}

describe('[AC1] admission and closure', () => {
  it('recomputes #948 reverse closure against the merge base and has no external executable target-library reference', () => {
    const base = git(['merge-base', 'origin/main', 'HEAD']);
    const manifest = buildPlanningManifest(base);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.unknown).toEqual([]);
    expect(manifest.dynamicUnsupported).toEqual([]);
    const targets = new Set(['scripts/lib/Orchestrator-SideProcessSupervisor.ps1', 'scripts/lib/Review-StartClaim.ps1']);
    const external = manifest.references.filter((row) => targets.has(row.target) && !(D928 as readonly string[]).includes(row.source) && !governanceOnlyReference(row.source));
    expect(external).toEqual([]);
    expect(manifest.references.some((row) => targets.has(row.target) && governanceOnlyReference(row.source))).toBe(true);
  });

  it('refuses before cordon when foundation adoption evidence is unavailable', async () => {
    const { request, boundary } = activationFixture();
    boundary.proveFoundationAdoption = () => { throw new Error('foundation_evidence_missing'); };
    await expect(activateCutover(request, boundary)).rejects.toThrow(/foundation_evidence_missing/);
    expect(existsSync(request.paths.cordonPath)).toBe(false);
  });

  it('retains the fail-closed admission guards required before cordon', () => {
    const activation = source('scripts/lib/cutover/activation-transaction.ts');
    const preflight = source('scripts/lib/cutover/activation-platform-preflight.ts');
    const cordon = source('scripts/lib/cutover/activation-cordon.ts');
    for (const token of [
      "const FOUNDATION_LANDING_COMMIT = 'b967dfe156838039e1d6d137e7064dc9d1b10b4d';",
      "const PR2A_LANDING_COMMIT = '17ac39d725ba9ae7c881816405d5225e541177c7';",
      "if (!isAncestor(repoRoot, PR2A_LANDING_COMMIT, baseRef)) throw new Error('pr2a_merge_missing');",
      "if (manifest.schemaVersion !== 1) throw new Error('closure_schema_incompatible');",
      "throw new Error('closure_unresolved_set_nonempty');",
      'if (external.length !== 0) throw new Error(`external_legacy_reference:',
      'const foundation = boundary.proveFoundationAdoption(request);',
      "if (!request.hostId || request.hostId !== observedLocalHost) throw new Error('foundation_host_unbound');",
      "throw new Error('foundation_heartbeat_stale');",
      "throw new Error('foundation_member_not_adopted');",
      "throw new Error('second_control_plane_host');",
      'assertLegacySupervisor(legacyIdentity, request.oldInstalledRevisionRoot);',
    ]) expect(activation).toContain(token);
    for (const token of [
      "if (platform !== 'linux') throw new Error('unsupported_platform');",
      "if (major !== 22) throw new Error('node22_required');",
      "if (actualHead.toLowerCase() !== input.installedCommitSha.toLowerCase()) throw new Error('installed_commit_unbound');",
      "throw new Error(`${label}_not_canonical`);",
    ]) expect(preflight).toContain(token);
    expect(cordon).toContain("if (existsSync(input.path)) throw new Error('competing_transaction_admitted');");
  });
});

describe('[AC2][AC3][AC4][AC5][AC7] activation transaction', () => {
  it('runs the real transaction through synthetic process/store/CAS boundaries with CAS as the sole commit', async () => {
    const { request, boundary } = activationFixture();
    const result = await activateCutover(request, boundary) as any;
    expect(result.cutover.admission.result).toBe('foundation-single-host-adopted');
    expect(result.cutover.activation.result).toBe('C1-C18-ts-transfer-pass');
    expect(result.cutover.import_claim.result).toBe('imports-and-claim-compatibility-verified');
    expect(result.cutover.recovery.result).toBe('import-boundary-forward-only');
    expect(result.cutover.activation_evidence.result).toBe('bound-central-cas-record');
    expect(result.supervisorPid).toBe(43210);
    expect(result.childGeneration).toBe(1);
    const cordon = JSON.parse(readFileSync(request.paths.cordonPath, 'utf8'));
    expect(cordon).toMatchObject({ writersClosed: true, noRespawn: true, noTypeScriptStart: true });
    expect(existsSync(path.join(request.paths.supervisorStateDir, 'stopping'))).toBe(true);
    expect(existsSync(path.join(request.paths.supervisorStateDir, 'maintenance.epoch'))).toBe(true);
    const phaseOne = JSON.parse(readFileSync(request.paths.phaseOnePath, 'utf8'));
    expect(phaseOne.records.map((row: any) => row.step)).toEqual([
      'admission','cordon','writer-drain','legacy-supervisor-and-writers-terminated','snapshots','import-begun','imports','registry-projected',
    ]);
    const authority = JSON.parse(readFileSync(request.paths.epochAuthorityPath, 'utf8'));
    expect(authority.records).toHaveLength(1);
    expect(Object.keys(authority.records[0]!).sort()).toEqual([
      'commitAt','epochId','hostId','importDigests','installedCommitSha','nonce','preCommitLogDigest','registryHash','repoRoot','snapshotDigests',
    ].sort());
    expect(JSON.parse(readFileSync(request.paths.followupPath, 'utf8')).map((row: any) => row.step)).toEqual([
      'committed-registry-reprojected',
      'typescript-supervisor-started',
      'scheduler-owned',
      'machine-local-completion-fsync-confirmed',
      'final-step-timestamp-recorded',
      'final-health-delivery-observed',
      'activation-complete',
    ]);
    await expect(recoverCommittedCutover(request, {
      ensureTypeScriptSupervisor: async () => ({ supervisorPid: 43210, childGeneration: 1 }),
    })).resolves.toMatchObject({ result: 'forward-repair-ready', supervisorPid: 43210, childGeneration: 1 });
    expect(() => provePreImportRollbackSafe(request)).toThrow(/forward_only/);
  });

  it('retains cordon-first, import, projection, CAS and supervisor ordering', () => {
    const activation = source('scripts/lib/cutover/activation-transaction.ts');
    const body = activation.slice(activation.indexOf('export async function activateCutover'));
    const ordered = [
      'const cordon = createCordon(',
      'boundary.drainLegacyWriters(request, legacyWriters)',
      'boundary.terminateLegacyProcesses(',
      'snapshotStores(request.stores',
      'markImportBegun(request.paths.cordonPath)',
      'importSnapshot({',
      'projectRegistry(request.paths.targetRegistryPath',
      'authority.commit(request.expectedOldEpochId, core)',
      'boundary.startTypeScriptSupervisor(request, cordon.nonce)',
    ].map((token) => body.indexOf(token));
    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
  });

  it('rejects a missing writer watermark before snapshots', async () => {
    const { request, boundary } = activationFixture();
    boundary.drainLegacyWriters = async () => ({ writerWatermark: '', drainedAt: new Date().toISOString() });
    await expect(activateCutover(request, boundary)).rejects.toThrow(/writer_watermark_missing/);
    expect(existsSync(request.paths.snapshotDir)).toBe(false);
  });

  it('rejects a surviving legacy writer after drain and termination', async () => {
    const { request, boundary } = activationFixture();
    const writer: ProcessIdentity = { pid: 23456, startTicks: '77', cmdline: ['legacy-writer'] };
    boundary.verifyLegacyProcessesGone = () => ({ supervisorAlive: false, writers: [{ childId: 'mutation-writer', identity: writer, sideEffectLockPath: null }] });
    await expect(activateCutover(request, boundary)).rejects.toThrow(/legacy_process_survivor/);
    expect(existsSync(request.paths.snapshotDir)).toBe(false);
  });

  it('resumes forward from the import boundary when CAS has not happened yet', async () => {
    const { request, boundary } = activationFixture();
    const identity = boundary.readLegacySupervisor(request);
    const cordon = createCordon({ path: request.paths.cordonPath, epochId: request.epochId, hostId: request.hostId, repoRoot: request.repoRoot, installedCommitSha: request.installedCommitSha, oldInstalledRevisionRoot: request.oldInstalledRevisionRoot, legacyStateRoot: request.paths.supervisorStateDir, legacySupervisor: identity, stores: request.stores });
    appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'admission', { recoveredFixture: true });
    appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'cordon', { writersClosed: true, noRespawn: true, noTypeScriptStart: true });
    appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'writer-drain', { writerWatermark: 'drained-test-watermark' });
    appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'legacy-supervisor-and-writers-terminated', { reenumeratedEmpty: true });
    const snapshots = snapshotStores(request.stores, request.paths.snapshotDir, 'drained-test-watermark');
    appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'snapshots', snapshots);
    const marked = markImportBegun(request.paths.cordonPath);
    appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'import-begun', { importBegunAt: marked.importBegunAt });
    expect(existsSync(request.paths.epochAuthorityPath)).toBe(false);
    await expect(recoverCommittedCutover(request, {
      ensureTypeScriptSupervisor: async () => ({ supervisorPid: 43210, childGeneration: 1 }),
    })).resolves.toMatchObject({ result: 'forward-repair-ready', supervisorPid: 43210 });
    const authority = new FileEpochAuthority(request.paths.epochAuthorityPath).read();
    expect(authority.currentEpochId).toBe(request.epochId);
    expect(authority.records).toHaveLength(1);
    expect(JSON.parse(readFileSync(request.paths.phaseOnePath, 'utf8')).records.map((row: any) => row.step)).toEqual([
      'admission','cordon','writer-drain','legacy-supervisor-and-writers-terminated','snapshots','import-begun','imports','registry-projected',
    ]);
    expect(existsSync(path.join(request.paths.supervisorStateDir, 'stopping'))).toBe(true);
  });

  it('refuses snapshot/import when legacy processes survive re-enumeration', async () => {
    const { request, boundary } = activationFixture();
    boundary.verifyLegacyProcessesGone = () => ({ supervisorAlive: true, writers: [] });
    await expect(activateCutover(request, boundary)).rejects.toThrow(/legacy_process_survivor/);
    expect(existsSync(request.paths.snapshotDir)).toBe(false);
  });

  it('allows old-revision rollback only before import mutation and refuses target drift', () => {
    const { request, boundary } = activationFixture();
    const identity = boundary.readLegacySupervisor(request);
    createCordon({ path: request.paths.cordonPath, epochId: request.epochId, hostId: request.hostId, repoRoot: request.repoRoot, installedCommitSha: request.installedCommitSha, oldInstalledRevisionRoot: request.oldInstalledRevisionRoot, legacyStateRoot: request.paths.supervisorStateDir, legacySupervisor: identity, stores: request.stores });
    expect(provePreImportRollbackSafe(request).safe).toBe(true);
    writeJson(request.stores[0]!.targetPath, { changed: true });
    expect(() => provePreImportRollbackSafe(request)).toThrow(/preimport_target_changed/);
  });

  it('retains snapshot/import identity, validation and convergence guards', () => {
    const imports = source('scripts/lib/cutover/activation-import.ts');
    for (const token of [
      "if (!writerWatermark.trim()) throw new Error('writer_watermark_missing');",
      'snapshotDigest: sha256Bytes(bytes)',
      'if (!Number.isInteger(sourceVersion) || sourceVersion <= 0)',
      "throw new Error(`store_unknown_field:${spec.id}:${unknown.join(',')}`)",
      "throw new Error(`store_missing_field:${spec.id}:${key}`)",
      'epochId: input.epochId,',
      'nonce: input.nonce,',
      'storeId: input.spec.id,',
      'snapshotDigest: input.snapshot.snapshotDigest,',
      'if (marker.importIdentity !== importIdentity || marker.importTargetDigest !== importTargetDigest)',
      'if (sha256Stable(existing) !== importTargetDigest)',
      'if (sha256Stable(readBack) !== importTargetDigest)',
      'writeDurableJson(markerPath, record);',
    ]) expect(imports).toContain(token);
  });
});

describe('[AC6] scope', () => {
  it('contains exactly the four PowerShell deletions and preserves #948 claim authority/tracked registry', () => {
    const base = git(['merge-base', 'origin/main', 'HEAD']);
    const rows = git(['diff', '--name-status', `${base}..HEAD`]).split(/\r?\n/).filter(Boolean).map((line) => {
      const [status, ...parts] = line.split('\t');
      return { status, path: parts.at(-1)! };
    });
    const powershell = rows.filter((row) => /\.(ps1|psm1|psd1)$/i.test(row.path)).sort((a, b) => a.path.localeCompare(b.path));
    expect(powershell).toEqual([...D928].map((pathName) => ({ status: 'D', path: pathName })).sort((a, b) => a.path.localeCompare(b.path)));
    for (const protectedPath of CLAIM_AUTHORITY) expect(rows.some((row) => row.path === protectedPath)).toBe(false);
    expect(rows.some((row) => row.path === 'scripts/orchestrator-side-process-registry.json')).toBe(false);
    expect(rows.some((row) => row.path === 'scripts/check-side-process-launch-contract.ps1')).toBe(false);
    const newTests = rows.filter((row) => row.status === 'A' && /^scripts\/.*\.test\.ts$/.test(row.path)).map((row) => row.path);
    expect(newTests).toEqual([]);
    const protectedWorktree = [...D928, ...CLAIM_AUTHORITY, 'scripts/orchestrator-side-process-registry.json', 'scripts/vitest-ci-lanes.config.json'];
    expect(git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...protectedWorktree])).toBe('');
  });
});

describe('[AC8] platform and canonical bytes', () => {
  it('reproduces committed canonicalization vectors', () => {
    const vectors = JSON.parse(readFileSync(path.join(repoRoot, 'scripts/fixtures/cutover/stable-stringify-vectors.json'), 'utf8')).vectors as Array<{ input: unknown; canonical: string }>;
    for (const vector of vectors) expect(stableStringify(vector.input)).toBe(vector.canonical);
  });

  it('fails unsupported Node before any cordon path can be created', () => {
    const { request } = activationFixture();
    expect(() => runActivationPlatformPreflight({
      repoRoot,
      installedCommitSha: git(['rev-parse', 'HEAD']),
      oldInstalledRevisionRoot: repoRoot,
      targetRegistryPath: request.paths.targetRegistryPath,
      projectedRegistryPath: request.paths.projectedRegistryPath,
      nodeVersion: '20.19.0',
      platform: 'linux',
    })).toThrow(/node22_required/);
  });

  it('fails unsupported native Windows before any cordon path can be created', () => {
    const { request } = activationFixture();
    expect(() => runActivationPlatformPreflight({
      repoRoot,
      installedCommitSha: git(['rev-parse', 'HEAD']),
      oldInstalledRevisionRoot: repoRoot,
      targetRegistryPath: request.paths.targetRegistryPath,
      projectedRegistryPath: request.paths.projectedRegistryPath,
      nodeVersion: '22.0.0',
      platform: 'win32',
    })).toThrow(/unsupported_platform/);
  });

  it('rejects a non-canonical repository root instead of normalizing it', () => {
    const { request } = activationFixture();
    const nonCanonical = `${repoRoot}${path.sep}..${path.sep}${path.basename(repoRoot)}`;
    expect(path.normalize(nonCanonical)).toBe(repoRoot);
    expect(nonCanonical).not.toBe(repoRoot);
    expect(() => runActivationPlatformPreflight({
      repoRoot: nonCanonical,
      installedCommitSha: git(['rev-parse', 'HEAD']),
      oldInstalledRevisionRoot: repoRoot,
      targetRegistryPath: request.paths.targetRegistryPath,
      projectedRegistryPath: request.paths.projectedRegistryPath,
      nodeVersion: '22.0.0',
      platform: 'linux',
    })).toThrow(/repo_root_not_canonical/);
  });

  it('retains durability, exclusion, process identity and central nonce primitives', () => {
    const evidence = source('scripts/lib/cutover/activation-evidence.ts');
    const epoch = source('scripts/lib/cutover/activation-epoch-authority.ts');
    const cordon = source('scripts/lib/cutover/activation-cordon.ts');
    const recovery = source('scripts/lib/cutover/activation-recovery.ts');
    const supervisor = source('scripts/lib/orchestrator-side-process-supervisor.ts');
    const preflight = source('scripts/lib/cutover/activation-platform-preflight.ts');
    for (const token of ['fsyncSync(fd);', 'renameSync(temporary, target);', 'syncDirectory(directory);']) expect(evidence).toContain(token);
    for (const token of ['mkdirSync(lock);', 'document.currentEpochId !== expectedOldEpochId', 'record.nonce !== nonce']) expect(epoch).toContain(token);
    for (const token of ["randomBytes(32).toString('hex')", 'writeDurableFile(barrier.stopping', 'current.startTicks !== identity.startTicks', 'if (survivors.length) throw new Error']) expect(cordon).toContain(token);
    for (const token of ['completePreCasRecovery', 'authority.commit(request.expectedOldEpochId, core);']) expect(recovery).toContain(token);
    for (const token of ['verifyEpochAndProjection(options)', 'projectRegistry(options.targetRegistryPath, options.projectedRegistryPath)']) expect(supervisor).toContain(token);
    for (const token of ["if (platform !== 'linux') throw new Error('unsupported_platform');", 'statSync(targetParent).dev !== statSync(projectionParent).dev']) expect(preflight).toContain(token);
  });

  it('accepts only the scheduler-only target registry', () => {
    const valid = readFileSync(path.join(repoRoot, 'scripts/orchestrator-side-process-registry.cutover-target.json'));
    expect(validateSchedulerRegistry(valid).children[0]!.id).toBe('pr2-scheduler');
    expect(() => validateSchedulerRegistry(JSON.stringify({ schemaVersion: 2, requiredChildIds: ['legacy'], children: [] }))).toThrow();
  });
});

describe('[AC4] scheduler-driven #918 successor slice', () => {
  it('starts exactly one exact-head review only after central epoch/nonce verification and fresh checks', async () => {
    const root = tempRoot();
    const authorityPath = path.join(root, 'authority.json');
    committedEpoch(authorityPath);
    const env = { ...process.env, ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: authorityPath, ORCHESTRATOR_CUTOVER_EPOCH_ID: 'epoch-scheduler', ORCHESTRATOR_CUTOVER_NONCE: 'nonce-scheduler' };
    const starts: Array<{ pr: number; head: string }> = [];
    const candidate = { sessionId: 'worker-1', repoSlug: 'chetwerikoff/orchestrator-pack', prNumber: 928, boundHeadSha: 'c'.repeat(40) };
    const boundary: SchedulerBoundary = {
      listCandidates: () => [candidate],
      readCurrentPr: async () => ({ number: 928, headRefOid: candidate.boundHeadSha, state: 'OPEN', isDraft: false }),
      readChecks: async () => REQUIRED_CHECKS.map((name) => ({ name, state: 'SUCCESS' })),
      listReviewRuns: () => [],
      start: async (row, head) => { starts.push({ pr: row.prNumber, head }); return { ok: true }; },
    };
    expect(await runSchedulerTick(boundary, env)).toEqual({ attempted: 1, started: 1, skipped: 0 });
    expect(starts).toEqual([{ pr: 928, head: candidate.boundHeadSha }]);
    await expect(runSchedulerTick(boundary, { ...env, ORCHESTRATOR_CUTOVER_NONCE: 'copied-stale-nonce' })).rejects.toThrow(/epoch_nonce_mismatch/);
  });

  it('refuses a fresh-head drift before review start', async () => {
    const root = tempRoot();
    const authorityPath = path.join(root, 'authority.json');
    committedEpoch(authorityPath);
    const env = { ...process.env, ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: authorityPath, ORCHESTRATOR_CUTOVER_EPOCH_ID: 'epoch-scheduler', ORCHESTRATOR_CUTOVER_NONCE: 'nonce-scheduler' };
    let started = false;
    const candidate = { sessionId: 'worker-1', repoSlug: 'chetwerikoff/orchestrator-pack', prNumber: 928, boundHeadSha: 'c'.repeat(40) };
    const boundary: SchedulerBoundary = {
      listCandidates: () => [candidate],
      readCurrentPr: async () => ({ number: 928, headRefOid: 'd'.repeat(40), state: 'OPEN', isDraft: false }),
      readChecks: async () => REQUIRED_CHECKS.map((name) => ({ name, state: 'SUCCESS' })),
      listReviewRuns: () => [],
      start: async () => { started = true; return { ok: true }; },
    };
    expect(await runSchedulerTick(boundary, env)).toEqual({ attempted: 1, started: 0, skipped: 1 });
    expect(started).toBe(false);
  });
});
