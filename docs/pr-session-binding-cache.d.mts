export declare const PR_SESSION_BINDING_CACHE_SCHEMA_VERSION = 1;
export declare const PACK_PR_SESSION_BINDING_CACHE_SURFACE: 'pack-pr-session-binding-cache';
export declare const DEFAULT_BINDING_TTL_MS: number;
export declare const DEFAULT_BINDING_MAX_RECORDS: number;

export declare const BINDING_SOURCE_PUSH_REGISTER: 'push_register';
export declare const BINDING_SOURCE_CLAIM_PR: 'claim_pr';
export declare const BINDING_SOURCE_BACKFILL_RESOLVER: 'backfill_resolver';

export type BindingSource =
  | typeof BINDING_SOURCE_PUSH_REGISTER
  | typeof BINDING_SOURCE_CLAIM_PR
  | typeof BINDING_SOURCE_BACKFILL_RESOLVER;

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

export interface ConsumerBindingResolution {
  sessionId: string | null;
  reason: string;
  failClosed: boolean;
  deferReason?: string;
  source?: 'cache' | 'backfill_resolver' | 'miss';
  diagnostic?: string;
}

export declare function resolvePrSessionBindingCachePath(env?: NodeJS.ProcessEnv): string;

export declare function createDefaultPrSessionBindingCache(
  raw?: Record<string, unknown>,
): PrSessionBindingCacheStore;

export declare function readPrSessionBindingCacheFile(path: string): PrSessionBindingCacheStore;

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

export declare function writePrSessionBindingCacheFile(
  path: string,
  store: PrSessionBindingCacheStore,
): void;

export declare function buildSessionBindingKey(repoSlug: string, sessionId: string): string;

export declare function buildPrBindingKey(repoSlug: string, prNumber: number): string;

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

export declare function registerPrSessionBindingRecord(
  store: PrSessionBindingCacheStore,
  record: {
    sessionId: string;
    prNumber: number;
    repoSlug: string;
    issueNumber?: number;
    headSha?: string;
    source: BindingSource;
    openPrs?: Array<Record<string, unknown>>;
    maxRecords?: number;
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
  openPrs?: Array<Record<string, unknown>>;
  nowMs: number;
  ttlMs?: number;
  maxRecords?: number;
  openListAuthoritative?: boolean;
  repoSlug?: string;
}): { removed: number; recordCount: number };

export declare function resolvePrSessionBindingForConsumer(input: {
  cachePath?: string;
  store?: PrSessionBindingCacheStore;
  repoSlug: string;
  prNumber: number;
  headSha?: string;
  sessions: Array<Record<string, unknown>>;
  openPrs?: Array<Record<string, unknown>>;
  sessionDetailsById?: Record<string, { displayName?: string }>;
  nowMs?: number;
  writeBackfill?: boolean;
  isLive?: (session: Record<string, unknown>) => boolean;
}): ConsumerBindingResolution;

export declare function resolveBindingRepoSlug(
  options?: { repoSlug?: string },
  openPrs?: Array<Record<string, unknown>>,
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): string;

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
