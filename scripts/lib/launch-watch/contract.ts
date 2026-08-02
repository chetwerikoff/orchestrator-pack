import { isAbsolute } from 'node:path';

export const LAUNCH_DEFAULT_DEADLINE_MS = 120_000;
export const WATCH_DEFAULT_DEADLINE_MS = 30_000;
export const MIN_DEADLINE_MS = 10_000;
export const MAX_DEADLINE_MS = 900_000;
export const CLEANUP_RESERVE_MS = 5_000;
export const EMISSION_RESERVE_MS = 1_000;
export const MAX_WORKTREE_PATH_BYTES = 4_096;
export const MAX_MODEL_BYTES = 128;
export const MAX_EFFORT_BYTES = 32;
export const MAX_INSTRUCTION_BYTES = 32_768;
export const MAX_WATCH_ID_BYTES = 64;
export const MAX_REPO_BYTES = 256;
export const MAX_HANDLE_BYTES = 256;

export type LaunchValidationCode =
  | 'launch_unknown_field' | 'launch_missing_request_version' | 'launch_unsupported_version'
  | 'launch_missing_cwd' | 'launch_invalid_cwd' | 'launch_cwd_too_large'
  | 'launch_missing_workspace_id' | 'launch_invalid_workspace_id' | 'launch_workspace_mismatch'
  | 'launch_workspace_path_mismatch' | 'launch_missing_target_ref' | 'launch_unsupported_target_ref'
  | 'launch_missing_remote_ref' | 'launch_unsupported_remote_ref' | 'launch_missing_model'
  | 'launch_model_empty' | 'launch_model_too_large' | 'launch_missing_effort' | 'launch_effort_empty'
  | 'launch_effort_too_large' | 'launch_missing_initial_instruction' | 'launch_instruction_too_large'
  | 'launch_invalid_utf8' | 'launch_nul_byte' | 'launch_malformed_json'
  | 'launch_unsafe_command_encoding' | 'launch_wrong_field_type' | 'launch_invalid_deadline'
  | 'launch_deadline_out_of_range';

export type WatchValidationCode =
  | 'watch_unknown_field' | 'watch_missing_request_version' | 'watch_unsupported_version'
  | 'watch_missing_source' | 'watch_unsupported_source' | 'watch_missing_predicate'
  | 'watch_unsupported_predicate' | 'watch_missing_repo' | 'watch_invalid_repo'
  | 'watch_missing_pr' | 'watch_invalid_pr' | 'watch_missing_terminal_handle'
  | 'watch_invalid_terminal_handle' | 'watch_wrong_field_type' | 'watch_invalid_utf8'
  | 'watch_nul_byte' | 'watch_malformed_json' | 'watch_value_too_large'
  | 'watch_invalid_deadline' | 'watch_deadline_out_of_range' | 'watch_field_not_applicable';

export type LaunchRequest = {
  readonly requestVersion: 'launch-request/v1';
  readonly cwd: string;
  readonly targetRef: 'main';
  readonly remoteRef: 'origin/main';
  readonly model: string;
  readonly effort: string;
  readonly initialInstruction: string;
  readonly deadlineMs: number;
};

export type WatchSourceId = 'github.pull-request' | 'orca.terminal';
export type WatchPredicateId = 'pr.merged' | 'terminal.read';
export type WatchRequest = {
  readonly requestVersion: 'watch-request/v1';
  readonly sourceId: WatchSourceId;
  readonly predicateId: WatchPredicateId;
  readonly repo?: string;
  readonly prNumber?: number;
  readonly terminalHandle?: string;
  readonly deadlineMs: number;
};

export type Phase =
  | 'preflight' | 'refresh' | 'target-verification' | 'target-transition'
  | 'binding-verification' | 'trust' | 'process-creation' | 'terminal-create'
  | 'cleanup' | 'emission' | null;

export type RemediationAction =
  | 'none' | 'reject-request' | 'repair-target' | 'inspect-source' | 'verify-trust'
  | 'retry-safe' | 'wait-and-retry' | 'close-and-investigate' | 'record-and-stop';

