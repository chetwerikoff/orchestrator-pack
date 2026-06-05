export declare const COMPLETION_MERGE_INTENT_WAKE_KINDS: ReadonlySet<string>;
export declare const WAKE_TO_RUN_DECISION_MAX_MS: 5000;

import type { AoSession, OpenPr, ReviewRun } from './review-trigger-reconcile.d.mts';

export type { AoSession, OpenPr, ReviewRun };

export interface WakeReviewTriggerPlanned {
  prNumber: number;
  headSha: string;
  sessionId: string;
}

export interface WakeReviewTriggerResult {
  triggerReviewRun: boolean;
  reason: string;
  route: string;
  planned?: WakeReviewTriggerPlanned;
  terminationReason?: string;
  processingMs: number;
  withinLatencyBound: boolean;
}

export interface MergeIntentAfterReviewResult {
  mergeable: boolean;
  reason: string;
  forwardWake: boolean;
  covered: boolean;
}

export declare function isCompletionMergeIntentWake(wakeKind: string | null | undefined): boolean;

export declare function findFailedOrCancelledRunOnHead(
  reviewRuns: ReviewRun[],
  prNumber: number,
  headSha: string,
): ReviewRun | null;

export declare function evaluateWakeReviewTrigger(input: {
  wakeKind?: string;
  sessionId?: string;
  prNumber?: number;
  wakeReceivedMs?: number;
  nowMs?: number;
  openPrs?: OpenPr[];
  reviewRuns?: ReviewRun[];
  sessions?: AoSession[];
  ciChecks?: Array<{ name?: string; state?: string; conclusion?: string; status?: string }>;
  requiredCheckNames?: string[];
  requiredCheckLookupFailed?: boolean;
}): WakeReviewTriggerResult;

export declare function evaluateMergeIntentAfterReviewTrigger(input: {
  prNumber: number;
  headSha: string;
  reviewRuns: ReviewRun[];
  reviewDecision?: string;
}): MergeIntentAfterReviewResult;

export declare function amendMergeWakeMessage(
  wakeMessage: string,
  mergeEval: { mergeable?: boolean; reason?: string },
): string;

export declare function evaluateWakePreRunRecheck(input: {
  planned: WakeReviewTriggerPlanned;
  fresh: Record<string, unknown>;
}): {
  emitReviewRun: boolean;
  reason: string;
  decision?: Record<string, unknown>;
};

export declare function findForbiddenReviewWakeCommands(
  commandLines: string[],
): Array<{ command: string; pattern: string }>;

export declare function buildReviewRunArgv(
  sessionId: string,
  reviewCommand: string,
): string[];
