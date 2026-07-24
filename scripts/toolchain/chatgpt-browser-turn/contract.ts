import { createHash } from 'node:crypto';

export const TURN_STATES = [
  'ok','input_invalid','quota','challenge','login','stream_timeout','send_failed','no_reply',
  'chrome_not_running','driver_error','profile_mismatch','recovery_required','orphaned_fresh_turn',
  'ui_contract_mismatch','foreign_activity','output_conflict','conversation_busy','profile_busy',
  'incompatible_record',
] as const;
export type TurnState = typeof TURN_STATES[number];

export const TURN_EXIT: Readonly<Record<TurnState, number>> = {
  ok: 0,
  input_invalid: 10,
  output_conflict: 10,
  send_failed: 10,
  ui_contract_mismatch: 10,
  conversation_busy: 11,
  stream_timeout: 11,
  no_reply: 11,
  recovery_required: 11,
  foreign_activity: 11,
  profile_busy: 12,
  quota: 12,
  challenge: 12,
  login: 12,
  chrome_not_running: 12,
  orphaned_fresh_turn: 12,
  profile_mismatch: 12,
  driver_error: 13,
  incompatible_record: 14,
};

export const LIST_STATES = ['ok','none','incompatible_schema','profile_mismatch','driver_error'] as const;
export const OBSERVE_STATES = ['drained','still_active','evidence_changed','not_found','incompatible_schema','profile_mismatch','driver_error'] as const;
export const CLEAR_STATES = ['cleared','refused_active','stale_generation','evidence_changed','not_found','incompatible_schema','profile_mismatch','driver_error'] as const;
export const CAPABILITY_STATES = ['ok','no_evidence','expired','downgraded','incompatible_schema','profile_mismatch','driver_error'] as const;
export const PUBLICATION_STATES = ['committed_ok','not_committed','in_progress','recovery_required','conflict','incompatible_schema','profile_mismatch','driver_error'] as const;

export type ListState = typeof LIST_STATES[number];
export type ObserveState = typeof OBSERVE_STATES[number];
export type ClearState = typeof CLEAR_STATES[number];
export type CapabilityState = typeof CAPABILITY_STATES[number];
export type PublicationState = typeof PUBLICATION_STATES[number];
export type Scope = 'none'|'invocation'|'conversation'|'profile'|'machine'|'blocking_domain';

export const CONTROL_EXIT = (state: ListState|ObserveState|ClearState|CapabilityState): number => {
  if (state === 'driver_error') return 22;
  if (state === 'incompatible_schema' || state === 'profile_mismatch') return 21;
  return 0;
};

export const PUBLICATION_EXIT = (state: PublicationState): number => {
  if (state === 'driver_error') return 22;
  if (state === 'incompatible_schema' || state === 'profile_mismatch') return 21;
  if (state === 'committed_ok' || state === 'not_committed') return 0;
  return 20;
};

export interface CausalWitness {
  user_message_id: string;
  assistant_message_id: string;
  relation: 'reply_to';
  source: 'dom'|'network';
}

export interface TurnResultV1 {
  schema: 'turn-result/v1';
  invocation_id: string;
  state: TurnState;
  scope: Scope;
  cause: string;
  configured_profile_key: string;
  conversation_key?: string;
  incident_id?: string;
  generation?: number;
  output?: { byte_length: number; sha256: string };
  witness?: CausalWitness;
}

export interface ControlResultV1<T extends string = string> {
  schema: 'control-result/v1';
  operation: 'list'|'observe'|'drain'|'clear'|'capability';
  state: T;
  configured_profile_key: string;
  complete?: boolean;
  incident_id?: string;
  generation?: number;
  cause?: string;
  records?: unknown[];
}

export interface PublicationStatusV1 {
  schema: 'publication-status/v1';
  state: PublicationState;
  invocation_id: string;
  configured_profile_key: string;
  destination_key: string;
  cause?: string;
  output?: { byte_length: number; sha256: string };
}

export interface OuterRecordV1 {
  record_kind: 'owner'|'incident'|'profile_wall'|'publication'|'capability'|'reservation';
  configured_profile_key: string;
  blocking_domain_key: string;
  payload: Record<string, unknown>;
}

export const sha256 = (value: string|Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

export function canonicalJson(value: unknown): string {
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>)
        .sort(([a],[b]) => a.localeCompare(b))
        .map(([k,val]) => [k, visit(val)]));
    }
    return v;
  };
  return JSON.stringify(visit(value));
}

export function bodyFree(value: unknown): boolean {
  const forbidden = /(^|_)(body|text|prompt|reply|content|message_body|input_bytes|output_bytes)($|_)/i;
  const visit = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.every(visit);
    if (!v || typeof v !== 'object') return true;
    return Object.entries(v as Record<string, unknown>).every(([k,val]) => !forbidden.test(k) && visit(val));
  };
  return visit(value);
}

export function assertBodyFree(value: unknown): void {
  if (!bodyFree(value)) throw new Error('body-bearing field rejected from helper-owned record');
}

export function turnResult(init: Omit<TurnResultV1,'schema'>): TurnResultV1 {
  const result: TurnResultV1 = { schema: 'turn-result/v1', ...init };
  assertBodyFree(result);
  return result;
}

export function publicationStatus(init: Omit<PublicationStatusV1,'schema'>): PublicationStatusV1 {
  const result: PublicationStatusV1 = { schema: 'publication-status/v1', ...init };
  assertBodyFree(result);
  return result;
}
