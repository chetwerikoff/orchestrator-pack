import { join } from 'node:path';
import { runProcessSync, type ProcessResult } from '../kernel/subprocess.ts';
import {
  normalizeBranchName,
  normalizeHeadSha,
  type ExpectedWorktreeIdentity,
} from './core.ts';
import type { CommandInvocation, CommandRunner } from './operations.ts';

export interface LivePrBinding {
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly state: string;
}

const defaultRunner: CommandRunner = ({ command, args, cwd, timeoutMs }) => runProcessSync({
  command,
  args,
  cwd,
  timeoutMs,
  inheritParentEnv: true,
});

function failedResult(message: string): ProcessResult {
  return {
    outcome: 'exit',
    ok: false,
    exitCode: 1,
    signal: null,
    stdout: '',
    stderr: message,
    timedOut: false,
    cancelled: false,
  };
}

export function readLivePrBinding(
  expected: ExpectedWorktreeIdentity,
  runner: CommandRunner = defaultRunner,
): LivePrBinding {
  if (expected.bindingKind !== 'pr') {
    throw new TypeError('live PR binding is available only for PR-bound lifecycle operations');
  }
  const gh = join(expected.repositoryRoot, 'scripts', 'gh');
  const args = [
    'pr',
    'view',
    String(expected.bindingNumber),
    '--json',
    'headRefName,state,headRefOid',
  ];
  const result = runner({ command: gh, args, cwd: expected.repositoryRoot });
  if (!result.ok) {
    throw new TypeError(
      result.stderr.trim()
      || result.error
      || `${gh} ${args.join(' ')} exited ${String(result.exitCode)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new TypeError(
      `gh pr view returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('gh pr view returned a non-object');
  }
  const row = parsed as Record<string, unknown>;
  if (
    typeof row.headRefName !== 'string'
    || typeof row.headRefOid !== 'string'
    || typeof row.state !== 'string'
  ) {
    throw new TypeError('gh pr view omitted headRefName/state/headRefOid');
  }
  return {
    headRefName: normalizeBranchName(row.headRefName) ?? '',
    headRefOid: normalizeHeadSha(row.headRefOid),
    state: row.state.trim().toUpperCase(),
  };
}

export function validateExpectedPrBinding(
  expected: ExpectedWorktreeIdentity,
  live: LivePrBinding,
): string | null {
  if (expected.bindingKind !== 'pr') {
    return 'destructive lifecycle operations require PR-bound authority';
  }
  if (live.state !== 'MERGED') {
    return `PR #${String(expected.bindingNumber)} is ${live.state || 'UNKNOWN'}, not MERGED`;
  }
  if (live.headRefOid !== expected.headSha) {
    return `expected head ${expected.headSha} does not match PR #${String(expected.bindingNumber)} head ${live.headRefOid}`;
  }
  if (expected.mode === 'branch-bound') {
    const expectedBranch = normalizeBranchName(expected.branchName);
    if (!expectedBranch || live.headRefName !== expectedBranch) {
      return `expected branch ${expectedBranch ?? '<missing>'} does not match PR #${String(expected.bindingNumber)} head branch ${live.headRefName || '<missing>'}`;
    }
  }
  return null;
}

function isDestructiveLifecycleInvocation(
  invocation: CommandInvocation,
  expected: ExpectedWorktreeIdentity,
): boolean {
  const args = [...invocation.args];
  if (invocation.command === 'git') {
    if (args.includes('worktree') && args.includes('remove')) return true;
    if (args.includes('branch') && (args.includes('-d') || args.includes('-D'))) return true;
  }
  return invocation.command === process.execPath
    && args.includes(join(expected.repositoryRoot, 'scripts', 'worktree-teardown.ts'))
    && args.includes('--apply');
}

export function createPrHeadBoundRunner(
  expected: ExpectedWorktreeIdentity,
  runner: CommandRunner = defaultRunner,
): CommandRunner {
  if (expected.bindingKind !== 'pr') return runner;
  return (invocation) => {
    if (!isDestructiveLifecycleInvocation(invocation, expected)) {
      return runner(invocation);
    }
    try {
      const live = readLivePrBinding(expected, runner);
      const mismatch = validateExpectedPrBinding(expected, live);
      if (mismatch) {
        return failedResult(`destructive lifecycle effect blocked: ${mismatch}`);
      }
    } catch (error) {
      return failedResult(
        `destructive lifecycle effect blocked: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return runner(invocation);
  };
}
