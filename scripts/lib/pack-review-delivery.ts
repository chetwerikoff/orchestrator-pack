import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runProcess } from '../kernel/subprocess.js';
import {
  getPackReviewRun,
  setPackReviewRunTerminal,
  updatePackReviewRun,
  type PackReviewDeliveryChannel,
  type PackReviewDeliveryOutcome,
  type PackReviewJournalOutcome,
  type PackReviewRunRecord,
  type PackReviewRunStatus,
  type PackReviewStoreOptions,
} from './pack-review-run-store.js';

export const PACK_REVIEW_REQUIRED_STATUS_CONTEXT = 'orchestrator-pack/pack-review';
const JOURNAL_WRITE_ATTEMPTS = 3;
const JOURNAL_RETRY_DELAY_MS = 25;

export interface PackReviewTerminalPayload {
  verdict: 'clean' | 'findings';
  findingCount: number;
  findings: unknown[];
}

export type PackReviewRequiredStatusState = 'success' | 'failure' | 'error' | 'pending';

export interface PackReviewRequiredStatusRequest {
  state: PackReviewRequiredStatusState;
  context: string;
  description: string;
  idempotencyKey: string;
}

export type PackReviewRequiredStatusWriter = (
  request: PackReviewRequiredStatusRequest,
) => Promise<void>;

export interface PackReviewWorkerNotificationResult {
  state: 'delivered' | 'failed' | 'escalated';
  reason: string;
}

export interface PackReviewWorkerNotificationRequest {
  message: string;
  idempotencyKey: string;
}

export type PackReviewWorkerNotifier = (
  request: PackReviewWorkerNotificationRequest,
) => Promise<PackReviewWorkerNotificationResult>;

export type PackReviewJournalWriter = (
  runId: string,
  fields: Partial<PackReviewRunRecord>,
  options: PackReviewStoreOptions,
) => PackReviewRunRecord | Promise<PackReviewRunRecord>;

export interface PackReviewGithubCommentResult {
  id: number | string;
  url: string;
  event: 'COMMENT';
}

interface PackReviewVerdictClassification {
  terminalStatus: Extract<PackReviewRunStatus, 'up_to_date' | 'commented' | 'changes_requested'>;
  requiredStatus: Extract<PackReviewRequiredStatusState, 'success' | 'failure'>;
  description: string;
  blocking: boolean;
}

interface DeliverPackReviewVerdictOptions extends PackReviewStoreOptions {
  run: PackReviewRunRecord;
  payload: PackReviewTerminalPayload;
  postGithubComment: () => Promise<PackReviewGithubCommentResult>;
  writeRequiredStatus: PackReviewRequiredStatusWriter;
  notifyWorker: PackReviewWorkerNotifier;
  journalWriter?: PackReviewJournalWriter;
  now?: () => Date;
}

interface RecordPendingReviewOptions extends PackReviewStoreOptions {
  run: PackReviewRunRecord;
  writeRequiredStatus: PackReviewRequiredStatusWriter;
  now?: () => Date;
}

interface RecordMalformedReviewOptions extends PackReviewStoreOptions {
  run: PackReviewRunRecord;
  failureReason: string;
  writeRequiredStatus: PackReviewRequiredStatusWriter;
  now?: () => Date;
}

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function timestamp(now?: () => Date): string {
  return (now?.() ?? new Date()).toISOString();
}

function findingSeverity(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return trim((value as Record<string, unknown>).severity).toLowerCase();
}

export function isNonBlockingPackReviewFinding(value: unknown): boolean {
  const severity = findingSeverity(value);
  return severity === 'warning' || severity === 'info' || severity === 'non-blocking';
}

export function classifyPackReviewPayload(payload: PackReviewTerminalPayload): PackReviewVerdictClassification {
  const blocking = payload.findings.length > 0
    ? payload.findings.some((finding) => !isNonBlockingPackReviewFinding(finding))
    : payload.verdict === 'findings';
  if (blocking) {
    return {
      terminalStatus: 'changes_requested',
      requiredStatus: 'failure',
      description: 'Pack review found blocking issues.',
      blocking: true,
    };
  }
  if (payload.verdict === 'clean' && payload.findingCount === 0) {
    return {
      terminalStatus: 'up_to_date',
      requiredStatus: 'success',
      description: 'Pack review completed with no findings.',
      blocking: false,
    };
  }
  return {
    terminalStatus: 'commented',
    requiredStatus: 'success',
    description: 'Pack review completed with non-blocking findings.',
    blocking: false,
  };
}

