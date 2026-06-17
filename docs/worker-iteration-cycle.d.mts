export declare const QUIESCENCE_DEBOUNCE_MS: number;
export declare const NUDGE_EXPIRY_MS: number;
export declare const OPEN_REVISION_STUCK_BOUND_MS: number;
export declare const STALE_PENDING_DELIVERY_BOUND_MS: number;

export declare const CYCLE_SURFACE_QUIESCENT_FALLBACK: 'quiescent_fallback';
export declare const CYCLE_SURFACE_READY_FOR_REVIEW: 'ready_for_review';
export declare const CYCLE_SURFACE_CI_GREEN_NUDGE: 'ci_green_nudge';

export declare function normalizeCanonicalRepoIdentity(repoRoot?: string | null): string;
export declare function evaluateWorkerIterationCycleForPr(input: Record<string, unknown>): Record<string, unknown>;
