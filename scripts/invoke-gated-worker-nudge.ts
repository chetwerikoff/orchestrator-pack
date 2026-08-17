#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyIntent,
  deriveCycleKey,
} from '../docs/worker-nudge-gate.mjs';
import { sendPackReviewWorkerNotification } from './lib/pack-review-worker-notification.ts';
import type { RuntimeAdapter } from './runtime/contracts.ts';

export interface WorkerNudgeCliOptions {
  workerId: string;
  workerGeneration: string;
  prNumber: number;
  issueNumber: number;
  headSha: string;
  intentClass: string;
  source: string;
  surface: string;
  reviewRunId: string;
  transitionId: string;
  episodeKey: string;
  projectId: string;
  repoRoot: string;
  dryRun: boolean;
  json: boolean;
}

function parsePositiveInteger(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function parseWorkerNudgeArgs(argv: readonly string[]): WorkerNudgeCliOptions {
  const options: WorkerNudgeCliOptions = {
    workerId: '',
    workerGeneration: '',
    prNumber: 0,
    issueNumber: 0,
    headSha: '',
    intentClass: '',
    source: 'orchestrator-turn',
    surface: 'orchestrator-turn',
    reviewRunId: '',
    transitionId: '',
    episodeKey: '',
    projectId: 'orchestrator-pack',
    repoRoot: process.cwd(),
    dryRun: false,
    json: false,
  };
  const args = [...argv];
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case '--worker-id': options.workerId = args[++index]?.trim() ?? ''; break;
      case '--worker-generation': options.workerGeneration = args[++index]?.trim() ?? ''; break;
      case '--pr': options.prNumber = parsePositiveInteger(args[++index]); break;
      case '--issue': options.issueNumber = parsePositiveInteger(args[++index]); break;
      case '--head-sha': options.headSha = args[++index]?.trim().toLowerCase() ?? ''; break;
      case '--intent-class': options.intentClass = args[++index]?.trim() ?? ''; break;
      case '--source': options.source = args[++index]?.trim() || options.source; break;
      case '--surface': options.surface = args[++index]?.trim() || options.surface; break;
      case '--review-run-id': options.reviewRunId = args[++index]?.trim() ?? ''; break;
      case '--transition-id': options.transitionId = args[++index]?.trim() ?? ''; break;
      case '--episode-key': options.episodeKey = args[++index]?.trim() ?? ''; break;
      case '--project-id': options.projectId = args[++index]?.trim() || options.projectId; break;
      case '--repo-root': options.repoRoot = resolve(args[++index] ?? options.repoRoot); break;
      case '--dry-run': options.dryRun = true; break;
      case '--json': options.json = true; break;
      default: throw new Error(`unknown argument: ${args[index]}`);
    }
  }
  if (!options.workerId) throw new Error('--worker-id is required');
  if (!options.workerGeneration) throw new Error('--worker-generation is required');
  return options;
}

function buildClassificationInput(options: WorkerNudgeCliOptions, message: string): Record<string, unknown> {
  return {
    source: options.source,
    surface: options.surface,
    message,
    intentClass: options.intentClass,
    prNumber: options.prNumber,
    issueNumber: options.issueNumber,
    headSha: options.headSha,
    sessionId: options.workerId,
    reviewRunId: options.reviewRunId,
    transitionId: options.transitionId,
    episodeKey: options.episodeKey,
    targetId: options.workerId,
    targetGeneration: options.workerGeneration,
    projectId: options.projectId,
  };
}

export function resolveWorkerNudgeIdentity(
  options: WorkerNudgeCliOptions,
  message: string,
): { intentClass: string; cycleKey: string; idempotencyKey: string } {
  const classified = options.intentClass || classifyIntent(buildClassificationInput(options, message));
  if (!classified) throw new Error('worker_nudge_intent_unresolved');
  if (classified === 'ci-failure') {
    throw new Error('ci_failure_intent_retired_use_ci_failure_reconcile');
  }
  if (classified === 'task-continuation') {
    if (options.issueNumber <= 0) throw new Error('task_continuation_issue_required');
  } else if (options.prNumber <= 0) {
    throw new Error('pr_number_required');
  }
  const cycleKey = deriveCycleKey(classified, buildClassificationInput(options, message));
  if (!cycleKey) throw new Error('worker_nudge_cycle_key_unresolved');
  const ownerKey = classified === 'task-continuation'
    ? `${options.projectId}|issue:${options.issueNumber}`
    : `${options.projectId}|pr:${options.prNumber}|head:${options.headSha || 'unbound'}`;
  return {
    intentClass: classified,
    cycleKey,
    idempotencyKey: `${ownerKey}|${cycleKey}|${classified}|worker:${options.workerId}:${options.workerGeneration}`,
  };
}

export async function runGatedWorkerNudge(input: {
  options: WorkerNudgeCliOptions;
  message: string;
  adapter?: RuntimeAdapter;
  journalPath?: string;
  claimNamespace?: string;
  sideEffectFencePath?: string;
}): Promise<{ sent: boolean; reason: string; intentClass: string; cycleKey: string }> {
  if (!input.message.trim()) throw new Error('worker_nudge_message_empty');
  const identity = resolveWorkerNudgeIdentity(input.options, input.message);
  if (input.options.dryRun) {
    return { sent: false, reason: 'dry_run', ...identity };
  }
  const submitted = await sendPackReviewWorkerNotification({
    trustedPackRoot: input.options.repoRoot,
    repoRoot: input.options.repoRoot,
    workerId: input.options.workerId,
    expectedWorkerGeneration: input.options.workerGeneration,
    projectId: input.options.projectId,
    prNumber: input.options.prNumber,
    issueNumber: input.options.issueNumber,
    headSha: input.options.headSha,
    intentClass: identity.intentClass,
    cycleKey: identity.cycleKey,
    surface: input.options.surface,
    request: {
      message: input.message,
      idempotencyKey: identity.idempotencyKey,
      reviewRunId: input.options.reviewRunId || undefined,
    },
    adapter: input.adapter,
    journalPath: input.journalPath,
    claimNamespace: input.claimNamespace,
    sideEffectFencePath: input.sideEffectFencePath,
  });
  return {
    sent: submitted.state === 'submitted',
    reason: submitted.reason,
    intentClass: identity.intentClass,
    cycleKey: identity.cycleKey,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseWorkerNudgeArgs(argv);
  const message = readFileSync(0, 'utf8');
  const result = await runGatedWorkerNudge({ options, message });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.sent || result.reason === 'dry_run' ? 0 : 1;
}

const direct = import.meta.url === new URL(process.argv[1] ?? '', 'file:').href;
if (direct) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`invoke-gated-worker-nudge: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
