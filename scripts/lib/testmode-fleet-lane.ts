import './native-entrypoint-preflight-shim.ts';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../kernel/subprocess.ts';

export interface TestModeLaneContext {
  readonly leaseId: string;
  readonly leaseRoot: string;
  readonly writtenMs?: number;
}

interface TestModeLeaseRecord {
  readonly leaseId: string;
  readonly stateRoots?: readonly string[];
}

interface ProcessSnapshot {
  readonly pid: number;
  readonly name: string;
  readonly commandLine: string;
  readonly stateRoot: string;
  readonly markerDir: string;
  readonly testMode: boolean;
  readonly startIdentity: string;
}

export interface TestModeLaneHygiene {
  readonly ok: boolean;
  readonly survivors: readonly number[];
  readonly leaseId: string;
  readonly reason?: string;
}

export interface TestModeLaneCleanup {
  readonly ok: boolean;
  readonly killed: number;
  readonly failed: number;
  readonly survivors: readonly number[];
  readonly maskedLeak: boolean;
  readonly reason?: string;
}

function canonical(value: string): string {
  const text = value.trim();
  return text ? path.resolve(text) : '';
}

function parseJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function contextFiles(root: string, shard: number): string[] {
  if (!root || !existsSync(root)) return [];
  const prefix = `vitest-lane-context-shard-${shard}`;
  const names = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile()
      && (entry.name === `${prefix}.json` || (entry.name.startsWith(`${prefix}-`) && entry.name.endsWith('.json'))))
    .map((entry) => path.join(root, entry.name));
  return names.sort();
}

export function readHeavyLaneContexts(
  shard: number,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): readonly TestModeLaneContext[] {
  const roots = new Set<string>();
  const explicitRoot = canonical(String(env.OPK_TESTMODE_LEASE_ROOT ?? ''));
  if (explicitRoot) roots.add(explicitRoot);
  const harnessRoot = canonical(String(env.OPK_VITEST_HARNESS_ROOT ?? ''));
  if (harnessRoot) roots.add(path.join(harnessRoot, 'state', 'testmode-fleet-leases'));

  const byLease = new Map<string, TestModeLaneContext>();
  for (const root of roots) {
    for (const file of contextFiles(root, shard)) {
      const raw = parseJsonFile<Record<string, unknown>>(file);
      const leaseId = String(raw?.leaseId ?? '').trim();
      if (!leaseId) continue;
      const leaseRoot = canonical(String(raw?.leaseRoot ?? root));
      const writtenMs = Number(raw?.writtenMs ?? 0);
      const next: TestModeLaneContext = {
        leaseId,
        leaseRoot,
        ...(Number.isFinite(writtenMs) && writtenMs > 0 ? { writtenMs } : {}),
      };
      const previous = byLease.get(leaseId);
      if (!previous || Number(next.writtenMs ?? 0) >= Number(previous.writtenMs ?? 0)) {
        byLease.set(leaseId, next);
      }
    }
  }

  const envLeaseId = String(env.OPK_TESTMODE_FLEET_LANE_LEASE_ID ?? '').trim();
  if (envLeaseId && explicitRoot && !byLease.has(envLeaseId)) {
    byLease.set(envLeaseId, { leaseId: envLeaseId, leaseRoot: explicitRoot });
  }
  return [...byLease.values()].sort((left, right) => Number(right.writtenMs ?? 0) - Number(left.writtenMs ?? 0));
}

function readLease(context: TestModeLaneContext): TestModeLeaseRecord | null {
  const file = path.join(context.leaseRoot, 'leases', `${context.leaseId}.json`);
  const raw = parseJsonFile<Record<string, unknown>>(file);
  if (!raw || String(raw.leaseId ?? '') !== context.leaseId) return null;
  const roots = Array.isArray(raw.stateRoots)
    ? raw.stateRoots.map((value) => canonical(String(value ?? ''))).filter(Boolean)
    : [];
  return { leaseId: context.leaseId, stateRoots: roots };
}

function parseEnvironmentBlock(bytes: Buffer): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of bytes.toString('utf8').split('\u0000')) {
    const split = entry.indexOf('=');
    if (split <= 0) continue;
    result.set(entry.slice(0, split), entry.slice(split + 1));
  }
  return result;
}

function linuxStartIdentity(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return '';
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    return fields[19] ?? '';
  } catch {
    return '';
  }
}

function switchValue(commandLine: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const quoted = commandLine.match(new RegExp(`(?:^|\\s)${escaped}(?:\\s+|[:=])(?:\"([^\"]+)\"|'([^']+)'|([^\\s]+))`, 'iu'));
  return String(quoted?.[1] ?? quoted?.[2] ?? quoted?.[3] ?? '').trim();
}

