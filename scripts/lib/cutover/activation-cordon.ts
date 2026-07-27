import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256Bytes, sha256Stable, stableStringify } from './stable-stringify.ts';
import { writeDurableFile, writeDurableJson } from './activation-evidence.ts';
import type {
  ActivationPaths,
  ActivationRequest,
  CordonPreparedRecord,
  CordonRecord,
  CordonState,
  CutoverRecoveryBindings,
  CutoverStoreSpec,
  ProcessIdentity,
  TypeScriptSupervisorInertProof,
} from './types.ts';
import { D928 } from '../../pr2a/contracts.ts';

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
  const required = path.join(oldInstalledRevisionRoot, D928[0]);
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

function maintenanceBelongsToEpoch(pathName: string, epochId: string): boolean {
  if (!existsSync(pathName)) return false;
  try {
    const value = JSON.parse(readFileSync(pathName, 'utf8')) as { reason?: unknown; epochId?: unknown };
    return value.reason === 'issue-928-cutover' && value.epochId === epochId;
  } catch {
    return false;
  }
}

function persistLegacyStartBarrier(stateRoot: string, epochId: string, allowResume = false): void {
  const barrier = legacyBarrierPaths(stateRoot);
  if (!allowResume && legacyBarrierActive(stateRoot)) throw new Error('recovery_required_existing_legacy_barrier');
  if (!existsSync(barrier.stopping)) {
    // The legacy loop checks `stopping` before any recovery/restart work, and Start treats
    // either `stopping` or `maintenance.epoch` as an active stop-maintenance epoch.
    writeDurableFile(barrier.stopping, `${new Date().toISOString()}\n`);
  }
  if (existsSync(barrier.maintenance)) {
    if (!maintenanceBelongsToEpoch(barrier.maintenance, epochId)) throw new Error('legacy_barrier_epoch_conflict');
  } else {
    writeDurableJson(barrier.maintenance, {
      reason: 'issue-928-cutover',
      epochId,
      startedMs: Date.now(),
    });
  }
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

interface TypeScriptSupervisorStatusSnapshot {
  supervisorPid?: unknown;
  supervisorStartTicks?: unknown;
  childPid?: unknown;
}

function proveTypeScriptSupervisorInert(stateRoot: string): TypeScriptSupervisorInertProof {
  const statusPath = path.join(stateRoot, 'typescript-supervisor-status.json');
  if (!existsSync(statusPath)) {
    return { result: 'typescript-supervisor-inert', statusObserved: false, supervisorAlive: false, childAlive: false };
  }
  const status = JSON.parse(readFileSync(statusPath, 'utf8')) as TypeScriptSupervisorStatusSnapshot;
  const supervisorPid = Number(status.supervisorPid ?? 0);
  const childPid = Number(status.childPid ?? 0);
  let supervisorAlive = false;
  if (Number.isInteger(supervisorPid) && supervisorPid > 1 && processAlive(supervisorPid)) {
    const identity = readProcessIdentity(supervisorPid);
    supervisorAlive = identity.startTicks === String(status.supervisorStartTicks ?? '');
  }
  const childAlive = Number.isInteger(childPid) && childPid > 1 && processAlive(childPid);
  if (supervisorAlive || childAlive) throw new Error('typescript_supervisor_not_inert');
  return { result: 'typescript-supervisor-inert', statusObserved: true, supervisorAlive: false, childAlive: false };
}

function cloneStores(stores: readonly CutoverStoreSpec[]): CutoverStoreSpec[] {
  return stores.map((store) => ({ ...store, coveredFields: [...store.coveredFields] }));
}

export function recoveryBindings(paths: ActivationPaths, stores: readonly CutoverStoreSpec[]): CutoverRecoveryBindings {
  return {
    phaseOnePath: paths.phaseOnePath,
    followupPath: paths.followupPath,
    epochAuthorityPath: paths.epochAuthorityPath,
    targetRegistryPath: paths.targetRegistryPath,
    projectedRegistryPath: paths.projectedRegistryPath,
    snapshotDir: paths.snapshotDir,
    supervisorStateDir: paths.supervisorStateDir,
    stores: cloneStores(stores),
  };
}

function stateBindingShape(state: CordonState): unknown {
  return {
    epochId: state.epochId,
    hostId: state.hostId,
    repoRoot: state.repoRoot,
    installedCommitSha: state.installedCommitSha,
    oldInstalledRevisionRoot: state.oldInstalledRevisionRoot,
    recoveryBindings: state.recoveryBindings,
  };
}

function requestBindingShape(request: ActivationRequest): unknown {
  return {
    epochId: request.epochId,
    hostId: request.hostId,
    repoRoot: request.repoRoot,
    installedCommitSha: request.installedCommitSha,
    oldInstalledRevisionRoot: request.oldInstalledRevisionRoot,
    recoveryBindings: recoveryBindings(request.paths, request.stores),
  };
}

export function assertCordonRequestBinding(request: ActivationRequest, state: CordonState): void {
  if (stableStringify(requestBindingShape(request)) !== stableStringify(stateBindingShape(state))) {
    throw new Error('recovery_request_binding_mismatch');
  }
}

function assertPreparedInput(input: {
  epochId: string;
  hostId: string;
  repoRoot: string;
  installedCommitSha: string;
  oldInstalledRevisionRoot: string;
  legacySupervisor: ProcessIdentity;
  stores: CutoverStoreSpec[];
  paths: ActivationPaths;
}, prepared: CordonPreparedRecord): void {
  const expected = {
    epochId: input.epochId,
    hostId: input.hostId,
    repoRoot: input.repoRoot,
    installedCommitSha: input.installedCommitSha,
    oldInstalledRevisionRoot: String(input.oldInstalledRevisionRoot),
    legacySupervisor: input.legacySupervisor,
    recoveryBindings: recoveryBindings(input.paths, input.stores),
  };
  const observed = {
    epochId: prepared.epochId,
    hostId: prepared.hostId,
    repoRoot: prepared.repoRoot,
    installedCommitSha: prepared.installedCommitSha,
    oldInstalledRevisionRoot: prepared.oldInstalledRevisionRoot,
    legacySupervisor: prepared.legacySupervisor,
    recoveryBindings: prepared.recoveryBindings,
  };
  if (stableStringify(expected) !== stableStringify(observed)) throw new Error('cordon_resume_binding_mismatch');
}

function refuseCompetingTransaction(input: { path: string }): void {
  if (existsSync(input.path)) throw new Error('competing_transaction_admitted');
}

export function readCordonState(pathName: string): CordonState {
  if (!existsSync(pathName)) throw new Error('cordon_missing');
  const record = JSON.parse(readFileSync(pathName, 'utf8')) as CordonState;
  if (
    record.schemaVersion !== 1
    || (record.state !== 'preparing' && record.state !== 'active')
    || !record.epochId
    || !record.nonce
    || !record.hostId
    || !record.repoRoot
    || !record.installedCommitSha
    || !record.oldInstalledRevisionRoot
    || !record.recoveryBindings
    || record.typescriptSupervisorInert?.result !== 'typescript-supervisor-inert'
    || record.typescriptSupervisorInert.supervisorAlive !== false
    || record.typescriptSupervisorInert.childAlive !== false
  ) {
    throw new Error('cordon_invalid');
  }
  return record;
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
  paths: ActivationPaths;
}): CordonRecord {
  let prepared: CordonPreparedRecord;
  if (existsSync(input.path)) {
    const existing = readCordonState(input.path);
    if (existing.state === 'preparing') {
      assertPreparedInput(input, existing);
      prepared = existing;
    } else {
      refuseCompetingTransaction(input);
      throw new Error('unreachable_competing_transaction');
    }
  } else {
    if (legacyBarrierActive(input.legacyStateRoot)) throw new Error('recovery_required_existing_legacy_barrier');
    const typescriptSupervisorInert = proveTypeScriptSupervisorInert(input.legacyStateRoot);
    const preImportTargetDigests: CordonRecord['preImportTargetDigests'] = {};
    for (const store of input.stores) preImportTargetDigests[store.id] = fileDigestOrAbsent(store.targetPath);
    prepared = {
      schemaVersion: 1,
      state: 'preparing',
      epochId: input.epochId,
      nonce: randomBytes(32).toString('hex'),
      hostId: input.hostId,
      repoRoot: input.repoRoot,
      installedCommitSha: input.installedCommitSha,
      oldInstalledRevisionRoot: input.oldInstalledRevisionRoot,
      legacySupervisor: input.legacySupervisor,
      startedAt: new Date().toISOString(),
      typescriptSupervisorInert,
      importBegunAt: null,
      preImportTargetDigests,
      recoveryBindings: recoveryBindings(input.paths, input.stores),
    };
    // Recovery-authoritative intent is durable before the first barrier byte. A crash at any
    // later point can resume the same nonce/bindings instead of leaving an orphan barrier.
    writeDurableJson(input.path, prepared);
  }

  persistLegacyStartBarrier(input.legacyStateRoot, input.epochId, true);
  const record: CordonRecord = {
    ...prepared,
    state: 'active',
    writersClosed: true,
    noRespawn: true,
    noTypeScriptStart: true,
  };
  writeDurableJson(input.path, record);
  return record;
}

export function readCordon(pathName: string): CordonRecord {
  const record = readCordonState(pathName);
  if (
    record.state !== 'active'
    || !record.writersClosed
    || !record.noRespawn
    || !record.noTypeScriptStart
  ) {
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
