import '../toolchain/native-entrypoint-preflight.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../kernel/subprocess.ts';
import {
  foundationEvidenceDigest,
  writeDurableJson,
} from '../lib/cutover/activation-evidence.ts';
import { FileEpochAuthority } from '../lib/cutover/activation-epoch-authority.ts';
import { captureLegacyWriters, findLegacySupervisorIdentities, processAlive } from '../lib/cutover/activation-cordon.ts';
import { runActivationPlatformPreflight } from '../lib/cutover/activation-platform-preflight.ts';
import type { FoundationAdmissionEvidence } from '../lib/cutover/types.ts';
import { readSupervisorStatus } from '../lib/orchestrator-side-process-supervisor.ts';
import { readMigrationJournal } from '../pr2-foundation/migration-journal.ts';
import {
  captureLeakReason,
  sanitizeRuntimeWorkers,
  sanitizerIdentity,
  validateRuntimePreflight,
  type RuntimeWorkerRow,
} from '../pr2-foundation/binding.ts';
import { parseFoundationConfig, type FoundationConfig } from '../pr2-foundation/config.ts';
import { FOUNDATION_RUNTIME_CATALOG, validateRuntimeCatalog } from '../pr2-foundation/runtime-catalog.ts';
import { assertFoundationInert } from '../pr2-foundation/scheduler.ts';
import { FOUNDATION_COMMIT } from '../pr2a/contracts.ts';

const DEFAULT_EVIDENCE_FILE = 'foundation-923-adoption.json';

export interface FoundationAdoptionProducerInput {
  repoRoot: string;
  stateDir: string;
  configPath: string;
  appStatePath: string;
  migrationJournalPaths?: string[];
  evidencePath?: string;
  now?: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('foundation_observation_shape_invalid');
  return value as Record<string, unknown>;
}

function appStateVersion(value: unknown): string {
  const root = record(value);
  const direct = [root.version, root.appStateVersion, root.appVersion]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
  if (direct) return direct;
  throw new Error('foundation_preflight_version_unobservable');
}

function parseRuntimeRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const root = record(value);
  for (const key of ['sessions', 'workers', 'data']) {
    if (Array.isArray(root[key])) return root[key] as unknown[];
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

function requireObservedConfig(input: unknown): { raw: Record<string, unknown>; config: FoundationConfig } {
  const raw = record(input);
  const parsed = parseFoundationConfig(raw);
  if (!parsed.ok) throw new Error(`foundation_typed_config_unobservable:${parsed.reason}:${parsed.path}`);
  const required = [
    ['schemaVersion'],
    ['notification', 'runtimePath'],
    ['notification', 'timeoutMs'],
    ['notification', 'maxJournalAttempts'],
    ['notification', 'argvCeilingChars'],
    ['scheduler', 'pollIntervalMs'],
    ['scheduler', 'leaseMs'],
    ['migration', 'destructiveCleanupEnabled'],
    ['actuator', 'enabled'],
    ['actuator', 'postValidationWindowMs'],
    ['actuator', 'maxUnadoptedRuntimeMerges'],
    ['actuator', 'runtimeMaxAgeHours'],
    ['actuator', 'maxUnadoptedNonRuntimeMerges'],
    ['actuator', 'nonRuntimeMaxAgeDays'],
  ];
  for (const keys of required) {
    let current: unknown = raw;
    for (const key of keys) current = record(current)[key];
    if (current === undefined) throw new Error(`foundation_typed_config_unobservable:${keys.join('.')}`);
  }
  return { raw, config: parsed.config };
}

function discoverMigrationJournals(stateDir: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(candidate);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        const journal = readMigrationJournal(candidate);
        if (journal.ok && journal.record?.state === 'committed') output.push(candidate);
      }
    }
  };
  if (existsSync(stateDir)) visit(stateDir);
  return output.sort();
}