function linuxSnapshots(): ProcessSnapshot[] {
  const snapshots: ProcessSnapshot[] = [];
  let entries: string[] = [];
  try { entries = readdirSync('/proc'); } catch { return snapshots; }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    if (pid <= 0 || pid === process.pid) continue;
    try {
      const name = readFileSync(`/proc/${pid}/comm`, 'utf8').trim().toLowerCase();
      if (name !== 'pwsh' && name !== 'powershell' && name !== 'powershell.exe' && name !== 'pwsh.exe') continue;
      const commandLine = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\u0000').filter(Boolean).join(' ');
      const environment = parseEnvironmentBlock(readFileSync(`/proc/${pid}/environ`));
      const stateRoot = canonical(environment.get('OPK_SIDE_PROCESS_STATE_DIR') ?? switchValue(commandLine, '-StateDir'));
      const markerDir = canonical(environment.get('OPK_WAKE_SUPERVISOR_TEST_MARKER_DIR') ?? '');
      const testMode = markerDir.length > 0 || /(?:^|\s)-TestMode(?:\s|$)/iu.test(commandLine);
      snapshots.push({ pid, name, commandLine, stateRoot, markerDir, testMode, startIdentity: linuxStartIdentity(pid) });
    } catch {
      // Process exited or became unreadable between /proc enumeration and read.
    }
  }
  return snapshots;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(value); value = '';
    } else value += char;
  }
  values.push(value);
  return values;
}

async function windowsSnapshots(): Promise<ProcessSnapshot[]> {
  const result = await runProcess({
    command: 'wmic.exe',
    args: ['process', 'where', "name='pwsh.exe' or name='powershell.exe'", 'get', 'CommandLine,CreationDate,Name,ProcessId', '/format:csv'],
    inheritParentEnv: true,
    allowEmptyStdout: true,
    timeoutMs: 15_000,
  });
  if (!result.ok) throw new Error(`testmode_fleet_windows_inventory_unavailable:${result.error || result.stderr || result.exitCode}`);
  const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return [];
  const header = parseCsvLine(lines[0]!).map((value) => value.trim());
  const indexOf = (name: string) => header.findIndex((value) => value.toLowerCase() === name.toLowerCase());
  const cmdIndex = indexOf('CommandLine');
  const createdIndex = indexOf('CreationDate');
  const nameIndex = indexOf('Name');
  const pidIndex = indexOf('ProcessId');
  if ([cmdIndex, createdIndex, nameIndex, pidIndex].some((index) => index < 0)) {
    throw new Error('testmode_fleet_windows_inventory_malformed');
  }
  return lines.slice(1).flatMap((line) => {
    const row = parseCsvLine(line);
    const pid = Number(row[pidIndex] ?? 0);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return [];
    const commandLine = String(row[cmdIndex] ?? '');
    const stateRoot = canonical(switchValue(commandLine, '-StateDir'));
    const testMode = /(?:^|\s)-TestMode(?:\s|$)/iu.test(commandLine);
    return [{
      pid,
      name: String(row[nameIndex] ?? '').toLowerCase(),
      commandLine,
      stateRoot,
      markerDir: '',
      testMode,
      startIdentity: String(row[createdIndex] ?? ''),
    }];
  });
}

async function macSnapshots(): Promise<ProcessSnapshot[]> {
  const inventory = await runProcess({
    command: 'ps',
    args: ['-axo', 'pid=,comm=,command='],
    inheritParentEnv: true,
    allowEmptyStdout: true,
    timeoutMs: 15_000,
  });
  if (!inventory.ok) throw new Error('testmode_fleet_macos_inventory_unavailable');
  const candidates = inventory.stdout.split(/\r?\n/u).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/u);
    if (!match) return [];
    const pid = Number(match[1]);
    const name = path.basename(match[2] ?? '').toLowerCase();
    if (pid <= 0 || pid === process.pid || (name !== 'pwsh' && name !== 'powershell')) return [];
    return [{ pid, name, commandLine: match[3] ?? '' }];
  });
  const snapshots: ProcessSnapshot[] = [];
  for (const candidate of candidates) {
    const start = await runProcess({ command: 'ps', args: ['-p', String(candidate.pid), '-o', 'lstart='], inheritParentEnv: true, allowEmptyStdout: true, timeoutMs: 5_000 });
    const env = await runProcess({ command: 'ps', args: ['eww', '-p', String(candidate.pid), '-o', 'command='], inheritParentEnv: true, allowEmptyStdout: true, timeoutMs: 5_000 });
    const text = env.ok ? env.stdout : candidate.commandLine;
    const stateMatch = text.match(/(?:^|\s)OPK_SIDE_PROCESS_STATE_DIR=([^\s]+)/u);
    const markerMatch = text.match(/(?:^|\s)OPK_WAKE_SUPERVISOR_TEST_MARKER_DIR=([^\s]+)/u);
    const stateRoot = canonical(stateMatch?.[1] ?? switchValue(candidate.commandLine, '-StateDir'));
    const markerDir = canonical(markerMatch?.[1] ?? '');
    snapshots.push({
      ...candidate,
      stateRoot,
      markerDir,
      testMode: markerDir.length > 0 || /(?:^|\s)-TestMode(?:\s|$)/iu.test(candidate.commandLine),
      startIdentity: start.ok ? start.stdout.trim() : '',
    });
  }
  return snapshots;
}

