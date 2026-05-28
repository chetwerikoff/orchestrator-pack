export declare const DEFAULT_WAKE_DEDUP_WINDOW_MS: 30000;

export declare const WAKE_RELEVANT_KINDS: ReadonlySet<string>;

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

export declare function evaluateWakePayload(body: unknown): WakeFilterResult;

export declare function parseWebhookJson(raw: string): unknown;
