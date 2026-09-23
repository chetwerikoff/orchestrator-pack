import { TURN_STATES, type TurnResultV1, type TurnState } from '../chatgpt-browser-turn/contracts.ts';
import {
  projectExecutionRecoveryInspect,
  type ExecutionRecoveryInspectEvidence,
  type ProbeStatus,
} from '../browser-gpt-page-probe.ts';
import {
  CREATE_ISSUE_NEXT_ACTION_KINDS,
  createIssueExternalPauseResult,
  createIssueNextAction,
  createIssueRecoverableResult,
  createIssueTerminalResult,
  validateCreateIssueNextAction,
  type CreateIssueActionBinding,
  type CreateIssueExternalPauseCause,
  type CreateIssueNextAction,
} from './create-issue-next-action.ts';
import {
  evaluateCreateIssueManagerBoundary,
  type CreateIssueManagerBoundaryEvaluation,
} from './create-issue-manager-boundary.ts';

export const EXECUTE_ISSUE_PHASES = ['implementation', 'review', 'fixer'] as const;
export type ExecuteIssuePhase = typeof EXECUTE_ISSUE_PHASES[number];

type ClassificationClass = 'completed' | 'recoverable' | 'external_pause' | 'contract_defect' | 'conditional';

export const EXECUTE_ISSUE_TURN_CLASSIFICATION = {
  ok: 'completed',
  input_invalid: 'conditional',
  quota: 'external_pause',
  rate_limit: 'recoverable',
  challenge: 'external_pause',
  login: 'external_pause',
  stream_timeout: 'recoverable',
  send_failed: 'recoverable',
  no_reply: 'recoverable',
  chrome_not_running: 'external_pause',
  driver_error: 'conditional',
  profile_mismatch: 'conditional',
  recovery_required: 'conditional',
  orphaned_fresh_turn: 'recoverable',
  ui_contract_mismatch: 'conditional',
  foreign_activity: 'external_pause',
  observation_uncertain: 'recoverable',
  output_conflict: 'external_pause',
  conversation_busy: 'recoverable',
  profile_busy: 'recoverable',
  incompatible_record: 'conditional',
} as const satisfies Record<TurnState, ClassificationClass>;

export const EXECUTE_ISSUE_PROBE_CLASSIFICATION = {
  ok: 'conditional',
  not_found: 'recoverable',
  ambiguous: 'external_pause',
  stale_node: 'recoverable',
  unsafe_output: 'contract_defect',
  surface_unknown: 'recoverable',
  unavailable: 'conditional',
  export_failed: 'recoverable',
  cleanup_failed: 'recoverable',
  input_invalid: 'conditional',
} as const satisfies Record<ProbeStatus, ClassificationClass>;

export interface ExecuteIssueManagerBoundaryContext {
  repository: string;
  issueNumber: number;
  sourceRevision: string;
  phase: ExecuteIssuePhase;
  cdp?: string;
  targetId?: string;
  conversationUrl?: string;
  prNumber?: number;
  currentArgv?: readonly string[];
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function evidence(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== '{}' ? serialized.slice(0, 4_000) : 'execute-Issue producer result';
  } catch {
    return 'execute-Issue producer result';
  }
}

function actionBinding(context: ExecuteIssueManagerBoundaryContext): CreateIssueActionBinding {
  return {
    repository: context.repository,
    issueNumber: context.issueNumber,
    sourceRevision: context.sourceRevision,
    stage: ('execute:' + context.phase) as CreateIssueActionBinding['stage'],
  };
}

function conversationUrlFromTurn(value: JsonRecord): string {
  const id = text(value.conversation_id);
  return id ? 'https://chatgpt.com/c/' + encodeURIComponent(id) : '';
}

function nestedPageUrl(value: JsonRecord): string {
  const snapshot = record(value.snapshot);
  return snapshot ? text(snapshot.page_url) : '';
}

function observeAction(
  context: ExecuteIssueManagerBoundaryContext,
  producerRecord: JsonRecord,
): CreateIssueNextAction | null {
  const cdp = text(context.cdp);
  if (!cdp) return null;
  const targetId = text(context.targetId) || text(producerRecord.target_id);
  const conversationUrl = text(context.conversationUrl)
    || nestedPageUrl(producerRecord)
    || conversationUrlFromTurn(producerRecord);
  if (!targetId && !conversationUrl) return null;

  const argv = [
    'node',
    '--experimental-strip-types',
    'scripts/browser-gpt-page-probe.ts',
    'inspect',
    '--cdp',
    cdp,
    ...(targetId ? ['--target-id', targetId] : ['--url', conversationUrl]),
  ];
  return createIssueNextAction({
    kind: 'execute-observe-owned-turn',
    binding: actionBinding(context),
    argv,
  });
}

