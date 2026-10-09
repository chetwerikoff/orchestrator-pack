#!/usr/bin/env node
import { runProcessSync } from './kernel/subprocess.ts';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWakeSupervisorStateRoot } from './pr2-foundation/wake-supervisor-state-root.ts';
import { originSlugFromGitConfig } from './lib/git-origin-slug.mjs';
import { projectCardPath, resolveTargetContext } from './lib/target-context.ts';

export type ConsumerState = 'running' | 'not_running' | 'ephemeral' | 'unknown';
export interface ConsumerObservation { readonly state: ConsumerState; readonly startedAtMs?: number; readonly identity?: string; readonly reason?: string; }
export interface ConsumerController { observe(): Promise<ConsumerObservation> | ConsumerObservation; restart?(before?: ConsumerObservation): Promise<void> | void; }
export interface AdoptionConsumer { readonly id: string; readonly matchedPaths: readonly string[]; }
export interface LiveCheckResult { readonly ok: boolean; readonly reason?: string; }
export interface VerifyAdoptionEffectInput {
  readonly adoptionStartedAtMs: number;
  readonly consumers: readonly AdoptionConsumer[];
  readonly controllers: Readonly<Record<string, ConsumerController | undefined>>;
  readonly runLiveCheck: () => Promise<LiveCheckResult> | LiveCheckResult;
  readonly restartStaleConsumers?: boolean;
  readonly fleetAdoptedAtMs?: number;
}
export interface ConsumerEffectResult {
  readonly id: string;
  readonly matchedPaths: readonly string[];
  readonly before: ConsumerObservation;
  readonly action: 'none' | 'not_running' | 'fresh_invocation' | 'restart' | 'restart_unavailable';
  readonly after?: ConsumerObservation;
  readonly verified: boolean;
  readonly reason?: string;
}
export interface AdoptionEffectReport {
  readonly schema: 'orchestrator-pack/merge-adoption-effect/v1';
  readonly consumers: readonly ConsumerEffectResult[];
  readonly liveCheck: LiveCheckResult;
  readonly effect: 'effect_verified' | string;
  readonly operationalOutcome: 'operationally_complete' | 'operationally_incomplete';
  readonly coordinatorMessage: string | null;
}

interface ConsumerDefinition {
  readonly id: string;
  readonly entrypoints: readonly string[];
  readonly extraPaths?: readonly string[];
  readonly control: 'supervisor' | 'scheduler' | 'systemd-user' | 'agent-hook' | 'unsupported';
}
interface SupervisorStatus {
  readonly supervisorPid?: number;
  readonly supervisorStartTicks?: string;
  readonly childPid?: number | null;
  readonly childStartTicks?: string | null;
  readonly lastChildStartAt?: string | null;
}
interface CliOptions {
  readonly repoRoot: string;
  readonly mergeSha: string;
  readonly adoptedAt: string;
  readonly fleetAdoptedAt?: string;
  readonly liveChecks: readonly string[][];
  readonly supervisorStateDir: string;
  readonly restartControls: Readonly<Record<string, readonly string[]>>;
}

