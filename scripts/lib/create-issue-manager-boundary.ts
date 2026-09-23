import { createHash } from 'node:crypto';
import {
  createIssueExternalPauseResult,
  createIssueRecoverableResult,
  validateCreateIssueManagerResult,
  type CreateIssueActionBinding,
  type CreateIssueContractDefectResult,
  type CreateIssueExternalPauseCause,
  type CreateIssueManagerResult,
  type CreateIssueNextAction,
  type CreateIssueResumePredicate,
  type CreateIssueSemanticStage,
} from './create-issue-next-action.ts';

export const CREATE_ISSUE_MANAGER_ENTRYPOINTS = [
  'create-issue-stage-record-cli.ts:main',
  'flow-manager-browser-gpt-long-run.ts:main',
  'create-issue-browser-gpt-preflight.ts:caller',
] as const;

export type CreateIssueManagerBoundaryProducer = typeof CREATE_ISSUE_MANAGER_ENTRYPOINTS[number] | string;

export interface CreateIssueManagerBoundaryInput {
  producer: CreateIssueManagerBoundaryProducer;
  currentArgv: readonly string[];
  produce: () => unknown;
  reconcileAction?: CreateIssueNextAction;
  retryAction?: CreateIssueNextAction;
  externalEvidence?: {
    cause: CreateIssueExternalPauseCause;
    evidence: string;
    remedy: string;
  };
  retryBudgetEvidence?: {
    reviewerSlot: string;
    externalCauses: readonly string[];
  };
}

