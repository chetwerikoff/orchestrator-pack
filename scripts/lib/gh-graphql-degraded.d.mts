export const CACHE_VERSION: number;
export const RATE_LIMIT_REFRESH_MS: number;
export const RATE_LIMIT_REFRESH_LOCK_STALE_MS: number;
export const AUDIT_LABEL: string;
export const SUPPRESSION_EXIT_CODE: number;
export const PRIMARY_QUOTA_MARKER: string;

export function extractApiHostnameInfo(argv: string[], env?: NodeJS.ProcessEnv): { host: string; explicit: boolean };
export function extractApiHostname(argv: string[], env?: NodeJS.ProcessEnv): string;
export function isGraphqlPassthroughArgv(argv: string[]): boolean;
export function resolveCredentialFingerprint(
  realGh: string,
  env?: NodeJS.ProcessEnv,
  hostname?: string,
  explicitHostname?: boolean,
): string;
export function resolveEnvTokenForHost(env: NodeJS.ProcessEnv, hostname: string): string | null;
export function resolvePartitionKey(realGh: string, argv: string[], env?: NodeJS.ProcessEnv): string;
export function resolveCacheDir(env?: NodeJS.ProcessEnv): string;
export function cacheFilePath(cacheDir: string, partitionKey: string): string;
export function rateLimitRefreshLockPath(cacheDir: string, partitionKey: string): string;
export function tryAcquireRateLimitRefreshLease(
  cacheDir: string,
  partitionKey: string,
  currentMs: number,
): { acquired: boolean; lockPath: string };
export function releaseRateLimitRefreshLease(lockPath: string): void;
export function readDegradedCache(
  cacheDir: string,
  partitionKey: string,
): {
  v: number;
  partition: string;
  degraded: boolean;
  graphqlResetAt: number | null;
  graphqlRemaining: number | null;
  lastRateLimitFetchMs: number;
} | null;
export function writeDegradedCache(
  cacheDir: string,
  partitionKey: string,
  state: {
    degraded: boolean;
    graphqlResetAt: number | null;
    graphqlRemaining: number | null;
    lastRateLimitFetchMs: number;
  },
): {
  v: number;
  partition: string;
  degraded: boolean;
  graphqlResetAt: number | null;
  graphqlRemaining: number | null;
  lastRateLimitFetchMs: number;
};
export function parseRateLimitGraphql(body: unknown): { remaining: number; reset: number } | null;
export function isPrimaryGraphqlQuotaExhaustion(result: {
  stderr?: string;
  stdout?: string;
  exitCode?: number | null;
}): boolean;
export function fetchRateLimitGraphql(
  realGh: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
): { ok: true; remaining: number; reset: number } | { ok: false; error: string };
export function tryGraphqlDegradedPassthrough(
  argv: string[],
  realGh: string,
  options?: { env?: NodeJS.ProcessEnv },
): boolean;
