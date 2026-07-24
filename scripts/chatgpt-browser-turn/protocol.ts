export const TURN_RESULT_SCHEMA = 'turn-result/v1' as const;
export const CONTROL_RESULT_SCHEMA = 'control-result/v1' as const;
export const PUBLICATION_STATUS_SCHEMA = 'publication-status/v1' as const;

export const TURN_STATES = [
  'ok',
  'input_invalid',
  'quota',
  'challenge',
  'login',
  'stream_timeout',
  'send_failed',
  'no_reply',
  'chrome_not_running',
  'driver_error',
  'profile_mismatch',
  'recovery_required',
  'orphaned_fresh_turn',
  'ui_contract_mismatch',
  'foreign_activity',
  'output_conflict',
  'conversation_busy',
  'profile_busy',
  'incompatible_record',
] as const;

export type TurnState = (typeof TURN_STATES)[number];

export const TURN_SCOPES = [
  'none',
  'invocation',
  'conversation',
  'profile',
  'machine',
  'blocking_domain',
] as const;

export type TurnScope = (typeof TURN_SCOPES)[number];

export const TURN_EXIT_CODES = Object.freeze({
  ok: 0,
  input_invalid: 10,
  send_failed: 10,
  ui_contract_mismatch: 10,
  output_conflict: 10,
  stream_timeout: 11,
  no_reply: 11,
  recovery_required: 11,
  foreign_activity: 11,
  conversation_busy: 11,
  quota: 12,
  challenge: 12,
  login: 12,
  chrome_not_running: 12,
  profile_mismatch: 12,
  orphaned_fresh_turn: 12,
  profile_busy: 12,
  driver_error: 13,
  incompatible_record: 14,
} satisfies Readonly<Record<TurnState, 0 | 10 | 11 | 12 | 13 | 14>>);

export type TurnExitCode = (typeof TURN_EXIT_CODES)[TurnState];

export interface TurnResult {
  readonly schema: typeof TURN_RESULT_SCHEMA;
  readonly state: TurnState;
  readonly scope: TurnScope;
  readonly cause: string;
  readonly invocationId: string;
  readonly configuredProfileKey: string;
  readonly conversationKey?: string;
  readonly incidentId?: string;
  readonly publicationId?: string;
}

export const CONTROL_OPERATIONS = [
  'incident_list',
  'incident_observe',
  'incident_drain',
  'incident_clear',
  'capability_status',
] as const;

export type ControlOperation = (typeof CONTROL_OPERATIONS)[number];

export const INCIDENT_LIST_STATES = [
  'ok',
  'none',
  'incompatible_schema',
  'profile_mismatch',
  'driver_error',
] as const;

export type IncidentListState = (typeof INCIDENT_LIST_STATES)[number];

export const INCIDENT_OBSERVE_STATES = [
  'drained',
  'still_active',
  'evidence_changed',
  'not_found',
  'incompatible_schema',
  'profile_mismatch',
  'driver_error',
] as const;

export type IncidentObserveState = (typeof INCIDENT_OBSERVE_STATES)[number];

export const INCIDENT_CLEAR_STATES = [
  'cleared',
  'refused_active',
  'stale_generation',
  'evidence_changed',
  'not_found',
  'incompatible_schema',
  'profile_mismatch',
  'driver_error',
] as const;

export type IncidentClearState = (typeof INCIDENT_CLEAR_STATES)[number];

export const CAPABILITY_STATES = [
  'ok',
  'no_evidence',
  'expired',
  'downgraded',
  'incompatible_schema',
  'profile_mismatch',
  'driver_error',
] as const;

export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export type ControlState =
  | IncidentListState
  | IncidentObserveState
  | IncidentClearState
  | CapabilityState;

export interface ControlResult {
  readonly schema: typeof CONTROL_RESULT_SCHEMA;
  readonly operation: ControlOperation;
  readonly state: ControlState;
  readonly configuredProfileKey: string;
  readonly complete?: boolean;
  readonly incidentId?: string;
  readonly generation?: number;
  readonly cause?: string;
}

const CONTROL_INCOMPATIBLE_STATES = new Set<ControlState>([
  'incompatible_schema',
  'profile_mismatch',
]);

export function controlExitCode(state: ControlState): 0 | 21 | 22 {
  if (state === 'driver_error') {
    return 22;
  }
  if (CONTROL_INCOMPATIBLE_STATES.has(state)) {
    return 21;
  }
  return 0;
}

export const PUBLICATION_STATES = [
  'committed_ok',
  'not_committed',
  'in_progress',
  'recovery_required',
  'conflict',
  'incompatible_schema',
  'profile_mismatch',
  'driver_error',
] as const;

export type PublicationState = (typeof PUBLICATION_STATES)[number];

export const PUBLICATION_EXIT_CODES = Object.freeze({
  committed_ok: 0,
  not_committed: 0,
  in_progress: 20,
  recovery_required: 20,
  conflict: 20,
  incompatible_schema: 21,
  profile_mismatch: 21,
  driver_error: 22,
} satisfies Readonly<Record<PublicationState, 0 | 20 | 21 | 22>>);

export type PublicationExitCode =
  (typeof PUBLICATION_EXIT_CODES)[PublicationState];

export interface PublicationStatus {
  readonly schema: typeof PUBLICATION_STATUS_SCHEMA;
  readonly state: PublicationState;
  readonly configuredProfileKey: string;
  readonly publicationId: string;
  readonly invocationId: string;
  readonly cause?: string;
  readonly outputByteLength?: number;
  readonly outputSha256?: string;
}

export function turnExitCode(state: TurnState): TurnExitCode {
  return TURN_EXIT_CODES[state];
}

export function publicationExitCode(
  state: PublicationState,
): PublicationExitCode {
  return PUBLICATION_EXIT_CODES[state];
}

export function isTurnState(value: unknown): value is TurnState {
  return typeof value === 'string' &&
    (TURN_STATES as readonly string[]).includes(value);
}

export function isControlOperation(value: unknown): value is ControlOperation {
  return typeof value === 'string' &&
    (CONTROL_OPERATIONS as readonly string[]).includes(value);
}

export function isPublicationState(value: unknown): value is PublicationState {
  return typeof value === 'string' &&
    (PUBLICATION_STATES as readonly string[]).includes(value);
}
