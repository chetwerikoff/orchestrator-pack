export declare const DEFAULT_STUCK_AGE_FLOOR_SECONDS: number;
export declare const FAIL_STALE_UPSTREAM_ISSUE: string;
export declare const AO_REVIEW_FAIL_STALE_PATH: string;

export type PaneLiveness = 'healthy' | 'absent' | 'unknown';

export interface PaneProbeResult {
  paneLiveness: PaneLiveness;
  reason?: string;
}

export interface StuckRunClassification {
  classification: string;
  reason: string;
  sessionId: string;
  prUrl: string;
  runId: string;
  targetSha: string;
  ageSeconds: number;
  paneLiveness: PaneLiveness;
  prNumber?: number;
  alertLine?: string;
}

export declare function buildFailStalePath(sessionId: string, runId: string): string;
export declare function parseTimestampMs(value: unknown): number | null;
export declare function computeRunAgeSeconds(
  run: Record<string, unknown>,
  nowMs?: number,
): number;
export declare function isSameHeadRunning(run: Record<string, unknown>, headSha: string): boolean;
export declare function probeReviewerPaneLiveness(input: {
  reviewerHandleId?: string;
  sessions?: Array<Record<string, unknown>>;
  tmuxExists?: ((handleId: string) => 'exists' | 'missing' | 'unavailable' | null) | null;
}): PaneProbeResult;
export declare function classifyStuckSameHeadCandidate(input: {
  run: Record<string, unknown>;
  headSha: string;
  prUrl?: string;
  ageFloorSeconds?: number;
  paneLiveness: PaneLiveness;
  nowMs?: number;
}): StuckRunClassification;
export declare function formatClassifiedAlertLine(action: Record<string, unknown>): string;
export declare function buildSessionReviewsListPath(sessionId: string): string;
export declare function fetchSessionReviewsList(
  baseUrl: string,
  sessionId: string,
): Promise<Record<string, unknown>>;
export declare function defaultTmuxExists(
  handleId: string,
): 'exists' | 'missing' | 'unavailable';
export declare function createJitPaneProbe(input?: {
  sessions?: Array<Record<string, unknown>>;
  tmuxExists?: (handleId: string) => 'exists' | 'missing' | 'unavailable';
  refreshSessions?: (() => Promise<Array<Record<string, unknown>>>) | null;
}): (ctx: { reviewerHandleId: string }) => Promise<PaneProbeResult>;
export declare function justInTimeRevalidate(input: {
  prior: Record<string, unknown>;
  headSha: string;
  listPayload?: unknown;
  refreshListPayload?: (() => Promise<unknown>) | null;
  paneProbe: (ctx: { reviewerHandleId: string }) => PaneProbeResult | Promise<PaneProbeResult>;
  ageFloorSeconds?: number;
  nowMs?: number;
}): Promise<{ ok: boolean; reason?: string; runId?: string; priorRunId?: string; targetSha?: string; status?: string; ageSeconds?: number }>;
export declare function detectFailStaleSurfaceFromProbe(probeResult: unknown): boolean;
export declare function evaluateFailStaleInvocation(input: {
  classification: string;
  paneLiveness: PaneLiveness;
  failStaleSurfaceAvailable?: boolean;
  dryRun?: boolean;
}): Record<string, unknown>;
export declare function runStuckRunReaperTick(
  input?: Record<string, unknown>,
): Promise<Record<string, unknown>>;
