import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256Bytes, sha256Stable } from './stable-stringify.ts';
import { writeDurableFile, writeDurableJson } from './activation-evidence.ts';
import type { CordonRecord, CutoverStoreSpec, ProcessIdentity } from './types.ts';

interface LegacyRegistryChild {
  id: string;
  sideEffecting?: boolean;
  sideEffectLockFile?: string;
}

export interface LegacyWriterRecord {
  childId: string;
  identity: ProcessIdentity;
  sideEffectLockPath: string | null;
}

function procStat(pid: number): { ppid: number; startTicks: string } {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const close = raw.lastIndexOf(')');
  if (close < 0) throw new Error('process_stat_invalid');
  const fields = raw.slice(close + 2).trim().split(/\s+/);
  return { ppid: Number(fields[1]), startTicks: fields[19] ?? '' };
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function readProcessIdentity(pid: number): ProcessIdentity {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('process_pid_invalid');
  const { startTicks } = procStat(pid);
  const cmdline = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
  if (!startTicks || cmdline.length === 0) throw new Error('process_identity_unreadable');
  return { pid, startTicks, cmdline };
}

export function assertSameProcess(identity: ProcessIdentity): void {
  const current = readProcessIdentity(identity.pid);
  if (current.startTicks !== identity.startTicks || current.cmdline.join('\0') !== identity.cmdline.join('\0')) {
    throw new Error('process_identity_changed');
  }
}

export function assertLegacySupervisor(identity: ProcessIdentity, oldInstalledRevisionRoot: string): void {
  const required = path.join(oldInstalledRevisionRoot, 'scripts', 'orchestrator-wake-supervisor.ps1');
  const joined = identity.cmdline.join(' ');
  if (!joined.includes(required)) throw new Error('legacy_supervisor_identity_ambiguous');
}

function descendants(rootPid: number): number[] {
  const rows = new Map<number, number>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try { rows.set(pid, procStat(pid).ppid); } catch { /* raced exit */ }
  }
  const result: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of rows) {
      if (pid === rootPid || result.includes(pid)) continue;
      if (ppid === rootPid || result.includes(ppid)) { result.push(pid); changed = true; }
    }
  }
  return result.sort((a, b) => b - a);
}

export async function terminateProcessTree(identity: ProcessIdentity, timeoutMs = 5_000): Promise<number[]> {
  if (!processAlive(identity.pid)) return [];
  assertSameProcess(identity);
  const targets = [...descendants(identity.pid), identity.pid];
  for (const pid of targets) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && targets.some(processAlive)) await new Promise((resolve) => setTimeout(resolve, 50));
  for (const pid of targets.filter(processAlive)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const survivors = targets.filter(processAlive);
  if (survivors.length) throw new Error(`legacy_process_survivor:${survivors.join(',')}`);
  return targets;
}

function readPid(pathName: string): number {
  if (!existsSync(pathName)) return 0;
  const raw = readFileSync(pathName, 'utf8').trim();
  const pid = Number(raw.split(/\r?\n/, 1)[0]);
  return Number.isInteger(pid) && pid > 1 ? pid : 0;
}

