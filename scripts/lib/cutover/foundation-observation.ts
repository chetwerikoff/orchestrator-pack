import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileEpochAuthority } from './activation-epoch-authority.ts';
import {
  captureLegacyWriters,
  findLegacySupervisorIdentities,
  findTypeScriptSupervisorIdentities,
  processAliveStrict,
} from './activation-cordon.ts';
import { sha256Bytes, stableStringify } from './stable-stringify.ts';
import type {
  ActivationRequest,
  FoundationHeartbeatEvidence,
  FoundationInertObservation,
  GreenfieldFoundationObservation,
} from './types.ts';
import {
  processIdentityMatches,
  readSupervisorStatus,
} from '../orchestrator-side-process-supervisor.ts';
import { readMigrationJournal } from '../../pr2-foundation/migration-journal.ts';
import { resolveWakeSupervisorStateRoot } from '../../pr2-foundation/wake-supervisor-state-root.ts';
import { assertFoundationInert } from '../../pr2-foundation/scheduler.ts';
import { parseFoundationConfig } from '../../pr2-foundation/config.ts';
import {
  captureLeakReason,
  sanitizeRuntimeWorkers,
  sanitizerIdentity,
  validateRuntimePreflight,
  validateRuntimeWorkerRow,
  type RuntimeWorkerRow,
} from '../../pr2-foundation/binding.ts';
import { runProcess } from '../../kernel/subprocess.ts';
import type { FoundationAdmissionEvidence, FoundationArtifactPreflight } from './types.ts';
import { readLiveSingleInstanceLease } from '../../runtime/single-instance-lease.ts';
import {
  selectRuntimeAdapterFactory,
  type RuntimeAdapterInstanceOptions,
  type RuntimeSelectionOptions,
} from '../../runtime/registry.ts';
import type { RuntimeAdapter, RuntimeReadiness } from '../../runtime/contracts.ts';
import { sha256Stable } from './stable-stringify.ts';

export const RUNTIME_ADAPTER_TIMEOUT_MS = 30_000;
export const FOUNDATION_MIGRATION_JOURNAL_DIRECTORY = 'migration-journals';
export const FOUNDATION_MIGRATION_JOURNAL_SUFFIX = '.migration-journal.json';

export interface CanonicalFoundationPaths {
  stateRoot: string;
  supervisorStateDir: string;
  epochAuthorityPath: string;
  evidencePath: string;
  configPath: string;
  appStatePath: string;
  cordonPath: string;
  phaseOnePath: string;
  followupPath: string;
  projectedRegistryPath: string;
  snapshotDir: string;
}

export type ObservedFoundationInertInput = FoundationInertObservation;

function samePath(actual: string, expected: string): boolean {
  return path.resolve(actual) === path.resolve(expected);
}

function requirePath(actual: string, expected: string, label: string): void {
  if (!samePath(actual, expected)) throw new Error(`foundation_${label}_unobservable`);
}

function machineHomeDir(): string {
  const homeDir = os.userInfo().homedir.trim();
  if (!homeDir) throw new Error('foundation_state_root_unobservable');
  return homeDir;
}

export function canonicalFoundationPaths(_repoRoot: string, homeDir = machineHomeDir()): CanonicalFoundationPaths {
  const stateRoot = path.resolve(resolveWakeSupervisorStateRoot({
    env: {},
    homeDir,
    platform: process.platform,
  }));
  const supervisorStateDir = path.join(stateRoot, 'supervisor');
  return {
    stateRoot,
    supervisorStateDir,
    epochAuthorityPath: path.join(stateRoot, 'epoch-authority.json'),
    evidencePath: path.join(stateRoot, 'foundation-923-adoption.json'),
    configPath: path.join(stateRoot, 'foundation-config.json'),
    appStatePath: path.join(stateRoot, 'app-state.json'),
    cordonPath: path.join(stateRoot, 'cordon.json'),
    phaseOnePath: path.join(stateRoot, 'phase-one.json'),
    followupPath: path.join(stateRoot, 'followups.json'),
    projectedRegistryPath: path.join(supervisorStateDir, 'projected-registry.json'),
    snapshotDir: path.join(stateRoot, 'snapshots'),
  };
}

