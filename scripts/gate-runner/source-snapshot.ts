import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export interface SourceSnapshot {
  readonly root: string;
  readonly paths: readonly string[];
  readonly files: ReadonlyMap<string, string>;
  readonly unreadable: ReadonlyMap<string, string>;
}

const EXCLUDED_DIRECTORY_NAMES = new Set(['.git', '.ao', '.graphify', 'node_modules']);

function repoPath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/');
}

export function captureSourceSnapshot(rootInput: string): SourceSnapshot {
  const root = resolve(rootInput);
  const files = new Map<string, string>();
  const unreadable = new Map<string, string>();
  const paths: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = repoPath(root, absolutePath);
      paths.push(path);
      try {
        files.set(path, readFileSync(absolutePath, 'utf8'));
      } catch (error) {
        unreadable.set(path, error instanceof Error ? error.message : String(error));
      }
    }
  };
  if (!statSync(root).isDirectory()) throw new Error(`repo root is not a directory: ${root}`);
  walk(root);
  paths.sort();
  return { root, paths, files, unreadable };
}

export function memorySnapshot(filesInput: Readonly<Record<string, string>>): SourceSnapshot {
  const files = new Map(Object.entries(filesInput).map(([path, text]) => [path.replaceAll('\\', '/'), text]));
  return {
    root: '<memory>',
    paths: [...files.keys()].sort(),
    files,
    unreadable: new Map(),
  };
}
