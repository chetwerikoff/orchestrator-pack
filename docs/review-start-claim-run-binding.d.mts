export const REVIEW_START_CLAIM_RUN_BINDING_VERSION: string;
export const MISSING_CLAIM_FOR_REVIEW_RUN: string;
export const MANUAL_OPERATOR_PROVENANCE: Set<string>;
export const PACK_OWNED_AUTOMATED_SURFACES: Set<string>;
export const PACK_OWNED_AUTOMATED_START_REASONS: Set<string>;

export function isPackOwnedAutomatedReviewRun(
  run: Record<string, unknown>,
  options?: { surface?: string; provenanceAutonomous?: boolean; manualOperator?: boolean },
): boolean;

export function isManualOperatorReviewRun(run: Record<string, unknown>): boolean;

export function findVisibleMatchingRun(
  reviewRuns: unknown[],
  prNumber: number,
  headSha: string,
  projectId?: string,
): {
  run: Record<string, unknown>;
  status: string;
  runId: string;
  reviewerSessionId: string;
  createdAt: string;
} | null;

export function findMatchingClaimForRun(
  claims: unknown[],
  run: Record<string, unknown>,
  projectId?: string,
): Record<string, unknown> | null;

export function evaluateAutomatedLaunchClaimGate(args: Record<string, unknown>): Record<string, unknown>;
export function evaluateLaunchPendingRunReconciliation(args: Record<string, unknown>): Record<string, unknown>;
export function applyRunBindingToReclaimDecision(args: Record<string, unknown>): Record<string, unknown>;
export function diagnoseMissingClaimForReviewRun(args: Record<string, unknown>): Record<string, unknown> | null;
export function evaluateCursorGuardOffSurface(args: Record<string, unknown>): Record<string, unknown>;