function githubFirstAction(context: ExecuteIssueManagerBoundaryContext): CreateIssueNextAction {
  return createIssueNextAction({
    kind: 'execute-github-first-read-only',
    binding: actionBinding(context),
    argv: [
      'scripts/gh',
      'issue',
      'view',
      String(context.issueNumber),
      '--repo',
      context.repository,
      '--json',
      'state,url',
    ],
  });
}

function runnerReadOnlyAction(
  context: ExecuteIssueManagerBoundaryContext,
  producerRecord: JsonRecord,
): CreateIssueNextAction | null {
  const raw = context.prNumber ?? Number(producerRecord.prNumber);
  if (!Number.isSafeInteger(raw) || Number(raw) < 1) return null;
  return createIssueNextAction({
    kind: 'execute-review-runner-read-only',
    binding: actionBinding(context),
    argv: [
      'scripts/gh',
      'pr',
      'view',
      String(raw),
      '--repo',
      context.repository,
      '--json',
      'number,state,headRefOid,url',
    ],
  });
}

function normalizeCommandToken(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}

export function isExecuteIssueReadOnlyArgv(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  if (argv.some((part) => part === '--new-chat' || /fresh[-_ ]conversation|replacement[-_ ]send/u.test(part))) {
    return false;
  }
  const normalized = argv.map(normalizeCommandToken);
  const probeIndex = normalized.findIndex((part) => part === 'scripts/browser-gpt-page-probe.ts');
  if (probeIndex >= 0) {
    return normalized[probeIndex + 1] === 'inspect'
      && !normalized.includes('--open-if-missing');
  }
  const ghIndex = normalized.findIndex((part) => part === 'scripts/gh');
  if (ghIndex >= 0) {
    return (normalized[ghIndex + 1] === 'issue' || normalized[ghIndex + 1] === 'pr')
      && normalized[ghIndex + 2] === 'view';
  }
  return false;
}

function boundary(
  context: ExecuteIssueManagerBoundaryContext,
  producer: string,
  produce: () => unknown,
): CreateIssueManagerBoundaryEvaluation {
  return evaluateCreateIssueManagerBoundary({
    producer,
    currentArgv: context.currentArgv ?? [],
    produce,
  });
}

function completed(
  context: ExecuteIssueManagerBoundaryContext,
  producer: string,
  cause: string,
): CreateIssueManagerBoundaryEvaluation {
  return boundary(context, producer, () => createIssueTerminalResult({ ok: true, cause }));
}

function recoverable(
  context: ExecuteIssueManagerBoundaryContext,
  producer: string,
  cause: string,
  nextAction: CreateIssueNextAction,
  blocker?: string,
): CreateIssueManagerBoundaryEvaluation {
  return boundary(context, producer, () => createIssueRecoverableResult({
    cause,
    ...(blocker ? { blocker } : {}),
    nextAction,
  }));
}

function pause(
  context: ExecuteIssueManagerBoundaryContext,
  producer: string,
  cause: CreateIssueExternalPauseCause,
  producerRecord: unknown,
  remedy: string,
): CreateIssueManagerBoundaryEvaluation {
  return boundary(context, producer, () => createIssueExternalPauseResult({
    cause,
    remedy,
    resumeWhen: { operator: true },
    evidence: evidence(producerRecord),
  }));
}

function defect(
  context: ExecuteIssueManagerBoundaryContext,
  producer: string,
  detail: string,
): CreateIssueManagerBoundaryEvaluation {
  return boundary(context, producer, () => {
    throw new Error('execute-Issue producer contract defect: ' + detail);
  });
}

function recoverObservation(
  context: ExecuteIssueManagerBoundaryContext,
  producer: string,
  producerRecord: JsonRecord,
  cause: string,
): CreateIssueManagerBoundaryEvaluation {
  const nextAction = observeAction(context, producerRecord);
  return nextAction
    ? recoverable(context, producer, cause, nextAction)
    : defect(context, producer, 'read-only observation requires retained CDP plus target or conversation identity');
}

function externalCauseFromText(value: string): CreateIssueExternalPauseCause | null {
  const lower = value.toLowerCase();
  if (/chrome|cdp|browser unavailable|browser_not_running/u.test(lower)) return 'external:chrome_not_running';
  if (/login|sign[- ]?in|challenge|authentication/u.test(lower)) return 'external:login_required';
  if (/quota|429|rate.?limit/u.test(lower)) return 'external:quota_exhausted';
  if (/permission|forbidden|\b403\b/u.test(lower)) return 'external:permission_denied';
  if (/github|\b50[234]\b|http\s*5\d\d/u.test(lower)) return 'external:github_unavailable';
  return null;
}