export function assertCanonicalActivationPaths(
  request: ActivationRequest,
): CanonicalFoundationPaths {
  if (String(process.env.OPK_WAKE_SUPERVISOR_STATE_DIR ?? '').trim()) {
    throw new Error('foundation_state_root_override_forbidden');
  }
  const canonical = canonicalFoundationPaths(request.repoRoot);
  requirePath(request.paths.stateDir, canonical.stateRoot, 'state_root');
  requirePath(request.paths.supervisorStateDir, canonical.supervisorStateDir, 'supervisor_state_root');
  requirePath(request.paths.epochAuthorityPath, canonical.epochAuthorityPath, 'epoch_authority');
  requirePath(request.paths.foundationEvidencePath, canonical.evidencePath, 'evidence_path');
  requirePath(request.paths.cordonPath, canonical.cordonPath, 'cordon_path');
  requirePath(request.paths.phaseOnePath, canonical.phaseOnePath, 'phase_one_path');
  requirePath(request.paths.followupPath, canonical.followupPath, 'followup_path');
  requirePath(request.paths.projectedRegistryPath, canonical.projectedRegistryPath, 'projected_registry_path');
  requirePath(request.paths.snapshotDir, canonical.snapshotDir, 'snapshot_dir');
  requirePath(
    request.paths.targetRegistryPath,
    path.join(path.resolve(request.repoRoot), 'scripts', 'orchestrator-side-process-registry.json'),
    'target_registry_path',
  );
  return canonical;
}

function readRecord(pathName: string, errorCode: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(pathName, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(errorCode);
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new Error(errorCode);
  }
}

function parseRuntimeRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') throw new Error('foundation_runtime_sessions_unobservable');
  const root = value as Record<string, unknown>;
  for (const key of ['sessions', 'workers', 'data']) {
    if (Array.isArray(root[key])) return root[key];
  }
  throw new Error('foundation_runtime_sessions_unobservable');
}

function parseJsonOutput(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
    if (!line) throw new Error('foundation_runtime_output_unobservable');
    try {
      return JSON.parse(line);
    } catch {
      throw new Error('foundation_runtime_output_unobservable');
    }
  }
}

export function observeCanonicalFilePresence(pathName: string, label: 'config' | 'app_state'): boolean {
  try {
    const metadata = lstatSync(pathName);
    if (!metadata.isFile()) throw new Error(`foundation_${label}_unobservable`);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === `foundation_${label}_unobservable`) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`foundation_${label}_unobservable`);
  }
}

export function validateGreenfieldRuntimeAdapterPreflight(
  input: FoundationAdmissionEvidence['preflight'],
): { ok: true; observationId: string } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'preflight_shape_invalid' };
  }
  const candidate = input as unknown as Record<string, unknown>;
  if (candidate.kind !== 'runtime-adapter') return { ok: false, reason: 'preflight_kind_mismatch' };
  if (typeof candidate.adapterId !== 'string' || !candidate.adapterId.trim()) {
    return { ok: false, reason: 'preflight_adapter_missing' };
  }
  const readiness = candidate.readiness;
  if (!readiness || typeof readiness !== 'object' || Array.isArray(readiness)) {
    return { ok: false, reason: 'preflight_readiness_unobservable' };
  }
  const observed = readiness as Record<string, unknown>;
  if (observed.ready !== true
    || typeof observed.workspacePath !== 'string'
    || !observed.workspacePath.trim()
    || (observed.headSha !== undefined && typeof observed.headSha !== 'string')
    || (observed.linkedIssue !== undefined
      && observed.linkedIssue !== null
      && !Number.isInteger(observed.linkedIssue))) {
    return { ok: false, reason: 'preflight_readiness_unobservable' };
  }
  if (typeof candidate.observationId !== 'string' || !candidate.observationId.trim()) {
    return { ok: false, reason: 'preflight_observation_id_missing' };
  }
  const expected = sha256Stable({ adapterId: candidate.adapterId, readiness });
  if (candidate.observationId !== expected) return { ok: false, reason: 'preflight_observation_id_mismatch' };
  return { ok: true, observationId: candidate.observationId };
}

