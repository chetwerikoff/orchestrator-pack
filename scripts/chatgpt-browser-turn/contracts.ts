export const RECORD_VERSION = 1 as const;
export const RECORD_SCHEMA = 'chatgpt-browser-turn-record/v1' as const;

export const TURN_STATES = [
  'ok', 'input_invalid', 'quota', 'rate_limit', 'challenge', 'login', 'stream_timeout',
  'send_failed', 'no_reply', 'chrome_not_running', 'driver_error', 'profile_mismatch',
  'recovery_required', 'orphaned_fresh_turn', 'ui_contract_mismatch', 'foreign_activity',
  'observation_uncertain', 'output_conflict', 'conversation_busy', 'profile_busy', 'incompatible_record',
] as const;
export type TurnState = (typeof TURN_STATES)[number];

export const STATUS_STATES = ['ok', 'none', 'profile_blocked', 'profile_mismatch', 'driver_error'] as const;
export const CLEAR_STATES = [
  'cleared', 'quarantined', 'refused_active', 'stale_generation', 'evidence_changed', 'not_found',
  'profile_blocked', 'profile_mismatch', 'driver_error',
] as const;
export const CAPABILITY_STATES = [
  'ok', 'no_evidence', 'expired', 'downgraded', 'profile_blocked', 'profile_mismatch', 'driver_error',
] as const;
export const PUBLICATION_STATES = [
  'committed_ok', 'not_committed', 'in_progress', 'recovery_required', 'conflict',
  'profile_blocked', 'profile_mismatch', 'driver_error',
] as const;

export type FailureScope = 'none' | 'invocation' | 'conversation' | 'profile' | 'machine' | 'blocking_domain';
export type IncidentKind = 'conversation_incident' | 'fresh_orphan' | 'profile_wall' | 'active_owner' | 'publication_incident';
export type IncidentPhase = 'pre_send' | 'possible_delivery' | 'reply_complete' | 'publication_prepared' | 'committed';

export const PRE_SEND_COMPOSER_FAILURE_CAUSES = [
  'composer_mutation_budget_exhausted', 'composer_unavailable', 'blocking_page_overlay',
] as const;
export type PreSendComposerFailureCause = (typeof PRE_SEND_COMPOSER_FAILURE_CAUSES)[number];

export interface CommonIncidentRecordV1 {
  schema: typeof RECORD_SCHEMA;
  version: typeof RECORD_VERSION;
  kind: IncidentKind;
  configured_profile_key: string;
  conversation_id?: string;
  provisional_id?: string;
  invocation_id?: string;
  output_identity?: string;
  generation: number;
  phase: IncidentPhase;
  cause?: string;
  lock_key?: string;
  service_user_id?: string;
  service_assistant_id?: string;
  owner?: { pid: number; started_at: string; nonce: string };
  evidence_token: string;
  created_at: string;
  updated_at: string;
}

export interface CausalWitnessV1 {
  user_message_id: string;
  assistant_message_id: string;
  relation: 'reply_to';
  source: 'service';
}

export interface PostSettlementTargetV1 {
  disposition: 'preserved_after_settlement';
  configured_profile_key: string;
  target_id: string;
  normalized_url: string;
  assistant_message_id: string;
  representation: 'innerText' | 'textContent';
  byte_length: number;
  sha256: string;
  document_ordinal: number;
  observed_user_nodes: number;
  observed_assistant_nodes: number;
  observed_message_nodes: number;
  generation_in_progress: false;
  nodes_truncated: false;
}

export interface PostSettlementTargetCaptureDiagnosticV1 {
  status: 'unavailable';
  cause: 'timeout' | 'page_detached' | 'target_identity_unavailable' | 'reply_identity_unavailable' | 'surface_incomplete' | 'malformed';
}

