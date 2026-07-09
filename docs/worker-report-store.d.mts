export declare const WORKER_REPORT_STORE_SCHEMA_VERSION: number;
export declare const PACK_WORKER_REPORT_STORE_SURFACE: string;
export declare const DEFAULT_MAX_AGE_MS: number;
export declare const DEFAULT_NONTERMINAL_MAX_AGE_MS: number;
export declare const WORKER_REPORT_STATES: Readonly<string[]>;

export declare function resolveWorkerReportStorePath(env?: Record<string, unknown>): string;
export declare function buildWorkerReportRecordKey(record: Record<string, unknown>): string;
export declare function createDefaultWorkerReportStore(raw?: Record<string, unknown>): Record<string, unknown>;
export declare function migrateLegacySeedStateToWorkerReportStore(legacy: Record<string, unknown>): Record<string, unknown>;
export declare function readWorkerReportStoreFile(path: string): Record<string, unknown>;
export declare function writeWorkerReportStoreFile(path: string, store: Record<string, unknown>): void;
export declare function upsertWorkerReportRecord(
  store: Record<string, unknown>,
  record: Record<string, unknown>,
  nowMs: number,
): { key: string; record: Record<string, unknown> };
export declare function listWorkerReportRecordsForSession(
  store: Record<string, unknown>,
  repoSlug: string,
  sessionId: string,
): Record<string, unknown>[];
export declare function workerReportRecordToSessionReportRow(record: Record<string, unknown>): Record<string, unknown>;
export declare function mergePackWorkerReportsIntoSessions(
  sessions: Record<string, unknown>[],
  store: Record<string, unknown>,
  repoSlug?: string,
): Record<string, unknown>[];
export declare function evictWorkerReportRecords(input: {
  store: Record<string, unknown>;
  openPrs?: Array<Record<string, unknown>>;
  currentHeadByPr?: Record<string, string>;
  nowMs: number;
  maxAgeMs?: number;
  nonterminalMaxAgeMs?: number;
  openListAuthoritative?: boolean;
}): { removed: number; recordCount: number; store: Record<string, unknown> };
export declare function validateWorkerReportTrustBoundary(input: {
  callerSessionId: string;
  record: Record<string, unknown>;
}): { ok: boolean; reason?: string };
export declare function sessionHasPackWorkerReportReceiptSurface(session: Record<string, unknown>): boolean;
export declare function findPackWorkerAckReportAfterDelivery(
  session: Record<string, unknown>,
  run: Record<string, unknown>,
  sendObservedAtMs: number,
): Record<string, unknown> | null;
export declare function upsertWorkerReportRecordInMemory(input: {
  store: Record<string, unknown>;
  record: Record<string, unknown>;
  callerSessionId: string;
  nowMs: number;
}): { ok: boolean; reason?: string; store?: Record<string, unknown>; key?: string; record?: Record<string, unknown>; generation?: number };
export declare function writeWorkerReportRecordWithCas(input: {
  storePath: string;
  record: Record<string, unknown>;
  callerSessionId: string;
  nowMs: number;
  expectedGeneration?: number;
}): { ok: boolean; reason?: string; key?: string; record?: Record<string, unknown>; generation?: number };
export declare function seedShouldPromoteReadyForReview(
  store: Record<string, unknown>,
  repoSlug: string,
  prNumber: number,
  headSha: string,
  currentHeadSha: string,
): { promote: boolean; reason?: string; record?: Record<string, unknown> };
