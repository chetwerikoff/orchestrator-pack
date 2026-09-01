import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { writeDurableJson } from './activation-evidence.ts';
import type { CutoverStoreId, EpochAuthorityDocument, EpochCommitCore } from './types.ts';

const CORE_KEYS = [
  'epochId', 'nonce', 'hostId', 'repoRoot', 'installedCommitSha', 'snapshotDigests',
  'importDigests', 'registryHash', 'preCommitLogDigest', 'commitAt',
].sort();

function assertExactCore(core: EpochCommitCore): void {
  const keys = Object.keys(core).sort();
  if (JSON.stringify(keys) !== JSON.stringify(CORE_KEYS)) throw new Error('epoch_core_shape_invalid');
  if (!core.epochId || !core.nonce || !core.hostId || !core.repoRoot || !/^[0-9a-f]{40}$/i.test(core.installedCommitSha)) {
    throw new Error('epoch_core_binding_invalid');
  }
}

export function mapCutoverStoreDigests<T extends { storeId: CutoverStoreId }>(
  rows: T[],
  select: (row: T) => string,
): Record<CutoverStoreId, string> {
  const output = {} as Record<CutoverStoreId, string>;
  for (const row of rows) output[row.storeId] = select(row);
  for (const id of ['reconcile', 'reevaluation', 'reportStateSeed'] as const) {
    if (!output[id]) throw new Error(`store_digest_missing:${id}`);
  }
  return output;
}

export function buildEpochCommitCore(
  input: Omit<EpochCommitCore, 'commitAt'> & { commitAt?: string },
): EpochCommitCore {
  const core: EpochCommitCore = { ...input, commitAt: input.commitAt ?? new Date().toISOString() };
  assertExactCore(core);
  return core;
}

function readAuthority(pathName: string): EpochAuthorityDocument {
  if (!existsSync(pathName)) return { schemaVersion: 1, currentEpochId: null, records: [] };
  const value = JSON.parse(readFileSync(pathName, 'utf8')) as EpochAuthorityDocument;
  if (value.schemaVersion !== 1 || !Array.isArray(value.records)) throw new Error('epoch_authority_schema_invalid');
  if (new Set(value.records.map((row) => row.epochId)).size !== value.records.length) throw new Error('epoch_authority_duplicate_epoch');

  const currentEpochId = (value as { currentEpochId?: unknown }).currentEpochId;
  if (currentEpochId !== null && (typeof currentEpochId !== 'string' || currentEpochId.length === 0)) {
    throw new Error('epoch_authority_current_pointer_invalid:malformed_current');
  }
  if (currentEpochId === null && value.records.length > 0) {
    throw new Error('epoch_authority_current_pointer_invalid:null_with_history');
  }
  if (
    typeof currentEpochId === 'string'
    && !value.records.some((row) => row.epochId === currentEpochId)
  ) {
    throw new Error('epoch_authority_current_pointer_invalid:unbound_current');
  }
  return value;
}

function withLock<T>(pathName: string, operation: () => T): T {
  const lock = `${pathName}.lock`;
  mkdirSync(path.dirname(lock), { recursive: true });
  try {
    mkdirSync(lock);
  } catch {
    throw new Error('epoch_authority_busy');
  }
  try { return operation(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

export class FileEpochAuthority {
  readonly path: string;

  constructor(pathName: string) {
    this.path = pathName;
  }

  read(): EpochAuthorityDocument {
    return readAuthority(this.path);
  }

  commit(expectedOldEpochId: string | null, core: EpochCommitCore): EpochCommitCore {
    assertExactCore(core);
    return withLock(this.path, () => {
      const document = readAuthority(this.path);
      if (document.currentEpochId !== expectedOldEpochId) throw new Error('epoch_cas_conflict');
      if (document.records.some((row) => row.epochId === core.epochId)) throw new Error('epoch_duplicate_commit');
      document.records.push(core);
      document.currentEpochId = core.epochId;
      writeDurableJson(this.path, document);
      return core;
    });
  }

  verify(epochId: string, nonce: string): EpochCommitCore {
    const document = readAuthority(this.path);
    if (document.currentEpochId !== epochId) throw new Error('epoch_not_current');
    const record = document.records.find((row) => row.epochId === epochId);
    if (!record || record.nonce !== nonce) throw new Error('epoch_nonce_mismatch');
    assertExactCore(record);
    return record;
  }
}
