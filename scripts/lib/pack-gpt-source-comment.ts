import { createHash } from 'node:crypto';
import { runProcess } from '../kernel/subprocess.ts';
import { createGithubReviewTransport, requireProcess } from './github-review-reconciliation.ts';
import { resolveTrackedGhWrapper } from './gh-resolve-real-binary.mjs';
import { mapGptReplyToReviewPayload, type GptMappedReviewPayload } from './pack-gpt-reviewer.ts';
import {
  parsePackGptSourceCommentEnvelope,
  parsePackGptSourceMarker,
  samePackGptSourceIdentity,
  type PackGptSourceIdentity,
} from './pack-gpt-source-comment-contract.ts';

export interface PackGptSourceGithubComment {
  id: number | string;
  body: string;
  url: string;
  issueUrl: string;
  actorLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface PackGptSourceCommentReceipt extends PackGptSourceIdentity {
  commentId: number | string;
  commentUrl: string;
  actorLogin: string;
  createdAt: string;
  updatedAt: string;
  bodySha256: string;
}

export interface PackGptSourceCommentTransport {
  resolveActorLogin(): Promise<string>;
  listComments(): Promise<PackGptSourceGithubComment[]>;
  getComment(id: number | string): Promise<PackGptSourceGithubComment>;
}

export type PackGptSourceCommentResolution =
  | {
      kind: 'credentialed';
      payload: GptMappedReviewPayload;
      receipt: PackGptSourceCommentReceipt;
    }
  | {
      kind: 'missing' | 'ambiguous' | 'conflict' | 'provenance_unresolved';
      reason: string;
    };

export type PackGptSourceHeadCommentResolution =
  | {
      kind: 'credentialed';
      identity: PackGptSourceIdentity;
      payload: GptMappedReviewPayload;
      receipt: PackGptSourceCommentReceipt;
    }
  | {
      kind: 'missing' | 'ambiguous' | 'conflict' | 'provenance_unresolved';
      reason: string;
    };

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeComment(value: unknown): PackGptSourceGithubComment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GitHub source comment response is not an object');
  }
  const raw = value as Record<string, unknown>;
  const user = raw.user && typeof raw.user === 'object' && !Array.isArray(raw.user)
    ? raw.user as Record<string, unknown>
    : {};
  const id = typeof raw.id === 'number' || typeof raw.id === 'string' ? raw.id : '';
  const body = typeof raw.body === 'string' ? raw.body : '';
  const url = trim(raw.html_url);
  const issueUrl = trim(raw.issue_url);
  const actorLogin = trim(user.login);
  const createdAt = trim(raw.created_at);
  const updatedAt = trim(raw.updated_at);
  if (id === '' || !url || !issueUrl || !actorLogin || !createdAt || !updatedAt) {
    throw new Error('GitHub source comment response is missing canonical fields');
  }
  return { id, body, url, issueUrl, actorLogin, createdAt, updatedAt };
}

function flattenPaginatedComments(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('GitHub source comment census is not an array');
  if (value.every((entry) => Array.isArray(entry))) return value.flatMap((entry) => entry as unknown[]);
  return value;
}

export function createPackGptSourceCommentTransport(options: {
  repoRoot: string;
  repoSlug: string;
  prNumber: number;
}): PackGptSourceCommentTransport {
  const trackedGh = resolveTrackedGhWrapper();
  const actorTransport = createGithubReviewTransport({
    repoRoot: options.repoRoot,
    repoSlug: options.repoSlug,
    prNumber: options.prNumber,
  });
  const listComments = async (): Promise<PackGptSourceGithubComment[]> => {
    const result = await runProcess({
      command: trackedGh,
      args: [
        'api',
        '--paginate',
        '--slurp',
        `repos/${options.repoSlug}/issues/${options.prNumber}/comments`,
        '-H', 'Accept: application/vnd.github+json',
      ],
      cwd: options.repoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs: 30_000,
    });
    const stdout = await requireProcess(result, `gh source-comment census PR #${options.prNumber}`);
    return flattenPaginatedComments(JSON.parse(stdout)).map(normalizeComment);
  };
  return {
    resolveActorLogin: () => actorTransport.resolveActorLogin(),
    listComments,
    getComment: async (id) => {
      const census = await listComments();
      const matches = census.filter((comment) => comment.id === id);
      if (matches.length !== 1) {
        throw new Error(`gh source-comment reread ${String(id)} returned ${matches.length} exact id matches`);
      }
      return matches[0]!;
    },
  };
}

function expectedIssueUrl(identity: PackGptSourceIdentity): string {
  return `https://api.github.com/repos/${identity.repository}/issues/${identity.prNumber}`;
}

