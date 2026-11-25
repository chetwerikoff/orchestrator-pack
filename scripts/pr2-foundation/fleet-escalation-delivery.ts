import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RuntimeAdapter } from '../runtime/contracts.ts';
import { readSelectedProjectFile } from '../orca-runtime/orchestrator-attach.ts';
import {
  publishOperatorMessageOnce,
  type OperatorPublicationOutcome,
} from '../lib/operator-publication.ts';
import {
  resolveCoordinatorSeatIdentity,
  type OperatorPrimaryPreActionFailure,
  type OperatorPrimaryTargetFenceResult,
} from '../lib/operator-primary-target.ts';
import {
  FLEET_RECONCILIATION_HANDOFF_SCHEMA,
  type FleetReconciliationHandoff,
  type FleetReconciliationReason,
} from './fleet-reconciliation-handoff.ts';

export const FLEET_ESCALATION_CONTENT_SCHEMA = 'fleet-escalation-content/v1' as const;
export const FLEET_ESCALATION_INVOCATION_RESULT_SCHEMA = 'fleet-escalation-invocation-result/v1' as const;
export const FLEET_ESCALATION_RESULT = 'operator-escalation-only' as const;
export const FLEET_ESCALATION_ROUTE = 'operator-primary' as const;
export const MAX_FLEET_ESCALATION_CONTENT_BYTES = 4_096 as const;
export const MAX_FLEET_ESCALATION_DIAGNOSTICS = 4 as const;
export const DEFAULT_FLEET_ESCALATION_TARGET_TIMEOUT_MS = 1_000 as const;
export const DEFAULT_FLEET_ESCALATION_PUBLICATION_TIMEOUT_MS = 5_000 as const;

const REASONS = new Set<FleetReconciliationReason>([
  'target_unresolved',
  'target_stale',
  'observer_untrusted',
  'assignment_untrusted',
  'remote_not_applicable',
  'runtime_unavailable',
  'dispatch_unknown',
  'effect_untrusted',
]);

const HANDOFF_KEYS = new Set([
  'schema',
  'projectId',
  'repository',
  'activationLineage',
  'schedulerGeneration',
  'tickSequence',
  'decision',
  'reason',
  'role',
  'issueNumber',
  'taskId',
  'assignmentId',
  'assignmentGeneration',
  'reconciliations',
  'reconciliationCount',
  'recordedAtUtc',
  'payloadDigest',
]);