export type PrimaryOutcome =
  | 'launched' | 'invalid-request' | 'source-unavailable' | 'target-refused'
  | 'trusted-start-failed' | 'process-launch-failed' | 'terminal-create-ambiguous'
  | 'deadline-exceeded' | 'emission-failed' | 'matched' | 'predicate-failed';

export type CleanupErrorCode =
  | 'cleanup_timeout' | 'cleanup_termination_failed' | 'cleanup_reap_failed' | 'cleanup_sink_close_failed';

export type CleanupOverride = {
  readonly outcome: 'partial-cleanup' | 'cleanup-failed';
  readonly primaryOutcome: PrimaryOutcome;
  readonly primaryPhase: Phase;
  readonly primaryOperation: 'github-pr-read' | 'orca-terminal-read' | null;
  readonly primaryReasonCode: string | null;
  readonly cleanupOutcome: 'completed' | 'failed';
  readonly cleanupErrorCode: CleanupErrorCode | null;
  readonly affectedResourceIds: {
    readonly terminalHandle: string | null;
    readonly helperProcessGroupId: string | null;
    readonly redirectedSinkId: string | null;
  };
};

export type LaunchResult = {
  readonly schema: 'launch-result/v1';
  readonly outcome: PrimaryOutcome | 'partial-cleanup' | 'cleanup-failed';
  readonly phase: Phase;
  readonly operation: null;
  readonly sourceId: string | null;
  readonly predicateId: null;
  readonly reasonCode: string;
  readonly retryAllowed: boolean;
  readonly sourceIds: readonly string[];
  readonly observedAt: string;
  readonly deadlineMs: number;
  readonly remediation: { readonly action: RemediationAction; readonly owner: 'wrapper' | 'operator'; readonly detail: string };
  readonly operatorDisposition: string;
  readonly evidence: Record<string, unknown>;
  readonly terminal: Record<string, unknown> | null;
  readonly containment: Record<string, unknown> | null;
  readonly cleanup: CleanupOverride | null;
  readonly primaryOutcome: PrimaryOutcome | null;
  readonly primaryPhase: Phase;
  readonly primaryOperation: null;
  readonly primaryReasonCode: string | null;
};

export type WatchResult = {
  readonly schema: 'watch-result/v1';
  readonly outcome: PrimaryOutcome | 'partial-cleanup' | 'cleanup-failed';
  readonly phase: null;
  readonly operation: 'github-pr-read' | 'orca-terminal-read' | null;
  readonly sourceId: WatchSourceId | null;
  readonly predicateId: WatchPredicateId | null;
  readonly reasonCode: string;
  readonly retryAllowed: false;
  readonly sourceIds: readonly string[];
  readonly observedAt: string;
  readonly deadlineMs: number;
  readonly remediation: { readonly action: RemediationAction; readonly owner: 'wrapper' | 'operator'; readonly detail: string };
  readonly operatorDisposition: string;
  readonly evidence: Record<string, unknown>;
  readonly terminal: null;
  readonly containment: null;
  readonly cleanup: CleanupOverride | null;
  readonly primaryOutcome: PrimaryOutcome | null;
  readonly primaryPhase: null;
  readonly primaryOperation: 'github-pr-read' | 'orca-terminal-read' | null;
  readonly primaryReasonCode: string | null;
};

export type AnyResult = LaunchResult | WatchResult;

type JsonRecord = Record<string, unknown>;

const launchFields = new Set([
  'requestVersion', 'cwd', 'targetRef', 'remoteRef', 'model', 'effort', 'initialInstruction', 'deadlineMs',
]);
const watchFields = new Set([
  'requestVersion', 'sourceId', 'predicateId', 'repo', 'prNumber', 'terminalHandle', 'deadlineMs',
]);

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function hasNul(value: string): boolean {
  return value.includes('\u0000');
}

function typedObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function wrongType(record: JsonRecord, fields: readonly string[]): boolean {
  for (const field of fields) {
    if (!(field in record)) continue;
    const value = record[field];
    if (field === 'deadlineMs') {
      if (typeof value !== 'number') return true;
      continue;
    }
    if (field === 'prNumber') {
      if (typeof value !== 'number') return true;
      continue;
    }
    if (typeof value !== 'string') return true;
  }
  return false;
}

