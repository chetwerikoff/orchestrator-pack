export const MANAGER_NEXT_ACTION_SCHEMA = 'manager-next-action/v1' as const;

export const MANAGER_NEXT_ACTION_KINDS = [
  'execute-observe-owned-turn',
  'execute-github-first-read-only',
  'execute-review-runner-read-only',
] as const;

export type ManagerNextActionKind = typeof MANAGER_NEXT_ACTION_KINDS[number];
export type ExecuteIssueManagerPhase = 'implementation' | 'review' | 'fixer' | 'independent-smoke';
export type ManagerStage = `execute:${ExecuteIssueManagerPhase}`;

export const MANAGER_EXTERNAL_PAUSE_CAUSES = [
  'external:chrome_not_running',
  'external:profile_mismatch',
  'external:login_required',
  'external:product_challenge',
  'external:github_unavailable',
  'external:permission_denied',
  'external:quota_exhausted',
  'external:waiting_on_issue',
  'external:waiting_on_pr',
  'external:content_authority_conflict',
] as const;

export type ManagerExternalPauseCause = typeof MANAGER_EXTERNAL_PAUSE_CAUSES[number];
export type ManagerResumePredicate =
  | { issue: number; condition: 'issue_closed' }
  | { pr: number; condition: 'pr_merged' }
  | { coordinator: true };

export interface ManagerActionBinding {
  repository: string;
  issueNumber: number;
  sourceRevision: string;
  stage: ManagerStage;
}

export interface ManagerNextAction {
  schema: typeof MANAGER_NEXT_ACTION_SCHEMA;
  kind: ManagerNextActionKind;
  binding: ManagerActionBinding;
  argv: string[];
}

export type ZeroSendCauseClass = 'transient' | 'deterministic-input' | 'state-conflict';
export interface ManagerZeroSendReason {
  class: ZeroSendCauseClass;
  code: string;
  rawCause: string;
  binding: ManagerActionBinding;
  invocationId?: string;
  reviewerSlot?: string;
  owned_prompt_seen?: boolean;
  observed_user_heads?: readonly string[];
}

export interface ManagerTerminalResult {
  ok: true;
  cause: string;
  blocker?: string;
  verdict?: 'PASS' | 'FAIL';
  nextAction: null;
}

export interface ManagerRecoverableResult {
  ok: false;
  cause: string;
  blocker?: string;
  reason?: ManagerZeroSendReason;
  nextAction: ManagerNextAction;
}

export interface ManagerExternalPauseResult {
  ok: false;
  cause: ManagerExternalPauseCause;
  blocker?: string;
  reason?: ManagerZeroSendReason;
  pause: {
    remedy: string;
    resume_when: ManagerResumePredicate;
    evidence: string;
  };
  nextAction: null;
}

export interface ManagerContractDefectResult {
  ok: false;
  cause: 'producer_contract_defect' | 'self_recommendation';
  defect: {
    producer: string;
    detail: string[];
  };
  nextAction: null;
}

export type ManagerResult =
  | ManagerTerminalResult
  | ManagerRecoverableResult
  | ManagerExternalPauseResult
  | ManagerContractDefectResult;

export interface ManagerBoundaryEvaluation {
  result: ManagerResult;
  exitCode: 0 | 3 | 4 | 5;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeResumePredicate(value: unknown): ManagerResumePredicate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length === 1 && row.coordinator === true) return { coordinator: true };
  if (keys.length === 1 && row.operator === true) return { coordinator: true };
  if (
    keys.length === 2
    && Number.isSafeInteger(row.issue)
    && Number(row.issue) > 0
    && row.condition === 'issue_closed'
  ) return { issue: Number(row.issue), condition: 'issue_closed' };
  if (
    keys.length === 2
    && Number.isSafeInteger(row.pr)
    && Number(row.pr) > 0
    && row.condition === 'pr_merged'
  ) return { pr: Number(row.pr), condition: 'pr_merged' };
  return null;
}

function normalizeLegacyResumePredicate(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  if (!result.pause || typeof result.pause !== 'object' || Array.isArray(result.pause)) return value;
  const pause = result.pause as Record<string, unknown>;
  const normalized = normalizeResumePredicate(pause.resume_when);
  if (!normalized) return value;
  return { ...result, pause: { ...pause, resume_when: normalized } };
}

function validStage(value: unknown): value is ManagerStage {
  return value === 'execute:implementation'
    || value === 'execute:review'
    || value === 'execute:fixer'
    || value === 'execute:independent-smoke';
}

export function validateManagerActionBinding(value: unknown): string[] {
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
  if (!validStage(binding.stage)) errors.push('binding.stage is invalid');
  return errors;
}

