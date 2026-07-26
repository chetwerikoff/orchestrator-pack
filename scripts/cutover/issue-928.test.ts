import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { stableStringify } from '../lib/cutover/stable-stringify.ts';
import { FileEpochAuthority } from '../lib/cutover/activation-epoch-authority.ts';
import { activateCutover, type ActivationBoundary } from '../lib/cutover/activation-transaction.ts';
import { createCordon } from '../lib/cutover/activation-cordon.ts';
import { provePreImportRollbackSafe, recoverCommittedCutover } from '../lib/cutover/activation-recovery.ts';
import { runActivationPlatformPreflight } from '../lib/cutover/activation-platform-preflight.ts';
import { validateSchedulerRegistry } from '../lib/cutover/activation-registry-projection.ts';
import type { ActivationRequest, EpochCommitCore, ProcessIdentity } from '../lib/cutover/types.ts';
import { runSchedulerTick, type SchedulerBoundary } from '../pr2-foundation/scheduler.ts';
import { buildPlanningManifest } from '../pr2a/closed-world-scanner.ts';

const repoRoot = path.resolve(process.cwd());
const roots: string[] = [];
const D928 = [
  'scripts/orchestrator-wake-supervisor.ps1',
  'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
  'scripts/lib/Review-StartClaim.ps1',
  'scripts/review-start-claim-reaper.ps1',
];
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

