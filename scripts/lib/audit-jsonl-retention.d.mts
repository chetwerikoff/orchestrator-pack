export type AuditJsonlPolicy = {
  streamId: string;
  maxActiveBytes: number;
  maxTotalBytes: number;
  maxAgeMs: number;
  defaults: Record<string, unknown>;
};

export type AuditJsonlSegment = {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
  ts: number;
};

export function resolveAuditJsonlPolicy(streamId: string, env?: NodeJS.ProcessEnv): AuditJsonlPolicy;
export function maybeMaintainAuditJsonl(
  activePath: string,
  policy: AuditJsonlPolicy,
  log?: (kind: string, fields?: Record<string, unknown>) => void,
): { rotated: boolean; activeSize: number; lockContended?: boolean };
export function appendAuditJsonlLine(
  activePath: string,
  line: string,
  options?: {
    streamId?: string;
    policy?: AuditJsonlPolicy;
    env?: NodeJS.ProcessEnv;
    log?: (kind: string, fields?: Record<string, unknown>) => void;
  },
): void;
export function maintenanceLockPath(activePath: string): string;
export function activeFileSize(activePath: string): number;
export function listSegments(dir: string, activePath: string): AuditJsonlSegment[];
export function pruneSegments(
  dir: string,
  activePath: string,
  policy: AuditJsonlPolicy,
  log?: (kind: string, fields?: Record<string, unknown>) => void,
): void;
export function rotateActiveFile(
  activePath: string,
  policy: AuditJsonlPolicy,
  log?: (kind: string, fields?: Record<string, unknown>) => void,
): void;
export function segmentNameRegex(activePath: string): RegExp;
export function resolveRotationSegmentPath(dir: string, base: string): string | null;
export function rotationStamp(): string;
export function parseCompactRotationTimestamp(compact: string): number;
export function clearStaleMaintenanceLockIfNeeded(
  lockPath: string,
  log?: (kind: string, fields?: Record<string, unknown>) => void,
  env?: NodeJS.ProcessEnv,
): boolean;
export function tryAcquireMaintenanceLock(
  lockPath: string,
  log?: (kind: string, fields?: Record<string, unknown>) => void,
  env?: NodeJS.ProcessEnv,
): boolean;
export function releaseMaintenanceLock(lockPath: string): void;
