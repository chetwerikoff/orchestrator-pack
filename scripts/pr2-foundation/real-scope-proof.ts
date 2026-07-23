import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { resolveLatestCommittedSnapshot } from '../pr-scope-check.ts';
import {
  EXACT_EXISTING_SCOPE_PATHS,
  FOUNDATION_DOC_ROWS,
  validateFoundationScope,
} from './contracts.ts';

const DECLARATION_PATH = 'docs/declarations/923.chatgpt-issue-923.json';
const DECLARATION_BASE_SHA = 'faac4525e5e457f7480f99b5f26fcfd96da6d9d5';
const FOUNDATION_IMPLEMENTATION_BASE_SHA = 'd9f6b60acc17fa56c0c29a45950e14f7b2b801db';
const FOUNDATION_TERMINAL_SHA = '1c040b1f75e4553af7cfbe992264eea9afd5f95e';
const FOUNDATION_MERGE_SHA = 'b967dfe156838039e1d6d137e7064dc9d1b10b4d';

export interface RealScopeProofResult {
  ok: true;
  result: 'foundation-bounded-regular-single-revert';
}

function invariant(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function git(repoRoot: string, args: string[]): string {
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

function changedRows(
  repoRoot: string,
  baseSha: string,
  headSha: string,
): Array<{ status: string; path: string }> {
  const output = git(repoRoot, ['diff', '--name-status', '--find-renames=0', `${baseSha}...${headSha}`]);
  if (!output) return [];
  return output.split(/\r?\n/).map((line) => {
    const [status = '', ...pathParts] = line.split('\t');
    return { status, path: pathParts.join('\t') };
  });
}

function treeMode(repoRoot: string, ref: string, file: string): string {
  const output = git(repoRoot, ['ls-tree', ref, '--', file]);
  return output ? output.split(/\s+/)[0] ?? '' : '';
}

function basePaths(repoRoot: string, baseSha: string): string[] {
  const output = git(repoRoot, ['ls-tree', '-r', '--name-only', baseSha]);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function resolveLatestCommittedSnapshotAtCommit(
  repoRoot: string,
  commitSha: string,
): ReturnType<typeof resolveLatestCommittedSnapshot> {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-pr2-declaration-proof-'));
  try {
    const target = path.join(root, DECLARATION_PATH);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, git(repoRoot, ['show', `${commitSha}:${DECLARATION_PATH}`]), 'utf8');
    return resolveLatestCommittedSnapshot(root, 923);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function packageJsonOverreach(repoRoot: string, baseSha: string, headSha: string): string[] {
  const base = JSON.parse(git(repoRoot, ['show', `${baseSha}:package.json`])) as Record<string, unknown>;
  const head = JSON.parse(git(repoRoot, ['show', `${headSha}:package.json`])) as Record<string, unknown>;
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
  repoRoot: string,
  baseSha: string,
  headSha: string,
  rows: Array<{ status: string; path: string }>,
): string[] {
  const exact = new Set<string>([...EXACT_EXISTING_SCOPE_PATHS, ...FOUNDATION_DOC_ROWS]);
  const derived: string[] = [];
  for (const row of rows) {
    if (row.status !== 'M' || exact.has(row.path)) continue;
    const baseText = git(repoRoot, ['show', `${baseSha}:${row.path}`]);
    const headText = git(repoRoot, ['show', `${headSha}:${row.path}`]).trimEnd();
    const expected = expectedConsumerRewrite(row.path, baseText).trimEnd();
    if (expected === headText) derived.push(row.path);
  }
  return derived;
}

export function runRealFoundationScopeProof(repoRoot = path.resolve('.')): RealScopeProofResult {
  const currentBaseSha = git(repoRoot, ['rev-parse', 'origin/main']);
  git(repoRoot, ['merge-base', '--is-ancestor', DECLARATION_BASE_SHA, FOUNDATION_IMPLEMENTATION_BASE_SHA]);
  git(repoRoot, ['merge-base', '--is-ancestor', FOUNDATION_IMPLEMENTATION_BASE_SHA, FOUNDATION_TERMINAL_SHA]);
  git(repoRoot, ['merge-base', '--is-ancestor', FOUNDATION_TERMINAL_SHA, FOUNDATION_MERGE_SHA]);
  git(repoRoot, ['merge-base', '--is-ancestor', FOUNDATION_MERGE_SHA, currentBaseSha]);
  git(repoRoot, ['merge-base', '--is-ancestor', currentBaseSha, 'HEAD']);

  const declarationCommits = git(repoRoot, [
    'log',
    '--full-history',
    '--diff-filter=A',
    '--format=%H',
    `${DECLARATION_BASE_SHA}..${FOUNDATION_TERMINAL_SHA}`,
    '--',
    DECLARATION_PATH,
  ]).split(/\r?\n/).filter(Boolean);
  invariant(declarationCommits.length === 1, `declaration_commit_count:${declarationCommits.length}`);
  const declarationCommitSha = declarationCommits[0];
  invariant(declarationCommitSha, 'declaration_commit_missing');
  invariant(
    git(repoRoot, ['rev-parse', `${declarationCommitSha}^`]) === DECLARATION_BASE_SHA,
    'declaration_created_after_implementation',
  );
  invariant(
    JSON.stringify(git(repoRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', declarationCommitSha])
      .split(/\r?\n/).filter(Boolean)) === JSON.stringify([DECLARATION_PATH]),
    'declaration_commit_not_isolated',
  );
  invariant(
    git(repoRoot, ['ls-tree', FOUNDATION_TERMINAL_SHA, '--', DECLARATION_PATH]) === '',
    'declaration_present_in_terminal_tree',
  );

  const resolved = resolveLatestCommittedSnapshotAtCommit(repoRoot, declarationCommitSha);
  invariant(resolved.ok, resolved.ok ? 'declaration_snapshot_unreachable' : resolved.message);
  const snapshot = resolved.snapshot;
  invariant(snapshot.baseline.commit_sha === DECLARATION_BASE_SHA, 'declaration_baseline_changed');

  const rows = changedRows(repoRoot, FOUNDATION_IMPLEMENTATION_BASE_SHA, FOUNDATION_TERMINAL_SHA);
  invariant(!rows.some((row) => row.path === DECLARATION_PATH), 'declaration_in_implementation_delta');
  const changedPaths = rows.map((row) => row.path);
  const addedPaths = rows.filter((row) => row.status === 'A').map((row) => row.path);
  const derivedRewritePaths = derivedConsumerRewrites(
    repoRoot,
    FOUNDATION_IMPLEMENTATION_BASE_SHA,
    FOUNDATION_TERMINAL_SHA,
    rows,
  );
  const modes = Object.fromEntries(
    changedPaths.map((file) => [file, treeMode(repoRoot, FOUNDATION_TERMINAL_SHA, file)]),
  );
  const lanes = JSON.parse(
    git(repoRoot, ['show', `${FOUNDATION_TERMINAL_SHA}:scripts/vitest-ci-lanes.config.json`]),
  ) as { classification: Record<string, string> };

  const validated = validateFoundationScope({
    issueNumber: 923,
    baseCommitSha: DECLARATION_BASE_SHA,
    declaration: snapshot,
    changedPaths,
    addedPaths,
    basePaths: basePaths(repoRoot, DECLARATION_BASE_SHA),
    derivedRewritePaths,
    modes,
    laneClassification: lanes.classification,
    packageJsonChangedKeys: packageJsonOverreach(
      repoRoot,
      FOUNDATION_IMPLEMENTATION_BASE_SHA,
      FOUNDATION_TERMINAL_SHA,
    ),
    revertCommitCount: 1,
  });
  invariant(validated.ok, validated.ok ? 'scope_validation_unreachable' : validated.reason);
  invariant(validated.result === 'foundation-bounded-regular-single-revert', `scope_result:${validated.result}`);
  return { ok: true, result: 'foundation-bounded-regular-single-revert' };
}