function readOnlyCorrectionCause(value: string): boolean {
  return /(inspect|observation|target|conversation|cdp).*(argument|option|identity)|(?:argument|option).*(inspect|observation|target|conversation|cdp)/iu.test(value);
}

function classifyTurn(
  value: JsonRecord,
  context: ExecuteIssueManagerBoundaryContext,
): CreateIssueManagerBoundaryEvaluation {
  const producer = 'chatgpt-browser-turn-record/v1';
  const state = value.state;
  if (!TURN_STATES.includes(state as TurnState)) {
    return defect(context, producer, 'unknown turn state ' + String(state));
  }
  const turn = value as unknown as TurnResultV1;
  switch (turn.state) {
    case 'ok':
      return completed(context, producer, 'execute_turn_completed');
    case 'quota':
      return pause(context, producer, 'external:quota_exhausted', value, 'restore ChatGPT quota, then resume the same execute-Issue Dispatch');
    case 'challenge':
    case 'login':
      return pause(context, producer, 'external:login_required', value, 'restore the authenticated ChatGPT surface, then resume the same execute-Issue Dispatch');
    case 'chrome_not_running':
      return pause(context, producer, 'external:chrome_not_running', value, 'restore the retained Chrome/CDP surface, then resume the same execute-Issue Dispatch');
    case 'foreign_activity':
    case 'output_conflict':
      return pause(context, producer, 'external:content_authority_conflict', value, 'resolve the content-authority conflict, then resume the same execute-Issue Dispatch');
    case 'stream_timeout':
    case 'no_reply':
    case 'observation_uncertain':
    case 'conversation_busy':
    case 'profile_busy':
    case 'send_failed':
    case 'rate_limit':
    case 'orphaned_fresh_turn':
      return recoverObservation(context, producer, value, 'execute_owned_turn_reobserve');
    case 'profile_mismatch':
    case 'incompatible_record': {
      const action = observeAction(context, value);
      if (action) return recoverable(context, producer, 'execute_owned_turn_identity_reobserve', action);
      return pause(
        context,
        producer,
        text(context.cdp) ? 'external:content_authority_conflict' : 'external:chrome_not_running',
        value,
        'restore the retained profile/CDP/conversation identity without guessing, then resume the same execute-Issue Dispatch',
      );
    }
    case 'recovery_required':
      if (
        turn.scope === 'conversation'
        && (turn.cause === 'message_delivery_timed_out' || turn.cause === 'product_network_error')
      ) {
        return recoverable(
          context,
          producer,
          'execute_github_first_reconciliation',
          githubFirstAction(context),
        );
      }
      if (turn.scope === 'blocking_domain') {
        const external = externalCauseFromText(turn.cause);
        if (external === 'external:login_required' || external === 'external:quota_exhausted') {
          return pause(context, producer, external, value, 'clear the observed blocking-domain wall, then resume the same execute-Issue Dispatch');
        }
      }
      return defect(context, producer, 'unsupported recovery_required scope/cause combination');
    case 'input_invalid':
      if (readOnlyCorrectionCause(turn.cause)) {
        const action = observeAction(context, value);
        if (action) return recoverable(context, producer, 'execute_read_only_argument_correction', action);
      }
      return defect(context, producer, 'input_invalid does not identify a safe read-only observation correction');
    case 'ui_contract_mismatch':
    case 'driver_error':
      if (readOnlyCorrectionCause(turn.cause)) {
        const action = observeAction(context, value);
        if (action) return recoverable(context, producer, 'execute_read_only_driver_observation_correction', action);
      }
      return defect(context, producer, turn.state + ' requires producer repair rather than send authority');
  }
}

function executionRecoveryInspect(value: JsonRecord): ExecutionRecoveryInspectEvidence | null {
  const embedded = record(value.execution_recovery_inspect);
  if (embedded) {
    const generation = embedded.generation_in_progress;
    if (generation === true || generation === false || generation === 'unknown') {
      return embedded as unknown as ExecutionRecoveryInspectEvidence;
    }
  }
  return projectExecutionRecoveryInspect(value);
}

