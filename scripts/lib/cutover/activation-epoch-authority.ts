import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ActivationCore, ActivationFollowUp, EpochDocument } from './types.ts';
import { makeFollowUp, validateFollowUps } from './activation-evidence.ts';
import { stableStringify } from './stable-stringify.ts';

function initial(): EpochDocument {
  return { schemaVersion: 1, currentEpochId: '', coreByEpoch: {}, followUpsByEpoch: {} };
}

function read(path: string): EpochDocument {
  if (!existsSync(path)) return initial();
  const value = JSON.parse(readFileSync(path, 'utf8')) as EpochDocument;
  if (value.schemaVersion !== 1 || typeof value.coreByEpoch !== 'object' || typeof value.followUpsByEpoch !== 'object') {
    throw new Error('epoch_authority_schema_invalid');
  }
  return value;
}

function writeAtomic(path: string, value: EpochDocument): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeFileSync(fd, `${stableStringify(value)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const dirFd = openSync(dirname(path), 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('epoch_authority_locked');
    throw error;
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

export class JsonEpochAuthority {
  constructor(readonly path: string) {}

  get(epochId: string): ActivationCore | null {
    return read(this.path).coreByEpoch[epochId] ?? null;
  }

  getCurrent(): ActivationCore | null {
    const document = read(this.path);
    return document.currentEpochId ? document.coreByEpoch[document.currentEpochId] ?? null : null;
  }

  commit(expectedOldEpochId: string, core: ActivationCore): ActivationCore {
    return withLock(this.path, () => {
      const document = read(this.path);
      if (document.coreByEpoch[core.epochId]) {
        const existing = document.coreByEpoch[core.epochId]!;
        if (stableStringify(existing) !== stableStringify(core)) throw new Error('epoch_duplicate_conflict');
        return existing;
      }
      if (document.currentEpochId !== expectedOldEpochId) throw new Error('epoch_cas_conflict');
      document.currentEpochId = core.epochId;
      document.coreByEpoch[core.epochId] = core;
      document.followUpsByEpoch[core.epochId] = [];
      writeAtomic(this.path, document);
      return core;
    });
  }

  require(epochId: string, nonce: string): ActivationCore {
    const core = this.get(epochId);
    if (!core) throw new Error('epoch_missing');
    if (core.nonce !== nonce) throw new Error('epoch_nonce_mismatch');
    return core;
  }

  followUps(epochId: string): ActivationFollowUp[] {
    const document = read(this.path);
    const rows = document.followUpsByEpoch[epochId] ?? [];
    validateFollowUps(rows);
    return rows;
  }

  appendFollowUp(epochId: string, nonce: string, step: string, detail: unknown): ActivationFollowUp {
    return withLock(this.path, () => {
      const document = read(this.path);
      const core = document.coreByEpoch[epochId];
      if (!core || core.nonce !== nonce) throw new Error('epoch_nonce_mismatch');
      const rows = document.followUpsByEpoch[epochId] ?? [];
      const next = makeFollowUp(epochId, rows, step, detail);
      rows.push(next);
      document.followUpsByEpoch[epochId] = rows;
      writeAtomic(this.path, document);
      return next;
    });
  }
}