const REGISTRY_PATH = 'scripts/orchestrator-side-process-registry.json';
const SUPERVISOR_ENTRYPOINT = 'scripts/orchestrator-wake-supervisor.ts';
const FLEET_WAKE_ENTRYPOINT = 'scripts/fleet/fleet-wake.ts';
const FLEET_WAKE_UNIT = 'scripts/fleet/fleet-wake@.service';
const FLEET_TEMPLATE_CONSUMER = 'fleet-wake-template';
const FLEET_INVENTORY_CONSUMER = 'fleet-wake-inventory';
const FLEET_CONSUMER_RE = /^fleet-wake@([A-Za-z0-9][A-Za-z0-9._-]*)\.service$/u;
const TYPESCRIPT_CLI_ENTRYPOINT = 'scripts/lib/Invoke-TypeScriptCli.ts';
const AGENT_HOOK_ENTRYPOINTS = [
  'scripts/invoke-read-delegation-audit-stop.ts',
  'scripts/json-producers/read-delegation-audit-stop.ts',
  TYPESCRIPT_CLI_ENTRYPOINT,
] as const;
const IMPORT_RE = /(?:\b(?:import|export)\s+(?:[^'";]+?\s+from\s+)?|\bimport\s*\()\s*['"]([^'"]+)['"]/gu;
const FULL_SHA = /^[0-9a-f]{40}$/iu;

/** Pack origin is read from this trusted tool checkout, never from the selected target card id. */
export function assertPackAdoptionRoot(repoRoot: string): void {
  const packRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const packRepository = originSlugFromGitConfig(packRoot)?.toLowerCase();
  if (!existsSync(path.join(repoRoot, REGISTRY_PATH)) || !packRepository
    || originSlugFromGitConfig(repoRoot)?.toLowerCase() !== packRepository) {
    throw new Error('pack-only adoption requires the trusted pack repository origin and ' + REGISTRY_PATH + ' in repo-root; use the selected target {PRIMARY_ROOT}/AGENTS.md merge-time adoption and its named live check instead. Do not substitute a pack registry.');
  }
}

function normalizeRepoPath(value: string): string {
  let normalized = value.trim().replaceAll('\\', '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = path.posix.normalize(normalized);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new TypeError('repository path is invalid: ' + JSON.stringify(value));
  }
  return normalized;
}

function readJsonObject(file: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(file + ' must contain a JSON object');
  return value as Record<string, unknown>;
}

function resolveRelativeImport(repoRoot: string, importer: string, specifier: string): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = path.posix.extname(base)
    ? [base]
    : [base, base + '.ts', base + '.mts', base + '.cts', base + '.mjs', base + '.js', base + '.json', base + '/index.ts'];
  for (const candidate of candidates) {
    const normalized = normalizeRepoPath(candidate);
    if (existsSync(path.join(repoRoot, normalized))) return normalized;
  }
  return null;
}

function resolvePackageImport(repoRoot: string, specifier: string): string | null {
  const pkg = readJsonObject(path.join(repoRoot, 'package.json'));
  const imports = pkg.imports;
  if (!imports || typeof imports !== 'object' || Array.isArray(imports)) return null;
  for (const [pattern, targetValue] of Object.entries(imports as Record<string, unknown>)) {
    if (typeof targetValue !== 'string') continue;
    if (!pattern.includes('*')) {
      if (pattern !== specifier) continue;
      const candidate = normalizeRepoPath(targetValue);
      return existsSync(path.join(repoRoot, candidate)) ? candidate : null;
    }
    const [prefix = '', suffix = ''] = pattern.split('*');
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
    const target = targetValue.replace('*', wildcard);
    const candidate = normalizeRepoPath(target);
    if (existsSync(path.join(repoRoot, candidate))) return candidate;
  }
  return null;
}

function resolveInternalImport(repoRoot: string, importer: string, specifier: string): string | null {
  if (specifier.startsWith('.')) return resolveRelativeImport(repoRoot, importer, specifier);
  if (specifier.startsWith('#')) return resolvePackageImport(repoRoot, specifier);
  return null;
}

export function staticDependencyClosure(repoRootValue: string, entrypoints: readonly string[]): Set<string> {
  const repoRoot = realpathSync(repoRootValue);
  const pending = entrypoints.map(normalizeRepoPath);
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const absolute = path.join(repoRoot, current);
    if (!existsSync(absolute) || !/\.(?:[cm]?ts|mjs|js)$/u.test(current)) continue;
    const source = readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1];
      if (!specifier) continue;
      if (specifier.startsWith('#')) visited.add('package.json');
      const resolved = resolveInternalImport(repoRoot, current, specifier);
      if (resolved && !visited.has(resolved)) pending.push(resolved);
    }
  }
  return visited;
}

function consumerDefinitions(repoRoot: string): ConsumerDefinition[] {
  assertPackAdoptionRoot(repoRoot);
  const registry = readJsonObject(path.join(repoRoot, REGISTRY_PATH));
  if (!Array.isArray(registry.children)) throw new TypeError('side-process registry omitted children[]');
  const children = registry.children.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('registry child ' + String(index) + ' is not an object');
    const row = value as Record<string, unknown>;
    const id = String(row.id ?? '').trim();
    const script = String(row.script ?? '').trim();
    if (!id || !script) throw new TypeError('registry child ' + String(index) + ' omitted id/script');
    return {
      id,
      entrypoints: [normalizeRepoPath(path.posix.join('scripts', script))],
      extraPaths: [REGISTRY_PATH],
      control: id === 'pr2-scheduler' ? 'scheduler' as const : 'unsupported' as const,
    };
  });
  return [
    { id: 'orchestrator-side-process-supervisor', entrypoints: [SUPERVISOR_ENTRYPOINT], extraPaths: [REGISTRY_PATH], control: 'supervisor' },
    ...children,
    { id: 'agent-hooks', entrypoints: AGENT_HOOK_ENTRYPOINTS, control: 'agent-hook' },
  ];
}

