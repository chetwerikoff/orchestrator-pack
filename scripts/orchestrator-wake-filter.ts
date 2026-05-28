/**
 * AO webhook payload → orchestrator wake decision.
 * Used by orchestrator-wake-listener.ps1 (via tsx CLI) and Vitest.
 */

export const DEFAULT_WAKE_DEDUP_WINDOW_MS = 30_000;

/** Semantic / event kinds that should wake the orchestrator session. */
export const WAKE_RELEVANT_KINDS = new Set([
  'review.needs_triage',
  'pr_created',
  'ready_for_review',
  'ci.failing',
  'report.stale',
  'merge.ready',
]);

/** Maps AO event.type values that imply a wake kind (when priority is routed to webhook). */
const EVENT_TYPE_TO_WAKE_KIND: Record<string, string> = {
  'ci.failing': 'ci.failing',
  'merge.ready': 'merge.ready',
  'review.pending': 'review.needs_triage',
};

/** Maps notification data semanticType values to wake kinds. */
const SEMANTIC_TYPE_TO_WAKE_KIND: Record<string, string> = {
  'ci.failing': 'ci.failing',
  'merge.ready': 'merge.ready',
  'report.stale': 'report.stale',
  'report.no_acknowledge': 'report.stale',
  'review.needs_triage': 'review.needs_triage',
  'review.pending': 'review.needs_triage',
  pr_created: 'pr_created',
  ready_for_review: 'ready_for_review',
};

