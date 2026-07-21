import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcessSync } from '../kernel/subprocess.ts';
import { resolveLatestCommittedSnapshot } from '../pr-scope-check.ts';
import { validateFoundationScope } from './contracts.ts';

const repoRoot = path.resolve('.');
const declarationPath = 'docs/declarations/923.chatgpt-issue-923.json';

function git(args: string[]): string {
  const result = runProcessSync({
    command: 'git',
    args,
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  if (!result.ok) {
    throw new Error(`git_failed:${args.join(' ')}:${result.stderr || result.error || result.outcome}`);
  }
  return result.stdout.trim();
}

function changedRows(baseSha: string): Array<{ status: string; path: string }> {
  const output = git(['diff', '--name-status', '--find-renames=0', `${baseSha}...HEAD`]);
  if (!output) return [];
  return output.split(/\r?\n/).map((line) => {
    const [status = '', ...pathParts] = line.split('\t');
    return { status, path: pathParts.join('\t') };
  });
}

function treeMode(ref: string, file: string): string {
  const output = git(['ls-tree', ref, '--', file]);
  return output ? output.split(/\s+/)[0] ?? '' : '';
}

function basePaths(baseSha: string): string[] {
  const output = git(['ls-tree', '-r', '--name-only', baseSha]);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function commitOrder(baseSha: string): Array<{ sha: string; paths: string[] }> {
  const separator = '__OPK_COMMIT__';
  const output = git([
    'log',
    '--reverse',
    `--format=${separator}%H`,
    '--name-only',
    `${baseSha}..HEAD`,
  ]);
  if (!output) return [];
  return output.split(separator).filter(Boolean).map((block) => {
    const [sha = '', ...paths] = block.trim().split(/\r?\n/);
    return { sha, paths: paths.filter(Boolean) };
  });
}

function resolveLatestCommittedSnapshotAtCommit(
  commitSha: string,
): ReturnType<typeof resolveLatestCommittedSnapshot> {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-pr2-declaration-proof-'));
  try {
    const target = path.join(root, declarationPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, git(['show', `${commitSha}:${declarationPath}`]), 'utf8');
    return resolveLatestCommittedSnapshot(root, 923);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function packageJsonOverreach(baseSha: string): string[] {
  const base = JSON.parse(git(['show', `${baseSha}:package.json`])) as Record<string, unknown>;
  const head = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
  const baseScripts = { ...((base.scripts as Record<string, string>) ?? {}) };
  const headScripts = { ...((head.scripts as Record<string, string>) ?? {}) };
  delete headScripts['test:contract-mutations'];
  const normalizedBase = { ...base, scripts: baseScripts };
  const normalizedHead = { ...head, scripts: headScripts };
  return JSON.stringify(normalizedBase) === JSON.stringify(normalizedHead)
    ? ['scripts.test:contract-mutations']
    : ['package-json-overreach'];
}

describe('[AC9] real committed declaration and base-to-head scope proof', () => {
  it('loads the ancestor snapshot through the repository resolver and validates the real final diff', () => {
    const baseSha = 'faac4525e5e457f7480f99b5f26fcfd96da6d9d5';
    expect(git(['merge-base', '--is-ancestor', baseSha, 'HEAD'])).toBe('');
    const commits = commitOrder(baseSha);
    const declarationIndex = commits.findIndex((commit) => commit.paths.includes(declarationPath));
    const implementationIndex = commits.findIndex((commit) =>
      commit.paths.some((file) => file !== declarationPath),
    );
    expect(declarationIndex).toBe(0);
    expect(implementationIndex).toBeGreaterThan(declarationIndex);
    expect(git(['ls-tree', 'HEAD', '--', declarationPath])).toBe('');

    const declarationCommit = commits[declarationIndex];
    if (!declarationCommit) throw new Error('declaration_commit_missing');
    const resolved = resolveLatestCommittedSnapshotAtCommit(declarationCommit.sha);
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) throw new Error(resolved.message);
    const snapshot = resolved.snapshot;
    expect(snapshot.baseline.commit_sha).toBe(baseSha);

    const rows = changedRows(baseSha);
    expect(rows.some((row) => row.path === declarationPath)).toBe(false);
    const changedPaths = rows.map((row) => row.path);
    const addedPaths = rows.filter((row) => row.status === 'A').map((row) => row.path);
    const modes = Object.fromEntries(changedPaths.map((file) => [file, treeMode('HEAD', file)]));
    const lanes = JSON.parse(
      readFileSync(path.join(repoRoot, 'scripts/vitest-ci-lanes.config.json'), 'utf8'),
    ) as { classification: Record<string, string> };

    expect(validateFoundationScope({
      issueNumber: 923,
      baseCommitSha: baseSha,
      declaration: snapshot,
      changedPaths,
      addedPaths,
      basePaths: basePaths(baseSha),
      modes,
      laneClassification: lanes.classification,
      packageJsonChangedKeys: packageJsonOverreach(baseSha),
      revertCommitCount: 1,
    })).toEqual({ ok: true, result: 'foundation-bounded-regular-single-revert' });
  });
});
