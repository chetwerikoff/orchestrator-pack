export type CiFailureProgressProofMode = 'freshness' | 'stale';

export interface CiFailureProgressFreshnessPayload {
  'ci-failure-progress-freshness': {
    freshDecision: string;
  };
}

export interface CiFailureProgressStalePayload {
  'ci-failure-progress-stale': {
    auditReason: string;
  };
}

export type CiFailureProgressProofPayload =
  | CiFailureProgressFreshnessPayload
  | CiFailureProgressStalePayload;

export declare function buildCiFailureProgressProofPayload(
  mode: 'freshness',
): CiFailureProgressFreshnessPayload;
export declare function buildCiFailureProgressProofPayload(
  mode: 'stale',
): CiFailureProgressStalePayload;
export declare function buildCiFailureProgressProofPayload(
  mode: CiFailureProgressProofMode,
): CiFailureProgressProofPayload;

export declare function emitCiFailureProgressProof(mode: CiFailureProgressProofMode): void;
