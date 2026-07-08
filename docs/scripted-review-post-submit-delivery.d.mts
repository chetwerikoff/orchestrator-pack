export declare function parsePackReviewTerminalStdout(stdout: unknown): {
  ok: boolean;
  reason?: string;
  packVerdict?: 'clean' | 'findings';
  gateVerdict?: 'approved' | 'changes_requested';
};

export declare function buildScriptedReviewDeliveryMessage(input: {
  prNumber?: number;
  runId?: string;
  gateVerdict?: string;
}): { ok: boolean; reason?: string; message?: string };

export declare function resolveSubmittedRunTerminalStatus(
  run: Record<string, unknown> | undefined | null,
): string;

export declare function parseSubmitRunIsoMs(iso: string | undefined): number | null;

export declare function resolveSubmitRunEpochMs(
  run: Record<string, unknown> | undefined | null,
): number | null;

export declare function findSubmittedReviewRun(
  reviewRuns: Array<Record<string, unknown>>,
  submit: { prNumber?: number; targetSha?: string; submitObservedAfterMs?: number },
): {
  ok: boolean;
  reason?: string;
  matchCount?: number;
  runId?: string;
  batchId?: string;
  sessionId?: string;
  status?: string;
};

export declare function resolveSubmitVisibilityConfig(
  env?: Record<string, string | undefined>,
): { visibilityMs: number; intervalMs: number };

export declare const DEFAULT_SUBMIT_VISIBILITY_MS: number;
export declare const DEFAULT_SUBMIT_VISIBILITY_INTERVAL_MS: number;
export declare const ENV_SUBMIT_VISIBILITY_SECONDS: string;
export declare const SUBMIT_BIND_TERMINAL_STATUSES: Set<string>;
export declare const SUBMIT_BIND_LOOKBACK_MS: number;
