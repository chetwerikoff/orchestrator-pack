import {
  freezeConsistentReviewLaneBody,
  normalizeReviewLaneDeclaration,
  parseReviewLaneAuthorDeclaration,
  type ReviewLaneBodyRead,
  type ReviewLaneAuthorDeclaration,
  type ReviewLaneInput,
} from './review-lane-routing.ts';

const DECLARATION_FENCE = /```review-lane-change-set(?:\/v1)?\s*\n([\s\S]*?)```/i;
const SOURCE_REVISION_MARKER = /^\s*(?:revision\s*:?\s*|<!--\s*source-revision\s*:\s*)(\S+)\s*(?:-->)?\s*$/im;

export function parseReviewLaneSourceRevision(body: string): string | null {
  const match = SOURCE_REVISION_MARKER.exec(body);
  return match?.[1]?.trim() || null;
}

function scalar(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^(['"])(.*)\1$/, '$2');
}

function inlineList(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  if (trimmed.slice(1, -1).trim() === '') return [];
  return trimmed.slice(1, -1).split(',').map((item) => scalar(item));
}

function parseYamlLikeDeclaration(source: string): unknown {
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const entries: Array<{ kind?: string; path?: string; behaviors?: string[] }> = [];
  let current: { kind?: string; path?: string; behaviors?: string[] } | undefined;
  let schema: string | undefined;
  let owner: string | undefined;
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    if (line.startsWith('schema:')) schema = scalar(line.slice('schema:'.length));
    else if (line.startsWith('owner:')) owner = scalar(line.slice('owner:'.length));
    else if (line.startsWith('- kind:')) {
      current = { kind: scalar(line.slice('- kind:'.length)) };
      entries.push(current);
    } else if (current && line.startsWith('kind:')) current.kind = scalar(line.slice('kind:'.length));
    else if (current && line.startsWith('path:')) current.path = scalar(line.slice('path:'.length));
    else if (current && line.startsWith('behaviors:')) current.behaviors = inlineList(line.slice('behaviors:'.length)) ?? [];
    else if (current && line.startsWith('- ') && current.behaviors) current.behaviors.push(scalar(line.slice(2)));
  }
  if (!schema || !owner || entries.length === 0) return { malformed: true };
  return { schema, owner, entries };
}

export function parseReviewLaneDeclarationFromBody(body: string): unknown {
  const match = DECLARATION_FENCE.exec(body);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(match[1]) as unknown;
  } catch {
    return parseYamlLikeDeclaration(match[1]);
  }
}

export function parseReviewLaneAuthorDeclarationFromBody(body: string): ReviewLaneAuthorDeclaration | null {
  return parseReviewLaneAuthorDeclaration(parseReviewLaneDeclarationFromBody(body));
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
