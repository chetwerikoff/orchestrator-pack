export const CREATE_ISSUE_NEXT_ACTION_SCHEMA = 'create-issue-next-action/v1' as const;
export const CREATE_ISSUE_STALE_ACTION_SCHEMA = 'create-issue-stale-next-action/v1' as const;

export type CreateIssueSemanticStage =
  | 'competitive'
  | 'architectural-review'
  | 'architectural-lens'
  | 'architectural'
  | 'acceptance';

export interface CreateIssueActionBinding {
  repository: string;
  issueNumber: number;
  sourceRevision: string;
  stage: CreateIssueSemanticStage;
  stageAttemptId?: string;
}

export interface CreateIssueNextAction {
  schema: typeof CREATE_ISSUE_NEXT_ACTION_SCHEMA;
  kind: string;
  binding: CreateIssueActionBinding;
  argv: string[];
}

export interface CreateIssueRecoverableResult {
  ok: false;
  cause: string;
  blocker?: string;
  nextAction: CreateIssueNextAction;
}

export type ZeroSendCauseClass = 'transient' | 'deterministic-input' | 'state-conflict';

export interface CreateIssueZeroSendReason {
  class: ZeroSendCauseClass;
  code: string;
  rawCause: string;
  binding: CreateIssueActionBinding;
  invocationId?: string;
  reviewerSlot?: string;
  owned_prompt_seen?: boolean;
  observed_user_heads?: readonly string[];
}

export type CreateIssueBlockedOn =
  | { issue: number; condition: 'issue_closed'; evidence: string }
  | { pr: number; condition: 'pr_merged'; evidence: string };

export interface CreateIssueTerminalResult {
  ok: boolean;
  cause: string;
  blocker?: string;
  reason?: CreateIssueZeroSendReason;
  blocked_on?: CreateIssueBlockedOn;
  nextAction: null;
}

export interface CreateIssueStaleNextActionResult {
  ok: false;
  schema: typeof CREATE_ISSUE_STALE_ACTION_SCHEMA;
  cause: 'stale_next_action';
  binding: CreateIssueActionBinding;
  observed: Partial<CreateIssueActionBinding>;
  nextAction: CreateIssueNextAction | null;
}

export type CreateIssueManagerResult =
  | CreateIssueRecoverableResult
  | CreateIssueTerminalResult
  | CreateIssueStaleNextActionResult;

export function validateCreateIssueManagerResult(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['manager result must be an object'];
  const result = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof result.ok !== 'boolean') errors.push('manager result.ok must be boolean');
  if (!Object.prototype.hasOwnProperty.call(result, 'nextAction')) {
    errors.push('manager result.nextAction must be present');
    return errors;
  }
  const nextAction = result.nextAction;
  if (result.ok === false) {
    if (!nonEmpty(result.cause)) errors.push('manager non-success result.cause must be non-empty');
    if (result.cause === 'stale_next_action') {
      if (result.schema !== CREATE_ISSUE_STALE_ACTION_SCHEMA) errors.push('stale manager result.schema is invalid');
      errors.push(...validateCreateIssueActionBinding(result.binding).map((error) => 'stale manager result.' + error));
      if (!result.observed || typeof result.observed !== 'object' || Array.isArray(result.observed)) {
        errors.push('stale manager result.observed must be an object');
      }
    }
  }
  if (nextAction !== null) {
    errors.push(...validateCreateIssueNextAction(nextAction));
  }
  if (Object.prototype.hasOwnProperty.call(result, 'reason')) {
    errors.push(...validateZeroSendReason(result.reason));
  }
  if (Object.prototype.hasOwnProperty.call(result, 'blocked_on')) {
    if (nextAction !== null) errors.push('manager result.blocked_on requires nextAction=null');
    if (result.cause === 'stale_next_action') errors.push('stale manager result must not carry blocked_on');
    errors.push(...validateCreateIssueBlockedOn(result.blocked_on));
  }
  return errors;
}