export const REVIEWER_SOURCE_POLICIES = ['final-node/v1', 'issue-comment-api-harvest/v1', 'direct-publication/v1'] as const;
export type ReviewerSourcePolicy = (typeof REVIEWER_SOURCE_POLICIES)[number];
export const REVIEWER_SOURCE_KINDS = ['service-observed-issue-comment/v1', 'failed-write-final-assistant/v1'] as const;
export type ReviewerSourceKind = (typeof REVIEWER_SOURCE_KINDS)[number];

export interface ReviewerSourceV1 {
  kind: ReviewerSourceKind;
  byte_length: number;
  sha256: string;
  tool_call_id: string;
  repository_full_name: string;
  issue_number: number;
  comment_id?: string;
  comment_url?: string;
  source_revision: string;
  finding_count: number;
}

export interface TurnResultV1 {
  schema: 'turn-result/v1';
  state: TurnState;
  scope: FailureScope;
  cause: string;
  invocation_id: string;
  configured_profile_key: string;
  legacy_configured_profile_key?: string;
  legacy_namespace_root?: string;
  conversation_id?: string;
  provisional_id?: string;
  incident_id?: string;
  generation?: number;
  driver_diagnostic_id?: string;
  output?: { byte_length: number; sha256: string };
  reviewer_source?: ReviewerSourceV1;
  witness?: CausalWitnessV1;
  post_settlement_target?: PostSettlementTargetV1;
  post_settlement_target_capture?: PostSettlementTargetCaptureDiagnosticV1;
  observation_uncertainty_diagnostics?: {
    cause: string;
    send_count: number;
    owned_prompt_seen: boolean;
    observed_user_heads?: readonly string[];
  };
  observation_exhausted_diagnostics?: {
    observation_state: string;
    stable_reads: number;
    last_assistant_head: string;
    poll_count: number;
    soft_deadline_elapsed: boolean;
  };
}

export interface StatusItemV1 {
  identity: string;
  kind: IncidentKind | 'opaque_quarantine' | 'blocking_tombstone' | 'opaque_record';
  generation: number;
  phase?: IncidentPhase;
  evidence_token: string;
  conversation_id?: string;
  provisional_id?: string;
  cause?: string;
  opaque?: boolean;
  configured_profile_key?: string;
}

export interface ControlResultV1 {
  schema: 'control-result/v1';
  operation: 'status/list' | 'clear' | 'capability';
  state: string;
  configured_profile_key: string;
  legacy_configured_profile_key?: string;
  legacy_namespace_root?: string;
  complete?: boolean;
  items?: StatusItemV1[];
  cause?: string;
  driver_diagnostic_id?: string;
}

export interface PublicationStatusV1 {
  schema: 'publication-status/v1';
  state: (typeof PUBLICATION_STATES)[number];
  configured_profile_key: string;
  legacy_configured_profile_key?: string;
  legacy_namespace_root?: string;
  invocation_id: string;
  output_path?: string;
  output_bytes?: number;
  output_sha256?: string;
  cause?: string;
}

export function turnExitCode(state: TurnState): number {
  if (state === 'ok') return 0;
  if (state === 'driver_error') return 13;
  if (state === 'incompatible_record') return 14;
  if (['stream_timeout', 'no_reply', 'recovery_required', 'foreign_activity', 'observation_uncertain', 'conversation_busy'].includes(state)) return 11;
  if (['quota', 'rate_limit', 'challenge', 'login', 'chrome_not_running', 'profile_mismatch', 'orphaned_fresh_turn', 'profile_busy'].includes(state)) return 12;
  return 10;
}

export function controlExitCode(state: string): number {
  if (state === 'driver_error') return 22;
  if (state === 'profile_blocked' || state === 'profile_mismatch') return 21;
  return 0;
}

export function publicationExitCode(state: PublicationStatusV1['state']): number {
  if (state === 'driver_error') return 22;
  if (state === 'profile_blocked' || state === 'profile_mismatch') return 21;
  if (state === 'in_progress' || state === 'recovery_required' || state === 'conflict') return 20;
  return 0;
}