function outcome(
  state: PackReviewDeliveryOutcome['state'],
  reason: string,
  idempotencyKey: string,
  now?: () => Date,
): PackReviewDeliveryOutcome {
  return {
    state,
    recordedAtUtc: timestamp(now),
    reason: trim(reason) || state,
    idempotencyKey,
  };
}

function journalOutcome(
  state: PackReviewJournalOutcome['state'],
  reason: string,
  idempotencyKey: string,
  attempts: number,
  now?: () => Date,
): PackReviewJournalOutcome {
  return {
    state,
    recordedAtUtc: timestamp(now),
    reason: trim(reason) || state,
    idempotencyKey,
    attempts,
  };
}

function storeOptions(options: PackReviewStoreOptions): PackReviewStoreOptions {
  return { projectId: options.projectId, storeRoot: options.storeRoot };
}

function persistChannelOutcome(
  runId: string,
  channel: PackReviewDeliveryChannel,
  value: PackReviewDeliveryOutcome,
  options: PackReviewStoreOptions,
): PackReviewRunRecord | null {
  try {
    const current = getPackReviewRun(runId, storeOptions(options));
    return updatePackReviewRun(runId, {
      deliveryOutcomes: {
        ...(current?.deliveryOutcomes ?? {}),
        [channel]: value,
      },
    }, storeOptions(options));
  } catch {
    return null;
  }
}

async function journalVerdict(
  options: DeliverPackReviewVerdictOptions,
  classification: PackReviewVerdictClassification,
): Promise<{ ok: true; run: PackReviewRunRecord; outcome: PackReviewJournalOutcome } | {
  ok: false;
  outcome: PackReviewJournalOutcome;
}> {
  const idempotencyKey = `verdict:${options.run.id}:${options.run.targetSha}`;
  const writer = options.journalWriter ?? updatePackReviewRun;
  let lastError = 'journal_write_failed';
  for (let attempt = 1; attempt <= JOURNAL_WRITE_ATTEMPTS; attempt += 1) {
    const persisted = journalOutcome('persisted', 'verdict_persisted', idempotencyKey, attempt, options.now);
    try {
      const run = await writer(options.run.id, {
        status: 'reviewing',
        latestRunStatus: 'reviewing',
        reviewVerdict: options.payload.verdict,
        findingCount: options.payload.findingCount,
        findings: [...options.payload.findings],
        journalOutcome: persisted,
      }, storeOptions(options));
      return { ok: true, run, outcome: persisted };
    } catch (error) {
      lastError = describeError(error);
      if (attempt < JOURNAL_WRITE_ATTEMPTS) await delay(JOURNAL_RETRY_DELAY_MS * attempt);
    }
  }

  const failed = journalOutcome(
    'journal_write_failed',
    lastError,
    idempotencyKey,
    JOURNAL_WRITE_ATTEMPTS,
    options.now,
  );
  try {
    updatePackReviewRun(options.run.id, { journalOutcome: failed }, storeOptions(options));
  } catch {
    // The escalation is also returned to the caller if the store remains unavailable.
  }
  try {
    setPackReviewRunTerminal(options.run.id, classification.terminalStatus, {
      exitCode: 0,
      failureReason: 'journal_write_failed',
      journalOutcome: failed,
    }, storeOptions(options));
  } catch {
    // Never reclassify a successful reviewer process as failed because the journal is unavailable.
  }
  return { ok: false, outcome: failed };
}

