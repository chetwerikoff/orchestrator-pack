import {
  freezeConsistentReviewLaneBody,
  normalizeReviewLaneDeclaration,
  type ReviewLaneBodyRead,
  type ReviewLaneInput,
} from './review-lane-routing.ts';

const DECLARATION_FENCE = /```review-lane-change-set(?:\/v1)?\s*\n([\s\S]*?)```/i;

export function parseReviewLaneDeclarationFromBody(body: string): unknown {
  const match = DECLARATION_FENCE.exec(body);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(match[1]) as unknown;
  } catch {
    return { malformed: true };
  }
}

export function produceReviewLaneInput(
  body: string,
  sourceRevision: string,
): ReviewLaneInput {
  const normalized = normalizeReviewLaneDeclaration(parseReviewLaneDeclarationFromBody(body));
  if (normalized.status !== 'usable') return normalized;
  return {
    ...normalized,
    sourceRevision,
    identity: `${sourceRevision}:${normalized.identity}`,
  };
}

export function freezeAndProduceReviewLaneInput(
  reads: readonly ReviewLaneBodyRead[],
): ReviewLaneInput {
  const frozen = freezeConsistentReviewLaneBody(reads);
  if (frozen.status !== 'frozen') {
    return {
      status: 'producer-unavailable',
      reason: frozen.reason,
      observed: frozen.observed,
      message: frozen.message,
    };
  }
  return produceReviewLaneInput(frozen.body, frozen.sourceRevision);
}
