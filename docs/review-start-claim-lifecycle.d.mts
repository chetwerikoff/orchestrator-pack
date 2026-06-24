export const CLAIM_LIFECYCLE_SCHEMA_VERSION: number;
export const DEFAULT_READINESS_ENVELOPE_MS: number;
export const DEFAULT_HOLD_BUDGET_MS: number;
export const DEFAULT_LAUNCH_PENDING_BUDGET_MS: number;
export const DEFAULT_VISIBILITY_BUDGET_MS: number;
export const DEFAULT_REAPER_PERIOD_SECONDS: number;
export const COVERED_RUN_STATUSES: string[];
export const IN_FLIGHT_RUN_STATUSES: string[];
export const TERMINAL_OUTCOME_RETRY_ELIGIBLE: Record<string, boolean>;

export function resolveClaimLifecycleConfig(
  config?: Record<string, unknown>,
  env?: NodeJS.ProcessEnv,
): {
  readinessEnvelopeMs: number;
  holdBudgetMs: number;
  launchPendingBudgetMs: number;
  visibilityBudgetMs: number;
  reaperPeriodSeconds: number;
};

export function classifyClaimHolderLiveness(
  holder: Record<string, unknown> | null | undefined,
  options?: Record<string, unknown>,
): { outcome: string; reason: string };

export function findCoveringRunForKey(
  reviewRuns: unknown[],
  prNumber: number,
  headSha: string,
): { run: Record<string, unknown>; status: string; runId: string } | null;

export function hasInFlightCoveringRun(
  reviewRuns: unknown[],
  prNumber: number,
  headSha: string,
): boolean;

export function evaluateLaunchPending(args: Record<string, unknown>): Record<string, unknown>;
export function evaluateHoldBudget(args: Record<string, unknown>): Record<string, unknown>;
export function evaluateReadinessEnvelope(args: Record<string, unknown>): Record<string, unknown>;
export function evaluateVisibilityFence(args: Record<string, unknown>): Record<string, unknown>;
export function evaluateReclaimDecision(args: Record<string, unknown>): Record<string, unknown>;
export function evaluateSweep(args: Record<string, unknown>): Record<string, unknown>;
