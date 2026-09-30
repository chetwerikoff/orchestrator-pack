import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { sha256Bytes, sha256Stable } from './stable-stringify.ts';
import { writeDurableFile, writeDurableJson } from './activation-evidence.ts';
import type {
  CutoverStoreId,
  CutoverStoreKind,
  CutoverStoreSpec,
  ImportRecord,
  SnapshotRecord,
} from './types.ts';

const REQUIRED_FIELDS: Record<string, readonly string[]> = {
  reconcile: ['lastTickMs', 'degradedCi', 'cycleState'],
  reevaluation: ['watchEntries', 'terminalTombstones', 'lastUpdatedMs'],
  reportStateSeed: ['bindingByKey', 'seededKeys', 'deferredScanKeys', 'githubSnapshot', 'lastUpdatedMs'],
};
const LEGACY_STORE_IDS = new Set(Object.keys(REQUIRED_FIELDS));

type DirectoryArchiveEntry =
  | { path: string; type: 'directory'; mode: number }
  | { path: string; type: 'file'; mode: number; contentBase64: string };

interface DirectoryArchiveV1 {
  schemaVersion: 1;
  storeId: string;
  kind: 'opaque-directory';
  entries: DirectoryArchiveEntry[];
}

function validateStoreId(id: string): string {
  const value = String(id ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) throw new Error(`cutover_store_id_invalid:${id}`);
  return value;
}

export function cutoverStoreKind(spec: CutoverStoreSpec): CutoverStoreKind {
  validateStoreId(spec.id);
  if (spec.kind) {
    if (!['legacy-json', 'opaque-file', 'opaque-directory'].includes(spec.kind)) {
      throw new Error(`cutover_store_kind_invalid:${spec.id}`);
    }
    if (spec.kind === 'legacy-json' && !LEGACY_STORE_IDS.has(spec.id)) {
      throw new Error(`cutover_legacy_store_id_invalid:${spec.id}`);
    }
    return spec.kind;
  }
  if (LEGACY_STORE_IDS.has(spec.id)) return 'legacy-json';
  throw new Error(`cutover_store_kind_missing:${spec.id}`);
}

function writeAbsentImportMarker(markerPath: string, record: ImportRecord): void {
  writeDurableJson(markerPath, record);
}

function normalizedPayload(spec: CutoverStoreSpec, raw: Buffer): Record<string, unknown> {
  const value = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`store_shape_invalid:${spec.id}`);
  const required = REQUIRED_FIELDS[spec.id];
  if (!required || JSON.stringify([...spec.coveredFields]) !== JSON.stringify(required)) {
    throw new Error(`store_covered_fields_invalid:${spec.id}`);
  }
  const allowed = new Set([...required, '_recovery']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`store_unknown_field:${spec.id}:${unknown.join(',')}`);
  for (const key of required) if (!(key in value)) throw new Error(`store_missing_field:${spec.id}:${key}`);
  return Object.fromEntries(required.map((key) => [key, value[key]]));
}

function directoryEntries(root: string): DirectoryArchiveEntry[] {
  const output: DirectoryArchiveEntry[] = [];
  const visit = (directory: string, relativeRoot: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      const relative = relativeRoot ? path.posix.join(relativeRoot, entry.name) : entry.name;
      const stat = lstatSync(full);
      const mode = stat.mode & 0o777;
      if (entry.isDirectory()) {
        output.push({ path: relative, type: 'directory', mode });
        visit(full, relative);
      } else if (entry.isFile()) {
        output.push({
          path: relative,
          type: 'file',
          mode,
          contentBase64: readFileSync(full).toString('base64'),
        });
      } else {
        throw new Error(`cutover_store_unsupported_entry:${relative}`);
      }
    }
  };
  visit(root, '');
  return output;
}

function archiveDirectory(spec: CutoverStoreSpec): DirectoryArchiveV1 {
  return {
    schemaVersion: 1,
    storeId: spec.id,
    kind: 'opaque-directory',
    entries: directoryEntries(spec.sourcePath),
  };
}

