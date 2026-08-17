export const PACK_GPT_SOURCE_COMMENT_SCHEMA = 'opk-pack-gpt-source:v1' as const;
export const PACK_GPT_SOURCE_COMMENT_NOTICE = 'Source review artifact, not the final pack-review verdict.';

export interface PackGptSourceIdentity {
  repository: string;
  prNumber: number;
  headSha: string;
  runId: string;
  slotId: string;
  invocationId: string;
}

function requiredText(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`pack GPT source identity requires ${label}`);
  return text;
}

export function normalizePackGptSourceIdentity(value: PackGptSourceIdentity): PackGptSourceIdentity {
  const repository = requiredText(value.repository, 'repository');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`invalid pack GPT source repository '${repository}'`);
  }
  const prNumber = Number(value.prNumber);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('pack GPT source identity requires a positive PR number');
  }
  const headSha = requiredText(value.headSha, 'head SHA').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error(`invalid pack GPT source head SHA '${value.headSha}'`);
  }
  const runId = requiredText(value.runId, 'run id');
  if (!/^prr-[a-zA-Z0-9._-]+$/.test(runId)) {
    throw new Error(`invalid pack GPT source run id '${runId}'`);
  }
  const slotId = requiredText(value.slotId, 'source slot');
  if (!/^source-\d{2}$/.test(slotId)) {
    throw new Error(`invalid pack GPT source slot '${slotId}'`);
  }
  const invocationId = requiredText(value.invocationId, 'invocation id').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(invocationId)) {
    throw new Error(`invalid pack GPT source invocation id '${value.invocationId}'`);
  }
  return { repository, prNumber, headSha, runId, slotId, invocationId };
}

export function samePackGptSourceIdentity(left: PackGptSourceIdentity, right: PackGptSourceIdentity): boolean {
  const a = normalizePackGptSourceIdentity(left);
  const b = normalizePackGptSourceIdentity(right);
  return a.repository === b.repository
    && a.prNumber === b.prNumber
    && a.headSha === b.headSha
    && a.runId === b.runId
    && a.slotId === b.slotId
    && a.invocationId === b.invocationId;
}

export function formatPackGptSourceMarker(identity: PackGptSourceIdentity): string {
  const normalized = normalizePackGptSourceIdentity(identity);
  return `<!-- ${PACK_GPT_SOURCE_COMMENT_SCHEMA} repo=${normalized.repository} pr=${normalized.prNumber} run=${normalized.runId} slot=${normalized.slotId} invocation=${normalized.invocationId} head=${normalized.headSha} -->`;
}

export function parsePackGptSourceMarker(line: string): PackGptSourceIdentity | null {
  const escapedSchema = PACK_GPT_SOURCE_COMMENT_SCHEMA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = line.trim().match(new RegExp(
    `^<!-- ${escapedSchema} repo=([^\\s]+) pr=(\\d+) run=([^\\s]+) slot=([^\\s]+) invocation=([^\\s]+) head=([0-9a-fA-F]{40}) -->$`,
  ));
  if (!match) return null;
  try {
    return normalizePackGptSourceIdentity({
      repository: match[1]!,
      prNumber: Number(match[2]),
      runId: match[3]!,
      slotId: match[4]!,
      invocationId: match[5]!,
      headSha: match[6]!,
    });
  } catch {
    return null;
  }
}

export function formatPackGptSourceCommentEnvelope(
  identity: PackGptSourceIdentity,
  payloadText: string,
): string {
  const payload = String(payloadText ?? '').trim();
  if (!payload) throw new Error('pack GPT source comment payload must be non-empty');
  return [
    formatPackGptSourceMarker(identity),
    PACK_GPT_SOURCE_COMMENT_NOTICE,
    '',
    payload,
  ].join('\n');
}

export function parsePackGptSourceCommentEnvelope(body: string): {
  identity: PackGptSourceIdentity;
  payloadText: string;
} | null {
  const normalizedBody = String(body ?? '').replace(/\r\n?/g, '\n');
  const lines = normalizedBody.split('\n');
  const identity = parsePackGptSourceMarker(lines[0] ?? '');
  if (!identity) return null;
  if ((lines[1] ?? '') !== PACK_GPT_SOURCE_COMMENT_NOTICE) return null;
  if ((lines[2] ?? '') !== '') return null;
  const payloadText = lines.slice(3).join('\n').trim();
  if (!payloadText) return null;
  return { identity, payloadText };
}
