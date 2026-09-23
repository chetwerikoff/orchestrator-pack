export const CREATE_ISSUE_NEXT_ACTION_SCHEMA = 'create-issue-next-action/v1' as const;
export const CREATE_ISSUE_STALE_ACTION_SCHEMA = 'create-issue-stale-next-action/v1' as const;

export const CREATE_ISSUE_NEXT_ACTION_KINDS = [
  'reconcile-stage-read-only',
  'produce-acceptance-artifacts',
  'retry-start-cycle',
  'retry-stage-record-publication',
  'retry-final-acceptance',
  'retry-create-issue-browser-preflight',
] as const;

export type CreateIssueNextActionKind = typeof CREATE_ISSUE_NEXT_ACTION_KINDS[number];

export const CREATE_ISSUE_RECONCILIATION_KINDS = [
  'reconcile-stage-read-only',
  'produce-acceptance-artifacts',
] as const satisfies readonly CreateIssueNextActionKind[];

export const CREATE_ISSUE_CONTINUATION_KINDS = [
  'retry-start-cycle',
  'retry-stage-record-publication',
  'retry-final-acceptance',
  'retry-create-issue-browser-preflight',
] as const satisfies readonly CreateIssueNextActionKind[];

export const CREATE_ISSUE_EXTERNAL_PAUSE_CAUSES = [
  'external:chrome_not_running',
  'external:login_required',
  'external:github_unavailable',
  'external:permission_denied',
  'external:quota_exhausted',
  'external:waiting_on_issue',
  'external:waiting_on_pr',
  'external:content_authority_conflict',
] as const;

export type CreateIssueExternalPauseCause = typeof CREATE_ISSUE_EXTERNAL_PAUSE_CAUSES[number];

export type CreateIssueResumePredicate =
  | { issue: number; condition: 'issue_closed' }
  | { pr: number; condition: 'pr_merged' }
  | { operator: true };

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
  kind: CreateIssueNextActionKind;
  binding: CreateIssueActionBinding;
  argv: string[];
}

export interface CreateIssueRecoverableResult {
  ok: false;
  cause: string;
  blocker?: string;
  reason?: CreateIssueZeroSendReason;
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
  ok: true;
  cause: string;
  blocker?: string;
  nextAction: null;
}

export interface CreateIssueStaleNextActionResult extends CreateIssueRecoverableResult {
  schema: typeof CREATE_ISSUE_STALE_ACTION_SCHEMA;
  cause: 'stale_next_action';
  binding: CreateIssueActionBinding;
  observed: Partial<CreateIssueActionBinding>;
  nextAction: CreateIssueNextAction;
}

export interface CreateIssueExternalPauseResult {
  ok: false;
  cause: CreateIssueExternalPauseCause;
  blocker?: string;
  reason?: CreateIssueZeroSendReason;
  pause: {
    remedy: string;
    resume_when: CreateIssueResumePredicate;
    evidence: string;
  };
  nextAction: null;
}

export interface CreateIssueContractDefectResult {
  ok: false;
  cause: 'producer_contract_defect' | 'self_recommendation';
  defect: {
    producer: string;
    detail: string[];
  };
  nextAction: null;
}

export type CreateIssueManagerResult =
  | CreateIssueTerminalResult
  | CreateIssueRecoverableResult
  | CreateIssueExternalPauseResult
  | CreateIssueContractDefectResult;

