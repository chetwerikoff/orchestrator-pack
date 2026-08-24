// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { stableStringify } from '../lib/cutover/stable-stringify.ts';
import { FileEpochAuthority } from '../lib/cutover/activation-epoch-authority.ts';
import { activateCutover, assertNoExternalLegacyReferences, recomputeClosure, productionActivationBoundary, type ActivationBoundary } from '../lib/cutover/activation-transaction.ts';
import { abandonPreImportCordon } from '../lib/cutover/activation-transaction.ts';
import { isExecutableLegacyReference } from '../lib/cutover/activation-transaction.ts';
import { createCordon, findLegacySupervisorIdentities, markImportBegun, readCordonState } from '../lib/cutover/activation-cordon.ts';
import {
  assertCanonicalActivationPaths,
  canonicalFoundationPaths,
  observeFoundationInertProof,
  observeLocalHeartbeat,
} from '../lib/cutover/foundation-observation.ts';
import {
  appendPhaseOne,
  foundationEvidenceDigest,
  writeDurableJson,
  verifyFoundationEvidenceDigest,
  verifyFoundationEvidenceObservation,
} from '../lib/cutover/activation-evidence.ts';
import { snapshotStores } from '../lib/cutover/activation-import.ts';
import {
  findCompletedSchedulerDelivery,
  provePreImportRollbackSafe,
  recoverCommittedCutover,
  type SchedulerHealthDeliveryObservation,
} from '../lib/cutover/activation-recovery.ts';
import { runActivationPlatformPreflight } from '../lib/cutover/activation-platform-preflight.ts';
import { validateSchedulerRegistry } from '../lib/cutover/activation-registry-projection.ts';
import type { ActivationRequest, EpochCommitCore, FoundationAdmissionEvidence, ProcessIdentity } from '../lib/cutover/types.ts';
import { runSchedulerTick, type SchedulerBoundary } from '../pr2-foundation/scheduler.ts';
import { CUTOVER_ROWS, FOUNDATION_DOC_ROWS, validateEstateSplit } from '../pr2-foundation/contracts.ts';
import { buildPlanningManifest } from '../pr2a/closed-world-scanner.ts';
import { D928 } from '../pr2a/contracts.ts';
import { getPackReviewRun, initializePackReviewRunStore, updatePackReviewRun } from '../lib/pack-review-run-store.ts';
import { packReviewDeliveryNeedsResume } from '../lib/pack-review-delivery.ts';
import { startPackReview } from '../pack-review-runner.ts';
import { produceFoundationAdoptionEvidence } from './foundation-adoption-producer.ts';
import { DEFAULT_FOUNDATION_CONFIG } from '../pr2-foundation/config.ts';

const activationCordonTestState = vi.hoisted(() => ({
  disableGreenfieldProcessCensus: false,
}));

const activationSubprocessTestState = vi.hoisted(() => ({
  result: null as null | {
    outcome: 'exit';
    ok: true;
    exitCode: 0;
    signal: null;
    stdout: string;
    stderr: string;
    timedOut: false;
    cancelled: false;
  },
}));

vi.mock('../kernel/subprocess.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../kernel/subprocess.ts')>();
  return {
    ...actual,
    runProcess: async (options: Parameters<typeof actual.runProcess>[0]) =>
      activationSubprocessTestState.result ?? actual.runProcess(options),
  };
});

vi.mock('../lib/cutover/activation-cordon.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/cutover/activation-cordon.ts')>();
  return {
    ...actual,
    findLegacySupervisorIdentities: (
      oldInstalledRevisionRoot: string,
      options: Parameters<typeof actual.findLegacySupervisorIdentities>[1] = {},
    ) => actual.findLegacySupervisorIdentities(
      oldInstalledRevisionRoot,
      activationCordonTestState.disableGreenfieldProcessCensus
        ? { ...options, entries: () => [] }
        : options,
    ),
    findTypeScriptSupervisorIdentities: (
      options: Parameters<typeof actual.findTypeScriptSupervisorIdentities>[0] = {},
    ) => actual.findTypeScriptSupervisorIdentities(
      activationCordonTestState.disableGreenfieldProcessCensus
        ? { ...options, entries: () => [] }
        : options,
    ),
  };
});

const repoRoot = path.resolve(process.cwd());
const roots: string[] = [];
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
  activationSubprocessTestState.result = null;
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

function fixtureObservation(core: EpochCommitCore, supervisorPid = 43210, childGeneration = 1): SchedulerHealthDeliveryObservation {
  return {
    result: 'scheduler-health-delivery-observed',
    epochId: core.epochId,
    nonce: core.nonce,
    installedCommitSha: core.installedCommitSha,
    observedAt: new Date().toISOString(),
    supervisor: {
      pid: supervisorPid,
      childGeneration,
      childPid: 54321,
      registryHash: core.registryHash,
      restartState: 'running',
    },
    delivery: {
      result: 'scheduler-durable-delivery-observed',
      runId: 'prr-fixture-delivery',
      prNumber: 928,
      headSha: 'c'.repeat(40),
      status: 'up_to_date',
      journalState: 'persisted',
      deliveryOutcomes: {},
    },
  };
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
    observeFinalHealthAndDelivery: async (_request, core, supervisor) => fixtureObservation(core, supervisor.supervisorPid, supervisor.childGeneration),
  };
  return { request, boundary, root };
}

function recoveryBoundary() {
  return {
    ensureTypeScriptSupervisor: async () => ({ supervisorPid: 43210, childGeneration: 1 }),
    observeFinalHealthAndDelivery: async (_request: ActivationRequest, core: EpochCommitCore, supervisor: { supervisorPid: number; childGeneration: number }) => fixtureObservation(core, supervisor.supervisorPid, supervisor.childGeneration),
  };
}

