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

export declare function findSubmittedReviewRun(
  reviewRuns: Array<Record<string, unknown>>,
  submit: { prNumber?: number; targetSha?: string },
): {
  ok: boolean;
  reason?: string;
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
