import {
  expectExactKeys,
  expectInteger,
  expectNullableString,
  expectRecord,
  expectString,
  fail,
  parseJsonDocument,
  propertyPath,
  type ValidatedJsonDocument,
} from './json-contract.ts';

export type CaptureKind = 'structured' | 'unstructured';

export interface CaptureManifestEntry {
  readonly id: string;
  readonly producer: string;
  readonly sourceCommand: string | null;
  readonly kind: CaptureKind;
  readonly path: string;
  readonly contentHash: string;
  readonly exitStatus?: number;
}

export interface CaptureManifest {
  readonly version: number;
  readonly corpusRoot: string;
  readonly entries: Readonly<Record<string, CaptureManifestEntry>>;
}

export interface DaemonStatusCapture {
  readonly state: string;
  readonly pid: number;
  readonly port: number;
  readonly startedAt: string;
  readonly uptime: string;
  readonly runFile: string;
  readonly dataDir: string;
  readonly health: string;
  readonly ready: string;
}

function captureKind(value: unknown, path: string): CaptureKind {
  if (value !== 'structured' && value !== 'unstructured') {
    fail(path, 'expected "structured" or "unstructured"');
  }
  return value;
}

function captureEntry(value: unknown, path: string): CaptureManifestEntry {
  const record = expectRecord(value, path);
  expectExactKeys(
    record,
    path,
    ['id', 'producer', 'sourceCommand', 'kind', 'path', 'contentHash'],
    ['exitStatus'],
  );
  const entry: CaptureManifestEntry = {
    id: expectString(record.id, propertyPath(path, 'id')),
    producer: expectString(record.producer, propertyPath(path, 'producer')),
    sourceCommand: expectNullableString(record.sourceCommand, propertyPath(path, 'sourceCommand')),
    kind: captureKind(record.kind, propertyPath(path, 'kind')),
    path: expectString(record.path, propertyPath(path, 'path')),
    contentHash: expectString(record.contentHash, propertyPath(path, 'contentHash')),
    ...(record.exitStatus === undefined
      ? {}
      : { exitStatus: expectInteger(record.exitStatus, propertyPath(path, 'exitStatus')) }),
  };
  if (!entry.contentHash.startsWith('sha256:')) {
    fail(propertyPath(path, 'contentHash'), 'expected a sha256: content hash');
  }
  return entry;
}

export function validateCaptureManifest(value: unknown, path = '$'): CaptureManifest {
  const record = expectRecord(value, path);
  expectExactKeys(record, path, ['version', 'corpusRoot', 'entries']);
  const entriesRecord = expectRecord(record.entries, propertyPath(path, 'entries'));
  const entries: Record<string, CaptureManifestEntry> = {};
  for (const [key, nested] of Object.entries(entriesRecord)) {
    const entryPath = propertyPath(propertyPath(path, 'entries'), key);
    const parsed = captureEntry(nested, entryPath);
    if (parsed.id !== key) fail(propertyPath(entryPath, 'id'), 'must match its entries key');
    entries[key] = parsed;
  }
  const version = expectInteger(record.version, propertyPath(path, 'version'));
  if (version !== 1) fail(propertyPath(path, 'version'), 'expected capture manifest version 1');
  return {
    version,
    corpusRoot: expectString(record.corpusRoot, propertyPath(path, 'corpusRoot')),
    entries,
  };
}

export function validateDaemonStatusCapture(value: unknown, path = '$'): DaemonStatusCapture {
  const record = expectRecord(value, path);
  const keys = ['state', 'pid', 'port', 'startedAt', 'uptime', 'runFile', 'dataDir', 'health', 'ready'] as const;
  expectExactKeys(record, path, keys);
  return {
    state: expectString(record.state, propertyPath(path, 'state')),
    pid: expectInteger(record.pid, propertyPath(path, 'pid')),
    port: expectInteger(record.port, propertyPath(path, 'port')),
    startedAt: expectString(record.startedAt, propertyPath(path, 'startedAt')),
    uptime: expectString(record.uptime, propertyPath(path, 'uptime')),
    runFile: expectString(record.runFile, propertyPath(path, 'runFile')),
    dataDir: expectString(record.dataDir, propertyPath(path, 'dataDir')),
    health: expectString(record.health, propertyPath(path, 'health')),
    ready: expectString(record.ready, propertyPath(path, 'ready')),
  };
}

export function parseCaptureManifest(source: string | Uint8Array): ValidatedJsonDocument<CaptureManifest> {
  return parseJsonDocument(source, validateCaptureManifest);
}

export function parseDaemonStatusCapture(
  source: string | Uint8Array,
): ValidatedJsonDocument<DaemonStatusCapture> {
  return parseJsonDocument(source, validateDaemonStatusCapture);
}