function coreFixture(epochId = 'epoch-scheduler', nonce = 'nonce-scheduler'): EpochCommitCore {
  return {
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
}

function committedEpoch(file: string, epochId = 'epoch-scheduler', nonce = 'nonce-scheduler'): EpochCommitCore {
  const core = coreFixture(epochId, nonce);
  new FileEpochAuthority(file).commit(null, core);
  return core;
}

describe('[AC4][AC6] estate successor state', () => {
  it('terminalizes the exact Issue #906 cutover denominator rows', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, 'scripts/estate-cut/issue-906.manifest.json'), 'utf8'),
    ) as {
      objectiveStateDomain?: string[];
      rows?: Array<{ path: string; terminalState: string; replacementOwner?: string }>;
    };
    expect(manifest.objectiveStateDomain?.filter((state) => state === 'cutover-terminalized')).toHaveLength(1);
    const denominator = (manifest.rows ?? []).filter((row) =>
      (FOUNDATION_DOC_ROWS as readonly string[]).includes(row.path)
      || (CUTOVER_ROWS as readonly string[]).includes(row.path),
    );
    expect(validateEstateSplit(denominator)).toEqual({ ok: true, result: 'foundation-15-cutover-6' });
    const byPath = new Map((manifest.rows ?? []).map((row) => [row.path, row]));
    for (const file of CUTOVER_ROWS) {
      expect(byPath.get(file)).toMatchObject({ terminalState: 'cutover-terminalized', replacementOwner: 'scripts/orchestrator-cutover-activate.ts' });
    }
    const replacementOwners = [
      'scripts/orchestrator-wake-supervisor.ts',
      'scripts/lib/orchestrator-side-process-supervisor.ts',
      'scripts/lib/review-start-claim-store.ts',
      'scripts/lib/review-start-claim-reaper.ts',
    ] as const;
    D928.forEach((file, index) => {
      expect(byPath.get(file)).toMatchObject({ terminalState: 'deleted-now', replacementOwner: replacementOwners[index] });
    });
  });
});

