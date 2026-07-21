import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export type MigrationState = 'prepared' | 'imported' | 'committed';

export interface MigrationJournalRecord {
  schemaVersion: 1;
  journalKey: string;
  sourcePath: string;
  targetPath: string;
  sourceDigest: string;
  importedDigest?: string;
  archiveIdentity: string;
  state: MigrationState;
  preparedAt: string;
  importedAt?: string;
  committedAt?: string;
}

export interface MigrationResult {
  ok: boolean;
  reason: string;
  record?: MigrationJournalRecord;
  replayed?: boolean;
}

export type MigrationCrashPoint =
  | 'before_prepare'
  | 'after_prepare'
  | 'before_import'
  | 'after_import'
  | 'before_commit'
  | 'after_commit';

export type GuardedPathResult =
  | { ok: true; path: string; realBoundaryPath: string }
  | {
    ok: false;
    reason:
      | 'foundation_live_import_forbidden'
      | 'fixture_root_required'
      | 'fixture_root_missing'
      | 'path_missing'
      | 'path_ancestry_symlink_refused';
  };

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonical(value: string): string {
  return path.resolve(value);
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function nearestExistingAncestor(candidate: string): string | null {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function hasSymlinkAncestry(lexicalRoot: string, candidate: string): boolean {
  if (lstatSync(lexicalRoot).isSymbolicLink()) return true;
  const relative = path.relative(lexicalRoot, candidate);
  if (!isInside(candidate, lexicalRoot)) return true;
  let current = lexicalRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function realBoundary(candidate: string, mustExist: boolean): string | null {
  if (existsSync(candidate)) return realpathSync(candidate);
  if (mustExist) return null;
  const ancestor = nearestExistingAncestor(path.dirname(candidate));
  return ancestor ? realpathSync(ancestor) : null;
}

function liveRootBoundaries(liveStoreRoots: string[]): string[] {
  return liveStoreRoots
    .map((root) => root.trim())
    .filter(Boolean)
    .flatMap((root) => {
      const lexical = canonical(root);
      if (!existsSync(lexical)) return [lexical];
      return [lexical, realpathSync(lexical)];
    });
}

/**
 * Resolve a path without following a symlink hidden in any ancestor. For
 * output paths, the nearest existing parent is canonicalized before any write.
 * Both the lexical and real boundary must stay under the fixture root and out
 * of every live-store root.
 */
export function assertFixtureOnlyPath(
  candidate: string,
  fixtureRoot: string,
  liveStoreRoots: string[],
  options: { mustExist?: boolean } = {},
): GuardedPathResult {
  if (!fixtureRoot.trim()) return { ok: false, reason: 'fixture_root_required' };
  const lexicalRoot = canonical(fixtureRoot);
  if (!existsSync(lexicalRoot)) return { ok: false, reason: 'fixture_root_missing' };
  const lexicalCandidate = canonical(candidate);
  if (!isInside(lexicalCandidate, lexicalRoot)) {
    return { ok: false, reason: 'foundation_live_import_forbidden' };
  }
  if (hasSymlinkAncestry(lexicalRoot, lexicalCandidate)) {
    return { ok: false, reason: 'path_ancestry_symlink_refused' };
  }

  const mustExist = options.mustExist === true;
  const boundary = realBoundary(lexicalCandidate, mustExist);
  if (!boundary) return { ok: false, reason: 'path_missing' };
  const realRoot = realpathSync(lexicalRoot);
  if (!isInside(boundary, realRoot)) {
    return { ok: false, reason: 'foundation_live_import_forbidden' };
  }

  for (const liveRoot of liveRootBoundaries(liveStoreRoots)) {
    if (isInside(lexicalCandidate, liveRoot)
      || isInside(boundary, liveRoot)
      || (existsSync(lexicalCandidate) && isInside(realpathSync(lexicalCandidate), liveRoot))) {
      return { ok: false, reason: 'foundation_live_import_forbidden' };
    }
  }
  return { ok: true, path: lexicalCandidate, realBoundaryPath: boundary };
}

function writeAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}

export function readMigrationJournal(file: string):
  | { ok: true; record: MigrationJournalRecord | null }
  | { ok: false; reason: 'corrupt_journal' } {
  if (!existsSync(file)) return { ok: true, record: null };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as MigrationJournalRecord;
    if (!parsed
      || parsed.schemaVersion !== 1
      || typeof parsed.journalKey !== 'string'
      || !['prepared', 'imported', 'committed'].includes(parsed.state)
      || typeof parsed.sourceDigest !== 'string'
      || typeof parsed.archiveIdentity !== 'string') {
      return { ok: false, reason: 'corrupt_journal' };
    }
    return { ok: true, record: parsed };
  } catch {
    return { ok: false, reason: 'corrupt_journal' };
  }
}

function inject(crashAt: MigrationCrashPoint | undefined, point: MigrationCrashPoint): void {
  if (crashAt === point) throw new Error(`injected_crash:${point}`);
}

export function runSyntheticMigration(input: {
  journalPath: string;
  sourcePath: string;
  targetPath: string;
  fixtureRoot: string;
  liveStoreRoots?: string[];
  journalKey: string;
  now?: string;
  crashAt?: MigrationCrashPoint;
}): MigrationResult {
  const liveStoreRoots = input.liveStoreRoots ?? [];
  const journalPath = assertFixtureOnlyPath(
    input.journalPath,
    input.fixtureRoot,
    liveStoreRoots,
  );
  const sourcePath = assertFixtureOnlyPath(
    input.sourcePath,
    input.fixtureRoot,
    liveStoreRoots,
    { mustExist: true },
  );
  const targetPath = assertFixtureOnlyPath(
    input.targetPath,
    input.fixtureRoot,
    liveStoreRoots,
  );
  if (!journalPath.ok || !sourcePath.ok || !targetPath.ok) {
    const refusal = [journalPath, sourcePath, targetPath].find((entry) => !entry.ok);
    return { ok: false, reason: refusal && !refusal.ok ? refusal.reason : 'foundation_live_import_forbidden' };
  }
  if (!input.journalKey.trim()) return { ok: false, reason: 'journal_key_required' };

  const existing = readMigrationJournal(journalPath.path);
  if (!existing.ok) return { ok: false, reason: existing.reason };
  const sourceBytes = readFileSync(sourcePath.path);
  const sourceDigest = sha256(sourceBytes);
  const archiveIdentity = sha256(`${input.journalKey}\n${sourceDigest}\n${realpathSync(sourcePath.path)}`);
  const now = input.now ?? new Date().toISOString();
  let record = existing.record ?? undefined;
  let temporaryTarget = '';

  if (record) {
    if (record.journalKey !== input.journalKey
      || record.sourceDigest !== sourceDigest
      || canonical(record.sourcePath) !== sourcePath.path
      || canonical(record.targetPath) !== targetPath.path
      || record.archiveIdentity !== archiveIdentity) {
      return { ok: false, reason: 'journal_identity_conflict', record };
    }
    if (record.state === 'committed') {
      if (!existsSync(targetPath.path) || sha256(readFileSync(targetPath.path)) !== record.importedDigest) {
        return { ok: false, reason: 'committed_target_digest_mismatch', record };
      }
      return { ok: true, reason: 'already_committed', record, replayed: true };
    }
  }

  try {
    if (!record) {
      inject(input.crashAt, 'before_prepare');
      record = {
        schemaVersion: 1,
        journalKey: input.journalKey,
        sourcePath: sourcePath.path,
        targetPath: targetPath.path,
        sourceDigest,
        archiveIdentity,
        state: 'prepared',
        preparedAt: now,
      };
      writeAtomic(journalPath.path, record);
      inject(input.crashAt, 'after_prepare');
    }

    if (record.state === 'prepared') {
      inject(input.crashAt, 'before_import');
      mkdirSync(path.dirname(targetPath.path), { recursive: true });
      temporaryTarget = `${targetPath.path}.${process.pid}.${Date.now()}.importing`;
      writeFileSync(temporaryTarget, sourceBytes, { mode: 0o600 });
      renameSync(temporaryTarget, targetPath.path);
      temporaryTarget = '';
      record = {
        ...record,
        state: 'imported',
        importedDigest: sha256(readFileSync(targetPath.path)),
        importedAt: now,
      };
      writeAtomic(journalPath.path, record);
      inject(input.crashAt, 'after_import');
    }

    if (record.state === 'imported') {
      inject(input.crashAt, 'before_commit');
      if (!record.importedDigest || !existsSync(targetPath.path)
        || sha256(readFileSync(targetPath.path)) !== record.importedDigest) {
        return { ok: false, reason: 'imported_target_digest_mismatch', record };
      }
      record = { ...record, state: 'committed', committedAt: now };
      writeAtomic(journalPath.path, record);
      inject(input.crashAt, 'after_commit');
    }
    return { ok: true, reason: 'committed', record };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), record };
  } finally {
    if (temporaryTarget && existsSync(temporaryTarget)) {
      rmSync(temporaryTarget, { force: true });
    }
  }
}
