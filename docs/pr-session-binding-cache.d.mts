import type { AoSession, OpenPr, RuntimeBindingSource } from './session-pr-binding-resolver.mjs';

export declare const PR_SESSION_BINDING_CACHE_SCHEMA_VERSION = 1;
export declare const PACK_PR_SESSION_BINDING_CACHE_SURFACE: 'pack-pr-session-binding-cache';
export declare const DEFAULT_BINDING_TTL_MS: number;
export declare const DEFAULT_BINDING_MAX_RECORDS: number;
export declare const BINDING_SOURCE_PUSH_REGISTER: 'push_register';
export declare const BINDING_SOURCE_CLAIM_PR: 'claim_pr';
export declare const BINDING_SOURCE_BACKFILL_RESOLVER: 'backfill_resolver';
export declare const PR_SESSION_BINDING_REASON_SET_VERSION = 1;
export declare const PR_SESSION_BINDING_FAIL_CLOSED_REASONS: readonly [
  'no_source',
  'live_ambiguous',
  'stale_cache_no_live',
  'stale_cache_live_ambiguous',
  'binding_cache_conflict',
  'ambiguous_issue_pr_binding',
  'ambiguous_pr_session_binding',
  'head_owner_mismatch',
  'no_worker_session',
  'binding_miss_after_backfill',
  'binding_cache_read_failed',
  'binding_cache_lock_timeout',
  'binding_cache_cas_exhausted',
  'missing_pr_number',
  'missing_session_id',
  'missing_repo_slug',
];

export type BindingSource =
  | typeof BINDING_SOURCE_PUSH_REGISTER
  | typeof BINDING_SOURCE_CLAIM_PR
  | typeof BINDING_SOURCE_BACKFILL_RESOLVER;
export type PrSessionBindingFailClosedReason = typeof PR_SESSION_BINDING_FAIL_CLOSED_REASONS[number];

export interface PrSessionBindingConflict {
  reason?: string;
  winner?: string;
  [key: string]: unknown;
}

export interface PrSessionBindingRecord {
  schemaVersion: number;
  sessionId: string;
  prNumber: number;
  issueNumber?: number | null;
  headSha?: string | null;
  repoSlug: string;
  source: BindingSource;
  lastUpdatedMs: number;
  superseded?: boolean;
  conflict?: PrSessionBindingConflict;
}

export interface PrSessionBindingCacheStore {
  schemaVersion: number;
  lastUpdatedMs: number | null;
  generation: number;
  records: Record<string, PrSessionBindingRecord>;
}

export interface PushRegisterIdentityProof {
  ok: boolean;
  sessionId?: string;
  repoSlug?: string;
  issueNumber?: number;
  reason?: string;
}

export interface SessionConsumerBindingResolution {
  bound: boolean;
  ok: boolean;
  failClosed: boolean;
  sessionId: string | null;
  prNumber?: number;
  source?: 'cache' | 'live';
  bindingSource?: BindingSource | RuntimeBindingSource;
  reason: string;
  deferReason?: string;
  diagnostic?: unknown;
  bindingCacheGeneration?: number;
}

export interface PrConsumerBindingResolution {
  sessionId: string | null;
  conflictingSessionId?: string;
  conflictingSessionIds?: string[];
  reason: string;
  failClosed: boolean;
  deferReason?: string;
  source?: 'cache' | 'backfill_resolver' | 'miss' | RuntimeBindingSource;
  diagnostic?: unknown;
  bindingCacheGeneration?: number;
}