export function validateCreateIssueBlockedOn(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['manager result.blocked_on must be an object'];
  }
  const blockedOn = value as Record<string, unknown>;
  const errors: string[] = [];
  const hasIssue = Object.prototype.hasOwnProperty.call(blockedOn, 'issue');
  const hasPr = Object.prototype.hasOwnProperty.call(blockedOn, 'pr');
  if (hasIssue === hasPr) {
    errors.push('manager result.blocked_on must contain exactly one selector: issue or pr');
  }
  if (!nonEmpty(blockedOn.evidence)) {
    errors.push('manager result.blocked_on.evidence must be non-empty');
  }
  if (hasIssue && (!Number.isSafeInteger(blockedOn.issue) || Number(blockedOn.issue) < 1)) {
    errors.push('manager result.blocked_on.issue must be a positive integer');
  }
  if (hasPr && (!Number.isSafeInteger(blockedOn.pr) || Number(blockedOn.pr) < 1)) {
    errors.push('manager result.blocked_on.pr must be a positive integer');
  }
  if (hasIssue && !hasPr && blockedOn.condition !== 'issue_closed') {
    errors.push('manager result.blocked_on.condition must be issue_closed for an issue selector');
  }
  if (hasPr && !hasIssue && blockedOn.condition !== 'pr_merged') {
    errors.push('manager result.blocked_on.condition must be pr_merged for a pr selector');
  }
  if (hasIssue === hasPr && blockedOn.condition !== 'issue_closed' && blockedOn.condition !== 'pr_merged') {
    errors.push('manager result.blocked_on.condition is invalid');
  }
  const allowed = new Set(['issue', 'pr', 'condition', 'evidence']);
  const unexpected = Object.keys(blockedOn).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    errors.push('manager result.blocked_on has unexpected fields: ' + unexpected.sort().join(', '));
  }
  return errors;
}

