#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveReviewerBudgetDecision } from '../plugins/codex-pr-reviewer/lib/reviewer_budget.ts';
import { resolveTargetContext } from './lib/target-context.ts';
import { startPackReview } from './pack-review-runner.ts';
import { packReviewRunStaleMinutes } from './lib/pack-review-run-store.ts';
import { normalizePackReviewer, type PackReviewer } from './lib/resolve-pack-reviewer.ts';

type StartReview = (input: Parameters<typeof startPackReview>[0]) => ReturnType<typeof startPackReview>;

type TextWriter = {
  write: (chunk: string) => unknown;
};

export interface PackGptReviewOptions {
  prNumber: number;
  projectId?: string;
  sessionId?: string;
  timeoutSeconds?: number;
  reviewer?: PackReviewer;
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
    'Canonical pack review (historical command name; reviewer is configurable)',
    '',
    'Usage:',
    '  npm run --silent pack-gpt-review -- [--project <id>] [--session-id <id>] --pr-number <n> [--reviewer <gpt|claude|codex>] [--timeout-seconds <n>]',
    '  or select the card with OPK_PROJECT_ID for this invocation.',
    '',
    'The command resolves the selected project card and live OPEN PR head. Reviewer priority:',
    'explicit --reviewer > explicit PACK_REVIEW_BOUND_REVIEWER > saved preference > PACK_REVIEWER.',
    'The route name does not select GPT. It stays foregrounded until the runner returns,',
    'and leaves GitHub publication to that runner. It does not accept a caller-supplied head SHA.',
  ].join('\n');
}

export function parsePackGptReviewArgs(argv: readonly string[]): PackGptReviewOptions {
  let prNumber: number | undefined;
  let projectId: string | undefined;
  let sessionId: string | undefined;
  let timeoutSeconds: number | undefined;
  let reviewer: PackReviewer | undefined;
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
      case '--reviewer': {
        const value = argv[++index];
        reviewer = value && !value.startsWith('--') ? normalizePackReviewer(value) ?? undefined : undefined;
        if (!reviewer) throw new Error('--reviewer requires gpt, claude, or codex');
        break;
      }
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
    ...(reviewer ? { reviewer } : {}),
  };
}

function reviewNextStep(result: Record<string, unknown>, prNumber: number): string {
  const supplied = trim(result.nextAction);
  if (supplied) return supplied;
  const reason = trim(result.publicationReason) || trim(result.runnerReason) || trim(result.reason);
  if (reason === 'required_ci_not_green_for_current_head') {
    return `inspect the exact current PR #${prNumber} required CI, then retry the PR-led review only after green checks`;
  }
  if (trim(result.status) === 'reviewing' || Number(result.httpStatus) === 202) {
    return `observe the existing review run on PR #${prNumber}; use scoped reconcile for uncertain sources, never send another possible_delivery attempt`;
  }
  if (reason.includes('journal_write_failed')) {
    return `inspect the persisted run journal for PR #${prNumber} and use its incumbent journal/resume recovery; do not treat the verdict as published`;
  }
  if (reason.includes('review_comment_not_published')) {
    return `observe the existing PR #${prNumber} reviewer COMMENT and use incumbent comment reconciliation/resume; do not blindly duplicate a possibly accepted post`;
  }
  if (reason.includes('status_not_published') || reason.includes('status_unverified')) {
    return `read the current PR #${prNumber} head and required status, then use the incumbent PR-led projection or scoped reconcile when authorized`;
  }
  if (reason.includes('harvest') || reason.includes('parse_error') || reason.includes('no_judgment')) {
    return `inspect the existing GPT source evidence for PR #${prNumber} and run scoped reconcile; retry only affirmatively eligible same-run slots`;
  }
  return `inspect PR #${prNumber} and its current review run; apply the incumbent scoped reconcile or correct the reported input before retrying`;
}

export async function runPackGptReviewCommand(
  options: PackGptReviewOptions,
  dependencies: PackGptReviewDependencies = {},
): Promise<PackGptReviewExecution> {
  const env = dependencies.env ?? process.env;
  const stderr = dependencies.stderr ?? process.stderr;
  const startReview = dependencies.startReview ?? startPackReview;

  try {
    const reviewer = options.reviewer === undefined
      ? undefined : normalizePackReviewer(options.reviewer);
    if (options.reviewer !== undefined && !reviewer) {
      throw new Error('--reviewer requires gpt, claude, or codex');
    }
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
      ...(reviewer ? { reviewerOverride: reviewer } : {}),
      onRunStarted: ({ prNumber, headSha, runId, timeoutSeconds }) => {
        stderr.write(`[pack-gpt-review] started pr=${prNumber} head=${headSha} run=${runId} timeout_seconds=${timeoutSeconds}\n`);
      },
    });

    // 'ok' can mean accepted/in progress, journal failure, or only part of
    // the three required delivery channels. It does not mean a settled review.
    const currentHeadPublication = result.publicationVerified === true
      && trim(result.publicationHeadSha) === trim(result.headSha)
      && Boolean(trim(result.headSha));
    const deliveredRound = result.created === true
      && currentHeadPublication
      && result.reason !== 'completed_with_delivery_failures'
      && result.reason !== 'journal_write_failed';
    const recoveredRound = result.created === false && result.reused === true
      && result.reason === 'resumed_journaled_delivery' && currentHeadPublication;
    const stageCompleteReuse = result.created === false && result.reused === true
      && result.statusPublished === true && currentHeadPublication
      && (result.reason === 'review_stage_complete' || result.reason === 'terminal_run_exists');
    // The route name does not select GPT. Native reviewer delivery retains its
    // incumbent acknowledgement contract; only GPT uses exact-head observation.
    const nativeDeliveredRound = (result.resolvedReviewer === 'claude' || result.resolvedReviewer === 'codex')
      && result.created === true && result.reused === false
      && result.reason === 'completed' && result.httpStatus === 201
      && result.publicationVerified === undefined
      && (result.status === 'up_to_date' || result.status === 'commented' || result.status === 'changes_requested');
    if (result.ok === true && (deliveredRound || recoveredRound || stageCompleteReuse || nativeDeliveredRound)) {
      return { exitCode: 0, result };
    }

    const prNumber = Number.isSafeInteger(result.prNumber) && Number(result.prNumber) > 0
      ? Number(result.prNumber) : options.prNumber;
    const runnerReason = trim(result.reason) || 'unknown_runner_reason';
    const publicationReason = trim(result.publicationReason);
    return {
      exitCode: 1,
      result: {
        ...result,
        ok: false,
        created: result.created === true,
        reused: Boolean(result.reused),
        outcome: result.created === true ? 'review_not_settled' : 'review_not_started',
        reason: result.created === true ? (publicationReason || runnerReason) : 'review_not_started',
        runnerReason,
        prNumber,
        ...(trim(result.headSha) ? { headSha: trim(result.headSha) } : {}),
        ...(trim(result.runId) ? { runId: trim(result.runId) } : {}),
        ...(trim(result.status) ? { status: trim(result.status) } : {}),
        nextAction: reviewNextStep(result, prNumber),
      },
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
        runnerReason: describeError(error),
        prNumber: options.prNumber,
        nextAction: `verify the arguments and selected PR #${options.prNumber}; if the remote target is unavailable, restore GitHub and inspect that PR before retrying`,
      },
    };
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
