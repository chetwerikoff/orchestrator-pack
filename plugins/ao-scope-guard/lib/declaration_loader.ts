import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';
import { validateDeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';

const MIRROR_DIR = join('.ao', 'declarations');
const SNAPSHOT_DIR = join('docs', 'declarations');

function declarationRelativePath(issueNumber: number, iterationId: string): string {
  return `${issueNumber}.${iterationId}.json`;
}

function readDeclarationFile(path: string): DeclarationSnapshot | null {
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

export function loadActiveDeclaration(
  repoRoot: string,
  issueNumber: number,
  iterationId: string,
): DeclarationSnapshot | null {
  const filename = declarationRelativePath(issueNumber, iterationId);
  const mirrorPath = join(repoRoot, MIRROR_DIR, filename);
  const fromMirror = readDeclarationFile(mirrorPath);
  if (fromMirror) {
    return fromMirror;
  }

  const snapshotPath = join(repoRoot, SNAPSHOT_DIR, filename);
  return readDeclarationFile(snapshotPath);
}