function validateCommittedJournals(paths: string[]): string[] {
  const normalized = [...new Set(paths.map((value) => path.resolve(value)))];
  if (normalized.length === 0) throw new Error('foundation_migration_journal_unobservable');
  for (const journalPath of normalized) {
    const journal = readMigrationJournal(journalPath);
    if (!journal.ok) {
      throw new Error(`foundation_migration_journal_unobservable:${journalPath}`);
    }
    if (journal.record?.state !== 'committed') {
      throw new Error(`foundation_migration_journal_unobservable:${journalPath}`);
    }
  }
  return normalized;
}

function assertEmptyAuthority(stateDir: string): void {
  const authority = new FileEpochAuthority(path.join(stateDir, 'epoch-authority.json')).read();
  if (authority.currentEpochId !== null || authority.records.length !== 0) {
    throw new Error('greenfield_epoch_authority_not_empty');
  }
}

function assertNoRegisteredControlPlane(supervisorStateDir: string): void {
  const status = readSupervisorStatus({ stateDir: supervisorStateDir });
  if (status) {
    if (status.schemaVersion !== 1 || status.childId !== 'pr2-scheduler' || typeof status.restartState !== 'string') {
      throw new Error('greenfield_registered_child_unknown');
    }
    const supervisorAlive = Number.isInteger(status.supervisorPid) && status.supervisorPid > 1 && processAlive(status.supervisorPid);
    const childAlive = Number.isInteger(status.childPid) && status.childPid !== null && status.childPid > 1 && processAlive(status.childPid);
    if (supervisorAlive || childAlive) throw new Error('greenfield_registered_child_alive');
  }
}

