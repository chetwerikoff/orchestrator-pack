export interface CiRedLookupFailureIdentity {
  repo: string;
  prNumber: number;
  requiredCheckContext: string;
  headSha: string;
}

export interface CiRedLookupFailureRecord {
  kind: 'authoritative-check-lookup';
  identity: CiRedLookupFailureIdentity;
  state: 'deferred' | 'parked' | 'resolved';
  createdAtMs: number;
  updatedAtMs: number;
  attempts: number;
  totalAttempts: number;
  nextEligibleAtMs: number;
  lastDeferReason: string;
  parkedReason?: string;
  resolvedAtMs?: number;
}

export interface CiRedWatchdogLedger {
  schemaVersion: number;
  nextSequence: number;
  episodes: Record<string, unknown>;
  lookupFailures: Record<string, CiRedLookupFailureRecord>;
  history: Array<Record<string, unknown>>;
  quarantinedPaths?: string[];
}

export function ciRedLookupFailureKey(input: CiRedLookupFailureIdentity): string;
export function readCiRedWatchdogLedger(storeDir?: string): CiRedWatchdogLedger;
export function recordCiRedWatchdogLookupFailure(input?: {
  storeDir?: string;
  lookup: CiRedLookupFailureIdentity;
  reason?: string;
  nowMs?: number;
  actor?: string;
  config?: Record<string, unknown>;
}): {
  ok: boolean;
  action: 'defer' | 'park';
  reason: string;
  key: string;
  record: CiRedLookupFailureRecord;
};
export function resolveCiRedWatchdogLookupFailure(input?: {
  storeDir?: string;
  lookup: CiRedLookupFailureIdentity;
  nowMs?: number;
  actor?: string;
  config?: Record<string, unknown>;
}): {
  ok: boolean;
  resolved: boolean;
  key: string;
  record?: CiRedLookupFailureRecord;
};
