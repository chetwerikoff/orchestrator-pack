export declare const ENVELOPE_EXTERNAL_IO_VERSION: string;
export declare const DEFAULT_ATTEMPT_CEILING_MS: number;
export declare const INFRA_TRANSPORT_FAILURE_CLASS: string;
export declare const INFRA_TRANSPORT_POSITIVE_SHAPES: readonly string[];

export declare function createMonotonicClock(startMs?: number): {
  now: () => number;
  advance: (ms: number) => number;
  set: (ms: number) => number;
};

export declare function readInjectedMonotonicNowMs(
  env?: NodeJS.ProcessEnv,
): number | null;

export declare function getMonotonicNowMs(env?: NodeJS.ProcessEnv): number;

export declare function classifyInfraTransportFailure(
  input?: Record<string, unknown>,
): { failureClass: string | null; shape: string };

export declare function resolveFirstAttemptMonotonicMs(
  claim: Record<string, unknown> | null | undefined,
): number | null;

export declare function resolveReadinessStartMonotonicMs(
  claim: Record<string, unknown> | null | undefined,
): number | null;

export declare function sumInfraPauseMs(
  claim: Record<string, unknown> | null | undefined,
  nowMonotonicMs: number,
): number;

export declare function evaluateReadinessEnvelopeWithPause(args: {
  claim?: Record<string, unknown> | null;
  nowMs?: number;
  nowMonotonicMs?: number;
  config?: Record<string, unknown>;
}): Record<string, unknown>;

export declare function evaluateAttemptCeiling(args: {
  claim?: Record<string, unknown> | null;
  nowMonotonicMs?: number;
  reviewRuns?: unknown[];
  config?: Record<string, unknown>;
}): Record<string, unknown>;

export declare function beginInfraPauseSegment(
  input?: Record<string, unknown>,
): Record<string, unknown>;

export declare function closeInfraPauseSegment(
  input?: Record<string, unknown>,
): Record<string, unknown>;

export declare function clearFirstAttemptOnCoveredHead(
  input?: Record<string, unknown>,
): Record<string, unknown>;