export function validateCreateIssueManagerResult(
  value: unknown,
  options: { boundary?: boolean } = {},
): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['manager result must be an object'];
  const result = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof result.ok !== 'boolean') errors.push('manager result.ok must be boolean');
  if (!Object.prototype.hasOwnProperty.call(result, 'nextAction')) {
    errors.push('manager result.nextAction must be present');
    return errors;
  }
  if (Object.prototype.hasOwnProperty.call(result, 'blocked_on')) {
    errors.push('manager result.blocked_on is retired; project the coordinator-supplied predicate to external_pause');
  }

  const nextAction = result.nextAction;
  const hasPause = Object.prototype.hasOwnProperty.call(result, 'pause');
  const hasDefect = Object.prototype.hasOwnProperty.call(result, 'defect');

  if (result.ok === true) {
    if (nextAction !== null) errors.push('completed manager result.nextAction must be null');
    if (hasPause) errors.push('completed manager result must not carry pause');
    if (hasDefect) errors.push('completed manager result must not carry defect');
    if (!nonEmpty(result.cause)) errors.push('completed manager result.cause must be non-empty');
  } else if (result.ok === false) {
    if (!nonEmpty(result.cause)) errors.push('manager non-success result.cause must be non-empty');
    if (hasPause && hasDefect) errors.push('manager non-success result cannot carry both pause and defect');
    if (hasPause) {
      if (nextAction !== null) errors.push('external_pause result.nextAction must be null');
      errors.push(...validateExternalPause(result));
    } else if (hasDefect) {
      if (!options.boundary) errors.push('contract_defect may only be constructed by the manager boundary');
      if (nextAction !== null) errors.push('contract_defect result.nextAction must be null');
      errors.push(...validateContractDefect(result));
    } else {
      if (nextAction === null) errors.push('recoverable manager result.nextAction must be non-null');
      else errors.push(...validateCreateIssueNextAction(nextAction));
      if (result.cause === 'stale_next_action') {
        if (result.schema !== CREATE_ISSUE_STALE_ACTION_SCHEMA) errors.push('stale manager result.schema is invalid');
        errors.push(...validateCreateIssueActionBinding(result.binding).map((error) => 'stale manager result.' + error));
        if (!result.observed || typeof result.observed !== 'object' || Array.isArray(result.observed)) {
          errors.push('stale manager result.observed must be an object');
        }
        if (
          nextAction
          && typeof nextAction === 'object'
          && !Array.isArray(nextAction)
          && (nextAction as Record<string, unknown>).kind !== 'reconcile-stage-read-only'
        ) {
          errors.push('stale manager result.nextAction.kind must be reconcile-stage-read-only');
        }
      }
    }
  }

  if (nextAction !== null && result.ok !== false) {
    errors.push(...validateCreateIssueNextAction(nextAction));
  }
  if (Object.prototype.hasOwnProperty.call(result, 'reason')) {
    errors.push(...validateZeroSendReason(result.reason));
  }
  return errors;
}

function validateExternalPause(result: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!CREATE_ISSUE_EXTERNAL_PAUSE_CAUSES.includes(result.cause as CreateIssueExternalPauseCause)) {
    errors.push('external_pause result.cause is invalid');
  }
  if (!result.pause || typeof result.pause !== 'object' || Array.isArray(result.pause)) {
    return [...errors, 'external_pause result.pause must be an object'];
  }
  const pause = result.pause as Record<string, unknown>;
  if (!nonEmpty(pause.remedy)) errors.push('external_pause result.pause.remedy must be non-empty');
  if (!nonEmpty(pause.evidence)) errors.push('external_pause result.pause.evidence must be non-empty');
  errors.push(...validateResumePredicate(pause.resume_when));
  const resume = pause.resume_when as Record<string, unknown> | undefined;
  if (result.cause === 'external:waiting_on_issue') {
    if (!resume || resume.condition !== 'issue_closed' || !Number.isSafeInteger(resume.issue)) {
      errors.push('external:waiting_on_issue requires issue_closed resume_when');
    }
  } else if (result.cause === 'external:waiting_on_pr') {
    if (!resume || resume.condition !== 'pr_merged' || !Number.isSafeInteger(resume.pr)) {
      errors.push('external:waiting_on_pr requires pr_merged resume_when');
    }
  } else if (!resume || resume.operator !== true) {
    errors.push('non-waiting external_pause cause requires resume_when { operator: true }');
  }
  return errors;
}

