#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatViolationReport } from '../lib/check.js';
import { parseScopeCheckArgs, runScopeCheck } from './scope-check.js';

interface WrapOptions {
  repoRoot: string;
  issueNumber: number;
  iterationId?: string;
  baselineCommitSha?: string;
  command: string[];
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

  const scopeResult = runScopeCheck({
    repoRoot: options.repoRoot,
    issueNumber: options.issueNumber,
    mode: 'worktree',
    iterationId: options.iterationId,
    baselineCommitSha: options.baselineCommitSha,
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
  if (!process.argv[1]) {
    return false;
  }
  return resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
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
