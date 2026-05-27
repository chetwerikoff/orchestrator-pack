import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';
import { validateDeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';

const MIRROR_DIR = join('.ao', 'declarations');
const SNAPSHOT_DIR = join('docs', 'declarations');

function declarationRelativePath(issueNumber: number, iterationId: string): string {
  return `${issueNumber}.${iterationId}.json`;
}

function iterationIdFromDeclarationFilename(
  issueNumber: number,
  filename: string,
): string | null {
  const prefix = `${issueNumber}.`;
  if (!filename.startsWith(prefix) || !filename.endsWith('.json')) {
    return null;
  }

  return filename.slice(prefix.length, -'.json'.length);
}

function listIssueDeclarationFiles(
  repoRoot: string,
  directory: string,
  issueNumber: number,
): string[] {
  const dir = join(repoRoot, directory);
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(`${issueNumber}.`) && name.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

export function findLatestMirrorIterationId(
  repoRoot: string,
  issueNumber: number,
): string | null {
  const files = listIssueDeclarationFiles(repoRoot, MIRROR_DIR, issueNumber);
  if (files.length === 0) {
    return null;
  }

  return iterationIdFromDeclarationFilename(issueNumber, files[files.length - 1]!);
}

export function findLatestSnapshotIterationId(
  repoRoot: string,
  issueNumber: number,
): string | null {
  const files = listIssueDeclarationFiles(repoRoot, SNAPSHOT_DIR, issueNumber);
  if (files.length === 0) {
    return null;
  }

  return iterationIdFromDeclarationFilename(issueNumber, files[files.length - 1]!);
}

/**
 * Resolve the iteration id used for scope checks. Prefer explicit/ao session ids,
 * then the latest mirror, then the latest committed snapshot. Never generates a
 * fresh wrapper id — that would miss declarations created by ao-declare.
 */
export function resolveScopeCheckIterationId(
  repoRoot: string,
  issueNumber: number,
  explicitIterationId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (explicitIterationId?.trim()) {
    return explicitIterationId.trim();
  }

  const sessionId = env.AO_SESSION_ID?.trim();
  if (sessionId) {
    return sessionId;
  }

  return (
    findLatestMirrorIterationId(repoRoot, issueNumber) ??
    findLatestSnapshotIterationId(repoRoot, issueNumber)
  );
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

export function loadLatestActiveDeclaration(
  repoRoot: string,
  issueNumber: number,
  explicitIterationId?: string,
  env: NodeJS.ProcessEnv = process.env,
): DeclarationSnapshot | null {
  const iterationId = resolveScopeCheckIterationId(
    repoRoot,
    issueNumber,
    explicitIterationId,
    env,
  );
  if (!iterationId) {
    return null;
  }

  return loadActiveDeclaration(repoRoot, issueNumber, iterationId);
}