async function processSnapshots(): Promise<readonly ProcessSnapshot[]> {
  if (process.platform === 'linux') return linuxSnapshots();
  if (process.platform === 'darwin') return macSnapshots();
  if (process.platform === 'win32') return windowsSnapshots();
  throw new Error(`testmode_fleet_platform_unsupported:${process.platform}`);
}

function stateRootMatches(snapshot: ProcessSnapshot, roots: ReadonlySet<string>): boolean {
  return snapshot.testMode && snapshot.stateRoot.length > 0 && roots.has(snapshot.stateRoot);
}

async function currentProcessSnapshot(pid: number): Promise<ProcessSnapshot | undefined> {
  return (await processSnapshots()).find((candidate) => candidate.pid === pid);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function killWithToctou(snapshot: ProcessSnapshot, roots: ReadonlySet<string>): Promise<boolean> {
  const current = await currentProcessSnapshot(snapshot.pid);
  if (!current
      || !current.startIdentity
      || current.startIdentity !== snapshot.startIdentity
      || !stateRootMatches(current, roots)) return false;
  try {
    process.kill(snapshot.pid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (processAlive(snapshot.pid)) process.kill(snapshot.pid, 'SIGKILL');
  } catch {
    return false;
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  return !processAlive(snapshot.pid);
}

async function laneSurvivors(context: TestModeLaneContext): Promise<{ roots: Set<string>; survivors: ProcessSnapshot[]; reason?: string }> {
  const lease = readLease(context);
  if (!lease) return { roots: new Set(), survivors: [], reason: 'lease_record_untrusted' };
  const roots = new Set((lease.stateRoots ?? []).map(canonical).filter(Boolean));
  if (roots.size === 0) return { roots, survivors: [] };
  const snapshots = await processSnapshots();
  return { roots, survivors: snapshots.filter((snapshot) => stateRootMatches(snapshot, roots)) };
}

export async function observeHeavyLaneContext(context: TestModeLaneContext): Promise<TestModeLaneHygiene> {
  const observed = await laneSurvivors(context);
  if (observed.reason) {
    return { ok: false, survivors: [], leaseId: context.leaseId, reason: observed.reason };
  }
  return {
    ok: observed.survivors.length === 0,
    survivors: observed.survivors.map((item) => item.pid),
    leaseId: context.leaseId,
  };
}

export async function cleanupHeavyLaneContext(context: TestModeLaneContext): Promise<TestModeLaneCleanup> {
  const observed = await laneSurvivors(context);
  if (observed.reason) {
    return { ok: false, killed: 0, failed: 1, survivors: [], maskedLeak: false, reason: observed.reason };
  }
  let killed = 0;
  let failed = 0;
  for (const survivor of observed.survivors) {
    if (await killWithToctou(survivor, observed.roots)) killed += 1;
    else failed += 1;
  }
  const after = await laneSurvivors(context);
  if (after.reason) {
    return { ok: false, killed, failed: failed + 1, survivors: [], maskedLeak: observed.survivors.length > 0, reason: after.reason };
  }
  return {
    ok: failed === 0 && after.survivors.length === 0,
    killed,
    failed,
    survivors: after.survivors.map((item) => item.pid),
    maskedLeak: observed.survivors.length > 0 && after.survivors.length === 0,
  };
}

export async function cleanupHeavyShardFleet(
  shard: number,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<readonly TestModeLaneCleanup[]> {
  const contexts = readHeavyLaneContexts(shard, env);
  const results: TestModeLaneCleanup[] = [];
  for (const context of contexts) results.push(await cleanupHeavyLaneContext(context));
  return results;
}

export async function observeHeavyShardFleet(
  shard: number,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<readonly TestModeLaneHygiene[]> {
  const contexts = readHeavyLaneContexts(shard, env);
  const results: TestModeLaneHygiene[] = [];
  for (const context of contexts) results.push(await observeHeavyLaneContext(context));
  return results;
}
