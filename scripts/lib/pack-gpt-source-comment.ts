import { createHash } from 'node:crypto';
import { runProcess } from '../kernel/subprocess.ts';
import { createGithubReviewTransport, requireProcess } from './github-review-reconciliation.ts';
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
  const actorTransport = createGithubReviewTransport({
    repoRoot: options.repoRoot,
    repoSlug: options.repoSlug,
    prNumber: options.prNumber,
  });
  return {
    resolveActorLogin: () => actorTransport.resolveActorLogin(),
    listComments: async () => {
      const result = await runProcess({
        command: 'gh',
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
    },
    getComment: async (id) => {
      const result = await runProcess({
        command: 'gh',
        args: [
          'api',
          `repos/${options.repoSlug}/issues/comments/${String(id)}`,
          '-H', 'Accept: application/vnd.github+json',
        ],
        cwd: options.repoRoot,
        inheritParentEnv: true,
        allowEmptyStdout: false,
        timeoutMs: 30_000,
      });
      const stdout = await requireProcess(result, `gh source-comment reread ${String(id)}`);
      return normalizeComment(JSON.parse(stdout));
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