const FORBIDDEN_CANONICAL_CONTENT_PATTERNS = [
  /\b(?:Basic|Bearer)\s+\S+/iu,
  /ghp_/u,
  /gho_/u,
  /ghu_/u,
  /ghs_/u,
  /ghr_/u,
  /github_pat_/u,
  /(?:^|[^A-Za-z0-9])sk-/u,
  /AKIA[0-9A-Z]{16}/u,
  /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s",}]+/u,
  /\b(?:token|password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s",}]+/iu,
] as const;

export type FleetEscalationDecision =
  | 'no_escalation'
  | 'invalid_evidence'
  | 'invalid_target'
  | 'publish_attempted';

export type FleetEscalationPublication =
  | 'not_attempted'
  | OperatorPublicationOutcome;

export type FleetEscalationDiagnostic =
  | 'evidence_absent'
  | 'evidence_not_committed_readback'
  | 'evidence_shape_invalid'
  | 'evidence_digest_invalid'
  | 'evidence_scheduler_identity_mismatch'
  | 'content_invalid'
  | 'runtime_unavailable'
  | 'publication_threw'
  | OperatorPrimaryPreActionFailure
  | 'action_failed'
  | 'action_result_invalid';

export interface FleetEscalationSchedulerIdentityV1 {
  readonly projectId: string;
  readonly repository: string;
  readonly activationLineage: string;
  readonly schedulerGeneration: string;
  readonly tickSequence: number;
}

export interface FleetEscalationContentV1 extends FleetEscalationSchedulerIdentityV1 {
  readonly schema: typeof FLEET_ESCALATION_CONTENT_SCHEMA;
  readonly decision: 'orchestrator_required';
  readonly reason: FleetReconciliationReason;
  readonly role?: 'manager' | 'worker';
  readonly issueNumber?: number;
  readonly taskId?: string;
  readonly assignmentId?: string;
  readonly assignmentGeneration?: number;
}

export interface FleetEscalationInvocationResultV1 extends FleetEscalationSchedulerIdentityV1 {
  readonly schema: typeof FLEET_ESCALATION_INVOCATION_RESULT_SCHEMA;
  readonly result: typeof FLEET_ESCALATION_RESULT;
  readonly decision: FleetEscalationDecision;
  readonly publication: FleetEscalationPublication;
  readonly reconciliationDecision: 'orchestrator_required' | null;
  readonly reason: FleetReconciliationReason | null;
  readonly invocationId: string;
  readonly route: typeof FLEET_ESCALATION_ROUTE;
  readonly contentDigest: string | null;
  readonly contentBytes: number;
  readonly attemptCount: 0 | 1;
  readonly diagnostics: readonly FleetEscalationDiagnostic[];
  readonly retryAuthority: 'none';
}

export interface FleetEscalationInvocationInput {
  readonly evidence: FleetReconciliationHandoff | null;
  readonly committedReadBack: boolean;
  readonly expected: FleetEscalationSchedulerIdentityV1;
  /**
   * Selected project file (~/.config/orchestrator-fleet/<id>.env): the operator-supplied
   * OPK_RUN_ID and the current ORCH_HANDLE are the only recipient authority. No local
   * orchestrator assignment row selects or attests the target.
   */
  readonly selectedProjectFile: string;
  /** Selected project's primary checkout; the recipient terminal must live there. */
  readonly primaryRoot: string;
  /** Native `run-show --full` coordinator of the selected Run; undefined when unreadable. */
  readonly readRunCoordinator: (runId: string) => string | null | undefined;
  readonly selectAdapter: () => Promise<RuntimeAdapter>;
  readonly invocationId?: string;
  readonly targetTimeoutMs?: number;
  readonly publicationTimeoutMs?: number;
}

interface CanonicalContent {
  readonly content: FleetEscalationContentV1;
  readonly text: string;
  readonly digest: string;
  readonly bytes: number;
}

type EvidenceValidation =
  | { readonly ok: true; readonly evidence: FleetReconciliationHandoff }
  | { readonly ok: false; readonly diagnostic: FleetEscalationDiagnostic };

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function validRepository(value: unknown): value is string {
  return boundedText(value, 240) && /^[^/\s]+\/[^/\s]+$/u.test(value);
}

function validIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function canonicalHandoffPayload(record: FleetReconciliationHandoff): object {
  return {
    schema: record.schema,
    projectId: record.projectId,
    repository: record.repository,
    activationLineage: record.activationLineage,
    schedulerGeneration: record.schedulerGeneration,
    tickSequence: record.tickSequence,
    decision: record.decision,
    reason: record.reason,
    ...(record.role ? { role: record.role } : {}),
    ...(record.issueNumber !== undefined ? { issueNumber: record.issueNumber } : {}),
    ...(record.taskId !== undefined ? { taskId: record.taskId } : {}),
    ...(record.assignmentId !== undefined ? { assignmentId: record.assignmentId } : {}),
    ...(record.assignmentGeneration !== undefined ? { assignmentGeneration: record.assignmentGeneration } : {}),
    ...(record.reconciliations !== undefined ? { reconciliations: record.reconciliations } : {}),
    ...(record.reconciliationCount !== undefined ? { reconciliationCount: record.reconciliationCount } : {}),
    recordedAtUtc: record.recordedAtUtc,
  };
}

function validateEvidence(
  evidence: FleetReconciliationHandoff | null,
  committedReadBack: boolean,
  expected: FleetEscalationSchedulerIdentityV1,
): EvidenceValidation {
  if (evidence === null) return { ok: false, diagnostic: 'evidence_absent' };
  if (!committedReadBack) return { ok: false, diagnostic: 'evidence_not_committed_readback' };
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { ok: false, diagnostic: 'evidence_shape_invalid' };
  }
  if (Object.keys(evidence).some((key) => !HANDOFF_KEYS.has(key))) {
    return { ok: false, diagnostic: 'evidence_shape_invalid' };
  }
  if (evidence.schema !== FLEET_RECONCILIATION_HANDOFF_SCHEMA
    || !boundedText(evidence.projectId, 128)
    || !validRepository(evidence.repository)
    || !boundedText(evidence.activationLineage, 256)
    || !boundedText(evidence.schedulerGeneration, 256)
    || !Number.isInteger(evidence.tickSequence) || evidence.tickSequence <= 0
    || evidence.decision !== 'orchestrator_required'
    || !REASONS.has(evidence.reason)
    || !validIsoInstant(evidence.recordedAtUtc)
    || typeof evidence.payloadDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(evidence.payloadDigest)) {
    return { ok: false, diagnostic: 'evidence_shape_invalid' };
  }
  if (evidence.role !== undefined && evidence.role !== 'manager' && evidence.role !== 'worker') {
    return { ok: false, diagnostic: 'evidence_shape_invalid' };
  }
  if (evidence.issueNumber !== undefined
    && (!Number.isInteger(evidence.issueNumber) || evidence.issueNumber <= 0)) {
    return { ok: false, diagnostic: 'evidence_shape_invalid' };
  }
  if (evidence.taskId !== undefined && !boundedText(evidence.taskId, 256)) {
    return { ok: false, diagnostic: 'evidence_shape_invalid' };
  }
  if (evidence.assignmentId !== undefined && !boundedText(evidence.assignmentId, 256)) {
    return { ok: false, diagnostic: 'evidence_shape_invalid' };
  }
  if (evidence.assignmentGeneration !== undefined
    && (!Number.isInteger(evidence.assignmentGeneration) || evidence.assignmentGeneration <= 0)) {
    return { ok: false, diagnostic: 'evidence_shape_invalid' };
  }
  if (evidence.reconciliations !== undefined) {
    const rowKeys = new Set(['assignmentId', 'assignmentGeneration', 'issueNumber', 'taskId', 'reason']);
    if (!Array.isArray(evidence.reconciliations) || evidence.reconciliations.some((row) =>
      !row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).some((key) => !rowKeys.has(key))
      || !boundedText(row.assignmentId, 256) || !boundedText(row.taskId, 256)
      || !Number.isInteger(row.assignmentGeneration) || row.assignmentGeneration <= 0
      || !Number.isInteger(row.issueNumber) || row.issueNumber <= 0 || !REASONS.has(row.reason))) {
      return { ok: false, diagnostic: 'evidence_shape_invalid' };
    }
  }
  if (evidence.reconciliationCount !== undefined
    && (!Array.isArray(evidence.reconciliations) || !Number.isInteger(evidence.reconciliationCount)
      || evidence.reconciliationCount < evidence.reconciliations.length)) {
    return { ok: false, diagnostic: 'evidence_shape_invalid' };
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalHandoffPayload(evidence)), 'utf8')
    .digest('hex');
  if (digest !== evidence.payloadDigest) {
    return { ok: false, diagnostic: 'evidence_digest_invalid' };
  }
  if (evidence.projectId !== expected.projectId
    || evidence.repository !== expected.repository
    || evidence.activationLineage !== expected.activationLineage
    || evidence.schedulerGeneration !== expected.schedulerGeneration
    || evidence.tickSequence !== expected.tickSequence) {
    return { ok: false, diagnostic: 'evidence_scheduler_identity_mismatch' };
  }
  return { ok: true, evidence };
}