function archiveDigest(archive: DirectoryArchiveV1): string {
  return sha256Stable({
    kind: archive.kind,
    entries: archive.entries.map((entry) => entry.type === 'directory'
      ? { path: entry.path, type: entry.type, mode: entry.mode }
      : {
          path: entry.path,
          type: entry.type,
          mode: entry.mode,
          contentDigest: sha256Bytes(Buffer.from(entry.contentBase64, 'base64')),
        }),
  });
}

export function cutoverPathDigest(pathName: string): string {
  if (!existsSync(pathName)) return 'absent';
  const stat = lstatSync(pathName);
  if (stat.isFile()) return sha256Bytes(readFileSync(pathName));
  if (stat.isDirectory()) {
    const archive: DirectoryArchiveV1 = {
      schemaVersion: 1,
      storeId: 'digest-only',
      kind: 'opaque-directory',
      entries: directoryEntries(pathName),
    };
    return archiveDigest(archive);
  }
  throw new Error(`cutover_path_type_unsupported:${pathName}`);
}

export function cutoverPathEmpty(pathName: string): boolean {
  if (!existsSync(pathName)) return true;
  const stat = lstatSync(pathName);
  if (stat.isFile()) return stat.size === 0;
  if (stat.isDirectory()) return readdirSync(pathName).length === 0;
  return false;
}

export function snapshotArtifactPath(spec: CutoverStoreSpec, snapshotDir: string): string {
  validateStoreId(spec.id);
  return path.join(snapshotDir, `${spec.id}.snapshot.json`);
}

function snapshotBytes(spec: CutoverStoreSpec): { bytes: Buffer; sourceVersion: number; sourceDigest: string } {
  const kind = cutoverStoreKind(spec);
  if (kind === 'legacy-json') {
    const bytes = readFileSync(spec.sourcePath);
    const parsed = JSON.parse(bytes.toString('utf8')) as { schemaVersion?: unknown };
    const sourceVersion = Number(parsed.schemaVersion ?? 1);
    if (!Number.isInteger(sourceVersion) || sourceVersion <= 0) throw new Error(`snapshot_version_missing:${spec.id}`);
    return { bytes, sourceVersion, sourceDigest: sha256Bytes(bytes) };
  }
  if (kind === 'opaque-file') {
    const bytes = readFileSync(spec.sourcePath);
    return { bytes, sourceVersion: 1, sourceDigest: sha256Bytes(bytes) };
  }
  const archive = archiveDirectory(spec);
  const bytes = Buffer.from(`${JSON.stringify(archive, null, 2)}\n`, 'utf8');
  return { bytes, sourceVersion: 1, sourceDigest: archiveDigest(archive) };
}

