import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  inferResumeLineageFromOwnershipChange,
  resolvePrOwnerSessionForNudge,
  resolveWorkerTargetFromPrClaim,
  syncPrOwnershipClaimRecord,
} from './worker-nudge-gate.ts';
import { runProcess } from '../kernel/subprocess.ts';
import {
  collectOpenPrSnapshot,
  normalizeAoSessionRow,
  VERIFIED_AO_VERSION,
  type AoSessionRow,
  type OpenPrSnapshotRow,
} from './binding.ts';
import type { FoundationNotificationConfig } from './config.ts';

export interface VerifiedWorkerNotificationTarget {
  sessionId: string;
  workerTarget: string;
  targetId: string;
  targetGeneration: string;
  openPrs: OpenPrSnapshotRow[];
  repoSlug: string;
}

export interface WorkerNotificationTargetDependencies {
  loadAoVersion?: () => Promise<string>;
  loadSessions?: () => Promise<AoSessionRow[]>;
  loadOpenPrs?: (repoSlug: string) => Promise<OpenPrSnapshotRow[]>;
  resolveRepoSlug?: () => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePrefixedJson(text: string, label: string): unknown {
  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  const starts = [objectStart, arrayStart].filter((value) => value >= 0);
  if (!starts.length) throw new Error(`${label}_no_json`);
  const start = Math.min(...starts);
  try {
    return JSON.parse(text.slice(start));
  } catch (error) {
    throw new Error(`${label}_parse_failed:${error instanceof Error ? error.message : String(error)}`);
  }
}

function sessionsFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.sessions)) return payload.sessions;
  return [];
}

function openPrsFromPayload(payload: unknown, repoSlug: string): OpenPrSnapshotRow[] {
  if (!Array.isArray(payload)) throw new Error('invalid_open_pr_snapshot');
  return payload.map((value) => {
    if (!isRecord(value)) throw new Error('invalid_open_pr_snapshot');
    return {
      repoSlug,
      number: Number(value.number),
      state: String(value.state ?? '').toUpperCase() as 'OPEN',
      isDraft: value.isDraft as boolean,
      headRefName: String(value.headRefName ?? ''),
      headRefOid: String(value.headRefOid ?? '').toLowerCase(),
    };
  });
}

