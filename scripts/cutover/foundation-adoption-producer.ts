import '../toolchain/native-entrypoint-preflight.ts';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../kernel/subprocess.ts';
import {
  foundationEvidenceDigest,
  writeDurableJson,
} from '../lib/cutover/activation-evidence.ts';
import {
  captureLegacyWriters,
  findLegacySupervisorIdentities,
  findTypeScriptSupervisorIdentities,
} from '../lib/cutover/activation-cordon.ts';
import { runActivationPlatformPreflight } from '../lib/cutover/activation-platform-preflight.ts';
import {
  canonicalFoundationPaths,
  discoverCommittedMigrationJournals,
  localObservedHostId,
  observeFoundationInertProof,
  observeLocalHeartbeat,
  readObservedAppStateVersion,
} from '../lib/cutover/foundation-observation.ts';
import type { FoundationAdmissionEvidence } from '../lib/cutover/types.ts';
import {
  captureLeakReason,
  sanitizeRuntimeWorkers,
  sanitizerIdentity,
  validateRuntimePreflight,
  type RuntimeWorkerRow,
} from '../pr2-foundation/binding.ts';
import { parseFoundationConfig, type FoundationConfig } from '../pr2-foundation/config.ts';
import { FOUNDATION_RUNTIME_CATALOG, validateRuntimeCatalog } from '../pr2-foundation/runtime-catalog.ts';
import { FOUNDATION_COMMIT } from '../pr2a/contracts.ts';

export interface FoundationAdoptionProducerInput {
  repoRoot: string;
  stateDir: string;
  configPath: string;
  appStatePath: string;
  migrationJournalPaths?: string[];
  evidencePath?: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('foundation_observation_shape_invalid');
  return value as Record<string, unknown>;
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

export async function produceFoundationAdoptionEvidence(
  input: FoundationAdoptionProducerInput,
): Promise<{ evidencePath: string; evidence: FoundationAdmissionEvidence }> {
  const repoRoot = path.resolve(input.repoRoot);
  if (String(process.env.OPK_WAKE_SUPERVISOR_STATE_DIR ?? '').trim()) {
    throw new Error('foundation_state_root_override_forbidden');
  }
  const canonical = canonicalFoundationPaths(repoRoot);
  if (path.resolve(input.stateDir) !== canonical.stateRoot) throw new Error('foundation_state_root_unobservable');
  if (path.resolve(input.configPath) !== canonical.configPath) throw new Error('foundation_config_unobservable');
  if (path.resolve(input.appStatePath) !== canonical.appStatePath) {
    throw new Error('foundation_preflight_version_unobservable');
  }
  const evidencePath = path.resolve(input.evidencePath ?? canonical.evidencePath);
  if (evidencePath !== canonical.evidencePath) throw new Error('foundation_evidence_path_unobservable');
  const supervisorStateDir = canonical.supervisorStateDir;
  const targetRegistryPath = path.join(repoRoot, 'scripts', 'orchestrator-side-process-registry.json');
  const projectedRegistryPath = canonical.projectedRegistryPath;
  mkdirSync(supervisorStateDir, { recursive: true });

  let observedConfigInput: unknown;
  try {
    observedConfigInput = JSON.parse(readFileSync(canonical.configPath, 'utf8')) as unknown;
  } catch {
    throw new Error('foundation_config_unobservable');
  }
  const observedConfig = requireObservedConfig(observedConfigInput);
  if (observedConfig.config.notification.runtimePath !== 'ao') {
    throw new Error('foundation_preflight_command_unobservable');
  }
  const version = readObservedAppStateVersion(canonical.appStatePath);
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
  if (captureLegacyWriters(repoRoot, supervisorStateDir).length !== 0) {
    throw new Error('greenfield_legacy_writer_present');
  }
  if (findLegacySupervisorIdentities(repoRoot).length !== 0) throw new Error('greenfield_legacy_supervisor_present');
  if (findTypeScriptSupervisorIdentities().length !== 0) throw new Error('greenfield_typescript_supervisor_present');
  const journals = discoverCommittedMigrationJournals(canonical.stateRoot);
  if (input.migrationJournalPaths !== undefined) {
    const supplied = [...new Set(input.migrationJournalPaths.map((value) => path.resolve(value)))].sort();
    if (supplied.length !== journals.length || supplied.some((value, index) => value !== journals[index])) {
      throw new Error('foundation_migration_journal_unobservable');
    }
  }
  const localHostId = localObservedHostId();
  const inertProof = observeFoundationInertProof({
    repoRoot,
    paths: canonical,
  });

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
    heartbeats: [observeLocalHeartbeat(localHostId, installedCommitSha, canonical.configPath)],
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
  const canonical = canonicalFoundationPaths(repoRoot);
  return {
    repoRoot,
    stateDir: values.get('state-dir') ?? canonical.stateRoot,
    configPath: values.get('config') ?? canonical.configPath,
    appStatePath: values.get('app-state') ?? canonical.appStatePath,
    evidencePath: values.get('output') ?? canonical.evidencePath,
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
