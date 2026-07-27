import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { runProcessSync, runProcess } from '../../kernel/subprocess.ts';
import { appendFollowup, appendPhaseOne, finalizePhaseOne, verifyPhaseOneDigest } from './activation-evidence.ts';
import {
  assertCordonRequestBinding,
  assertLegacySupervisor,
  captureLegacyWriters,
  createCordon,
  fileDigestOrAbsent,
  markImportBegun,
  processAlive,
  readCordonState,
  readProcessIdentity,
  releaseLegacyStartBarrier,
  terminateProcessTree,
  waitForLegacyWriterDrain,
  type LegacyWriterRecord,
} from './activation-cordon.ts';
import { buildEpochCommitCore, FileEpochAuthority, mapCutoverStoreDigests } from './activation-epoch-authority.ts';
import { importSnapshot, snapshotStores } from './activation-import.ts';
import { localHostId, runActivationPlatformPreflight, type PlatformPreflightResult } from './activation-platform-preflight.ts';
import { projectRegistry } from './activation-registry-projection.ts';
import { observeSchedulerHealthAndDelivery, type SchedulerHealthDeliveryObservation } from './activation-recovery.ts';
import type { ActivationRequest, CutoverStoreId, EpochCommitCore, FoundationAdmissionEvidence } from './types.ts';
import { readSupervisorStatus } from '../orchestrator-side-process-supervisor.ts';
import { D928 as D928_PATHS, TARGET_LIBRARIES as TARGET_LIBRARY_PATHS } from '../../pr2a/contracts.ts';
import { validateAoPreflight } from '../../pr2-foundation/binding.ts';
import { parseFoundationConfig } from '../../pr2-foundation/config.ts';
import { readMigrationJournal } from '../../pr2-foundation/migration-journal.ts';
import { FOUNDATION_RUNTIME_CATALOG, validateRuntimeCatalog, type RuntimeSurface } from '../../pr2-foundation/runtime-catalog.ts';

const FOUNDATION_LANDING_COMMIT = 'b967dfe156838039e1d6d137e7064dc9d1b10b4d';
const PR2A_LANDING_COMMIT = '17ac39d725ba9ae7c881816405d5225e541177c7';
const FOUNDATION_HEARTBEAT_MAX_AGE_MS = 5 * 60_000;
const D928 = new Set<string>(D928_PATHS);
const TARGET_LIBRARIES = new Set<string>(TARGET_LIBRARY_PATHS);

type ClosureExecutionClass = 'root' | 'reachable-helper' | 'explicitly-unsupported' | 'dead';
export interface ClosureReferenceRow {
  source?: string;
  target?: string;
  primitiveClass?: string;
  selector?: string;
  sourceExecutionClass?: ClosureExecutionClass;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isExecutableLegacyReference(row: ClosureReferenceRow): boolean {
  if (row.sourceExecutionClass === 'dead' || row.sourceExecutionClass === 'explicitly-unsupported') return false;
  const target = String(row.target ?? '').replace(/\\/g, '/');
  if (!TARGET_LIBRARIES.has(target)) return false;
  const primitiveClass = String(row.primitiveClass ?? '');
  if (primitiveClass === 'javascript-static-import' || primitiveClass === 'node-child-process' || primitiveClass === 'powershell-dot-source') {
    return true;
  }

  const selector = String(row.selector ?? '');
  const basename = path.posix.basename(target);
  if (!selector.includes(basename)) return false;
  const escaped = regexEscape(basename);
  const patterns = [
    new RegExp(`^\\s*import\\s+(?:(?:[^'\"]+?\\s+from\\s+)?['\"][^'\"]*${escaped}|\\(\\s*['\"][^'\"]*${escaped})`, 'iu'),
    new RegExp(`^\\s*(?:(?:const|let|var)\\s+[^=]+?=\\s*)?require\\s*\\(\\s*['\"][^'\"]*${escaped}`, 'iu'),
    new RegExp(`^\\s*(?:await\\s+)?(?:spawn|execFile|fork|exec)\\s*\\([^\\r\\n]*${escaped}`, 'iu'),
    new RegExp(`^\\s*(?:Import-Module|Start-Process|pwsh|powershell)\\b[^\\r\\n]*${escaped}`, 'iu'),
    new RegExp(`^\\s*(?:\\.|&)\\s*(?:\\(\\s*)?(?:Join-Path\\s+[^\\r\\n]*?\\s+)?['\"][^'\"]*${escaped}`, 'iu'),
    new RegExp(`^\\s*(?:run|command|args)\\s*[:=][^\\r\\n]*${escaped}`, 'iu'),
  ];
  return patterns.some((pattern) => pattern.test(selector));
}

function git(repoRoot: string, args: string[]): string {
  const result = runProcessSync({ command: 'git', args: ['-C', repoRoot, ...args], cwd: repoRoot, inheritParentEnv: true });
  if (!result.ok) throw new Error(result.stderr || result.error || `git_${args.join('_')}_failed`);
  return result.stdout.trim();
}

function isAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
  return runProcessSync({
    command: 'git',
    args: ['-C', repoRoot, 'merge-base', '--is-ancestor', ancestor, descendant],
    cwd: repoRoot,
    inheritParentEnv: true,
  }).ok;
}