export async function observeRuntimePreflight(
  repoRoot: string,
  runtimePath: string,
  timeoutMs: number,
  appStateVersion?: string,
): Promise<FoundationAdmissionEvidence['preflight']> {
  let runtime;
  try {
    runtime = await runProcess({
      command: runtimePath,
      args: ['session', 'ls', '--json'],
      cwd: repoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs,
    });
  } catch {
    throw new Error('foundation_runtime_observation_unobservable');
  }
  if (!runtime.ok) throw new Error('foundation_runtime_observation_unobservable');
  let payload: unknown;
  try {
    payload = parseJsonOutput(runtime.stdout);
  } catch {
    throw new Error('foundation_runtime_output_unobservable');
  }
  let observedRows: unknown[];
  try {
    observedRows = parseRuntimeRows(payload);
  } catch {
    throw new Error('foundation_runtime_sessions_unobservable');
  }
  let sanitized: RuntimeWorkerRow[];
  try {
    sanitized = sanitizeRuntimeWorkers(observedRows.map((row) => {
      if (!row || typeof row !== 'object') throw new Error('invalid_runtime_row');
      return row as RuntimeWorkerRow;
    }));
  } catch {
    throw new Error('foundation_runtime_sanitizer_unobservable');
  }
  const leak = captureLeakReason(sanitized);
  if (leak) throw new Error(`foundation_runtime_capture_unobservable:${leak}`);
  if (appStateVersion === undefined) throw new Error('foundation_runtime_preflight_version_unobservable');
  const livePreflight: FoundationArtifactPreflight = {
    command: 'a\u006f session ls --json',
    sessions: sanitized,
    sanitizerId: sanitizerIdentity(sanitized),
    appStateVersion,
  };
  const validatedPreflight = validateRuntimePreflight(livePreflight);
  if (!validatedPreflight.ok) throw new Error(`foundation_runtime_preflight_unobservable:${validatedPreflight.reason}`);
  return livePreflight;
}

export type RuntimeAdapterSelector = (
  options?: RuntimeSelectionOptions,
  instanceOptions?: RuntimeAdapterInstanceOptions,
) => Promise<RuntimeAdapter>;

const defaultRuntimeAdapterSelector: RuntimeAdapterSelector = async (options = {}, instanceOptions = {}) => {
  const factory = await selectRuntimeAdapterFactory(options);
  return factory(instanceOptions);
};

export async function observeRuntimeAdapterPreflight(
  repoRoot: string,
  timeoutMs: number,
  selectAdapter: RuntimeAdapterSelector = defaultRuntimeAdapterSelector,
): Promise<FoundationAdmissionEvidence['preflight']> {
  let adapter: RuntimeAdapter;
  try {
    adapter = await selectAdapter({}, { cwd: repoRoot, timeoutMs });
  } catch {
    throw new Error('foundation_runtime_adapter_unobservable');
  }
  const readReadiness = adapter.readiness.bind(adapter);
  const readiness = readReadiness({ cwd: repoRoot, timeoutMs });
  if (readiness.status !== 'ok') {
    throw new Error(`foundation_runtime_adapter_unobservable:${readiness.operation}:${readiness.reason}`);
  }
  const value: RuntimeReadiness = readiness.value;
  if (path.resolve(value.workspacePath) !== path.resolve(repoRoot)) {
    throw new Error('foundation_runtime_adapter_workspace_mismatch');
  }
  const livePreflight: FoundationAdmissionEvidence['preflight'] = {
    kind: 'runtime-adapter',
    adapterId: adapter.id,
    readiness: value,
    observationId: sha256Stable({ adapterId: adapter.id, readiness: value }),
  };
  const validated = validateGreenfieldRuntimeAdapterPreflight(livePreflight);
  if (!validated.ok) throw new Error(`foundation_runtime_adapter_unobservable:${validated.reason}`);
  return livePreflight;
}

export function readObservedAppStateVersion(pathName: string): string {
  const root = readRecord(pathName, 'foundation_preflight_version_unobservable');
  const version = [root.version, root.appStateVersion, root.appVersion]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (!version) throw new Error('foundation_preflight_version_unobservable');
  return version;
}

