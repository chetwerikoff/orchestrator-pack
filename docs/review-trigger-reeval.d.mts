export declare const INCIDENT_WAKE_TO_READINESS_DELAY_MS: 77000;
export declare const DEFERRED_WATCH_WINDOW_MS: 300000;
export declare const READINESS_TO_RUN_DECISION_MAX_MS: 5000;
export declare const SCOPED_DEFERRED_HEAD_WATCH_POLL_CLASS: 'scoped_deferred_head_watch';
export declare const REPORT_STATE_SEED_START_REASON: 'report_state_seed';
export declare const IN_PROGRESS_REPORT_STATES: ReadonlySet<string>;
export declare const MECHANICAL_FORBIDDEN_REVIEW_REEVAL: readonly RegExp[];

import type { AoSession, OpenPr, ReviewRun } from './review-trigger-reconcile.d.mts';

export type { AoSession, OpenPr, ReviewRun };

export interface WatchEntry {
  prNumber: number;
  headSha: string;
  sessionId: string;
  seedMs: number;
  windowExpiresMs: number;
  seedSource: string;
  deferReason?: string;
  deferPrimary?: string;
  pollClass: string;
  lastObservedReadyMs: number | null;
  lastEvaluatedMs: number;
  status: string;
}

export interface HeadReviewTriggerDecision {
  triggerReviewRun: boolean;
  reason: string;
  route: string;
  entryPath?: string;
  planned?: { prNumber: number; headSha: string; sessionId: string };
  terminationReason?: string;
  processingMs: number;
  withinLatencyBound: boolean;
  retainWatch?: boolean;
  record?: Record<string, unknown>;
  currentHeadSha?: string;
}

export type ReevalWatchAction =
  | { type: 'start_review'; prNumber: number; headSha: string; sessionId: string; startReason?: string; reason?: string; processingMs?: number; withinLatencyBound?: boolean; watchKey?: string }
  | { type: 'retain_watch'; prNumber: number; headSha: string; reason: string }
  | { type: 'hand_to_backstop'; prNumber: number; headSha: string; reason: string }
  | { type: 'empty_review_trap'; prNumber: number; headSha: string; terminationReason?: string }
  | { type: 'escalate_degraded_ci'; prNumber: number; headSha: string; reason: string }
  | { type: 'skip'; prNumber: number; headSha: string; reason: string };

export declare function watchEntryKey(prNumber: number, headSha: string): string;

export declare function isDeferredNotReadySeedEligible(
  deferReason: string | null | undefined,
  deferRecord?: { primary?: string; failedComponents?: string[]; branch?: string } | null,
): boolean;

export declare function isDeferredReevalWatchSeedEligible(
  deferReason: string | null | undefined,
  deferRecord?: { primary?: string; failedComponents?: string[]; branch?: string } | null,
): boolean;

export declare function createWatchEntry(input: {
  prNumber: number;
  headSha: string;
  sessionId: string;
  nowMs?: number;
  seedSource?: string;
  deferReason?: string;
  deferPrimary?: string;
  windowMs?: number;
}): WatchEntry;

export declare function isWatchWindowNonConformant(windowMs?: number): boolean;

export declare function pruneExpiredWatchEntries(
  entries: Record<string, WatchEntry>,
  nowMs?: number,
): Record<string, WatchEntry>;

export declare function mergeWatchState(
  existing: Record<string, WatchEntry>,
  incoming: Record<string, WatchEntry>,
  nowMs?: number,
): Record<string, WatchEntry>;

export declare function hasInProgressReportForHead(
  session: AoSession | null | undefined,
  headSha: string,
  options?: { headCommittedAtMs?: number },
): boolean;

export declare function evaluateBackstopOnlyZeroSignal(input: {
  prNumber: number;
  headSha: string;
  session?: AoSession | null;
  hadCompletionWake?: boolean;
}): { backstopOnly: boolean; reason: string };

export declare function detectReadinessTransition(input: {
  session?: AoSession | null;
  headSha: string;
  priorReadyMs?: number | null;
  bindingOptions?: { headCommittedAtMs?: number };
  nowMs?: number;
}): { transitioned: boolean; readyNow: boolean; readinessObservedMs: number | null };

export declare function evaluateHeadReviewTriggerDecision(input: {
  prNumber: number;
  headSha?: string;
  sessionId?: string;
  readinessObservedMs?: number;
  nowMs?: number;
  snapshotError?: boolean;
  openPrs?: OpenPr[];
  reviewRuns?: ReviewRun[];
  sessions?: AoSession[];
  ciChecks?: Array<{ name?: string; state?: string; conclusion?: string; status?: string }>;
  requiredCheckNames?: string[];
  requiredCheckLookupFailed?: boolean;
  entryPath?: string;
}): HeadReviewTriggerDecision;

export declare function evaluateDeferredWatchEntry(input: Record<string, unknown>): HeadReviewTriggerDecision & {
  readiness?: Record<string, unknown>;
  expired?: boolean;
  nextEntry?: WatchEntry;
  watchKey?: string;
};

export declare function planDeferredWatchTick(input: Record<string, unknown>): {
  actions: ReevalWatchAction[];
  watchEntries: Record<string, WatchEntry>;
  pollClass: string;
};

export declare function mergeWatchState(
  existing: Record<string, WatchEntry>,
  incoming: Record<string, WatchEntry>,
  nowMs?: number,
): Record<string, WatchEntry>;

export declare function resolveMergedWatchStatus(
  priorStatus?: string,
  incomingStatus?: string,
): string;

export declare function revertTriggeredWatchOnAbort(
  entries: Record<string, WatchEntry>,
  watchKey: string,
  nowMs?: number,
): Record<string, WatchEntry>;

export declare function seedWatchFromInProgressSignals(input: Record<string, unknown>): {
  watchEntries: Record<string, WatchEntry>;
  seededKeys: string[];
};

export declare function seedWatchFromWakeDefer(input: Record<string, unknown>): {
  seeded: boolean;
  reason?: string;
  watchKey?: string;
  watchEntries?: Record<string, WatchEntry>;
};

export declare function evaluateReadyForReviewNotificationCapture(body: Record<string, unknown>): {
  emitsNotification: boolean;
  priority?: string;
  filteredByListener: boolean;
  requiresScopedDeferredHeadWatch: boolean;
  wakeKind?: string;
};

export declare function findForbiddenReviewReevalCommands(
  commandLines: string[],
): Array<{ command: string; pattern: string }>;

export declare function buildReviewRunArgv(
  sessionId: string,
  reviewCommand: string,
): string[];

export declare function buildNoStartDecisionRecord(input: Record<string, unknown>): Record<string, unknown>;

export declare function preRunHeadReadyRecheck(
  planned: { prNumber: number; headSha: string; sessionId: string },
  fresh: Record<string, unknown>,
): { emitReviewRun: boolean; reason: string; decision?: Record<string, unknown> };

export declare function resolveStartReasonForWatchEntry(entry: Record<string, unknown> | null | undefined): string;
export declare function seedWatchFromReportStatePoll(input: Record<string, unknown>): { watchEntries: Record<string, object>; seededKeys: string[] };