function assertFoundationAndPr2a(repoRoot: string, installedCommitSha: string): string {
  const baseRef = git(repoRoot, ['rev-parse', `${installedCommitSha}^`]);
  if (!isAncestor(repoRoot, PR2A_LANDING_COMMIT, baseRef)) throw new Error('pr2a_merge_missing');
  return baseRef;
}

function recomputeClosure(repoRoot: string, baseRef: string): { inputTree: string; referenceCount: number } {
  const scanner = path.join(repoRoot, 'scripts', 'pr2a', 'closed-world-scanner.ts');
  const result = runProcessSync({
    command: process.execPath,
    args: ['--experimental-strip-types', scanner, '--ref', baseRef],
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  if (!result.ok) throw new Error(`closure_recompute_failed:${result.stderr || result.error || result.exitCode}`);
  const manifest = JSON.parse(result.stdout) as {
    schemaVersion?: number;
    lineage?: { planningBaseTreeOid?: string };
    references?: ClosureReferenceRow[];
    unknown?: unknown[];
    dynamicUnsupported?: unknown[];
  };
  if (manifest.schemaVersion !== 1) throw new Error('closure_schema_incompatible');
  if (!manifest.lineage?.planningBaseTreeOid) throw new Error('closure_input_tree_unbound');
  if ((manifest.unknown ?? []).length !== 0 || (manifest.dynamicUnsupported ?? []).length !== 0) {
    throw new Error('closure_unresolved_set_nonempty');
  }
  const references = (manifest.references ?? []).filter((row) => TARGET_LIBRARIES.has(String(row.target ?? '').replace(/\\/g, '/')));
  const external = references.filter((row) => {
    const source = String(row.source ?? '').replace(/\\/g, '/');
    return !D928.has(source) && isExecutableLegacyReference(row);
  });
  if (external.length !== 0) throw new Error(`external_legacy_reference:${external.map((row) => row.source).join(',')}`);
  return { inputTree: manifest.lineage.planningBaseTreeOid, referenceCount: references.length };
}

export interface FoundationAdmissionProof {
  result: 'foundation-evidence-verified';
  evidencePath: string;
  localHostId: string;
  oldInstalledCommitSha: string;
  heartbeatObservedAt: string;
  migrationJournalCount: number;
  preflightSanitizerId: string;
}

function readFoundationEvidence(request: ActivationRequest): { evidence: FoundationAdmissionEvidence; evidencePath: string } {
  const stateRoot = realpathSync(request.paths.stateDir);
  const evidencePath = realpathSync(request.paths.foundationEvidencePath);
  const relative = path.relative(stateRoot, evidencePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('foundation_evidence_outside_state_root');
  }
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as FoundationAdmissionEvidence;
  if (!evidence || evidence.schemaVersion !== 1 || evidence.issue !== 923) throw new Error('foundation_evidence_schema_invalid');
  if (evidence.foundationMergeCommitSha !== FOUNDATION_LANDING_COMMIT) throw new Error('foundation_evidence_merge_binding_invalid');
  return { evidence, evidencePath };
}

function proveFoundationAdoption(request: ActivationRequest): FoundationAdmissionProof {
  const { evidence, evidencePath } = readFoundationEvidence(request);
  const preflight = validateAoPreflight(evidence.preflight);
  if (!preflight.ok) throw new Error(`foundation_preflight_invalid:${preflight.reason}`);
  const config = parseFoundationConfig(evidence.typedConfig);
  if (!config.ok) throw new Error(`foundation_typed_config_invalid:${config.reason}:${config.path}`);
  const catalog = validateRuntimeCatalog(FOUNDATION_RUNTIME_CATALOG, evidence.runtimeCatalog as RuntimeSurface[]);
  if (!catalog.ok) throw new Error(`foundation_runtime_catalog_invalid:${catalog.reason}:${catalog.surface ?? ''}`);
  if (evidence.inertProof?.result !== 'live-acquirers-unchanged') throw new Error('foundation_inert_proof_missing');
  if (!Array.isArray(evidence.migrationJournalPaths) || evidence.migrationJournalPaths.length === 0) {
    throw new Error('foundation_migration_journal_missing');
  }
  for (const journalPath of evidence.migrationJournalPaths) {
    const journal = readMigrationJournal(journalPath);
    if (!journal.ok || journal.record?.state !== 'committed') throw new Error(`foundation_migration_journal_invalid:${journalPath}`);
  }

  const observedLocalHost = localHostId();
  if (!request.hostId || request.hostId !== observedLocalHost) throw new Error('foundation_host_unbound');
  const oldInstalledCommitSha = git(request.oldInstalledRevisionRoot, ['rev-parse', 'HEAD']);
  if (!isAncestor(request.oldInstalledRevisionRoot, FOUNDATION_LANDING_COMMIT, oldInstalledCommitSha)) {
    throw new Error('foundation_merge_missing_from_old_install');
  }
  const configuredHosts = new Map(request.knownMemberRoster.map((row) => [row.hostId, row]));
  if (configuredHosts.size !== request.knownMemberRoster.length || !configuredHosts.has(request.hostId)) {
    throw new Error('foundation_roster_invalid');
  }
  for (const member of request.knownMemberRoster) {
    if (member.hostId !== request.hostId && member.quarantined !== true) throw new Error('second_control_plane_host');
  }
  if (!Array.isArray(evidence.heartbeats) || evidence.heartbeats.length === 0) throw new Error('foundation_heartbeat_missing');
  const heartbeatHosts = new Set<string>();
  for (const heartbeat of evidence.heartbeats) {
    if (!heartbeat?.hostId || heartbeatHosts.has(heartbeat.hostId)) throw new Error('foundation_heartbeat_roster_invalid');
    heartbeatHosts.add(heartbeat.hostId);
    const configured = configuredHosts.get(heartbeat.hostId);
    if (!configured) throw new Error(`foundation_unknown_member:${heartbeat.hostId}`);
    if (heartbeat.hostId !== request.hostId) {
      if (configured.quarantined !== true) throw new Error(`foundation_member_not_quarantined:${heartbeat.hostId}`);
      continue;
    }
    const observedMs = Date.parse(heartbeat.observedAt);
    const nowMs = Date.now();
    if (!Number.isFinite(observedMs) || observedMs > nowMs + 30_000 || nowMs - observedMs > FOUNDATION_HEARTBEAT_MAX_AGE_MS) {
      throw new Error('foundation_heartbeat_stale');
    }
    if (heartbeat.active !== true || heartbeat.installedCommitSha !== oldInstalledCommitSha) {
      throw new Error('foundation_member_not_adopted');
    }
  }
  for (const member of request.knownMemberRoster) {
    if (member.quarantined !== true && !heartbeatHosts.has(member.hostId)) throw new Error(`foundation_member_omitted:${member.hostId}`);
  }
  const localHeartbeat = evidence.heartbeats.find((row) => row.hostId === request.hostId);
  if (!localHeartbeat) throw new Error('foundation_local_heartbeat_missing');
  const legacyIdentity = readProcessIdentity(request.legacySupervisorPid);
  assertLegacySupervisor(legacyIdentity, request.oldInstalledRevisionRoot);
  if (!processAlive(legacyIdentity.pid)) throw new Error('foundation_legacy_supervisor_not_active');
  return {
    result: 'foundation-evidence-verified',
    evidencePath,
    localHostId: observedLocalHost,
    oldInstalledCommitSha,
    heartbeatObservedAt: localHeartbeat.observedAt,
    migrationJournalCount: evidence.migrationJournalPaths.length,
    preflightSanitizerId: preflight.sanitizerId,
  };
}

async function waitForStartedSupervisor(request: ActivationRequest, nonce: string, expectedPid: number): Promise<{ supervisorPid: number; childGeneration: number }> {
  const deadline = Date.now() + 10_000;
  do {
    const status = readSupervisorStatus({ stateDir: request.paths.supervisorStateDir });
    if (status?.restartState === 'refused') throw new Error(`typescript_supervisor_refused:${status.refusalReason ?? 'unknown'}`);
    if (
      status
      && status.epochId === request.epochId
      && status.nonce === nonce
      && status.supervisorPid === expectedPid
      && status.restartState === 'running'
      && processAlive(expectedPid)
      && status.registryHash
      && status.childPid !== null
      && processAlive(status.childPid)
      && status.childGeneration >= 1
    ) {
      return { supervisorPid: expectedPid, childGeneration: status.childGeneration };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('typescript_supervisor_scheduler_not_ready');
}

async function startSupervisor(request: ActivationRequest, nonce: string): Promise<{ supervisorPid: number; childGeneration: number }> {
  const entry = path.join(request.repoRoot, 'scripts', 'orchestrator-wake-supervisor.ts');
  const result = await runProcess({
    command: process.execPath,
    args: [
      '--experimental-strip-types', entry, 'run',
      '--state-dir', request.paths.supervisorStateDir,
      '--epoch-authority', request.paths.epochAuthorityPath,
      '--epoch-id', request.epochId,
      '--nonce', nonce,
      '--target-registry', request.paths.targetRegistryPath,
      '--projected-registry', request.paths.projectedRegistryPath,
      '--repo-root', request.repoRoot,
      '--detach',
    ],
    cwd: request.repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 20_000,
  });
  if (!result.ok) throw new Error(`typescript_supervisor_start_failed:${result.stderr || result.error || result.exitCode}`);
  const parsed = JSON.parse(result.stdout.trim()) as { pid?: number };
  const pid = Number(parsed.pid);
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('typescript_supervisor_pid_missing');
  return waitForStartedSupervisor(request, nonce, pid);
}

export interface ActivationBoundary {
  preflight(request: ActivationRequest): PlatformPreflightResult;
  proveFoundationAdoption(request: ActivationRequest): FoundationAdmissionProof;
  resolveBaseAndClosure(request: ActivationRequest): { baseRef: string; closure: { inputTree: string; referenceCount: number } };
  readLegacySupervisor(request: ActivationRequest): ReturnType<typeof readProcessIdentity>;
  captureLegacyWriters(request: ActivationRequest): LegacyWriterRecord[];
  drainLegacyWriters(request: ActivationRequest, writers: LegacyWriterRecord[]): Promise<{ writerWatermark: string; drainedAt: string }>;
  terminateLegacyProcesses(identities: ReturnType<typeof readProcessIdentity>[]): Promise<number[]>;
  verifyLegacyProcessesGone(request: ActivationRequest, legacySupervisor: ReturnType<typeof readProcessIdentity>): { supervisorAlive: boolean; writers: LegacyWriterRecord[] };
  startTypeScriptSupervisor(request: ActivationRequest, nonce: string): Promise<{ supervisorPid: number; childGeneration: number }>;
  observeFinalHealthAndDelivery(
    request: ActivationRequest,
    core: EpochCommitCore,
    supervisor: { supervisorPid: number; childGeneration: number },
  ): Promise<SchedulerHealthDeliveryObservation>;
}

export const productionActivationBoundary: ActivationBoundary = {
  preflight: (request) => runActivationPlatformPreflight({
    repoRoot: request.repoRoot,
    installedCommitSha: request.installedCommitSha,
    oldInstalledRevisionRoot: request.oldInstalledRevisionRoot,
    targetRegistryPath: request.paths.targetRegistryPath,
    projectedRegistryPath: request.paths.projectedRegistryPath,
  }),
  proveFoundationAdoption,
  resolveBaseAndClosure: (request) => {
    const baseRef = assertFoundationAndPr2a(request.repoRoot, request.installedCommitSha);
    return { baseRef, closure: recomputeClosure(request.repoRoot, baseRef) };
  },
  readLegacySupervisor: (request) => {
    const identity = readProcessIdentity(request.legacySupervisorPid);
    assertLegacySupervisor(identity, request.oldInstalledRevisionRoot);
    return identity;
  },
  captureLegacyWriters: (request) => captureLegacyWriters(request.oldInstalledRevisionRoot, request.paths.supervisorStateDir),
  drainLegacyWriters: (_request, writers) => waitForLegacyWriterDrain(writers),
  terminateLegacyProcesses: async (identities) => {
    const terminated: number[] = [];
    for (const identity of identities) terminated.push(...await terminateProcessTree(identity));
    return [...new Set(terminated)];
  },
  verifyLegacyProcessesGone: (request, legacySupervisor) => ({
    supervisorAlive: processAlive(legacySupervisor.pid),
    writers: captureLegacyWriters(request.oldInstalledRevisionRoot, request.paths.supervisorStateDir),
  }),
  startTypeScriptSupervisor: (request, nonce) => startSupervisor(request, nonce),
  observeFinalHealthAndDelivery: observeSchedulerHealthAndDelivery,
};

export async function activateCutover(
  request: ActivationRequest,
  boundary: ActivationBoundary = productionActivationBoundary,
): Promise<Record<string, unknown>> {
  const preflight = boundary.preflight(request);
  const foundation = boundary.proveFoundationAdoption(request);
  if (request.stores.length !== 3 || new Set(request.stores.map((row) => row.id)).size !== 3) throw new Error('store_roster_invalid');
  const { baseRef, closure } = boundary.resolveBaseAndClosure(request);
  const legacySupervisor = boundary.readLegacySupervisor(request);
  const legacyWriters = boundary.captureLegacyWriters(request);

  const cordon = createCordon({
    path: request.paths.cordonPath,
    epochId: request.epochId,
    expectedOldEpochId: request.expectedOldEpochId,
    hostId: request.hostId,
    repoRoot: preflight.repoRoot,
    installedCommitSha: request.installedCommitSha,
    oldInstalledRevisionRoot: preflight.oldInstalledRevisionRoot,
    legacyStateRoot: request.paths.supervisorStateDir,
    legacySupervisor,
    stores: request.stores,
    paths: request.paths,
  });
  appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'admission', { preflight, foundation, closure, baseRef });
  appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'cordon', { writersClosed: true, noRespawn: true, noTypeScriptStart: true });

  const drain = await boundary.drainLegacyWriters(request, legacyWriters);
  appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'writer-drain', { writers: legacyWriters, ...drain });

  const terminated = await boundary.terminateLegacyProcesses([...legacyWriters.map((row) => row.identity), legacySupervisor]);
  const survivors = boundary.verifyLegacyProcessesGone(request, legacySupervisor);
  if (survivors.supervisorAlive || survivors.writers.length !== 0) {
    throw new Error(`legacy_process_survivor:supervisor=${survivors.supervisorAlive};writers=${survivors.writers.map((row) => row.childId).join(',')}`);
  }
  appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'legacy-supervisor-and-writers-terminated', {
    supervisor: legacySupervisor,
    writers: legacyWriters,
    terminated,
    reenumeratedEmpty: true,
  });

  const snapshots = snapshotStores(request.stores, request.paths.snapshotDir, drain.writerWatermark);
  appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'snapshots', snapshots);

  const importBoundary = markImportBegun(request.paths.cordonPath);
  appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'import-begun', { importBegunAt: importBoundary.importBegunAt });
  const imports = request.stores.map((spec) => importSnapshot({
    epochId: request.epochId,
    nonce: cordon.nonce,
    spec,
    snapshot: snapshots.find((row) => row.storeId === spec.id)!,
  }));
  appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'imports', imports);

  const projection = projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath);
  appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'registry-projected', projection);

  const phaseOne = finalizePhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce);
  const core = buildEpochCommitCore({
    epochId: request.epochId,
    nonce: cordon.nonce,
    hostId: request.hostId,
    repoRoot: preflight.repoRoot,
    installedCommitSha: request.installedCommitSha,
    snapshotDigests: mapCutoverStoreDigests(snapshots, (row) => row.snapshotDigest),
    importDigests: mapCutoverStoreDigests(imports, (row) => row.importTargetDigest),
    registryHash: projection.registryHash,
    preCommitLogDigest: phaseOne.digest,
  });
  const authority = new FileEpochAuthority(request.paths.epochAuthorityPath);
  authority.commit(request.expectedOldEpochId, core);
  const committed = authority.verify(request.epochId, cordon.nonce);
  verifyPhaseOneDigest(request.paths.phaseOnePath, request.epochId, cordon.nonce, committed.preCommitLogDigest);

  const committedProjection = projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath);
  if (committedProjection.registryHash !== committed.registryHash) throw new Error('committed_registry_hash_mismatch');
  appendFollowup(request.paths.followupPath, request.epochId, 'committed-registry-reprojected', committedProjection);
  const supervisor = await boundary.startTypeScriptSupervisor(request, cordon.nonce);
  appendFollowup(request.paths.followupPath, request.epochId, 'typescript-supervisor-started', { pid: supervisor.supervisorPid });
  appendFollowup(request.paths.followupPath, request.epochId, 'scheduler-owned', {
    childId: 'pr2-scheduler',
    supervisorPid: supervisor.supervisorPid,
    childGeneration: supervisor.childGeneration,
  });
  appendFollowup(request.paths.followupPath, request.epochId, 'machine-local-completion-fsync-confirmed', { path: request.paths.followupPath });
  appendFollowup(request.paths.followupPath, request.epochId, 'final-step-timestamp-recorded', { at: new Date().toISOString() });
  const observation = await boundary.observeFinalHealthAndDelivery(request, committed, supervisor);
  appendFollowup(request.paths.followupPath, request.epochId, 'final-health-delivery-observed', observation);
  appendFollowup(request.paths.followupPath, request.epochId, 'activation-complete', { at: new Date().toISOString(), observationResult: observation.result });

  return {
    cutover: {
      admission: { result: 'foundation-single-host-adopted' },
      activation: { result: 'C1-C18-ts-transfer-pass' },
      import_claim: { result: 'imports-and-claim-compatibility-verified' },
      recovery: { result: 'import-boundary-forward-only' },
      activation_evidence: { result: 'bound-central-cas-record' },
      merge_gate: { result: 'node22-linux-wsl2-and-pwsh-guards-green' },
    },
    epoch: committed,
    supervisorPid: supervisor.supervisorPid,
    childGeneration: supervisor.childGeneration,
  };
}

export function abandonPreImportCordon(request: ActivationRequest): void {
  if (!existsSync(request.paths.cordonPath)) return;
  const cordon = readCordonState(request.paths.cordonPath);
  assertCordonRequestBinding(request, cordon);
  if (cordon.importBegunAt) throw new Error('forward_only_recovery_required');
  for (const store of cordon.recoveryBindings.stores) {
    if (fileDigestOrAbsent(store.targetPath) !== cordon.preImportTargetDigests?.[store.id]) {
      throw new Error(`preimport_target_changed:${store.id}`);
    }
  }
  releaseLegacyStartBarrier(request.paths.supervisorStateDir);
  rmSync(request.paths.cordonPath, { force: true });
}
