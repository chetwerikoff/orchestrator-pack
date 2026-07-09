export declare const REPORT_RECEIPT_SURFACE_FOLLOWUP: string;

export declare const SIGNAL_SOURCES: Readonly<{
  reviewTrigger: string;
  deliveryConfirm: string;
  ciGreenWake: string;
  workerSubmit: string;
  ciFailureNotification: string;
}>;

export declare const DEAD_AO_SIGNAL_SURFACES: Readonly<string[]>;

export declare function formatSignalSourceLog(surface: string, source: string): string;
export declare function formatJournalWriteDegradedLog(surface: string, key?: string): string;
export declare function formatReportReceiptSurfaceRemovedLog(surface: string, followup?: string): string;
export declare function assertLiveSignalSourceBinding(source: string): void;
export declare function sessionHasLegacyReportReceiptSurface(session: Record<string, unknown>): boolean;
export declare function isSessionReviewsDeliveredRun(run: Record<string, unknown>): boolean;
export declare function resolveDeliveredRunObservedAtMs(
  run: Record<string, unknown>,
  parseIsoMs?: (iso?: string) => number | null,
): number | null;
export declare function hasReactionDispatchJournalEntries(
  journal?: Record<string, Record<string, unknown>>,
): boolean;
export declare function shouldSuppressNudgeForPendingJournal(
  transitionId: string,
  pendingJournal?: Record<string, { sessionId?: string; sentAtMs?: number; message?: string }>,
): boolean;
export declare function shouldSuppressSubmitForPendingOutcome(
  deliveryId: string,
  pendingOutcomes?: Record<string, { claimKey?: string; submittedAtMs?: number; sessionId?: string }>,
): boolean;
export declare function reviewRunsLackAoWireDeliveredAt(
  reviewRuns: Array<Record<string, unknown>>,
): boolean;
