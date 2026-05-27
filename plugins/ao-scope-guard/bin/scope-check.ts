#!/usr/bin/env tsx

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { IterationIdSource } from '@orchestrator-pack/shared/lib/declaration_schema.js';
import {
  checkScope,
  formatViolationReport,
  type ScopeCheckResult,
} from '../lib/check.js';
import { partitionControlArtifacts } from '../lib/control_artifacts.js';
import { loadActiveDeclaration } from '../lib/declaration_loader.js';
import { resolveIssueDenylist } from '../lib/denylist.js';
import { listStagedPaths } from '../lib/diff_index.js';
import { listWorktreeChanges } from '../lib/diff_worktree.js';

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

function resolveIterationId(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { iteration_id: string; iteration_id_source: IterationIdSource } {
  if (explicit?.trim()) {
    return {
      iteration_id: explicit.trim(),
      iteration_id_source: env.AO_SESSION_ID?.trim() ? 'ao_session' : 'wrapper_generated',
    };
  }

  const sessionId = env.AO_SESSION_ID?.trim();
  if (sessionId) {
    return { iteration_id: sessionId, iteration_id_source: 'ao_session' };
  }

  const shortUuid = randomUUID().split('-')[0];
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return {
    iteration_id: `wrap-${timestamp}-${shortUuid}`,
    iteration_id_source: 'wrapper_generated',
  };
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
  const iteration = resolveIterationId(options.iterationId);
  const denylist = resolveIssueDenylist(options.repoRoot, options.issueNumber);

  const declarationForBaseline =
    options.mode === 'worktree' || options.baselineCommitSha
      ? loadActiveDeclaration(
          options.repoRoot,
          options.issueNumber,
          iteration.iteration_id,
        )
      : null;

  const paths =
    options.mode === 'index'
      ? listStagedPaths(options.repoRoot)
      : listWorktreeChanges(
          options.repoRoot,
          options.baselineCommitSha ??
            declarationForBaseline?.baseline.commit_sha ??
            (() => {
              throw new Error(
                'worktree mode requires --baseline or an active declaration with baseline.commit_sha',
              );
            })(),
        );

  const { scoped } = partitionControlArtifacts(paths);
  const declaration =
    scoped.length === 0
      ? null
      : (declarationForBaseline ??
        loadActiveDeclaration(
          options.repoRoot,
          options.issueNumber,
          iteration.iteration_id,
        ));

  return checkScope(paths, declaration, denylist);
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  return resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
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