function deadline(record: JsonRecord, fallback: number, prefix: 'launch' | 'watch'):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly code: LaunchValidationCode | WatchValidationCode } {
  if (!('deadlineMs' in record)) return { ok: true, value: fallback };
  const value = record.deadlineMs;
  if (typeof value !== 'number') return { ok: false, code: `${prefix}_wrong_field_type` as LaunchValidationCode & WatchValidationCode };
  if (!Number.isInteger(value)) return { ok: false, code: `${prefix}_invalid_deadline` as LaunchValidationCode & WatchValidationCode };
  if (value < MIN_DEADLINE_MS || value > MAX_DEADLINE_MS) {
    return { ok: false, code: `${prefix}_deadline_out_of_range` as LaunchValidationCode & WatchValidationCode };
  }
  return { ok: true, value };
}

function parseUtf8(raw: Uint8Array, prefix: 'launch' | 'watch'): { ok: true; text: string } | { ok: false; code: LaunchValidationCode | WatchValidationCode } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return { ok: false, code: `${prefix}_invalid_utf8` as LaunchValidationCode & WatchValidationCode };
  }
  for (const byte of raw) if (byte === 0) return { ok: false, code: `${prefix}_nul_byte` as LaunchValidationCode & WatchValidationCode };
  if (hasNul(text)) return { ok: false, code: `${prefix}_nul_byte` as LaunchValidationCode & WatchValidationCode };
  return { ok: true, text };
}

