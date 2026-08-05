import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  buildDeterministicDeliveryId,
  evaluateDeterministicJournalAdmission,
} from '../../docs/review-delivery-lifecycle.mjs';
import type {
  PackReviewWorkerNotificationRequest,
  PackReviewWorkerNotificationResult,
} from './pack-review-delivery.ts';
import { getPackReviewRun } from './pack-review-run-store.ts';
import { runProcess } from '../kernel/subprocess.ts';
import { selectRuntimeAdapter } from '../runtime/registry.ts';
import type { RuntimeAdapter, RuntimeWorker } from '../runtime/contracts.ts';
import { withSideEffectFence } from '../runtime/side-effect-fence.ts';
import { withJournalLock } from '../pr2-foundation/journal-lock.ts';
import {
  admitDispatchJournalRecord,
  deriveMessageShape,
  DISPATCH_OUTCOME_DISPATCHED,
  DISPATCH_OUTCOME_IN_FLIGHT,
  DISPATCH_OUTCOME_SEND_FAILED,
  DISPATCH_OUTCOME_UNKNOWN,
  DRAFT_STATE_DRAFT_PRESENT,
  finalizeDispatchJournalRecord,
  type DispatchJournalRecord,
} from '../pr2-foundation/worker-dispatch-journal.ts';
import {
  acquireWorkerNudgeClaim,
  finalizeWorkerNudgeClaim,
  markWorkerNudgeSendAttempted,
  type WorkerNudgeClaimHandle,
} from '../pr2-foundation/worker-nudge-claim-store.ts';
import {
  resolveWakeSupervisorStateRoot,
  resolveWorkerMessageDispatchJournalPath,
} from '../pr2-foundation/wake-supervisor-state-root.ts';

export interface WorkerNotificationOptions {
  trustedPackRoot: string;
  workerId?: string;
  /** Transitional parameter name at old call sites; interpreted only as a runtime worker id. */
  sessionId?: string;
  expectedWorkerGeneration?: string;
  request: PackReviewWorkerNotificationRequest;
  repoRoot?: string;
  projectId?: string;
  storeRoot?: string;
  prNumber?: number;
  issueNumber?: number;
  headSha?: string;
  intentClass?: string;
  cycleKey?: string;
  surface?: string;
  adapter?: RuntimeAdapter;
  journalPath?: string;
  claimNamespace?: string;
  sideEffectFencePath?: string;
}

interface JournalAdmission {
  duplicate: boolean;
  deliveryId: string;
  journalPath: string;
}

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function readJournal(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('journal_untrusted');
  return parsed as Record<string, unknown>;
}

