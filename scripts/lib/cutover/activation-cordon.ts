import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { durableWriteJson } from './activation-evidence.ts';
import { processStartTime } from './activation-platform-preflight.ts';
import type { ProcessIdentity } from './types.ts';

export interface CordonRecord {
  schemaVersion: 1;
  nonce: string;
  epochId: string;
  hostId: string;
  installedCommitSha: string;
  createdAt: string;
  noRespawn: true;
  writersClosed: true;
  oldSupervisor: ProcessIdentity;
  writers: ProcessIdentity[];
}

export function cordonPath(stateDir: string): string { return join(stateDir, 'cutover-cordon.json'); }

export function createCordon(input: {
  stateDir: string;
  epochId: string;
  hostId: string;
  installedCommitSha: string;
  oldSupervisor: ProcessIdentity;
  writers: ProcessIdentity[];
  nonce?: string;
}): CordonRecord {
  mkdirSync(input.stateDir, { recursive: true });
  const path = cordonPath(input.stateDir);
  if (existsSync(path)) {
    const current = JSON.parse(readFileSync(path, 'utf8')) as CordonRecord;
    if (current.epochId !== input.epochId) throw new Error('competing_cutover_cordon');
    return current;
  }
  const record: CordonRecord = {
    schemaVersion: 1,
    nonce: input.nonce ?? randomBytes(32).toString('hex'),
    epochId: input.epochId,
    hostId: input.hostId,
    installedCommitSha: input.installedCommitSha,
    createdAt: new Date().toISOString(),
    noRespawn: true,
    writersClosed: true,
    oldSupervisor: input.oldSupervisor,
    writers: input.writers,
  };
  durableWriteJson(path, record);
  return record;
}

export function verifyIdentity(identity: ProcessIdentity): void {
  const actual = processStartTime(identity.pid);
  if (actual !== identity.startTime) throw new Error(`process_identity_mismatch:${identity.role}:${identity.pid}`);
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export async function terminateIdentity(identity: ProcessIdentity, timeoutMs = 5_000): Promise<void> {
  if (!processAlive(identity.pid)) return;
  verifyIdentity(identity);
  process.kill(identity.pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(identity.pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  verifyIdentity(identity);
  process.kill(identity.pid, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (processAlive(identity.pid)) throw new Error(`process_survived_termination:${identity.role}:${identity.pid}`);
}

export async function drainAndTerminate(record: CordonRecord): Promise<void> {
  for (const writer of record.writers) await terminateIdentity(writer);
  await terminateIdentity(record.oldSupervisor);
  const survivors = [...record.writers, record.oldSupervisor].filter((identity) => processAlive(identity.pid));
  if (survivors.length) throw new Error(`cutover_survivors:${survivors.map((row) => row.role).join(',')}`);
}

export function releaseCordonBeforeImport(stateDir: string): void {
  rmSync(cordonPath(stateDir), { force: true });
}
