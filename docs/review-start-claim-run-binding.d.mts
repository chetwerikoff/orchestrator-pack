export const REVIEW_START_CLAIM_RUN_BINDING_VERSION: string;
export const MISSING_CLAIM_FOR_REVIEW_RUN: string;
export const PACK_OWNED_AUTOMATED_SURFACES: string[];
export const PACK_OWNED_AUTOMATED_START_REASONS: string[];
export const MANUAL_OPERATOR_PROVENANCE: string[];
export const CURSOR_GUARD_OFF_SURFACES: string[];

export function claimMatchesRunKey(
  claim: Record<string, unknown> | null | undefined,
  prNumber: number,
  headSha: string,
  projectNamespace?: string,
): boolean;

export function runMatchesBindingKey(
  run: Record<string, unknown> | null | undefined,
  prNumber: number,
  headSha: string,
  projectNamespace?: string,
): boolean;

export function isManualOperatorProvenance(input?: Record<string, unknown>): boolean;
export function isPackOwnedAutomatedProvenance(input?: Record<string, unknown>): boolean;
export function isClaimLive(claim: Record<string, unknown> | null | undefined): boolean;
export function isClaimReconciled(claim: Record<string, unknown> | null | undefined): boolean;

export function findMatchingClaimForRun(input: Record<string, unknown>): Record<string, unknown>;
export function evaluateAutomatedLaunchClaimGate(input: Record<string, unknown>): Record<string, unknown>;
export function diagnoseMissingClaimForReviewRun(input: Record<string, unknown>): Record<string, unknown>;
export function evaluateLaunchPendingRunBinding(input: Record<string, unknown>): Record<string, unknown>;
export function evaluateLaunchPendingBudgetDecision(input: Record<string, unknown>): Record<string, unknown>;
export function evaluateClaimRunBinding(input: Record<string, unknown>): Record<string, unknown>;