export interface CreateIssueManagerBoundaryEvaluation {
  result: CreateIssueManagerResult;
  exitCode: 0 | 3 | 4 | 5;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function defect(
  producer: string,
  cause: CreateIssueContractDefectResult['cause'],
  detail: readonly string[],
): CreateIssueContractDefectResult {
  const result: CreateIssueContractDefectResult = {
    ok: false,
    cause,
    defect: {
      producer,
      detail: detail.length > 0 ? [...detail] : ['unspecified manager boundary defect'],
    },
    nextAction: null,
  };
  const errors = validateCreateIssueManagerResult(result, { boundary: true });
  if (errors.length > 0) throw new Error('manager boundary produced invalid contract_defect: ' + errors.join('; '));
  return result;
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function retryBudgetExternalCause(causes: readonly string[]): CreateIssueExternalPauseCause | null {
  if (causes.length < 2 || causes.some((cause) => !nonEmpty(cause))) return null;
  const joined = causes.join('\n').toLowerCase();
  if (/github|http\s*5\d\d|503|502|504/u.test(joined)) return 'external:github_unavailable';
  if (/chrome|cdp|browser/u.test(joined)) return 'external:chrome_not_running';
  if (/login|sign[- ]?in|authentication/u.test(joined)) return 'external:login_required';
  if (/quota|429|rate limit/u.test(joined)) return 'external:quota_exhausted';
  if (/permission|forbidden|403/u.test(joined)) return 'external:permission_denied';
  return null;
}

function classifyThrown(input: CreateIssueManagerBoundaryInput, error: unknown): CreateIssueManagerResult {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (input.externalEvidence) {
    return createIssueExternalPauseResult({
      cause: input.externalEvidence.cause,
      evidence: input.externalEvidence.evidence,
      remedy: input.externalEvidence.remedy,
      resumeWhen: { operator: true },
      blocker: message,
    });
  }

  if (/authoritative github artifact.*edited|foreign[- ]comment|publisher mismatch|principal mismatch/u.test(lower)) {
    return createIssueExternalPauseResult({
      cause: 'external:content_authority_conflict',
      evidence: message,
      remedy: 'resolve the authoritative GitHub content/principal conflict, then resume this same live Dispatch',
      resumeWhen: { operator: true },
      blocker: message,
    });
  }

  if (/reviewerslot\s+\S+\s+retry budget is exhausted/u.test(lower)) {
    const evidence = input.retryBudgetEvidence;
    const cause = evidence ? retryBudgetExternalCause(evidence.externalCauses) : null;
    if (evidence && cause) {
      return createIssueExternalPauseResult({
        cause,
        evidence: evidence.externalCauses.join('; '),
        remedy: 'restore the external reviewer transport condition, then resume this same live Dispatch',
        resumeWhen: { operator: true },
        blocker: message,
      });
    }
    return defect(input.producer, 'producer_contract_defect', [
      message,
      ...(evidence ? [`transport slot ${evidence.reviewerSlot} exhausted without two classifiable external turn_result_cause values`] : []),
    ]);
  }

  if (/temporary|source-unavailable|identity-unresolved|observation-lost/u.test(lower) && input.retryAction) {
    return createIssueRecoverableResult({
      cause: 'temporary_source_unavailable',
      blocker: message,
      nextAction: input.retryAction,
    });
  }

  if (/stale_next_action/u.test(lower) && input.reconcileAction) {
    return createIssueRecoverableResult({
      cause: 'stale_next_action',
      blocker: message,
      nextAction: input.reconcileAction,
    });
  }

  if (input.reconcileAction) {
    return createIssueRecoverableResult({
      cause: 'repository_invariant_requires_reconciliation',
      blocker: message,
      nextAction: input.reconcileAction,
    });
  }

  return defect(input.producer, 'producer_contract_defect', [message]);
}

export function evaluateCreateIssueManagerBoundary(
  input: CreateIssueManagerBoundaryInput,
): CreateIssueManagerBoundaryEvaluation {
  let candidate: CreateIssueManagerResult;
  try {
    const value = input.produce();
    const errors = validateCreateIssueManagerResult(value, { boundary: true });
    if (errors.length > 0) {
      candidate = defect(input.producer, 'producer_contract_defect', errors);
    } else {
      candidate = value as CreateIssueManagerResult;
    }
  } catch (error) {
    candidate = classifyThrown(input, error);
  }

  if (candidate.ok === false && candidate.nextAction !== null && sameArgv(candidate.nextAction.argv, input.currentArgv)) {
    candidate = defect(input.producer, 'self_recommendation', [
      'recoverable nextAction.argv is byte-identical to the invocation currently emitting it',
      candidate.nextAction.argv.join(' '),
    ]);
  }

  return {
    result: candidate,
    exitCode: createIssueManagerExitCode(candidate),
  };
}

export function createIssueManagerExitCode(result: CreateIssueManagerResult): 0 | 3 | 4 | 5 {
  if (result.ok === true) return 0;
  if ('defect' in result) return 5;
  if ('pause' in result) return 4;
  return 3;
}

export function emitCreateIssueManagerResult(
  input: CreateIssueManagerBoundaryInput & {
    stdout?: (text: string) => void;
  },
): CreateIssueManagerBoundaryEvaluation {
  const evaluation = evaluateCreateIssueManagerBoundary(input);
  (input.stdout ?? ((text) => process.stdout.write(text)))(JSON.stringify(evaluation.result) + '\n');
  return evaluation;
}

export function createIssueEscalationThreadId(input: {
  issueNumber: number;
  stage: CreateIssueSemanticStage;
  cause: string;
  resumeWhen: CreateIssueResumePredicate | null;
}): string {
  const canonical = JSON.stringify({
    issue: input.issueNumber,
    stage: input.stage,
    cause: input.cause,
    resume_when: input.resumeWhen,
  });
  return 'create-issue-escalation-' + createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export function reconcileActionForInvocation(input: {
  binding: CreateIssueActionBinding;
  argv: readonly string[];
}): CreateIssueNextAction {
  return {
    schema: 'create-issue-next-action/v1',
    kind: 'reconcile-stage-read-only',
    binding: { ...input.binding },
    argv: [...input.argv],
  };
}