function validateContractDefect(result: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (result.cause !== 'producer_contract_defect' && result.cause !== 'self_recommendation') {
    errors.push('contract_defect result.cause is invalid');
  }
  if (!result.defect || typeof result.defect !== 'object' || Array.isArray(result.defect)) {
    return [...errors, 'contract_defect result.defect must be an object'];
  }
  const defect = result.defect as Record<string, unknown>;
  if (!nonEmpty(defect.producer)) errors.push('contract_defect result.defect.producer must be non-empty');
  if (!Array.isArray(defect.detail) || defect.detail.length === 0 || defect.detail.some((item) => !nonEmpty(item))) {
    errors.push('contract_defect result.defect.detail must be a non-empty string array');
  }
  return errors;
}

function validateResumePredicate(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['external_pause result.pause.resume_when must be a typed predicate'];
  }
  const predicate = value as Record<string, unknown>;
  const hasIssue = Object.prototype.hasOwnProperty.call(predicate, 'issue');
  const hasPr = Object.prototype.hasOwnProperty.call(predicate, 'pr');
  const hasOperator = Object.prototype.hasOwnProperty.call(predicate, 'operator');
  if (Number(hasIssue) + Number(hasPr) + Number(hasOperator) !== 1) {
    return ['external_pause result.pause.resume_when must have exactly one predicate selector'];
  }
  if (hasIssue) {
    return Number.isSafeInteger(predicate.issue)
      && Number(predicate.issue) > 0
      && predicate.condition === 'issue_closed'
      ? []
      : ['external_pause issue resume_when is invalid'];
  }
  if (hasPr) {
    return Number.isSafeInteger(predicate.pr)
      && Number(predicate.pr) > 0
      && predicate.condition === 'pr_merged'
      ? []
      : ['external_pause pr resume_when is invalid'];
  }
  return predicate.operator === true
    ? []
    : ['external_pause operator resume_when is invalid'];
}

export function validateCreateIssueBlockedOn(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['manager blocked_on input must be an object'];
  }
  const blockedOn = value as Record<string, unknown>;
  const errors: string[] = [];
  const hasIssue = Object.prototype.hasOwnProperty.call(blockedOn, 'issue');
  const hasPr = Object.prototype.hasOwnProperty.call(blockedOn, 'pr');
  if (hasIssue === hasPr) errors.push('manager blocked_on input must contain exactly one selector: issue or pr');
  if (!nonEmpty(blockedOn.evidence)) errors.push('manager blocked_on input.evidence must be non-empty');
  if (hasIssue && (!Number.isSafeInteger(blockedOn.issue) || Number(blockedOn.issue) < 1)) {
    errors.push('manager blocked_on input.issue must be a positive integer');
  }
  if (hasPr && (!Number.isSafeInteger(blockedOn.pr) || Number(blockedOn.pr) < 1)) {
    errors.push('manager blocked_on input.pr must be a positive integer');
  }
  if (hasIssue && !hasPr && blockedOn.condition !== 'issue_closed') {
    errors.push('manager blocked_on input.condition must be issue_closed for an issue selector');
  }
  if (hasPr && !hasIssue && blockedOn.condition !== 'pr_merged') {
    errors.push('manager blocked_on input.condition must be pr_merged for a pr selector');
  }
  const allowed = new Set(['issue', 'pr', 'condition', 'evidence']);
  const unexpected = Object.keys(blockedOn).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) errors.push('manager blocked_on input has unexpected fields: ' + unexpected.sort().join(', '));
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
  if (!isCreateIssueSemanticStage(binding.stage)) errors.push('binding.stage is invalid');
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
  if (!CREATE_ISSUE_NEXT_ACTION_KINDS.includes(action.kind as CreateIssueNextActionKind)) {
    errors.push('nextAction.kind is outside the closed manager kind set');
  }
  errors.push(...validateCreateIssueActionBinding(action.binding).map((error) => `nextAction.${error}`));
  if (!Array.isArray(action.argv) || action.argv.length === 0 || action.argv.some((item) => !nonEmpty(item))) {
    errors.push('nextAction.argv must be a non-empty string vector');
  }
  return errors;
}

