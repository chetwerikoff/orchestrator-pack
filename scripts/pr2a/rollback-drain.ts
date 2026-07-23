#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ProcessIdentity {
  pid: number;
  startTimeTicks: string;
  bootId: string;
}

export interface RollbackDrainArtifact {
  schemaVersion: 1;
  issue: 948;
  candidateGeneration: string;
  entryBlocked: true;
  createdAtUtc: string;
  processes: ProcessIdentity[];
  digest?: string;
}

function stable(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function bootId(): string {
  return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

function procStat(pid: number): { state: string; ppid: number; startTimeTicks: string } | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
    const close = raw.lastIndexOf(')');
    if (close < 0) return null;
    const fields = raw.slice(close + 2).split(/\s+/u);
    const state = fields[0] ?? '';
    const ppid = Number(fields[1] ?? 0);
    const startTimeTicks = fields[19] ?? '';
    if (!state || !Number.isInteger(ppid) || !startTimeTicks) return null;
    return { state, ppid, startTimeTicks };
  } catch {
    return null;
  }
}

export function readProcessIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const stat = procStat(pid);
  return stat && stat.state !== 'Z' ? { pid, startTimeTicks: stat.startTimeTicks, bootId: bootId() } : null;
}

export function sameProcess(identity: ProcessIdentity): boolean {
  const current = readProcessIdentity(identity.pid);
  return Boolean(current
    && current.bootId === identity.bootId
    && current.startTimeTicks === identity.startTimeTicks);
}

function descendantsOf(rootPids: number[]): number[] {
  const parentByPid = new Map<number, number>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    const stat = procStat(pid);
    if (stat) parentByPid.set(pid, stat.ppid);
  }
  const roots = new Set(rootPids);
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of parentByPid) {
      if (!descendants.has(pid) && (roots.has(ppid) || descendants.has(ppid))) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return [...descendants].sort((a, b) => b - a);
}

function artifactWithoutDigest(artifact: RollbackDrainArtifact): Omit<RollbackDrainArtifact, 'digest'> {
  const { digest: _digest, ...rest } = artifact;
  return rest;
}

export function sealRollbackDrainArtifact(
  candidateGeneration: string,
  processes: ProcessIdentity[],
): RollbackDrainArtifact {
  const generation = candidateGeneration.trim();
  if (!generation) throw new Error('candidate_generation_missing');
  if (processes.length === 0) throw new Error('rollback_process_inventory_empty');
  const artifact: RollbackDrainArtifact = {
    schemaVersion: 1,
    issue: 948,
    candidateGeneration: generation,
    entryBlocked: true,
    createdAtUtc: new Date().toISOString(),
    processes: [...processes].sort((a, b) => a.pid - b.pid),
  };
  artifact.digest = sha256(stable(artifactWithoutDigest(artifact)));
  return artifact;
}

export function validateRollbackDrainArtifact(artifact: RollbackDrainArtifact): void {
  if (artifact.schemaVersion !== 1 || artifact.issue !== 948) throw new Error('rollback_artifact_schema_invalid');
  if (artifact.entryBlocked !== true) throw new Error('rollback_entry_not_blocked');
  if (!artifact.candidateGeneration.trim()) throw new Error('rollback_generation_missing');
  if (artifact.processes.length === 0) throw new Error('rollback_process_inventory_empty');
  const expected = sha256(stable(artifactWithoutDigest(artifact)));
  if (artifact.digest !== expected) throw new Error('rollback_artifact_digest_invalid');
}

function signal(pid: number, name: NodeJS.Signals): void {
  try { process.kill(pid, name); } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
    if (code !== 'ESRCH') throw error;
  }
}

async function waitForExit(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter((pid) => { const stat = procStat(pid); return stat && stat.state !== 'Z'; });
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    alive = pids.filter((pid) => { const stat = procStat(pid); return stat && stat.state !== 'Z'; });
  }
  return alive;
}

export async function executeRollbackDrainArtifact(
  artifact: RollbackDrainArtifact,
): Promise<{ drained: number[]; stale: number[] }> {
  validateRollbackDrainArtifact(artifact);
  const current = artifact.processes.filter(sameProcess);
  const stale = artifact.processes.filter((row) => !sameProcess(row)).map((row) => row.pid);
  const descendants = descendantsOf(current.map((row) => row.pid));
  const targets = [...new Set([...descendants, ...current.map((row) => row.pid)])];
  for (const pid of targets) signal(pid, 'SIGTERM');
  const remaining = await waitForExit(targets, 2_000);
  for (const pid of remaining) signal(pid, 'SIGKILL');
  const survivors = await waitForExit(remaining, 2_000);
  if (survivors.length > 0) throw new Error(`rollback_drain_survivors:${survivors.join(',')}`);
  return { drained: targets, stale };
}

export function exportDetachedRollbackDrain(
  outputDir: string,
  candidateGeneration: string,
  pids: number[],
): { artifactPath: string; runnerPath: string; artifact: RollbackDrainArtifact } {
  if (process.platform !== 'linux') throw new Error('rollback_drain_linux_only');
  const identities = pids.map(readProcessIdentity);
  if (identities.some((row) => row === null)) throw new Error('rollback_process_identity_unavailable');
  const artifact = sealRollbackDrainArtifact(candidateGeneration, identities as ProcessIdentity[]);
  mkdirSync(outputDir, { recursive: true });
  const runnerPath = path.join(outputDir, 'rollback-drain.ts');
  const artifactPath = path.join(outputDir, 'rollback-drain-artifact.json');
  copyFileSync(import.meta.filename, runnerPath);
  writeFileSync(artifactPath, stable(artifact), { mode: 0o600 });
  return { artifactPath, runnerPath, artifact };
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main(): Promise<void> {
  if (process.platform !== 'linux') throw new Error('rollback_drain_linux_only');
  const command = process.argv[2] ?? '';
  if (command === 'identity') {
    const pid = Number(process.argv[3] ?? 0);
    const identity = readProcessIdentity(pid);
    if (!identity) throw new Error('process_identity_unavailable');
    process.stdout.write(stable(identity));
    return;
  }
  if (command === 'export') {
    const output = arg('--out');
    const generation = arg('--generation');
    const pids = (arg('--pids') ?? '').split(',').filter(Boolean).map(Number);
    if (!output || !generation || pids.length === 0) throw new Error('usage: export --out DIR --generation ID --pids P1[,P2]');
    process.stdout.write(stable(exportDetachedRollbackDrain(output, generation, pids)));
    return;
  }
  if (command === 'drain') {
    const artifactPath = arg('--artifact');
    if (!artifactPath) throw new Error('usage: drain --artifact FILE');
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as RollbackDrainArtifact;
    process.stdout.write(stable(await executeRollbackDrainArtifact(artifact)));
    return;
  }
  throw new Error('usage: rollback-drain.ts <identity|export|drain>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
