import { createHash } from 'node:crypto';

export const VERIFIED_AO_VERSION = '0.10.3';
export const VERIFIED_AO_SESSION_KEYS = Object.freeze([
  'createdAt',
  'harness',
  'id',
  'isTerminated',
  'issueId',
  'lastActivityAt',
  'projectId',
  'role',
  'status',
  'updatedAt',
] as const);

export interface AoSessionRow {
  createdAt: string;
  harness: string;
  id: string;
  isTerminated: boolean;
  issueId: number;
  lastActivityAt: string;
  projectId: string;
  role: string;
  status: string;
  updatedAt: string;
}

export interface OpenPrSnapshotRow {
  repoSlug: string;
  number: number;
  state: 'OPEN';
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
}

export type CacheSource = 'push_register' | 'claim_pr' | 'backfill_resolver';

export interface BindingCacheRecord {
  sessionId: string;
  prNumber: number;
  currentHeadSha: string;
  source: CacheSource;
  boundAt: string;
  fresh: boolean;
}

export interface AoPreflightInput {
  command: string;
  appStateVersion: string;
  sessions: unknown[];
  sanitizerId: string;
}

export type AoPreflightResult =
  | {
    ok: true;
    command: 'ao session ls --json';
    appStateVersion: '0.10.3';
    normalizedKeys: readonly string[];
    fleetCount: number;
    sanitizerId: string;
  }
  | { ok: false; reason: string };

export type BindingResult =
  | {
    bound: true;
    classId: `B${number}`;
    sessionId: string;
    prNumber: number;
    currentHeadSha: string;
    source: CacheSource | 'issue_correlation';
    boundAt: string;
    corroborated?: boolean;
    retainedConflict?: Record<string, unknown>;
  }
  | {
    bound: false;
    classId: `B${number}`;
    sessionId: string;
    reason:
      | 'no_source'
      | 'live_ambiguous'
      | 'stale_cache_no_live'
      | 'stale_cache_live_ambiguous'
      | 'invalid_open_pr_snapshot';
    context?: Record<string, unknown>;
  };

const SHA40 = /^[0-9a-f]{40}$/;
const CACHE_RANK: Record<CacheSource, number> = {
  push_register: 4,
  claim_pr: 3,
  backfill_resolver: 1,
};
const LIVE_RANK = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizedIssueId(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

export function normalizeAoSessionRow(value: unknown): AoSessionRow | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join('\n') !== [...VERIFIED_AO_SESSION_KEYS].sort().join('\n')) return null;
  const issueId = normalizedIssueId(value.issueId);
  if (!isIso(value.createdAt)
    || typeof value.harness !== 'string'
    || typeof value.id !== 'string'
    || !value.id.trim()
    || typeof value.isTerminated !== 'boolean'
    || issueId === null
    || !isIso(value.lastActivityAt)
    || typeof value.projectId !== 'string'
    || !value.projectId.trim()
    || typeof value.role !== 'string'
    || typeof value.status !== 'string'
    || !isIso(value.updatedAt)) {
    return null;
  }
  return {
    createdAt: value.createdAt,
    harness: value.harness,
    id: value.id,
    isTerminated: value.isTerminated,
    issueId,
    lastActivityAt: value.lastActivityAt,
    projectId: value.projectId,
    role: value.role,
    status: value.status,
    updatedAt: value.updatedAt,
  };
}

export function validateAoSessionRow(value: unknown): boolean {
  return normalizeAoSessionRow(value) !== null;
}

