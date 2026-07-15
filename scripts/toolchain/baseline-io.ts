import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess } from '#opk-kernel/subprocess';

export interface ChangedFileEntry {
  readonly path: string;
  readonly status: string;
  readonly previousPath?: string;
}

export function writeVersionOneBaseline(path: string, entries: readonly unknown[]): void {
  const serializedEntries = entries.map((entry, index) =>
    `    ${JSON.stringify(entry)}${index === entries.length - 1 ? '' : ','}`,
  );
  writeFileSync(path, ['{', '  "version": 1,', '  "entries": [', ...serializedEntries, '  ]', '}', ''].join('\n'));
}

export function isDirectExecution(importMetaUrl: string, entry: string | undefined): boolean {
  return entry !== undefined && importMetaUrl === pathToFileURL(resolve(entry)).href;
}

export function readJsonFile<T>(repoRoot: string, relativePath: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), 'utf8')) as T;
}

async function gitCapture(repoRoot: string, args: readonly string[]): Promise<string | null> {
  const result = await runProcess({
    command: 'git',
    args,
    cwd: repoRoot,
    allowEmptyStdout: true,
  });
  return result.ok ? result.stdout.trim() : null;
}

function uniqueCandidates(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value))];
}

/** Resolve the same non-self comparison boundary in PR and push contexts. */
export async function resolveComparisonBaseRef(repoRoot: string): Promise<string | null> {
  const head = await gitCapture(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!head) return null;

  const candidates = uniqueCandidates([
    process.env.BASE_SHA,
    process.env.GITHUB_BASE_SHA,
    process.env.PR_BASE_SHA,
    'origin/main',
    'refs/remotes/origin/main',
    'main',
  ]);
  for (const candidate of candidates) {
    const candidateCommit = await gitCapture(repoRoot, ['rev-parse', '--verify', `${candidate}^{commit}`]);
    if (!candidateCommit) continue;
    const mergeBase = await gitCapture(repoRoot, ['merge-base', 'HEAD', candidateCommit]);
    if (mergeBase && mergeBase !== head) return mergeBase;
  }

  const firstParent = await gitCapture(repoRoot, ['rev-parse', '--verify', 'HEAD^1']);
  return firstParent && firstParent !== head ? firstParent : null;
}

export async function readGitFile(repoRoot: string, ref: string, relativePath: string): Promise<string | null> {
  return gitCapture(repoRoot, ['show', `${ref}:${relativePath}`]);
}

export async function listChangedFilesSinceBase(repoRoot: string, baseRef: string): Promise<ChangedFileEntry[]> {
  const output = await gitCapture(repoRoot, ['diff', '--name-status', '--find-renames', `${baseRef}...HEAD`]);
  if (output === null) return [];

  const entries: ChangedFileEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    if (status.startsWith('R') && parts.length >= 3) {
      const previousPath = parts[1];
      const path = parts[2];
      if (!previousPath || !path) continue;
      entries.push({
        status: status.charAt(0),
        previousPath: previousPath.replaceAll('\\', '/'),
        path: path.replaceAll('\\', '/'),
      });
      continue;
    }
    if (!parts[1]) continue;
    entries.push({
      status: status.charAt(0),
      path: parts[1].replaceAll('\\', '/'),
    });
  }
  return entries;
}
