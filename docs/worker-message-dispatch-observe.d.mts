export declare const AO_PASTE_CHAR_THRESHOLD: number;

export declare const DELIVERY_PATH_PENDING_DRAFT: 'pending-draft';
export declare const DELIVERY_PATH_SELF_SUBMITTED: 'self-submitted';
export declare const DELIVERY_PATH_UNKNOWN: 'unknown';

export declare const DISPATCH_OUTCOME_DISPATCHED: 'dispatched';
export declare const DISPATCH_OUTCOME_SEND_FAILED: 'send_failed';
export declare const DISPATCH_OUTCOME_IN_FLIGHT: 'dispatch_in_flight';
export declare const DISPATCH_OUTCOME_UNKNOWN: 'dispatch_unknown';

export declare const DRAFT_STATE_DRAFT_PRESENT: 'draft_present';
export declare const DRAFT_STATE_AUTO_SUBMITTED: 'auto_submitted';
export declare const DRAFT_STATE_UNKNOWN: 'unknown';

export declare const DISPATCH_SOURCE_REACTION: 'reaction';
export declare const DISPATCH_SOURCE_PACK_SEND: 'pack-send';
export declare const DISPATCH_SOURCE_REVIEW_SEND: 'review-send';
export declare const DISPATCH_SOURCE_AO_SEND: 'ao-send';
export declare const DISPATCH_SOURCE_RESTORE_RETRY: 'restore-retry';

export interface MessageShape {
  charLength: number;
  lineCount: number;
  multiline: boolean;
  deliveryPath: string;
}

export interface DeliveryRecord {
  deliveryId?: string;
  sessionId?: string;
  deliveredAtMs?: number;
  deliveryPath?: string;
  source?: string;
  sourceKey?: string;
  messageShape?: MessageShape;
  dispatchOutcome?: string;
  draftState?: string;
  ambiguousSessionInflight?: boolean;
  corruptObservation?: boolean;
  corruptionReason?: string;
  backendKey?: string;
  dispatchSignature?: string;
  runtimeFingerprint?: string;
  tmuxFingerprint?: string;
  busyDispatchAllowed?: boolean;
  draftIdentity?: string;
  draftIdentityStatus?: string;
  draftIdentityUnprovable?: boolean;
  draftFreshness?: string;
  drainSettled?: boolean;
  observability?: string;
  reviewRunId?: string;
  prNumber?: number;
  headSha?: string;
  deliverySequence?: number;
}

export declare function classifyDeliveryPath(shape: {
  charLength?: number;
  lineCount?: number;
  multiline?: boolean;
}): string;

export declare function deriveMessageShape(
  message: string,
  senderSessionId?: string,
): MessageShape;

export declare function buildDeliveryId(
  sessionId: string,
  deliveredAtMs: number,
  source: string,
  sourceKey?: string,
): string | null;

export declare function resolveReviewSendObservedAtMs(
  run: Record<string, unknown>,
): number | null;

export declare function buildReviewSendDeliveryId(
  sessionId: string,
  runId: string,
  observedAtMs?: number | null,
): string | null;

export declare function isReactionSendSucceededEvent(
  event: Record<string, unknown>,
): boolean;

export declare function extractReactionDeliveries(
  events: Array<Record<string, unknown>>,
  reactionMessages?: Record<string, string>,
): DeliveryRecord[];

export declare function extractJournalDeliveries(
  journal: Record<string, Record<string, unknown>>,
): DeliveryRecord[];

export declare function extractReviewFindingDeliveries(
  reviewRuns: Array<Record<string, unknown>>,
  nowMs: number,
): DeliveryRecord[];

export declare function mergeDeliveryRecords(input: {
  aoEvents?: Array<Record<string, unknown>>;
  dispatchJournal?: Record<string, Record<string, unknown>>;
  reviewRuns?: Array<Record<string, unknown>>;
  reactionMessages?: Record<string, string>;
  nowMs: number;
}): DeliveryRecord[];

export declare function getSessionActivity(session: Record<string, unknown>): string;

export declare function isDeliveryConsumed(
  session: Record<string, unknown>,
  delivery: DeliveryRecord,
  deliveredAtMs: number,
): boolean;

export declare function isSessionStreaming(session: Record<string, unknown>): boolean;

export declare function isSessionAlive(session: Record<string, unknown>): boolean;

export declare function selectSurvivingDelivery(
  deliveries: DeliveryRecord[],
  sessionId: string,
): DeliveryRecord | null;

export declare function findOverwrittenDeliveries(
  deliveries: DeliveryRecord[],
  sessionId: string,
): DeliveryRecord[];