/** Cards are the only fleet inventory. An invalid relevant inventory is a v1 consumer failure, never a singleton fallback. */
function fleetConsumersForChangedPaths(repoRoot: string, changed: readonly string[], env: Readonly<NodeJS.ProcessEnv>): AdoptionConsumer[] {
  const closure = staticDependencyClosure(repoRoot, [FLEET_WAKE_ENTRYPOINT, TYPESCRIPT_CLI_ENTRYPOINT]);
  const matchedPaths = changed.filter((item) => item === FLEET_WAKE_UNIT || closure.has(item));
  if (matchedPaths.length === 0) return [];
  // The tracked template must be installed and activated by the operator; code+template is no exception.
  if (matchedPaths.includes(FLEET_WAKE_UNIT)) return [{ id: FLEET_TEMPLATE_CONSUMER, matchedPaths }];
  const directory = path.dirname(projectCardPath('inventory-probe', env));
  try {
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('inventory_directory_invalid');
    const files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith('.json'))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (files.length === 0) throw new Error('inventory_empty');
    const selectedEnv: NodeJS.ProcessEnv = { ...env };
    delete selectedEnv.OPK_PROJECT_ID;
    const identities = new Set<string>();
    return files.map((entry) => {
      const fullPath = path.join(directory, entry.name);
      const stat = lstatSync(fullPath);
      if (!entry.isFile() || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('card_alias');
      const projectId = entry.name.slice(0, -'.json'.length);
      const context = resolveTargetContext({ projectId, env: selectedEnv });
      if (context.projectId !== projectId || path.resolve(context.cardPath) !== path.resolve(fullPath)) throw new Error('card_identity');
      const unit = 'fleet-wake@' + context.projectId + '.service';
      // Case aliases cannot silently select two spellings of one unit on another host.
      if (!FLEET_CONSUMER_RE.test(unit) || identities.has(unit.toLowerCase())) throw new Error('unit_alias');
      identities.add(unit.toLowerCase());
      return { id: unit, matchedPaths };
    });
  } catch {
    // Never place card paths, local values, parser errors or operator configuration in the v1 report.
    return [{ id: FLEET_INVENTORY_CONSUMER, matchedPaths }];
  }
}

export function mapChangedPathsToConsumers(
  repoRootValue: string,
  changedPaths: readonly string[],
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): AdoptionConsumer[] {
  const repoRoot = realpathSync(repoRootValue);
  const changed = [...new Set(changedPaths.map(normalizeRepoPath))].sort();
  const otherConsumers = consumerDefinitions(repoRoot).flatMap((definition) => {
    const closure = staticDependencyClosure(repoRoot, definition.entrypoints);
    for (const extra of definition.extraPaths ?? []) closure.add(normalizeRepoPath(extra));
    const matchedPaths = changed.filter((item) => closure.has(item));
    return matchedPaths.length > 0 ? [{ id: definition.id, matchedPaths }] : [];
  });
  return [...otherConsumers, ...fleetConsumersForChangedPaths(repoRoot, changed, env)];
}

function runCommand(command: string, args: readonly string[], cwd?: string, timeout = 30_000) {
  const result = runProcessSync({
    command,
    args,
    ...(cwd ? { cwd } : {}),
    inheritParentEnv: true,
    timeoutMs: timeout,
  });
  return { ok: result.ok, status: result.exitCode, stdout: result.stdout };
}

function procStartTicks(pid: number): string | null {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 1) return null;
  try {
    const raw = readFileSync('/proc/' + String(pid) + '/stat', 'utf8');
    const close = raw.lastIndexOf(')');
    return close < 0 ? null : raw.slice(close + 2).trim().split(/\s+/u)[19] ?? null;
  } catch { return null; }
}

export function linuxProcessStartTimeMs(pid: number): number | null {
  const startTicksText = procStartTicks(pid);
  if (!startTicksText) return null;
  try {
    const uptimeSeconds = Number(readFileSync('/proc/uptime', 'utf8').trim().split(/\s+/u)[0]);
    const clock = runCommand('getconf', ['CLK_TCK']);
    const ticksPerSecond = Number(clock.stdout.trim());
    const startTicks = Number(startTicksText);
    if (!Number.isFinite(uptimeSeconds) || !Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0 || !Number.isFinite(startTicks)) return null;
    return Date.now() - uptimeSeconds * 1_000 + (startTicks / ticksPerSecond) * 1_000;
  } catch { return null; }
}

