import { runProcessSync } from '../kernel/subprocess.ts';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractMarker,
  logicalFingerprint,
  parseLogicalFromCommentBody,
} from './create-issue-stage-record-marker.ts';
import type {
  CommentCensusOptions,
  CommentCensusResult,
  GhFailure,
  GhFailureKind,
  GhTransport,
  LineageDiagnostic,
  ParsedJournalEvent,
  PendingJournalEvent,
  ProjectionSyncResult,
  TrustedComment,
} from './create-issue-stage-record-types.ts';
import { buildCanonicalLineage } from './create-issue-stage-record-lineage.ts';
import {
  PROJECTION_ACCEPTED,
  PROJECTION_IN_PROGRESS,
  PROJECTION_LABELS,
} from './create-issue-stage-record-types.ts';

// Match the existing pack precedent in plugins/ao-codex-pr-reviewer/lib/scope_context.ts.
export const GH_TIMEOUT_MS = 10_000;

export class GhTransportError extends Error {
  readonly failureKind: GhFailureKind;
  readonly timedOut: boolean;

  constructor(message: string, failureKind: GhFailureKind) {
    super(message);
    this.name = 'GhTransportError';
    this.failureKind = failureKind;
    this.timedOut = failureKind === 'timeout';
  }
}

function classifyGhResponse(response: { stderr: string; timedOut?: boolean; terminalRefusal?: boolean }, fallback: string): GhFailure {
  const kind: GhFailureKind = response.timedOut === true
    ? 'timeout'
    : response.terminalRefusal === true
      ? 'terminal-refusal'
      : 'transport';
  return {
    kind,
    message: response.stderr.trim() || fallback,
  };
}


export function withGhDeadline(transport: GhTransport, deadlineMs: number): GhTransport {
  return {
    runGh(argv: string[]) {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        return {
          exitCode: 124,
          stdout: '',
          stderr: 'publication_deadline_exhausted',
          timedOut: true,
        };
      }
      return transport.runGh(argv, remainingMs);
    },
  };
}


export function resolvePackGh(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return join(here, '..', 'gh');
}

export function defaultGhTransport(): GhTransport {
  const gh = resolvePackGh();
  return {
    runGh(argv: string[], timeoutMs = GH_TIMEOUT_MS) {
      const result = runProcessSync({
        command: gh,
        args: argv.slice(1),
        inheritParentEnv: true,
        timeoutMs,
      });
      return {
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        timedOut: result.timedOut,
        terminalRefusal: false,
      };
    },
  };
}

function parseRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`invalid repo ${repo}`);
  return { owner, name };
}

function normalizeComment(raw: Record<string, unknown>): TrustedComment | null {
  const id = Number(raw.id);
  const body = typeof raw.body === 'string' ? raw.body : null;
  const createdAt = typeof raw.created_at === 'string' ? raw.created_at : null;
  const updatedAt = typeof raw.updated_at === 'string' ? raw.updated_at : null;
  const user = raw.user as Record<string, unknown> | undefined;
  const userLogin = typeof user?.login === 'string' ? user.login : null;
  const authorAssociation = typeof raw.author_association === 'string' ? raw.author_association : null;
  if (!Number.isFinite(id) || !body || !createdAt || !updatedAt || !userLogin || !authorAssociation) {
    return null;
  }
  return { id, body, createdAt, updatedAt, userLogin, authorAssociation };
}

