export declare const DEFAULT_WAKE_DEDUP_WINDOW_MS: 30000;
export declare const DEFAULT_HEARTBEAT_INTERVAL_MS: number;
export declare const HEARTBEAT_WAKE_KIND: 'heartbeat.reconcile';
export declare const GLOBAL_ORCHESTRATOR_WAKE_KEY: '__orchestrator_wake__';
export declare const HEARTBEAT_DEDUPE_KEY: string;
export declare const DEDUP_LOCK_STALE_MS: number;
export declare const DEDUP_LOCK_WAIT_MS: number;

export declare const WAKE_RELEVANT_KINDS: ReadonlySet<string>;
export declare const COMPLETION_MERGE_INTENT_WAKE_KINDS: ReadonlySet<string>;

export declare function isCompletionMergeIntentWake(
  wakeKind: string | null | undefined,
): boolean;

export interface AoWebhookEvent {
  id?: string;
  type?: string;
  priority?: string;
  sessionId?: string;
  projectId?: string;
  timestamp?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface AoWebhookBody {
  type?: string;
  event?: AoWebhookEvent;
  message?: string;
  context?: Record<string, unknown>;
}

export type WakeFilterRejectReason =
  | 'malformed_payload'
  | 'not_notification'
  | 'missing_session_id'
  | 'info_priority'
  | 'not_wake_relevant';

export interface WakeFilterAccept {
  ok: true;
  wakeKind: string;
  sessionId: string;
  projectId?: string;
  prNumber?: number;
  prUrl?: string;
  runId?: string;
  wakeMessage: string;
  dedupeKey: string;
}

export interface WakeFilterReject {
  ok: false;
  reason: WakeFilterRejectReason;
  detail?: string;
}

export type WakeFilterResult = WakeFilterAccept | WakeFilterReject;

export declare function buildWakeMessage(
  wakeKind: string,
  parts: {
    sessionId: string;
    prNumber?: number;
    prUrl?: string;
    runId?: string;
  },
): string;

export declare function buildHeartbeatWakeMessage(): string;

export declare function pruneDedupEntries(
  entries: Record<string, number>,
  nowMs: number,
  windowMs: number,
): Record<string, number>;

export declare function isDeduped(
  entries: Record<string, number>,
  dedupeKey: string,
  nowMs: number,
  windowMs: number,
): boolean;

export type OrchestratorWakeSendRejectReason = 'global_deduped' | 'deduped';

export interface OrchestratorWakeSendAccept {
  ok: true;
  entries: Record<string, number>;
}

export interface OrchestratorWakeSendReject {
  ok: false;
  reason: OrchestratorWakeSendRejectReason;
  entries: Record<string, number>;
}

export type OrchestratorWakeSendResult = OrchestratorWakeSendAccept | OrchestratorWakeSendReject;

export declare function evaluateOrchestratorWakeSend(args: {
  dedupeKey: string;
  nowMs?: number;
  dedupWindowMs?: number;
  entries?: Record<string, number>;
}): OrchestratorWakeSendResult;

export type HeartbeatTickRejectReason =
  | 'interval_not_elapsed'
  | OrchestratorWakeSendRejectReason;

export interface HeartbeatTickAccept {
  ok: true;
  wakeKind: typeof HEARTBEAT_WAKE_KIND;
  wakeMessage: string;
  dedupeKey: string;
  entries: Record<string, number>;
  lastHeartbeatSentMs: number;
}

export interface HeartbeatTickReject {
  ok: false;
  reason: HeartbeatTickRejectReason;
  entries: Record<string, number>;
}

export type HeartbeatTickResult = HeartbeatTickAccept | HeartbeatTickReject;

export declare function evaluateHeartbeatTick(args: {
  nowMs?: number;
  intervalMs?: number;
  lastHeartbeatSentMs?: number;
  entries?: Record<string, number>;
  dedupWindowMs?: number;
}): HeartbeatTickResult;

export declare function evaluateWakePayload(body: unknown): WakeFilterResult;

export declare function parseWebhookJson(raw: string): unknown;

export declare function loadDedupStateFile(filePath: string): {
  entries: Record<string, number>;
  lastHeartbeatSentMs?: number;
};

export declare function saveDedupStateFile(
  filePath: string,
  state: { entries: Record<string, number>; lastHeartbeatSentMs?: number },
): void;

export interface DedupStateLockHandle {
  fd: number;
  lockPath: string;
}

export interface DedupLockTimeout {
  ok: false;
  reason: 'dedup_lock_timeout';
}

export declare function dedupLockPath(stateFilePath: string): string;

export declare function acquireDedupStateLock(
  stateFilePath: string,
  options?: { maxWaitMs?: number; staleMs?: number },
): DedupStateLockHandle | null;

export declare function releaseDedupStateLock(lock: DedupStateLockHandle | null): void;

export declare function withDedupStateFileLock<T>(
  stateFilePath: string,
  fn: () => T,
  options?: { maxWaitMs?: number; staleMs?: number },
): T | DedupLockTimeout;

export declare function applyDedupTry(args: {
  filePath: string;
  dedupeKey: string;
  dedupWindowMs: number;
  nowMs: number;
}): OrchestratorWakeSendResult | DedupLockTimeout;

export declare function applyHeartbeatTick(args: {
  filePath: string;
  intervalMs: number;
  dedupWindowMs: number;
  nowMs: number;
}): HeartbeatTickResult | DedupLockTimeout;
