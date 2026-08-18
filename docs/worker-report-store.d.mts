export interface WorkerReportRuntimeIdentity {
  readonly runtime: string;
  readonly id: string;
  readonly generation: string;
}

export interface WorkerReportAssignmentIdentity {
  readonly assignmentId: string;
  readonly generation: number;
  readonly taskId: string;
}

export interface WorkerReportTrustedBinding {
  readonly ok: boolean;
  readonly reason?: string;
  readonly prNumber?: number;
  readonly headSha?: string;
  readonly assignment?: WorkerReportAssignmentIdentity;
  readonly worker?: WorkerReportRuntimeIdentity;
  readonly bindingSource?: string;
}

export declare const WORKER_REPORT_STORE_SCHEMA_VERSION: number;
export declare const PACK_WORKER_REPORT_STORE_SURFACE: string;
export declare const DEFAULT_MAX_AGE_MS: number;
export declare const DEFAULT_NONTERMINAL_MAX_AGE_MS: number;
export declare const WORKER_REPORT_STATES: Readonly<string[]>;

export declare function normalizeWorkerReportAssignment(value: unknown): WorkerReportAssignmentIdentity | null;
export declare function resolveWorkerReportStorePath(env?: Record<string, unknown>): string;
export declare function buildWorkerReportRecordKey(record: Record<string, unknown>): string;
export declare function createDefaultWorkerReportStore(raw?: Record<string, unknown>): Record<string, unknown>;
export declare function normalizeWorkerReportStore(raw: unknown): Record<string, unknown>;
export declare function readWorkerReportStoreFile(path: string): Record<string, unknown>;
export declare function writeWorkerReportStoreFile(path: string, store: Record<string, unknown>): void;
export declare function upsertWorkerReportRecord(
  store: Record<string, any>,
  record: Record<string, any>,
  nowMs: number,
): { key: string; record: Record<string, any> };
export declare function listWorkerReportRecordsForWorker(
  store: Record<string, any>,
  repoSlug: string,
  worker: WorkerReportRuntimeIdentity,
): Array<Record<string, any>>;
export declare function listWorkerReportRecordsForAssignment(
  store: Record<string, any>,
  repoSlug: string,
  assignment: WorkerReportAssignmentIdentity,
): Array<Record<string, any>>;
export declare function workerReportRecordToRuntimeReportRow(record: Record<string, any>): Record<string, unknown>;
export declare function mergePackWorkerReportsIntoWorkers(
  workers: Array<Record<string, any>>,
  store: Record<string, any>,
  repoSlug?: string,
): Array<Record<string, any>>;
export declare function evictWorkerReportRecords(input: {
  store: Record<string, any>;
  openPrs?: Array<Record<string, any>>;
  currentHeadByPr?: Record<string, string>;
  nowMs: number;
  maxAgeMs?: number;
  nonterminalMaxAgeMs?: number;
  openListAuthoritative?: boolean;
  repoSlug?: string;
}): { removed: number; recordCount: number };
export declare function resolveWorkerReportTrustedBinding(input: {
  assignment?: WorkerReportAssignmentIdentity | null;
  worker?: WorkerReportRuntimeIdentity | null;
  openPrs?: Array<Record<string, any>>;
  worktreeHeadSha?: string;
  prNumber?: number;
}): WorkerReportTrustedBinding;
export declare function validateWorkerReportTrustBoundary(input: {
  record: Record<string, any>;
  trustedBinding?: WorkerReportTrustedBinding | null;
}): { ok: boolean; reason?: string };
export declare function workerHasPackWorkerReportReceiptSurface(worker: Record<string, any>): boolean;
export declare function resolvePackWorkerReportDeliveryRunId(input: {
  reportState?: string;
  prNumber?: number;
  headSha?: string;
  deliveryRunId?: string;
  reviewRuns?: Array<Record<string, any>>;
}): string;
export declare function findPackWorkerAckReportAfterDelivery(
  worker: Record<string, any>,
  run: Record<string, any>,
  sendObservedAtMs: number,
): Record<string, any> | null;
export declare function upsertWorkerReportRecordInMemory(input: {
  store: Record<string, any>;
  record: Record<string, any>;
  nowMs: number;
  trustedBinding?: WorkerReportTrustedBinding | null;
}): { ok: boolean; reason?: string; store?: Record<string, any>; key?: string; record?: Record<string, any>; generation?: number };
export declare function writeWorkerReportRecordWithCas(input: {
  storePath: string;
  record: Record<string, any>;
  nowMs: number;
  expectedGeneration: number;
  trustedBinding?: WorkerReportTrustedBinding | null;
}): { ok: boolean; reason?: string; key?: string; record?: Record<string, any>; generation?: number };
export declare function seedShouldPromoteReadyForReview(
  store: Record<string, any>,
  repoSlug: string,
  prNumber: number,
  headSha: string,
  currentHeadSha: string,
): { promote: boolean; reason?: string; record?: Record<string, any> };
