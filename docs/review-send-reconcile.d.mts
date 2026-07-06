export declare const REVIEW_SEND_RECONCILE_REMOVED: boolean;
export declare const REVIEW_SEND_RECONCILE_REMOVED_REASON: string;
export declare const DEFAULT_REVIEW_SEND_INTERVAL_MS: number;
export declare const FIRST_SEND_RUN_STATUS: string;
export declare const INELIGIBLE_FIRST_SEND_STATUSES: ReadonlySet<string>;
export declare const FORBIDDEN_LIFECYCLE_PATTERNS: readonly RegExp[];

import type { AoSession, OpenPr } from './review-trigger-reconcile.d.mts';

export type { AoSession, OpenPr };

export interface ReviewRun {
  id?: string;
  reviewerSessionId?: string;
  prNumber?: number;
  targetSha?: string;
  status?: string;
  openFindingCount?: number;
  deliveredFindingCount?: number;
  deliveredAt?: string | null;
  prReviewStatus?: string;
  linkedSessionId?: string;
}

export interface SentDeliveryRecord {
  runId?: string;
  targetSha?: string;
  sessionId?: string;
  sentAtMs?: number;
}

export interface ReviewSendTrackingState {
  sent?: Record<string, SentDeliveryRecord>;
  lastTickMs?: number;
}

export type ReviewSendAction =
  | {
      type: 'send';
      runId: string;
      prNumber: number;
      targetSha: string;
      sessionId: string;
      dedupeKey: string;
    }
  | {
      type: 'skip';
      runId?: string;
      prNumber?: number;
      targetSha?: string;
      reason: string;
    };

export interface PlanReviewSendInput {
  reviewRuns: ReviewRun[];
  sessions: AoSession[];
  openPrs: OpenPr[];
  mergedPrNumbers?: number[] | Set<number>;
  tracking?: ReviewSendTrackingState;
}

export declare function buildDedupeKey(runId: string, targetSha: string): string;

export declare function resolveSentFindingCount(run: ReviewRun): {
  ok: boolean;
  reason?: string;
  count?: number;
};

export declare function resolveOpenFindingCount(run: ReviewRun): {
  ok: boolean;
  reason?: string;
  count?: number;
};

export declare function isNeedsTriageNeverSentRun(run: ReviewRun): boolean;

export declare function buildMergedPrNumberSet(
  reviewRuns: ReviewRun[],
  sessions: AoSession[],
  openPrs: OpenPr[],
  explicitMerged?: number[] | Set<number>,
): Set<number>;

export declare function countAmbiguousNeedsTriagePeers(
  runs: ReviewRun[],
  target: ReviewRun,
): number;

export declare function evaluateFirstSendCandidate(
  run: ReviewRun,
  sessions: AoSession[],
  openPrs: OpenPr[],
  mergedPrNumbers: Set<number>,
): {
  eligible: boolean;
  reason: string;
  runId?: string;
  prNumber?: number;
  targetSha?: string;
  sessionId?: string;
};

export declare function planReviewSendActions(input: PlanReviewSendInput): {
  actions: ReviewSendAction[];
  mergedPrNumbers: number[];
  removed?: boolean;
  reason?: string;
};

export declare function verifyRunSentStateAfterSend(
  run: ReviewRun | undefined,
  expectedRunId: string,
  expectedTargetSha: string,
): { ok: boolean; reason: string };

export declare function preSendRecheck(
  planned: {
    runId: string;
    prNumber: number;
    targetSha: string;
    sessionId: string;
  },
  fresh: {
    reviewRuns: ReviewRun[];
    sessions: AoSession[];
    openPrs: OpenPr[];
    mergedPrNumbers?: number[] | Set<number>;
  },
): { ok: boolean; reason: string };

export declare function recordSuccessfulSend(
  tracking: ReviewSendTrackingState,
  dedupeKey: string,
  record: {
    runId: string;
    targetSha: string;
    sessionId: string;
    sentAtMs: number;
  },
): ReviewSendTrackingState;

export declare function evaluateReviewSendInterval(input: {
  nowMs: number;
  lastTickMs?: number;
  intervalMs?: number;
}): { ok: boolean; reason?: string; intervalMs: number };

export declare function findForbiddenReviewSendReconcileCommands(
  commandLines: string[],
): Array<{ command: string; pattern: string }>;
