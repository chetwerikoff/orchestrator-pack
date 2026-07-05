export declare const PREFLIGHT_SHIELD_VERSION: string;
export declare const DEFAULT_MAX_ATTEMPTS: number;
export declare const DEFAULT_WALL_CLOCK_BUDGET_MS: number;
export declare const DEFAULT_BASE_BACKOFF_MS: number;
export declare const DEFAULT_MAX_BACKOFF_MS: number;

export declare function parseRateLimitHeadersFromStderr(
  stderr: string,
): Record<string, string>;

export declare function hasRateLimitHeaders(headers: Record<string, string>): boolean;

export declare function classifyPreflightGhOutcome(
  input?: Record<string, unknown>,
): {
  disposition: 'success' | 'transient' | 'terminal';
  reason: string;
  transientClass?: string;
  terminalClass?: string;
};

export declare function computePreflightBackoffMs(
  input?: Record<string, unknown>,
): {
  backoffMs: number;
  headerDegraded: boolean;
  source: string;
};

export declare function evaluatePreflightRetryBudget(
  input?: Record<string, unknown>,
): {
  canRetry: boolean;
  canCapture: boolean;
  attemptsRemaining: number;
  elapsedMs: number;
  remainingMs: number;
  budgetMs: number;
  exhaustedReason: string;
};

export declare function shieldBackoffInfraClassification(
  input?: Record<string, unknown>,
): {
  failureClass: string;
  shape: string;
};