export function validateAoPreflight(input: AoPreflightInput): AoPreflightResult {
  if (input.command !== 'ao session ls --json') return { ok: false, reason: 'preflight_command_mismatch' };
  if (input.appStateVersion !== VERIFIED_AO_VERSION) return { ok: false, reason: 'preflight_version_unverifiable' };
  if (!input.sanitizerId.trim()) return { ok: false, reason: 'preflight_sanitizer_missing' };
  if (!Array.isArray(input.sessions) || input.sessions.length === 0) {
    return { ok: false, reason: 'preflight_empty_fleet' };
  }
  if (!input.sessions.every(validateAoSessionRow)) return { ok: false, reason: 'preflight_schema_mismatch' };
  return {
    ok: true,
    command: 'ao session ls --json',
    appStateVersion: VERIFIED_AO_VERSION,
    normalizedKeys: VERIFIED_AO_SESSION_KEYS,
    fleetCount: input.sessions.length,
    sanitizerId: input.sanitizerId,
  };
}

function stableTimestamp(index: number, offsetMinutes: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, index * 10 + offsetMinutes, 0)).toISOString();
}

export function sanitizeAoSessions(rows: unknown[]): AoSessionRow[] {
  if (!Array.isArray(rows)) throw new Error('preflight_schema_mismatch');
  const normalized = rows.map(normalizeAoSessionRow);
  if (normalized.some((row) => row === null)) throw new Error('preflight_schema_mismatch');
  return (normalized as AoSessionRow[]).map((row, index) => ({
    createdAt: stableTimestamp(index, 0),
    harness: row.harness,
    id: `session-${String(index + 1).padStart(3, '0')}`,
    isTerminated: row.isTerminated,
    issueId: 9_000 + index + 1,
    lastActivityAt: stableTimestamp(index, 1),
    projectId: `project-${String(index + 1).padStart(3, '0')}`,
    role: row.role,
    status: row.status,
    updatedAt: stableTimestamp(index, 2),
  }));
}