function activationFixture(): { request: ActivationRequest; boundary: ActivationBoundary; root: string } {
  const root = tempRoot();
  const state = path.join(root, 'state');
  const storesRoot = root;
  const snapshots = path.join(root, 'snapshots');
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
    const sourcePath = path.join(storesRoot, `${id}.source.json`);
    const targetPath = path.join(storesRoot, `${id}.target.json`);
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
    knownMemberRoster: [{ hostId: 'test-host', installedCommitSha, fresh: true, adopted: true }],
    stores,
    paths: {
      stateDir: state,
      cordonPath: path.join(state, 'cordon.json'),
      phaseOnePath: path.join(state, 'phase-one.json'),
      followupPath: path.join(state, 'followups.json'),
      epochAuthorityPath: path.join(state, 'epoch-authority.json'),
      targetRegistryPath: targetRegistry,
      projectedRegistryPath: path.join(state, 'projected-registry.json'),
      snapshotDir: snapshots,
      supervisorStateDir: path.join(state, 'supervisor'),
    },
  };
  const identity: ProcessIdentity = { pid: 12345, startTicks: '99', cmdline: [path.join(root, 'scripts', 'orchestrator-wake-supervisor.ps1')] };
  const boundary: ActivationBoundary = {
    preflight: () => ({ result: 'node22-linux-wsl2-preflight-pass', repoRoot, oldInstalledRevisionRoot: root, platform: 'linux', nodeMajor: 22 }),
    resolveBaseAndClosure: () => ({ baseRef: 'post-948-base', closure: { inputTree: 'tree-948', referenceCount: 2 } }),
    readLegacySupervisor: () => identity,
    captureLegacyWriters: () => [],
    drainLegacyWriters: async () => ({ writerWatermark: 'drained-test-watermark', drainedAt: new Date().toISOString() }),
    terminateLegacyProcesses: async () => [identity.pid],
    verifyLegacyProcessesGone: () => ({ supervisorAlive: false, writers: [] }),
    startTypeScriptSupervisor: async () => ({ supervisorPid: 43210, childGeneration: 1 }),
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
  it('recomputes #948 reverse closure against the merge base and has no external target-library reference', () => {
    const base = git(['merge-base', 'origin/main', 'HEAD']);
    const manifest = buildPlanningManifest(base);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.unknown).toEqual([]);
    expect(manifest.dynamicUnsupported).toEqual([]);
    const targets = new Set(['scripts/lib/Orchestrator-SideProcessSupervisor.ps1', 'scripts/lib/Review-StartClaim.ps1']);
    const external = manifest.references.filter((row) => targets.has(row.target) && !D928.includes(row.source));
    expect(external).toEqual([]);
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
    expect(existsSync(path.join(request.paths.supervisorStateDir, 'stopping'))).toBe(true);
    expect(existsSync(path.join(request.paths.supervisorStateDir, 'maintenance.epoch'))).toBe(true);
    const phaseOne = JSON.parse(readFileSync(request.paths.phaseOnePath, 'utf8'));
    expect(phaseOne.records.map((row: any) => row.step)).toContain('writer-drain');
    expect(phaseOne.records.map((row: any) => row.step)).toContain('legacy-supervisor-and-writers-terminated');
    const authority = JSON.parse(readFileSync(request.paths.epochAuthorityPath, 'utf8'));
    expect(authority.records).toHaveLength(1);
    expect(Object.keys(authority.records[0]).sort()).toEqual([
      'commitAt','epochId','hostId','importDigests','installedCommitSha','nonce','preCommitLogDigest','registryHash','repoRoot','snapshotDigests',
    ].sort());
    expect(JSON.parse(readFileSync(request.paths.followupPath, 'utf8')).map((row: any) => row.step)).toEqual([
      'committed-registry-reprojected','typescript-supervisor-started','scheduler-owned','activation-complete',
    ]);
    await expect(recoverCommittedCutover(request, {
      ensureTypeScriptSupervisor: async () => ({ supervisorPid: 43210, childGeneration: 1 }),
    })).resolves.toMatchObject({ result: 'forward-repair-ready', supervisorPid: 43210, childGeneration: 1 });
    expect(() => provePreImportRollbackSafe(request)).toThrow(/forward_only/);
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
    writeJson(request.stores[0].targetPath, { changed: true });
    expect(() => provePreImportRollbackSafe(request)).toThrow(/preimport_target_changed/);
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
    expect(powershell).toEqual(D928.map((pathName) => ({ status: 'D', path: pathName })).sort((a, b) => a.path.localeCompare(b.path)));
    for (const protectedPath of CLAIM_AUTHORITY) expect(rows.some((row) => row.path === protectedPath)).toBe(false);
    expect(rows.some((row) => row.path === 'scripts/orchestrator-side-process-registry.json')).toBe(false);
    expect(rows.some((row) => row.path === 'scripts/check-side-process-launch-contract.ps1')).toBe(false);
    const newTests = rows.filter((row) => row.status === 'A' && /^scripts\/.*\.test\.ts$/.test(row.path)).map((row) => row.path);
    expect(newTests).toEqual(['scripts/cutover/issue-928.test.ts']);
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

  it('accepts only the scheduler-only target registry', () => {
    const valid = readFileSync(path.join(repoRoot, 'scripts/orchestrator-side-process-registry.cutover-target.json'));
    expect(validateSchedulerRegistry(valid).children[0].id).toBe('pr2-scheduler');
    expect(() => validateSchedulerRegistry(JSON.stringify({ schemaVersion: 2, requiredChildIds: ['legacy'], children: [] }))).toThrow();
  });
});

describe('[AC4] scheduler-driven #918 successor slice', () => {
  it('starts exactly one exact-head review only after central epoch/nonce verification and fresh checks', async () => {
    const root = tempRoot();
    const authorityPath = path.join(root, 'authority.json');
    committedEpoch(authorityPath);
    const env = {
      ...process.env,
      ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: authorityPath,
      ORCHESTRATOR_CUTOVER_EPOCH_ID: 'epoch-scheduler',
      ORCHESTRATOR_CUTOVER_NONCE: 'nonce-scheduler',
    };
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
    const staleEnv = { ...env, ORCHESTRATOR_CUTOVER_NONCE: 'copied-stale-nonce' };
    await expect(runSchedulerTick(boundary, staleEnv)).rejects.toThrow(/epoch_nonce_mismatch/);
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
