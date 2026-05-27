import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';
import { validateDeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';

const MIRROR_DIR = join('.ao', 'declarations');

export function mirrorRelativePath(issueNumber: number, iterationId: string): string {
  return join(MIRROR_DIR, `${issueNumber}.${iterationId}.json`);
}

export function mirrorAbsolutePath(
  repoRoot: string,
  issueNumber: number,
  iterationId: string,
): string {
  return join(repoRoot, mirrorRelativePath(issueNumber, iterationId));
}

export function readMirror(
  repoRoot: string,
  issueNumber: number,
  iterationId: string,
): DeclarationSnapshot | null {
  const path = mirrorAbsolutePath(repoRoot, issueNumber, iterationId);
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

export function writeMirror(
  repoRoot: string,
  snapshot: DeclarationSnapshot,
): string {
  const validated = validateDeclarationSnapshot(snapshot);
  if (!validated.ok) {
    throw new Error(`invalid mirror snapshot: ${validated.errors.join('; ')}`);
  }

  const path = mirrorAbsolutePath(
    repoRoot,
    snapshot.issue_number,
    snapshot.iteration_id,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return path;
}
