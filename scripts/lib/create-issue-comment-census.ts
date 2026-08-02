import type { GhTransport, TrustedComment } from './create-issue-stage-record-types.ts';
import {
  buildTopologyRecord,
  buildSourceRecords,
  COMMENT_BODY_UTF8_LIMIT,
  ISSUE_COMMENT_PAGE_SIZE,
  MAX_ISSUE_COMMENT_CENSUS,
  MAX_ISSUE_COMMENT_PAGES,
  parseRecordMarker,
  parseTopologyRecord,
  parseSourceRecord,
  sha256,
  type ParsedRecordMarker,
} from './create-issue-stage-topology.ts';
import {
  createIssueComment,
  fetchIssueComments,
  fetchRepositoryOwnerLogin,
} from './create-issue-stage-record-gh.ts';

export interface CommentCensusSnapshot {
  readonly comments: readonly TrustedComment[];
  readonly complete: boolean;
  readonly censusCount: number;
  readonly maxPages: number;
  readonly pageSize: number;
  readonly capturedAt: string;
  readonly diagnostics: readonly string[];
}

export interface TargetedCommentRead {
  ok: boolean;
  comment?: TrustedComment;
  exactBody: boolean;
  marker?: ParsedRecordMarker | null;
  reason?: 'transport-unavailable' | 'missing-comment' | 'body-mismatch' | 'oversized-body' | 'malformed-comment';
}

export interface CommentPublicationResult {
  state: 'published' | 'publication-pending' | 'pending-observation' | 'terminal-publication-conflict';
  commentId?: number;
  targetedRead?: TargetedCommentRead;
  reason?: string;
}

function parseRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`invalid repo ${repo}`);
  return { owner, name };
}

export function createCommentCensus(
  transport: GhTransport,
  repo: string,
  issueNumber: number,
  options: { pageSize?: number; maxPages?: number } = {},
): CommentCensusSnapshot {
  const pageSize = Math.min(ISSUE_COMMENT_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize ?? ISSUE_COMMENT_PAGE_SIZE)));
  const maxPages = Math.min(MAX_ISSUE_COMMENT_PAGES, Math.max(1, Math.floor(options.maxPages ?? MAX_ISSUE_COMMENT_PAGES)));
  const ownerLogin = fetchRepositoryOwnerLogin(transport, repo);
  const fetched = fetchIssueComments(transport, repo, issueNumber, ownerLogin, {
    pageSize,
    maxPages,
  });
  const comments = Object.freeze(fetched.comments.slice()) as readonly TrustedComment[];
  const diagnostics = fetched.diagnostics.map((item) => item.message);
  if (comments.length > MAX_ISSUE_COMMENT_CENSUS) {
    return {
      comments: [],
      complete: false,
      censusCount: comments.length,
      maxPages,
      pageSize,
      capturedAt: new Date().toISOString(),
      diagnostics: [...diagnostics, 'comment census exceeded configured bound'],
    };
  }
  return {
    comments,
    complete: fetched.commentsComplete,
    censusCount: comments.length,
    maxPages,
    pageSize,
    capturedAt: new Date().toISOString(),
    diagnostics,
  };
}

export function censusRecords(snapshot: CommentCensusSnapshot): {
  markers: Array<{ comment: TrustedComment; marker: ParsedRecordMarker }>;
  malformedMarkedComments: TrustedComment[];
} {
  const markers: Array<{ comment: TrustedComment; marker: ParsedRecordMarker }> = [];
  const malformedMarkedComments: TrustedComment[] = [];
  for (const comment of snapshot.comments) {
    if (!comment.body.includes('create-issue-review-record/v1')) continue;
    const marker = parseRecordMarker(comment.body);
    if (marker) markers.push({ comment, marker });
    else malformedMarkedComments.push(comment);
  }
  return { markers, malformedMarkedComments };
}

export function readTargetedComment(
  transport: GhTransport,
  repo: string,
  commentId: number,
  expectedBody: string,
): TargetedCommentRead {
  if (Buffer.byteLength(expectedBody, 'utf8') > COMMENT_BODY_UTF8_LIMIT) {
    return { ok: false, exactBody: false, reason: 'oversized-body' };
  }
  const { owner, name } = parseRepo(repo);
  const response = transport.runGh([
    'gh',
    'api',
    `repos/${owner}/${name}/issues/comments/${commentId}`,
  ]);
  if (response.exitCode !== 0) return { ok: false, exactBody: false, reason: 'transport-unavailable' };
  let parsed: unknown;
  try { parsed = JSON.parse(response.stdout); } catch { return { ok: false, exactBody: false, reason: 'malformed-comment' }; }
  if (!parsed || typeof parsed !== 'object') return { ok: false, exactBody: false, reason: 'malformed-comment' };
  const raw = parsed as Record<string, unknown>;
  const body = typeof raw.body === 'string' ? raw.body : null;
  if (body === null) return { ok: false, exactBody: false, reason: 'malformed-comment' };
  if (body !== expectedBody) return { ok: false, exactBody: false, reason: 'body-mismatch', marker: parseRecordMarker(body) };
  const id = Number(raw.id);
  const user = raw.user as Record<string, unknown> | undefined;
  const createdAt = typeof raw.created_at === 'string' ? raw.created_at : '';
  const updatedAt = typeof raw.updated_at === 'string' ? raw.updated_at : '';
  const userLogin = typeof user?.login === 'string' ? user.login : '';
  const authorAssociation = typeof raw.author_association === 'string' ? raw.author_association : '';
  if (!Number.isSafeInteger(id) || !createdAt || !updatedAt || !userLogin || !authorAssociation) {
    return { ok: false, exactBody: false, reason: 'malformed-comment' };
  }
  const comment: TrustedComment = { id, body, createdAt, updatedAt, userLogin, authorAssociation };
  return { ok: true, exactBody: true, comment, marker: parseRecordMarker(body) };
}

