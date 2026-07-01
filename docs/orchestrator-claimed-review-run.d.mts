import type { CiCheck } from './ci-green-wake-reconcile.d.mts';
import type {
  AoSession,
  OpenPr,
  ReviewRun,
} from './review-trigger-reconcile.d.mts';

export declare const ORCHESTRATOR_CLAIMED_REVIEW_RUN_GATE_VERSION: string;
export declare const ATOMIC_REVIEW_START_CLAIM_CAPABILITY: string;
export declare const ORCHESTRATOR_TURN_SURFACE: string;
export declare const AUTONOMOUS_SURFACE_ENV: string;
export declare const CLAIMED_REVIEW_RUN_BYPASS_ENV: string;

export interface CoverageVerdict {
  verdict: 'covered' | 'not_covered' | 'unknown' | 'failed_or_cancelled';
  reason: string;
  status?: string;
  retryEligible?: boolean;
  escalationReason?: string;
}

export interface ScenarioCellResult {
  launch: boolean;
  reason: string;
  coverage: CoverageVerdict;
}

export interface TurnGateResult {
  launch: boolean;
  reason: string;
  stage: string;
  auditShape: string;
  currentHeadSha?: string;
  staleEventHead?: boolean;
  sessionId?: string;
  coverage?: CoverageVerdict;
  escalationReason?: string;
}

export interface BoundaryVerdict {
  allowed: boolean;
  reason: string;
}

export interface PreflightVerdict {
  ok: boolean;
  reason: string;
  auditShape: string;
  markerState?: string;
}

export declare function isNormalizedHeadSha(sha: string | null | undefined): boolean;
export declare function selectCurrentHeadRows(
  reviewRuns: ReviewRun[],
  prNumber: number,
  headSha: string,
): ReviewRun[];
export declare function classifyCurrentHeadCoverage(rows: ReviewRun[]): CoverageVerdict;
export declare function evaluateCurrentHeadCoverage(
  reviewRuns: ReviewRun[],
  prNumber: number,
  headSha: string,
): CoverageVerdict;
export declare function evaluateScenarioMatrixCell(input: {
  claimWindow: 'free' | 'held_by_other' | 'prior_terminal';
  reviewRuns: ReviewRun[];
  prNumber: number;
  headSha: string;
}): ScenarioCellResult;
export declare function evaluateOrchestratorTurnGate(input: {
  prNumber: number;
  eventHeadSha?: string;
  openPrs?: OpenPr[];
  reviewRuns?: ReviewRun[];
  sessions?: AoSession[];
  ciChecks?: CiCheck[];
  requiredCheckNames?: string[];
  requiredCheckLookupFailed?: boolean;
  sessionId?: string;
  claimWindow?: 'free' | 'held_by_other' | 'prior_terminal';
  provenanceAutonomous?: boolean;
  transportFailure?: Record<string, unknown>;
}): TurnGateResult;
export declare function containsRawReviewRunInvocation(commandLine: string): boolean;
export declare function isClaimedReviewRunParentCommandLine(commandLine: string): boolean;
export declare function isAoReviewRunGitWorktreeSetupCommandLine(commandLine: string): boolean;
export declare function isRawReviewRunInvocation(commandLine: string): boolean;
export declare function evaluateAutonomousReviewRunBoundary(input: {
  commandLine?: string;
  autonomousSurface?: boolean;
  claimedBypass?: boolean;
}): BoundaryVerdict;
export declare function findForbiddenAutonomousReviewRunInvocations(
  commandLines: string[],
): Array<{ commandLine: string; verdict: BoundaryVerdict }>;
export declare function evaluateGatePreflight(input: {
  loadedGateVersion: string;
  atomicClaimPresent?: boolean;
  liveCapabilities?: Array<{ id: string; classification: string }>;
}): PreflightVerdict;
export declare function buildRedactedAuditRecord(
  record: Record<string, unknown>,
): Record<string, unknown>;
export declare function buildDenialCoalesceKey(input: Record<string, unknown>): string;
export declare function coalesceDenialAudit(
  existing: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
): Record<string, unknown>;
export declare function loadAutonomousReviewStartCapabilities(
  inventoryPath?: string,
): {
  version: string;
  capabilities: Array<{ id: string; classification: string; path?: string }>;
};
export declare function validateCapabilityInventory(input: {
  repoInventory: Array<{ id: string; classification: string }>;
  liveSurfaces?: Array<{ id: string; classification?: string }>;
}): { ok: boolean; violations: string[] };
