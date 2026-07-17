import type { OpenPr, ReviewRun } from './review-trigger-reconcile.d.mts';

export declare const REVIEW_CYCLE_CAP_SCHEMA_VERSION: number;
export declare const DEFAULT_REVIEW_CYCLE_TIER: string;
export declare const TIER_CAP_BY_TIER: Readonly<Record<string, number>>;
export declare const VALID_REVIEW_CYCLE_TIERS: ReadonlySet<string>;
export declare const TERMINAL_CLEAN_EARLY_STOP: string;
export declare const TERMINAL_COMMENTED_EARLY_STOP: string;
export declare const TERMINAL_AT_CAP_OPEN_FINDINGS: string;
export declare const REVIEW_CYCLE_CAP_BUDGET_EXHAUSTED: string;

export type ComplexityTierParseResult =
  | { kind: 'tier'; tier: string }
  | { kind: 'no-tier'; skipLine: true }
  | { kind: 'invalid'; reason: string }
  | { kind: 'missing' };

export type TerminalRunClassification =
  | { kind: 'excluded'; reason: string }
  | { kind: 'in_flight' }
  | { kind: 'clean'; openFindings: 0 }
  | { kind: 'non_blocking'; openFindings: 0 }
  | { kind: 'open_findings'; openFindings: number };

export interface PrCapCycleState {
  tier?: string;
  cap?: number;
  tierFrozen?: boolean;
  cycleOpenedAtUtc?: string | null;
  distinctHeadsReviewed?: string[];
  terminal?: string | null;
  terminalHeadSha?: string | null;
  mergeEligible?: boolean;
  atCapRecord?: Record<string, unknown> | null;
}

export interface ReviewCycleCapGateResult {
  allowStart: boolean;
  reason: string;
  terminal: string | null;
  mergeEligible: boolean;
  capState: Record<string, unknown>;
  prState: PrCapCycleState | null;
  atCapRecord?: Record<string, unknown>;
}

export declare function parseComplexityTierFromIssueBody(
  body: string | null | undefined,
): ComplexityTierParseResult;

export declare function resolveTierAndCap(input?: {
  tier?: string;
  issueBody?: string | null;
  tierFrozen?: boolean;
}): { tier: string; cap: number };

export declare function resolveOpenFindingCount(run: ReviewRun | Record<string, unknown> | null | undefined): number;

export declare function isRunInFlight(run: ReviewRun | null | undefined): boolean;

export declare function isCleanTerminalRun(run: ReviewRun | null | undefined): boolean;

export declare function isCommentedTerminalRun(run: ReviewRun | null | undefined): boolean;

export declare function isZeroFindingFailedOrCancelled(run: ReviewRun | null | undefined): boolean;

export declare function isReaperKilledWithoutVerdict(run: ReviewRun | null | undefined): boolean;

export declare function isSupersededRun(run: ReviewRun | null | undefined): boolean;

export declare function resolveTerminalHeadSnapshot(
  run: ReviewRun | null | undefined,
  currentHeadSha?: string,
): string;

export declare function isStaleHeadTerminal(
  run: ReviewRun | null | undefined,
  currentHeadSha?: string,
): boolean;

export declare function classifyTerminalRun(
  run: ReviewRun | null | undefined,
  currentHeadSha?: string,
): TerminalRunClassification;

export declare function deriveDistinctHeadBudget(
  runs: ReviewRun[],
  prNumber: number,
  currentHeadSha: string,
): Array<{
  targetSha: string;
  classification: TerminalRunClassification;
  completedAt: string | null;
  run: ReviewRun;
}>;

export declare function filterRunsWithinCycleBoundary(
  runs: ReviewRun[],
  cycleOpenedAtUtc: string | null | undefined,
): ReviewRun[];

export declare function resolveCurrentHeadOpenFindingCount(
  runs: ReviewRun[],
  prNumber: number,
  currentHeadSha: string,
): number;

export declare function buildAtCapOpenFindingsRecord(input: {
  prNumber: number;
  headSha: string;
  tier?: string;
  cap?: number;
  distinctHeadsReviewed?: string[];
  openFindingCount?: number;
  cycleOpenedAtUtc?: string;
  terminatedAtUtc?: string;
  producer?: string;
  nowMs?: number;
}): Record<string, unknown>;

export declare function normalizePrCapCycleState(
  raw: Record<string, unknown> | null | undefined,
  prNumber: number,
): PrCapCycleState;

export declare function syncReviewCycleCapState(input: {
  capState?: Record<string, unknown>;
  reviewRuns?: ReviewRun[];
  prNumber: number;
  currentHeadSha: string;
  openPrs?: OpenPr[];
  issueBody?: string | null;
  tier?: string;
  producer?: string;
  nowMs?: number;
}): { capState: Record<string, unknown>; prState: PrCapCycleState };

export declare function evaluateReviewCycleCapGate(input: {
  prNumber: number;
  currentHeadSha?: string;
  openPrs?: OpenPr[];
  reviewRuns?: ReviewRun[];
  capState?: Record<string, unknown>;
  issueBody?: string | null;
  tier?: string;
  mergedPrNumbers?: number[];
  producer?: string;
  nowMs?: number;
}): ReviewCycleCapGateResult;

export declare function applyReviewCycleCapToStartDecision(input: {
  prNumber: number;
  currentHeadSha?: string;
  openPrs?: OpenPr[];
  reviewRuns?: ReviewRun[];
  capState?: Record<string, unknown>;
  issueBody?: string | null;
  tier?: string;
  mergedPrNumbers?: number[];
  producer?: string;
  nowMs?: number;
  startAllowed?: boolean;
  priorReason?: string;
}): {
  start: boolean;
  triggerReviewRun: boolean;
  launch: boolean;
  reason: string;
  capGate: ReviewCycleCapGateResult;
};