export function fetchIssueComments(
  transport: GhTransport,
  repo: string,
  issueNumber: number,
  ownerLogin: string,
  options: CommentCensusOptions = {},
): CommentCensusResult {
  const diagnostics: LineageDiagnostic[] = [];
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? 100));
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? 10));
  const { owner, name } = parseRepo(repo);
  const path = `repos/${owner}/${name}/issues/${issueNumber}/comments`;
  const collected: TrustedComment[] = [];
  let page = 1;
  let commentsComplete = false;

  while (page <= maxPages) {
    const response = transport.runGh([
      'gh',
      'api',
      `${path}?per_page=${pageSize}&page=${page}`,
    ]);
    if (response.exitCode !== 0) {
      diagnostics.push({
        code: 'comments-truncated',
        message: 'comment census transport failed',
      });
      return {
        comments: collected,
        commentsComplete: false,
        diagnostics,
        failure: classifyGhResponse(response, 'comment census transport failed'),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.stdout);
    } catch {
      diagnostics.push({
        code: 'comments-truncated',
        message: 'comment census response malformed',
      });
      return { comments: collected, commentsComplete: false, diagnostics };
    }
    if (!Array.isArray(parsed)) {
      diagnostics.push({
        code: 'comments-truncated',
        message: 'comment census response not an array',
      });
      return { comments: collected, commentsComplete: false, diagnostics };
    }
    if (parsed.length === 0) {
      commentsComplete = true;
      break;
    }
    for (const item of parsed) {
      if (!item || typeof item !== 'object') {
        diagnostics.push({
          code: 'trust-field-incomplete',
          message: 'comment record is not an object',
        });
        return { comments: [], commentsComplete: false, diagnostics };
      }
      const normalized = normalizeComment(item as Record<string, unknown>);
      if (!normalized) {
        diagnostics.push({
          code: 'trust-field-incomplete',
          message: 'comment record missing required trust fields',
        });
        return { comments: [], commentsComplete: false, diagnostics };
      }
      if (normalized.userLogin !== ownerLogin) {
        diagnostics.push({
          code: 'foreign-comment',
          message: `foreign comment ${normalized.id}`,
          commentId: normalized.id,
        });
        continue;
      }
      if (normalized.updatedAt !== normalized.createdAt) {
        diagnostics.push({
          code: 'edited-comment',
          message: `edited comment ${normalized.id}`,
          commentId: normalized.id,
        });
        continue;
      }
      collected.push(normalized);
    }
    if (parsed.length < pageSize) {
      commentsComplete = true;
      break;
    }
    if (page === maxPages) {
      if (options.sentinelProbe === false) {
        diagnostics.push({
          code: 'comments-truncated',
          message: 'comment census hit page ceiling without exhaustion proof',
        });
        return { comments: collected, commentsComplete: false, diagnostics };
      }
      const sentinel = transport.runGh([
        'gh',
        'api',
        `${path}?per_page=${pageSize}&page=${page + 1}`,
      ]);
      if (sentinel.exitCode !== 0) {
        diagnostics.push({
          code: 'comments-truncated',
          message: 'comment census sentinel probe failed',
        });
        return {
          comments: collected,
          commentsComplete: false,
          diagnostics,
          failure: classifyGhResponse(sentinel, 'comment census sentinel probe failed'),
        };
      }
      let sentinelParsed: unknown;
      try {
        sentinelParsed = JSON.parse(sentinel.stdout);
      } catch {
        diagnostics.push({
          code: 'comments-truncated',
          message: 'comment census sentinel response malformed',
        });
        return { comments: collected, commentsComplete: false, diagnostics };
      }
      if (!Array.isArray(sentinelParsed)) {
        diagnostics.push({
          code: 'comments-truncated',
          message: 'comment census sentinel response not an array',
        });
        return { comments: collected, commentsComplete: false, diagnostics };
      }
      commentsComplete = sentinelParsed.length === 0;
      if (!commentsComplete) {
        diagnostics.push({
          code: 'comments-truncated',
          message: 'comment census exceeded configured page ceiling',
        });
      }
      break;
    }
    page += 1;
  }

  return {
    comments: collected.sort((a, b) => {
      const at = Date.parse(a.createdAt);
      const bt = Date.parse(b.createdAt);
      if (at !== bt) return at - bt;
      return a.id - b.id;
    }),
    commentsComplete,
    diagnostics,
  };
}

function readJournalDeliveryEnvelope(body: string): {
  delivery?: 'immediate' | 'delayed';
  deliveryFailureClass?: string;
  firstFailureAt?: string;
} {
  const fence = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!fence) return {};
  try {
    const parsed = JSON.parse(fence[1] ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const record = parsed as {
      delivery?: unknown;
      'delivery-failure-class'?: unknown;
      'first-failure-at'?: unknown;
    };
    const delivery = record.delivery === 'immediate' || record.delivery === 'delayed'
      ? record.delivery
      : undefined;
    const deliveryFailureClass = typeof record['delivery-failure-class'] === 'string'
      ? record['delivery-failure-class']
      : undefined;
    const firstFailureAt = typeof record['first-failure-at'] === 'string'
      ? record['first-failure-at']
      : undefined;
    return { delivery, deliveryFailureClass, firstFailureAt };
  } catch {
    return {};
  }
}