export async function produceFoundationAdoptionEvidence(
  input: FoundationAdoptionProducerInput,
): Promise<{ evidencePath: string; evidence: FoundationAdmissionEvidence }> {
  const repoRoot = path.resolve(input.repoRoot);
  const stateDir = path.resolve(input.stateDir);
  const supervisorStateDir = path.join(stateDir, 'supervisor');
  const targetRegistryPath = path.join(repoRoot, 'scripts', 'orchestrator-side-process-registry.json');
  const projectedRegistryPath = path.join(supervisorStateDir, 'projected-registry.json');
  const evidencePath = path.resolve(input.evidencePath ?? path.join(stateDir, DEFAULT_EVIDENCE_FILE));
  mkdirSync(supervisorStateDir, { recursive: true });

  const observedConfig = requireObservedConfig(JSON.parse(readFileSync(input.configPath, 'utf8')));
  if (observedConfig.config.notification.runtimePath !== 'ao') {
    throw new Error('foundation_preflight_command_unobservable');
  }
  const version = appStateVersion(JSON.parse(readFileSync(input.appStatePath, 'utf8')));
  const runtime = await runProcess({
    command: observedConfig.config.notification.runtimePath,
    args: ['session', 'ls', '--json'],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: observedConfig.config.notification.timeoutMs,
  });
  if (!runtime.ok) throw new Error(`foundation_runtime_observation_failed:${runtime.stderr || runtime.error || runtime.exitCode}`);
  const observedRows = parseRuntimeRows(parseJsonOutput(runtime.stdout));
  const normalizedRows = observedRows.map((row) => {
    if (!row || typeof row !== 'object') throw new Error('foundation_runtime_sessions_unobservable');
    return row as RuntimeWorkerRow;
  });
  const sanitized = sanitizeRuntimeWorkers(normalizedRows);
  const leak = captureLeakReason(sanitized);
  if (leak) throw new Error(leak);
  const preflight = {
    command: 'a\u006f session ls --json',
    appStateVersion: version,
    sessions: sanitized,
    sanitizerId: sanitizerIdentity(sanitized),
  };
  const validatedPreflight = validateRuntimePreflight(preflight);
  if (!validatedPreflight.ok) throw new Error(`foundation_preflight_unobservable:${validatedPreflight.reason}`);

  const parsedCatalog = validateRuntimeCatalog(FOUNDATION_RUNTIME_CATALOG, FOUNDATION_RUNTIME_CATALOG);
  if (!parsedCatalog.ok) throw new Error(`foundation_runtime_catalog_unobservable:${parsedCatalog.reason}`);
  assertEmptyAuthority(stateDir);
  assertNoRegisteredControlPlane(supervisorStateDir);
  if (captureLegacyWriters(repoRoot, supervisorStateDir).length !== 0) {
    throw new Error('greenfield_legacy_writer_present');
  }
  if (findLegacySupervisorIdentities(repoRoot).length !== 0) throw new Error('greenfield_legacy_supervisor_present');
  const journals = validateCommittedJournals(input.migrationJournalPaths ?? discoverMigrationJournals(stateDir));
  const inertProof = assertFoundationInert({
    registryChanged: false,
    supervisorChanged: false,
    schedulerRegistered: false,
    schedulerRunning: false,
    schedulerClaimAcquirer: false,
    activationEpochEnforced: false,
    liveStoreOpened: false,
    legacyStarterDisabled: false,
    nonNotificationRuntimeDelta: false,
    notificationTypedConfigLive: true,
    dormantTypedConfigReaderLive: false,
  });
  if (!inertProof.ok) throw new Error(`foundation_inert_proof_unobservable:${inertProof.reason}`);

  const installedCommitSha = (await runProcess({
    command: 'git',
    args: ['-C', repoRoot, 'rev-parse', 'HEAD'],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 10_000,
  })).stdout.trim();
  if (!/^[0-9a-f]{40}$/iu.test(installedCommitSha)) throw new Error('foundation_installed_commit_unobservable');
  runActivationPlatformPreflight({
    repoRoot,
    installedCommitSha,
    oldInstalledRevisionRoot: repoRoot,
    targetRegistryPath,
    projectedRegistryPath,
  });
  const now = input.now ?? new Date().toISOString();
  const hostId = os.hostname().trim();
  if (!hostId) throw new Error('foundation_host_unobservable');
  const unsigned: Omit<FoundationAdmissionEvidence, 'observationDigest'> = {
    schemaVersion: 1,
    issue: 923,
    foundationMergeCommitSha: FOUNDATION_COMMIT,
    producer: 'orchestrator-pack:foundation-adoption-producer',
    preflight,
    typedConfig: observedConfig.raw,
    migrationJournalPaths: journals,
    runtimeCatalog: [...FOUNDATION_RUNTIME_CATALOG],
    inertProof,
    heartbeats: [{
      hostId,
      installedCommitSha,
      observedAt: now,
      active: true,
    }],
  };
  const evidence: FoundationAdmissionEvidence = {
    ...unsigned,
    observationDigest: foundationEvidenceDigest(unsigned),
  };
  writeDurableJson(evidencePath, evidence);
  return { evidencePath, evidence };
}

function parseArgs(argv: string[]): FoundationAdoptionProducerInput {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith('--')) throw new Error(`unknown_argument:${flag ?? ''}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing_value:${flag}`);
    values.set(flag.slice(2), value);
  }
  const repoRoot = values.get('repo-root') ?? process.cwd();
  const stateDir = values.get('state-dir') ?? path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'orchestrator-pack-wake-supervisor');
  const configPath = values.get('config') ?? process.env.OPK_FOUNDATION_CONFIG ?? '';
  const appStatePath = values.get('app-state') ?? process.env.OPK_APP_STATE_PATH ?? '';
  if (!configPath) throw new Error('foundation_config_unobservable');
  if (!appStatePath) throw new Error('foundation_preflight_version_unobservable');
  return {
    repoRoot,
    stateDir,
    configPath,
    appStatePath,
    evidencePath: values.get('output'),
    migrationJournalPaths: values.get('migration-journal')?.split(',').filter(Boolean),
  };
}

if (process.argv[1]?.endsWith('foundation-adoption-producer.ts')) {
  produceFoundationAdoptionEvidence(parseArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