export async function deliverPackReviewVerdict(options: DeliverPackReviewVerdictOptions): Promise<{
  ok: true;
  reason: 'completed' | 'completed_with_delivery_failures' | 'journal_write_failed';
  status: Extract<PackReviewRunStatus, 'up_to_date' | 'commented' | 'changes_requested'>;
  run: PackReviewRunRecord | null;
  journalOutcome: PackReviewJournalOutcome;
  githubReviewId?: number | string;
  githubReviewUrl?: string;
}> {
  const classification = classifyPackReviewPayload(options.payload);
  const journal = await journalVerdict(options, classification);
  if (!journal.ok) {
    return {
      ok: true,
      reason: 'journal_write_failed',
      status: classification.terminalStatus,
      run: getPackReviewRun(options.run.id, storeOptions(options)),
      journalOutcome: journal.outcome,
    };
  }

  const githubKey = `github-comment:${options.run.id}:${options.run.targetSha}`;
  const statusKey = `required-status:${PACK_REVIEW_REQUIRED_STATUS_CONTEXT}:${options.run.targetSha}`;
  const workerKey = `worker-notification:${options.run.id}:${options.run.targetSha}`;
  let githubReview: PackReviewGithubCommentResult | undefined;
  let deliveryFailed = false;

  try {
    githubReview = await options.postGithubComment();
    persistChannelOutcome(
      options.run.id,
      'githubComment',
      outcome('succeeded', 'comment_posted', githubKey, options.now),
      options,
    );
  } catch (error) {
    deliveryFailed = true;
    persistChannelOutcome(
      options.run.id,
      'githubComment',
      outcome('failed', describeError(error), githubKey, options.now),
      options,
    );
  }

  try {
    await options.writeRequiredStatus({
      state: classification.requiredStatus,
      context: PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
      description: classification.description,
      idempotencyKey: statusKey,
    });
    persistChannelOutcome(
      options.run.id,
      'requiredStatus',
      outcome('succeeded', `status_${classification.requiredStatus}`, statusKey, options.now),
      options,
    );
  } catch (error) {
    deliveryFailed = true;
    persistChannelOutcome(
      options.run.id,
      'requiredStatus',
      outcome('failed', describeError(error), statusKey, options.now),
      options,
    );
  }

  try {
    const notified = await options.notifyWorker({
      message: [
        `Pack review completed for PR #${options.run.prNumber}.`,
        `Run: ${options.run.id}`,
        `Head: ${options.run.targetSha}`,
        `Verdict: ${options.payload.verdict}`,
        `Findings: ${options.payload.findingCount}`,
        `Merge status: ${classification.requiredStatus}`,
      ].join('\n'),
      idempotencyKey: workerKey,
    });
    if (notified.state !== 'delivered') deliveryFailed = true;
    persistChannelOutcome(
      options.run.id,
      'workerNotification',
      outcome(notified.state, notified.reason, workerKey, options.now),
      options,
    );
  } catch (error) {
    deliveryFailed = true;
    persistChannelOutcome(
      options.run.id,
      'workerNotification',
      outcome('failed', describeError(error), workerKey, options.now),
      options,
    );
  }

  let terminalRun: PackReviewRunRecord | null = null;
  try {
    terminalRun = setPackReviewRunTerminal(options.run.id, classification.terminalStatus, {
      exitCode: 0,
      ...(githubReview ? {
        githubReviewId: githubReview.id,
        githubReviewUrl: githubReview.url,
        githubReviewEvent: 'COMMENT' as const,
      } : {}),
    }, storeOptions(options));
  } catch {
    terminalRun = getPackReviewRun(options.run.id, storeOptions(options));
  }

  return {
    ok: true,
    reason: deliveryFailed ? 'completed_with_delivery_failures' : 'completed',
    status: classification.terminalStatus,
    run: terminalRun,
    journalOutcome: journal.outcome,
    ...(githubReview ? { githubReviewId: githubReview.id, githubReviewUrl: githubReview.url } : {}),
  };
}

export async function recordPackReviewPendingStatus(
  options: RecordPendingReviewOptions,
): Promise<PackReviewDeliveryOutcome> {
  const idempotencyKey = `required-status:${PACK_REVIEW_REQUIRED_STATUS_CONTEXT}:${options.run.targetSha}:pending`;
  let statusOutcome: PackReviewDeliveryOutcome;
  try {
    await options.writeRequiredStatus({
      state: 'pending',
      context: PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
      description: 'Pack review is running for this exact head.',
      idempotencyKey,
    });
    statusOutcome = outcome('succeeded', 'status_pending', idempotencyKey, options.now);
  } catch (error) {
    statusOutcome = outcome('failed', describeError(error), idempotencyKey, options.now);
  }
  persistChannelOutcome(options.run.id, 'requiredStatus', statusOutcome, options);
  return statusOutcome;
}