export function snapshotStores(
  stores: CutoverStoreSpec[],
  snapshotDir: string,
  writerWatermark: string,
  options: { allowMissingSourceIds?: readonly CutoverStoreId[] } = {},
): SnapshotRecord[] {
  if (!writerWatermark.trim()) throw new Error('writer_watermark_missing');
  mkdirSync(snapshotDir, { recursive: true });
  const allowMissingSourceIds = new Set(options.allowMissingSourceIds ?? []);
  return stores.map((store) => {
    cutoverStoreKind(store);
    let bytes: Buffer;
    let sourceVersion = 1;
    let sourceDigest = 'absent';
    let sourceState: SnapshotRecord['sourceState'] = 'present';
    try {
      const captured = snapshotBytes(store);
      bytes = captured.bytes;
      sourceVersion = captured.sourceVersion;
      sourceDigest = captured.sourceDigest;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code !== 'ENOENT' || !allowMissingSourceIds.has(store.id)) {
        throw new Error(`snapshot_source_unreadable:${store.id}:${code || String(error)}`);
      }
      sourceState = 'absent';
      bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, storeId: store.id, sourceState })}\n`, 'utf8');
    }
    const snapshotPath = snapshotArtifactPath(store, snapshotDir);
    writeDurableFile(snapshotPath, bytes);
    return {
      storeId: store.id,
      snapshotPath,
      snapshotDigest: sha256Bytes(bytes),
      sourceDigest,
      sourceVersion,
      writerWatermark,
      sourceState,
    };
  });
}

function parseDirectoryArchive(spec: CutoverStoreSpec, raw: Buffer): DirectoryArchiveV1 {
  const archive = JSON.parse(raw.toString('utf8')) as DirectoryArchiveV1;
  if (
    archive?.schemaVersion !== 1
    || archive.storeId !== spec.id
    || archive.kind !== 'opaque-directory'
    || !Array.isArray(archive.entries)
  ) {
    throw new Error(`snapshot_directory_archive_invalid:${spec.id}`);
  }
  const seen = new Set<string>();
  for (const entry of archive.entries) {
    if (
      !entry
      || typeof entry.path !== 'string'
      || !entry.path
      || path.posix.isAbsolute(entry.path)
      || entry.path.split('/').includes('..')
      || seen.has(entry.path)
      || (entry.type !== 'directory' && entry.type !== 'file')
      || !Number.isInteger(entry.mode)
    ) throw new Error(`snapshot_directory_archive_invalid:${spec.id}`);
    if (entry.type === 'file' && typeof entry.contentBase64 !== 'string') {
      throw new Error(`snapshot_directory_archive_invalid:${spec.id}`);
    }
    seen.add(entry.path);
  }
  return archive;
}

function restoreDirectory(target: string, archive: DirectoryArchiveV1): void {
  if (existsSync(target) && !cutoverPathEmpty(target)) throw new Error(`import_target_not_empty:${archive.storeId}`);
  mkdirSync(target, { recursive: true });
  for (const entry of archive.entries.filter((row) => row.type === 'directory')) {
    const destination = path.join(target, ...entry.path.split('/'));
    mkdirSync(destination, { recursive: true });
    chmodSync(destination, entry.mode);
  }
  for (const entry of archive.entries.filter((row): row is Extract<DirectoryArchiveEntry, { type: 'file' }> => row.type === 'file')) {
    const destination = path.join(target, ...entry.path.split('/'));
    writeDurableFile(destination, Buffer.from(entry.contentBase64, 'base64'));
    chmodSync(destination, entry.mode);
  }
}

export function importSnapshot(input: {
  epochId: string;
  nonce: string;
  spec: CutoverStoreSpec;
  snapshot: SnapshotRecord;
}): ImportRecord {
  const kind = cutoverStoreKind(input.spec);
  if (input.snapshot.storeId !== input.spec.id) throw new Error(`snapshot_store_mismatch:${input.spec.id}`);
  const raw = readFileSync(input.snapshot.snapshotPath);
  if (sha256Bytes(raw) !== input.snapshot.snapshotDigest) throw new Error(`snapshot_digest_mismatch:${input.spec.id}`);
  if (input.snapshot.sourceState === 'absent') {
    const observed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    if (observed.schemaVersion !== 1 || observed.storeId !== input.spec.id || observed.sourceState !== 'absent') {
      throw new Error(`snapshot_absence_evidence_invalid:${input.spec.id}`);
    }
  }
  const importIdentity = sha256Stable({
    epochId: input.epochId,
    nonce: input.nonce,
    storeId: input.spec.id,
    snapshotDigest: input.snapshot.snapshotDigest,
    sourceDigest: input.snapshot.sourceDigest ?? input.snapshot.snapshotDigest,
    sourceState: input.snapshot.sourceState,
  });
  let importTargetDigest = 'sha256:absent';
  if (input.snapshot.sourceState === 'present') {
    if (kind === 'legacy-json') importTargetDigest = sha256Stable(normalizedPayload(input.spec, raw));
    else if (kind === 'opaque-file') importTargetDigest = input.snapshot.sourceDigest ?? input.snapshot.snapshotDigest;
    else importTargetDigest = archiveDigest(parseDirectoryArchive(input.spec, raw));
  }
  const markerPath = `${input.spec.targetPath}.cutover-import.json`;
  if (existsSync(markerPath)) {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as ImportRecord;
    if (marker.importIdentity !== importIdentity || marker.importTargetDigest !== importTargetDigest) {
      throw new Error(`import_identity_conflict:${input.spec.id}`);
    }
    if (marker.sourceState !== input.snapshot.sourceState) {
      throw new Error(`import_identity_conflict:${input.spec.id}`);
    }
    if (input.snapshot.sourceState === 'absent') {
      if (existsSync(input.spec.targetPath)) throw new Error(`import_target_digest_mismatch:${input.spec.id}`);
      return marker;
    }
    const existingDigest = kind === 'legacy-json'
      ? sha256Stable(normalizedPayload(input.spec, readFileSync(input.spec.targetPath)))
      : cutoverPathDigest(input.spec.targetPath);
    if (existingDigest !== importTargetDigest) throw new Error(`import_target_digest_mismatch:${input.spec.id}`);
    return marker;
  }
  if (input.snapshot.sourceState === 'absent') {
    if (existsSync(input.spec.targetPath)) throw new Error(`import_target_digest_mismatch:${input.spec.id}`);
    const record: ImportRecord = {
      storeId: input.snapshot.storeId,
      importIdentity,
      snapshotDigest: input.snapshot.snapshotDigest,
      importTargetDigest,
      markerPath,
      sourceState: 'absent',
    };
    writeAbsentImportMarker(markerPath, record);
    return record;
  }

  if (kind !== 'legacy-json' && !cutoverPathEmpty(input.spec.targetPath)) {
    throw new Error(`import_target_not_empty:${input.spec.id}`);
  }
  if (kind === 'legacy-json') {
    const normalized = normalizedPayload(input.spec, raw);
    writeDurableFile(input.spec.targetPath, `${JSON.stringify(normalized, null, 2)}\n`);
  } else if (kind === 'opaque-file') {
    writeDurableFile(input.spec.targetPath, raw);
  } else {
    restoreDirectory(input.spec.targetPath, parseDirectoryArchive(input.spec, raw));
  }

  const readBackDigest = kind === 'legacy-json'
    ? sha256Stable(normalizedPayload(input.spec, readFileSync(input.spec.targetPath)))
    : cutoverPathDigest(input.spec.targetPath);
  if (readBackDigest !== importTargetDigest) throw new Error(`import_target_digest_mismatch:${input.spec.id}`);
  const record: ImportRecord = {
    storeId: input.snapshot.storeId,
    importIdentity,
    snapshotDigest: input.snapshot.snapshotDigest,
    importTargetDigest,
    markerPath,
    sourceState: 'present',
  };
  writeDurableJson(markerPath, record);
  return record;
}

export function assertSnapshotSourceStable(spec: CutoverStoreSpec, snapshot: SnapshotRecord): void {
  if (cutoverStoreKind(spec) === 'legacy-json') return;
  const expected = snapshot.sourceState === 'absent' ? 'absent' : snapshot.sourceDigest;
  if (!expected || cutoverPathDigest(spec.sourcePath) !== expected) {
    throw new Error(`cutover_source_changed:${spec.id}`);
  }
}

export function retireImportedSource(spec: CutoverStoreSpec, snapshot: SnapshotRecord): boolean {
  if (cutoverStoreKind(spec) === 'legacy-json' || snapshot.sourceState === 'absent') return false;
  assertSnapshotSourceStable(spec, snapshot);
  rmSync(spec.sourcePath, { recursive: true, force: true });
  if (existsSync(spec.sourcePath)) throw new Error(`cutover_source_retirement_failed:${spec.id}`);
  return true;
}