function validateZeroSendReason(reason: unknown): string[] {
  if (!reason || typeof reason !== 'object' || Array.isArray(reason)) return ['manager result.reason must be an object'];
  const value = reason as Record<string, unknown>;
  const errors: string[] = [];
  if (value.class !== 'transient' && value.class !== 'deterministic-input' && value.class !== 'state-conflict') {
    errors.push('manager result.reason.class is invalid');
  }
  if (value.class === 'state-conflict' && value.code !== 'marker_conflict') {
    errors.push('manager result.reason.code must be marker_conflict');
  }
  if (!nonEmpty(value.code)) errors.push('manager result.reason.code must be non-empty');
  if (!nonEmpty(value.rawCause)) errors.push('manager result.reason.rawCause must be non-empty');
  errors.push(...validateCreateIssueActionBinding(value.binding).map((error) => `manager result.reason.${error}`));
  if (value.invocationId !== undefined && !nonEmpty(value.invocationId)) {
    errors.push('manager result.reason.invocationId must be non-empty when present');
  }
  if (value.reviewerSlot !== undefined && !nonEmpty(value.reviewerSlot)) {
    errors.push('manager result.reason.reviewerSlot must be non-empty when present');
  }
  if (value.owned_prompt_seen !== undefined && typeof value.owned_prompt_seen !== 'boolean') {
    errors.push('manager result.reason.owned_prompt_seen must be boolean when present');
  }
  if (value.observed_user_heads !== undefined) {
    if (!Array.isArray(value.observed_user_heads) || value.observed_user_heads.some((item) => !nonEmpty(item))) {
      errors.push('manager result.reason.observed_user_heads must be a string array when present');
    }
  }
  return errors;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isCreateIssueSemanticStage(value: unknown): value is CreateIssueSemanticStage {
  return value === 'competitive'
    || value === 'architectural-review'
    || value === 'architectural-lens'
    || value === 'architectural'
    || value === 'acceptance';
}

export function validateCreateIssueActionBinding(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['binding must be an object'];
  const binding = value as Record<string, unknown>;
  const errors: string[] = [];
  if (!nonEmpty(binding.repository) || !/^[^/\s]+\/[^/\s]+$/.test(binding.repository)) {
    errors.push('binding.repository must be owner/name');
  }
  if (!Number.isSafeInteger(binding.issueNumber) || Number(binding.issueNumber) < 1) {
    errors.push('binding.issueNumber must be a positive integer');
  }
  if (!nonEmpty(binding.sourceRevision) || !/^r[0-9]+$/i.test(binding.sourceRevision)) {
    errors.push('binding.sourceRevision must be rNN');
  }
  if (!isCreateIssueSemanticStage(binding.stage)) {
    errors.push('binding.stage is invalid');
  }
  if (binding.stageAttemptId !== undefined && !nonEmpty(binding.stageAttemptId)) {
    errors.push('binding.stageAttemptId must be non-empty when present');
  }
  return errors;
}

export function validateCreateIssueNextAction(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['nextAction must be an object'];
  const action = value as Record<string, unknown>;
  const errors: string[] = [];
  if (action.schema !== CREATE_ISSUE_NEXT_ACTION_SCHEMA) errors.push(`nextAction.schema must be ${CREATE_ISSUE_NEXT_ACTION_SCHEMA}`);
  if (!nonEmpty(action.kind)) errors.push('nextAction.kind must be non-empty');
  errors.push(...validateCreateIssueActionBinding(action.binding).map((error) => `nextAction.${error}`));
  if (!Array.isArray(action.argv) || action.argv.length === 0 || action.argv.some((item) => !nonEmpty(item))) {
    errors.push('nextAction.argv must be a non-empty string vector');
  }
  return errors;
}

export function createIssueNextAction(input: {
  kind: string;
  binding: CreateIssueActionBinding;
  argv: readonly string[];
}): CreateIssueNextAction {
  const action: CreateIssueNextAction = {
    schema: CREATE_ISSUE_NEXT_ACTION_SCHEMA,
    kind: input.kind,
    binding: { ...input.binding },
    argv: [...input.argv],
  };
  const errors = validateCreateIssueNextAction(action);
  if (errors.length > 0) throw new Error(`invalid create-Issue nextAction: ${errors.join('; ')}`);
  return action;
}

export function createIssueTerminalResult(input: {
  ok: boolean;
  cause: string;
  blocker?: string;
  reason?: CreateIssueZeroSendReason;
  blockedOn?: CreateIssueBlockedOn;
}): CreateIssueTerminalResult {
  if (!nonEmpty(input.cause)) throw new Error('terminal create-Issue result cause must be non-empty');
  const result: CreateIssueTerminalResult = {
    ok: input.ok,
    cause: input.cause,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    ...(input.reason ? { reason: cloneZeroSendReason(input.reason) } : {}),
    ...(input.blockedOn ? { blocked_on: { ...input.blockedOn } } : {}),
    nextAction: null,
  };
  const errors = validateCreateIssueManagerResult(result);
  if (errors.length > 0) throw new Error('invalid terminal create-Issue result: ' + errors.join('; '));
  return result;
}

export function createIssueRecoverableResult(input: {
  cause: string;
  blocker?: string;
  nextAction: CreateIssueNextAction;
}): CreateIssueRecoverableResult {
  if (!nonEmpty(input.cause)) throw new Error('recoverable create-Issue result cause must be non-empty');
  const result: CreateIssueRecoverableResult = {
    ok: false,
    cause: input.cause,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    nextAction: input.nextAction,
  };
  const errors = validateCreateIssueManagerResult(result);
  if (errors.length > 0) throw new Error(`invalid recoverable create-Issue result: ${errors.join('; ')}`);
  return result;
}

export function sameCreateIssueActionBinding(
  expected: CreateIssueActionBinding,
  observed: Partial<CreateIssueActionBinding>,
): boolean {
  if (expected.repository.toLowerCase() !== String(observed.repository ?? '').toLowerCase()) return false;
  if (expected.issueNumber !== observed.issueNumber) return false;
  if (expected.sourceRevision.toLowerCase() !== String(observed.sourceRevision ?? '').toLowerCase()) return false;
  if (expected.stage !== observed.stage) return false;
  if (expected.stageAttemptId !== undefined || observed.stageAttemptId !== undefined) {
    return expected.stageAttemptId === observed.stageAttemptId;
  }
  return true;
}

export function createIssueStaleNextAction(input: {
  binding: CreateIssueActionBinding;
  observed: Partial<CreateIssueActionBinding>;
  nextAction?: CreateIssueNextAction | null;
}): CreateIssueStaleNextActionResult {
  const result: CreateIssueStaleNextActionResult = {
    ok: false,
    schema: CREATE_ISSUE_STALE_ACTION_SCHEMA,
    cause: 'stale_next_action',
    binding: { ...input.binding },
    observed: { ...input.observed },
    nextAction: input.nextAction ?? null,
  };
  const errors = validateCreateIssueManagerResult(result);
  if (errors.length > 0) throw new Error('invalid stale create-Issue result: ' + errors.join('; '));
  return result;
}

const EXISTING_PACED_RETRY_KIND = 'retry-create-issue-browser-preflight';

function cloneZeroSendReason(reason: CreateIssueZeroSendReason): CreateIssueZeroSendReason {
  return {
    class: reason.class,
    code: reason.code,
    rawCause: reason.rawCause,
    binding: { ...reason.binding },
    ...(reason.invocationId ? { invocationId: reason.invocationId } : {}),
    ...(reason.reviewerSlot ? { reviewerSlot: reason.reviewerSlot } : {}),
    ...(reason.owned_prompt_seen !== undefined ? { owned_prompt_seen: reason.owned_prompt_seen } : {}),
    ...(reason.observed_user_heads ? { observed_user_heads: [...reason.observed_user_heads] } : {}),
  };
}

export function existingPacedBoundedRetryAction(
  binding: CreateIssueActionBinding,
  reviewerSlot?: string,
): CreateIssueNextAction {
  const argv = [
    'node', '--experimental-strip-types', 'scripts/flow-manager-browser-gpt-long-run.ts',
    '--repository', binding.repository,
    '--issue-number', String(binding.issueNumber),
    '--source-revision', binding.sourceRevision,
    '--stage', binding.stage,
  ];
  if (binding.stageAttemptId) argv.push('--stage-attempt-id', binding.stageAttemptId);
  if (reviewerSlot) argv.push('--source-slot', reviewerSlot);
  return createIssueNextAction({
    kind: EXISTING_PACED_RETRY_KIND,
    binding,
    argv,
  });
}

export function projectZeroSendManagerResult(input: {
  policy: { class: ZeroSendCauseClass; code: string; rawCause: string } | null;
  attemptOrdinal: number;
  binding: CreateIssueActionBinding;
  invocationId?: string;
  reviewerSlot?: string;
  owned_prompt_seen?: boolean;
  observed_user_heads?: readonly string[];
  pacedRetryAction: CreateIssueNextAction;
  freshInvocationId?: string;
}): CreateIssueRecoverableResult | CreateIssueTerminalResult | null {
  if (!input.policy) return null;
  // A newly minted invocation id is not evidence that a deterministic cause was corrected.
  void input.freshInvocationId;
  const reason: CreateIssueZeroSendReason = {
    class: input.policy.class,
    code: input.policy.code,
    rawCause: input.policy.rawCause,
    binding: { ...input.binding },
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    ...(input.reviewerSlot ? { reviewerSlot: input.reviewerSlot } : {}),
    ...(input.owned_prompt_seen !== undefined ? { owned_prompt_seen: input.owned_prompt_seen } : {}),
    ...(input.observed_user_heads ? { observed_user_heads: [...input.observed_user_heads] } : {}),
  };
  const firstAttemptTransient = input.policy.class === 'transient' && input.attemptOrdinal === 1;
  if (!firstAttemptTransient) {
    return createIssueTerminalResult({
      ok: false,
      cause: input.policy.code,
      blocker: input.policy.rawCause,
      reason,
    });
  }
  if (input.pacedRetryAction.kind !== EXISTING_PACED_RETRY_KIND) {
    throw new Error('zero-send transient continuation must reuse the existing paced retry action');
  }
  if (input.pacedRetryAction.binding.stageAttemptId !== input.binding.stageAttemptId) {
    throw new Error('zero-send transient continuation must keep the canonical stageAttemptId');
  }
  return createIssueRecoverableResult({
    cause: input.policy.code,
    blocker: input.policy.rawCause,
    nextAction: input.pacedRetryAction,
  });
}

export function assertCreateIssueActionCurrent(input: {
  action: CreateIssueNextAction;
  observed: Partial<CreateIssueActionBinding>;
  nextAction?: CreateIssueNextAction | null;
}): CreateIssueStaleNextActionResult | null {
  const errors = validateCreateIssueNextAction(input.action);
  if (errors.length > 0) throw new Error(`invalid create-Issue nextAction: ${errors.join('; ')}`);
  return sameCreateIssueActionBinding(input.action.binding, input.observed)
    ? null
    : createIssueStaleNextAction({
        binding: input.action.binding,
        observed: input.observed,
        nextAction: input.nextAction ?? null,
      });
}
