import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  buildDeterministicDeliveryId,
  evaluateDeterministicJournalAdmission,
} from '../../docs/review-delivery-lifecycle.mjs';
import type {
  PackReviewWorkerNotificationBinding,
  PackReviewWorkerNotificationRequest,
  PackReviewWorkerSubmissionResult,
} from './pack-review-delivery.ts';
import { getPackReviewRun } from './pack-review-run-store.ts';
import { runProcess } from '../kernel/subprocess.ts';
import { selectRuntimeAdapter } from '../runtime/registry.ts';
import { createAdapterSubmitDeps, submitUnsentCursorComposerOnceForWorker } from '../cursor-unsent-composer-submit.ts';
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
  /** Transitional parameter name at old call sites; bound to the persisted review session. */
  sessionId?: string;
  expectedWorkerGeneration?: string;
  expectedRuntime?: string;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parsePersistedWorkerNotificationBinding(
  run: unknown,
): PackReviewWorkerNotificationBinding | null {
  const record = asRecord(run);
  const raw = asRecord(record?.workerNotificationBinding);
  const targetSha = trim(record?.targetSha).toLowerCase();
  if (!raw || Number(raw.schemaVersion) !== 1) return null;
  const binding: PackReviewWorkerNotificationBinding = {
    schemaVersion: 1,
    runtime: trim(raw.runtime),
    id: trim(raw.id),
    generation: trim(raw.generation),
    workspacePath: trim(raw.workspacePath),
    headSha: trim(raw.headSha).toLowerCase(),
  };
  if (!binding.runtime
    || !binding.id
    || !binding.generation
    || !binding.workspacePath
    || !/^[0-9a-f]{40}$/.test(binding.headSha)
    || binding.headSha !== targetSha) return null;
  return binding;
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
  expectedRuntime: string;
  expectedGeneration: string;
  expectedWorkspacePath: string;
  expectedHeadSha: string;
}): Promise<RuntimeWorker> {
  const found = input.adapter.findWorkerById(input.workerId);
  if (found.status !== 'ok') throw new Error(`${found.operation}:${found.reason}`);
  if (!found.value) throw new Error('worker_not_found');
  if (!input.expectedRuntime || found.value.identity.runtime !== input.expectedRuntime) {
    throw new Error('worker_runtime_mismatch');
  }
  if (!input.expectedGeneration || found.value.identity.generation !== input.expectedGeneration) {
    throw new Error('worker_generation_mismatch');
  }
  if (input.expectedWorkspacePath
    && resolve(found.value.workspacePath) !== resolve(input.expectedWorkspacePath)) {
    throw new Error('worker_workspace_mismatch');
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

function submitCursorComposerOnceAfterDelivery(adapter: RuntimeAdapter, worker: RuntimeWorker): void {
  try {
    submitUnsentCursorComposerOnceForWorker(worker, createAdapterSubmitDeps(adapter));
  } catch {
    // Composer submission is an auxiliary bounded reaction; notification settlement remains authoritative.
  }
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

function fixture(options: WorkerNotificationOptions, workerId: string): PackReviewWorkerSubmissionResult | null {
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
  return { state: 'submitted', reason: 'fixture_submitted' };
}

function bindPersistedReviewRun(options: WorkerNotificationOptions):
  | { ok: true; options: WorkerNotificationOptions & { expectedWorkspacePath?: string } }
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
    const intentClass = trim(options.intentClass) || 'review-findings';
    const explicitBinding = intentClass === 'task-continuation'
      ? Number.isInteger(Number(options.issueNumber)) && Number(options.issueNumber) > 0
      : Number.isInteger(Number(options.prNumber)) && Number(options.prNumber) > 0;
    return explicitBinding
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
  const linkedSessionId = trim(run.linkedSessionId);
  if (!linkedSessionId) return { ok: false, reason: 'worker_session_binding_unresolved' };
  const explicitSessionId = trim(options.sessionId);
  if (explicitSessionId && explicitSessionId !== linkedSessionId) {
    return { ok: false, reason: 'review_run_session_mismatch' };
  }

  const bypassFixtureBinding = process.env.OPK_VITEST_HARNESS === '1'
    && !options.adapter
    && process.env.PACK_REVIEW_WORKER_NOTIFICATION_REAL_ADAPTER !== '1';
  if (bypassFixtureBinding) {
    return {
      ok: true,
      options: {
        ...options,
        workerId: linkedSessionId,
        sessionId: undefined,
        repoRoot: trim(options.repoRoot) || run.sourceRepoRoot,
        projectId: run.projectId,
        prNumber: run.prNumber,
        headSha: run.targetSha,
      },
    };
  }

  const binding = parsePersistedWorkerNotificationBinding(run);
  if (!binding) return { ok: false, reason: 'worker_runtime_binding_unresolved' };
  const explicitWorkerId = trim(options.workerId);
  if (explicitWorkerId && explicitWorkerId !== binding.id) {
    return { ok: false, reason: 'worker_runtime_binding_id_mismatch' };
  }
  const explicitGeneration = trim(options.expectedWorkerGeneration);
  if (explicitGeneration && explicitGeneration !== binding.generation) {
    return { ok: false, reason: 'worker_runtime_binding_generation_mismatch' };
  }
  const explicitRuntime = trim(options.expectedRuntime);
  if (explicitRuntime && explicitRuntime !== binding.runtime) {
    return { ok: false, reason: 'worker_runtime_binding_runtime_mismatch' };
  }

  return {
    ok: true,
    options: {
      ...options,
      workerId: binding.id,
      sessionId: undefined,
      expectedWorkerGeneration: binding.generation,
      expectedRuntime: binding.runtime,
      expectedWorkspacePath: binding.workspacePath,
      repoRoot: trim(options.repoRoot) || run.sourceRepoRoot,
      projectId: run.projectId,
      prNumber: run.prNumber,
      headSha: run.targetSha,
    },
  };
}

/**
 * Journal-first runtime notification. The exact runtime + id + generation is
 * loaded from the immutable persisted review-run binding before claim acquisition,
 * then revalidated against the selected adapter immediately before one dispatch.
 * The consumer result is submit-scoped: only evidence-backed dispatch is
 * `submitted`; definite failures before dispatch are `pre_dispatch_failure`; and
 * post-dispatch uncertainty is `ambiguous`. Recipient delivery is never inferred.
 */
export async function sendPackReviewWorkerNotification(
  originalOptions: WorkerNotificationOptions,
): Promise<PackReviewWorkerSubmissionResult> {
  const bound = bindPersistedReviewRun(originalOptions);
  if (!bound.ok) return { state: 'pre_dispatch_failure', reason: bound.reason };
  const options = bound.options;
  const workerId = trim(options.workerId || options.sessionId);
  if (!workerId) return { state: 'pre_dispatch_failure', reason: 'worker_id_unresolved' };
  const fixtureResult = fixture(options, workerId);
  if (fixtureResult) return fixtureResult;
  if (!trim(options.request.idempotencyKey)) {
    return { state: 'pre_dispatch_failure', reason: 'worker_notification_delivery_key_missing' };
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
      expectedRuntime: trim(options.expectedRuntime) || adapter.id,
      expectedGeneration: trim(options.expectedWorkerGeneration),
      expectedWorkspacePath: trim(options.expectedWorkspacePath),
      expectedHeadSha: trim(options.headSha).toLowerCase(),
    });
  } catch (error) {
    return { state: 'pre_dispatch_failure', reason: error instanceof Error ? error.message : 'worker_target_unresolved' };
  }

  const projectId = trim(options.projectId) || 'orchestrator-pack';
  const prNumber = Number(options.prNumber ?? 0);
  const issueNumber = Number(options.issueNumber ?? 0);
  const intentClass = trim(options.intentClass) || 'review-findings';
  if (intentClass === 'task-continuation') {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return { state: 'pre_dispatch_failure', reason: 'task_continuation_issue_required' };
    }
  } else if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { state: 'pre_dispatch_failure', reason: 'pr_number_required' };
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
    if (claim.reason === 'already_served') return { state: 'submitted', reason: 'claim_duplicate_no_op' };
    return { state: 'pre_dispatch_failure', reason: claim.reason };
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
    return { state: 'pre_dispatch_failure', reason: error instanceof Error ? error.message : 'journal_register_failed' };
  }
  if (admission.duplicate) {
    await finalizeWorkerNudgeClaim(claim, 'SENT', { duplicateNoOp: true });
    return { state: 'submitted', reason: 'journal_duplicate_no_op' };
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
    return { state: 'pre_dispatch_failure', reason: completed.ok ? fenced.reason : completed.reason };
  }
  if (!fenced.value.marked) {
    const completed = await finalizeBoth({
      admission,
      claim,
      journalOutcome: DISPATCH_OUTCOME_SEND_FAILED,
      claimOutcome: 'FAILED_DEFINITIVE',
      extra: { reason: fenced.value.reason },
    });
    return { state: 'pre_dispatch_failure', reason: completed.ok ? fenced.value.reason : completed.reason };
  }

  const dispatch = fenced.value.result;
  if (dispatch.status === 'dispatched') {
    const completed = await finalizeBoth({
      admission,
      claim,
      journalOutcome: DISPATCH_OUTCOME_DISPATCHED,
      claimOutcome: 'SENT',
    });
    if (completed.ok) submitCursorComposerOnceAfterDelivery(adapter, worker);
    return {
      state: 'submitted',
      reason: completed.ok ? 'runtime_dispatch_submitted' : `runtime_dispatch_submitted:${completed.reason}`,
    };
  }
  if (dispatch.status === 'dispatch_unknown') {
    const completed = await finalizeBoth({
      admission,
      claim,
      journalOutcome: DISPATCH_OUTCOME_UNKNOWN,
      claimOutcome: 'UNCERTAIN',
      extra: { reason: dispatch.reason },
    });
    if (completed.ok) submitCursorComposerOnceAfterDelivery(adapter, worker);
    return { state: 'ambiguous', reason: completed.ok ? 'dispatch_unknown' : completed.reason };
  }
  const completed = await finalizeBoth({
    admission,
    claim,
    journalOutcome: DISPATCH_OUTCOME_SEND_FAILED,
    claimOutcome: 'FAILED_DEFINITIVE',
    extra: { reason: dispatch.reason },
  });
  return { state: 'pre_dispatch_failure', reason: completed.ok ? dispatch.reason : completed.reason };
}

export { sendPackReviewWorkerNotification as dispatchPackReviewWorkerNotification };
