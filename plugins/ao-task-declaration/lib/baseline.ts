import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { DeclarationBaseline } from '@orchestrator-pack/shared/lib/declaration_schema.js';

const RUNTIME_PATH_EXCLUSIONS = [
  /^\.ao\//,
  /^node_modules\//,
  /^dist\//,
  /^build\//,
  /^coverage\//,
  /^\.cache\//,
  /^\.turbo\//,
  /^\.next\//,
  /^\.out\//,
  /^\.npm\//,
  /^\.pnpm-store\//,
];

export interface ActiveScopeInput {
  declared_paths: string[];
  declared_globs: string[];
  issue_denylist: string[];
  issue_allowed_roots?: string[];
}

export function computeActiveScopeHash(input: ActiveScopeInput): string {
  const payload: Record<string, string[]> = {
    declared_paths: [...input.declared_paths].sort(),
    declared_globs: [...input.declared_globs].sort(),
    issue_denylist: [...input.issue_denylist].sort(),
  };

  if (input.issue_allowed_roots !== undefined) {
    payload.issue_allowed_roots = [...input.issue_allowed_roots].sort();
  }

  const canonical = JSON.stringify(payload);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:${digest}`;
}

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function parsePorcelainPath(line: string): string | null {
  if (line.length < 4) {
    return null;
  }

  const payload = line.slice(3).trim();
  if (!payload) {
    return null;
  }

  const renameMarker = ' -> ';
  if (payload.includes(renameMarker)) {
    return payload.split(renameMarker).pop() ?? null;
  }

  return payload;
}

function isRuntimeExcludedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return RUNTIME_PATH_EXCLUSIONS.some((pattern) => pattern.test(normalized));
}

export function isWorktreeDirty(repoRoot: string): boolean {
  const porcelain = runGit(repoRoot, ['status', '--porcelain']);
  if (!porcelain) {
    return false;
  }

  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const path = parsePorcelainPath(line);
    if (!path || isRuntimeExcludedPath(path)) {
      continue;
    }

    return true;
  }

  return false;
}

export function computeBaseline(
  repoRoot: string,
  scope: ActiveScopeInput,
): DeclarationBaseline {
  const commit_sha = runGit(repoRoot, ['rev-parse', 'HEAD']);
  const worktree_dirty = isWorktreeDirty(repoRoot);
  const active_scope_hash = computeActiveScopeHash(scope);

  return {
    commit_sha,
    worktree_dirty,
    active_scope_hash,
  };
}

export function assertCleanWorktree(repoRoot: string): void {
  if (isWorktreeDirty(repoRoot)) {
    throw new Error(
      'worktree is dirty; commit or stash pending changes before declaring scope',
    );
  }
}
