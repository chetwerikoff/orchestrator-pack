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
import {
  EXACT_EXISTING_SCOPE_PATHS,
  FOUNDATION_DOC_ROWS,
  validateFoundationScope,
} from './contracts.ts';

const repoRoot = path.resolve('.');
const declarationPath = 'docs/declarations/923.chatgpt-issue-923.json';

function git(args: string[]): string {
  const result = runProcessSync({
    command: 'git',
    args,
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  if (!result.ok) throw new Error(`git_failed:${args.join(' ')}:${result.stderr || result.error || result.outcome}`);
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
  return JSON.stringify({ ...base, scripts: baseScripts }) === JSON.stringify({ ...head, scripts: headScripts })
    ? ['scripts.test:contract-mutations']
    : ['package-json-overreach'];
}

function portTarget(source: string): string {
  const basename = path.basename(source);
  const targetName = basename.endsWith('.d.mts')
    ? basename.replace(/\.d\.mts$/, '.d.ts')
    : basename.replace(/\.mjs$/, '.ts');
  return path.posix.join('scripts/pr2-foundation/terminalized', targetName);
}

function relativeSpecifier(fromFile: string, toFile: string): string {
  let relative = path.posix.relative(path.posix.dirname(fromFile), toFile);
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative;
}

function rewriteTerminalizedSpecifier(consumer: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  const source = path.posix.normalize(path.posix.join(path.posix.dirname(consumer), specifier));
  if (!(FOUNDATION_DOC_ROWS as readonly string[]).includes(source)) return specifier;
  const target = consumer === 'scripts/fleet-liveness.cases.ts' && source === 'docs/review-head-ready.mjs'
    ? 'scripts/pr2-foundation/review-head-ready.ts'
    : portTarget(source);
  return relativeSpecifier(consumer, target);
}

function expectedConsumerRewrite(consumer: string, baseText: string): string {
  if (consumer === 'scripts/lib/WorkerReportStore.ps1') {
    return baseText.replace(
      "docs/worker-report-store.mjs'",
      "scripts/pr2-foundation/terminalized/worker-report-store.ts'",
    );
  }
  const rewrite = (specifier: string): string => rewriteTerminalizedSpecifier(consumer, specifier);
  let text = baseText.replace(
    /(from\s+)(['"])(\.[^'"]+)\2/g,
    (_match, prefix: string, quote: string, specifier: string) => `${prefix}${quote}${rewrite(specifier)}${quote}`,
  );
  text = text.replace(
    /(import\s*\(\s*)(['"])(\.[^'"]+)\2/g,
    (_match, prefix: string, quote: string, specifier: string) => `${prefix}${quote}${rewrite(specifier)}${quote}`,
  );
  text = text.replace(
    /(import\s+)(['"])(\.[^'"]+)\2/g,
    (_match, prefix: string, quote: string, specifier: string) => `${prefix}${quote}${rewrite(specifier)}${quote}`,
  );
  return text.replace(
    /(new\s+URL\(\s*)(['"])(\.[^'"]+)\2(\s*,\s*import\.meta\.url\s*\))/g,
    (_match, prefix: string, quote: string, specifier: string, suffix: string) =>
      `${prefix}${quote}${rewrite(specifier)}${quote}${suffix}`,
  );
}

function derivedConsumerRewrites(
  baseSha: string,
  rows: Array<{ status: string; path: string }>,
): string[] {
  const exact = new Set<string>([...EXACT_EXISTING_SCOPE_PATHS, ...FOUNDATION_DOC_ROWS]);
  const derived: string[] = [];
  for (const row of rows) {
    if (row.status !== 'M' || exact.has(row.path)) continue;
    const baseText = git(['show', `${baseSha}:${row.path}`]);
    const headText = readFileSync(path.join(repoRoot, row.path), 'utf8').trimEnd();
    const expected = expectedConsumerRewrite(row.path, baseText).trimEnd();
    if (expected === headText) derived.push(row.path);
  }
  return derived;
}

describe('[AC9] real committed declaration and base-to-head scope proof', () => {
  it('keeps the immutable declaration baseline while validating only the current PR delta', () => {
    const declarationBaseSha = 'faac4525e5e457f7480f99b5f26fcfd96da6d9d5';
    const currentBaseSha = git(['rev-parse', 'origin/main']);
    expect(git(['merge-base', '--is-ancestor', declarationBaseSha, currentBaseSha])).toBe('');
    expect(git(['merge-base', '--is-ancestor', currentBaseSha, 'HEAD'])).toBe('');

    const declarationCommits = git([
      'log',
      '--diff-filter=A',
      '--format=%H',
      `${declarationBaseSha}..HEAD`,
      '--',
      declarationPath,
    ]).split(/\r?\n/).filter(Boolean);
    expect(declarationCommits).toHaveLength(1);
    const declarationCommitSha = declarationCommits[0];
    if (!declarationCommitSha) throw new Error('declaration_commit_missing');
    expect(git(['rev-parse', `${declarationCommitSha}^`])).toBe(declarationBaseSha);
    expect(git(['diff-tree', '--no-commit-id', '--name-only', '-r', declarationCommitSha])
      .split(/\r?\n/).filter(Boolean)).toEqual([declarationPath]);
    expect(git(['ls-tree', 'HEAD', '--', declarationPath])).toBe('');

    const resolved = resolveLatestCommittedSnapshotAtCommit(declarationCommitSha);
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) throw new Error(resolved.message);
    const snapshot = resolved.snapshot;
    expect(snapshot.baseline.commit_sha).toBe(declarationBaseSha);

    const rows = changedRows(currentBaseSha);
    expect(rows.some((row) => row.path === declarationPath)).toBe(false);
    const changedPaths = rows.map((row) => row.path);
    const addedPaths = rows.filter((row) => row.status === 'A').map((row) => row.path);
    const derivedRewritePaths = derivedConsumerRewrites(currentBaseSha, rows);
    const modes = Object.fromEntries(changedPaths.map((file) => [file, treeMode('HEAD', file)]));
    const lanes = JSON.parse(
      readFileSync(path.join(repoRoot, 'scripts/vitest-ci-lanes.config.json'), 'utf8'),
    ) as { classification: Record<string, string> };

    expect(validateFoundationScope({
      issueNumber: 923,
      baseCommitSha: declarationBaseSha,
      declaration: snapshot,
      changedPaths,
      addedPaths,
      basePaths: basePaths(declarationBaseSha),
      derivedRewritePaths,
      modes,
      laneClassification: lanes.classification,
      packageJsonChangedKeys: packageJsonOverreach(currentBaseSha),
      revertCommitCount: 1,
    })).toEqual({ ok: true, result: 'foundation-bounded-regular-single-revert' });
  });
});
