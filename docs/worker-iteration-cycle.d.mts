export declare const QUIESCENCE_DEBOUNCE_MS: number;
export declare const NUDGE_EXPIRY_MS: number;
export declare const OPEN_REVISION_STUCK_BOUND_MS: number;
export declare const STALE_PENDING_DELIVERY_BOUND_MS: number;

export declare const CYCLE_SURFACE_QUIESCENT_FALLBACK: 'quiescent_fallback';
export declare const CYCLE_SURFACE_READY_FOR_REVIEW: 'ready_for_review';
export declare const CYCLE_SURFACE_CI_GREEN_NUDGE: 'ci_green_nudge';

export declare const IN_FLIGHT_REVISION_STATUSES: ReadonlySet<string>;
export declare const TERMINAL_REVISION_RELEASE_STATUSES: ReadonlySet<string>;
export declare const BLOCKER_PRECEDENCE: readonly string[];
export declare const ACTIVELY_WORKING_REPORT_STATES: ReadonlySet<string>;

export declare function normalizeCanonicalRepoIdentity(repoRoot?: string | null): string;
export declare function buildPrScopedKey(repoId: string, prNumber: number): string;
export declare function buildOwnerCycleKey(
  repoId: string,
  prNumber: number,
  ownerSessionId: string,
): string;
export declare function buildSurfaceStateKey(
  surface: string,
  repoId: string,
  prNumber: number,
  ownerSessionId?: string,
): string;
export declare function getPrRevisionLock(
  state: Record<string, unknown>,
  repoId: string,
  prNumber: number,
): Record<string, unknown> | null;
export declare function getOwnerCycleRecord(
  state: Record<string, unknown>,
  repoId: string,
  prNumber: number,
  ownerSessionId: string,
): Record<string, unknown> | null;
export declare function choosePrimaryBlocker(blockers: string[]): string | null;
export declare function coalesceSuppressAudit(
  cycle: Record<string, unknown> | null,
  branch: string,
  headSha: string,
  blockers: string[],
): Record<string, unknown>;
export declare function listPrReviewRuns(
  runs: Array<Record<string, unknown>>,
  prNumber: number,
): Array<Record<string, unknown>>;
export declare function isRevisionTerminalReleased(run: Record<string, unknown>): boolean;
export declare function isRevisionDrained(
  run: Record<string, unknown>,
  session: Record<string, unknown> | null,
  workerDeliveries: Array<Record<string, unknown>>,
  currentHeadSha: string,
  options?: Record<string, unknown>,
): boolean;
export declare function evaluateOpenReviewRevision(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateStalePendingDelivery(
  session: Record<string, unknown>,
  sessionId: string,
  workerDeliveries: Array<Record<string, unknown>>,
  nowMs: number,
  firstSeenAtMs: number,
): { stale: boolean; pending: boolean };
export declare function resolveOrAdvanceOwnerCycle(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateReadyForReviewSettleDebounce(
  input: Record<string, unknown>,
): Record<string, unknown>;
export declare function evaluateReviewCycleGate(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateNudgeCycleGate(input: Record<string, unknown>): Record<string, unknown>;
export declare function evaluateSettleActionPrecedence(input: Record<string, unknown>): Record<string, unknown>;
export declare function patchOwnerCycle(
  cycle: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown>;
export declare function bootstrapLegacyNudgedCycle(
  cycleState: Record<string, unknown>,
  legacyNudged: Record<string, { sessionId?: string; sentAtMs?: number }>,
  prNumber: number,
  ownerSessionId: string,
): Record<string, unknown>;
export declare function isWorkerSettledIdle(
  session: Record<string, unknown>,
  headSha: string,
  nowMs: number,
  options?: Record<string, unknown>,
): boolean;
export declare function commitOwnerCyclePatch(
  state: Record<string, unknown>,
  repoId: string,
  prNumber: number,
  ownerSessionId: string,
  patch: Record<string, unknown>,
): Record<string, unknown>;
export declare function commitReviewStartedCycleState(
  cycleState: Record<string, unknown>,
  input: {
    repoId: string;
    prNumber: number;
    ownerSessionId: string;
    cycle?: Record<string, unknown>;
    isQuiescentFallback?: boolean;
  },
): Record<string, unknown>;
export declare function commitRevisionLock(
  state: Record<string, unknown>,
  repoId: string,
  prNumber: number,
  lock: Record<string, unknown>,
): Record<string, unknown>;
export declare function evaluateWorkerIterationCycleForPr(
  input: Record<string, unknown>,
): Record<string, unknown>;
