#!/usr/bin/env tsx

import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';
import { formatViolationReport } from '../lib/check.js';
import { loadLatestActiveDeclaration } from '../lib/declaration_loader.js';
import { parseScopeCheckArgs, runScopeCheck } from './scope-check.js';

interface WrapOptions {
  repoRoot: string;
  issueNumber: number;
  iterationId?: string;
  baselineCommitSha?: string;
  command: string[];
}

function resolveRepoHead(repoRoot: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function resolveWrapScopeBaseline(
  options: WrapOptions,
  preRunBaseline: string,
  declaration: DeclarationSnapshot | null,
): string {
  return (
    options.baselineCommitSha ??
    declaration?.baseline.commit_sha ??
    preRunBaseline
  );
}

function usage(): string {
  return [
    'Usage: agent-wrap --issue <n> [--repo-root <path>] [--iteration-id <id>]',
    '                   [--baseline <commit-sha>] -- <agent-command...>',
  ].join('\n');
}

export function parseAgentWrapArgs(argv: string[]): WrapOptions {
  const separator = argv.indexOf('--');
  const optionArgs = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);

  const scopeOptions = parseScopeCheckArgs([
    ...optionArgs,
    '--mode',
    'worktree',
  ]);

  if (command.length === 0) {
    throw new Error(`agent command is required after --\n${usage()}`);
  }

  return {
    repoRoot: scopeOptions.repoRoot,
    issueNumber: scopeOptions.issueNumber,
    iterationId: scopeOptions.iterationId,
    baselineCommitSha: scopeOptions.baselineCommitSha,
    command,
  };
}

export function runAgentWrap(options: WrapOptions): number {
  const [executable, ...args] = options.command;
  if (!executable) {
    throw new Error(`agent command is required after --\n${usage()}`);
  }

  const preRunBaseline = resolveRepoHead(options.repoRoot);

  const child = spawnSync(executable, args, {
    cwd: options.repoRoot,
    stdio: 'inherit',
    env: process.env,
  });

  if (child.error) {
    throw child.error;
  }

  if (child.status !== 0) {
    return child.status ?? 1;
  }

  const declaration = loadLatestActiveDeclaration(
    options.repoRoot,
    options.issueNumber,
    options.iterationId,
  );

  const scopeResult = runScopeCheck({
    repoRoot: options.repoRoot,
    issueNumber: options.issueNumber,
    mode: 'worktree',
    iterationId: options.iterationId,
    baselineCommitSha: resolveWrapScopeBaseline(
      options,
      preRunBaseline,
      declaration,
    ),
  });

  if (!scopeResult.ok) {
    process.stderr.write(`${formatViolationReport(scopeResult)}\n`);
    process.stderr.write(
      'agent-wrap: refusing to proceed — working tree changes violate active scope\n',
    );
    return 1;
  }

  return 0;
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
    const exitCode = runAgentWrap(parseAgentWrapArgs(process.argv.slice(2)));
    process.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`agent-wrap: ${message}\n`);
    process.exit(1);
  }
}