export function discoverCommittedMigrationJournals(stateRoot: string): string[] {
  const journals = observeCommittedMigrationJournals(stateRoot);
  if (journals.length === 0) throw new Error('foundation_migration_journal_unobservable');
  return journals;
}

export function observeCommittedMigrationJournals(stateRoot: string): string[] {
  if (!existsSync(stateRoot)) return [];
  const output: string[] = [];
  const visit = (directory: string): void => {
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(candidate);
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          const journal = readMigrationJournal(candidate);
          if (journal.ok && journal.record?.state === 'committed') output.push(path.resolve(candidate));
        }
      }
    } catch {
      throw new Error('foundation_migration_journal_unobservable');
    }
  };
  visit(stateRoot);
  const journals = [...new Set(output)].sort();
  return journals;
}

export function observeGreenfieldMigrationJournalAbsence(stateRoot: string): void {
  const journalDirectory = path.join(stateRoot, FOUNDATION_MIGRATION_JOURNAL_DIRECTORY);
  let entries;
  try {
    entries = readdirSync(journalDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('foundation_migration_journal_unobservable');
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(FOUNDATION_MIGRATION_JOURNAL_SUFFIX)) continue;
    const candidate = path.join(journalDirectory, entry.name);
    if (!entry.isFile()) throw new Error('foundation_migration_journal_unobservable');
    const journal = readMigrationJournal(candidate);
    if (!journal.ok) throw new Error('foundation_migration_journal_unobservable');
    if (journal.record !== null) throw new Error('greenfield_migration_journal_present');
  }
}

export function observeGreenfieldControlPlane(input: {
  repoRoot: string;
  paths: CanonicalFoundationPaths;
}): GreenfieldFoundationObservation['controlPlane'] {
  const observedHostId = localObservedHostId();
  const authority = new FileEpochAuthority(input.paths.epochAuthorityPath).read();
  if (authority.currentEpochId !== null || authority.records.length !== 0) {
    throw new Error('greenfield_epoch_authority_not_empty');
  }

  const supervisorStatusPath = path.join(input.paths.supervisorStateDir, 'typescript-supervisor-status.json');
  let supervisorStatusPresent = false;
  let supervisorAlive = false;
  let childAlive = false;
  try {
    const status = readSupervisorStatus({ stateDir: input.paths.supervisorStateDir });
    supervisorStatusPresent = status !== null;
    if (status) {
      if (status.schemaVersion !== 2 || status.childId !== 'pr2-scheduler' || typeof status.restartState !== 'string') {
        throw new Error('greenfield_registered_child_unknown');
      }
      supervisorAlive = processIdentityMatches(status.supervisorPid, status.supervisorStartTicks);
      childAlive = status.childPid !== null
        && processIdentityMatches(status.childPid, status.childStartTicks);
      if (supervisorAlive || childAlive) throw new Error('greenfield_registered_child_alive');
    }
    const singleInstanceLeasePath = path.join(input.paths.supervisorStateDir, 'typescript-supervisor.lock');
    const singleInstanceLeasePresent = readLiveSingleInstanceLease(singleInstanceLeasePath) !== null;
    if (singleInstanceLeasePresent) throw new Error('greenfield_registered_supervisor_alive');

    const writers = captureLegacyWriters(input.repoRoot, input.paths.supervisorStateDir);
    if (writers.length !== 0) throw new Error('greenfield_legacy_writer_present');
    const legacySupervisors = findLegacySupervisorIdentities(input.repoRoot);
    if (legacySupervisors.length !== 0) throw new Error('greenfield_legacy_supervisor_present');
    const typescriptSupervisors = findTypeScriptSupervisorIdentities();
    if (typescriptSupervisors.length !== 0) throw new Error('greenfield_typescript_supervisor_present');
    return {
      epochAuthorityPath: input.paths.epochAuthorityPath,
      epochAuthorityCurrentEpochId: null,
      epochAuthorityRecordCount: 0,
      supervisorStatusPath,
      supervisorStatusPresent,
      supervisorAlive: false,
      childAlive: false,
      singleInstanceLeasePath,
      singleInstanceLeasePresent: false,
      legacyWriterCount: 0,
      legacySupervisorCount: 0,
      typescriptSupervisorCount: 0,
      observedHostId,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('greenfield_')) throw error;
    if (error instanceof Error && error.message.includes('unobservable')) throw error;
    throw new Error(`foundation_greenfield_control_plane_unobservable:${error instanceof Error ? error.message : 'unknown'}`);
  }
}

