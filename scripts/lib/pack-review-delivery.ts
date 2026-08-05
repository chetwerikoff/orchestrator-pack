import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../kernel/subprocess.ts';
import {
  GithubReviewPostError,
  GithubReviewTransport,
  GitHubCliReviewTransport,
  reconcileGithubReviewPublication,
  type GithubReviewEvent,
} from './github-review-reconciliation.js';
import {
  acquireReviewStartClaim,
  completeReviewStartClaim,
  failReviewStartClaim,
  readReviewStartClaim,
  type ReviewStartClaimContext,
} from './review-start-claim-store.js';
import {
  getPackReviewRun,
  updatePackReviewRun,
  type PackReviewDeliveryOutcome,
  type PackReviewRunRecord,
} from './pack-review-run-store.js';
import type { RuntimeAdapter } from '../runtime/contracts.ts';

function trim(value: string): string {
  return value.trim();
}

function normalizeRepo(value: string): string {
  return trim(value).toLowerCase();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deliveryOutcome(input: {
  state: PackReviewDeliveryOutcome['state'];
  reason: string;
  idempotencyKey: string;
  attempts?: number;
  detail?: string;
}): PackReviewDeliveryOutcome {
  return {
    state: input.state,
    recordedAtUtc: new Date().toISOString(),
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  };
}

export interface PackReviewWorkerNotificationRequest {
  readonly workerId: string;
  readonly expectedWorkerGeneration?: string;
  readonly prNumber: number;
  readonly projectId: string;
  readonly trustedPackRoot: string;
  readonly request: {
    readonly message: string;
    readonly idempotencyKey: string;
  };
  readonly journalPath: string;
  readonly claimNamespace: string;
  readonly sideEffectFencePath: string;
  readonly adapter?: RuntimeAdapter;
}

export interface PackReviewRequiredStatusRequest {
  readonly state: 'pending' | 'success' | 'failure' | 'error';
  readonly context: string;
  readonly description: string;
}

export interface ResumePackReviewDeliveryOptions {
  readonly projectId: string;
  readonly storeRoot: string;
  readonly runId: string;
  readonly trustedPackRoot: string;
  readonly sourceRepoRoot: string;
  readonly canonicalRepository: string;
  readonly githubReviewTransport?: GithubReviewTransport;
  readonly writeRequiredStatus?: (request: PackReviewRequiredStatusRequest) => Promise<void>;
  readonly notifyWorker?: (request: PackReviewWorkerNotificationRequest) => Promise<{
    readonly state: 'delivered' | 'failed' | 'escalated';
    readonly reason: string;
  }>;
}

function deliveryTerminal(outcome: PackReviewDeliveryOutcome | undefined): boolean {
  return outcome?.state === 'succeeded'
    || outcome?.state === 'failed'
    || outcome?.state === 'escalated';
}

function journalTerminal(run: PackReviewRunRecord): boolean {
  return run.journalOutcome?.state === 'persisted';
}

function githubPublicationTerminal(run: PackReviewRunRecord): boolean {
  return run.githubReviewReconciliation?.phase === 'complete'
    && deliveryTerminal(run.deliveryOutcomes?.githubComment);
}

export function packReviewDeliveryNeedsResume(run: PackReviewRunRecord): boolean {
  if (!journalTerminal(run)) return false;
  if (!githubPublicationTerminal(run)) return true;
  if (!deliveryTerminal(run.deliveryOutcomes?.requiredStatus)) return true;
  if (run.linkedSessionId && !deliveryTerminal(run.deliveryOutcomes?.workerNotification)) return true;
  return false;
}

function boundRun(run: PackReviewRunRecord, options: ResumePackReviewDeliveryOptions): void {
  if (run.projectId !== options.projectId) throw new Error('pack_review_delivery_project_mismatch');
  if (normalizeRepo(run.canonicalRepository) !== normalizeRepo(options.canonicalRepository)) {
    throw new Error('pack_review_delivery_repository_mismatch');
  }
  if (path.resolve(run.trustedPackRoot) !== path.resolve(options.trustedPackRoot)) {
    throw new Error('pack_review_delivery_pack_root_mismatch');
  }
  if (path.resolve(run.sourceRepoRoot) !== path.resolve(options.sourceRepoRoot)) {
    throw new Error('pack_review_delivery_source_root_mismatch');
  }
}

function requiredStatusForRun(run: PackReviewRunRecord): PackReviewRequiredStatusRequest {
  if (run.status === 'approved') {
    return {
      state: 'success',
      context: 'orchestrator-pack/pack-review',
      description: 'Pack review approved',
    };
  }
  return {
    state: 'failure',
    context: 'orchestrator-pack/pack-review',
    description: 'Pack review requested changes',
  };
}

function reviewEventForRun(run: PackReviewRunRecord): GithubReviewEvent {
  return run.status === 'approved' ? 'APPROVE' : 'REQUEST_CHANGES';
}

function reviewBodyForRun(run: PackReviewRunRecord): string {
  const marker = `<!-- orchestrator-pack-review:${run.id}:${run.headSha} -->`;
  const verdict = run.status === 'approved' ? 'APPROVE' : 'REQUEST_CHANGES';
  const details = run.findings?.length
    ? run.findings.map((finding) => `- ${JSON.stringify(finding)}`).join('\n')
    : '- No findings.';
  return `${marker}\n## Pack review: ${verdict}\n\n${details}`;
}

function githubReviewIdempotencyKey(run: PackReviewRunRecord): string {
  return `github-comment:${run.id}:${run.headSha}`;
}

function requiredStatusIdempotencyKey(run: PackReviewRunRecord): string {
  return `required-status:${run.canonicalRepository}/pack-review:${run.headSha}`;
}

function workerNotificationIdempotencyKey(run: PackReviewRunRecord): string {
  return `worker-notification:${run.id}:${run.headSha}`;
}

function reviewFingerprint(run: PackReviewRunRecord): string {
  return sha256(canonicalJson({
    runId: run.id,
    repository: normalizeRepo(run.canonicalRepository),
    prNumber: run.prNumber,
    headSha: run.headSha,
    event: reviewEventForRun(run),
    body: reviewBodyForRun(run),
  }));
}

function claimContext(run: PackReviewRunRecord): ReviewStartClaimContext {
  return {
    projectId: run.projectId,
    canonicalRepository: run.canonicalRepository,
    prNumber: run.prNumber,
    headSha: run.headSha,
  };
}

async function ensureGithubReview(
  run: PackReviewRunRecord,
  options: ResumePackReviewDeliveryOptions,
): Promise<PackReviewRunRecord> {
  if (githubPublicationTerminal(run)) return run;
  const idempotencyKey = githubReviewIdempotencyKey(run);
  const transport = options.githubReviewTransport
    ?? new GitHubCliReviewTransport({ cwd: options.sourceRepoRoot });
  const event = reviewEventForRun(run);
  const body = reviewBodyForRun(run);
  const fingerprint = reviewFingerprint(run);

  const current = getPackReviewRun(run.id, {
    projectId: options.projectId,
    storeRoot: options.storeRoot,
  }) ?? run;
  if (githubPublicationTerminal(current)) return current;

  try {
    const reconciliation = await reconcileGithubReviewPublication({
      transport,
      canonicalRepository: run.canonicalRepository,
      prNumber: run.prNumber,
      headSha: run.headSha,
      event,
      body,
      idempotencyKey,
      fingerprint,
      prior: current.githubReviewReconciliation,
    });
    return updatePackReviewRun(run.id, {
      githubReviewId: reconciliation.reviewId,
      githubReviewReconciliation: reconciliation,
      deliveryOutcomes: {
        ...(current.deliveryOutcomes ?? {}),
        githubComment: deliveryOutcome({
          state: 'succeeded',
          reason: reconciliation.reason,
          idempotencyKey,
          attempts: reconciliation.attempts,
          detail: reconciliation.reviewUrl,
        }),
      },
    }, { projectId: options.projectId, storeRoot: options.storeRoot });
  } catch (error) {
    const reason = error instanceof GithubReviewPostError
      ? error.kind
      : 'github_review_publication_failed';
    const detail = error instanceof Error ? error.message : String(error);
    return updatePackReviewRun(run.id, {
      deliveryOutcomes: {
        ...(current.deliveryOutcomes ?? {}),
        githubComment: deliveryOutcome({
          state: 'failed',
          reason,
          idempotencyKey,
          detail,
        }),
      },
    }, { projectId: options.projectId, storeRoot: options.storeRoot });
  }
}

async function ensureRequiredStatus(
  run: PackReviewRunRecord,
  options: ResumePackReviewDeliveryOptions,
): Promise<PackReviewRunRecord> {
  if (deliveryTerminal(run.deliveryOutcomes?.requiredStatus)) return run;
  const idempotencyKey = requiredStatusIdempotencyKey(run);
  try {
    await writeRequiredStatus({
      repoRoot: options.sourceRepoRoot,
      repoSlug: run.canonicalRepository,
      headSha: run.headSha,
      request: requiredStatusForRun(run),
      writer: options.writeRequiredStatus,
    });
    return updatePackReviewRun(run.id, {
      deliveryOutcomes: {
        ...(run.deliveryOutcomes ?? {}),
        requiredStatus: deliveryOutcome({
          state: 'succeeded',
          reason: 'required_status_written',
          idempotencyKey,
        }),
      },
    }, { projectId: options.projectId, storeRoot: options.storeRoot });
  } catch (error) {
    return updatePackReviewRun(run.id, {
      deliveryOutcomes: {
        ...(run.deliveryOutcomes ?? {}),
        requiredStatus: deliveryOutcome({
          state: 'failed',
          reason: 'required_status_write_failed',
          idempotencyKey,
          detail: error instanceof Error ? error.message : String(error),
        }),
      },
    }, { projectId: options.projectId, storeRoot: options.storeRoot });
  }
}

async function ensureWorkerNotification(
  run: PackReviewRunRecord,
  options: ResumePackReviewDeliveryOptions,
): Promise<PackReviewRunRecord> {
  if (!run.linkedSessionId || deliveryTerminal(run.deliveryOutcomes?.workerNotification)) return run;
  const idempotencyKey = workerNotificationIdempotencyKey(run);
  const request: PackReviewWorkerNotificationRequest = {
    trustedPackRoot: options.trustedPackRoot,
    workerId: run.linkedSessionId,
    expectedWorkerGeneration: run.linkedSessionGeneration,
    prNumber: run.prNumber,
    projectId: run.projectId,
    journalPath: path.join(options.storeRoot, 'worker-notification-journal.json'),
    claimNamespace: path.join(options.storeRoot, 'worker-notification-claims'),
    sideEffectFencePath: path.join(options.storeRoot, 'worker-notification.lock'),
    request: {
      message: run.status === 'approved'
        ? `Pack review approved PR #${run.prNumber} at ${run.headSha}.`
        : `Pack review found changes for PR #${run.prNumber} at ${run.headSha}.`,
      idempotencyKey,
    },
  };
  try {
    const notifier = options.notifyWorker ?? sendPackReviewWorkerNotification;
    const result = await notifier(request);
    const state: PackReviewDeliveryOutcome['state'] = result.state === 'delivered'
      ? 'succeeded'
      : result.state;
    return updatePackReviewRun(run.id, {
      deliveryOutcomes: {
        ...(run.deliveryOutcomes ?? {}),
        workerNotification: deliveryOutcome({
          state,
          reason: result.reason,
          idempotencyKey,
        }),
      },
    }, { projectId: options.projectId, storeRoot: options.storeRoot });
  } catch (error) {
    return updatePackReviewRun(run.id, {
      deliveryOutcomes: {
        ...(run.deliveryOutcomes ?? {}),
        workerNotification: deliveryOutcome({
          state: 'failed',
          reason: 'worker_notification_failed',
          idempotencyKey,
          detail: error instanceof Error ? error.message : String(error),
        }),
      },
    }, { projectId: options.projectId, storeRoot: options.storeRoot });
  }
}

export async function resumePackReviewVerdictDelivery(
  options: ResumePackReviewDeliveryOptions,
): Promise<PackReviewRunRecord> {
  let run = getPackReviewRun(options.runId, {
    projectId: options.projectId,
    storeRoot: options.storeRoot,
  });
  if (!run) throw new Error('pack_review_delivery_run_missing');
  boundRun(run, options);
  if (!journalTerminal(run)) throw new Error('pack_review_delivery_journal_missing');

  run = await ensureGithubReview(run, options);
  run = await ensureRequiredStatus(run, options);
  run = await ensureWorkerNotification(run, options);

  if (packReviewDeliveryNeedsResume(run)) {
    return updatePackReviewRun(run.id, {
      latestRunStatus: 'delivery_failed',
    }, { projectId: options.projectId, storeRoot: options.storeRoot });
  }
  return updatePackReviewRun(run.id, {
    latestRunStatus: run.status,
  }, { projectId: options.projectId, storeRoot: options.storeRoot });
}

export async function deliverPackReviewVerdict(input: {
  readonly projectId: string;
  readonly storeRoot: string;
  readonly runId: string;
  readonly trustedPackRoot: string;
  readonly sourceRepoRoot: string;
  readonly canonicalRepository: string;
  readonly claimNamespace?: string;
  readonly surface?: string;
  readonly githubReviewTransport?: GithubReviewTransport;
  readonly writeRequiredStatus?: (request: PackReviewRequiredStatusRequest) => Promise<void>;
  readonly notifyWorker?: ResumePackReviewDeliveryOptions['notifyWorker'];
}): Promise<PackReviewRunRecord> {
  const run = getPackReviewRun(input.runId, {
    projectId: input.projectId,
    storeRoot: input.storeRoot,
  });
  if (!run) throw new Error('pack_review_delivery_run_missing');
  boundRun(run, input);
  if (!journalTerminal(run)) throw new Error('pack_review_delivery_journal_missing');

  const claimNamespace = input.claimNamespace ?? path.join(input.storeRoot, 'review-start-claims');
  const context = claimContext(run);
  const existing = readReviewStartClaim(claimNamespace, context);
  let claim = existing;
  if (!claim) {
    claim = acquireReviewStartClaim({
      namespace: claimNamespace,
      context,
      surface: input.surface ?? 'pack-review-delivery',
      reviewId: run.id,
    });
  }
  if (!claim.acquired) {
    throw new Error(`pack_review_delivery_claim_denied:${claim.reason}`);
  }

  try {
    const delivered = await resumePackReviewVerdictDelivery(input);
    completeReviewStartClaim(claim.handle, {
      status: delivered.status,
      reviewId: delivered.id,
      githubReviewId: delivered.githubReviewId,
    });
    return delivered;
  } catch (error) {
    failReviewStartClaim(claim.handle, {
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function writeRequiredStatus(options: {
  repoRoot: string;
  repoSlug: string;
  headSha: string;
  request: PackReviewRequiredStatusRequest;
  writer?: (request: PackReviewRequiredStatusRequest) => Promise<void>;
}): Promise<void> {
  if (options.writer) {
    await options.writer({
      ...options.request,
    });
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

export { sendPackReviewWorkerNotification } from './pack-review-worker-notification.ts';