function containsForbiddenCanonicalContent(text: string): boolean {
  return FORBIDDEN_CANONICAL_CONTENT_PATTERNS.some((pattern) => pattern.test(text));
}

export function canonicalFleetEscalationContent(
  evidence: FleetReconciliationHandoff,
): CanonicalContent | null {
  const content: FleetEscalationContentV1 = {
    schema: FLEET_ESCALATION_CONTENT_SCHEMA,
    projectId: evidence.projectId,
    repository: evidence.repository,
    activationLineage: evidence.activationLineage,
    schedulerGeneration: evidence.schedulerGeneration,
    tickSequence: evidence.tickSequence,
    decision: 'orchestrator_required',
    reason: evidence.reason,
    ...(evidence.role ? { role: evidence.role } : {}),
    ...(evidence.issueNumber !== undefined ? { issueNumber: evidence.issueNumber } : {}),
    ...(evidence.taskId !== undefined ? { taskId: evidence.taskId } : {}),
    ...(evidence.assignmentId !== undefined ? { assignmentId: evidence.assignmentId } : {}),
    ...(evidence.assignmentGeneration !== undefined ? { assignmentGeneration: evidence.assignmentGeneration } : {}),
  };
  const text = JSON.stringify(content);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 1
    || bytes > MAX_FLEET_ESCALATION_CONTENT_BYTES
    || containsForbiddenCanonicalContent(text)) return null;
  return {
    content,
    text,
    bytes,
    digest: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

function boundedInvocationId(value: string | undefined): string {
  if (value !== undefined && boundedText(value, 128)) return value;
  return randomUUID();
}

function boundedDiagnostics(
  diagnostics: readonly FleetEscalationDiagnostic[],
): readonly FleetEscalationDiagnostic[] {
  return diagnostics.slice(0, MAX_FLEET_ESCALATION_DIAGNOSTICS);
}

function baseResult(
  expected: FleetEscalationSchedulerIdentityV1,
  invocationId: string,
  input: {
    readonly decision: FleetEscalationDecision;
    readonly publication: FleetEscalationPublication;
    readonly reconciliationDecision: 'orchestrator_required' | null;
    readonly reason: FleetReconciliationReason | null;
    readonly contentDigest: string | null;
    readonly contentBytes: number;
    readonly attemptCount: 0 | 1;
    readonly diagnostics: readonly FleetEscalationDiagnostic[];
  },
): FleetEscalationInvocationResultV1 {
  return {
    schema: FLEET_ESCALATION_INVOCATION_RESULT_SCHEMA,
    result: FLEET_ESCALATION_RESULT,
    ...expected,
    decision: input.decision,
    publication: input.publication,
    reconciliationDecision: input.reconciliationDecision,
    reason: input.reason,
    invocationId,
    route: FLEET_ESCALATION_ROUTE,
    contentDigest: input.contentDigest,
    contentBytes: input.contentBytes,
    attemptCount: input.attemptCount,
    diagnostics: boundedDiagnostics(input.diagnostics),
    retryAuthority: 'none',
  };
}

export function closeFleetEscalationTargetFence(
  expected: FleetEscalationSchedulerIdentityV1,
  invocationId: string,
  canonical: CanonicalContent,
  fenced: OperatorPrimaryTargetFenceResult<OperatorPublicationOutcome>,
  diagnostics: readonly FleetEscalationDiagnostic[] = [],
): FleetEscalationInvocationResultV1 {
  if (!fenced.ok && !fenced.actionEntered) {
    return baseResult(expected, invocationId, {
      decision: 'invalid_target',
      publication: 'not_attempted',
      reconciliationDecision: 'orchestrator_required',
      reason: canonical.content.reason,
      contentDigest: canonical.digest,
      contentBytes: canonical.bytes,
      attemptCount: 0,
      diagnostics: [...diagnostics, fenced.reason],
    });
  }
  if (!fenced.ok) {
    return baseResult(expected, invocationId, {
      decision: 'publish_attempted',
      publication: 'ambiguous',
      reconciliationDecision: 'orchestrator_required',
      reason: canonical.content.reason,
      contentDigest: canonical.digest,
      contentBytes: canonical.bytes,
      attemptCount: 1,
      diagnostics: [...diagnostics, fenced.reason],
    });
  }
  return baseResult(expected, invocationId, {
    decision: 'publish_attempted',
    publication: fenced.value,
    reconciliationDecision: 'orchestrator_required',
    reason: canonical.content.reason,
    contentDigest: canonical.digest,
    contentBytes: canonical.bytes,
    attemptCount: 1,
    diagnostics,
  });
}

/**
 * Resolve the selected project's current coordinator seat and make one bounded publication.
 * The pair (operator-selected Run, current pin) is re-read and re-joined with native run-show
 * immediately before the single send; this is not an atomic guard inside the handle-only send.
 */
function resolveAndPublish(
  input: FleetEscalationInvocationInput,
  adapter: RuntimeAdapter,
  canonical: CanonicalContent,
  markPublicationThrew: () => void,
): OperatorPrimaryTargetFenceResult<OperatorPublicationOutcome> {
  const fail = (reason: OperatorPrimaryPreActionFailure): OperatorPrimaryTargetFenceResult<never> =>
    ({ ok: false, actionEntered: false, reason });
  const timeoutMs = input.targetTimeoutMs ?? DEFAULT_FLEET_ESCALATION_TARGET_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) return fail('deadline_invalid');
  const deadlineMs = performance.now() + timeoutMs;
  const remaining = (): number => Math.floor(deadlineMs - performance.now());

  const selectCurrent = (): { readonly handle: string } | OperatorPrimaryPreActionFailure => {
    const selection = readSelectedProjectFile(input.selectedProjectFile);
    if (!selection.ok || !selection.handle) return 'target_unresolved';
    let coordinator: string | null | undefined;
    try { coordinator = input.readRunCoordinator(selection.runId); }
    catch { return 'runtime_unavailable'; }
    if (coordinator === undefined) return 'runtime_unavailable';
    if (coordinator !== selection.handle) return 'target_not_current';
    return { handle: selection.handle };
  };
  const first = selectCurrent();
  if (typeof first === 'string') return fail(first);
  const seat = resolveCoordinatorSeatIdentity({
    adapter, handle: first.handle, primaryRoot: input.primaryRoot, remainingMs: remaining,
  });
  if (!seat.ok) return fail(seat.reason);
  const identity = seat.identity;
  // Recheck the selected pair after the identity reads and before the single effect.
  const again = selectCurrent();
  if (typeof again === 'string') return fail(again);
  if (again.handle !== first.handle) return fail('target_not_current');
  if (remaining() <= 0) return fail('deadline_exhausted');

  let publication: OperatorPublicationOutcome;
  try {
    publication = publishOperatorMessageOnce(adapter, {
      route: FLEET_ESCALATION_ROUTE,
      target: identity,
      text: canonical.text,
      timeoutMs: input.publicationTimeoutMs ?? DEFAULT_FLEET_ESCALATION_PUBLICATION_TIMEOUT_MS,
    });
  } catch {
    markPublicationThrew();
    publication = 'ambiguous';
  }
  return { ok: true, actionEntered: true, value: publication };
}