export function parseLaunchRequest(raw: Uint8Array): { ok: true; request: LaunchRequest } | { ok: false; code: LaunchValidationCode; deadlineMs: number } {
  const parsed = parseUtf8(raw, 'launch');
  if (!parsed.ok) return { ok: false, code: parsed.code as LaunchValidationCode, deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  let value: unknown;
  try { value = JSON.parse(parsed.text); } catch { return { ok: false, code: 'launch_malformed_json', deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS }; }
  if (!typedObject(value)) return { ok: false, code: 'launch_wrong_field_type', deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  if (wrongType(value, ['requestVersion', 'cwd', 'targetRef', 'remoteRef', 'model', 'effort', 'initialInstruction', 'deadlineMs'])) {
    return { ok: false, code: 'launch_wrong_field_type', deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  }
  const unknown = [...Object.keys(value)].find((key) => !launchFields.has(key));
  if (unknown) return { ok: false, code: 'launch_unknown_field', deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  if (!('requestVersion' in value)) return { ok: false, code: 'launch_missing_request_version', deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  if (value.requestVersion !== 'launch-request/v1') return { ok: false, code: 'launch_unsupported_version', deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  const requiredStrings: Array<[string, LaunchValidationCode]> = [
    ['cwd', 'launch_missing_cwd'], ['targetRef', 'launch_missing_target_ref'], ['remoteRef', 'launch_missing_remote_ref'],
    ['model', 'launch_missing_model'], ['effort', 'launch_missing_effort'], ['initialInstruction', 'launch_missing_initial_instruction'],
  ];
  for (const [field, code] of requiredStrings) if (!(field in value)) return { ok: false, code, deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  const cwd = value.cwd as string;
  if ([cwd, value.model as string, value.effort as string, value.initialInstruction as string].some(hasNul)) return { ok: false, code: 'launch_nul_byte', deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  if (byteLength(cwd) > MAX_WORKTREE_PATH_BYTES) return { ok: false, code: 'launch_cwd_too_large', deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  if (!isAbsolute(cwd)) return { ok: false, code: 'launch_invalid_cwd', deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  if (value.targetRef !== 'main') return { ok: false, code: 'launch_unsupported_target_ref', deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  if (value.remoteRef !== 'origin/main') return { ok: false, code: 'launch_unsupported_remote_ref', deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  const model = value.model as string;
  const effort = value.effort as string;
  const instruction = value.initialInstruction as string;
  if (model.length === 0) return { ok: false, code: 'launch_model_empty', deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  if (effort.length === 0) return { ok: false, code: 'launch_effort_empty', deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  if (byteLength(model) > MAX_MODEL_BYTES) return { ok: false, code: 'launch_model_too_large', deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  if (byteLength(effort) > MAX_EFFORT_BYTES) return { ok: false, code: 'launch_effort_too_large', deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  if (byteLength(instruction) > MAX_INSTRUCTION_BYTES) return { ok: false, code: 'launch_instruction_too_large', deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  const d = deadline(value, LAUNCH_DEFAULT_DEADLINE_MS, 'launch');
  if (!d.ok) return { ok: false, code: d.code as LaunchValidationCode, deadlineMs: LAUNCH_DEFAULT_DEADLINE_MS };
  return { ok: true, request: { requestVersion: 'launch-request/v1', cwd, targetRef: 'main', remoteRef: 'origin/main', model, effort, initialInstruction: instruction, deadlineMs: d.value } };
}

export function parseWatchRequest(raw: Uint8Array): { ok: true; request: WatchRequest } | { ok: false; code: WatchValidationCode; deadlineMs: number } {
  const parsed = parseUtf8(raw, 'watch');
  if (!parsed.ok) return { ok: false, code: parsed.code as WatchValidationCode, deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  let value: unknown;
  try { value = JSON.parse(parsed.text); } catch { return { ok: false, code: 'watch_malformed_json', deadlineMs: WATCH_DEFAULT_DEADLINE_MS }; }
  if (!typedObject(value)) return { ok: false, code: 'watch_wrong_field_type', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  if (wrongType(value, ['requestVersion', 'sourceId', 'predicateId', 'repo', 'prNumber', 'terminalHandle', 'deadlineMs'])) {
    return { ok: false, code: 'watch_wrong_field_type', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  }
  const unknown = [...Object.keys(value)].find((key) => !watchFields.has(key));
  if (unknown) return { ok: false, code: 'watch_unknown_field', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  if (!('requestVersion' in value)) return { ok: false, code: 'watch_missing_request_version', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  if (value.requestVersion !== 'watch-request/v1') return { ok: false, code: 'watch_unsupported_version', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  if (!('sourceId' in value)) return { ok: false, code: 'watch_missing_source', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  if (value.sourceId !== 'github.pull-request' && value.sourceId !== 'orca.terminal') return { ok: false, code: 'watch_unsupported_source', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  if (!('predicateId' in value)) return { ok: false, code: 'watch_missing_predicate', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  const supportedPair = (value.sourceId === 'github.pull-request' && value.predicateId === 'pr.merged')
    || (value.sourceId === 'orca.terminal' && value.predicateId === 'terminal.read');
  if (!supportedPair) return { ok: false, code: 'watch_unsupported_predicate', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  if (value.sourceId === 'github.pull-request') {
    if (byteLength(value.sourceId as string) > MAX_WATCH_ID_BYTES || byteLength(value.predicateId as string) > MAX_WATCH_ID_BYTES)
      return { ok: false, code: 'watch_value_too_large', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
    if (!('repo' in value)) return { ok: false, code: 'watch_missing_repo', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
    if (!('prNumber' in value)) return { ok: false, code: 'watch_missing_pr', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
    if ('terminalHandle' in value) return { ok: false, code: 'watch_field_not_applicable', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
    const repo = value.repo as string;
    if ([repo, String(value.prNumber)].some(hasNul)) return { ok: false, code: 'watch_nul_byte', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
    if (byteLength(repo) > MAX_REPO_BYTES) return { ok: false, code: 'watch_value_too_large', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
    if (!/^[^/\s]+\/[^/\s]+$/u.test(repo)) return { ok: false, code: 'watch_invalid_repo', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
    const pr = value.prNumber as number;
    if (!Number.isInteger(pr) || pr <= 0 || pr > 2_147_483_647) return { ok: false, code: 'watch_invalid_pr', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
    const d = deadline(value, WATCH_DEFAULT_DEADLINE_MS, 'watch');
    if (!d.ok) return { ok: false, code: d.code as WatchValidationCode, deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
    return { ok: true, request: { requestVersion: 'watch-request/v1', sourceId: 'github.pull-request', predicateId: 'pr.merged', repo, prNumber: pr, deadlineMs: d.value } };
  }
  if (byteLength(value.sourceId as string) > MAX_WATCH_ID_BYTES || byteLength(value.predicateId as string) > MAX_WATCH_ID_BYTES) return { ok: false, code: 'watch_value_too_large', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  if (!('terminalHandle' in value)) return { ok: false, code: 'watch_missing_terminal_handle', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  if ('repo' in value || 'prNumber' in value) return { ok: false, code: 'watch_field_not_applicable', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  const terminalHandle = value.terminalHandle as string;
  if (hasNul(terminalHandle)) return { ok: false, code: 'watch_nul_byte', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  if (byteLength(terminalHandle) > MAX_HANDLE_BYTES) return { ok: false, code: 'watch_value_too_large', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  if (terminalHandle.length === 0) return { ok: false, code: 'watch_invalid_terminal_handle', deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  const d = deadline(value, WATCH_DEFAULT_DEADLINE_MS, 'watch');
  if (!d.ok) return { ok: false, code: d.code as WatchValidationCode, deadlineMs: WATCH_DEFAULT_DEADLINE_MS };
  return { ok: true, request: { requestVersion: 'watch-request/v1', sourceId: 'orca.terminal', predicateId: 'terminal.read', terminalHandle, deadlineMs: d.value } };
}

export function decodeCommandPart(value: string): string {
  if (hasNul(value)) throw new Error('NUL cannot be command input');
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function encodeLaunchCommand(request: Pick<LaunchRequest, 'model' | 'effort' | 'initialInstruction'>): string {
  try {
    return `cursor-agent --model ${decodeCommandPart(request.model)} --effort ${decodeCommandPart(request.effort)} --instruction ${decodeCommandPart(request.initialInstruction)}`;
  } catch {
    throw new Error('launch_unsafe_command_encoding');
  }
}

export function workBudgetMs(deadlineMs: number): number {
  return deadlineMs - CLEANUP_RESERVE_MS - EMISSION_RESERVE_MS;
}

export function launchResult(
  outcome: PrimaryOutcome,
  fields: {
    readonly phase: Phase;
    readonly reasonCode: string;
    readonly deadlineMs: number;
    readonly sourceIds: readonly string[];
    readonly sourceId?: string | null;
    readonly evidence?: Record<string, unknown>;
    readonly remediation: RemediationAction;
    readonly owner?: 'wrapper' | 'operator';
    readonly detail?: string;
    readonly operatorDisposition?: string;
    readonly terminal?: Record<string, unknown> | null;
    readonly containment?: Record<string, unknown> | null;
  },
): LaunchResult {
  return {
    schema: 'launch-result/v1', outcome, phase: fields.phase, operation: null, sourceId: fields.sourceId ?? null,
    predicateId: null, reasonCode: fields.reasonCode, retryAllowed: outcome === 'process-launch-failed',
    sourceIds: fields.sourceIds, observedAt: new Date().toISOString(), deadlineMs: fields.deadlineMs,
    remediation: { action: fields.remediation, owner: fields.owner ?? 'operator', detail: fields.detail ?? '' },
    operatorDisposition: fields.operatorDisposition ?? (outcome === 'launched' ? 'none' : 'investigate'),
    evidence: fields.evidence ?? {}, terminal: fields.terminal ?? null, containment: fields.containment ?? null,
    cleanup: null, primaryOutcome: null, primaryPhase: null, primaryOperation: null, primaryReasonCode: null,
  };
}

export function watchResult(
  outcome: PrimaryOutcome,
  fields: {
    readonly operation: 'github-pr-read' | 'orca-terminal-read';
    readonly sourceId: WatchSourceId;
    readonly predicateId: WatchPredicateId;
    readonly reasonCode: string;
    readonly deadlineMs: number;
    readonly evidence?: Record<string, unknown>;
    readonly remediation: RemediationAction;
    readonly owner?: 'wrapper' | 'operator';
    readonly detail?: string;
    readonly operatorDisposition?: string;
  },
): WatchResult {
  return {
    schema: 'watch-result/v1', outcome, phase: null, operation: fields.operation, sourceId: fields.sourceId,
    predicateId: fields.predicateId, reasonCode: fields.reasonCode, retryAllowed: false,
    sourceIds: [fields.sourceId], observedAt: new Date().toISOString(), deadlineMs: fields.deadlineMs,
    remediation: { action: fields.remediation, owner: fields.owner ?? 'operator', detail: fields.detail ?? '' },
    operatorDisposition: fields.operatorDisposition ?? (outcome === 'matched' || outcome === 'predicate-failed' ? 'none' : 'investigate'),
    evidence: fields.evidence ?? {}, terminal: null, containment: null, cleanup: null,
    primaryOutcome: null, primaryPhase: null, primaryOperation: null, primaryReasonCode: null,
  };
}

export function invalidLaunchResult(code: LaunchValidationCode, deadlineMs: number): LaunchResult {
  return launchResult('invalid-request', {
    phase: null, reasonCode: code, deadlineMs, sourceIds: ['pack.launch.request'],
    sourceId: 'pack.launch.request', remediation: 'reject-request', owner: 'operator', operatorDisposition: 'reject-request',
  });
}

export function invalidWatchResult(code: WatchValidationCode, deadlineMs: number): WatchResult {
  return {
    schema: 'watch-result/v1', outcome: 'invalid-request', phase: null, operation: null, sourceId: null, predicateId: null,
    reasonCode: code, retryAllowed: false, sourceIds: ['pack.watch.request'], observedAt: new Date().toISOString(),
    deadlineMs, remediation: { action: 'reject-request', owner: 'operator', detail: '' }, operatorDisposition: 'reject-request',
    evidence: {}, terminal: null, containment: null, cleanup: null, primaryOutcome: null, primaryPhase: null,
    primaryOperation: null, primaryReasonCode: null,
  };
}

export function cleanupOverride(
  primary: LaunchResult | WatchResult,
  status: 'completed' | 'failed',
  resources: CleanupOverride['affectedResourceIds'],
  errorCode: CleanupErrorCode | null = null,
): AnyResult {
  if (primary.outcome === 'launched' || primary.outcome === 'matched' || primary.outcome === 'predicate-failed' || primary.cleanup) {
    throw new Error('cleanup override is not valid for this result');
  }
  const override: CleanupOverride = {
    outcome: status === 'completed' ? 'partial-cleanup' : 'cleanup-failed',
    primaryOutcome: primary.outcome as PrimaryOutcome,
    primaryPhase: primary.phase,
    primaryOperation: primary.operation,
    primaryReasonCode: primary.reasonCode,
    cleanupOutcome: status,
    cleanupErrorCode: status === 'completed' ? null : errorCode,
    affectedResourceIds: resources,
  };
  return {
    ...primary,
    outcome: override.outcome,
    cleanup: override,
    primaryOutcome: primary.outcome as PrimaryOutcome,
    primaryPhase: primary.phase,
    primaryOperation: primary.operation,
    primaryReasonCode: primary.reasonCode,
  } as AnyResult;
}

export function selectCleanupError(failures: readonly CleanupErrorCode[]): CleanupErrorCode | null {
  const order: readonly CleanupErrorCode[] = ['cleanup_timeout', 'cleanup_termination_failed', 'cleanup_reap_failed', 'cleanup_sink_close_failed'];
  return order.find((candidate) => failures.includes(candidate)) ?? null;
}


const resultFields = new Set([
  'schema', 'outcome', 'phase', 'operation', 'sourceId', 'predicateId', 'reasonCode',
  'retryAllowed', 'sourceIds', 'observedAt', 'deadlineMs', 'remediation', 'operatorDisposition',
  'evidence', 'terminal', 'containment', 'cleanup', 'primaryOutcome', 'primaryPhase',
  'primaryOperation', 'primaryReasonCode',
]);
const cleanupFields = new Set([
  'outcome', 'primaryOutcome', 'primaryPhase', 'primaryOperation', 'primaryReasonCode',
  'cleanupOutcome', 'cleanupErrorCode', 'affectedResourceIds',
]);
const resourceFields = new Set(['terminalHandle', 'helperProcessGroupId', 'redirectedSinkId']);
const launchOutcomes = new Set(['launched', 'invalid-request', 'source-unavailable', 'target-refused', 'trusted-start-failed', 'process-launch-failed', 'terminal-create-ambiguous', 'deadline-exceeded', 'emission-failed', 'partial-cleanup', 'cleanup-failed']);
const watchOutcomes = new Set(['matched', 'predicate-failed', 'invalid-request', 'source-unavailable', 'deadline-exceeded', 'emission-failed', 'partial-cleanup', 'cleanup-failed']);

function exactKeys(value: JsonRecord, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key)) && [...allowed].every((key) => key in value);
}

function validResourceIds(value: unknown): boolean {
  if (!typedObject(value) || !exactKeys(value, resourceFields)) return false;
  return Object.values(value).every((entry) => entry === null || (typeof entry === 'string' && !hasNul(entry)));
}

function validCleanup(value: unknown): boolean {
  if (!typedObject(value) || !exactKeys(value, cleanupFields)) return false;
  if (value.outcome !== 'partial-cleanup' && value.outcome !== 'cleanup-failed') return false;
  if (value.cleanupOutcome !== 'completed' && value.cleanupOutcome !== 'failed') return false;
  if (value.cleanupOutcome === 'completed' && value.cleanupErrorCode !== null) return false;
  if (value.cleanupOutcome === 'failed' && !['cleanup_timeout', 'cleanup_termination_failed', 'cleanup_reap_failed', 'cleanup_sink_close_failed'].includes(String(value.cleanupErrorCode))) return false;
  return validResourceIds(value.affectedResourceIds);
}

export function validateResult(value: unknown): { readonly ok: true; readonly result: AnyResult } | { readonly ok: false; readonly reason: string } {
  if (!typedObject(value) || !exactKeys(value, resultFields)) return { ok: false, reason: 'result_invalid_response_shape' };
  if (value.schema !== 'launch-result/v1' && value.schema !== 'watch-result/v1') return { ok: false, reason: 'result_unsupported_schema' };
  const isLaunch = value.schema === 'launch-result/v1';
  const outcomes = isLaunch ? launchOutcomes : watchOutcomes;
  if (typeof value.outcome !== 'string' || !outcomes.has(value.outcome)) return { ok: false, reason: 'result_invalid_outcome' };
  if (typeof value.reasonCode !== 'string' || typeof value.retryAllowed !== 'boolean' || typeof value.observedAt !== 'string' || !Number.isInteger(value.deadlineMs)) return { ok: false, reason: 'result_invalid_scalar' };
  if (!Array.isArray(value.sourceIds) || value.sourceIds.some((entry) => typeof entry !== 'string')) return { ok: false, reason: 'result_invalid_source_ids' };
  if (!typedObject(value.remediation) || !['none', 'reject-request', 'repair-target', 'inspect-source', 'verify-trust', 'retry-safe', 'wait-and-retry', 'close-and-investigate', 'record-and-stop'].includes(String(value.remediation.action)) || !['wrapper', 'operator'].includes(String(value.remediation.owner)) || typeof value.remediation.detail !== 'string') return { ok: false, reason: 'result_invalid_remediation' };
  if (typeof value.operatorDisposition !== 'string' || !typedObject(value.evidence)) return { ok: false, reason: 'result_invalid_evidence' };
  if (value.cleanup !== null && !validCleanup(value.cleanup)) return { ok: false, reason: 'result_invalid_cleanup' };
  if (value.cleanup === null && (value.primaryOutcome !== null || value.primaryPhase !== null || value.primaryOperation !== null || value.primaryReasonCode !== null)) return { ok: false, reason: 'result_orphaned_primary_fields' };
  if (value.cleanup !== null && (value.primaryOutcome === null || value.primaryReasonCode === null)) return { ok: false, reason: 'result_missing_primary_fields' };
  if (isLaunch) {
    if (value.phase !== null && !['preflight', 'refresh', 'target-verification', 'target-transition', 'binding-verification', 'trust', 'process-creation', 'terminal-create', 'cleanup', 'emission'].includes(String(value.phase))) return { ok: false, reason: 'result_invalid_launch_phase' };
    if (value.operation !== null || value.predicateId !== null || value.primaryOperation !== null) return { ok: false, reason: 'result_invalid_launch_operation' };
  } else {
    if (value.phase !== null || (value.operation !== null && value.operation !== 'github-pr-read' && value.operation !== 'orca-terminal-read') || (value.predicateId !== null && value.predicateId !== 'pr.merged' && value.predicateId !== 'terminal.read')) return { ok: false, reason: 'result_invalid_watch_operation' };
    if (value.terminal !== null || value.containment !== null) return { ok: false, reason: 'result_invalid_watch_terminal' };
  }
  return { ok: true, result: value as AnyResult };
}