export function parseJournalEvents(comments: TrustedComment[]): {
  events: ParsedJournalEvent[];
  diagnostics: LineageDiagnostic[];
} {
  const events: ParsedJournalEvent[] = [];
  const diagnostics: LineageDiagnostic[] = [];
  for (const comment of comments) {
    if (!extractMarker(comment.body)) continue;
    const logical = parseLogicalFromCommentBody(comment.body);
    if (!logical) {
      diagnostics.push({
        code: 'malformed-marker',
        message: `malformed journal marker in comment ${comment.id}`,
        commentId: comment.id,
      });
      continue;
    }
    const envelope = readJournalDeliveryEnvelope(comment.body);
    events.push({
      schema: logical.schema,
      eventKey: logical['event-key'],
      logical,
      fingerprint: logicalFingerprint(logical),
      commentId: comment.id,
      createdAt: comment.createdAt,
      delivery: envelope.delivery,
      deliveryFailureClass: envelope.deliveryFailureClass,
      firstFailureAt: envelope.firstFailureAt,
    });
  }
  return { events, diagnostics };
}


export function loadIssueJournalCensus(
  transport: GhTransport,
  repo: string,
  issueNumber: number,
  census?: CommentCensusOptions,
) {
  const ownerLogin = fetchRepositoryOwnerLogin(transport, repo);
  const fetched = fetchIssueComments(transport, repo, issueNumber, ownerLogin, census);
  const parsed = parseJournalEvents(fetched.comments);
  const lineage = buildCanonicalLineage(parsed.events);
  return {
    ownerLogin,
    fetched,
    parsed,
    lineage,
    diagnostics: [...fetched.diagnostics, ...parsed.diagnostics, ...lineage.diagnostics],
  };
}

export function fetchRepositoryOwnerLogin(transport: GhTransport, repo: string): string {
  const { owner, name } = parseRepo(repo);
  const response = transport.runGh(['gh', 'api', `repos/${owner}/${name}`, '--jq', '.owner.login']);
  if (response.exitCode !== 0 || !response.stdout.trim()) {
    const failure = classifyGhResponse(response, 'unable to resolve repository owner login');
    throw new GhTransportError(failure.message, failure.kind);
  }
  return response.stdout.trim();
}

export function fetchIssueRevision(transport: GhTransport, repo: string, issueNumber: number): {
  title: string;
  body: string;
  labels: string[];
} {
  const { owner, name } = parseRepo(repo);
  const response = transport.runGh([
    'gh',
    'api',
    `repos/${owner}/${name}/issues/${issueNumber}`,
    '--jq',
    '{title, body, labels: [.labels[].name]}',
  ]);
  if (response.exitCode !== 0) {
    const failure = classifyGhResponse(response, 'unable to read issue revision');
    throw new GhTransportError(failure.message, failure.kind);
  }
  const parsed = JSON.parse(response.stdout) as { title: string; body: string; labels: string[] };
  return parsed;
}

export function createIssueComment(
  transport: GhTransport,
  repo: string,
  issueNumber: number,
  body: string,
): { ok: boolean; commentId?: number; ambiguous?: boolean; timedOut?: boolean; terminalRefusal?: boolean } {
  const { owner, name } = parseRepo(repo);
  const response = transport.runGh([
    'gh',
    'api',
    `repos/${owner}/${name}/issues/${issueNumber}/comments`,
    '-f',
    `body=${body}`,
  ]);
  if (response.exitCode !== 0) {
    return {
      ok: false,
      timedOut: response.timedOut === true,
      terminalRefusal: response.terminalRefusal === true,
    };
  }
  try {
    const parsed = JSON.parse(response.stdout) as { id?: number };
    if (!parsed.id) return { ok: true, ambiguous: true };
    return { ok: true, commentId: Number(parsed.id) };
  } catch {
    return { ok: true, ambiguous: true };
  }
}