export declare function bindingRecordIsLive(
  record: PrSessionBindingRecord | null | undefined,
  openPrs?: OpenPr[],
  authoritative?: boolean,
  repoSlug?: string,
  nowMs?: number,
  ttlMs?: number,
): boolean;
export declare function resolvePrSessionBindingCachePath(env?: NodeJS.ProcessEnv): string;
export declare function createDefaultPrSessionBindingCache(
  raw?: Partial<PrSessionBindingCacheStore> | Record<string, unknown>,
): PrSessionBindingCacheStore;
export declare function readPrSessionBindingCacheFile(path: string): PrSessionBindingCacheStore;
export declare function writePrSessionBindingCacheFile(
  path: string,
  store: PrSessionBindingCacheStore,
): void;
export declare function writePrSessionBindingCacheFileWithCas(
  path: string,
  store: PrSessionBindingCacheStore,
  expectedGeneration: number,
): { ok: boolean; reason?: string; generation?: number; diagnostic?: string };
export declare function updatePrSessionBindingCacheWithCas(
  cachePath: string,
  mutator: (
    store: PrSessionBindingCacheStore,
    nowMs: number,
  ) => { ok: boolean; reason?: string; diagnostic?: string },
  nowMs?: number,
): { ok: boolean; reason?: string; diagnostic?: string; generation?: number };
export declare const buildSessionBindingKey: (repoSlug: string, sessionId: string) => string;
export declare const buildPrBindingKey: (repoSlug: string, prNumber: number) => string;
export declare function registerPrSessionBindingRecord(
  store: PrSessionBindingCacheStore,
  record: {
    sessionId: string;
    prNumber: number;
    repoSlug: string;
    issueNumber?: number;
    headSha?: string;
    source: BindingSource;
    openPrs?: OpenPr[];
    maxRecords?: number;
    superseded?: boolean;
    conflict?: PrSessionBindingConflict;
  },
  nowMs: number,
): { ok: boolean; reason?: string; diagnostic?: string };
export declare function lookupBindingByPr(
  store: PrSessionBindingCacheStore,
  repoSlug: string,
  prNumber: number,
): PrSessionBindingRecord | null;
export declare function lookupBindingBySession(
  store: PrSessionBindingCacheStore,
  repoSlug: string,
  sessionId: string,
): PrSessionBindingRecord | null;
export declare function evictPrSessionBindings(input: {
  store: PrSessionBindingCacheStore;
  openPrs?: OpenPr[];
  nowMs: number;
  ttlMs?: number;
  maxRecords?: number;
  openListAuthoritative?: boolean;
  repoSlug?: string;
}): { removed: number; recordCount: number };
export declare function resolveSessionPrBindingForConsumer(input: {
  cachePath?: string;
  store?: PrSessionBindingCacheStore;
  env?: NodeJS.ProcessEnv;
  repoSlug: string;
  sessionId?: string;
  session?: AoSession | null;
  openPrs?: OpenPr[];
  headSha?: string;
  nowMs?: number;
  ttlMs?: number;
  openListAuthoritative?: boolean;
  writeBackfill?: boolean;
}): SessionConsumerBindingResolution;
export declare function resolvePrSessionBindingForConsumer(input: {
  cachePath?: string;
  store?: PrSessionBindingCacheStore;
  env?: NodeJS.ProcessEnv;
  repoSlug: string;
  prNumber: number;
  headSha?: string;
  sessions?: AoSession[];
  openPrs?: OpenPr[];
  nowMs?: number;
  writeBackfill?: boolean;
  openListAuthoritative?: boolean;
  isLive?: (session: AoSession) => boolean;
}): PrConsumerBindingResolution;
export declare function resolveBindingRepoSlug(
  options?: { repoSlug?: string },
  openPrs?: OpenPr[],
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): string;
export declare function sessionRowFromAoSessionGetPayload(
  payload: unknown,
): Record<string, unknown> | null;
export declare function loadPushRegisterVerifiedSessions(options?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  sessions?: Array<Record<string, unknown>>;
}): {
  ok: boolean;
  reason?: string;
  sessions: Array<Record<string, unknown>>;
  source?: string;
};
export declare function provePushRegisterWorkerIdentity(
  env?: NodeJS.ProcessEnv,
  options?: {
    claimedSessionId?: string;
    cwd?: string;
    sessions?: Array<Record<string, unknown>>;
  },
): PushRegisterIdentityProof;

export interface PushRegisterOpenPrRow {
  number: number;
  state?: string;
  headRefOid?: string;
  repoSlug?: string;
}

export declare function fetchPriorPrOpenRowForPushRegister(
  repoSlug: string,
  prNumber: number,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): PushRegisterOpenPrRow | null;
export declare function parsePrNumberFromGhPrCreateOutput(stdout?: string, stderr?: string): number;
export declare function isGhPrCreateArgv(argv?: string[]): boolean;
export declare function tryPushRegisterFromPrCreate(input: {
  argv: string[];
  status: number;
  stdout: string;
  stderr: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  sessions?: Array<Record<string, unknown>>;
  fetchPriorPrOpenRow?: (
    repoSlug: string,
    prNumber: number,
    cwd?: string,
    env?: NodeJS.ProcessEnv,
  ) => PushRegisterOpenPrRow | null;
}): { registered: boolean; reason?: string; diagnostic?: string };