export function createIssueNextAction(input: {
  kind: CreateIssueNextActionKind;
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
  ok: true;
  cause: string;
  blocker?: string;
}): CreateIssueTerminalResult {
  if (!nonEmpty(input.cause)) throw new Error('completed create-Issue result cause must be non-empty');
  const result: CreateIssueTerminalResult = {
    ok: true,
    cause: input.cause,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    nextAction: null,
  };
  const errors = validateCreateIssueManagerResult(result);
  if (errors.length > 0) throw new Error('invalid completed create-Issue result: ' + errors.join('; '));
  return result;
}

export function createIssueRecoverableResult(input: {
  cause: string;
  blocker?: string;
  reason?: CreateIssueZeroSendReason;
  nextAction: CreateIssueNextAction;
}): CreateIssueRecoverableResult {
  if (!nonEmpty(input.cause)) throw new Error('recoverable create-Issue result cause must be non-empty');
  const result: CreateIssueRecoverableResult = {
    ok: false,
    cause: input.cause,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    ...(input.reason ? { reason: cloneZeroSendReason(input.reason) } : {}),
    nextAction: input.nextAction,
  };
  const errors = validateCreateIssueManagerResult(result);
  if (errors.length > 0) throw new Error(`invalid recoverable create-Issue result: ${errors.join('; ')}`);
  return result;
}

export function createIssueExternalPauseResult(input: {
  cause: CreateIssueExternalPauseCause;
  remedy: string;
  resumeWhen: CreateIssueResumePredicate;
  evidence: string;
  blocker?: string;
  reason?: CreateIssueZeroSendReason;
}): CreateIssueExternalPauseResult {
  const result: CreateIssueExternalPauseResult = {
    ok: false,
    cause: input.cause,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    ...(input.reason ? { reason: cloneZeroSendReason(input.reason) } : {}),
    pause: {
      remedy: input.remedy,
      resume_when: { ...input.resumeWhen },
      evidence: input.evidence,
    },
    nextAction: null,
  };
  const errors = validateCreateIssueManagerResult(result);
  if (errors.length > 0) throw new Error('invalid external_pause create-Issue result: ' + errors.join('; '));
  return result;
}

export function projectBlockedOnToExternalPause(
  blockedOn: CreateIssueBlockedOn,
  remedy = 'wait for the coordinator-supplied external predicate, then resume this same live Dispatch',
): CreateIssueExternalPauseResult {
  const errors = validateCreateIssueBlockedOn(blockedOn);
  if (errors.length > 0) throw new Error('invalid blocked_on projection input: ' + errors.join('; '));
  if ('issue' in blockedOn) {
    return createIssueExternalPauseResult({
      cause: 'external:waiting_on_issue',
      remedy,
      resumeWhen: { issue: blockedOn.issue, condition: blockedOn.condition },
      evidence: blockedOn.evidence,
    });
  }
  return createIssueExternalPauseResult({
    cause: 'external:waiting_on_pr',
    remedy,
    resumeWhen: { pr: blockedOn.pr, condition: blockedOn.condition },
    evidence: blockedOn.evidence,
  });
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
  nextAction: CreateIssueNextAction;
}): CreateIssueStaleNextActionResult {
  const result: CreateIssueStaleNextActionResult = {
    ok: false,
    schema: CREATE_ISSUE_STALE_ACTION_SCHEMA,
    cause: 'stale_next_action',
    binding: { ...input.binding },
    observed: { ...input.observed },
    nextAction: input.nextAction,
  };
  const errors = validateCreateIssueManagerResult(result);
  if (errors.length > 0) throw new Error('invalid stale create-Issue result: ' + errors.join('; '));
  return result;
}

const EXISTING_PACED_RETRY_KIND: CreateIssueNextActionKind = 'retry-create-issue-browser-preflight';

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