describe('[AC1] admission and closure', () => {
  it('recomputes #948 closure and rejects every executable target-library edge outside D928', () => {
    const base = git(['merge-base', 'origin/main', 'HEAD']);
    const manifest = buildPlanningManifest(base);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.unknown).toEqual([]);
    expect(manifest.dynamicUnsupported).toEqual([]);
    const targets = new Set(['scripts/lib/Orchestrator-SideProcessSupervisor.ps1', 'scripts/lib/Review-StartClaim.ps1']);
    const external = manifest.references.filter((row) =>
      targets.has(row.target)
      && !(D928 as readonly string[]).includes(row.source)
      && isExecutableLegacyReference(row),
    );
    expect(external).toEqual([]);
  });

  it('streams complete closure output above 1 MiB and still rejects an external executable reference', async () => {
    const closure = await recomputeClosure(repoRoot, 'HEAD');
    expect(closure.inputTree).toMatch(/^[0-9a-f]{40}$/iu);

    const denominator = [{ path: 'scripts/external-consumer.ts', executionClass: 'root' as const }];
    const governanceLines = "HEAD:scripts/external-consumer.ts:1:const historical = 'Review-StartClaim.ps1';\n".repeat(30_000);
    const externalLine = "HEAD:scripts/external-consumer.ts:2:spawn('pwsh', 'Review-StartClaim.ps1');\n";
    expect(Buffer.byteLength(governanceLines + externalLine)).toBeGreaterThan(1_048_576);
    expect(() => assertNoExternalLegacyReferences(governanceLines + externalLine, denominator))
      .toThrow(/external_legacy_reference:scripts\/external-consumer\.ts/);
  });

  it('classifies executable selectors instead of whitelisting governance source paths', () => {
    const target = 'scripts/lib/Review-StartClaim.ps1';
    for (const selector of [
      "import legacy from '../lib/Review-StartClaim.ps1';",
      "import '../lib/Review-StartClaim.ps1';",
      ". (Join-Path $PSScriptRoot 'Review-StartClaim.ps1')",
    ]) {
      expect(isExecutableLegacyReference({
        source: 'scripts/pr2a/example.ts',
        target,
        sourceExecutionClass: 'reachable-helper',
        primitiveClass: selector.startsWith('.') ? 'powershell-dot-source-or-actionable-reference' : 'javascript-import-child-or-actionable-reference',
        selector,
      })).toBe(true);
    }
    expect(isExecutableLegacyReference({
      source: 'scripts/pr2a/example.ts',
      target,
      sourceExecutionClass: 'reachable-helper',
      primitiveClass: 'javascript-import-child-or-actionable-reference',
      selector: "const historicalName = 'Review-StartClaim.ps1';",
    })).toBe(false);
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
      'const foundation = await boundary.proveFoundationAdoption(request);',
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
  it('runs the transaction with one CAS and an explicit observed health/delivery receipt', async () => {
    const { request, boundary } = activationFixture();
    let observed = 0;
    const originalObserve = boundary.observeFinalHealthAndDelivery;
    boundary.observeFinalHealthAndDelivery = async (...args) => { observed += 1; return originalObserve(...args); };
    const result = await activateCutover(request, boundary) as any;
    expect(result.cutover.admission.result).toBe('foundation-single-host-adopted');
    expect(result.cutover.activation.result).toBe('C1-C18-ts-transfer-pass');
    expect(result.cutover.import_claim.result).toBe('imports-and-claim-compatibility-verified');
    expect(result.cutover.recovery.result).toBe('import-boundary-forward-only');
    expect(result.cutover.activation_evidence.result).toBe('bound-central-cas-record');
    expect(result.supervisorPid).toBe(43210);
    expect(result.childGeneration).toBe(1);
    expect(observed).toBe(1);
    const cordon = JSON.parse(readFileSync(request.paths.cordonPath, 'utf8'));
    expect(cordon).toMatchObject({ state: 'active', writersClosed: true, noRespawn: true, noTypeScriptStart: true });
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
      'committed-registry-reprojected','typescript-supervisor-started','scheduler-owned','machine-local-completion-fsync-confirmed','final-step-timestamp-recorded','final-health-delivery-observed','activation-complete',
    ]);
    await expect(recoverCommittedCutover(request, recoveryBoundary())).resolves.toMatchObject({ result: 'forward-repair-ready', supervisorPid: 43210, childGeneration: 1 });
    expect(() => provePreImportRollbackSafe(request)).toThrow(/forward_only/);
  });

  it('does not fabricate final health/delivery evidence when observation fails', async () => {
    const { request, boundary } = activationFixture();
    boundary.observeFinalHealthAndDelivery = async () => { throw new Error('health_delivery_not_observed'); };
    await expect(activateCutover(request, boundary)).rejects.toThrow(/health_delivery_not_observed/);
    expect(new FileEpochAuthority(request.paths.epochAuthorityPath).read().currentEpochId).toBe(request.epochId);
    const steps = JSON.parse(readFileSync(request.paths.followupPath, 'utf8')).map((row: any) => row.step);
    expect(steps).toEqual([
      'committed-registry-reprojected','typescript-supervisor-started','scheduler-owned','machine-local-completion-fsync-confirmed','final-step-timestamp-recorded',
    ]);
    expect(steps).not.toContain('final-health-delivery-observed');
    expect(steps).not.toContain('activation-complete');
  });

  it('resumes a crash after the first barrier write from the durable preparing intent', () => {
    const { request, boundary } = activationFixture();
    const identity = boundary.readLegacySupervisor(request);
    const input = { path: request.paths.cordonPath, epochId: request.epochId, hostId: request.hostId, repoRoot: request.repoRoot, installedCommitSha: request.installedCommitSha, oldInstalledRevisionRoot: request.oldInstalledRevisionRoot, legacyStateRoot: request.paths.supervisorStateDir, legacySupervisor: identity, stores: request.stores, paths: request.paths };
    const first = createCordon(input);
    const prepared: any = { ...first, state: 'preparing' };
    delete prepared.writersClosed;
    delete prepared.noRespawn;
    delete prepared.noTypeScriptStart;
    writeJson(request.paths.cordonPath, prepared);
    rmSync(path.join(request.paths.supervisorStateDir, 'maintenance.epoch'), { force: true });
    expect(existsSync(path.join(request.paths.supervisorStateDir, 'stopping'))).toBe(true);
    const resumed = createCordon(input);
    expect(resumed.nonce).toBe(first.nonce);
    expect(resumed.state).toBe('active');
    expect(existsSync(path.join(request.paths.supervisorStateDir, 'maintenance.epoch'))).toBe(true);
  });

  it('resumes forward from import boundary before CAS and rejects a changed recovery tuple', async () => {
    const { request, boundary } = activationFixture();
    const identity = boundary.readLegacySupervisor(request);
    const cordon = createCordon({ path: request.paths.cordonPath, epochId: request.epochId, hostId: request.hostId, repoRoot: request.repoRoot, installedCommitSha: request.installedCommitSha, oldInstalledRevisionRoot: request.oldInstalledRevisionRoot, legacyStateRoot: request.paths.supervisorStateDir, legacySupervisor: identity, stores: request.stores, paths: request.paths });
    appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'admission', { recoveredFixture: true });
    appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'cordon', { writersClosed: true, noRespawn: true, noTypeScriptStart: true });
    appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'writer-drain', { writerWatermark: 'drained-test-watermark' });
    appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'legacy-supervisor-and-writers-terminated', { reenumeratedEmpty: true });
    const snapshots = snapshotStores(request.stores, request.paths.snapshotDir, 'drained-test-watermark');
    appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'snapshots', snapshots);
    const marked = markImportBegun(request.paths.cordonPath);
    appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'import-begun', { importBegunAt: marked.importBegunAt });
    const tampered: ActivationRequest = {
      ...request,
      stores: request.stores.map((store, index) => index === 0 ? { ...store, targetPath: `${store.targetPath}.other` } : store),
    };
    await expect(recoverCommittedCutover(tampered, recoveryBoundary())).rejects.toThrow(/recovery_request_binding_mismatch/);
    await expect(recoverCommittedCutover({ ...request, expectedOldEpochId: 'foreign-predecessor' }, recoveryBoundary())).rejects.toThrow(/recovery_request_binding_mismatch/);
    expect(existsSync(request.paths.epochAuthorityPath)).toBe(false);
    await expect(recoverCommittedCutover(request, recoveryBoundary())).resolves.toMatchObject({ result: 'forward-repair-ready', supervisorPid: 43210 });
    expect(new FileEpochAuthority(request.paths.epochAuthorityPath).read().currentEpochId).toBe(request.epochId);
  });

  it('rejects a missing watermark and surviving writer before snapshot/import', async () => {
    const missing = activationFixture();
    missing.boundary.drainLegacyWriters = async () => ({ writerWatermark: '', drainedAt: new Date().toISOString() });
    await expect(activateCutover(missing.request, missing.boundary)).rejects.toThrow(/writer_watermark_missing/);
    expect(existsSync(missing.request.paths.snapshotDir)).toBe(false);

    const survivor = activationFixture();
    const writer: ProcessIdentity = { pid: 23456, startTicks: '77', cmdline: ['legacy-writer'] };
    survivor.boundary.verifyLegacyProcessesGone = () => ({ supervisorAlive: false, writers: [{ childId: 'mutation-writer', identity: writer, sideEffectLockPath: null }] });
    await expect(activateCutover(survivor.request, survivor.boundary)).rejects.toThrow(/legacy_process_survivor/);
    expect(existsSync(survivor.request.paths.snapshotDir)).toBe(false);
  });

  it('allows rollback only before import mutation and binds it to the original targets', () => {
    const { request, boundary } = activationFixture();
    const identity = boundary.readLegacySupervisor(request);
    createCordon({ path: request.paths.cordonPath, epochId: request.epochId, hostId: request.hostId, repoRoot: request.repoRoot, installedCommitSha: request.installedCommitSha, oldInstalledRevisionRoot: request.oldInstalledRevisionRoot, legacyStateRoot: request.paths.supervisorStateDir, legacySupervisor: identity, stores: request.stores, paths: request.paths });
    expect(provePreImportRollbackSafe(request).safe).toBe(true);
    const tampered = { ...request, hostId: 'other-host' };
    expect(() => provePreImportRollbackSafe(tampered)).toThrow(/recovery_request_binding_mismatch/);
    writeJson(request.stores[0]!.targetPath, { changed: true });
    expect(() => provePreImportRollbackSafe(request)).toThrow(/preimport_target_changed/);
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
      'boundary.observeFinalHealthAndDelivery(request, committed, supervisor)',
    ].map((token) => body.indexOf(token));
    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
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

describe('[AC6] post-cutover scope invariant', () => {
  it('keeps the four retired D928 PowerShell targets absent from the current tree', () => {
    for (const pathName of D928) {
      expect(existsSync(path.join(repoRoot, pathName))).toBe(false);
    }
  });
});

describe('[AC8] platform and canonical bytes', () => {
  it('reproduces committed canonicalization vectors', () => {
    const vectors = JSON.parse(readFileSync(path.join(repoRoot, 'scripts/fixtures/cutover/stable-stringify-vectors.json'), 'utf8')).vectors as Array<{ input: unknown; canonical: string }>;
    for (const vector of vectors) expect(stableStringify(vector.input)).toBe(vector.canonical);
  });

  it('fails unsupported Node and native Windows before cordon', () => {
    const { request } = activationFixture();
    expect(() => runActivationPlatformPreflight({ repoRoot, installedCommitSha: git(['rev-parse', 'HEAD']), oldInstalledRevisionRoot: repoRoot, targetRegistryPath: request.paths.targetRegistryPath, projectedRegistryPath: request.paths.projectedRegistryPath, nodeVersion: '20.19.0', platform: 'linux' })).toThrow(/node22_required/);
    expect(() => runActivationPlatformPreflight({ repoRoot, installedCommitSha: git(['rev-parse', 'HEAD']), oldInstalledRevisionRoot: repoRoot, targetRegistryPath: request.paths.targetRegistryPath, projectedRegistryPath: request.paths.projectedRegistryPath, nodeVersion: '22.0.0', platform: 'win32' })).toThrow(/unsupported_platform/);
  });

  it('rejects a non-canonical repository root', () => {
    const { request } = activationFixture();
    const nonCanonical = `${repoRoot}${path.sep}..${path.sep}${path.basename(repoRoot)}`;
    expect(path.normalize(nonCanonical)).toBe(repoRoot);
    expect(() => runActivationPlatformPreflight({ repoRoot: nonCanonical, installedCommitSha: git(['rev-parse', 'HEAD']), oldInstalledRevisionRoot: repoRoot, targetRegistryPath: request.paths.targetRegistryPath, projectedRegistryPath: request.paths.projectedRegistryPath, nodeVersion: '22.0.0', platform: 'linux' })).toThrow(/repo_root_not_canonical/);
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
    for (const token of ['completePreCasRecovery', 'authority.commit(request.expectedOldEpochId, core);', 'assertCordonRequestBinding(request, cordon);']) expect(recovery).toContain(token);
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
  it('extends the existing #918 gate through the real scheduler/runner durable-delivery path', async () => {
    const root = tempRoot();
    const authorityPath = path.join(root, 'authority.json');
    const core = committedEpoch(authorityPath);
    const env = { ...process.env, ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: authorityPath, ORCHESTRATOR_CUTOVER_EPOCH_ID: core.epochId, ORCHESTRATOR_CUTOVER_NONCE: core.nonce };
    const storeRoot = path.join(root, 'review-runs');
    initializePackReviewRunStore(storeRoot);
    const currentHead = git(['rev-parse', 'HEAD']);
    const starts: Array<{ pr: number; head: string }> = [];
    const durableRuns: string[] = [];
    const candidate = { sessionId: 'worker-1', repoSlug: 'chetwerikoff/orchestrator-pack', prNumber: 928, boundHeadSha: currentHead };
    const boundary: SchedulerBoundary = {
      listCandidates: () => [candidate],
      readCurrentPr: async () => ({ number: 928, headRefOid: candidate.boundHeadSha, state: 'OPEN', isDraft: false }),
      readChecks: async () => REQUIRED_CHECKS.map((name) => ({ name, state: 'SUCCESS' })),
      listReviewRuns: () => [],
      start: async (row, head) => {
        starts.push({ pr: row.prNumber, head });
        const reviews: any[] = [];
        const previousHarness = process.env.OPK_VITEST_HARNESS;
        const previousClaimRoot = process.env.OPK_REVIEW_CLAIM_DIR;
        process.env.OPK_VITEST_HARNESS = '1';
        process.env.OPK_REVIEW_CLAIM_DIR = path.join(root, 'claims');
        try {
          const result = await startPackReview({
            projectId: 'orchestrator-pack',
            linkedSessionId: row.sessionId,
            prNumber: row.prNumber,
            headSha: head,
            sourceRepoRoot: repoRoot,
            startReason: 'scheduler',
            surface: 'pr2-scheduler',
            claimMode: 'acquire',
            storeRoot,
            fixtureReviewStdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
            fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
            fixtureGithubReviewTransport: {
              async resolveActorLogin() { return 'issue-928-reviewer'; },
              async listReviews() { return [...reviews]; },
              async postReview(input) {
                const review = {
                  id: 92801 + reviews.length,
                  state: 'COMMENTED',
                  userLogin: 'issue-928-reviewer',
                  submittedAt: new Date().toISOString(),
                  body: input.body,
                  commitId: input.commitId,
                  url: `fixture://issue-928/review/${92801 + reviews.length}`,
                };
                reviews.push(review);
                return { id: review.id, url: review.url };
              },
              async dismissReview() { /* no prior approval exists in this fixture */ },
            },
            fixtureRequiredStatusWriter: async () => { /* real delivery persists the successful outcome */ },
            fixtureWorkerNotifier: async () => ({ state: 'delivered', reason: 'issue_928_fixture_dispatched' }),
          });
          expect(result).toMatchObject({ ok: true, created: true });
          const runId = String(result.runId);
          const run = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
          expect(run).not.toBeNull();
          expect(run).toMatchObject({ surface: 'pr2-scheduler', startReason: 'scheduler', headSha: head, targetSha: head });
          expect(run?.journalOutcome?.state).toBe('persisted');
          expect(packReviewDeliveryNeedsResume(run!)).toBe(false);
          expect(run?.reviewVerdict).toBe('clean');
          expect(findCompletedSchedulerDelivery(core, storeRoot)).toMatchObject({ runId, prNumber: row.prNumber, headSha: head });

          const worker = run!.deliveryOutcomes.workerNotification!;
          updatePackReviewRun(runId, {
            deliveryOutcomes: {
              ...run!.deliveryOutcomes,
              workerNotification: { ...worker, state: 'failed', reason: 'fixture_delivery_failed' },
            },
          }, { projectId: 'orchestrator-pack', storeRoot });
          expect(findCompletedSchedulerDelivery(core, storeRoot)).toBeNull();
          durableRuns.push(runId);
          return { ok: true };
        } finally {
          if (previousHarness === undefined) delete process.env.OPK_VITEST_HARNESS;
          else process.env.OPK_VITEST_HARNESS = previousHarness;
          if (previousClaimRoot === undefined) delete process.env.OPK_REVIEW_CLAIM_DIR;
          else process.env.OPK_REVIEW_CLAIM_DIR = previousClaimRoot;
        }
      },
    };
    expect(await runSchedulerTick(boundary, env)).toEqual({ attempted: 1, started: 1, skipped: 0 });
    expect(starts).toEqual([{ pr: 928, head: candidate.boundHeadSha }]);
    expect(durableRuns).toHaveLength(1);
    await expect(runSchedulerTick(boundary, { ...env, ORCHESTRATOR_CUTOVER_NONCE: 'copied-stale-nonce' })).rejects.toThrow(/epoch_nonce_mismatch/);
  });

  it('refuses a fresh-head drift before review start', async () => {
    const root = tempRoot();
    const authorityPath = path.join(root, 'authority.json');
    const core = committedEpoch(authorityPath);
    const env = { ...process.env, ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: authorityPath, ORCHESTRATOR_CUTOVER_EPOCH_ID: core.epochId, ORCHESTRATOR_CUTOVER_NONCE: core.nonce };
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

describe('[pack-review-4] regression coverage', () => {
  it('classifies executable target-library references from otherwise-unlisted candidate sources', async () => {
    const { candidateLegacyReferenceRows } = await import('../lib/cutover/activation-transaction.ts');
    const rows = candidateLegacyReferenceRows(
      [
        "deadbeef:scripts/unlisted-cutover-consumer.ts:1:import '../lib/Review-StartClaim.ps1';",
        "deadbeef:docs/historical-note.md:1:const historicalName = 'Review-StartClaim.ps1';",
      ].join('\n'),
      [
        { path: 'scripts/unlisted-cutover-consumer.ts', executionClass: 'reachable-helper' },
        { path: 'docs/historical-note.md', executionClass: 'dead' },
      ],
    );
    expect(rows.filter(isExecutableLegacyReference).map((row) => row.source)).toEqual([
      'scripts/unlisted-cutover-consumer.ts',
    ]);
  });

  it('reuses a waiting supervisor, validates running child identity, and fails closed on stale/v1 recovery status', async () => {
    const { readProcessIdentity } = await import('../lib/cutover/activation-cordon.ts');
    const { observeSchedulerHealthAndDelivery, productionRecoveryBoundary } = await import('../lib/cutover/activation-recovery.ts');
    const { createPackReviewRun } = await import('../lib/pack-review-run-store.ts');
    const root = tempRoot();
    const identity = readProcessIdentity(process.pid);
    const core: EpochCommitCore = {
      epochId: 'epoch-review4-wait',
      nonce: 'nonce-review4-wait',
      hostId: 'test-host',
      repoRoot,
      installedCommitSha: 'e'.repeat(40),
      snapshotDigests: { reconcile: 'r', reevaluation: 'e', reportStateSeed: 's' },
      importDigests: { reconcile: 'ir', reevaluation: 'ie', reportStateSeed: 'is' },
      registryHash: 'registry-review4',
      preCommitLogDigest: 'phase-review4',
      commitAt: new Date(Date.now() - 1_000).toISOString(),
    };
    const request = {
      epochId: core.epochId,
      expectedOldEpochId: null,
      hostId: core.hostId,
      repoRoot,
      installedCommitSha: core.installedCommitSha,
      oldInstalledRevisionRoot: repoRoot,
      legacySupervisorPid: process.pid,
      knownMemberRoster: [{ hostId: core.hostId }],
      stores: [],
      paths: {
        stateDir: root,
        cordonPath: path.join(root, 'cordon.json'),
        phaseOnePath: path.join(root, 'phase-one.json'),
        followupPath: path.join(root, 'followups.json'),
        epochAuthorityPath: path.join(root, 'authority.json'),
        targetRegistryPath: path.join(root, 'target-registry.json'),
        projectedRegistryPath: path.join(root, 'projected-registry.json'),
        snapshotDir: path.join(root, 'snapshots'),
        supervisorStateDir: root,
        foundationEvidencePath: path.join(root, 'foundation.json'),
      },
    } as ActivationRequest;
    const statusPath = path.join(root, 'typescript-supervisor-status.json');
    writeJson(statusPath, {
      schemaVersion: 2,
      epochId: core.epochId,
      nonce: core.nonce,
      supervisorPid: process.pid,
      supervisorStartTicks: identity.startTicks,
      registryHash: core.registryHash,
      registrySource: request.paths.targetRegistryPath,
      childId: 'pr2-scheduler',
      childPid: null,
      childStartTicks: null,
      childGeneration: 3,
      childRestarts: 2,
      restartState: 'waiting-restart',
      startedAt: new Date().toISOString(),
      lastChildStartAt: new Date().toISOString(),
      cordonReason: 'post-cas-epoch-owner',
      refusalReason: null,
    });

    await expect(productionRecoveryBoundary.ensureTypeScriptSupervisor(request, core.nonce)).resolves.toEqual({
      supervisorPid: process.pid,
      childGeneration: 3,
    });

    const storeRoot = path.join(root, 'review-runs');
    initializePackReviewRunStore(storeRoot);
    const headSha = 'f'.repeat(40);
    const delayedDelivery = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const created = createPackReviewRun({
        projectId: 'orchestrator-pack',
        storeRoot,
        prNumber: 928,
        headSha,
        linkedSessionId: 'worker-review4',
        startReason: 'scheduler',
        surface: 'pr2-scheduler',
        trustedPackRoot: repoRoot,
        sourceRepoRoot: repoRoot,
      });
      const now = new Date().toISOString();
      updatePackReviewRun(created.run.id, {
        status: 'up_to_date',
        latestRunStatus: 'up_to_date',
        reviewVerdict: 'clean',
        findingCount: 0,
        findings: [],
        journalOutcome: {
          state: 'persisted',
          recordedAtUtc: now,
          reason: 'verdict_persisted',
          idempotencyKey: `verdict:${created.run.id}:${headSha}`,
          attempts: 1,
        },
        githubReviewId: 92804,
        githubReviewUrl: 'fixture://issue-928/review4',
        githubReviewReconciliation: {
          schemaVersion: 1,
          event: 'COMMENT',
          phase: 'complete',
          actorLogin: 'issue-928-reviewer',
          commentBody: 'clean',
          commentReviewId: 92804,
          commentReviewUrl: 'fixture://issue-928/review4',
          pendingDismissalReviewIds: [],
          dismissedReviewIds: [],
          preparedAtUtc: now,
          updatedAtUtc: now,
        },
        deliveryOutcomes: {
          requiredStatus: {
            state: 'succeeded',
            recordedAtUtc: now,
            reason: 'fixture_status_written',
            idempotencyKey: `required-status:orchestrator-pack/pack-review:${headSha}`,
          },
          workerNotification: {
            state: 'delivered',
            recordedAtUtc: now,
            reason: 'fixture_worker_delivered',
            idempotencyKey: `worker-notification:${created.run.id}:${headSha}`,
          },
        },
      }, { projectId: 'orchestrator-pack', storeRoot });
    })();

    const observation = await observeSchedulerHealthAndDelivery(
      request,
      core,
      { supervisorPid: process.pid, childGeneration: 3 },
      storeRoot,
      { timeoutMs: 1_000, pollMs: 10 },
    );
    await delayedDelivery;
    expect(observation.supervisor.restartState).toBe('waiting-restart');
    expect(observation.delivery.headSha).toBe(headSha);

    const runningStatus = {
      schemaVersion: 2 as const,
      epochId: core.epochId,
      nonce: core.nonce,
      supervisorPid: process.pid,
      supervisorStartTicks: identity.startTicks,
      registryHash: core.registryHash,
      registrySource: request.paths.targetRegistryPath,
      childId: 'pr2-scheduler',
      childPid: process.pid,
      childStartTicks: identity.startTicks,
      childGeneration: 4,
      childRestarts: 2,
      restartState: 'running' as const,
      startedAt: new Date().toISOString(),
      lastChildStartAt: new Date().toISOString(),
      cordonReason: 'post-cas-epoch-owner',
      refusalReason: null,
    };
    writeJson(statusPath, runningStatus);
    await expect(observeSchedulerHealthAndDelivery(
      request,
      core,
      { supervisorPid: process.pid, childGeneration: 4 },
      storeRoot,
      { timeoutMs: 100, pollMs: 5 },
    )).resolves.toMatchObject({ supervisor: { restartState: 'running', childPid: process.pid, childGeneration: 4 } });

    writeJson(statusPath, { ...runningStatus, childStartTicks: `${identity.startTicks}-reused` });
    await expect(observeSchedulerHealthAndDelivery(
      request,
      core,
      { supervisorPid: process.pid, childGeneration: 4 },
      storeRoot,
      { timeoutMs: 30, pollMs: 5 },
    )).rejects.toThrow(/scheduler_health_not_observed/);

    const { childStartTicks: _childStartTicks, ...legacyStatus } = runningStatus;
    writeJson(statusPath, { ...legacyStatus, schemaVersion: 1 });
    await expect(observeSchedulerHealthAndDelivery(
      request,
      core,
      { supervisorPid: process.pid, childGeneration: 4 },
      storeRoot,
      { timeoutMs: 30, pollMs: 5 },
    )).rejects.toThrow(/recovery_supervisor_status_v1_unsupported/);
  });

  it('activation startup accepts only a live matching schema-v2 child identity and rejects stale/v1 status', async () => {
    const { readProcessIdentity } = await import('../lib/cutover/activation-cordon.ts');
    const root = tempRoot();
    const identity = readProcessIdentity(process.pid);
    const nonce = 'nonce-review4-activation';
    const request = {
      epochId: 'epoch-review4-activation',
      expectedOldEpochId: null,
      hostId: 'test-host',
      repoRoot,
      installedCommitSha: 'd'.repeat(40),
      oldInstalledRevisionRoot: repoRoot,
      legacySupervisorPid: process.pid,
      knownMemberRoster: [{ hostId: 'test-host' }],
      stores: [],
      paths: {
        stateDir: root,
        cordonPath: path.join(root, 'cordon.json'),
        phaseOnePath: path.join(root, 'phase-one.json'),
        followupPath: path.join(root, 'followups.json'),
        epochAuthorityPath: path.join(root, 'authority.json'),
        targetRegistryPath: path.join(root, 'target-registry.json'),
        projectedRegistryPath: path.join(root, 'projected-registry.json'),
        snapshotDir: path.join(root, 'snapshots'),
        supervisorStateDir: root,
        foundationEvidencePath: path.join(root, 'foundation.json'),
      },
    } as ActivationRequest;
    const statusPath = path.join(root, 'typescript-supervisor-status.json');
    const runningStatus = {
      schemaVersion: 2 as const,
      epochId: request.epochId,
      nonce,
      supervisorPid: process.pid,
      supervisorStartTicks: identity.startTicks,
      registryHash: 'registry-review4-activation',
      registrySource: request.paths.targetRegistryPath,
      childId: 'pr2-scheduler',
      childPid: process.pid,
      childStartTicks: identity.startTicks,
      childGeneration: 5,
      childRestarts: 0,
      restartState: 'running' as const,
      startedAt: new Date().toISOString(),
      lastChildStartAt: new Date().toISOString(),
      cordonReason: 'post-cas-epoch-owner',
      refusalReason: null,
    };
    activationSubprocessTestState.result = {
      outcome: 'exit',
      ok: true,
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({ pid: process.pid }),
      stderr: '',
      timedOut: false,
      cancelled: false,
    };

    writeJson(statusPath, runningStatus);
    await expect(productionActivationBoundary.startTypeScriptSupervisor(request, nonce)).resolves.toEqual({
      supervisorPid: process.pid,
      childGeneration: 5,
    });

    const { childStartTicks: _childStartTicks, ...legacyStatus } = runningStatus;
    writeJson(statusPath, { ...legacyStatus, schemaVersion: 1 });
    await expect(productionActivationBoundary.startTypeScriptSupervisor(request, nonce))
      .rejects.toThrow(/typescript_supervisor_status_v1_unsupported/);

    writeJson(statusPath, { ...runningStatus, childStartTicks: `${identity.startTicks}-reused` });
    vi.useFakeTimers();
    try {
      const rejected = expect(productionActivationBoundary.startTypeScriptSupervisor(request, nonce))
        .rejects.toThrow(/typescript_supervisor_scheduler_not_ready/);
      await vi.advanceTimersByTimeAsync(10_100);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});


const issue1422FirstTimeRoots: string[] = [];

function createIssue1422FirstTimeFixture(): { request: ActivationRequest; boundary: ActivationBoundary } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opk-1422-'));
  issue1422FirstTimeRoots.push(root);
  const stateDir = path.join(root, 'state');
  const supervisorStateDir = path.join(stateDir, 'supervisor');
  mkdirSync(supervisorStateDir, { recursive: true });
  const targetRegistryPath = path.join(root, 'registry.json');
  writeFileSync(targetRegistryPath, JSON.stringify({
    schemaVersion: 2,
    requiredChildIds: ['pr2-scheduler'],
    children: [{ id: 'pr2-scheduler', runtime: 'node', script: 'pr2-foundation/scheduler.ts', sideEffecting: true, cadenceSeconds: 5 }],
  }));
  const stores = (['reconcile', 'reevaluation', 'reportStateSeed'] as const).map((id) => {
    const sourcePath = path.join(root, `${id}-source.json`);
    const targetPath = path.join(root, `${id}-target.json`);
    const value = id === 'reconcile'
      ? { lastTickMs: 1, degradedCi: {}, cycleState: {} }
      : id === 'reevaluation'
        ? { watchEntries: {}, terminalTombstones: {}, lastUpdatedMs: 2 }
        : { bindingByKey: {}, seededKeys: [], deferredScanKeys: [], githubSnapshot: {}, lastUpdatedMs: 3 };
    if (id !== 'reconcile') writeFileSync(sourcePath, `${JSON.stringify(value)}\n`);
    return {
      id,
      sourcePath,
      targetPath,
      coveredFields: id === 'reconcile'
        ? ['lastTickMs', 'degradedCi', 'cycleState']
        : id === 'reevaluation'
          ? ['watchEntries', 'terminalTombstones', 'lastUpdatedMs']
          : ['bindingByKey', 'seededKeys', 'deferredScanKeys', 'githubSnapshot', 'lastUpdatedMs'],
    };
  });
  const request: ActivationRequest = {
    epochId: 'greenfield-1422',
    expectedOldEpochId: null,
    hostId: 'test-host',
    repoRoot: root,
    installedCommitSha: 'a'.repeat(40),
    oldInstalledRevisionRoot: root,
    legacySupervisorPid: 0,
    knownMemberRoster: [{ hostId: 'test-host' }],
    stores,
    paths: {
      stateDir,
      cordonPath: path.join(stateDir, 'cordon.json'),
      phaseOnePath: path.join(stateDir, 'phase-one.json'),
      followupPath: path.join(stateDir, 'followups.json'),
      epochAuthorityPath: path.join(stateDir, 'epoch-authority.json'),
      targetRegistryPath,
      projectedRegistryPath: path.join(stateDir, 'projected-registry.json'),
      snapshotDir: path.join(root, 'snapshots'),
      supervisorStateDir,
      foundationEvidencePath: path.join(stateDir, 'foundation-923-adoption.json'),
    },
  };
  const boundary: ActivationBoundary = {
    preflight: () => ({ result: 'node22-linux-wsl2-preflight-pass', repoRoot: root, oldInstalledRevisionRoot: root, platform: 'linux', nodeMajor: 22 }),
    proveFoundationAdoption: () => ({
      result: 'foundation-evidence-verified',
      evidencePath: request.paths.foundationEvidencePath,
      localHostId: request.hostId,
      oldInstalledCommitSha: request.installedCommitSha,
      heartbeatObservedAt: new Date().toISOString(),
      migrationJournalCount: 1,
      preflightSanitizerId: 'sha256:test',
      activationMode: 'greenfield',
      writerWatermark: 'sha256:observed-empty-writer-set',
    }),
    resolveBaseAndClosure: () => ({ baseRef: 'base', closure: { inputTree: 'tree', referenceCount: 0 } }),
    findLegacySupervisorIdentities: () => [],
    findTypeScriptSupervisorIdentities: () => [],
    readLegacySupervisor: () => { throw new Error('legacy_path_should_not_run'); },
    captureLegacyWriters: () => [],
    drainLegacyWriters: async () => { throw new Error('legacy_path_should_not_run'); },
    terminateLegacyProcesses: async () => { throw new Error('legacy_path_should_not_run'); },
    verifyLegacyProcessesGone: () => { throw new Error('legacy_path_should_not_run'); },
    startTypeScriptSupervisor: async () => ({ supervisorPid: 1422, childGeneration: 1 }),
    observeFinalHealthAndDelivery: async () => ({
      result: 'scheduler-health-delivery-observed',
      epochId: request.epochId,
      nonce: 'nonce',
      installedCommitSha: request.installedCommitSha,
      observedAt: new Date().toISOString(),
      supervisor: { pid: 1422, childGeneration: 1, childPid: 1423, registryHash: 'sha256:registry', restartState: 'running' },
      delivery: { result: 'scheduler-durable-delivery-observed', runId: 'run', prNumber: 1422, headSha: 'b'.repeat(40), status: 'ok', journalState: 'persisted', deliveryOutcomes: {} },
    }),
  };
  return { request, boundary };
}

afterEach(() => {
  for (const root of issue1422FirstTimeRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue 1422 first-time activation', () => {
  it('commits through the existing transaction without entering legacy handover', async () => {
    const { request, boundary } = createIssue1422FirstTimeFixture();
    const result = await activateCutover(request, boundary);
    expect((result as { cutover: { admission: { result: string } } }).cutover.admission.result).toBe('foundation-single-host-adopted');
    expect(new FileEpochAuthority(request.paths.epochAuthorityPath).read().currentEpochId).toBe(request.epochId);
    expect(JSON.parse(readFileSync(request.paths.cordonPath, 'utf8')).legacySupervisor).toBeNull();
    expect(existsSync(request.paths.epochAuthorityPath)).toBe(true);
    const reconcile = request.stores.find((store) => store.id === 'reconcile')!;
    expect(existsSync(reconcile.sourcePath)).toBe(false);
    expect(existsSync(reconcile.targetPath)).toBe(false);
    expect(JSON.parse(readFileSync(path.join(request.paths.snapshotDir, 'reconcile.snapshot.json'), 'utf8')))
      .toMatchObject({ schemaVersion: 1, storeId: 'reconcile', sourceState: 'absent' });
    expect(JSON.parse(readFileSync(`${reconcile.targetPath}.cutover-import.json`, 'utf8')))
      .toMatchObject({ storeId: 'reconcile', sourceState: 'absent', importTargetDigest: 'sha256:absent' });
  });

  it('produces greenfield evidence through the runtime adapter without legacy preflight', async () => {
    const homeDir = mkdtempSync(path.join(path.dirname(repoRoot), 'opk-1422-home-'));
    issue1422FirstTimeRoots.push(homeDir);
    const binDir = path.join(homeDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const runtimeCli = path.join(binDir, 'orca');
    writeFileSync(runtimeCli, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({
      ok: true,
      result: {
        worktree: {
          path: repoRoot,
          head: 'a'.repeat(40),
          linkedIssue: null,
        },
      },
    }))});\n`);
    chmodSync(runtimeCli, 0o755);

    const previousPath = process.env.PATH;
    const previousStateRoot = process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
    const previousRuntimeAdapter = process.env.OPK_RUNTIME_ADAPTER;
    const previousRuntimeCli = process.env.OPK_RUNTIME_CLI_COMMAND;
    const previousProcessCensusToggle = activationCordonTestState.disableGreenfieldProcessCensus;
    const user = os.userInfo();
    vi.spyOn(os, 'userInfo').mockReturnValue({ ...user, homedir: homeDir });
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;
    delete process.env.OPK_RUNTIME_ADAPTER;
    process.env.OPK_RUNTIME_CLI_COMMAND = runtimeCli;
    delete process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
    activationCordonTestState.disableGreenfieldProcessCensus = true;

    try {
      const canonical = canonicalFoundationPaths(repoRoot);
      const result = await produceFoundationAdoptionEvidence({
        repoRoot,
        stateDir: canonical.stateRoot,
        configPath: canonical.configPath,
        appStatePath: canonical.appStatePath,
        evidencePath: canonical.evidencePath,
      });

      expect(produceFoundationAdoptionEvidence.length).toBe(1);
      expect(existsSync(result.evidencePath)).toBe(true);
      const evidence = JSON.parse(readFileSync(result.evidencePath, 'utf8')) as FoundationAdmissionEvidence;
      expect(evidence.preflight).toMatchObject({
        kind: 'runtime-adapter',
        adapterId: 'orca',
        readiness: {
          ready: true,
          workspacePath: repoRoot,
          headSha: 'a'.repeat(40),
          linkedIssue: null,
        },
      });
      expect(evidence.preflight).not.toHaveProperty('command');
      expect(evidence.preflight).not.toHaveProperty('appStateVersion');
      expect(evidence.preflight).not.toHaveProperty('sessions');
      expect(evidence.greenfieldObservation).toBeDefined();
      expect(evidence.typedConfig).toBeNull();
    } finally {
      activationCordonTestState.disableGreenfieldProcessCensus = previousProcessCensusToggle;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousStateRoot === undefined) delete process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
      else process.env.OPK_WAKE_SUPERVISOR_STATE_DIR = previousStateRoot;
      if (previousRuntimeAdapter === undefined) delete process.env.OPK_RUNTIME_ADAPTER;
      else process.env.OPK_RUNTIME_ADAPTER = previousRuntimeAdapter;
      if (previousRuntimeCli === undefined) delete process.env.OPK_RUNTIME_CLI_COMMAND;
      else process.env.OPK_RUNTIME_CLI_COMMAND = previousRuntimeCli;
      vi.restoreAllMocks();
    }
  });

  it('rejects mutated producer evidence before activation', () => {
    const evidence = {
      schemaVersion: 1,
      issue: 923,
      foundationMergeCommitSha: 'b'.repeat(40),
      producer: 'orchestrator-pack:foundation-adoption-producer',
      preflight: { command: 'a\u006f session ls --json', appStateVersion: '0.10.3', sessions: [], sanitizerId: 'sha256:test' },
      typedConfig: {},
      migrationJournalPaths: ['journal.json'],
      runtimeCatalog: [],
      inertProof: {
        result: 'live-acquirers-unchanged',
        observations: {
          registryChanged: false,
          supervisorChanged: false,
          schedulerRegistered: false,
          schedulerRunning: false,
          schedulerClaimAcquirer: false,
          activationEpochEnforced: false,
          liveStoreOpened: false,
          legacyStarterDisabled: false,
          nonNotificationRuntimeDelta: false,
          dormantTypedConfigReaderLive: false,
          notificationTypedConfigLive: true,
        },
      },
      heartbeats: [],
    } satisfies Omit<FoundationAdmissionEvidence, 'observationDigest'>;
    const editedUnsigned = { ...evidence, typedConfig: { changed: true } };
    const edited = { ...editedUnsigned, observationDigest: foundationEvidenceDigest(editedUnsigned) };
    expect(() => verifyFoundationEvidenceObservation(edited, {
      typedConfig: evidence.typedConfig,
      appStateVersion: '0.10.3',
      migrationJournalPaths: evidence.migrationJournalPaths,
      inertProof: evidence.inertProof,
      heartbeats: evidence.heartbeats,
    })).toThrow('foundation_evidence_observation_mismatch');
  });

  it('binds activation paths to the canonical state root', async () => {
    const { request } = createIssue1422FirstTimeFixture();
    const previousStateRoot = process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
    const alternateRoot = mkdtempSync(path.join(os.tmpdir(), 'opk-1422-canonical-'));
    issue1422FirstTimeRoots.push(alternateRoot);
    process.env.OPK_WAKE_SUPERVISOR_STATE_DIR = alternateRoot;
    try {
      const canonical = canonicalFoundationPaths(request.repoRoot);
      expect(() => assertCanonicalActivationPaths(request)).toThrow('foundation_state_root_override_forbidden');
      await expect(produceFoundationAdoptionEvidence({
        repoRoot: request.repoRoot,
        stateDir: canonical.stateRoot,
        configPath: canonical.configPath,
        appStatePath: canonical.appStatePath,
        evidencePath: canonical.evidencePath,
      })).rejects.toThrow('foundation_state_root_override_forbidden');
      expect(canonical.stateRoot).not.toBe(alternateRoot);
      expect(new FileEpochAuthority(canonical.epochAuthorityPath).read().currentEpochId).toBeNull();
    } finally {
      if (previousStateRoot === undefined) delete process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
      else process.env.OPK_WAKE_SUPERVISOR_STATE_DIR = previousStateRoot;
    }
  });

  it('fails closed on an ambiguous legacy supervisor census', () => {
    const { request } = createIssue1422FirstTimeFixture();
    const authority = new FileEpochAuthority(request.paths.epochAuthorityPath);
    const readIdentity = (): never => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    };
    expect(() => findLegacySupervisorIdentities(request.oldInstalledRevisionRoot, {
      entries: () => ['4242'],
      readIdentity,
    })).toThrow('greenfield_legacy_supervisor_unknown:4242');
    expect(authority.read().currentEpochId).toBeNull();
  });

  it('refuses unobservable canonical foundation sources before writing evidence', async () => {
    const { request } = createIssue1422FirstTimeFixture();
    const homeDir = mkdtempSync(path.join(path.dirname(repoRoot), 'opk-1422-unobservable-home-'));
    issue1422FirstTimeRoots.push(homeDir);
    const user = os.userInfo();
    const userInfoSpy = vi.spyOn(os, 'userInfo').mockReturnValue({ ...user, homedir: homeDir });
    const canonical = canonicalFoundationPaths(request.repoRoot);
    const previousStateRoot = process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
    delete process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
    try {
      await expect(produceFoundationAdoptionEvidence({
        repoRoot: request.repoRoot,
        stateDir: canonical.stateRoot,
        configPath: canonical.configPath,
        appStatePath: canonical.appStatePath,
        evidencePath: canonical.evidencePath,
      })).rejects.toThrow(/unobservable/);
    } finally {
      userInfoSpy.mockRestore();
      if (previousStateRoot === undefined) delete process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
      else process.env.OPK_WAKE_SUPERVISOR_STATE_DIR = previousStateRoot;
    }
    expect(existsSync(canonical.evidencePath)).toBe(false);
    expect(existsSync(canonical.epochAuthorityPath)).toBe(false);
  });

  it('rolls back a greenfield pre-import cordon without epoch mutation', () => {
    const { request } = createIssue1422FirstTimeFixture();
    createCordon({
      path: request.paths.cordonPath,
      epochId: request.epochId,
      expectedOldEpochId: request.expectedOldEpochId,
      hostId: request.hostId,
      repoRoot: request.repoRoot,
      installedCommitSha: request.installedCommitSha,
      oldInstalledRevisionRoot: request.oldInstalledRevisionRoot,
      legacyStateRoot: request.paths.supervisorStateDir,
      legacySupervisor: null,
      stores: request.stores,
      paths: request.paths,
    });
    abandonPreImportCordon({ ...request, legacySupervisorPid: 0 });
    expect(existsSync(request.paths.cordonPath)).toBe(false);
    expect(new FileEpochAuthority(request.paths.epochAuthorityPath).read().currentEpochId).toBeNull();
  });
});