export function observeGreenfieldFoundationObservation(input: {
  repoRoot: string;
  paths: CanonicalFoundationPaths;
}): GreenfieldFoundationObservation {
  const configPresent = observeCanonicalFilePresence(input.paths.configPath, 'config');
  const appStatePresent = observeCanonicalFilePresence(input.paths.appStatePath, 'app_state');
  if (configPresent) throw new Error('greenfield_foundation_config_present');
  if (appStatePresent) throw new Error('greenfield_app_state_present');
  const committedMigrationJournalPaths = observeCommittedMigrationJournals(input.paths.stateRoot);
  if (committedMigrationJournalPaths.length !== 0) throw new Error('greenfield_migration_journal_present');
  observeGreenfieldMigrationJournalAbsence(input.paths.stateRoot);
  return {
    mode: 'greenfield-observed',
    stateRoot: input.paths.stateRoot,
    foundationConfigPath: input.paths.configPath,
    foundationConfigPresent: false,
    appStatePath: input.paths.appStatePath,
    appStatePresent: false,
    committedMigrationJournalPaths: [],
    controlPlane: observeGreenfieldControlPlane(input),
  };
}

function fileDigestOrAbsent(pathName: string): string {
  if (!existsSync(pathName)) return 'absent';
  try {
    return sha256Bytes(readFileSync(pathName));
  } catch {
    throw new Error(`foundation_observation_unreadable:${pathName}`);
  }
}

function observeFoundationInertInputInternal(input: {
  repoRoot: string;
  paths: CanonicalFoundationPaths;
  allowAbsentTypedConfig?: boolean;
}, greenfield: boolean): ObservedFoundationInertInput {
  let configObserved = false;
  if (!existsSync(input.paths.configPath) && input.allowAbsentTypedConfig === true) {
    configObserved = false;
  } else {
    try {
      const config = parseFoundationConfig(JSON.parse(readFileSync(input.paths.configPath, 'utf8')) as unknown);
      configObserved = config.ok;
    } catch {
      throw new Error('foundation_typed_config_unobservable');
    }
  }
  const status = readSupervisorStatus({ stateDir: input.paths.supervisorStateDir });
  const statusV2 = status?.schemaVersion === 2 ? status : null;
  const supervisorAlive = statusV2
    ? processIdentityMatches(statusV2.supervisorPid, statusV2.supervisorStartTicks)
    : false;
  const childAlive = statusV2?.childPid !== null && statusV2?.childPid !== undefined
    ? processIdentityMatches(statusV2.childPid, statusV2.childStartTicks)
    : false;
  const singleInstanceLeasePath = path.join(input.paths.supervisorStateDir, 'typescript-supervisor.lock');
  const singleInstanceLeasePresent = readLiveSingleInstanceLease(singleInstanceLeasePath) !== null;
  const authority = new FileEpochAuthority(input.paths.epochAuthorityPath).read();
  const writerCount = captureLegacyWriters(
    input.repoRoot,
    input.paths.supervisorStateDir,
  ).length;
  const projectedExists = existsSync(input.paths.projectedRegistryPath);
  const registryChanged = projectedExists
    && fileDigestOrAbsent(path.join(input.repoRoot, 'scripts', 'orchestrator-side-process-registry.json'))
      !== fileDigestOrAbsent(input.paths.projectedRegistryPath);
  const supervisorChanged = greenfield
    ? status !== null || singleInstanceLeasePresent
    : status !== null;
  return {
    registryChanged,
    supervisorChanged,
    schedulerRegistered: supervisorChanged,
    schedulerRunning: supervisorAlive || childAlive,
    schedulerClaimAcquirer: supervisorAlive && childAlive && statusV2?.restartState === 'running',
    activationEpochEnforced: authority.currentEpochId !== null,
    liveStoreOpened: writerCount !== 0,
    legacyStarterDisabled: existsSync(path.join(input.repoRoot, 'scripts', 'orchestrator-wake-supervisor.ps1')),
    nonNotificationRuntimeDelta: Boolean(String(process.env.OPK_RUNTIME_ADAPTER ?? '').trim()),
    notificationTypedConfigLive: configObserved,
    dormantTypedConfigReaderLive: existsSync(path.join(input.paths.stateRoot, 'dormant-typed-config-reader.json')),
  };
}

