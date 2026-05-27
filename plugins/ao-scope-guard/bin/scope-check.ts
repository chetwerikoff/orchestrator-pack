#!/usr/bin/env tsx

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkScope,
  formatViolationReport,
  type ScopeCheckResult,
} from '../lib/check.js';
import { partitionControlArtifacts } from '../lib/control_artifacts.js';
import { loadLatestActiveDeclaration } from '../lib/declaration_loader.js';
import { resolveIssueDenylist } from '../lib/denylist.js';
import { listStagedPaths } from '../lib/diff_index.js';
import {
  listWorktreeChanges,
  resolveWorktreeBaseline,
} from '../lib/diff_worktree.js';

export type ScopeCheckMode = 'index' | 'worktree';

export interface ScopeCheckOptions {
  repoRoot: string;
  issueNumber: number;
  mode: ScopeCheckMode;
  iterationId?: string;
  baselineCommitSha?: string;
}

function usage(): string {
  return [
    'Usage: scope-check --issue <n> --mode <index|worktree>',
    '                 [--repo-root <path>]',
    '                 [--iteration-id <id>]',
    '                 [--baseline <commit-sha>]',
  ].join('\n');
}

function parseIssueNumber(raw: string | undefined): number {
  const issueNumber = Number(raw ?? process.env.AO_ISSUE_NUMBER);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error('--issue (or AO_ISSUE_NUMBER) must be a positive integer');
  }
  return issueNumber;
}

export function parseScopeCheckArgs(argv: string[]): ScopeCheckOptions {
  let issueNumber: number | undefined;
  let mode: ScopeCheckMode | undefined;
  let repoRoot = process.cwd();
  let iterationId: string | undefined;
  let baselineCommitSha: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--issue':
        issueNumber = parseIssueNumber(argv[++index]);
        break;
      case '--mode': {
        const raw = argv[++index];
        if (raw !== 'index' && raw !== 'worktree') {
          throw new Error('--mode must be "index" or "worktree"');
        }
        mode = raw;
        break;
      }
      case '--repo-root':
        repoRoot = resolve(argv[++index] ?? repoRoot);
        break;
      case '--iteration-id':
        iterationId = argv[++index];
        break;
      case '--baseline':
        baselineCommitSha = argv[++index];
        break;
      case '--help':
      case '-h':
        throw new Error(usage());
      default:
        throw new Error(`unknown argument: ${arg}\n${usage()}`);
    }
  }

  if (issueNumber === undefined) {
    issueNumber = parseIssueNumber(undefined);
  }

  if (!mode) {
    throw new Error(`--mode is required\n${usage()}`);
  }

  return {
    repoRoot,
    issueNumber,
    mode,
    iterationId,
    baselineCommitSha,
  };
}

export function runScopeCheck(options: ScopeCheckOptions): ScopeCheckResult {
  const denylist = resolveIssueDenylist(options.repoRoot, options.issueNumber);

  if (options.mode === 'index') {
    const paths = listStagedPaths(options.repoRoot);
    const { scoped } = partitionControlArtifacts(paths);
    if (scoped.length === 0) {
      return checkScope(paths, null, denylist);
    }

    const declaration = loadLatestActiveDeclaration(
      options.repoRoot,
      options.issueNumber,
      options.iterationId,
    );
    return checkScope(paths, declaration, denylist);
  }

  const declaration = loadLatestActiveDeclaration(
    options.repoRoot,
    options.issueNumber,
    options.iterationId,
  );
  const paths = listWorktreeChanges(
    options.repoRoot,
    resolveWorktreeBaseline(
      options.repoRoot,
      options.baselineCommitSha,
      declaration,
    ),
  );
  const { scoped } = partitionControlArtifacts(paths);
  if (scoped.length === 0) {
    return checkScope(paths, null, denylist);
  }

  return checkScope(paths, declaration, denylist);
}

function isDirectExecution(): boolean {
  const entryScript = process.argv[1];
  if (!entryScript) {
    return false;
  }

  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entryScript)
    );
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  try {
    const result = runScopeCheck(parseScopeCheckArgs(process.argv.slice(2)));
    if (!result.ok) {
      process.stderr.write(`${formatViolationReport(result)}\n`);
      process.exit(1);
    }
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`scope-check: ${message}\n`);
    process.exit(1);
  }
}