/** The supervisor writes its status under `<wake-supervisor state root>/supervisor`, as the cutover layout defines it. */
export function defaultSupervisorStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.resolve(resolveWakeSupervisorStateRoot({ env })), 'supervisor');
}

function readSupervisorStatus(stateDir: string): SupervisorStatus | null {
  const file = path.join(stateDir, 'typescript-supervisor-status.json');
  if (!existsSync(file)) return null;
  try { return readJsonObject(file) as SupervisorStatus; } catch { return null; }
}

function managedProcessObservation(pidValue: unknown, expectedStartTicks: unknown): ConsumerObservation {
  const pid = Number(pidValue);
  const expected = String(expectedStartTicks ?? '').trim();
  if (!Number.isInteger(pid) || pid <= 1 || !expected) return { state: 'unknown', reason: 'managed_process_identity_missing' };
  const actual = procStartTicks(pid);
  if (!actual) return { state: 'not_running' };
  if (actual !== expected) return { state: 'unknown', reason: 'managed_process_identity_mismatch' };
  const startedAtMs = linuxProcessStartTimeMs(pid);
  if (startedAtMs === null) return { state: 'unknown', reason: 'managed_process_start_time_unavailable' };
  return { state: 'running', startedAtMs, identity: String(pid) + ':' + actual };
}

function supervisorController(stateDir: string, restartArgv: readonly string[] | undefined): ConsumerController {
  return {
    observe() {
      const status = readSupervisorStatus(stateDir);
      if (!status) return { state: 'unknown', reason: 'supervisor_status_missing_or_invalid' };
      return managedProcessObservation(status.supervisorPid, status.supervisorStartTicks);
    },
    ...(restartArgv && restartArgv.length > 0 ? { restart() {
      const [command, ...args] = restartArgv;
      if (!command) throw new Error('supervisor restart control is empty');
      const result = runCommand(command, args, undefined, 120_000);
      if (!result.ok) throw new Error('supervisor normal control failed:' + String(result.status ?? 'unknown'));
    } } : {}),
  };
}

function schedulerController(stateDir: string, adoptionStartedAtMs: number): ConsumerController {
  const observe = (): ConsumerObservation => {
    const status = readSupervisorStatus(stateDir);
    if (!status) return { state: 'unknown', reason: 'supervisor_status_missing_or_invalid' };
    const lastStart = Date.parse(String(status.lastChildStartAt ?? ''));
    if (!Number.isFinite(lastStart)) return { state: 'unknown', reason: 'scheduler_start_time_missing' };
    if (status.childPid && status.childStartTicks) {
      const current = managedProcessObservation(status.childPid, status.childStartTicks);
      if (current.state === 'running') return current;
    }
    return { state: 'running', startedAtMs: lastStart, identity: 'generation-start:' + String(status.lastChildStartAt) };
  };
  return {
    observe,
    async restart() {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const current = observe();
        if (current.state === 'running' && (current.startedAtMs ?? 0) > adoptionStartedAtMs) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error('scheduler normal cadence did not produce a post-adoption child');
    },
  };
}

interface FleetProcessIdentity {
  readonly startTicks: string;
  readonly startedAtMs: number;
  readonly cmdline: Buffer;
}
interface FleetWakeIO {
  systemctl(args: readonly string[]): { readonly ok: boolean; readonly stdout: string; readonly status?: number | null };
  processIdentity(pid: number): FleetProcessIdentity | null;
}
const systemFleetIO: FleetWakeIO = {
  systemctl: (args) => runCommand('systemctl', args, undefined, 120_000),
  processIdentity(pid) {
    if (process.platform !== 'linux') return null;
    const first = procStartTicks(pid);
    const startedAtMs = linuxProcessStartTimeMs(pid);
    if (!first || startedAtMs === null || !Number.isFinite(startedAtMs) || procStartTicks(pid) !== first) return null;
    try {
      const cmdline = readFileSync('/proc/' + String(pid) + '/cmdline');
      if (procStartTicks(pid) !== first) return null;
      return { startTicks: first, startedAtMs, cmdline };
    } catch { return null; }
  },
};