export function ensureProjectionLabels(transport: GhTransport, repo: string): LineageDiagnostic[] {
  const diagnostics: LineageDiagnostic[] = [];
  const { owner, name } = parseRepo(repo);
  for (const [label, meta] of Object.entries(PROJECTION_LABELS)) {
    const response = transport.runGh([
      'gh',
      'api',
      `repos/${owner}/${name}/labels/${encodeURIComponent(label)}`,
    ]);
    if (response.exitCode === 0) continue;
    const create = transport.runGh([
      'gh',
      'api',
      `repos/${owner}/${name}/labels`,
      '-f',
      `name=${label}`,
      '-f',
      `description=${meta.description}`,
      '-f',
      `color=${meta.color}`,
    ]);
    if (create.exitCode !== 0) {
      diagnostics.push({
        code: 'comments-truncated',
        message: `label bootstrap failed for ${label}`,
      });
    }
  }
  return diagnostics;
}

export function syncIssueProjectionLabels(
  transport: GhTransport,
  repo: string,
  issueNumber: number,
  desired: typeof PROJECTION_IN_PROGRESS | typeof PROJECTION_ACCEPTED,
  preserveLabels: string[],
): ProjectionSyncResult {
  const diagnostics: LineageDiagnostic[] = [];
  const remove = desired === PROJECTION_ACCEPTED ? PROJECTION_IN_PROGRESS : PROJECTION_ACCEPTED;
  const apply = desired;
  const { owner, name } = parseRepo(repo);
  let current: ReturnType<typeof fetchIssueRevision>;
  try {
    current = fetchIssueRevision(transport, repo, issueNumber);
  } catch {
    return {
      ok: false,
      applied: [],
      removed: [],
      pendingRepair: true,
      diagnostics: [{ code: 'label-sync-failed', message: 'unable to read issue labels for projection synchronization' }],
    };
  }
  const unrelated = current.labels.filter(
    (label) => label !== PROJECTION_IN_PROGRESS && label !== PROJECTION_ACCEPTED,
  );
  const nextLabels = [...new Set([...unrelated, ...preserveLabels.filter((label) => label !== remove), apply])];
  const response = transport.runGh([
    'gh',
    'api',
    `repos/${owner}/${name}/issues/${issueNumber}`,
    '-X',
    'PATCH',
    ...nextLabels.flatMap((label) => ['-f', `labels[]=${label}`]),
  ]);
  if (response.exitCode !== 0) {
    return {
      ok: false,
      applied: [],
      removed: [],
      pendingRepair: true,
      diagnostics: [{
        code: 'label-sync-failed',
        message: 'projection label synchronization failed',
      }],
    };
  }
  return {
    ok: true,
    applied: [apply],
    removed: current.labels.includes(remove) ? [remove] : [],
    pendingRepair: false,
    diagnostics,
  };
}

export function defaultWorkdir(issueNumber: number): string {
  return join(homedir(), '.local', 'state', 'create-issue-draft', String(issueNumber), 'journal');
}

export function pendingPath(workdir: string, eventKey: string): string {
  const safe = eventKey.replace(/[^a-zA-Z0-9:_-]+/g, '_');
  return join(workdir, 'pending', `${safe}.json`);
}

export function writePendingEvent(workdir: string, pending: PendingJournalEvent): void {
  const filePath = pendingPath(workdir, pending.eventKey);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(pending, null, 2), 'utf8');
}

export function readPendingEvent(workdir: string, eventKey: string): PendingJournalEvent | null {
  const filePath = pendingPath(workdir, eventKey);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8')) as PendingJournalEvent;
}

export function clearPendingEvent(workdir: string, eventKey: string): void {
  const filePath = pendingPath(workdir, eventKey);
  if (existsSync(filePath)) unlinkSync(filePath);
}

export function clearPersistedCycleId(workdir: string): void {
  const filePath = cycleIdPath(workdir);
  if (existsSync(filePath)) unlinkSync(filePath);
}

export function listPendingEvents(workdir: string): PendingJournalEvent[] {
  const dir = join(workdir, 'pending');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as PendingJournalEvent);
}

export function cycleIdPath(workdir: string): string {
  return join(workdir, 'active-cycle-id.txt');
}

export function readPersistedCycleId(workdir: string): string | null {
  const filePath = cycleIdPath(workdir);
  if (!existsSync(filePath)) return null;
  const value = readFileSync(filePath, 'utf8').trim();
  return value || null;
}

export function persistCycleId(workdir: string, cycleId: string): void {
  const filePath = cycleIdPath(workdir);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${cycleId}\n`, 'utf8');
}