function classifyProbe(
  value: JsonRecord,
  context: ExecuteIssueManagerBoundaryContext,
): CreateIssueManagerBoundaryEvaluation {
  const producer = 'browser-gpt-page-probe/v1';
  const status = value.status as ProbeStatus;
  if (!Object.prototype.hasOwnProperty.call(EXECUTE_ISSUE_PROBE_CLASSIFICATION, status)) {
    return defect(context, producer, 'unknown probe status ' + String(value.status));
  }
  const reason = text(value.reason);
  switch (status) {
    case 'ok': {
      const inspect = executionRecoveryInspect(value);
      if (inspect?.reason === 'ambiguous_marker') {
        return pause(
          context,
          producer,
          'external:content_authority_conflict',
          value,
          'resolve the ambiguous owned-marker authority before any replacement send',
        );
      }
      if (
        (inspect?.cause === 'message_delivery_timed_out' || inspect?.cause === 'product_network_error')
        && inspect.generation_in_progress === false
      ) {
        return recoverable(context, producer, 'execute_github_first_reconciliation', githubFirstAction(context));
      }
      if (inspect && inspect.generation_in_progress !== false) {
        return recoverObservation(context, producer, value, 'execute_owned_turn_reobserve');
      }
      return completed(context, producer, 'execute_probe_observation_completed');
    }
    case 'not_found':
    case 'stale_node':
    case 'surface_unknown':
    case 'export_failed':
    case 'cleanup_failed':
      return recoverObservation(context, producer, value, 'execute_probe_reobserve');
    case 'ambiguous':
      return pause(
        context,
        producer,
        'external:content_authority_conflict',
        value,
        'resolve the ambiguous probe ownership before any replacement send',
      );
    case 'unsafe_output':
      return defect(context, producer, 'unsafe_output probe envelope cannot authorize manager continuation');
    case 'unavailable': {
      const external = externalCauseFromText(reason);
      if (external === 'external:chrome_not_running' || external === 'external:login_required') {
        return pause(context, producer, external, value, 'restore the unavailable external observation surface, then resume the same execute-Issue Dispatch');
      }
      return recoverObservation(context, producer, value, 'execute_probe_reobserve');
    }
    case 'input_invalid':
      if (readOnlyCorrectionCause(reason)) {
        const action = observeAction(context, value);
        if (action) return recoverable(context, producer, 'execute_read_only_probe_argument_correction', action);
      }
      return defect(context, producer, 'input_invalid probe envelope lacks a safe read-only correction');
  }
}

function structuredNextAction(value: unknown): CreateIssueNextAction | null {
  if (validateCreateIssueNextAction(value).length > 0) return null;
  const action = value as CreateIssueNextAction;
  return CREATE_ISSUE_NEXT_ACTION_KINDS.includes(action.kind) ? action : null;
}

function classifyReviewRunner(
  value: JsonRecord,
  context: ExecuteIssueManagerBoundaryContext,
): CreateIssueManagerBoundaryEvaluation {
  const producer = 'pack-gpt-review';
  if (value.ok === true) return completed(context, producer, 'execute_review_runner_completed');

  const outcome = text(value.outcome);
  const reason = text(value.reason) || text(value.runnerReason);
  if (outcome === 'review_target_unavailable') {
    const cause = externalCauseFromText(reason) ?? 'external:github_unavailable';
    return pause(context, producer, cause, value, 'restore the review target/external dependency, then resume the same execute-Issue Dispatch');
  }

  const candidate = structuredNextAction(value.nextAction);
  if (candidate && isExecuteIssueReadOnlyArgv(candidate.argv)) {
    return recoverable(context, producer, 'execute_review_runner_read_only', candidate);
  }

  if (value.nextAction !== undefined && value.nextAction !== null) {
    const nextAction = runnerReadOnlyAction(context, value);
    return nextAction
      ? recoverable(context, producer, 'execute_review_runner_reconcile', nextAction)
      : defect(context, producer, 'runner nextAction is not read-only and no exact PR target is available for reconciliation');
  }

  const external = externalCauseFromText(reason);
  if (external) {
    return pause(context, producer, external, value, 'restore the observed external review dependency, then resume the same execute-Issue Dispatch');
  }
  return defect(context, producer, 'non-success review runner result has no legal read-only action or external evidence');
}

export function classifyExecuteIssueManagerRecord(
  input: unknown,
  context: ExecuteIssueManagerBoundaryContext,
): CreateIssueManagerBoundaryEvaluation {
  const value = record(input);
  if (!value) return defect(context, 'execute-issue-manager-boundary', 'input record must be a JSON object');
  if (value.schema === 'turn-result/v1') return classifyTurn(value, context);
  if (value.schema === 'browser-gpt-page-probe/v1') return classifyProbe(value, context);
  return classifyReviewRunner(value, context);
}