function writeJournal(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function hashed(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

async function currentHead(workspacePath: string): Promise<string> {
  const result = await runProcess({
    command: 'git',
    args: ['-C', workspacePath, 'rev-parse', 'HEAD'],
    cwd: workspacePath,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  if (!result.ok) throw new Error('worker_workspace_head_unresolved');
  return result.stdout.trim().toLowerCase();
}

async function resolveWorker(input: {
  adapter: RuntimeAdapter;
  workerId: string;
  expectedGeneration: string;
  expectedHeadSha: string;
}): Promise<RuntimeWorker> {
  const found = input.adapter.findWorkerById(input.workerId);
  if (found.status !== 'ok') throw new Error(`${found.operation}:${found.reason}`);
  if (!found.value) throw new Error('worker_not_found');
  if (input.expectedGeneration && found.value.identity.generation !== input.expectedGeneration) {
    throw new Error('worker_generation_mismatch');
  }
  if (input.expectedHeadSha) {
    const observed = await currentHead(found.value.workspacePath);
    if (observed !== input.expectedHeadSha) throw new Error('worker_head_mismatch');
  }
  return found.value;
}

async function admitNotification(input: {
  worker: RuntimeWorker;
  request: PackReviewWorkerNotificationRequest;
  journalPath: string;
  source: string;
}): Promise<JournalAdmission> {
  const deliveryKey = trim(input.request.idempotencyKey);
  const findingsHash = hashed(input.request.message);
  return withJournalLock(input.journalPath, 3, () => {
    const journal = readJournal(input.journalPath);
    const deterministic = evaluateDeterministicJournalAdmission(journal, {
      deterministicKey: deliveryKey,
      findingsHash,
    });
    if (deterministic.action === 'no_op_terminal') {
      return {
        duplicate: true,
        deliveryId: trim(deterministic.deliveryId),
        journalPath: input.journalPath,
      };
    }
    if (!deterministic.ok || deterministic.action === 'escalate' || deterministic.action === 'escalate_supersede') {
      throw new Error(trim(deterministic.reason) || 'journal_admission_refused');
    }
    const deliveryId = trim(deterministic.deliveryId)
      || buildDeterministicDeliveryId(input.worker.identity.id, deliveryKey);
    if (!deliveryId) throw new Error('invalid_delivery_id');
    if (deterministic.action === 'resume') {
      return { duplicate: false, deliveryId, journalPath: input.journalPath };
    }

    const shape = deriveMessageShape(input.request.message, '');
    const record: DispatchJournalRecord = {
      deliveryId,
      sessionId: input.worker.identity.id,
      targetId: input.worker.identity.id,
      targetGeneration: input.worker.identity.generation,
      runtime: input.worker.identity.runtime,
      deliveredAtMs: Date.now(),
      source: input.source,
      sourceKey: hashed(deliveryKey).slice(0, 32),
      deliveryPath: shape.deliveryPath,
      messageShape: { charLength: shape.charLength, lineCount: shape.lineCount },
      dispatchOutcome: DISPATCH_OUTCOME_IN_FLIGHT,
      draftState: DRAFT_STATE_DRAFT_PRESENT,
      deterministicKey: deliveryKey,
      findingsHash,
      reviewRunId: trim(input.request.reviewRunId),
    };
    const admitted = admitDispatchJournalRecord(journal, record, Date.now());
    if (!admitted.ok) throw new Error(admitted.reason);
    writeJournal(input.journalPath, admitted.journal);
    return { duplicate: false, deliveryId, journalPath: input.journalPath };
  });
}

async function finalizeJournal(admission: JournalAdmission, outcome: string): Promise<void> {
  await withJournalLock(admission.journalPath, 3, () => {
    const finalized = finalizeDispatchJournalRecord(
      readJournal(admission.journalPath),
      admission.deliveryId,
      outcome,
      Date.now(),
      DRAFT_STATE_DRAFT_PRESENT,
    );
    if (!finalized.ok) throw new Error(finalized.reason);
    writeJournal(admission.journalPath, finalized.journal);
  });
}

async function finalizeBoth(input: {
  admission: JournalAdmission;
  claim: WorkerNudgeClaimHandle;
  journalOutcome: string;
  claimOutcome: 'SENT' | 'FAILED_DEFINITIVE' | 'UNCERTAIN';
  extra?: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await finalizeJournal(input.admission, input.journalOutcome);
  } catch (error) {
    await finalizeWorkerNudgeClaim(input.claim, 'UNCERTAIN', {
      reason: 'dispatch_outcome_unrecorded',
      detail: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: 'dispatch_outcome_unrecorded' };
  }
  const claim = await finalizeWorkerNudgeClaim(input.claim, input.claimOutcome, input.extra);
  return claim.ok ? { ok: true } : { ok: false, reason: claim.reason ?? 'claim_finalize_failed' };
}

function fixture(options: WorkerNotificationOptions, workerId: string): PackReviewWorkerNotificationResult | null {
  if (options.adapter
    || process.env.OPK_VITEST_HARNESS !== '1'
    || process.env.PACK_REVIEW_WORKER_NOTIFICATION_REAL_ADAPTER === '1') return null;
  const capturePath = trim(process.env.PACK_REVIEW_WORKER_NOTIFICATION_CAPTURE_FILE);
  if (capturePath) {
    mkdirSync(dirname(resolve(capturePath)), { recursive: true });
    writeFileSync(resolve(capturePath), `${JSON.stringify({
      workerId,
      message: options.request.message,
      idempotencyKey: options.request.idempotencyKey,
    }, null, 2)}\n`, 'utf8');
  }
  return { state: 'delivered', reason: 'fixture_dispatched' };
}

function bindPersistedReviewRun(options: WorkerNotificationOptions):
  | { ok: true; options: WorkerNotificationOptions }
  | { ok: false; reason: string } {
  const reviewRunId = trim(options.request.reviewRunId);
  if (!reviewRunId) return { ok: true, options };

  let run;
  try {
    run = getPackReviewRun(reviewRunId, {
      projectId: trim(options.projectId) || undefined,
      storeRoot: trim(options.storeRoot) || undefined,
    });
  } catch {
    return { ok: false, reason: 'review_run_binding_unresolved' };
  }
  if (!run) {
    // Preserve the explicit low-level API for focused callers. The production
    // runner supplies only reviewRunId/sessionId and therefore cannot cross this
    // branch without the durable run binding.
    return Number.isInteger(Number(options.prNumber)) && Number(options.prNumber) > 0
      ? { ok: true, options }
      : { ok: false, reason: 'review_run_binding_unresolved' };
  }

  const explicitPrNumber = Number(options.prNumber ?? 0);
  if (explicitPrNumber > 0 && explicitPrNumber !== run.prNumber) {
    return { ok: false, reason: 'review_run_pr_mismatch' };
  }
  const explicitHeadSha = trim(options.headSha).toLowerCase();
  if (explicitHeadSha && explicitHeadSha !== run.targetSha) {
    return { ok: false, reason: 'review_run_head_mismatch' };
  }
  const workerId = trim(options.workerId || options.sessionId || run.linkedSessionId);
  if (!workerId) return { ok: false, reason: 'worker_id_unresolved' };

  return {
    ok: true,
    options: {
      ...options,
      workerId,
      sessionId: undefined,
      repoRoot: trim(options.repoRoot) || run.sourceRepoRoot,
      projectId: run.projectId,
      prNumber: run.prNumber,
      headSha: run.targetSha,
    },
  };
}

/**
 * Journal-first runtime notification. The adapter is selected once, target
 * generation is resolved before claim acquisition, and dispatch is attempted
 * exactly once. `dispatch_unknown` is persisted as UNCERTAIN and never retried.
 */
export async function sendPackReviewWorkerNotification(
  originalOptions: WorkerNotificationOptions,
): Promise<PackReviewWorkerNotificationResult> {
  const bound = bindPersistedReviewRun(originalOptions);
  if (!bound.ok) return { state: 'escalated', reason: bound.reason };
  const options = bound.options;
  const workerId = trim(options.workerId || options.sessionId);
  if (!workerId) return { state: 'escalated', reason: 'worker_id_unresolved' };
  const fixtureResult = fixture(options, workerId);
  if (fixtureResult) return fixtureResult;
  if (!trim(options.request.idempotencyKey)) {
    return { state: 'escalated', reason: 'worker_notification_delivery_key_missing' };
  }

  const stateRoot = resolveWakeSupervisorStateRoot();
  const adapter = options.adapter ?? await selectRuntimeAdapter({}, {
    cwd: resolve(options.repoRoot || options.trustedPackRoot),
  });
  let worker: RuntimeWorker;
  try {
    worker = await resolveWorker({
      adapter,
      workerId,
      expectedGeneration: trim(options.expectedWorkerGeneration),
      expectedHeadSha: trim(options.headSha).toLowerCase(),
    });
  } catch (error) {
    return { state: 'escalated', reason: error instanceof Error ? error.message : 'worker_target_unresolved' };
  }

  const projectId = trim(options.projectId) || 'orchestrator-pack';
  const prNumber = Number(options.prNumber ?? 0);
  const issueNumber = Number(options.issueNumber ?? 0);
  const intentClass = trim(options.intentClass) || 'review-findings';
  if (intentClass === 'task-continuation') {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return { state: 'escalated', reason: 'task_continuation_issue_required' };
    }
  } else if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { state: 'escalated', reason: 'pr_number_required' };
  }

  const workerTarget = `${worker.identity.runtime}:${worker.identity.id}:${worker.identity.generation}`;
  const cycleKey = trim(options.cycleKey)
    || `${intentClass}:${hashed(options.request.idempotencyKey)}`;
  const tupleKey = intentClass === 'task-continuation'
    ? `${projectId}|${issueNumber}|${cycleKey}|${intentClass}|${workerTarget}`
    : `${prNumber}|${cycleKey}|${intentClass}|${workerTarget}`;
  const claimNamespace = options.claimNamespace ?? join(stateRoot, 'worker-nudge-claims', projectId);
  const claim = await acquireWorkerNudgeClaim({
    prNumber: Number.isInteger(prNumber) && prNumber > 0 ? prNumber : 0,
    issueNumber: Number.isInteger(issueNumber) && issueNumber > 0 ? issueNumber : undefined,
    cycleKey,
    intentClass,
    workerTarget,
    sessionId: worker.identity.id,
    targetId: worker.identity.id,
    targetGeneration: worker.identity.generation,
    tupleKey,
    surface: trim(options.surface) || 'runtime-worker-notification',
    projectId,
    message: options.request.message,
    namespace: claimNamespace,
  });
  if (!claim.acquired) {
    if (claim.reason === 'already_served') return { state: 'delivered', reason: 'claim_duplicate_no_op' };
    return { state: 'escalated', reason: claim.reason };
  }

  let admission: JournalAdmission;
  try {
    admission = await admitNotification({
      worker,
      request: options.request,
      journalPath: options.journalPath ?? resolveWorkerMessageDispatchJournalPath(),
      source: `runtime-worker-notification:${intentClass}`,
    });
  } catch (error) {
    await finalizeWorkerNudgeClaim(claim, 'FAILED_DEFINITIVE', {
      reason: 'journal_register_failed',
      detail: error instanceof Error ? error.message : String(error),
    });
    return { state: 'escalated', reason: error instanceof Error ? error.message : 'journal_register_failed' };
  }
  if (admission.duplicate) {
    await finalizeWorkerNudgeClaim(claim, 'SENT', { duplicateNoOp: true });
    return { state: 'delivered', reason: 'journal_duplicate_no_op' };
  }

  const fenced = await withSideEffectFence({
    path: options.sideEffectFencePath ?? join(stateRoot, 'side-effects', 'worker-notification.lock'),
    metadata: {
      operation: 'worker-notification',
      intentClass,
      targetId: worker.identity.id,
      targetGeneration: worker.identity.generation,
    },
    action: async () => {
      const marked = await markWorkerNudgeSendAttempted(claim);
      if (!marked.ok) return { marked: false as const, reason: marked.reason ?? 'send_attempt_mark_failed' };
      const result = adapter.dispatchInput({
        worker: worker.identity,
        text: options.request.message,
      }, { cwd: worker.workspacePath });
      return { marked: true as const, result };
    },
  });
  if (!fenced.ok) {
    const completed = await finalizeBoth({
      admission,
      claim,
      journalOutcome: DISPATCH_OUTCOME_SEND_FAILED,
      claimOutcome: 'FAILED_DEFINITIVE',
      extra: { reason: fenced.reason },
    });
    return { state: 'escalated', reason: completed.ok ? fenced.reason : completed.reason };
  }
  if (!fenced.value.marked) {
    const completed = await finalizeBoth({
      admission,
      claim,
      journalOutcome: DISPATCH_OUTCOME_SEND_FAILED,
      claimOutcome: 'FAILED_DEFINITIVE',
      extra: { reason: fenced.value.reason },
    });
    return { state: 'escalated', reason: completed.ok ? fenced.value.reason : completed.reason };
  }

  const dispatch = fenced.value.result;
  if (dispatch.status === 'dispatched') {
    const completed = await finalizeBoth({
      admission,
      claim,
      journalOutcome: DISPATCH_OUTCOME_DISPATCHED,
      claimOutcome: 'SENT',
    });
    return completed.ok
      ? { state: 'delivered', reason: 'runtime_dispatch_dispatched' }
      : { state: 'escalated', reason: completed.reason };
  }
  if (dispatch.status === 'dispatch_unknown') {
    const completed = await finalizeBoth({
      admission,
      claim,
      journalOutcome: DISPATCH_OUTCOME_UNKNOWN,
      claimOutcome: 'UNCERTAIN',
      extra: { reason: dispatch.reason },
    });
    return { state: 'escalated', reason: completed.ok ? 'dispatch_unknown' : completed.reason };
  }
  const completed = await finalizeBoth({
    admission,
    claim,
    journalOutcome: DISPATCH_OUTCOME_SEND_FAILED,
    claimOutcome: 'FAILED_DEFINITIVE',
    extra: { reason: dispatch.reason },
  });
  return { state: 'failed', reason: completed.ok ? dispatch.reason : completed.reason };
}

export { sendPackReviewWorkerNotification as dispatchPackReviewWorkerNotification };