export function validateManagerNextAction(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['nextAction must be an object'];
  const action = value as Record<string, unknown>;
  const errors: string[] = [];
  if (action.schema !== MANAGER_NEXT_ACTION_SCHEMA) {
    errors.push('nextAction.schema must be ' + MANAGER_NEXT_ACTION_SCHEMA);
  }
  if (!MANAGER_NEXT_ACTION_KINDS.includes(action.kind as ManagerNextActionKind)) {
    errors.push('nextAction.kind is outside the closed manager kind set');
  }
  errors.push(...validateManagerActionBinding(action.binding).map((error) => 'nextAction.' + error));
  if (!Array.isArray(action.argv) || action.argv.length === 0 || action.argv.some((item) => !nonEmpty(item))) {
    errors.push('nextAction.argv must be a non-empty string vector');
  }
  return errors;
}

function validateReason(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['manager result.reason must be an object'];
  const reason = value as Record<string, unknown>;
  const errors: string[] = [];
  if (!['transient', 'deterministic-input', 'state-conflict'].includes(String(reason.class))) {
    errors.push('manager result.reason.class is invalid');
  }
  if (!nonEmpty(reason.code)) errors.push('manager result.reason.code must be non-empty');
  if (!nonEmpty(reason.rawCause)) errors.push('manager result.reason.rawCause must be non-empty');
  errors.push(...validateManagerActionBinding(reason.binding).map((error) => 'manager result.reason.' + error));
  return errors;
}

function validatePause(result: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!MANAGER_EXTERNAL_PAUSE_CAUSES.includes(result.cause as ManagerExternalPauseCause)) {
    errors.push('external_pause result.cause is invalid');
  }
  if (!result.pause || typeof result.pause !== 'object' || Array.isArray(result.pause)) {
    return [...errors, 'external_pause result.pause must be an object'];
  }
  const pause = result.pause as Record<string, unknown>;
  if (!nonEmpty(pause.remedy)) errors.push('external_pause result.pause.remedy must be non-empty');
  if (!nonEmpty(pause.evidence)) errors.push('external_pause result.pause.evidence must be non-empty');
  const resume = normalizeResumePredicate(pause.resume_when);
  if (!resume) errors.push('external_pause result.pause.resume_when is invalid');
  if (result.cause === 'external:waiting_on_issue' && (!resume || !('issue' in resume))) {
    errors.push('external:waiting_on_issue requires issue_closed resume_when');
  } else if (result.cause === 'external:waiting_on_pr' && (!resume || !('pr' in resume))) {
    errors.push('external:waiting_on_pr requires pr_merged resume_when');
  } else if (
    result.cause !== 'external:waiting_on_issue'
    && result.cause !== 'external:waiting_on_pr'
    && (!resume || !('coordinator' in resume))
  ) {
    errors.push('non-waiting external_pause requires coordinator-owned resume_when');
  }
  return errors;
}

export function validateManagerResult(value: unknown, options: { boundary?: boolean } = {}): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['manager result must be an object'];
  const result = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof result.ok !== 'boolean') errors.push('manager result.ok must be boolean');
  if (!Object.prototype.hasOwnProperty.call(result, 'nextAction')) {
    errors.push('manager result.nextAction must be present');
    return errors;
  }
  const nextAction = result.nextAction;
  const hasPause = Object.prototype.hasOwnProperty.call(result, 'pause');
  const hasDefect = Object.prototype.hasOwnProperty.call(result, 'defect');
  if (result.ok === true) {
    if (nextAction !== null) errors.push('completed manager result.nextAction must be null');
    if (!nonEmpty(result.cause)) errors.push('completed manager result.cause must be non-empty');
    const expectedVerdict = result.cause === 'execute_worker_smoke_pass'
      ? 'PASS'
      : result.cause === 'execute_worker_smoke_assertion_failed' ? 'FAIL' : null;
    if (expectedVerdict && result.verdict !== expectedVerdict) {
      errors.push('completed worker-smoke result.verdict must match its cause');
    } else if (!expectedVerdict && Object.prototype.hasOwnProperty.call(result, 'verdict')) {
      errors.push('completed non-smoke result must not carry verdict');
    }
  } else if (result.ok === false) {
    if (!nonEmpty(result.cause)) errors.push('manager non-success result.cause must be non-empty');
    if (hasPause && hasDefect) errors.push('manager non-success result cannot carry both pause and defect');
    if (hasPause) {
      if (nextAction !== null) errors.push('external_pause result.nextAction must be null');
      errors.push(...validatePause(result));
    } else if (hasDefect) {
      if (!options.boundary) errors.push('contract_defect may only be constructed by the manager boundary');
      if (nextAction !== null) errors.push('contract_defect result.nextAction must be null');
    } else {
      if (nextAction === null) errors.push('recoverable manager result.nextAction must be non-null');
      else errors.push(...validateManagerNextAction(nextAction));
    }
  }
  if (Object.prototype.hasOwnProperty.call(result, 'reason')) errors.push(...validateReason(result.reason));
  return errors;
}

