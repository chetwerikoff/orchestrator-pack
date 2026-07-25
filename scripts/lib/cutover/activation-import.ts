import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ImportResult, StoreId } from './types.ts';
import { sha256Bytes, sha256Canonical, stableStringify } from './stable-stringify.ts';

const covered: Record<StoreId, readonly string[]> = {
  reconcile: ['lastTickMs', 'degradedCi', 'cycleState'],
  reevaluation: ['watchEntries', 'terminalTombstones', 'lastUpdatedMs'],
  reportStateSeed: ['bindingByKey', 'seededKeys', 'deferredScanKeys', 'githubSnapshot', 'lastUpdatedMs'],
};

function canonicalTarget(storeId: StoreId, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`store_shape_invalid:${storeId}`);
  const source = value as Record<string, unknown>;
  const allowed = new Set([...covered[storeId], '_recovery']);
  const unknown = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`store_unknown_field:${storeId}:${unknown.sort().join(',')}`);
  const result: Record<string, unknown> = {};
  for (const key of covered[storeId]) {
    if (!(key in source)) throw new Error(`store_field_missing:${storeId}:${key}`);
    result[key] = source[key];
  }
  return result;
}

function durableWrite(path: string, value: unknown): void {
  const temp = `${path}.cutover-${process.pid}`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeFileSync(fd, `${stableStringify(value)}\n`, 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temp, path);
  const dirFd = openSync(dirname(path), 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

export function importStore(input: {
  epochId: string;
  nonce: string;
  storeId: StoreId;
  snapshotPath: string;
  targetPath: string;
}): ImportResult {
  const raw = readFileSync(input.snapshotPath);
  const snapshotDigest = sha256Bytes(raw);
  const parsed = JSON.parse(raw.toString('utf8')) as unknown;
  const target = canonicalTarget(input.storeId, parsed);
  const importIdentity = sha256Canonical({
    epochId: input.epochId,
    nonce: input.nonce,
    storeId: input.storeId,
    snapshotDigest,
  });
  const targetDigest = sha256Canonical(target);

  try {
    const existing = canonicalTarget(input.storeId, JSON.parse(readFileSync(input.targetPath, 'utf8')));
    if (sha256Canonical(existing) === targetDigest) return { storeId: input.storeId, snapshotDigest, importIdentity, targetDigest };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  durableWrite(input.targetPath, target);
  const readback = canonicalTarget(input.storeId, JSON.parse(readFileSync(input.targetPath, 'utf8')));
  if (sha256Canonical(readback) !== targetDigest) throw new Error(`import_target_digest_mismatch:${input.storeId}`);
  return { storeId: input.storeId, snapshotDigest, importIdentity, targetDigest };
}
