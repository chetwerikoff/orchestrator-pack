import { createHash } from 'node:crypto';
import { branchMatchesIssue } from './binding.ts';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((row): row is Record<string, unknown> => row !== null) : [];
}

function sessionId(session: Record<string, unknown>): string {
  for (const key of ['name', 'sessionId', 'id']) {
    const value = String(session[key] ?? '').trim();
    if (value) return value;
  }
  return '';
}

function normalizeHeadSha(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function liveWorker(session: Record<string, unknown>): boolean {
  if (session.isTerminated === true) return false;
  const status = String(session.status ?? '').trim().toLowerCase();
  if (['terminated', 'closed', 'failed', 'dead', 'stopped'].includes(status)) return false;
  const role = String(session.role ?? session.kind ?? '').trim().toLowerCase();
  return role === 'worker' || role === 'coding';
}

function issueNumber(session: Record<string, unknown>): number {
  return Number(session.issueId ?? session.issue ?? 0);
}

export function canonicalizeStorePath(storePath: string): string {
  let normalized = String(storePath ?? '').trim();
  if (!normalized) return '';
  const wsl = normalized.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (wsl) normalized = `${wsl[1]!.toUpperCase()}:/${wsl[2]}`;
  normalized = normalized.replace(/\\/g, '/');
  if (/^[a-z]:\//i.test(normalized)) normalized = normalized[0]!.toLowerCase() + normalized.slice(1);
  return normalized.toLowerCase();
}

export function hashNudgeMessageContent(message: string): string {
  const normalized = String(message ?? '').replace(/\r\n/g, '\n').trim();
  return normalized ? createHash('sha256').update(normalized, 'utf8').digest('hex') : '';
}

export function inferResumeLineageFromOwnershipChange(input: {
  existingClaim?: Record<string, unknown> | null;
  ownerSessionId?: string;
  worktree?: string;
  sessionMeta?: Record<string, unknown>;
}): { resumeLineage: boolean; reason: string } {
  const existing = input.existingClaim ?? null;
  const owner = String(input.ownerSessionId ?? '').trim();
  if (!existing || !owner) return { resumeLineage: false, reason: 'missing_context' };
  const priorOwner = String(existing.ownerSessionId ?? '').trim();
  if (!priorOwner || priorOwner === owner) return { resumeLineage: false, reason: 'same_owner' };
  const worktree = canonicalizeStorePath(String(input.worktree ?? ''));
  const priorWorktree = canonicalizeStorePath(String(existing.worktree ?? ''));
  if (!worktree || !priorWorktree || worktree !== priorWorktree) {
    return { resumeLineage: false, reason: 'worktree_changed' };
  }
  const meta = input.sessionMeta ?? {};
  const restoredAt = String(meta.restoredAt ?? meta.resumedAt ?? '').trim();
  const parentSessionId = String(meta.parentSessionId ?? meta.parent_session_id ?? '').trim();
  const resumedFrom = String(meta.resumedFromSessionId ?? meta.resumedFrom ?? '').trim();
  return restoredAt || parentSessionId === priorOwner || resumedFrom === priorOwner
    ? { resumeLineage: true, reason: 'same_worktree_resume_signal' }
    : { resumeLineage: false, reason: 'replacement_without_resume_signal' };
}

export function syncPrOwnershipClaimRecord(input: {
  prNumber: number;
  ownerSessionId: string;
  worktree?: string;
  workspacePath?: string;
  existingClaim?: Record<string, unknown> | null;
  resumeLineage?: boolean;
  resumeSameLineage?: boolean;
}): { ok: boolean; changed?: boolean; reason: string; record?: Record<string, unknown> } {
  const prNumber = Number(input.prNumber);
  const owner = String(input.ownerSessionId ?? '').trim();
  const worktree = canonicalizeStorePath(String(input.worktree ?? input.workspacePath ?? ''));
  const existing = input.existingClaim ?? null;
  const nowIso = new Date().toISOString();
  if (!prNumber || !owner) return { ok: false, reason: 'missing_owner' };
  if (!existing || !existing.generation) {
    return {
      ok: true,
      changed: true,
      reason: 'initialized',
      record: {
        prNumber,
        ownerSessionId: owner,
        generation: owner,
        lineageId: owner,
        worktree,
        claimedAtUtc: nowIso,
        updatedAtUtc: nowIso,
      },
    };
  }
  const priorOwner = String(existing.ownerSessionId ?? '').trim();
  const priorWorktree = canonicalizeStorePath(String(existing.worktree ?? ''));
  if (priorOwner === owner) {
    return {
      ok: true,
      changed: false,
      reason: 'same_owner',
      record: { ...existing, ownerSessionId: owner, worktree: worktree || priorWorktree, updatedAtUtc: nowIso },
    };
  }
  if (input.resumeLineage === true || input.resumeSameLineage === true) {
    return {
      ok: true,
      changed: true,
      reason: 'resume_same_lineage',
      record: { ...existing, ownerSessionId: owner, worktree: worktree || priorWorktree, updatedAtUtc: nowIso },
    };
  }
  return {
    ok: true,
    changed: true,
    reason: 'replacement_claim',
    record: {
      prNumber,
      ownerSessionId: owner,
      generation: owner,
      lineageId: owner,
      worktree,
      claimedAtUtc: nowIso,
      updatedAtUtc: nowIso,
      replacedOwnerSessionId: priorOwner || null,
    },
  };
}

export function resolvePrOwnerSessionForNudge(input: {
  prNumber: number;
  headSha?: string;
  sessions?: unknown[];
  openPrs?: unknown[];
}): { ok: true; ownerSessionId: string } | { ok: false; reason: string } {
  const prNumber = Number(input.prNumber);
  const headSha = normalizeHeadSha(input.headSha);
  const openPrs = toRecords(input.openPrs);
  const exactPr = openPrs.find((row) =>
    Number(row.number) === prNumber
    && String(row.state ?? '').toUpperCase() === 'OPEN'
    && row.isDraft !== true
    && (!headSha || normalizeHeadSha(row.headRefOid) === headSha),
  );
  if (!exactPr) return { ok: false, reason: 'pr_owner_unresolved' };
  const branch = String(exactPr.headRefName ?? '');
  const candidates = toRecords(input.sessions).filter((session) =>
    liveWorker(session)
    && branchMatchesIssue(branch, issueNumber(session)),
  );
  if (candidates.length !== 1) {
    return { ok: false, reason: candidates.length > 1 ? 'pr_owner_ambiguous' : 'pr_owner_unresolved' };
  }
  const ownerSessionId = sessionId(candidates[0]!);
  return ownerSessionId
    ? { ok: true, ownerSessionId }
    : { ok: false, reason: 'pr_owner_unresolved' };
}

export function resolveWorkerTargetFromPrClaim(input: {
  prNumber: number;
  sessionId: string;
  claimRecord?: Record<string, unknown> | null;
  prClaims?: unknown[];
}): Record<string, unknown> {
  const prNumber = Number(input.prNumber);
  const requestedSessionId = String(input.sessionId ?? '').trim();
  if (!prNumber || !requestedSessionId) return { ok: false, reason: 'missing_pr_or_session', verifiable: false };
  const claims = toRecords(input.prClaims);
  const claim = claims.find((row) => Number(row.prNumber) === prNumber) ?? input.claimRecord ?? null;
  const ownerSessionId = String(claim?.ownerSessionId ?? '').trim();
  const targetGeneration = String(claim?.generation ?? '').trim();
  const targetId = String(claim?.logicalWorkerId ?? claim?.lineageId ?? targetGeneration).trim();
  if (!claim || ownerSessionId !== requestedSessionId || !targetId || !targetGeneration) {
    return { ok: false, reason: 'pr_claim_unresolved', verifiable: false };
  }
  return {
    ok: true,
    verifiable: true,
    targetId,
    targetGeneration,
    workerTarget: `${targetId}:${targetGeneration}`,
    logicalWorkerId: targetId,
    sessionGeneration: targetGeneration,
    rawSessionId: requestedSessionId,
    ownerSessionId,
    lineageId: String(claim.lineageId ?? targetGeneration),
    targetResolutionSource: claims.length ? 'pr-claim-record' : 'ao-pr-ownership-claim',
  };
}
