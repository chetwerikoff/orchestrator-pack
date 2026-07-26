import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sha256Bytes, sha256Stable } from './stable-stringify.ts';
import { writeDurableFile, writeDurableJson } from './activation-evidence.ts';
import type { CutoverStoreSpec, ImportRecord, SnapshotRecord } from './types.ts';

const REQUIRED_FIELDS: Record<string, readonly string[]> = {
  reconcile: ['lastTickMs', 'degradedCi', 'cycleState'],
  reevaluation: ['watchEntries', 'terminalTombstones', 'lastUpdatedMs'],
  reportStateSeed: ['bindingByKey', 'seededKeys', 'deferredScanKeys', 'githubSnapshot', 'lastUpdatedMs'],
};

function normalizedPayload(spec: CutoverStoreSpec, raw: Buffer): Record<string, unknown> {
  const value = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`store_shape_invalid:${spec.id}`);
  const required = REQUIRED_FIELDS[spec.id];
  if (!required || JSON.stringify([...spec.coveredFields]) !== JSON.stringify(required)) throw new Error(`store_covered_fields_invalid:${spec.id}`);
  const allowed = new Set([...required, '_recovery']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`store_unknown_field:${spec.id}:${unknown.join(',')}`);
  for (const key of required) if (!(key in value)) throw new Error(`store_missing_field:${spec.id}:${key}`);
  return Object.fromEntries(required.map((key) => [key, value[key]]));
}

export function snapshotStores(stores: CutoverStoreSpec[], snapshotDir: string, writerWatermark: string): SnapshotRecord[] {
  if (!writerWatermark.trim()) throw new Error('writer_watermark_missing');
  mkdirSync(snapshotDir, { recursive: true });
  return stores.map((store) => {
    const bytes = readFileSync(store.sourcePath);
    const parsed = JSON.parse(bytes.toString('utf8')) as { schemaVersion?: unknown };
    const sourceVersion = Number(parsed.schemaVersion ?? 1);
    if (!Number.isInteger(sourceVersion) || sourceVersion <= 0) throw new Error(`snapshot_version_missing:${store.id}`);
    const snapshotPath = path.join(snapshotDir, `${store.id}.snapshot.json`);
    writeDurableFile(snapshotPath, bytes);
    return { storeId: store.id, snapshotPath, snapshotDigest: sha256Bytes(bytes), sourceVersion, writerWatermark };
  });
}

export function importSnapshot(input: {
  epochId: string;
  nonce: string;
  spec: CutoverStoreSpec;
  snapshot: SnapshotRecord;
}): ImportRecord {
  const raw = readFileSync(input.snapshot.snapshotPath);
  if (sha256Bytes(raw) !== input.snapshot.snapshotDigest) throw new Error(`snapshot_digest_mismatch:${input.spec.id}`);
  const normalized = normalizedPayload(input.spec, raw);
  const importIdentity = sha256Stable({
    epochId: input.epochId,
    nonce: input.nonce,
    storeId: input.spec.id,
    snapshotDigest: input.snapshot.snapshotDigest,
  });
  const importTargetDigest = sha256Stable(normalized);
  const markerPath = `${input.spec.targetPath}.cutover-import.json`;
  if (existsSync(markerPath)) {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as ImportRecord;
    if (marker.importIdentity !== importIdentity || marker.importTargetDigest !== importTargetDigest) {
      throw new Error(`import_identity_conflict:${input.spec.id}`);
    }
    const existing = normalizedPayload(input.spec, readFileSync(input.spec.targetPath));
    if (sha256Stable(existing) !== importTargetDigest) throw new Error(`import_target_digest_mismatch:${input.spec.id}`);
    return marker;
  }
  writeDurableFile(input.spec.targetPath, `${JSON.stringify(normalized, null, 2)}\n`);
  const readBack = normalizedPayload(input.spec, readFileSync(input.spec.targetPath));
  if (sha256Stable(readBack) !== importTargetDigest) throw new Error(`import_target_digest_mismatch:${input.spec.id}`);
  const record: ImportRecord = {
    storeId: input.spec.id,
    importIdentity,
    snapshotDigest: input.snapshot.snapshotDigest,
    importTargetDigest,
    markerPath,
  };
  writeDurableJson(markerPath, record);
  return record;
}
