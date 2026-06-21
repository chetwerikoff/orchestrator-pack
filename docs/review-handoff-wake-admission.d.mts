import type { OpenPr } from './review-trigger-reconcile.d.mts';

export declare const HANDOFF_WAKE_KIND: 'ready_for_review';
export declare const HANDOFF_RECEIPT_TO_RUN_MAX_MS: 30000;
export declare const HANDOFF_LISTENER_RECOVERY_MAX_MS: 30000;
export declare const HANDOFF_AUDIT_PREFIX: 'review-handoff-wake';

export interface HandoffWakeAudit {
  prefix?: string;
  outcome?: string;
  reason?: string;
  wakeKind?: string;
  priority?: string;
  sessionId?: string;
  prNumber?: number;
  claimOutcome?: string;
}

export declare function isReadyForReviewHandoffEnvelope(
  body: unknown,
  event?: Record<string, unknown>,
): boolean;

export declare function parseHandoffNotificationSubject(event: Record<string, unknown>): {
  sessionId?: string;
  projectId?: string;
  prNumber?: number;
  prUrl?: string;
  priority?: string;
  receivedAtMs?: number;
};

export declare function normalizeRepoSlugFromPrUrl(prUrl: string | undefined): string | undefined;
export declare function parsePrNumberFromPrUrl(prUrl: string | undefined): number | undefined;

export declare function evaluateHandoffIdentityAdmission(input: {
  event?: Record<string, unknown>;
  supervisedProjectId?: string;
  supervisedRepoSlug?: string;
  supervisedSessions?: import('./review-trigger-reconcile.d.mts').AoSession[];
  sessionLookupFailed?: boolean;
  supervisedRepoLookupFailed?: boolean;
  openPrs?: OpenPr[];
  openPrLookupFailed?: boolean;
}): {
  admitted: boolean;
  outcome: string;
  reason: string;
  retryable?: boolean;
  subject?: Record<string, unknown>;
  admittedBaseRef?: string;
  admittedHeadSha?: string;
  audit: HandoffWakeAudit;
};

export declare function formatHandoffWakeAuditLine(audit: HandoffWakeAudit): string;

export declare function evaluateHandoffPreClaimRecheck(input: {
  planned?: {
    prNumber?: number;
    headSha?: string;
    sessionId?: string;
    admittedBaseRef?: string;
    startReason?: string;
  };
  fresh?: {
    openPrs?: OpenPr[];
    baseRefName?: string;
  };
}): {
  emitReviewRun: boolean;
  reason: string;
  audit?: HandoffWakeAudit;
};

export declare function seedHandoffAdmissionRecord(input: Record<string, unknown>): Record<string, unknown>;

export declare function selectHandoffAdmissionReplay(input: Record<string, unknown>): Record<string, unknown>;

export declare function evaluateHandoffReceiptToRunBound(
  wakeReceivedMs: number,
  runCreatedAtMs: number,
  boundMs?: number,
): {
  withinBound: boolean;
  receiptToRunMs: number | null;
  boundMs: number;
  reason?: string;
};

export declare function seedPendingAdmissionRetry(input: Record<string, unknown>): Record<string, unknown>;

export declare function selectPendingAdmissionRetries(input: Record<string, unknown>): {
  retries: Array<Record<string, unknown>>;
};

export declare function clearPendingAdmissionRetry(input: Record<string, unknown>): Record<string, unknown>;

export declare function getHandoffAdmissionStatePath(stateRoot: string): string;

export declare function loadHandoffAdmissionState(filePath: string): {
  records: Record<string, unknown>;
  pendingRetries: Record<string, unknown>;
  lastUpdatedMs: number | null;
};

export declare function saveHandoffAdmissionState(
  filePath: string,
  state: { records: Record<string, unknown>; lastUpdatedMs: number | null },
): void;
