import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';
import { validateDeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';

const SNAPSHOT_DIR = join('docs', 'declarations');

export function snapshotRelativePath(issueNumber: number, iterationId: string): string {
  return join(SNAPSHOT_DIR, `${issueNumber}.${iterationId}.json`);
}

export function snapshotAbsolutePath(
  repoRoot: string,
  issueNumber: number,
  iterationId: string,
): string {
  return join(repoRoot, snapshotRelativePath(issueNumber, iterationId));
}

export function listIssueSnapshots(repoRoot: string, issueNumber: number): string[] {
  const dir = join(repoRoot, SNAPSHOT_DIR);
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(`${issueNumber}.`) && name.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

export function iterationIdFromSnapshotFilename(
  issueNumber: number,
  filename: string,
): string | null {
  const prefix = `${issueNumber}.`;
  if (!filename.startsWith(prefix) || !filename.endsWith('.json')) {
    return null;
  }

  return filename.slice(prefix.length, -'.json'.length);
}

export function findLatestIterationId(
  repoRoot: string,
  issueNumber: number,
): string | null {
  const files = listIssueSnapshots(repoRoot, issueNumber);
  if (files.length === 0) {
    return null;
  }

  const latest = files[files.length - 1]!;
  return iterationIdFromSnapshotFilename(issueNumber, latest);
}

export function readSnapshot(
  repoRoot: string,
  issueNumber: number,
  iterationId: string,
): DeclarationSnapshot | null {
  const path = snapshotAbsolutePath(repoRoot, issueNumber, iterationId);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const validated = validateDeclarationSnapshot(raw);
    if (!validated.ok) {
      throw new Error(validated.errors.join('; '));
    }
    return validated.snapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function writeSnapshot(
  repoRoot: string,
  snapshot: DeclarationSnapshot,
): string {
  const validated = validateDeclarationSnapshot(snapshot);
  if (!validated.ok) {
    throw new Error(`invalid snapshot: ${validated.errors.join('; ')}`);
  }

  const path = snapshotAbsolutePath(
    repoRoot,
    snapshot.issue_number,
    snapshot.iteration_id,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return path;
}