export interface AoWebhookEvent {
  id?: string;
  type?: string;
  priority?: string;
  sessionId?: string;
  projectId?: string;
  timestamp?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface AoWebhookBody {
  type?: string;
  event?: AoWebhookEvent;
  message?: string;
  context?: Record<string, unknown>;
}

export type WakeFilterRejectReason =
  | 'malformed_payload'
  | 'not_notification'
  | 'missing_session_id'
  | 'info_priority'
  | 'not_wake_relevant';

export interface WakeFilterAccept {
  ok: true;
  wakeKind: string;
  sessionId: string;
  projectId?: string;
  prNumber?: number;
  prUrl?: string;
  runId?: string;
  wakeMessage: string;
  dedupeKey: string;
}

export interface WakeFilterReject {
  ok: false;
  reason: WakeFilterRejectReason;
  detail?: string;
}

export type WakeFilterResult = WakeFilterAccept | WakeFilterReject;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getNotificationData(event: AoWebhookEvent): Record<string, unknown> | null {
  const data = event.data;
  if (!isRecord(data)) return null;
  if (data.schemaVersion === 3 && isRecord(data.subject)) return data;
  return data;
}

function prIdentifier(data: Record<string, unknown> | null): {
  prNumber?: number;
  prUrl?: string;
} {
  if (!data) return {};
  const subject = data.subject;
  if (!isRecord(subject)) return {};
  const pr = subject.pr;
  if (!isRecord(pr)) return {};
  const prNumber = typeof pr.number === 'number' ? pr.number : undefined;
  const prUrl = nonEmptyString(pr.url);
  return { prNumber, prUrl };
}

function codeReviewRunId(data: Record<string, unknown> | null): string | undefined {
  if (!data) return undefined;
  const review = data.codeReview;
  if (isRecord(review)) {
    return nonEmptyString(review.runId) ?? nonEmptyString(review.id);
  }
  const runId = nonEmptyString(data.runId);
  if (runId) return runId;
  return undefined;
}

function resolveWakeKind(event: AoWebhookEvent): string | null {
  const data = getNotificationData(event);
  const semanticType = nonEmptyString(data?.semanticType);
  if (semanticType) {
    if (WAKE_RELEVANT_KINDS.has(semanticType)) return semanticType;
    const mapped = SEMANTIC_TYPE_TO_WAKE_KIND[semanticType];
    if (mapped) return mapped;
  }

  const eventType = nonEmptyString(event.type);
  if (eventType) {
    if (WAKE_RELEVANT_KINDS.has(eventType)) return eventType;
    const mapped = EVENT_TYPE_TO_WAKE_KIND[eventType];
    if (mapped) return mapped;
  }

  if (data && isRecord(data.reaction)) {
    const reactionKey = nonEmptyString(data.reaction.key);
    if (reactionKey === 'report-stale') return 'report.stale';
  }

  if (data && isRecord(data.codeReview)) {
    const status = nonEmptyString(data.codeReview.status);
    if (status === 'needs_triage') return 'review.needs_triage';
  }

  const message = nonEmptyString(event.message) ?? '';
  if (/needs_triage/i.test(message)) return 'review.needs_triage';

  return null;
}

function formatIdentifier(parts: {
  sessionId: string;
  prNumber?: number;
  prUrl?: string;
  runId?: string;
}): string {
  const bits = [`session=${parts.sessionId}`];
  if (parts.prNumber !== undefined) bits.push(`pr=#${parts.prNumber}`);
  else if (parts.prUrl) bits.push(`pr=${parts.prUrl}`);
  if (parts.runId) bits.push(`run=${parts.runId}`);
  return bits.join(' ');
}

export function buildWakeMessage(
  wakeKind: string,
  parts: {
    sessionId: string;
    prNumber?: number;
    prUrl?: string;
    runId?: string;
  },
): string {
  return `wake ${wakeKind} ${formatIdentifier(parts)}`;
}

/**
 * Evaluate a parsed AO webhook POST body.
 * Callers should only forward urgent/action routed events; info-class payloads are dropped.
 */
export function evaluateWakePayload(body: unknown): WakeFilterResult {
  if (!isRecord(body)) {
    return { ok: false, reason: 'malformed_payload', detail: 'body is not an object' };
  }

  const envelopeType = nonEmptyString(body.type);
  if (envelopeType !== 'notification' && envelopeType !== 'notification_with_actions') {
    return {
      ok: false,
      reason: 'not_notification',
      detail: envelopeType ?? 'missing type',
    };
  }

  const event = body.event;
  if (!isRecord(event)) {
    return { ok: false, reason: 'malformed_payload', detail: 'missing event object' };
  }

  const sessionId = nonEmptyString(event.sessionId);
  if (!sessionId) {
    return { ok: false, reason: 'missing_session_id' };
  }

  const priority = nonEmptyString(event.priority);
  if (priority === 'info' || priority === 'warning') {
    return { ok: false, reason: 'info_priority', detail: priority };
  }

  const wakeKind = resolveWakeKind(event as AoWebhookEvent);
  if (!wakeKind) {
    return { ok: false, reason: 'not_wake_relevant' };
  }

  const data = getNotificationData(event as AoWebhookEvent);
  const { prNumber, prUrl } = prIdentifier(data);
  const runId = codeReviewRunId(data);
  const projectId = nonEmptyString(event.projectId);

  const wakeMessage = buildWakeMessage(wakeKind, {
    sessionId,
    prNumber,
    prUrl,
    runId,
  });

  const dedupeKey = [wakeKind, sessionId, String(prNumber ?? ''), runId ?? ''].join('|');

  return {
    ok: true,
    wakeKind,
    sessionId,
    projectId,
    prNumber,
    prUrl,
    runId,
    wakeMessage,
    dedupeKey,
  };
}

export function parseWebhookJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid JSON: ${message}`);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'evaluate';

  if (command === 'evaluate') {
    const jsonFlag = args.indexOf('--json');
    let raw: string;
    if (jsonFlag >= 0 && args[jsonFlag + 1]) {
      raw = args[jsonFlag + 1];
    } else {
      raw = await readStdin();
    }
    let parsed: unknown;
    try {
      parsed = parseWebhookJson(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`${JSON.stringify({ ok: false, reason: 'malformed_payload', detail: message })}\n`);
      process.exit(0);
      return;
    }
    const result = evaluateWakePayload(parsed);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exit(2);
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('orchestrator-wake-filter.ts') ||
    process.argv[1].endsWith('orchestrator-wake-filter.js'));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
