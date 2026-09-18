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

export interface CreateIssueTerminalResult {
  ok: boolean;
  cause: string;
  blocker?: string;
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
}): CreateIssueTerminalResult {
  if (!nonEmpty(input.cause)) throw new Error('terminal create-Issue result cause must be non-empty');
  return {
    ok: input.ok,
    cause: input.cause,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    nextAction: null,
  };
}

export function createIssueRecoverableResult(input: {
  cause: string;
  blocker?: string;
  nextAction: CreateIssueNextAction;
}): CreateIssueRecoverableResult {
  if (!nonEmpty(input.cause)) throw new Error('recoverable create-Issue result cause must be non-empty');
  const errors = validateCreateIssueNextAction(input.nextAction);
  if (errors.length > 0) throw new Error(`invalid recoverable create-Issue nextAction: ${errors.join('; ')}`);
  return {
    ok: false,
    cause: input.cause,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    nextAction: input.nextAction,
  };
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
  return {
    ok: false,
    schema: CREATE_ISSUE_STALE_ACTION_SCHEMA,
    cause: 'stale_next_action',
    binding: { ...input.binding },
    observed: { ...input.observed },
    nextAction: input.nextAction ?? null,
  };
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
