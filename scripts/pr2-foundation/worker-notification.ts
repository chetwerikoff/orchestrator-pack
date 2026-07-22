import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildDeterministicDeliveryId,
  evaluateDeterministicJournalAdmission,
} from '../../docs/review-delivery-lifecycle.mjs';
import { runProcess, type ProcessResult } from '../kernel/subprocess.ts';
import type {
  PackReviewWorkerNotificationRequest,
  PackReviewWorkerNotificationResult,
} from '../lib/pack-review-delivery.ts';
import { trimPackReviewValue as trim } from '../lib/pack-review-run-store.ts';
import { notificationConfig, type FoundationNotificationConfig } from './config.ts';
import { withJournalLock } from './journal-lock.ts';
import {
  admitDispatchJournalRecord,
  deriveMessageShape,
  DISPATCH_OUTCOME_DISPATCHED,
  DISPATCH_OUTCOME_IN_FLIGHT,
  DISPATCH_OUTCOME_SEND_FAILED,
  DISPATCH_OUTCOME_UNKNOWN,
  DRAFT_STATE_AUTO_SUBMITTED,
  DRAFT_STATE_DRAFT_PRESENT,
  finalizeDispatchJournalRecord,
  type DispatchJournalRecord,
} from './worker-dispatch-journal.ts';
import {
  acquireWorkerNudgeClaim,
  finalizeWorkerNudgeClaim,
  markWorkerNudgeSendAttempted,
  persistWorkerNudgeMessageHash,
  releaseWorkerNudgeClaim,
  withWorkerNudgeSideEffectFence,
  type WorkerNudgeClaimHandle,
} from './worker-nudge-claim-store.ts';
import {
  resolveVerifiedWorkerNotificationTarget,
  type VerifiedWorkerNotificationTarget,
} from './worker-notification-target.ts';
import { resolveWorkerMessageDispatchJournalPath } from './wake-supervisor-state-root.ts';

export interface WorkerNotificationOptions {
  trustedPackRoot: string;
  sessionId: string;
  request: PackReviewWorkerNotificationRequest;
  repoRoot?: string;
  projectId?: string;
  prNumber?: number;
  headSha?: string;
  foundationConfig?: unknown;
}

interface JournalAdmission {
  duplicate: boolean;
  deliveryId: string;
  journalPath: string;
  deliveryPath: string;
}