export function managerNextAction(input: {
  kind: ManagerNextActionKind;
  binding: ManagerActionBinding;
  argv: readonly string[];
}): ManagerNextAction {
  const action: ManagerNextAction = {
    schema: MANAGER_NEXT_ACTION_SCHEMA,
    kind: input.kind,
    binding: { ...input.binding },
    argv: [...input.argv],
  };
  const errors = validateManagerNextAction(action);
  if (errors.length) throw new Error('invalid manager nextAction: ' + errors.join('; '));
  return action;
}

export function managerTerminalResult(input: {
  ok: true;
  cause: string;
  blocker?: string;
  verdict?: 'PASS' | 'FAIL';
}): ManagerTerminalResult {
  const result: ManagerTerminalResult = {
    ok: true,
    cause: input.cause,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    ...(input.verdict ? { verdict: input.verdict } : {}),
    nextAction: null,
  };
  const errors = validateManagerResult(result);
  if (errors.length) throw new Error('invalid completed manager result: ' + errors.join('; '));
  return result;
}

export function managerRecoverableResult(input: {
  cause: string;
  blocker?: string;
  reason?: ManagerZeroSendReason;
  nextAction: ManagerNextAction;
}): ManagerRecoverableResult {
  const result: ManagerRecoverableResult = {
    ok: false,
    cause: input.cause,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    ...(input.reason ? { reason: { ...input.reason, binding: { ...input.reason.binding } } } : {}),
    nextAction: input.nextAction,
  };
  const errors = validateManagerResult(result);
  if (errors.length) throw new Error('invalid recoverable manager result: ' + errors.join('; '));
  return result;
}

export function managerExternalPauseResult(input: {
  cause: ManagerExternalPauseCause;
  remedy: string;
  resumeWhen: ManagerResumePredicate;
  evidence: string;
  blocker?: string;
  reason?: ManagerZeroSendReason;
}): ManagerExternalPauseResult {
  const result: ManagerExternalPauseResult = {
    ok: false,
    cause: input.cause,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    ...(input.reason ? { reason: { ...input.reason, binding: { ...input.reason.binding } } } : {}),
    pause: {
      remedy: input.remedy,
      resume_when: { ...input.resumeWhen },
      evidence: input.evidence,
    },
    nextAction: null,
  };
  const errors = validateManagerResult(result);
  if (errors.length) throw new Error('invalid external_pause manager result: ' + errors.join('; '));
  return result;
}

function contractDefect(producer: string, detail: string[]): ManagerContractDefectResult {
  return { ok: false, cause: 'producer_contract_defect', defect: { producer, detail }, nextAction: null };
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function evaluateManagerBoundary(input: {
  producer: string;
  currentArgv: readonly string[];
  produce: () => unknown;
}): ManagerBoundaryEvaluation {
  let candidate: unknown;
  try {
    candidate = input.produce();
  } catch (error) {
    return {
      result: contractDefect(input.producer, [error instanceof Error ? error.message : String(error)]),
      exitCode: 5,
    };
  }
  const readable = normalizeLegacyResumePredicate(candidate);
  const errors = validateManagerResult(readable, { boundary: true });
  if (errors.length) return { result: contractDefect(input.producer, errors), exitCode: 5 };
  const result = readable as ManagerResult;
  if (!result.ok && result.nextAction !== null && sameArgv(result.nextAction.argv, input.currentArgv)) {
    const defect: ManagerContractDefectResult = {
      ...contractDefect(input.producer, ['recoverable nextAction.argv must not be byte-identical to currentArgv']),
      cause: 'self_recommendation',
    };
    return { result: defect, exitCode: 5 };
  }
  if (result.ok) return { result, exitCode: 0 };
  if (MANAGER_EXTERNAL_PAUSE_CAUSES.includes(result.cause as ManagerExternalPauseCause)) {
    return { result, exitCode: 4 };
  }
  if (result.cause === 'producer_contract_defect' || result.cause === 'self_recommendation') {
    return { result, exitCode: 5 };
  }
  if (result.nextAction === null) {
    return {
      result: contractDefect(input.producer, ['non-success result requires nextAction, external pause, or contract defect']),
      exitCode: 5,
    };
  }
  return { result, exitCode: 3 };
}