export async function runFleetEscalationDelivery(
  input: FleetEscalationInvocationInput,
): Promise<FleetEscalationInvocationResultV1> {
  const invocationId = boundedInvocationId(input.invocationId);
  const evidence = validateEvidence(input.evidence, input.committedReadBack, input.expected);
  if (!evidence.ok) {
    return baseResult(input.expected, invocationId, {
      decision: evidence.diagnostic === 'evidence_absent' ? 'no_escalation' : 'invalid_evidence',
      publication: 'not_attempted',
      reconciliationDecision: null,
      reason: null,
      contentDigest: null,
      contentBytes: 0,
      attemptCount: 0,
      diagnostics: [evidence.diagnostic],
    });
  }
  const canonical = canonicalFleetEscalationContent(evidence.evidence);
  if (!canonical) {
    return baseResult(input.expected, invocationId, {
      decision: 'invalid_evidence',
      publication: 'not_attempted',
      reconciliationDecision: 'orchestrator_required',
      reason: evidence.evidence.reason,
      contentDigest: null,
      contentBytes: 0,
      attemptCount: 0,
      diagnostics: ['content_invalid'],
    });
  }

  let adapter: RuntimeAdapter;
  try {
    adapter = await input.selectAdapter();
  } catch {
    return baseResult(input.expected, invocationId, {
      decision: 'invalid_target',
      publication: 'not_attempted',
      reconciliationDecision: 'orchestrator_required',
      reason: evidence.evidence.reason,
      contentDigest: canonical.digest,
      contentBytes: canonical.bytes,
      attemptCount: 0,
      diagnostics: ['runtime_unavailable'],
    });
  }

  let publicationThrew = false;
  const fenced = resolveAndPublish(input, adapter, canonical, () => { publicationThrew = true; });

  return closeFleetEscalationTargetFence(
    input.expected,
    invocationId,
    canonical,
    fenced,
    publicationThrew ? ['publication_threw'] : [],
  );
}