function externalCauseFromRecordedEvidence(rawCause: string): CreateIssueExternalPauseCause | null {
  const normalized = rawCause.toLowerCase();
  if (/\b(?:github|http\s*5\d\d|503|502|504|api unavailable)\b/u.test(normalized)) {
    return 'external:github_unavailable';
  }
  if (/\b(?:chrome|cdp|connection refused|browser not running)\b/u.test(normalized)) {
    return 'external:chrome_not_running';
  }
  if (/\b(?:login|required sign[- ]?in|authentication required)\b/u.test(normalized)) {
    return 'external:login_required';
  }
  if (/\b(?:quota|rate limit|429)\b/u.test(normalized)) {
    return 'external:quota_exhausted';
  }
  if (/\b(?:permission denied|forbidden|403)\b/u.test(normalized)) {
    return 'external:permission_denied';
  }
  return null;
}

function defaultReadOnlyReconciliationAction(binding: CreateIssueActionBinding): CreateIssueNextAction {
  const argv = [
    'node', '--experimental-strip-types', 'scripts/create-issue-stage-finalize.ts',
    'reconcile-stage',
    '--repo', binding.repository,
    '--issue-number', String(binding.issueNumber),
    '--expected-source-revision', binding.sourceRevision,
    '--expected-stage', binding.stage,
  ];
  if (binding.stageAttemptId) argv.push('--expected-stage-attempt-id', binding.stageAttemptId);
  argv.push('--json');
  return createIssueNextAction({
    kind: 'reconcile-stage-read-only',
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
  reconcileAction?: CreateIssueNextAction;
  freshInvocationId?: string;
}): CreateIssueRecoverableResult | CreateIssueExternalPauseResult | null {
  if (!input.policy) return null;
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
  if (input.policy.class === 'deterministic-input' || input.policy.class === 'state-conflict') {
    const reconcileAction = input.reconcileAction ?? defaultReadOnlyReconciliationAction(input.binding);
    if (reconcileAction.kind !== 'reconcile-stage-read-only') {
      throw new Error('zero-send deterministic/state-conflict continuation must reconcile read-only');
    }
    return createIssueRecoverableResult({
      cause: input.policy.code,
      blocker: input.policy.rawCause,
      reason,
      nextAction: reconcileAction,
    });
  }
  if (input.attemptOrdinal === 1) {
    if (input.pacedRetryAction.kind !== EXISTING_PACED_RETRY_KIND) {
      throw new Error('zero-send transient continuation must reuse the existing paced retry action');
    }
    if (input.pacedRetryAction.binding.stageAttemptId !== input.binding.stageAttemptId) {
      throw new Error('zero-send transient continuation must keep the canonical stageAttemptId');
    }
    return createIssueRecoverableResult({
      cause: input.policy.code,
      blocker: input.policy.rawCause,
      reason,
      nextAction: input.pacedRetryAction,
    });
  }
  const externalCause = externalCauseFromRecordedEvidence(input.policy.rawCause);
  if (!externalCause) {
    throw new Error('exhausted transient zero-send retry lacks classifiable external evidence: ' + input.policy.rawCause);
  }
  return createIssueExternalPauseResult({
    cause: externalCause,
    remedy: 'restore the named external dependency, then resume this same live Dispatch',
    resumeWhen: { operator: true },
    evidence: input.policy.rawCause,
    blocker: input.policy.rawCause,
    reason,
  });
}

export function assertCreateIssueActionCurrent(input: {
  action: CreateIssueNextAction;
  observed: Partial<CreateIssueActionBinding>;
  nextAction: CreateIssueNextAction;
}): CreateIssueStaleNextActionResult | null {
  const errors = validateCreateIssueNextAction(input.action);
  if (errors.length > 0) throw new Error(`invalid create-Issue nextAction: ${errors.join('; ')}`);
  return sameCreateIssueActionBinding(input.action.binding, input.observed)
    ? null
    : createIssueStaleNextAction({
        binding: input.action.binding,
        observed: input.observed,
        nextAction: input.nextAction,
      });
}