export function observeFoundationInertInput(input: {
  repoRoot: string;
  paths: CanonicalFoundationPaths;
  allowAbsentTypedConfig?: boolean;
}): ObservedFoundationInertInput {
  return observeFoundationInertInputInternal(input, false);
}

export function observeFoundationInertProof(input: {
  repoRoot: string;
  paths: CanonicalFoundationPaths;
}): { result: 'live-acquirers-unchanged'; observations: FoundationInertObservation } {
  const observed = observeFoundationInertInput(input);
  const proof = assertFoundationInert(observed);
  if (!proof.ok) throw new Error(`foundation_inert_proof_unobservable:${proof.reason}`);
  return { ...proof, observations: observed };
}

export function observeGreenfieldFoundationInertProof(input: {
  repoRoot: string;
  paths: CanonicalFoundationPaths;
}): { result: 'greenfield-dormant-layer-not-active'; observations: FoundationInertObservation } {
  const observed = observeFoundationInertInputInternal({
    ...input,
    allowAbsentTypedConfig: true,
  }, true);
  const failures: Array<[boolean, string]> = [
    [observed.registryChanged, 'registry_changed'],
    [observed.supervisorChanged, 'supervisor_changed'],
    [observed.schedulerRegistered, 'scheduler_registered'],
    [observed.schedulerRunning, 'scheduler_running'],
    [observed.schedulerClaimAcquirer, 'scheduler_claim_acquirer'],
    [observed.activationEpochEnforced, 'activation_epoch_enforced'],
    [observed.liveStoreOpened, 'live_store_opened'],
    [observed.legacyStarterDisabled, 'legacy_starter_enabled'],
    [observed.nonNotificationRuntimeDelta, 'non_notification_runtime_delta'],
    [observed.dormantTypedConfigReaderLive, 'dormant_config_reader_live'],
    [observed.notificationTypedConfigLive, 'notification_config_present'],
  ];
  const failure = failures.find(([condition]) => condition);
  if (failure) throw new Error(`foundation_inert_proof_unobservable:${failure[1]}`);
  return { result: 'greenfield-dormant-layer-not-active', observations: observed };
}

export function observeLocalHeartbeat(
  localHostId: string,
  installedCommitSha: string,
  observedSourcePath: string,
): FoundationHeartbeatEvidence {
  let observedAt: string;
  try {
    const mtimeMs = statSync(observedSourcePath).mtimeMs;
    observedAt = new Date(mtimeMs).toISOString();
  } catch {
    throw new Error('foundation_heartbeat_unobservable');
  }
  return {
    hostId: localHostId,
    installedCommitSha,
    observedAt,
    active: processAliveStrict(process.pid),
  };
}

export function observeLiveHeartbeat(
  localHostId: string,
  installedCommitSha: string,
): FoundationHeartbeatEvidence {
  return {
    hostId: localHostId,
    installedCommitSha,
    observedAt: new Date().toISOString(),
    active: processAliveStrict(process.pid),
  };
}

export function localObservedHostId(): string {
  const hostId = os.hostname().trim();
  if (!hostId) throw new Error('foundation_host_unobservable');
  return hostId;
}

export function canonicalConfigAndAppStateEqual(
  config: unknown,
  observedConfig: unknown,
  appStateVersion: string,
  observedAppStateVersion: string,
): boolean {
  return stableStringify(config) === stableStringify(observedConfig)
    && appStateVersion === observedAppStateVersion;
}