export function publishAfterCensus(
  transport: GhTransport,
  repo: string,
  issueNumber: number,
  snapshot: CommentCensusSnapshot,
  body: string,
): CommentPublicationResult {
  if (!snapshot.complete) return { state: 'pending-observation', reason: 'census-incomplete' } as CommentPublicationResult;
  if (Buffer.byteLength(body, 'utf8') > COMMENT_BODY_UTF8_LIMIT) {
    return { state: 'terminal-publication-conflict', reason: 'serialized-comment-too-large' };
  }
  const created = createIssueComment(transport, repo, issueNumber, body);
  if (!created.ok || created.commentId === undefined) {
    return { state: 'publication-pending', reason: created.ambiguous ? 'ambiguous-confirmation' : 'comment-create-failed' };
  }
  const targetedRead = readTargetedComment(transport, repo, created.commentId, body);
  if (!targetedRead.ok) return { state: 'publication-pending', commentId: created.commentId, targetedRead, reason: targetedRead.reason };
  return { state: 'published', commentId: created.commentId, targetedRead };
}

export function hasExactComment(snapshot: CommentCensusSnapshot, body: string): boolean {
  return snapshot.comments.some((comment) => comment.body === body);
}


export function publishCompletedReviewTurn(transport: GhTransport, repo: string, topology: import('./create-issue-stage-topology.ts').ReviewTopology, completed: import('./create-issue-completed-result.ts').CompletedResult): { ok: boolean; snapshot: CommentCensusSnapshot; eventKey?: string; results: CommentPublicationResult[] } {
  if (completed.stageAttemptId !== topology.stageAttemptId || !topology.requiredSlots.includes(completed.slot) || sha256(Buffer.from(completed.rawOutput, 'utf8')) !== completed.outputId) return { ok: false, snapshot: { comments: [], complete: false, censusCount: 0, maxPages: 0, pageSize: 0, capturedAt: new Date().toISOString(), diagnostics: ['completed-result-unavailable'] }, results: [{ state: 'terminal-publication-conflict', reason: 'incompatible-identity' }] };
  const snapshot = createCommentCensus(transport, repo, topology.issueNumber);
  if (!snapshot.complete) return { ok: false, snapshot, results: [{ state: 'pending-observation', reason: 'census-incomplete' }] };
  const topologyRecord = buildTopologyRecord(topology);
  const existingTopologyComments = snapshot.comments.filter((comment) => comment.body.includes('create-issue-review-record/v1') && comment.body.includes('schema=topology'));
  for (const comment of existingTopologyComments) {
    const parsed = parseTopologyRecord(comment.body);
    if (!parsed || parsed.body !== topologyRecord.body) return { ok: false, snapshot, results: [{ state: 'terminal-publication-conflict', reason: 'duplicate-topology' }] };
  }
  const results: CommentPublicationResult[] = [];
  if (!hasExactComment(snapshot, topologyRecord.body)) results.push(publishAfterCensus(transport, repo, topology.issueNumber, snapshot, topologyRecord.body));
  if (results.some((result) => result.state !== 'published')) return { ok: false, snapshot, results };
  const records = buildSourceRecords(topology, completed.slot, completed.rawOutput);
  for (const record of records) {
    const remoteSourceComments = snapshot.comments.filter((comment) => comment.body.includes('create-issue-review-record/v1') && comment.body.includes('schema=source'));
    for (const comment of remoteSourceComments) {
      const parsed = parseSourceRecord(comment.body);
      if (!parsed) return { ok: false, snapshot, results: [...results, { state: 'terminal-publication-conflict', reason: 'malformed-payload' }] };
      if (parsed.recordKey === record.recordKey && parsed.body !== record.body) return { ok: false, snapshot, results: [...results, { state: 'terminal-publication-conflict', reason: 'duplicate-conflicting' }] };
    }
    if (!hasExactComment(snapshot, record.body)) results.push(publishAfterCensus(transport, repo, topology.issueNumber, snapshot, record.body));
  }
  return { ok: results.every((result) => result.state === 'published'), snapshot, eventKey: records[0]?.eventKey, results };
}