function writeCapture(file: string, payload: Record<string, unknown>): void {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(resolve(file), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function fixtureNotification(
  options: WorkerNotificationOptions,
  sessionId: string,
): PackReviewWorkerNotificationResult | null {
  if (process.env.OPK_VITEST_HARNESS !== '1'
    || process.env.PACK_REVIEW_WORKER_NOTIFICATION_REAL_ADAPTER === '1') {
    return null;
  }
  const capturePath = trim(process.env.PACK_REVIEW_WORKER_NOTIFICATION_CAPTURE_FILE);
  if (capturePath) {
    writeCapture(capturePath, {
      sessionId,
      message: options.request.message,
      idempotencyKey: options.request.idempotencyKey,
    });
  }
  return { state: 'delivered', reason: 'fixture_dispatched' };
}

function parseTarget(options: WorkerNotificationOptions): {
  prNumber: number;
  headSha: string;
} | null {
  const key = trim(options.request.idempotencyKey);
  const keyMatch = key.match(/^worker-notification:[^:]+:([0-9a-f]{40})$/i);
  const messageMatch = trim(options.request.message).match(/Pack review completed for PR #(\d+)\./);
  const prNumber = Number(options.prNumber ?? messageMatch?.[1]);
  const headSha = trim(options.headSha ?? keyMatch?.[1]).toLowerCase();
  if (!Number.isInteger(prNumber) || prNumber <= 0 || !/^[0-9a-f]{40}$/.test(headSha)) return null;
  return { prNumber, headSha };
}

function defaultDispatchJournalPath(): string {
  return resolveWorkerMessageDispatchJournalPath();
}

function readJournal(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('journal_untrusted');
  const journal = parsed as Record<string, unknown>;
  const recovery = journal._recovery;
  if (recovery && typeof recovery === 'object' && !Array.isArray(recovery)
    && (recovery as Record<string, unknown>).fenceTrusted === false) {
    throw new Error('journal_untrusted');
  }
  return journal;
}

function writeJournalAtomic(file: string, journal: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}

function hashedSourceKey(value: string): string {
  return `sha256-${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24)}`;
}

async function inspectNotification(input: {
  deliveryKey: string;
  findingsHash: string;
  maxAttempts: number;
}): Promise<{ duplicate: boolean }> {
  const journalPath = defaultDispatchJournalPath();
  return withJournalLock(journalPath, input.maxAttempts, () => {
    const deterministic = evaluateDeterministicJournalAdmission(readJournal(journalPath), {
      deterministicKey: input.deliveryKey,
      findingsHash: input.findingsHash,
    });
    if (deterministic.action === 'no_op_terminal') return { duplicate: true };
    if (!deterministic.ok
      || deterministic.action === 'escalate'
      || deterministic.action === 'escalate_supersede') {
      throw new Error(String(deterministic.reason ?? 'journal_admission_refused'));
    }
    return { duplicate: false };
  });
}

async function admitNotification(input: {
  sessionId: string;
  deliveryKey: string;
  findingsHash: string;
  message: string;
  reviewRunId: string;
  maxAttempts: number;
}): Promise<JournalAdmission> {
  const journalPath = defaultDispatchJournalPath();
  return withJournalLock(journalPath, input.maxAttempts, () => {
    const journal = readJournal(journalPath);
    const deterministic = evaluateDeterministicJournalAdmission(journal, {
      deterministicKey: input.deliveryKey,
      findingsHash: input.findingsHash,
    });
    if (deterministic.action === 'no_op_terminal') {
      return {
        duplicate: true,
        deliveryId: String(deterministic.deliveryId ?? ''),
        journalPath,
        deliveryPath: '',
      };
    }
    if (!deterministic.ok
      || deterministic.action === 'escalate'
      || deterministic.action === 'escalate_supersede') {
      throw new Error(String(deterministic.reason ?? 'journal_admission_refused'));
    }
    const computedId = buildDeterministicDeliveryId(input.sessionId, input.deliveryKey);
    const deliveryId = String(deterministic.deliveryId ?? computedId ?? '').trim();
    if (!deliveryId) throw new Error('invalid_delivery_id');
    if (deterministic.action === 'resume') {
      const existingRecord = journal[deliveryId];
      const deliveryPath = existingRecord && typeof existingRecord === 'object' && !Array.isArray(existingRecord)
        ? trim((existingRecord as Record<string, unknown>).deliveryPath)
        : '';
      if (!deliveryPath) throw new Error('resume_delivery_path_missing');
      return { duplicate: false, deliveryId, journalPath, deliveryPath };
    }

    const shape = deriveMessageShape(input.message, trim(process.env.AO_SESSION_ID));
    const nowMs = Date.now();
    const record: DispatchJournalRecord = {
      deliveryId,
      sessionId: input.sessionId,
      deliveredAtMs: nowMs,
      source: 'pack-send',
      sourceKey: hashedSourceKey(input.deliveryKey),
      deliveryPath: shape.deliveryPath,
      messageShape: {
        charLength: shape.charLength,
        lineCount: shape.lineCount,
      },
      dispatchOutcome: DISPATCH_OUTCOME_IN_FLIGHT,
      draftState: shape.deliveryPath === 'self-submitted'
        ? DRAFT_STATE_AUTO_SUBMITTED
        : DRAFT_STATE_DRAFT_PRESENT,
      restoreRetry: false,
      adoptionProbe: false,
      aoEpochHash: '',
      configPathHash: '',
      adoptionProbeRunIdHash: '',
      deterministicKey: input.deliveryKey,
      findingsHash: input.findingsHash,
      reviewRunId: input.reviewRunId,
    };
    const admitted = admitDispatchJournalRecord(journal, record, nowMs);
    if (!admitted.ok) throw new Error(admitted.reason);
    writeJournalAtomic(journalPath, admitted.journal);
    return { duplicate: false, deliveryId, journalPath, deliveryPath: shape.deliveryPath };
  });
}

async function finalizeNotification(input: {
  admission: JournalAdmission;
  outcome: string;
  draftState: string;
  maxAttempts: number;
}): Promise<void> {
  await withJournalLock(input.admission.journalPath, input.maxAttempts, () => {
    const journal = readJournal(input.admission.journalPath);
    const finalized = finalizeDispatchJournalRecord(
      journal,
      input.admission.deliveryId,
      input.outcome,
      Date.now(),
      input.draftState,
    );
    if (!finalized.ok) throw new Error(finalized.reason);
    writeJournalAtomic(input.admission.journalPath, finalized.journal);
  });
}

function argvLength(command: string, args: readonly string[]): number {
  return [command, ...args].reduce((total, value) => total + value.length + 3, 0);
}

async function validateAoSendContract(command: string, timeoutMs: number): Promise<boolean> {
  if (process.env.AO_JOURNALED_SEND_ASSUME_CONTRACT === '1') return true;
  const help = await runProcess({
    command,
    args: ['send', '--help'],
    inheritParentEnv: true,
    allowEmptyStdout: true,
    timeoutMs,
  });
  const output = `${help.stdout}\n${help.stderr}`;
  return help.ok && /--message/.test(output) && /--session/.test(output);
}

function fixtureTarget(
  requestedSessionId: string,
): VerifiedWorkerNotificationTarget | null {
  if (process.env.OPK_VITEST_HARNESS !== '1') return null;
  const workerTarget = trim(process.env.PACK_REVIEW_WORKER_NOTIFICATION_FIXTURE_TARGET);
  if (!workerTarget) return null;
  const separator = workerTarget.lastIndexOf(':');
  const targetId = separator > 0 ? workerTarget.slice(0, separator) : requestedSessionId;
  const targetGeneration = separator > 0 ? workerTarget.slice(separator + 1) : requestedSessionId;
  return {
    sessionId: requestedSessionId,
    workerTarget,
    targetId,
    targetGeneration,
    openPrs: [],
    repoSlug: 'fixture/repository',
  };
}

async function resolveNotificationTarget(
  options: WorkerNotificationOptions,
  target: { prNumber: number; headSha: string },
  config: FoundationNotificationConfig,
): Promise<VerifiedWorkerNotificationTarget> {
  const requestedSessionId = trim(options.sessionId);
  const fixture = fixtureTarget(requestedSessionId);
  if (fixture) return fixture;
  const trustedPackRoot = resolve(options.trustedPackRoot);
  return resolveVerifiedWorkerNotificationTarget({
    trustedPackRoot,
    repoRoot: resolve(options.repoRoot || trustedPackRoot),
    projectId: trim(options.projectId) || 'orchestrator-pack',
    requestedSessionId,
    prNumber: target.prNumber,
    headSha: target.headSha,
    config,
  });
}

async function finalizeJournalAndClaim(input: {
  admission: JournalAdmission;
  claim: WorkerNudgeClaimHandle;
  journalOutcome: string;
  draftState: string;
  claimOutcome: 'SENT' | 'FAILED_DEFINITIVE' | 'UNCERTAIN';
  maxAttempts: number;
  extra?: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await finalizeNotification({
      admission: input.admission,
      outcome: input.journalOutcome,
      draftState: input.draftState,
      maxAttempts: input.maxAttempts,
    });
  } catch (error) {
    await finalizeWorkerNudgeClaim(input.claim, 'UNCERTAIN', {
      reason: 'dispatch_outcome_unrecorded',
      detail: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      reason: `dispatch_outcome_unrecorded:${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const finalized = await finalizeWorkerNudgeClaim(input.claim, input.claimOutcome, input.extra);
  if (!finalized.ok) return { ok: false, reason: `claim_finalize_failed:${finalized.reason ?? 'unknown'}` };
  return { ok: true };
}

function notificationFailureReason(result: ProcessResult): string {
  return trim(result.stderr || result.error || result.stdout) || result.outcome;
}

export async function sendPackReviewWorkerNotification(
  options: WorkerNotificationOptions,
): Promise<PackReviewWorkerNotificationResult> {
  const requestedSessionId = trim(options.sessionId);
  if (!requestedSessionId) return { state: 'escalated', reason: 'worker_session_unresolved' };
  const fixture = fixtureNotification(options, requestedSessionId);
  if (fixture) return fixture;

  const target = parseTarget(options);
  if (!target) return { state: 'escalated', reason: 'worker_notification_target_unresolved' };
  let config: FoundationNotificationConfig;
  try {
    config = notificationConfig(options.foundationConfig ?? {});
  } catch (error) {
    return { state: 'escalated', reason: error instanceof Error ? error.message : 'invalid_config' };
  }
  const deliveryKey = trim(options.request.idempotencyKey);
  if (!deliveryKey) return { state: 'escalated', reason: 'worker_notification_delivery_key_missing' };
  const findingsHash = `sha256:${createHash('sha256').update(options.request.message, 'utf8').digest('hex')}`;

  let verifiedTarget: VerifiedWorkerNotificationTarget;
  try {
    verifiedTarget = await resolveNotificationTarget(options, target, config);
  } catch (error) {
    return { state: 'escalated', reason: error instanceof Error ? error.message : 'pr_owner_unresolved' };
  }

  try {
    const inspected = await inspectNotification({
      deliveryKey,
      findingsHash,
      maxAttempts: config.maxJournalAttempts,
    });
    if (inspected.duplicate) return { state: 'delivered', reason: 'journal_duplicate_no_op' };
  } catch (error) {
    return { state: 'escalated', reason: error instanceof Error ? error.message : 'journal_admission_refused' };
  }

  const args = ['send', '--message', options.request.message, '--session', verifiedTarget.sessionId] as const;
  if (argvLength(config.aoPath, args) > config.argvCeilingChars - 64) {
    return { state: 'escalated', reason: 'inline_message_too_large' };
  }
  if (!await validateAoSendContract(config.aoPath, config.timeoutMs)) {
    return { state: 'escalated', reason: 'ao_send_contract_missing' };
  }

  const projectId = trim(options.projectId) || 'orchestrator-pack';
  const cycleKey = `stdout:${findingsHash}`;
  let lastUnknownReason = 'dispatch_unknown_exhausted';

  for (let attempt = 1; attempt <= config.maxJournalAttempts; attempt += 1) {
    const claim = await acquireWorkerNudgeClaim({
      prNumber: target.prNumber,
      cycleKey,
      intentClass: 'review-findings',
      workerTarget: verifiedTarget.workerTarget,
      sessionId: verifiedTarget.sessionId,
      targetId: verifiedTarget.targetId,
      targetGeneration: verifiedTarget.targetGeneration,
      surface: 'scripted-review-stdout-delivery',
      projectId,
      message: options.request.message,
    });
    if (!claim.acquired) {
      if (claim.reason === 'already_served') {
        try {
          const inspected = await inspectNotification({
            deliveryKey,
            findingsHash,
            maxAttempts: config.maxJournalAttempts,
          });
          if (inspected.duplicate) return { state: 'delivered', reason: 'journal_duplicate_no_op' };
        } catch {
          // Preserve the stronger claim failure below.
        }
      }
      return { state: 'escalated', reason: `nudge_claim_failed:${claim.reason}` };
    }

    const hashPersist = await persistWorkerNudgeMessageHash(claim, options.request.message);
    if (!hashPersist.ok) {
      await releaseWorkerNudgeClaim(claim);
      return { state: 'escalated', reason: `message_hash_persist_failed:${hashPersist.reason ?? 'unknown'}` };
    }

    let admission: JournalAdmission;
    try {
      admission = await admitNotification({
        sessionId: verifiedTarget.sessionId,
        deliveryKey,
        findingsHash,
        message: options.request.message,
        reviewRunId: trim(options.request.reviewRunId),
        maxAttempts: config.maxJournalAttempts,
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

    const fenced = await withWorkerNudgeSideEffectFence(async () => {
      const marked = await markWorkerNudgeSendAttempted(claim);
      if (!marked.ok) return { marked: false as const, reason: marked.reason ?? 'send_attempt_mark_failed' };
      const result = await runProcess({
        command: config.aoPath,
        args,
        cwd: resolve(options.repoRoot || options.trustedPackRoot),
        inheritParentEnv: true,
        allowEmptyStdout: true,
        timeoutMs: config.timeoutMs,
      });
      return { marked: true as const, result };
    });

    if (!fenced.ok) {
      await releaseWorkerNudgeClaim(claim);
      lastUnknownReason = fenced.reason;
      if (attempt < config.maxJournalAttempts) continue;
      return { state: 'escalated', reason: fenced.reason };
    }
    if (!fenced.value.marked) {
      const completed = await finalizeJournalAndClaim({
        admission,
        claim,
        journalOutcome: DISPATCH_OUTCOME_SEND_FAILED,
        draftState: DRAFT_STATE_DRAFT_PRESENT,
        claimOutcome: 'FAILED_DEFINITIVE',
        maxAttempts: config.maxJournalAttempts,
        extra: { reason: fenced.value.reason },
      });
      return {
        state: 'escalated',
        reason: completed.ok ? fenced.value.reason : completed.reason,
      };
    }

    const result = fenced.value.result;
    if (result.ok) {
      const completed = await finalizeJournalAndClaim({
        admission,
        claim,
        journalOutcome: DISPATCH_OUTCOME_DISPATCHED,
        draftState: admission.deliveryPath === 'self-submitted'
          ? DRAFT_STATE_AUTO_SUBMITTED
          : DRAFT_STATE_DRAFT_PRESENT,
        claimOutcome: 'SENT',
        maxAttempts: config.maxJournalAttempts,
      });
      return completed.ok
        ? { state: 'delivered', reason: 'explicit_send_dispatched' }
        : { state: 'escalated', reason: completed.reason };
    }

    if (result.exitCode === 44) {
      try {
        await finalizeNotification({
          admission,
          outcome: DISPATCH_OUTCOME_UNKNOWN,
          draftState: DRAFT_STATE_DRAFT_PRESENT,
          maxAttempts: config.maxJournalAttempts,
        });
      } catch (error) {
        await finalizeWorkerNudgeClaim(claim, 'UNCERTAIN', {
          reason: 'dispatch_outcome_unrecorded',
          detail: error instanceof Error ? error.message : String(error),
        });
        return {
          state: 'escalated',
          reason: `dispatch_outcome_unrecorded:${error instanceof Error ? error.message : String(error)}`,
        };
      }
      await releaseWorkerNudgeClaim(claim);
      lastUnknownReason = 'dispatch_unknown';
      continue;
    }

    const uncertain = result.timedOut || result.cancelled;
    const completed = await finalizeJournalAndClaim({
      admission,
      claim,
      journalOutcome: uncertain ? DISPATCH_OUTCOME_UNKNOWN : DISPATCH_OUTCOME_SEND_FAILED,
      draftState: DRAFT_STATE_DRAFT_PRESENT,
      claimOutcome: uncertain ? 'UNCERTAIN' : 'FAILED_DEFINITIVE',
      maxAttempts: config.maxJournalAttempts,
      extra: { exitCode: result.exitCode, reason: notificationFailureReason(result) },
    });
    if (!completed.ok) return { state: 'escalated', reason: completed.reason };
    return {
      state: uncertain ? 'escalated' : 'failed',
      reason: notificationFailureReason(result),
    };
  }

  return { state: 'escalated', reason: lastUnknownReason };
}