function parseRepoSlug(remote: string): string {
  const value = remote.trim().replace(/\.git$/i, '').replace(/\/$/, '');
  const scp = value.match(/^[^@]+@[^:]+:([^/]+\/[^/]+)$/);
  if (scp) return scp[1]!;
  try {
    const parsed = new URL(value);
    const slug = parsed.pathname.replace(/^\//, '');
    if (/^[^/]+\/[^/]+$/.test(slug)) return slug;
  } catch {
    // Fall through to a plain owner/repo form.
  }
  if (/^[^/]+\/[^/]+$/.test(value)) return value;
  throw new Error('repo_slug_unresolved');
}

function findVersion(value: unknown, depth = 0): string | null {
  if (depth > 5 || value === null || value === undefined) return null;
  if (typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value.trim())) return value.trim();
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findVersion(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const key of ['version', 'appVersion', 'currentVersion', 'installedVersion']) {
    const found = findVersion(value[key], depth + 1);
    if (found) return found;
  }
  for (const entry of Object.values(value)) {
    const found = findVersion(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

function aoBaseDir(): string {
  return process.env.AO_BASE_DIR?.trim() || path.join(homedir(), '.agent-orchestrator');
}

function projectRoot(projectId: string): string {
  return path.join(aoBaseDir(), 'projects', projectId);
}

function readRecord(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function writeRecordAtomic(file: string, value: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}

function sessionMetadata(projectId: string, sessionId: string): {
  worktree: string;
  sessionMeta: Record<string, unknown>;
} {
  const file = path.join(projectRoot(projectId), 'sessions', `${sessionId}.json`);
  const meta = readRecord(file) ?? {};
  const runtimeHandle = isRecord(meta.runtimeHandle) ? meta.runtimeHandle : null;
  const runtimeData = runtimeHandle && isRecord(runtimeHandle.data) ? runtimeHandle.data : null;
  const worktree = String(meta.worktree ?? runtimeData?.workspacePath ?? '').trim();
  const sessionMeta: Record<string, unknown> = {};
  for (const key of [
    'restoredAt',
    'resumedAt',
    'parentSessionId',
    'parent_session_id',
    'resumedFromSessionId',
    'resumedFrom',
  ]) {
    if (meta[key] !== undefined && meta[key] !== null && String(meta[key]).trim()) {
      sessionMeta[key] = meta[key];
    }
  }
  return { worktree, sessionMeta };
}

function booleanResult(value: Record<string, unknown>, key: string): boolean {
  return value[key] === true;
}

export async function resolveVerifiedWorkerNotificationTarget(input: {
  trustedPackRoot: string;
  repoRoot: string;
  projectId: string;
  requestedSessionId: string;
  prNumber: number;
  headSha: string;
  config: FoundationNotificationConfig;
  dependencies?: WorkerNotificationTargetDependencies;
}): Promise<VerifiedWorkerNotificationTarget> {
  const dependencies = input.dependencies ?? {};
  const loadAoVersion = dependencies.loadAoVersion ?? (async () => {
    const appStatePath = process.env.AO_APP_STATE_PATH?.trim()
      || path.join(homedir(), '.ao', 'app-state.json');
    const state = readRecord(appStatePath);
    const version = findVersion(state);
    if (!version) throw new Error('preflight_version_unverifiable');
    return version;
  });
  const loadSessions = dependencies.loadSessions ?? (async () => {
    const result = await runProcess({
      command: input.config.aoPath,
      args: ['session', 'ls', '--json'],
      cwd: input.repoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs: input.config.timeoutMs,
    });
    if (!result.ok) throw new Error('ao_session_list_failed');
    const rows = sessionsFromPayload(parsePrefixedJson(result.stdout, 'ao_session_list'));
    if (rows.length === 0) throw new Error('preflight_empty_fleet');
    const normalized = rows.map(normalizeAoSessionRow);
    if (normalized.some((row) => row === null)) throw new Error('preflight_schema_mismatch');
    return normalized as AoSessionRow[];
  });
  const resolveRepoSlug = dependencies.resolveRepoSlug ?? (async () => {
    const result = await runProcess({
      command: 'git',
      args: ['-C', input.repoRoot, 'remote', 'get-url', 'origin'],
      cwd: input.repoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs: input.config.timeoutMs,
    });
    if (!result.ok) throw new Error('repo_slug_unresolved');
    return parseRepoSlug(result.stdout);
  });
  const loadOpenPrs = dependencies.loadOpenPrs ?? (async (repoSlug: string) => {
    const result = await runProcess({
      command: path.join(input.trustedPackRoot, 'scripts', 'gh'),
      args: [
        'pr',
        'list',
        '--repo',
        repoSlug,
        '--state',
        'open',
        '--limit',
        '200',
        '--json',
        'number,headRefName,headRefOid,isDraft,state',
      ],
      cwd: input.repoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs: input.config.timeoutMs,
    });
    if (!result.ok) throw new Error('open_pr_bulk_read_failed');
    const rows = openPrsFromPayload(parsePrefixedJson(result.stdout, 'open_pr_bulk_read'), repoSlug);
    return collectOpenPrSnapshot(repoSlug, async () => rows);
  });

  const [appStateVersion, sessions, repoSlug] = await Promise.all([
    loadAoVersion(),
    loadSessions(),
    resolveRepoSlug(),
  ]);
  if (appStateVersion !== VERIFIED_AO_VERSION) throw new Error('preflight_version_unverifiable');
  const openPrs = await loadOpenPrs(repoSlug);
  // Resolve the current exact-head owner independently. requestedSessionId is
  // diagnostic lineage context from the review run and may legitimately be a
  // terminated predecessor after restore/replacement.
  const owner = resolvePrOwnerSessionForNudge({
    prNumber: input.prNumber,
  });
  if (!owner.ok) throw new Error(owner.reason);
  const ownerSessionId = owner.ownerSessionId.trim();
  if (!ownerSessionId) throw new Error('pr_owner_unresolved');

  const { worktree, sessionMeta } = sessionMetadata(input.projectId, ownerSessionId);
  const claimPath = path.join(projectRoot(input.projectId), 'pr-ownership-claims', `pr-${input.prNumber}.json`);
  const existingClaim = readRecord(claimPath);
  const resume = existingClaim
    ? inferResumeLineageFromOwnershipChange({
      ownerSessionId,
      worktree,
      existingClaim,
      sessionMeta,
    })
    : { resumeLineage: false, reason: 'missing_context' };
  const sync = syncPrOwnershipClaimRecord({
    prNumber: input.prNumber,
    ownerSessionId,
    worktree,
    existingClaim,
    resumeLineage: resume.resumeLineage === true,
  });
  if (!booleanResult(sync, 'ok') || !isRecord(sync.record)) {
    throw new Error(String(sync.reason ?? 'pr_claim_unresolved'));
  }
  if (sync.changed === true) writeRecordAtomic(claimPath, sync.record);

  const target = resolveWorkerTargetFromPrClaim({
    prNumber: input.prNumber,
    sessionId: ownerSessionId,
    headSha: input.headSha,
    sessions,
    openPrs,
    prClaims: [sync.record],
    claimRecord: sync.record,
  });
  if (!booleanResult(target, 'ok') || target.verifiable !== true) {
    throw new Error(String(target.reason ?? 'pr_claim_unresolved'));
  }
  const workerTarget = String(target.workerTarget ?? '').trim();
  const targetId = String(target.targetId ?? '').trim();
  const targetGeneration = String(target.targetGeneration ?? '').trim();
  if (!workerTarget || !targetId || !targetGeneration) throw new Error('pr_claim_unresolved');
  return {
    sessionId: ownerSessionId,
    workerTarget,
    targetId,
    targetGeneration,
    openPrs,
    repoSlug,
  };
}