export function sanitizerIdentity(rows: AoSessionRow[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(rows)).digest('hex')}`;
}

export function captureLeakReason(value: unknown): string | null {
  const text = JSON.stringify(value);
  const forbidden = [
    /(?:^|[\\/])Users[\\/]/i,
    /\/home\/[A-Za-z0-9._-]+\//,
    /(?:token|password|secret|authorization)["'\s:=]+[^,}\s]{8,}/i,
    /gh[opsu]_[A-Za-z0-9]{20,}/,
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  ];
  if (forbidden.some((pattern) => pattern.test(text))) return 'capture_metadata_secret_scan_failed';
  return null;
}

export async function collectOpenPrSnapshot(
  configuredRepo: string,
  bulkRead: (repo: string) => Promise<unknown[]>,
): Promise<OpenPrSnapshotRow[]> {
  const rows = await bulkRead(configuredRepo);
  if (!Array.isArray(rows)) throw new Error('invalid_open_pr_snapshot');
  return rows.map((value) => {
    if (!isRecord(value)
      || value.repoSlug !== configuredRepo
      || value.state !== 'OPEN'
      || typeof value.isDraft !== 'boolean'
      || !Number.isInteger(value.number)
      || typeof value.headRefName !== 'string'
      || typeof value.headRefOid !== 'string'
      || !SHA40.test(value.headRefOid.toLowerCase())) {
      throw new Error('invalid_open_pr_snapshot');
    }
    return {
      repoSlug: configuredRepo,
      number: Number(value.number),
      state: 'OPEN',
      isDraft: value.isDraft,
      headRefName: value.headRefName,
      headRefOid: value.headRefOid.toLowerCase(),
    };
  });
}

export function branchMatchesIssue(branch: string, issueId: number, iterationBranch = ''): boolean {
  const normalized = branch.trim();
  if (!normalized || !Number.isInteger(issueId) || issueId <= 0) return false;
  if (iterationBranch && normalized === iterationBranch) return true;
  const escaped = String(issueId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forms = [
    new RegExp(`^feat/${escaped}$`),
    new RegExp(`^feat/issue-${escaped}$`),
    new RegExp(`^opk-${escaped}$`),
    new RegExp(`^issue-${escaped}(?:$|[-/])`),
    new RegExp(`(?:^|/)issue-${escaped}(?:$|[-/])`),
  ];
  return forms.some((pattern) => pattern.test(normalized));
}

function eligibleLiveRows(
  session: AoSessionRow,
  rows: OpenPrSnapshotRow[],
  configuredRepo: string,
  iterationBranch: string,
): OpenPrSnapshotRow[] | null {
  if (rows.some((row) => row.repoSlug !== configuredRepo || row.state !== 'OPEN' || typeof row.isDraft !== 'boolean')) {
    return null;
  }
  return rows.filter((row) => !row.isDraft && branchMatchesIssue(row.headRefName, session.issueId, iterationBranch));
}

function cacheBinding(cache: BindingCacheRecord, classId: `B${number}`): BindingResult {
  return {
    bound: true,
    classId,
    sessionId: cache.sessionId,
    prNumber: cache.prNumber,
    currentHeadSha: cache.currentHeadSha,
    source: cache.source,
    boundAt: cache.boundAt,
  };
}

export function resolveFoundationBinding(input: {
  session: AoSessionRow;
  configuredRepo: string;
  openPrs: OpenPrSnapshotRow[];
  cache?: BindingCacheRecord | null;
  iterationBranch?: string;
  now?: string;
}): BindingResult {
  const { session, configuredRepo } = input;
  const cache = input.cache ?? null;
  const eligible = eligibleLiveRows(session, input.openPrs, configuredRepo, input.iterationBranch ?? '');
  if (eligible === null) {
    return { bound: false, classId: 'B1', sessionId: session.id, reason: 'invalid_open_pr_snapshot' };
  }
  const now = input.now ?? new Date().toISOString();
  const live = eligible.length === 1 ? eligible[0] : null;
  const ambiguous = eligible.length > 1;

  if (!cache) {
    if (eligible.length === 0) return { bound: false, classId: 'B1', sessionId: session.id, reason: 'no_source' };
    if (ambiguous) {
      return {
        bound: false,
        classId: 'B3',
        sessionId: session.id,
        reason: 'live_ambiguous',
        context: { reason: 'issue_correlation_ambiguous', candidates: eligible.map((row) => row.number) },
      };
    }
    return {
      bound: true,
      classId: 'B2',
      sessionId: session.id,
      prNumber: live!.number,
      currentHeadSha: live!.headRefOid,
      source: 'issue_correlation',
      boundAt: now,
    };
  }

  if (!cache.fresh) {
    if (eligible.length === 0) {
      return { bound: false, classId: 'B8', sessionId: session.id, reason: 'stale_cache_no_live' };
    }
    if (ambiguous) {
      return {
        bound: false,
        classId: 'B10',
        sessionId: session.id,
        reason: 'stale_cache_live_ambiguous',
        context: { reason: 'issue_correlation_ambiguous', staleCache: cache, candidates: eligible.map((row) => row.number) },
      };
    }
    return {
      bound: true,
      classId: 'B9',
      sessionId: session.id,
      prNumber: live!.number,
      currentHeadSha: live!.headRefOid,
      source: 'issue_correlation',
      boundAt: now,
      retainedConflict: { supersededCache: cache },
    };
  }

  if (eligible.length === 0) return cacheBinding(cache, 'B4');
  if (ambiguous) {
    return {
      ...cacheBinding(cache, 'B7'),
      retainedConflict: { reason: 'issue_correlation_ambiguous', candidates: eligible.map((row) => row.number) },
    } as BindingResult;
  }
  if (cache.prNumber === live!.number && cache.currentHeadSha === live!.headRefOid) {
    return { ...cacheBinding(cache, 'B5'), corroborated: true } as BindingResult;
  }
  if (CACHE_RANK[cache.source] > LIVE_RANK) {
    return { ...cacheBinding(cache, 'B6'), retainedConflict: { live } } as BindingResult;
  }
  return {
    bound: true,
    classId: 'B6',
    sessionId: session.id,
    prNumber: live!.number,
    currentHeadSha: live!.headRefOid,
    source: 'issue_correlation',
    boundAt: now,
    retainedConflict: { cache },
  };
}
