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
  journalCursor?: number;
  bindingCacheGeneration?: number;
  githubGeneration?: number;
  writerSessionId?: string;
}

export interface WorkerStatusRow {
  schemaVersion?: number;
  sessionId: string;
  repoSlug?: string;
  status: DerivedWorkerStatus;
  derivedStatus?: DerivedWorkerStatus;
  winningSource?: string;
  diagnostics?: string[];
  degradedReason?: string;
  requiredCheckSource?: string;
  lastUpdatedMs?: number;
  freshnessMs?: number;
  freshnessBoundMs?: number;
  missingReportObservedMs?: number;
  generationVector?: WorkerStatusGenerationVector;
  sourceGeneration?: WorkerStatusGenerationVector;
}

export interface WorkerStatusStore {
  schemaVersion: number;
  schemaRejected?: boolean;
  lastUpdatedMs: number | null;
  generation: number;
  repoTickGeneration: number;
  records: Record<string, WorkerStatusRow>;
  rows: Record<string, WorkerStatusRow>;
}

export interface FuseWorkerStatusResult {
  status: DerivedWorkerStatus;
  derivedStatus: DerivedWorkerStatus;
  winningSource: string;
  requiredCheckSource?: string;
  diagnostics: string[];
  degradedReason?: string;
  invalidatedReport?: boolean;
  webhookAccelerated?: boolean;
}

export interface ReportHeadValidation {
  valid: boolean;
  reason: string;
  invalidated?: boolean;
}

export interface RecomputeWorkerStatusRowResult {
  ok: boolean;
  reason?: string;
  row?: WorkerStatusRow;
  store?: WorkerStatusStore;
  reloadedMixedGeneration?: boolean;
}

export declare function resolveWorkerStatusStorePath(env?: Record<string, unknown>): string;
export declare function createDefaultWorkerStatusStore(raw?: Record<string, unknown>): WorkerStatusStore;
export declare function readWorkerStatusStoreFile(path: string): WorkerStatusStore;
export declare function writeWorkerStatusStoreFile(path: string, store: WorkerStatusStore | Record<string, unknown>): void;
export interface WorkerStatusSessionBindingResult {
  ok: boolean;
  reason?: string;
  prNumber?: number;
  headSha?: string;
  bindingSource?: string;
  enriched?: boolean;
}

export declare function resolveWorkerStatusSessionBinding(
  input: Record<string, unknown>,
): WorkerStatusSessionBindingResult;
export declare function fuseWorkerStatus(input: Record<string, unknown>): FuseWorkerStatusResult;
export declare function validateReportAgainstHead(
  report: Record<string, unknown> | null | undefined,
  githubHead: string,
  journalFacts?: Record<string, unknown>,
): ReportHeadValidation;
export declare function deriveCiClass(
  ciChecks?: Array<Record<string, unknown>>,
  requiredCheckNames?: string[],
  requiredCheckLookupFailed?: boolean,
): { ciClass: string; requiredCheckSource: string; diagnostics: string[] };
export declare function isRowStale(row: WorkerStatusRow | null | undefined, nowMs?: number, repoTickGeneration?: number): boolean;
export declare function shouldRefuseMonotonicWrite(
  existingRow: WorkerStatusRow | Record<string, unknown> | null | undefined,
  writerGenerationVector: WorkerStatusGenerationVector,
): boolean;
export declare function shouldReloadMixedGeneration(
  existingRow: WorkerStatusRow | Record<string, unknown> | null | undefined,
  writerGenerationVector: WorkerStatusGenerationVector,
): boolean;
export declare function mergeGenerationVectorMax(
  existingRow?: WorkerStatusRow | Record<string, unknown>,
  writerGenerationVector?: WorkerStatusGenerationVector | Record<string, unknown>,
): WorkerStatusGenerationVector;
export declare function recomputeWorkerStatusRow(
  input: Record<string, unknown>,
): WorkerStatusRow | RecomputeWorkerStatusRowResult;
export declare function evictWorkerStatusRecords(
  store: WorkerStatusStore | Record<string, unknown>,
  sessions: Array<Record<string, unknown>>,
  nowMs?: number,
): { store: WorkerStatusStore; removed: number; recordCount: number };
export declare function mergeWorkerStatusIntoSessions(
  sessions: Array<Record<string, unknown>>,
  store: WorkerStatusStore | Record<string, unknown>,
  nowMs?: number,
  repoTickGeneration?: number,
): Array<Record<string, unknown>>;
export declare function evaluateWorkerStatusKillSwitch(
  env?: Record<string, unknown>,
): { disabled: boolean; reason: string };
export declare function testSiblingReadiness(env?: Record<string, unknown>): {
  ready: boolean;
  ok: boolean;
  workerReportStorePresent: boolean;
  sessionPrBindingResolverPresent: boolean;
  disabled: boolean;
};
export declare function readWorkerStatusForDecision(
  sessionId: string,
  store: WorkerStatusStore | Record<string, unknown>,
  nowMs?: number,
): { status: DerivedWorkerStatus; stale: boolean; degradedReason?: string; winningSource?: string; diagnostics: string[] };
