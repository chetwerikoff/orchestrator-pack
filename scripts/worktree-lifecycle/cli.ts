#!/usr/bin/env node

import '../toolchain/native-entrypoint-preflight.ts';
import { runLifecycle } from './operations.ts';
import {
  normalizeBranchName,
  normalizeHeadSha,
  normalizeWorktreePath,
  type ExpectedWorktreeIdentity,
  type LifecycleContext,
  type WorktreeBindingKind,
} from './core.ts';
import {
  createPrHeadBoundRunner,
  readLivePrBinding,
  validateExpectedPrBinding,
  type PostMergeExpectedWorktreeIdentity,
} from './head-bound-runner.ts';

interface ParsedArgs {
  readonly context: LifecycleContext | null;
  readonly repositoryRoot: string | null;
  readonly worktree: string | null;
  readonly issueNumber: number | null;
  readonly prNumber: number | null;
  readonly expectedHead: string | null;
  readonly expectedBranch: string | null;
  readonly detached: boolean;
  readonly apply: boolean;
  readonly json: boolean;
}

const CONTEXTS = new Set<LifecycleContext>([
  'post-create',
  'post-merge-cleanup',
  'explicit-recovery',
]);

function valueAfter(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? null;
}

function positiveInteger(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseArgs(argv = process.argv.slice(2)): ParsedArgs {
  const contextValue = valueAfter(argv, '--context');
  return {
    context: contextValue && CONTEXTS.has(contextValue as LifecycleContext)
      ? contextValue as LifecycleContext
      : null,
    repositoryRoot: valueAfter(argv, '--repo-root'),
    worktree: valueAfter(argv, '--worktree'),
    issueNumber: positiveInteger(valueAfter(argv, '--issue')),
    prNumber: positiveInteger(valueAfter(argv, '--pr')),
    expectedHead: valueAfter(argv, '--expected-head'),
    expectedBranch: valueAfter(argv, '--expected-branch'),
    detached: argv.includes('--detached'),
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
  };
}

function usageError(args: ParsedArgs): string | null {
  if (!args.context) return '--context must be post-create, post-merge-cleanup, or explicit-recovery';
  if (!args.repositoryRoot) return '--repo-root is required';
  if (!args.worktree) return '--worktree is required';
  if (Boolean(args.issueNumber) === Boolean(args.prNumber)) {
    return 'choose exactly one authority: --issue <number> or --pr <number>';
  }
  if (args.context !== 'post-create' && !args.prNumber) {
    return `${args.context} requires --pr authority`;
  }
  if (!args.expectedHead) return '--expected-head is required and must be a full 40-hex SHA';
  if (args.detached === Boolean(args.expectedBranch)) {
    return 'choose exactly one of --expected-branch <name> or --detached';
  }
  return null;
}

function emitHuman(report: ReturnType<typeof runLifecycle>): void {
  console.log(`Outcome: ${report.outcome}`);
  console.log(`Context: ${report.context}`);
  console.log(`Classification: ${report.classification.classification}`);
  console.log(`Action: ${report.decision.action}`);
  console.log(`Pipeline continues: ${report.pipelineContinues ? 'yes' : 'no'}`);
  console.log(`Terminal spawn authorized: ${report.decision.terminalSpawnAuthorized ? 'yes' : 'no'}`);
  if (report.gates) {
    const gates = Object.entries(report.gates)
      .map(([name, value]) => `${name}=${value ? 'pass' : 'fail'}`)
      .join(' ');
    console.log(`Gates: ${gates}`);
  }
  if (report.effects.length > 0) console.log(`Effects: ${report.effects.join(', ')}`);
  if (report.error) console.log(`Detail: ${report.error}`);
}

function main(): void {
  const args = parseArgs();
  const error = usageError(args);
  if (error) {
    const payload = {
      schema: 'orchestrator-pack/worktree-lifecycle-cli-error/v1',
      outcome: 'invalid_arguments',
      pipelineContinues: true,
      error,
    };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else console.error(`Invalid arguments: ${error}`);
    process.exitCode = 2;
    return;
  }

  try {
    const bindingKind: WorktreeBindingKind = args.issueNumber ? 'issue' : 'pr';
    const bindingNumber = args.issueNumber ?? args.prNumber!;
    const baseExpected: ExpectedWorktreeIdentity = {
      repositoryRoot: normalizeWorktreePath(args.repositoryRoot!),
      path: normalizeWorktreePath(args.worktree!),
      headSha: normalizeHeadSha(args.expectedHead!),
      mode: args.detached ? 'detached-confirmed' : 'branch-bound',
      ...(args.expectedBranch
        ? { branchName: normalizeBranchName(args.expectedBranch) }
        : {}),
      bindingKind,
      bindingNumber,
    };

    let expected: PostMergeExpectedWorktreeIdentity = baseExpected;
    let operations: Parameters<typeof runLifecycle>[0]['operations'];
    if (bindingKind === 'pr') {
      const live = readLivePrBinding(baseExpected);
      if (args.context === 'post-merge-cleanup') {
        expected = { ...baseExpected, finalPrHeadSha: live.headRefOid };
      }
      const mismatch = validateExpectedPrBinding(expected, live, args.context!);
      if (mismatch) throw new TypeError(mismatch);
      operations = {
        runner: createPrHeadBoundRunner(expected, undefined, args.context!),
      };
    }

    const report = runLifecycle({
      expected,
      context: args.context!,
      apply: args.apply,
      ...(operations ? { operations } : {}),
    });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else emitHuman(report);
    process.exitCode = 0;
  } catch (caught) {
    const payload = {
      schema: 'orchestrator-pack/worktree-lifecycle-cli-error/v1',
      outcome: 'task_degraded',
      pipelineContinues: true,
      error: caught instanceof Error ? caught.message : String(caught),
    };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else console.error(`Lifecycle degraded: ${payload.error}`);
    process.exitCode = 0;
  }
}

main();
