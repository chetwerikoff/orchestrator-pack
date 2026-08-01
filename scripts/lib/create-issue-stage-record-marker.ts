import { createHash } from 'node:crypto';
import { JOURNAL_MARKER_PREFIX } from './create-issue-stage-record-types.ts';
import type { JournalLogical } from './create-issue-stage-record-types.ts';

const MARKER_RE = new RegExp(
  `<!--\\s*${JOURNAL_MARKER_PREFIX}:([^:]+):([^\\s]+)\\s*-->`,
  'i',
);

export function buildMarker(schema: string, eventKey: string): string {
  return `<!-- ${JOURNAL_MARKER_PREFIX}:${schema}:${eventKey} -->`;
}

export function extractMarker(body: string): { schema: string; eventKey: string } | null {
  const match = body.match(MARKER_RE);
  if (!match) return null;
  const schema = match[1]?.trim() ?? '';
  const eventKey = match[2]?.trim() ?? '';
  if (!schema || !eventKey) return null;
  return { schema, eventKey };
}

export function serializeCommentBody(
  logical: JournalLogical,
  delivery?: { delivery?: 'immediate' | 'delayed'; deliveryFailureClass?: string; firstFailureAt?: string },
): string {
  const marker = buildMarker(logical.schema, logical['event-key']);
  const payload: Record<string, unknown> = { ...logical };
  if (delivery?.delivery) payload.delivery = delivery.delivery;
  if (delivery?.deliveryFailureClass) payload['delivery-failure-class'] = delivery.deliveryFailureClass;
  if (delivery?.firstFailureAt) payload['first-failure-at'] = delivery.firstFailureAt;
  return `${marker}\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

export function parseLogicalFromCommentBody(body: string): JournalLogical | null {
  const marker = extractMarker(body);
  if (!marker) return null;
  const fence = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!fence) return null;
  try {
    const parsed = JSON.parse(fence[1] ?? '') as Record<string, unknown>;
    if (parsed.schema !== marker.schema) return null;
    if (String(parsed['event-key'] ?? '') !== marker.eventKey) return null;
    return parsed as JournalLogical;
  } catch {
    return null;
  }
}

export function logicalFingerprint(logical: JournalLogical): string {
  const canonical = canonicalizeLogical(logical);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function canonicalizeLogical(logical: JournalLogical): Record<string, unknown> {
  const copy = { ...logical } as Record<string, unknown>;
  delete copy.delivery;
  delete copy['delivery-failure-class'];
  delete copy['first-failure-at'];
  const keys = Object.keys(copy).sort();
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = copy[key];
  return out;
}

export function logicalEventsEqual(a: JournalLogical, b: JournalLogical): boolean {
  return logicalFingerprint(a) === logicalFingerprint(b);
}
