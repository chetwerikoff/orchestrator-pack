export declare const WORKER_STATUS_STORE_SCHEMA_VERSION = 1;
export declare const PACK_WORKER_STATUS_STORE_SURFACE = "pack-worker-status-store";
export declare const KILL_SWITCH_ENV = "PACK_WORKER_STATUS_STORE_DISABLED";
export declare const DEFAULT_FRESHNESS_MS: number;
export declare const DEFAULT_MAX_AGE_MS: number;
export declare const DERIVED_STATUSES: readonly [
  "review_active",
  "ready_for_review",
  "ci_failed",
  "pr_open",
  "needs_input",
  "dead",
  "unknown",
  "stale",
];

export type DerivedWorkerStatus = (typeof DERIVED_STATUSES)[number];

export interface WorkerStatusGenerationVector {
  repoTickGeneration?: number;
  reportStoreGeneration?: number;
  reviewRunGeneration?: number;
  githubGeneration?: number;
  writerSessionId?: string;
}

export interface WorkerStatusRow {
  schemaVersion?: number;
  sessionId: string;
  repoSlug?: string;
  status: DerivedWorkerStatus;
  winningSource?: string;
  diagnostics?: string[];
  degradedReason?: string;
  requiredCheckSource?: string;
  lastUpdatedMs?: number;
  freshnessMs?: number;
  generationVector?: WorkerStatusGenerationVector;
}

export interface WorkerStatusStore {
  schemaVersion: number;
  lastUpdatedMs: number | null;
  generation: number;
  repoTickGeneration: number;
  rows: Record<string, WorkerStatusRow>;
}

export declare function resolveWorkerStatusStorePath(env?: Record<string, unknown>): string;
export declare function createDefaultWorkerStatusStore(raw?: Record<string, unknown>): WorkerStatusStore;
export declare function readWorkerStatusStoreFile(path: string): WorkerStatusStore;
export declare function writeWorkerStatusStoreFile(path: string, store: Record<string, unknown>): void;
export declare function fuseWorkerStatus(input: Record<string, unknown>): {
  status: DerivedWorkerStatus;
  winningSource: string;
  requiredCheckSource?: string;
  diagnostics: string[];
};
export declare function validateReportAgainstHead(
  report: Record<string, unknown> | null | undefined,
  githubHead: string,
  journalFacts?: Record<string, unknown>,
): { valid: boolean; reason: string };
export declare function deriveCiClass(
  ciChecks?: Array<Record<string, unknown>>,
  requiredCheckNames?: string[],
  requiredCheckLookupFailed?: boolean,
): { ciClass: string; requiredCheckSource: string; diagnostics: string[] };
export declare function isRowStale(row: WorkerStatusRow | null | undefined, nowMs?: number, repoTickGeneration?: number): boolean;
export declare function shouldRefuseMonotonicWrite(
  existingRow: WorkerStatusRow | null | undefined,
  writerGenerationVector: WorkerStatusGenerationVector,
): boolean;
export declare function shouldReloadMixedGeneration(
  existingRow: WorkerStatusRow | null | undefined,
  writerGenerationVector: WorkerStatusGenerationVector,
): boolean;
export declare function recomputeWorkerStatusRow(input: Record<string, unknown>): WorkerStatusRow;
export declare function evictWorkerStatusRecords(
  store: Record<string, unknown>,
  sessions: Array<Record<string, unknown>>,
  nowMs?: number,
): { store: WorkerStatusStore; removed: number; recordCount: number };
export declare function mergeWorkerStatusIntoSessions(
  sessions: Array<Record<string, unknown>>,
  store: Record<string, unknown>,
): Array<Record<string, unknown>>;
export declare function evaluateWorkerStatusKillSwitch(env?: Record<string, unknown>): boolean;
export declare function testSiblingReadiness(env?: Record<string, unknown>): {
  ok: boolean;
  workerReportStorePresent: boolean;
  sessionPrBindingResolverPresent: boolean;
  disabled: boolean;
};
export declare function readWorkerStatusForDecision(
  sessionId: string,
  store: Record<string, unknown>,
  nowMs?: number,
): { status: DerivedWorkerStatus; stale: boolean; degradedReason?: string; winningSource?: string; diagnostics: string[] };