export function captureLegacyWriters(oldInstalledRevisionRoot: string, stateRoot: string): LegacyWriterRecord[] {
  const registryPath = path.join(oldInstalledRevisionRoot, 'scripts', 'orchestrator-side-process-registry.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as { children?: LegacyRegistryChild[] };
  if (!Array.isArray(registry.children)) throw new Error('legacy_registry_children_missing');
  const result: LegacyWriterRecord[] = [];
  for (const child of registry.children) {
    if (!child?.id) throw new Error('legacy_registry_child_id_missing');
    const pid = readPid(path.join(stateRoot, `${child.id}.pid`));
    if (pid <= 1 || !processAlive(pid)) continue;
    const identity = readProcessIdentity(pid);
    result.push({
      childId: child.id,
      identity,
      sideEffectLockPath: child.sideEffecting && child.sideEffectLockFile
        ? path.join(stateRoot, child.sideEffectLockFile)
        : null,
    });
  }
  return result;
}

function legacyBarrierPaths(stateRoot: string): { stopping: string; maintenance: string } {
  return {
    stopping: path.join(stateRoot, 'stopping'),
    maintenance: path.join(stateRoot, 'maintenance.epoch'),
  };
}

export function legacyBarrierActive(stateRoot: string): boolean {
  const barrier = legacyBarrierPaths(stateRoot);
  return existsSync(barrier.stopping) || existsSync(barrier.maintenance);
}

function persistLegacyStartBarrier(stateRoot: string, epochId: string): void {
  const barrier = legacyBarrierPaths(stateRoot);
  if (legacyBarrierActive(stateRoot)) throw new Error('recovery_required_existing_legacy_barrier');
  // The legacy loop checks `stopping` before any recovery/restart work, and Start treats
  // either `stopping` or `maintenance.epoch` as an active stop-maintenance epoch. Writing
  // `stopping` first therefore closes both respawn and new-start ingress as the first mutation.
  writeDurableFile(barrier.stopping, `${new Date().toISOString()}\n`);
  writeDurableJson(barrier.maintenance, {
    reason: 'issue-928-cutover',
    epochId,
    startedMs: Date.now(),
  });
}

export function releaseLegacyStartBarrier(stateRoot: string): void {
  const barrier = legacyBarrierPaths(stateRoot);
  rmSync(barrier.maintenance, { force: true });
  rmSync(barrier.stopping, { force: true });
}

interface SideEffectLockRecord { pid?: unknown; startedAt?: unknown }

function lockOwner(pathName: string): { pid: number; startedAt: string } | null {
  if (!existsSync(pathName)) return null;
  try {
    const value = JSON.parse(readFileSync(pathName, 'utf8')) as SideEffectLockRecord;
    const pid = Number(value.pid ?? 0);
    return { pid: Number.isInteger(pid) ? pid : 0, startedAt: String(value.startedAt ?? '') };
  } catch {
    return { pid: 0, startedAt: '' };
  }
}

export async function waitForLegacyWriterDrain(
  writers: LegacyWriterRecord[],
  timeoutMs = 60_000,
): Promise<{ writerWatermark: string; drainedAt: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let busy = false;
    for (const writer of writers) {
      const lockPath = writer.sideEffectLockPath;
      if (!lockPath || !existsSync(lockPath)) continue;
      const owner = lockOwner(lockPath);
      if (owner && owner.pid > 1 && !processAlive(owner.pid)) {
        // Legacy fence semantics define a lock owned by a dead PID as stale. Reclaiming that
        // state file is safe only after the recorded owner is provably gone.
        rmSync(lockPath, { force: true });
        continue;
      }
      busy = true;
    }
    if (!busy) break;
    if (Date.now() >= deadline) throw new Error('writer_drain_timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const drainedAt = new Date().toISOString();
  const evidence = writers.map((writer) => ({
    childId: writer.childId,
    pid: writer.identity.pid,
    startTicks: writer.identity.startTicks,
    sideEffectLockPath: writer.sideEffectLockPath,
    lockPresent: writer.sideEffectLockPath ? existsSync(writer.sideEffectLockPath) : false,
    pidAlive: processAlive(writer.identity.pid),
    pidFileMtimeMs: (() => {
      try { return statSync(`/proc/${writer.identity.pid}`).mtimeMs; } catch { return 0; }
    })(),
  }));
  return { writerWatermark: sha256Stable({ drainedAt, writers: evidence }), drainedAt };
}

export function fileDigestOrAbsent(pathName: string): string {
  return existsSync(pathName) ? sha256Bytes(readFileSync(pathName)) : 'absent';
}

export function createCordon(input: {
  path: string;
  epochId: string;
  hostId: string;
  repoRoot: string;
  installedCommitSha: string;
  oldInstalledRevisionRoot: string;
  legacyStateRoot: string;
  legacySupervisor: ProcessIdentity;
  stores: CutoverStoreSpec[];
}): CordonRecord {
  if (existsSync(input.path)) throw new Error('competing_transaction_admitted');
  const preImportTargetDigests: CordonRecord['preImportTargetDigests'] = {};
  for (const store of input.stores) preImportTargetDigests[store.id] = fileDigestOrAbsent(store.targetPath);
  const record: CordonRecord = {
    schemaVersion: 1,
    epochId: input.epochId,
    nonce: randomBytes(32).toString('hex'),
    hostId: input.hostId,
    repoRoot: input.repoRoot,
    installedCommitSha: input.installedCommitSha,
    oldInstalledRevisionRoot: input.oldInstalledRevisionRoot,
    legacySupervisor: input.legacySupervisor,
    startedAt: new Date().toISOString(),
    writersClosed: true,
    noRespawn: true,
    noTypeScriptStart: true,
    importBegunAt: null,
    preImportTargetDigests,
  };
  persistLegacyStartBarrier(input.legacyStateRoot, input.epochId);
  writeDurableJson(input.path, record);
  return record;
}

export function readCordon(pathName: string): CordonRecord {
  const record = JSON.parse(readFileSync(pathName, 'utf8')) as CordonRecord;
  if (record.schemaVersion !== 1 || !record.writersClosed || !record.noRespawn || !record.noTypeScriptStart) {
    throw new Error('cordon_invalid');
  }
  return record;
}

export function markImportBegun(pathName: string): CordonRecord {
  const record = readCordon(pathName);
  if (!record.importBegunAt) {
    record.importBegunAt = new Date().toISOString();
    writeDurableJson(pathName, record);
  }
  return record;
}