/** Validate the installed fleet ExecStart's Node -> launcher -> -- forwarding shape, not loose argv flags. */
function matchesFleetInvocation(raw: Buffer, projectId: string, adoptedRoot: string): boolean {
  if (raw.length === 0 || raw.length > 65_536 || raw[raw.length - 1] !== 0) return false;
  const argv = raw.toString('utf8').split('\0').slice(0, -1);
  // systemd's /usr/bin/env execs node; /proc/cmdline then starts with node (or its resolved path).
  // The template has no optional arguments: --project belongs only after the launcher '--'.
  if (argv.length !== 10) return false;
  const [node, stripTypes, launcher, repoFlag, root, scriptFlag, script, separator, projectFlag, runningProject] = argv;
  if (!node || path.basename(node) !== 'node'
    || stripTypes !== '--experimental-strip-types'
    || repoFlag !== '--repo-root' || scriptFlag !== '--script'
    || separator !== '--' || projectFlag !== '--project' || runningProject !== projectId
    || !launcher || !root || !script
    || !path.isAbsolute(launcher) || !path.isAbsolute(root) || !path.isAbsolute(script)) return false;
  try {
    const adopted = realpathSync(adoptedRoot);
    return realpathSync(root) === adopted
      && realpathSync(launcher) === realpathSync(path.join(adopted, TYPESCRIPT_CLI_ENTRYPOINT))
      && realpathSync(script) === realpathSync(path.join(adopted, FLEET_WAKE_ENTRYPOINT));
  } catch { return false; }
}

function fleetWakeController(projectId: string, adoptedRoot: string, io: FleetWakeIO = systemFleetIO): ConsumerController {
  const unit = 'fleet-wake@' + projectId + '.service';
  const unknown = (reason: string): ConsumerObservation => ({ state: 'unknown', reason });
  const observe = (): ConsumerObservation => {
    const active = io.systemctl(['--user', 'is-active', unit]);
    const state = active.stdout.trim();
    if (state === 'inactive') return { state: 'not_running' };
    if (state === 'unknown' || state === 'not-found') {
      const loadState = io.systemctl(['--user', 'show', unit, '--property=LoadState', '--value']);
      return loadState.ok && loadState.stdout.trim() === 'not-found'
        ? { state: 'not_running' } : unknown('fleet_wake_unit_state_unavailable');
    }
    if (!active.ok || state !== 'active') return unknown(state === 'failed' ? 'fleet_wake_unit_failed' : 'fleet_wake_unit_state_unavailable');
    const currentPid = (): number | null => {
      const result = io.systemctl(['--user', 'show', unit, '--property=MainPID', '--value']);
      const pid = Number(result.stdout.trim());
      return result.ok && /^\d+$/u.test(result.stdout.trim()) && Number.isSafeInteger(pid) && pid > 1 ? pid : null;
    };
    const pid = currentPid();
    if (pid === null) return unknown('fleet_wake_main_pid_unavailable');
    const identity = io.processIdentity(pid);
    if (!identity || !identity.startTicks || !Number.isFinite(identity.startedAtMs)) return unknown('fleet_wake_process_identity_unavailable');
    if (!matchesFleetInvocation(identity.cmdline, projectId, adoptedRoot)) return unknown('fleet_wake_invocation_or_checkout_mismatch');
    if (currentPid() !== pid) return unknown('fleet_wake_main_pid_changed');
    return { state: 'running', startedAtMs: identity.startedAtMs, identity: String(pid) + ':' + identity.startTicks };
  };
  return {
    observe,
    restart(before) {
      // Pre-control re-observation narrows the race without claiming atomicity with systemd.
      const current = observe();
      if (!before?.identity || current.state !== 'running' || current.identity !== before.identity) {
        throw new Error('fleet_wake_precontrol_identity_changed');
      }
      const result = io.systemctl(['--user', 'try-restart', unit]);
      if (!result.ok) throw new Error('fleet_wake_try_restart_failed');
    },
  };
}