function sameCommentSnapshot(left: PackGptSourceGithubComment, right: PackGptSourceGithubComment): boolean {
  return left.id === right.id
    && left.body === right.body
    && left.url === right.url
    && left.issueUrl === right.issueUrl
    && left.actorLogin === right.actorLogin
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function receipt(identity: PackGptSourceIdentity, comment: PackGptSourceGithubComment): PackGptSourceCommentReceipt {
  return {
    ...identity,
    commentId: comment.id,
    commentUrl: comment.url,
    actorLogin: comment.actorLogin,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    bodySha256: createHash('sha256').update(comment.body, 'utf8').digest('hex'),
  };
}

function parseCredentialableComment(
  comment: PackGptSourceGithubComment,
  identity: PackGptSourceIdentity,
  actorLogin: string,
): { payload: GptMappedReviewPayload } | { conflict: string } | null {
  const firstLine = comment.body.replace(/\r\n?/g, '\n').split('\n', 1)[0] ?? '';
  const markerIdentity = parsePackGptSourceMarker(firstLine);
  if (!markerIdentity || !samePackGptSourceIdentity(markerIdentity, identity)) return null;

  // Principal filtering intentionally precedes uniqueness. A foreign copy of the
  // exact marker is never credentialable and cannot manufacture ambiguity.
  if (comment.actorLogin !== actorLogin) return null;
  if (comment.issueUrl !== expectedIssueUrl(identity)) return { conflict: 'source_comment_wrong_target' };
  if (comment.createdAt !== comment.updatedAt) return { conflict: 'source_comment_edited' };

  const envelope = parsePackGptSourceCommentEnvelope(comment.body);
  if (!envelope || !samePackGptSourceIdentity(envelope.identity, identity)) {
    return { conflict: 'source_comment_malformed' };
  }
  try {
    return { payload: mapGptReplyToReviewPayload(envelope.payloadText) };
  } catch {
    return { conflict: 'source_comment_payload_malformed' };
  }
}

export async function resolvePackGptSourceComment(options: {
  identity: PackGptSourceIdentity;
  transport: PackGptSourceCommentTransport;
}): Promise<PackGptSourceCommentResolution> {
  let actorLogin: string;
  try {
    actorLogin = trim(await options.transport.resolveActorLogin());
  } catch {
    return { kind: 'provenance_unresolved', reason: 'source_comment_actor_resolution_failed' };
  }
  if (!actorLogin) {
    return { kind: 'provenance_unresolved', reason: 'source_comment_actor_resolution_empty' };
  }

  let census: PackGptSourceGithubComment[];
  try {
    census = await options.transport.listComments();
  } catch {
    return { kind: 'provenance_unresolved', reason: 'source_comment_census_failed' };
  }

  const valid: Array<{ comment: PackGptSourceGithubComment; payload: GptMappedReviewPayload }> = [];
  let conflictReason = '';
  for (const comment of census) {
    const parsed = parseCredentialableComment(comment, options.identity, actorLogin);
    if (!parsed) continue;
    if ('conflict' in parsed) {
      conflictReason ||= parsed.conflict;
      continue;
    }
    valid.push({ comment, payload: parsed.payload });
  }
  if (conflictReason) return { kind: 'conflict', reason: conflictReason };
  if (valid.length === 0) return { kind: 'missing', reason: 'source_comment_missing' };
  if (valid.length !== 1) return { kind: 'ambiguous', reason: 'source_comment_duplicate_exact_identity' };

  const selected = valid[0]!;
  let reread: PackGptSourceGithubComment;
  try {
    reread = await options.transport.getComment(selected.comment.id);
  } catch {
    return { kind: 'provenance_unresolved', reason: 'source_comment_reread_failed' };
  }
  if (!sameCommentSnapshot(selected.comment, reread)) {
    return { kind: 'conflict', reason: 'source_comment_changed_between_census_and_reread' };
  }
  if (reread.createdAt !== reread.updatedAt) {
    return { kind: 'conflict', reason: 'source_comment_edited_on_reread' };
  }
  const reparsed = parseCredentialableComment(reread, options.identity, actorLogin);
  if (!reparsed || 'conflict' in reparsed) {
    return {
      kind: 'conflict',
      reason: reparsed && 'conflict' in reparsed ? reparsed.conflict : 'source_comment_identity_changed_on_reread',
    };
  }

  return {
    kind: 'credentialed',
    payload: reparsed.payload,
    receipt: receipt(options.identity, reread),
  };
}


function samePackGptSourceHead(
  identity: PackGptSourceIdentity,
  target: { repository: string; prNumber: number; headSha: string },
): boolean {
  return identity.repository === target.repository
    && identity.prNumber === target.prNumber
    && identity.headSha.toLowerCase() === target.headSha.toLowerCase();
}

/**
 * Marker-first exact-head discovery for the no-local-run reconciliation path.
 * The run/slot/invocation identity is discovered only from the canonical
 * first-line marker; all credentialing, target/edit checks, payload mapping,
 * and exact-id reread rules are the same as the identity-first resolver.
 */
export async function resolvePackGptSourceCommentForHead(options: {
  repository: string;
  prNumber: number;
  headSha: string;
  transport: PackGptSourceCommentTransport;
}): Promise<PackGptSourceHeadCommentResolution> {
  const repository = trim(options.repository);
  const headSha = trim(options.headSha).toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)
      || !Number.isInteger(options.prNumber)
      || options.prNumber <= 0
      || !/^[0-9a-f]{40}$/.test(headSha)) {
    return { kind: 'provenance_unresolved', reason: 'source_comment_head_binding_invalid' };
  }

  let actorLogin: string;
  try {
    actorLogin = trim(await options.transport.resolveActorLogin());
  } catch {
    return { kind: 'provenance_unresolved', reason: 'source_comment_actor_resolution_failed' };
  }
  if (!actorLogin) {
    return { kind: 'provenance_unresolved', reason: 'source_comment_actor_resolution_empty' };
  }

  let census: PackGptSourceGithubComment[];
  try {
    census = await options.transport.listComments();
  } catch {
    return { kind: 'provenance_unresolved', reason: 'source_comment_census_failed' };
  }

  const target = { repository, prNumber: options.prNumber, headSha };
  const valid: Array<{
    comment: PackGptSourceGithubComment;
    identity: PackGptSourceIdentity;
    payload: GptMappedReviewPayload;
  }> = [];
  let conflictReason = '';
  for (const comment of census) {
    const firstLine = comment.body.replace(/\r\n?/g, '\n').split('\n', 1)[0] ?? '';
    const identity = parsePackGptSourceMarker(firstLine);
    if (!identity || !samePackGptSourceHead(identity, target)) continue;

    // Principal filtering precedes uniqueness and conflict classification, just
    // like the identity-first resolver.
    if (comment.actorLogin !== actorLogin) continue;
    const parsed = parseCredentialableComment(comment, identity, actorLogin);
    if (!parsed) continue;
    if ('conflict' in parsed) {
      conflictReason ||= parsed.conflict;
      continue;
    }
    valid.push({ comment, identity, payload: parsed.payload });
  }

  if (conflictReason) return { kind: 'conflict', reason: conflictReason };
  if (valid.length === 0) return { kind: 'missing', reason: 'source_comment_missing' };

  const identityKeys = new Set<string>();
  for (const candidate of valid) {
    const identityKey = [
      candidate.identity.repository,
      candidate.identity.prNumber,
      candidate.identity.headSha.toLowerCase(),
      candidate.identity.runId,
      candidate.identity.slotId,
      candidate.identity.invocationId,
    ].join('|');
    if (identityKeys.has(identityKey)) {
      return { kind: 'ambiguous', reason: 'source_comment_duplicate_identity_exact_head' };
    }
    identityKeys.add(identityKey);
  }
  const selected = [...valid].sort((left, right) =>
    String(left.comment.id).localeCompare(String(right.comment.id)))[0]!;
  let reread: PackGptSourceGithubComment;
  try {
    reread = await options.transport.getComment(selected.comment.id);
  } catch {
    return { kind: 'provenance_unresolved', reason: 'source_comment_reread_failed' };
  }
  if (!sameCommentSnapshot(selected.comment, reread)) {
    return { kind: 'conflict', reason: 'source_comment_changed_between_census_and_reread' };
  }
  if (reread.createdAt !== reread.updatedAt) {
    return { kind: 'conflict', reason: 'source_comment_edited_on_reread' };
  }
  const rereadMarker = parsePackGptSourceMarker(
    reread.body.replace(/\r\n?/g, '\n').split('\n', 1)[0] ?? '',
  );
  if (!rereadMarker
      || !samePackGptSourceHead(rereadMarker, target)
      || !samePackGptSourceIdentity(rereadMarker, selected.identity)) {
    return { kind: 'conflict', reason: 'source_comment_identity_changed_on_reread' };
  }
  const reparsed = parseCredentialableComment(reread, selected.identity, actorLogin);
  if (!reparsed || 'conflict' in reparsed) {
    return {
      kind: 'conflict',
      reason: reparsed && 'conflict' in reparsed
        ? reparsed.conflict
        : 'source_comment_identity_changed_on_reread',
    };
  }

  return {
    kind: 'credentialed',
    identity: selected.identity,
    payload: reparsed.payload,
    receipt: receipt(selected.identity, reread),
  };
}
