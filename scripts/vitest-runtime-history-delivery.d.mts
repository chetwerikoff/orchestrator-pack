export const PACK_REVIEW_CONTEXT: string;

export type RuntimeHistoryPolicyCheck = {
  context: string;
  appId: number | null;
};

export type RuntimeHistoryPolicy = {
  ok: true;
  strict: boolean;
  checks: RuntimeHistoryPolicyCheck[];
  names: string[];
};

export type RuntimeHistoryFailure = {
  ok: false;
  outcome: string;
  reason: string;
};

export function normalizeCurrentRequiredPolicy(
  policy: unknown,
  options?: { providerProofAvailable?: boolean },
): RuntimeHistoryPolicy | RuntimeHistoryFailure;

export function projectPackReviewStatusHistory(
  history: Array<Record<string, unknown>>,
): Record<string, unknown> & { ok: boolean };

export function evaluateRequiredChecks(input: {
  checks: Array<Record<string, unknown>>;
  policy: RuntimeHistoryPolicy | RuntimeHistoryFailure;
  packReviewProjection: unknown;
  machineAdmissionAttempted?: boolean;
}): {
  action: 'fail' | 'wait' | 'ready' | 'machine-admit';
  outcome?: string;
  reason: string;
};