function controllersFor(repoRoot: string, consumers: readonly AdoptionConsumer[], options: CliOptions, adoptionStartedAtMs: number): Readonly<Record<string, ConsumerController | undefined>> {
  const definitions = new Map(consumerDefinitions(repoRoot).map((row) => [row.id, row]));
  const output: Record<string, ConsumerController | undefined> = {};
  for (const consumer of consumers) {
    if (consumer.id === FLEET_TEMPLATE_CONSUMER) {
      output[consumer.id] = { observe: () => ({ state: 'unknown', reason: 'template_operator_activation_pending_install_render_daemon-reload_restart_effective-unit_readback' }) };
      continue;
    }
    if (consumer.id === FLEET_INVENTORY_CONSUMER) {
      output[consumer.id] = { observe: () => ({ state: 'unknown', reason: 'fleet_inventory_invalid_or_missing_repair_registered_cards' }) };
      continue;
    }
    const fleet = FLEET_CONSUMER_RE.exec(consumer.id);
    if (fleet) {
      output[consumer.id] = fleetWakeController(fleet[1]!, repoRoot);
      continue;
    }
    const definition = definitions.get(consumer.id);
    if (!definition) continue;
    if (definition.control === 'supervisor') output[consumer.id] = supervisorController(options.supervisorStateDir, options.restartControls[consumer.id]);
    else if (definition.control === 'scheduler') output[consumer.id] = schedulerController(options.supervisorStateDir, adoptionStartedAtMs);
    else if (definition.control === 'agent-hook') output[consumer.id] = { observe: () => ({ state: 'ephemeral' }) };
  }
  return output;
}

function sanitizedReason(value: string): string {
  return value.replace(/[()\r\n]+/gu, '_').replace(/\s+/gu, '_').slice(0, 160) || 'unknown';
}

