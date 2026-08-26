import { createHash } from 'node:crypto';
import type { PublishedAuthorState } from './create-issue-final-acceptance-contract.ts';

export interface PublishedAuthorStateAdjudication {
  issueNumber: number;
  sourceRevision: string;
  verdictUrl: string;
  verdictSha256: string;
  verdictByteLength: number;
}

export interface PublishedAuthorStateComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl?: string;
  issueUrl?: string;
}

export interface ResolvePublishedAuthorStateOptions {
  adjudication: PublishedAuthorStateAdjudication | undefined;
  repo: string;
  issueNumber: number;
  comments: readonly PublishedAuthorStateComment[];
  errorStyle?: 'final-acceptance' | 'artifacts';
}

export function resolvePublishedAuthorState(
  options: ResolvePublishedAuthorStateOptions,
): { state?: PublishedAuthorState; errors: string[] } {
  const { adjudication, repo, issueNumber, comments } = options;
  if (!adjudication) return { errors: [] };

  const errors: string[] = [];
  const sourceRevision = String(adjudication.sourceRevision ?? '').trim();
  const verdictUrl = String(adjudication.verdictUrl ?? '').trim();
  const verdictSha256 = String(adjudication.verdictSha256 ?? '').trim().toLowerCase();
  const verdictByteLength = Number(adjudication.verdictByteLength);
  const match = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/([1-9][0-9]*)#issuecomment-([1-9][0-9]*)$/.exec(verdictUrl);
  if (!match || match[1]!.toLowerCase() !== repo.toLowerCase() || Number(match[2]) !== issueNumber || Number(adjudication.issueNumber) !== issueNumber) {
    errors.push('operator verdict URL hint does not identify a published Issue comment in authoritative census');
    return { errors };
  }

  const comment = comments.find((candidate) => candidate.id === Number(match[3]));
  const commentUrl = comment?.htmlUrl ?? verdictUrl;
  if (!comment) {
    errors.push('operator verdict URL hint does not identify a published Issue comment in authoritative census');
    return { errors };
  }
  if (!/^m3-protected:/im.test(comment.body)) return { errors };
  const publishedRevision = /^revision:\s*(r[0-9]+)\s*$/m.exec(comment.body)?.[1];
  if (!/^author-state:\s*\S+/m.test(comment.body) || publishedRevision !== sourceRevision) {
    errors.push(options.errorStyle === 'artifacts'
      ? `operator verdict URL hint does not identify published author-state for revision ${sourceRevision}: ${commentUrl}`
      : `operator verdict URL hint does not identify published author-state for revision ${sourceRevision}: ${verdictUrl}`);
    return { errors };
  }

  const actualSha256 = createHash('sha256').update(comment.body, 'utf8').digest('hex');
  const actualByteLength = Buffer.byteLength(comment.body);
  if (!/^[0-9a-f]{64}$/.test(verdictSha256) || actualSha256 !== verdictSha256) {
    errors.push(options.errorStyle === 'artifacts'
      ? `operator verdict URL hint sha256 does not match published Issue comment: ${commentUrl}`
      : `operator verdict URL hint sha256 does not match published Issue comment: ${verdictUrl}`);
  }
  if (!Number.isSafeInteger(verdictByteLength) || verdictByteLength < 0 || actualByteLength !== verdictByteLength) {
    errors.push(options.errorStyle === 'artifacts'
      ? `operator verdict URL hint byteLength does not match published Issue comment: ${commentUrl}`
      : `operator verdict URL hint byteLength does not match published Issue comment: ${verdictUrl}`);
  }
  return errors.length > 0
    ? { errors }
    : { state: { text: comment.body, sha256: actualSha256, byteLength: actualByteLength }, errors };
}
