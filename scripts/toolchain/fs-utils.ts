import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.ao',
  'node_modules',
  'vendor',
  'packages',
]);

export function normalizeRepoPath(path: string): string {
  return path.split(sep).join('/');
}

export function walkFiles(root: string, accept: (path: string) => boolean): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(join(directory, entry.name));
      } else if (entry.isFile()) {
        const path = join(directory, entry.name);
        if (accept(path)) result.push(path);
      }
    }
  };
  visit(root);
  return result.sort((left, right) => left.localeCompare(right));
}

export function repoRelative(root: string, path: string): string {
  return normalizeRepoPath(relative(root, path));
}