async function observeFresh(controller: ConsumerController, adoptionStartedAtMs: number, oldIdentity?: string): Promise<ConsumerObservation> {
  const deadline = Date.now() + 15_000;
  let last: ConsumerObservation = { state: 'unknown', reason: 'readback_not_observed' };
  while (Date.now() < deadline) {
    last = await controller.observe();
    if (last.state === 'running' && Number.isFinite(last.startedAtMs) && (last.startedAtMs ?? 0) > adoptionStartedAtMs
      && (!oldIdentity || !last.identity || oldIdentity !== last.identity)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return last;
}

export async function verifyAdoptionEffect(input: VerifyAdoptionEffectInput): Promise<AdoptionEffectReport> {
  if (!Number.isFinite(input.adoptionStartedAtMs) || input.adoptionStartedAtMs <= 0) throw new TypeError('adoptionStartedAtMs must be a positive timestamp');
  const results: ConsumerEffectResult[] = [];
  const failures: string[] = [];
  // Observe all registered fleet instances first: an aliased MainPID must not cause either unit to be controlled.
  const initialFleet = new Map<string, ConsumerObservation>();
  const fleetIdentities = new Map<string, string>();
  for (const consumer of input.consumers) {
    if (!FLEET_CONSUMER_RE.test(consumer.id) || !input.controllers[consumer.id]) continue;
    const before = await input.controllers[consumer.id]!.observe();
    initialFleet.set(consumer.id, before);
    if (before.state !== 'running' || !before.identity) continue;
    const previous = fleetIdentities.get(before.identity);
    if (previous) {
      initialFleet.set(previous, { state: 'unknown', reason: 'fleet_wake_shared_process_identity' });
      initialFleet.set(consumer.id, { state: 'unknown', reason: 'fleet_wake_shared_process_identity' });
    } else fleetIdentities.set(before.identity, consumer.id);
  }
  for (const consumer of input.consumers) {
    const controller = input.controllers[consumer.id];
    if (!controller) {
      const reason = 'normal_control_unavailable:' + consumer.id;
      failures.push(reason);
      results.push({ id: consumer.id, matchedPaths: consumer.matchedPaths, before: { state: 'unknown', reason }, action: 'restart_unavailable', verified: false, reason });
      continue;
    }
    const isFleet = FLEET_CONSUMER_RE.test(consumer.id);
    const cutoff = isFleet ? input.fleetAdoptedAtMs : input.adoptionStartedAtMs;
    if (isFleet && (!Number.isFinite(cutoff) || (cutoff ?? 0) <= 0)) {
      const reason = consumer.id + ':fleet_adopted_at_missing_or_invalid';
      failures.push(reason);
      results.push({ id: consumer.id, matchedPaths: consumer.matchedPaths, before: initialFleet.get(consumer.id) ?? { state: 'unknown', reason }, action: 'none', verified: false, reason });
      continue;
    }
    const before = initialFleet.get(consumer.id) ?? await controller.observe();
    if (before.state === 'ephemeral') {
      results.push({ id: consumer.id, matchedPaths: consumer.matchedPaths, before, action: 'fresh_invocation', verified: true });
      continue;
    }
    if (before.state === 'not_running') {
      results.push({ id: consumer.id, matchedPaths: consumer.matchedPaths, before, action: 'not_running', verified: true });
      continue;
    }
    if (before.state !== 'running' || !Number.isFinite(before.startedAtMs)) {
      const reason = consumer.id + ':' + (before.reason ?? 'start_time_unverified');
      failures.push(reason);
      results.push({ id: consumer.id, matchedPaths: consumer.matchedPaths, before, action: 'none', verified: false, reason });
      continue;
    }
    if ((before.startedAtMs ?? 0) > cutoff!) {
      results.push({ id: consumer.id, matchedPaths: consumer.matchedPaths, before, action: 'none', verified: true });
      continue;
    }
    if (input.restartStaleConsumers === false || !controller.restart) {
      const reason = 'stale_consumer:' + consumer.id;
      failures.push(reason);
      results.push({ id: consumer.id, matchedPaths: consumer.matchedPaths, before, action: 'restart_unavailable', verified: false, reason });
      continue;
    }
    try { await controller.restart(before); }
    catch (error) {
      const reason = 'restart_failed:' + consumer.id + ':' + (error instanceof Error ? error.message : String(error));
      failures.push(reason);
      results.push({ id: consumer.id, matchedPaths: consumer.matchedPaths, before, action: 'restart', verified: false, reason });
      continue;
    }
    const after = await observeFresh(controller, cutoff!, before.identity);
    const fresh = after.state === 'running' && Number.isFinite(after.startedAtMs) && (after.startedAtMs ?? 0) > cutoff!
      && (isFleet ? Boolean(before.identity && after.identity && before.identity !== after.identity)
        : (!before.identity || !after.identity || before.identity !== after.identity));
    if (!fresh) {
      const reason = 'restart_not_observed:' + consumer.id;
      failures.push(reason);
      results.push({ id: consumer.id, matchedPaths: consumer.matchedPaths, before, action: 'restart', after, verified: false, reason });
      continue;
    }
    results.push({ id: consumer.id, matchedPaths: consumer.matchedPaths, before, action: 'restart', after, verified: true });
  }
  // A shared post-control MainPID/start-ticks across distinct units cannot verify either consumer.
  const postFleet = new Map<string, number>();
  for (let index = 0; index < results.length; index++) {
    const row = results[index]!;
    if (!FLEET_CONSUMER_RE.test(row.id)) continue;
    const observed = row.after ?? row.before;
    if (observed.state !== 'running' || !observed.identity) continue;
    const previous = postFleet.get(observed.identity);
    if (previous !== undefined) {
      for (const position of [previous, index]) {
        const conflicting = results[position]!;
        const reason = conflicting.id + ':fleet_wake_shared_post_control_identity';
        failures.push(reason);
        results[position] = { ...conflicting, verified: false, reason };
      }
    } else postFleet.set(observed.identity, index);
  }
  let liveCheck: LiveCheckResult;
  try { liveCheck = await input.runLiveCheck(); }
  catch (error) { liveCheck = { ok: false, reason: 'live_check_exception:' + (error instanceof Error ? error.message : String(error)) }; }
  if (!liveCheck.ok) failures.push('live_check:' + (liveCheck.reason ?? 'failed'));
  const uniqueFailures = [...new Set(failures.map(sanitizedReason))];
  const effect = uniqueFailures.length === 0 ? 'effect_verified' : 'effect_unverified(' + uniqueFailures.join(';') + ')';
  return {
    schema: 'orchestrator-pack/merge-adoption-effect/v1',
    consumers: results,
    liveCheck,
    effect,
    operationalOutcome: uniqueFailures.length === 0 ? 'operationally_complete' : 'operationally_incomplete',
    coordinatorMessage: uniqueFailures.length === 0 ? null
      : 'Merge adoption effect remains unverified: ' + uniqueFailures.join('; ') + '. Keep operationally_incomplete. '
        + (input.consumers.some((row) => row.id === FLEET_TEMPLATE_CONSUMER)
          ? 'Operator must install/render the tracked fleet template, daemon-reload, activate and read back the effective installed unit.'
          : input.consumers.some((row) => row.id === FLEET_INVENTORY_CONSUMER)
            ? 'Repair the registered project-card inventory and rerun this verifier without starting any fleet units.'
            : 'Reconcile the named unit through the supported normal control before claiming completion.'),
  };
}

function parseArgv(argv: readonly string[]): CliOptions {
  if (argv[0] !== 'verify') throw new Error('usage: merge-adoption-effect.ts verify --repo-root <path> --merge-sha <sha> --adopted-at <iso> --live-check-json <json> [--fleet-adopted-at <iso>] [--supervisor-state-dir <path>] [--restart-control-json <json>]');
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid argument near ' + String(key));
    values.set(key.slice(2), value);
  }
  const repoRoot = path.resolve(values.get('repo-root') ?? '');
  const mergeSha = String(values.get('merge-sha') ?? '').trim();
  const adoptedAt = String(values.get('adopted-at') ?? '').trim();
  const fleetAdoptedAt = values.get('fleet-adopted-at');
  if (!existsSync(repoRoot)) throw new Error('repo-root is missing');
  assertPackAdoptionRoot(repoRoot);
  if (!FULL_SHA.test(mergeSha)) throw new Error('merge-sha must be 40 hex');
  if (!Number.isFinite(Date.parse(adoptedAt))) throw new Error('adopted-at must be an ISO timestamp');
  const rawChecks = JSON.parse(values.get('live-check-json') ?? 'null') as unknown;
  const liveChecks = Array.isArray(rawChecks) && rawChecks.every((item) => typeof item === 'string')
    ? [rawChecks as string[]]
    : Array.isArray(rawChecks) && rawChecks.every((item) => Array.isArray(item) && item.every((part) => typeof part === 'string')) ? rawChecks as string[][] : [];
  if (liveChecks.length === 0 || liveChecks.some((check) => check.length === 0)) throw new Error('live-check-json must contain one or more argv arrays');
  const rawControls = JSON.parse(values.get('restart-control-json') ?? '{}') as unknown;
  if (!rawControls || typeof rawControls !== 'object' || Array.isArray(rawControls)) throw new Error('restart-control-json must be an object');
  const restartControls: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(rawControls as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item)) throw new Error('restart control ' + key + ' must be a non-empty argv array');
    restartControls[key] = value as string[];
  }
  return {
    repoRoot,
    mergeSha: mergeSha.toLowerCase(),
    adoptedAt,
    ...(fleetAdoptedAt === undefined ? {} : { fleetAdoptedAt }),
    liveChecks,
    supervisorStateDir: path.resolve(values.get('supervisor-state-dir') ?? defaultSupervisorStateDir()),
    restartControls,
  };
}

