#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveReviewerBudgetDecision } from '../plugins/codex-pr-reviewer/lib/reviewer_budget.ts';
import { resolveTargetContext } from './lib/target-context.ts';
import { startPackReview } from './pack-review-runner.ts';
import { packReviewRunStaleMinutes } from './lib/pack-review-run-store.ts';
import { PACK_REVIEW_BOUND_REVIEWER_ENV } from './lib/resolve-pack-reviewer.ts';

type StartReview = (input: Parameters<typeof startPackReview>[0]) => ReturnType<typeof startPackReview>;

type TextWriter = {
  write: (chunk: string) => unknown;
};

export interface PackGptReviewOptions {
  prNumber: number;
  projectId?: string;
  sessionId?: string;
  timeoutSeconds?: number;
}

export interface PackGptReviewDependencies {
  env?: NodeJS.ProcessEnv;
  stderr?: TextWriter;
  startReview?: StartReview;
}

export interface PackGptReviewExecution {
  exitCode: number;
  result: Record<string, unknown>;
}

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

export function resolvePackGptReviewTimeoutSeconds(): number {
  return Math.max(
    resolveReviewerBudgetDecision().runnerTimeoutSeconds,
    packReviewRunStaleMinutes() * 60,
  );
}

export function packGptReviewUsage(): string {
  return [
    'Canonical Browser-GPT pack review (Issue #1111)',
    '',
    'Usage:',
    '  npm run --silent pack-gpt-review -- [--project <id>] [--session-id <id>] --pr-number <n> [--timeout-seconds <n>]',
    '  or select the card with OPK_PROJECT_ID for this invocation.',
    '',
    'The command resolves the selected project card and live OPEN PR head, binds GPT for this invocation,',
    'stays foregrounded until the existing pack-review runner returns, and leaves',
    'GitHub publication to that runner. It does not accept a caller-supplied head SHA.',
  ].join('\n');
}

export function parsePackGptReviewArgs(argv: readonly string[]): PackGptReviewOptions {
  let prNumber: number | undefined;
  let projectId: string | undefined;
  let sessionId: string | undefined;
  let timeoutSeconds: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    switch (flag) {
      case '--project':
        projectId = trim(argv[++index]);
        if (!projectId) throw new Error('--project requires a value');
        break;
      case '--session-id':
        sessionId = trim(argv[++index]);
        if (!sessionId) throw new Error('--session-id requires a value');
        break;
      case '--pr-number':
        prNumber = positiveInteger(argv[++index], '--pr-number');
        break;
      case '--timeout-seconds':
        timeoutSeconds = positiveInteger(argv[++index], '--timeout-seconds');
        break;
      default:
        throw new Error(`unknown argument '${flag}'\n${packGptReviewUsage()}`);
    }
  }

  if (!prNumber) {
    throw new Error(`--pr-number is required\n${packGptReviewUsage()}`);
  }
  return {
    prNumber,
    ...(projectId ? { projectId } : {}),
    ...(sessionId ? { sessionId } : {}),
    timeoutSeconds,
  };
}

export async function runPackGptReviewCommand(
  options: PackGptReviewOptions,
  dependencies: PackGptReviewDependencies = {},
): Promise<PackGptReviewExecution> {
  const env = dependencies.env ?? process.env;
  const stderr = dependencies.stderr ?? process.stderr;
  const startReview = dependencies.startReview ?? startPackReview;
  const previousBoundReviewer = env[PACK_REVIEW_BOUND_REVIEWER_ENV];
  env[PACK_REVIEW_BOUND_REVIEWER_ENV] = 'gpt';

  try {
    const target = dependencies.startReview && !options.projectId && !trim(env.OPK_PROJECT_ID)
      ? undefined
      : resolveTargetContext({ projectId: options.projectId, env });
    const result = await startReview({
      prNumber: positiveInteger(options.prNumber, 'prNumber'),
      ...(target ? { projectId: target.projectId, sourceRepoRoot: target.primaryRoot } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      timeoutSeconds: options.timeoutSeconds ?? resolvePackGptReviewTimeoutSeconds(),
      startReason: 'manual-browser-gpt',
      surface: 'pack-gpt-review',
      onRunStarted: ({ prNumber, headSha, runId, timeoutSeconds }) => {
        stderr.write(`[pack-gpt-review] started pr=${prNumber} head=${headSha} run=${runId} timeout_seconds=${timeoutSeconds}\n`);
      },
    });

    if (result.created !== true) {
      // Non-created success is legitimate only for the runner's fresh,
      // same-invocation status projection with post-await current-head proof.
      // A generic terminal-run reuse has not established that status.
      if (result.ok === true && result.reused === true && result.statusPublished === true
          && result.publicationHeadSha === result.headSha
          && (result.reason === 'review_stage_complete' || result.reason === 'terminal_run_exists')) {
        return { exitCode: 0, result };
      }
      return {
        exitCode: 1,
        result: {
          ...result,
          ok: false,
          created: false,
          reused: Boolean(result.reused),
          outcome: 'review_not_started',
          reason: 'review_not_started',
          runnerReason: trim(result.reason) || 'unknown_runner_reason',
          prNumber: Number(result.prNumber) > 0 ? Number(result.prNumber) : options.prNumber,
          ...(trim(result.headSha) ? { headSha: trim(result.headSha) } : {}),
          ...(trim(result.runId) ? { runId: trim(result.runId) } : {}),
          ...(trim(result.status) ? { status: trim(result.status) } : {}),
        },
      };
    }

    return {
      exitCode: result.ok === true ? 0 : 1,
      result,
    };
  } catch (error) {
    return {
      exitCode: 1,
      result: {
        ok: false,
        created: false,
        reused: false,
        outcome: 'review_target_unavailable',
        reason: describeError(error),
        prNumber: options.prNumber,
      },
    };
  } finally {
    if (previousBoundReviewer === undefined) {
      delete env[PACK_REVIEW_BOUND_REVIEWER_ENV];
    } else {
      env[PACK_REVIEW_BOUND_REVIEWER_ENV] = previousBoundReviewer;
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${packGptReviewUsage()}\n`);
    return;
  }
  const options = parsePackGptReviewArgs(argv);
  const execution = await runPackGptReviewCommand(options);
  process.stdout.write(`${JSON.stringify(execution.result)}\n`);
  process.exitCode = execution.exitCode;
}

const direct = process.argv[1]
  ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  : false;

if (direct) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  }
}
