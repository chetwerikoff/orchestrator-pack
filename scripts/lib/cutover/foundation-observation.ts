import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileEpochAuthority } from './activation-epoch-authority.ts';
import { captureLegacyWriters, processAliveStrict } from './activation-cordon.ts';
import { sha256Bytes, stableStringify } from './stable-stringify.ts';
import type { ActivationRequest, FoundationHeartbeatEvidence, FoundationInertObservation } from './types.ts';
import { readSupervisorStatus } from '../orchestrator-side-process-supervisor.ts';
import { readMigrationJournal } from '../../pr2-foundation/migration-journal.ts';
import { resolveWakeSupervisorStateRoot } from '../../pr2-foundation/wake-supervisor-state-root.ts';
import { assertFoundationInert } from '../../pr2-foundation/scheduler.ts';
import { parseFoundationConfig } from '../../pr2-foundation/config.ts';

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

export function readObservedAppStateVersion(pathName: string): string {
  const root = readRecord(pathName, 'foundation_preflight_version_unobservable');
  const version = [root.version, root.appStateVersion, root.appVersion]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (!version) throw new Error('foundation_preflight_version_unobservable');
  return version;
}

export function discoverCommittedMigrationJournals(stateRoot: string): string[] {
  if (!existsSync(stateRoot)) throw new Error('foundation_migration_journal_unobservable');
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(candidate);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        const journal = readMigrationJournal(candidate);
        if (journal.ok && journal.record?.state === 'committed') output.push(path.resolve(candidate));
      }
    }
  };
  visit(stateRoot);
  const journals = [...new Set(output)].sort();
  if (journals.length === 0) throw new Error('foundation_migration_journal_unobservable');
  return journals;
}

function fileDigestOrAbsent(pathName: string): string {
  if (!existsSync(pathName)) return 'absent';
  try {
    return sha256Bytes(readFileSync(pathName));
  } catch {
    throw new Error(`foundation_observation_unreadable:${pathName}`);
  }
}

export function observeFoundationInertInput(input: {
  repoRoot: string;
  paths: CanonicalFoundationPaths;
}): ObservedFoundationInertInput {
  let configObserved = false;
  try {
    const config = parseFoundationConfig(JSON.parse(readFileSync(input.paths.configPath, 'utf8')) as unknown);
    configObserved = config.ok;
  } catch {
    throw new Error('foundation_typed_config_unobservable');
  }
  const status = readSupervisorStatus({ stateDir: input.paths.supervisorStateDir });
  const supervisorPid = Number(status?.supervisorPid ?? 0);
  const childPid = Number(status?.childPid ?? 0);
  const supervisorAlive = Number.isInteger(supervisorPid) && supervisorPid > 1
    ? processAliveStrict(supervisorPid)
    : false;
  const childAlive = Number.isInteger(childPid) && childPid > 1
    ? processAliveStrict(childPid)
    : false;
  const authority = new FileEpochAuthority(input.paths.epochAuthorityPath).read();
  const writerCount = captureLegacyWriters(
    input.repoRoot,
    input.paths.supervisorStateDir,
  ).length;
  const projectedExists = existsSync(input.paths.projectedRegistryPath);
  const registryChanged = projectedExists
    && fileDigestOrAbsent(path.join(input.repoRoot, 'scripts', 'orchestrator-side-process-registry.json'))
      !== fileDigestOrAbsent(input.paths.projectedRegistryPath);
  return {
    registryChanged,
    supervisorChanged: status !== null,
    schedulerRegistered: status !== null,
    schedulerRunning: supervisorAlive || childAlive,
    schedulerClaimAcquirer: supervisorAlive && status?.restartState === 'running',
    activationEpochEnforced: authority.currentEpochId !== null,
    liveStoreOpened: writerCount !== 0,
    legacyStarterDisabled: existsSync(path.join(input.repoRoot, 'scripts', 'orchestrator-wake-supervisor.ps1')),
    nonNotificationRuntimeDelta: Boolean(String(process.env.OPK_RUNTIME_ADAPTER ?? '').trim()),
    notificationTypedConfigLive: configObserved,
    dormantTypedConfigReaderLive: existsSync(path.join(input.paths.stateRoot, 'dormant-typed-config-reader.json')),
  };
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