function changedPathsForMerge(repoRoot: string, mergeSha: string): string[] {
  const result = runCommand('git', ['-C', repoRoot, 'diff-tree', '--no-commit-id', '--name-only', '-r', mergeSha + '^1', mergeSha]);
  if (!result.ok) throw new Error('changed path read failed:' + String(result.status ?? 'unknown'));
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map(normalizeRepoPath);
}

function runLiveChecks(repoRoot: string, checks: readonly string[][]): LiveCheckResult {
  for (const argv of checks) {
    const [command, ...args] = argv;
    if (!command) return { ok: false, reason: 'live_check_command_empty' };
    const result = runCommand(command, args, repoRoot, 120_000);
    if (!result.ok) return { ok: false, reason: 'command_failed:' + path.basename(command) + ':' + String(result.status ?? 'unknown') };
  }
  return { ok: true };
}

export async function runCli(argv: readonly string[]): Promise<AdoptionEffectReport> {
  const options = parseArgv(argv);
  const changedPaths = changedPathsForMerge(options.repoRoot, options.mergeSha);
  const consumers = mapChangedPathsToConsumers(options.repoRoot, changedPaths);
  const adoptionStartedAtMs = Date.parse(options.adoptedAt);
  const controllers = controllersFor(options.repoRoot, consumers, options, adoptionStartedAtMs);
  return verifyAdoptionEffect({
    adoptionStartedAtMs, consumers, controllers,
    fleetAdoptedAtMs: options.fleetAdoptedAt === undefined ? undefined : Date.parse(options.fleetAdoptedAt),
    runLiveCheck: () => runLiveChecks(options.repoRoot, options.liveChecks),
  });
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && path.resolve(entry) === fileURLToPath(import.meta.url));
}
if (isDirectExecution()) {
  runCli(process.argv.slice(2)).then((report) => {
    process.stdout.write(JSON.stringify(report) + '\n');
    if (report.effect !== 'effect_verified') process.exitCode = 2;
  }).catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}
