import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { runProcessSync, runProcess } from '../../kernel/subprocess.ts';
import {
  appendFollowup,
  appendPhaseOne,
  finalizePhaseOne,
  verifyFoundationEvidenceDigest,
  verifyFoundationEvidenceObservation,
  verifyPhaseOneDigest,
} from './activation-evidence.ts';
import {
  assertCordonRequestBinding,
  assertLegacySupervisor,
  captureLegacyWriters,
  createCordon,
  fileDigestOrAbsent,
  findLegacySupervisorIdentities,
  findTypeScriptSupervisorIdentities,
  markImportBegun,
  processAlive,
  processAliveStrict,
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
import {
  assertCanonicalActivationPaths,
  canonicalConfigAndAppStateEqual,
  discoverCommittedMigrationJournals,
  RUNTIME_ADAPTER_TIMEOUT_MS,
  localObservedHostId,
  observeGreenfieldFoundationInertProof,
  observeGreenfieldFoundationObservation,
  observeFoundationInertProof,
  validateGreenfieldRuntimeAdapterPreflight,
  observeLiveHeartbeat,
  observeLocalHeartbeat,
  readObservedAppStateVersion,
  observeRuntimePreflight,
  observeRuntimeAdapterPreflight,
} from './foundation-observation.ts';
import { readSupervisorStatus } from '../orchestrator-side-process-supervisor.ts';
import { D928 as D928_PATHS, TARGET_LIBRARIES as TARGET_LIBRARY_PATHS } from '../../pr2a/contracts.ts';
import { validateRuntimePreflight } from '../../pr2-foundation/binding.ts';
import { parseFoundationConfig } from '../../pr2-foundation/config.ts';
import { readMigrationJournal } from '../../pr2-foundation/migration-journal.ts';
import { FOUNDATION_RUNTIME_CATALOG, validateRuntimeCatalog, type RuntimeSurface } from '../../pr2-foundation/runtime-catalog.ts';
import { readLiveSingleInstanceLease } from '../../runtime/single-instance-lease.ts';
import { sha256Stable, stableStringify } from './stable-stringify.ts';

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

interface ClosureDenominatorRow {
  path?: string;
  executionClass?: ClosureExecutionClass;
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

function candidateReferencePrimitiveClass(source: string): string {
  if (/\.(?:ps1|psm1)$/iu.test(source)) return 'powershell-dot-source-or-actionable-reference';
  if (/\.(?:ts|mts|cts|js|mjs|cjs)$/iu.test(source)) return 'javascript-import-child-or-actionable-reference';
  return 'config-or-policy-reference';
}

export function candidateLegacyReferenceRows(
  grepOutput: string,
  denominator: readonly ClosureDenominatorRow[],
): ClosureReferenceRow[] {
  const executionByPath = new Map(
    denominator
      .filter((row): row is Required<ClosureDenominatorRow> => Boolean(row.path && row.executionClass))
      .map((row) => [row.path.replace(/\\/g, '/'), row.executionClass]),
  );
  const rows: ClosureReferenceRow[] = [];
  for (const rawLine of grepOutput.split(/\r?\n/u).filter(Boolean)) {
    const match = /^[^:]+:([^:]+):(\d+):(.*)$/u.exec(rawLine);
    if (!match) throw new Error(`closure_reference_unparseable:${rawLine}`);
    const source = match[1]!.replace(/\\/g, '/');
    const selector = match[3]!;
    const sourceExecutionClass = executionByPath.get(source);
    if (!sourceExecutionClass) throw new Error(`closure_source_unclassified:${source}`);
    for (const target of TARGET_LIBRARY_PATHS) {
      if (!selector.includes(path.posix.basename(target))) continue;
      rows.push({
        source,
        target,
        primitiveClass: candidateReferencePrimitiveClass(source),
        selector,
        sourceExecutionClass,
      });
    }
  }
  return rows;
}

export function recomputeClosure(repoRoot: string, baseRef: string): { inputTree: string; referenceCount: number } {
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
    denominator?: ClosureDenominatorRow[];
    unknown?: unknown[];
    dynamicUnsupported?: unknown[];
  };
  if (manifest.schemaVersion !== 1) throw new Error('closure_schema_incompatible');
  if (!manifest.lineage?.planningBaseTreeOid) throw new Error('closure_input_tree_unbound');
  if ((manifest.unknown ?? []).length !== 0 || (manifest.dynamicUnsupported ?? []).length !== 0) {
    throw new Error('closure_unresolved_set_nonempty');
  }
  if (!Array.isArray(manifest.denominator)) throw new Error('closure_denominator_missing');

  const grep = runProcessSync({
    command: 'git',
    args: [
      '-C', repoRoot, 'grep', '-n', '-I', '-E',
      '(Review-StartClaim\\.ps1|Orchestrator-SideProcessSupervisor\\.ps1)',
      baseRef,
    ],
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  if (!grep.ok && grep.exitCode !== 1) throw new Error(`closure_reference_scan_failed:${grep.stderr || grep.error || grep.exitCode}`);
  const references = candidateLegacyReferenceRows(grep.stdout, manifest.denominator);
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
  activationMode?: 'legacy-handover' | 'greenfield';
  writerWatermark?: string;
}

function readFoundationEvidence(request: ActivationRequest): { evidence: FoundationAdmissionEvidence; evidencePath: string } {
  const canonical = assertCanonicalActivationPaths(request);
  const stateRoot = realpathSync(canonical.stateRoot);
  const evidencePath = realpathSync(canonical.evidencePath);
  const relative = path.relative(stateRoot, evidencePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('foundation_evidence_outside_state_root');
  }
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as FoundationAdmissionEvidence;
  if (!evidence || evidence.schemaVersion !== 1 || evidence.issue !== 923) throw new Error('foundation_evidence_schema_invalid');
  if (evidence.foundationMergeCommitSha !== FOUNDATION_LANDING_COMMIT) throw new Error('foundation_evidence_merge_binding_invalid');
  verifyFoundationEvidenceDigest(evidence);
  if (evidence.greenfieldObservation?.mode === 'greenfield-observed') {
    let observedGreenfield: FoundationAdmissionEvidence['greenfieldObservation'];
    try {
      observedGreenfield = observeGreenfieldFoundationObservation({
        repoRoot: request.repoRoot,
        paths: canonical,
      });
    } catch {
      throw new Error('foundation_evidence_observation_mismatch:greenfield_inputs');
    }
    if (stableStringify(evidence.greenfieldObservation) !== stableStringify(observedGreenfield)) {
      throw new Error('foundation_evidence_observation_mismatch:greenfield_inputs');
    }
    if (evidence.typedConfig !== null || evidence.migrationJournalPaths.length !== 0
      || 'appStateVersion' in evidence.preflight) {
      throw new Error('foundation_greenfield_artifact_claim_invalid');
    }
    const inertProof = observeGreenfieldFoundationInertProof({
      repoRoot: request.repoRoot,
      paths: canonical,
    });
    if (stableStringify(evidence.inertProof) !== stableStringify(inertProof)) {
      throw new Error('foundation_evidence_observation_mismatch:inert_proof');
    }
    return { evidence, evidencePath };
  }
  let observedConfig: unknown;
  try {
    observedConfig = JSON.parse(readFileSync(canonical.configPath, 'utf8')) as unknown;
  } catch {
    throw new Error('foundation_typed_config_unobservable');
  }
  const observedAppStateVersion = readObservedAppStateVersion(canonical.appStatePath);
  if (!('appStateVersion' in evidence.preflight)) throw new Error('foundation_evidence_schema_invalid');
  if (!canonicalConfigAndAppStateEqual(
    evidence.typedConfig,
    observedConfig,
    evidence.preflight.appStateVersion,
    observedAppStateVersion,
  )) {
    throw new Error('foundation_evidence_observation_mismatch:config_or_app_state');
  }
  const observedJournals = discoverCommittedMigrationJournals(canonical.stateRoot);
  if (stableStringify(evidence.migrationJournalPaths) !== stableStringify(observedJournals)) {
    throw new Error('foundation_evidence_observation_mismatch:migration_journals');
  }
  const inertProof = observeFoundationInertProof({
    repoRoot: request.repoRoot,
    paths: canonical,
  });
  if (stableStringify(evidence.inertProof) !== stableStringify(inertProof)) {
    throw new Error('foundation_evidence_observation_mismatch:inert_proof');
  }
  return { evidence, evidencePath };
}

function assertGreenfieldAbsence(
  request: ActivationRequest,
): { writerWatermark: string } {
  const canonical = assertCanonicalActivationPaths(request);
  const observedLocalHost = localObservedHostId();
  if (request.hostId !== observedLocalHost) throw new Error('greenfield_host_unbound');
  const authority = new FileEpochAuthority(canonical.epochAuthorityPath).read();
  if (authority.currentEpochId !== null || authority.records.length !== 0) {
    throw new Error('greenfield_epoch_authority_not_empty');
  }
  const statusPath = path.join(canonical.supervisorStateDir, 'typescript-supervisor-status.json');
  try {
    const status = readSupervisorStatus({ stateDir: canonical.supervisorStateDir });
    if (status) {
      if (status.schemaVersion !== 1 || status.childId !== 'pr2-scheduler' || typeof status.restartState !== 'string') {
        throw new Error('greenfield_registered_child_unknown');
      }
      const supervisorAlive = Number.isInteger(status.supervisorPid)
        && status.supervisorPid > 1
        && processAliveStrict(status.supervisorPid);
      const childAlive = Number.isInteger(status.childPid)
        && status.childPid !== null
        && status.childPid > 1
        && processAliveStrict(status.childPid);
      if (supervisorAlive || childAlive) throw new Error('greenfield_registered_child_alive');
    }
    const lease = readLiveSingleInstanceLease(path.join(canonical.supervisorStateDir, 'typescript-supervisor.lock'));
    if (lease) throw new Error('greenfield_registered_supervisor_alive');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('greenfield_')) throw error;
    throw new Error(`greenfield_control_plane_unknown:${statusPath}`);
  }

  const writers = captureLegacyWriters(request.oldInstalledRevisionRoot, canonical.supervisorStateDir);
  if (writers.length !== 0) throw new Error('greenfield_legacy_writer_present');
  const legacyCandidates = findLegacySupervisorIdentities(request.oldInstalledRevisionRoot);
  if (legacyCandidates.length !== 0) throw new Error('greenfield_legacy_supervisor_present');
  const typescriptCandidates = findTypeScriptSupervisorIdentities();
  if (typescriptCandidates.length !== 0) throw new Error('greenfield_typescript_supervisor_present');
  return {
    writerWatermark: sha256Stable({
      result: 'greenfield-no-legacy-writers',
      hostId: request.hostId,
      observedAt: new Date().toISOString(),
    }),
  };
}

async function proveFoundationAdoption(request: ActivationRequest): Promise<FoundationAdmissionProof> {
  const { evidence, evidencePath } = readFoundationEvidence(request);
  const greenfield = evidence.greenfieldObservation?.mode === 'greenfield-observed';
  const preflight = greenfield
    ? validateGreenfieldRuntimeAdapterPreflight(evidence.preflight)
    : ('appStateVersion' in evidence.preflight
      ? validateRuntimePreflight(evidence.preflight)
      : { ok: false as const, reason: 'preflight_version_unverifiable' });
  if (!preflight.ok) throw new Error(`foundation_preflight_invalid:${preflight.reason}`);
  const config = greenfield ? null : parseFoundationConfig(evidence.typedConfig);
  if (!greenfield && !config?.ok) throw new Error(`foundation_typed_config_invalid:${config?.reason}:${config?.path}`);
  const catalog = validateRuntimeCatalog(FOUNDATION_RUNTIME_CATALOG, evidence.runtimeCatalog as RuntimeSurface[]);
  if (!catalog.ok) throw new Error(`foundation_runtime_catalog_invalid:${catalog.reason}:${catalog.surface ?? ''}`);
  const expectedInertProofResult = greenfield ? 'greenfield-dormant-layer-not-active' : 'live-acquirers-unchanged';
  if (evidence.inertProof?.result !== expectedInertProofResult) throw new Error('foundation_inert_proof_missing');
  if (!greenfield && (!Array.isArray(evidence.migrationJournalPaths) || evidence.migrationJournalPaths.length === 0)) {
    throw new Error('foundation_migration_journal_missing');
  }
  if (greenfield && (evidence.typedConfig !== null || evidence.migrationJournalPaths.length !== 0)) {
    throw new Error('foundation_greenfield_artifact_claim_invalid');
  }
  if (!greenfield) {
    for (const journalPath of evidence.migrationJournalPaths) {
      const journal = readMigrationJournal(journalPath);
      if (!journal.ok || journal.record?.state !== 'committed') throw new Error(`foundation_migration_journal_invalid:${journalPath}`);
    }
  }

  const observedLocalHost = localHostId();
  if (!request.hostId || request.hostId !== observedLocalHost) throw new Error('foundation_host_unbound');
  const configuredHosts = new Map(request.knownMemberRoster.map((row) => [row.hostId, row]));
  if (configuredHosts.size !== request.knownMemberRoster.length
    || configuredHosts.size === 0
    || !configuredHosts.has(request.hostId)
    || !configuredHosts.has(observedLocalHost)) {
    throw new Error('foundation_roster_invalid');
  }
  for (const member of request.knownMemberRoster) {
    if (member.hostId !== request.hostId && member.quarantined !== true) throw new Error('second_control_plane_host');
  }
  const oldInstalledCommitSha = git(request.oldInstalledRevisionRoot, ['rev-parse', 'HEAD']);
  if (!isAncestor(request.oldInstalledRevisionRoot, FOUNDATION_LANDING_COMMIT, oldInstalledCommitSha)) {
    throw new Error('foundation_merge_missing_from_old_install');
  }
  const canonical = assertCanonicalActivationPaths(request);
  let observedConfig: unknown = null;
  let observedAppStateVersion: string | undefined;
  let livePreflight: FoundationAdmissionEvidence['preflight'];
  let migrationJournalPaths: string[] = [];
  let inertProof: FoundationAdmissionEvidence['inertProof'];
  if (greenfield) {
    let observedGreenfield: FoundationAdmissionEvidence['greenfieldObservation'];
    try {
      observedGreenfield = observeGreenfieldFoundationObservation({
        repoRoot: request.repoRoot,
        paths: canonical,
      });
    } catch {
      throw new Error('foundation_evidence_observation_mismatch:greenfield_inputs');
    }
    if (stableStringify(evidence.greenfieldObservation) !== stableStringify(observedGreenfield)) {
      throw new Error('foundation_evidence_observation_mismatch:greenfield_inputs');
    }
    inertProof = observeGreenfieldFoundationInertProof({
      repoRoot: request.repoRoot,
      paths: canonical,
    });
    livePreflight = await observeRuntimeAdapterPreflight(
      request.repoRoot,
      RUNTIME_ADAPTER_TIMEOUT_MS,
    );
  } else {
    if (!config || !config.ok) throw new Error('foundation_typed_config_invalid');
    try {
      observedConfig = JSON.parse(readFileSync(canonical.configPath, 'utf8')) as unknown;
    } catch {
      throw new Error('foundation_typed_config_unobservable');
    }
    observedAppStateVersion = readObservedAppStateVersion(canonical.appStatePath);
    livePreflight = await observeRuntimePreflight(
      request.repoRoot,
      config.config.notification.runtimePath,
      config!.config.notification.timeoutMs,
      observedAppStateVersion,
    );
    try {
      migrationJournalPaths = discoverCommittedMigrationJournals(canonical.stateRoot);
    } catch {
      throw new Error('foundation_migration_journal_unobservable');
    }
    try {
      inertProof = observeFoundationInertProof({
        repoRoot: request.repoRoot,
        paths: canonical,
      });
    } catch {
      throw new Error('foundation_inert_proof_unobservable');
    }
  }
  if (stableStringify(livePreflight) !== stableStringify(evidence.preflight)) {
    throw new Error('foundation_evidence_observation_mismatch:preflight');
  }
  const heartbeat = greenfield
    ? observeLiveHeartbeat(request.hostId, oldInstalledCommitSha)
    : observeLocalHeartbeat(request.hostId, oldInstalledCommitSha, canonical.configPath);
  verifyFoundationEvidenceObservation(evidence, {
    typedConfig: observedConfig,
    appStateVersion: observedAppStateVersion,
    migrationJournalPaths,
    inertProof,
    heartbeats: [heartbeat],
    heartbeatTimestampMode: greenfield ? 'fresh' : 'exact',
  });
  if (!Array.isArray(evidence.heartbeats) || evidence.heartbeats.length !== 1) throw new Error('foundation_heartbeat_roster_invalid');
  const heartbeatHosts = new Set<string>();
  for (const evidenceHeartbeat of evidence.heartbeats) {
    if (!evidenceHeartbeat?.hostId || heartbeatHosts.has(evidenceHeartbeat.hostId)) throw new Error('foundation_heartbeat_roster_invalid');
    heartbeatHosts.add(evidenceHeartbeat.hostId);
    const configured = configuredHosts.get(evidenceHeartbeat.hostId);
    if (!configured) throw new Error(`foundation_unknown_member:${evidenceHeartbeat.hostId}`);
    if (evidenceHeartbeat.hostId !== request.hostId) {
      if (configured.quarantined !== true) throw new Error(`foundation_member_not_quarantined:${evidenceHeartbeat.hostId}`);
      continue;
    }
    const observedMs = Date.parse(greenfield ? evidenceHeartbeat.observedAt : heartbeat.observedAt);
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
  if (heartbeat.hostId !== request.hostId) throw new Error('foundation_local_heartbeat_missing');
  const preflightObservationId = 'observationId' in preflight ? preflight.observationId : preflight.sanitizerId;
  if (request.legacySupervisorPid === undefined || request.legacySupervisorPid === null || request.legacySupervisorPid === 0) {
    const absence = assertGreenfieldAbsence(request);
    return {
      result: 'foundation-evidence-verified',
      evidencePath,
      localHostId: observedLocalHost,
      oldInstalledCommitSha,
      heartbeatObservedAt: greenfield ? evidence.heartbeats[0]!.observedAt : heartbeat.observedAt,
      migrationJournalCount: evidence.migrationJournalPaths.length,
      preflightSanitizerId: preflightObservationId,
      activationMode: 'greenfield',
      writerWatermark: absence.writerWatermark,
    };
  }
  const legacyIdentity = readProcessIdentity(request.legacySupervisorPid);
  assertLegacySupervisor(legacyIdentity, request.oldInstalledRevisionRoot);
  if (!processAlive(legacyIdentity.pid)) throw new Error('foundation_legacy_supervisor_not_active');
  return {
    result: 'foundation-evidence-verified',
    evidencePath,
    localHostId: observedLocalHost,
    oldInstalledCommitSha,
    heartbeatObservedAt: heartbeat.observedAt,
    migrationJournalCount: evidence.migrationJournalPaths.length,
    preflightSanitizerId: preflightObservationId,
    activationMode: 'legacy-handover',
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
  proveFoundationAdoption(request: ActivationRequest): FoundationAdmissionProof | Promise<FoundationAdmissionProof>;
  resolveBaseAndClosure(request: ActivationRequest): { baseRef: string; closure: { inputTree: string; referenceCount: number } };
  readLegacySupervisor(request: ActivationRequest): ReturnType<typeof readProcessIdentity>;
  captureLegacyWriters(request: ActivationRequest): LegacyWriterRecord[];
  findLegacySupervisorIdentities?(request: ActivationRequest): ReturnType<typeof findLegacySupervisorIdentities>;
  findTypeScriptSupervisorIdentities?(request: ActivationRequest): ReturnType<typeof findTypeScriptSupervisorIdentities>;
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
    const legacySupervisorPid = request.legacySupervisorPid;
    if (typeof legacySupervisorPid !== 'number' || !Number.isInteger(legacySupervisorPid) || legacySupervisorPid <= 1) {
      throw new Error('legacy_supervisor_pid_missing');
    }
    const identity = readProcessIdentity(legacySupervisorPid);
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
  const foundation = await boundary.proveFoundationAdoption(request);
  if (request.stores.length !== 3 || new Set(request.stores.map((row) => row.id)).size !== 3) throw new Error('store_roster_invalid');
  const { baseRef, closure } = boundary.resolveBaseAndClosure(request);
  const legacySupervisorPid = request.legacySupervisorPid;
  const greenfield = foundation.activationMode === 'greenfield';
  const legacyClaimed = !greenfield
    && typeof legacySupervisorPid === 'number'
    && Number.isInteger(legacySupervisorPid)
    && legacySupervisorPid > 1;
  const legacySupervisor = legacyClaimed ? boundary.readLegacySupervisor(request) : null;
  const legacyWriters = legacySupervisor ? boundary.captureLegacyWriters(request) : [];

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

  if (greenfield) {
    const writers = boundary.captureLegacyWriters(request);
    if (writers.length !== 0) throw new Error('greenfield_legacy_writer_present');
    const legacyCandidates = boundary.findLegacySupervisorIdentities
      ? boundary.findLegacySupervisorIdentities(request)
      : findLegacySupervisorIdentities(request.oldInstalledRevisionRoot);
    if (legacyCandidates.length !== 0) {
      throw new Error('greenfield_legacy_supervisor_present');
    }
    const typescriptCandidates = boundary.findTypeScriptSupervisorIdentities
      ? boundary.findTypeScriptSupervisorIdentities(request)
      : findTypeScriptSupervisorIdentities();
    if (typescriptCandidates.length !== 0) {
      throw new Error('greenfield_typescript_supervisor_present');
    }
  }
  const drain = legacySupervisor
    ? await (async () => {
      const drain = await boundary.drainLegacyWriters(request, legacyWriters);
      return drain;
    })()
    : { writerWatermark: foundation.writerWatermark ?? '', drainedAt: new Date().toISOString() };
  if (!drain.writerWatermark) throw new Error('writer_watermark_missing');
  appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'writer-drain', { writers: legacyWriters, ...drain });

  const terminated = legacySupervisor
    ? await boundary.terminateLegacyProcesses([...legacyWriters.map((row) => row.identity), legacySupervisor])
    : [];
  const survivors = legacySupervisor
    ? boundary.verifyLegacyProcessesGone(request, legacySupervisor)
    : { supervisorAlive: false, writers: [] };
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
