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

export const TURN_EXIT_CODES = {
  ok: 0,
  invocation_refusal: 10,
  conversation_block: 11,
  profile_block: 12,
  driver_error: 13,
  incompatible_record: 14,
} as const;

export const CONTROL_LIST_STATES = [
  'ok',
  'none',
  'incompatible_schema',
  'profile_mismatch',
  'driver_error',
] as const;

export const CONTROL_OBSERVE_STATES = [
  'drained',
  'still_active',
  'evidence_changed',
  'not_found',
  'incompatible_schema',
  'profile_mismatch',
  'driver_error',
] as const;

export const CONTROL_CLEAR_STATES = [
  'cleared',
  'refused_active',
  'stale_generation',
  'evidence_changed',
  'not_found',
  'incompatible_schema',
  'profile_mismatch',
  'driver_error',
] as const;

export const CAPABILITY_STATES = [
  'ok',
  'no_evidence',
  'expired',
  'downgraded',
  'incompatible_schema',
  'profile_mismatch',
  'driver_error',
] as const;

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

export const CONTROL_EXIT_CODES = {
  evaluated: 0,
  pending_or_conflict: 20,
  incompatible_or_profile_mismatch: 21,
  driver_error: 22,
} as const;

export type FailureScope = 'invocation' | 'conversation' | 'profile' | 'none';

export interface TurnResultV1 {
  schema: 'turn-result/v1';
  state: TurnState;
  scope: FailureScope;
  cause: string;
  invocationId: string;
  configuredProfileKey: string;
  conversationId?: string;
  incidentId?: string;
  generation?: number;
}

export interface ControlResultV1<TState extends string = string> {
  schema: 'control-result/v1';
  operation: 'list' | 'observe' | 'drain' | 'clear' | 'capability';
  state: TState;
  configuredProfileKey: string;
  complete?: boolean;
  cause?: string;
}

export interface PublicationStatusV1 {
  schema: 'publication-status/v1';
  state: (typeof PUBLICATION_STATES)[number];
  configuredProfileKey: string;
  invocationId: string;
  outputPath?: string;
  outputBytes?: number;
  outputSha256?: string;
  cause?: string;
}