export async function recordMalformedPackReviewStatus(options: RecordMalformedReviewOptions): Promise<{
  ok: false;
  reason: string;
  status: 'failed';
  run: PackReviewRunRecord | null;
}> {
  const idempotencyKey = `required-status:${PACK_REVIEW_REQUIRED_STATUS_CONTEXT}:${options.run.targetSha}:malformed`;
  let statusOutcome: PackReviewDeliveryOutcome;
  try {
    await options.writeRequiredStatus({
      state: 'error',
      context: PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
      description: 'Pack review produced a malformed terminal verdict.',
      idempotencyKey,
    });
    statusOutcome = outcome('succeeded', 'status_error', idempotencyKey, options.now);
  } catch (error) {
    statusOutcome = outcome('failed', describeError(error), idempotencyKey, options.now);
  }
  persistChannelOutcome(options.run.id, 'requiredStatus', statusOutcome, options);

  let run: PackReviewRunRecord | null = null;
  try {
    run = setPackReviewRunTerminal(options.run.id, 'failed', {
      exitCode: 0,
      failureReason: `reviewer_output_malformed:${trim(options.failureReason) || 'invalid_terminal_payload'}`,
    }, storeOptions(options));
  } catch {
    run = getPackReviewRun(options.run.id, storeOptions(options));
  }
  return {
    ok: false,
    reason: trim(options.failureReason) || 'reviewer produced no valid terminal verdict payload',
    status: 'failed',
    run,
  };
}

function writeCapture(path: string, payload: Record<string, unknown>): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export async function publishPackReviewRequiredStatus(options: {
  repoRoot: string;
  repoSlug: string;
  headSha: string;
  request: PackReviewRequiredStatusRequest;
}): Promise<void> {
  const capture = trim(process.env.PACK_REVIEW_REQUIRED_STATUS_CAPTURE_FILE);
  if (process.env.OPK_VITEST_HARNESS === '1') {
    if (capture) {
      writeCapture(capture, {
        repoSlug: options.repoSlug,
        headSha: options.headSha,
        ...options.request,
      });
    }
    return;
  }
  const request = `${JSON.stringify({
    state: options.request.state,
    context: options.request.context,
    description: options.request.description,
  })}\n`;
  const result = await runProcess({
    command: 'gh',
    args: ['api', '--method', 'POST', `repos/${options.repoSlug}/statuses/${options.headSha}`, '--input', '-'],
    input: request,
    cwd: options.repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: true,
    timeoutMs: 30_000,
  });
  if (!result.ok) {
    throw new Error(`GitHub required status write failed: ${trim(result.stderr || result.error || result.stdout) || result.outcome}`);
  }
}

export async function sendPackReviewWorkerNotification(options: {
  trustedPackRoot: string;
  sessionId: string;
  request: PackReviewWorkerNotificationRequest;
}): Promise<PackReviewWorkerNotificationResult> {
  const sessionId = trim(options.sessionId);
  if (!sessionId) return { state: 'escalated', reason: 'worker_session_unresolved' };
  const capture = trim(process.env.PACK_REVIEW_WORKER_NOTIFICATION_CAPTURE_FILE);
  if (process.env.OPK_VITEST_HARNESS === '1') {
    if (capture) {
      writeCapture(capture, {
        sessionId,
        message: options.request.message,
        idempotencyKey: options.request.idempotencyKey,
      });
    }
    return { state: 'delivered', reason: 'fixture_dispatched' };
  }

  const adapter = join(options.trustedPackRoot, 'scripts', 'journaled-worker-send.ps1');
  const result = await runProcess({
    command: 'pwsh',
    args: [
      '-NoProfile',
      '-File', adapter,
      sessionId,
      '-Source', 'pack-review-runner',
      '-SourceKey', options.request.idempotencyKey,
      '-NoWait',
    ],
    input: options.request.message,
    cwd: options.trustedPackRoot,
    inheritParentEnv: true,
    allowEmptyStdout: true,
    timeoutMs: 30_000,
  });
  if (result.ok) return { state: 'delivered', reason: 'adapter_dispatched' };
  const reason = trim(result.stderr || result.error || result.stdout) || result.outcome;
  return {
    state: result.timedOut || result.cancelled ? 'escalated' : 'failed',
    reason,
  };
}
