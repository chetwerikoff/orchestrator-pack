import { createHash } from 'node:crypto';

export type WitnessMessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface WitnessMessage {
  readonly id: string;
  readonly role: WitnessMessageRole;
  readonly parent?: string;
}

export interface AssistantTerminalMetadata {
  endTurn?: boolean;
  finishDetailsType?: string;
  status?: string;
  contentType?: string;
  contentText?: string;
}

export type ServiceFrameKind =
  | 'delta'
  | 'patch'
  | 'stream_complete'
  | 'message_marker'
  | 'input_message'
  | 'other';

export interface ServiceFrameRecord {
  readonly kind: ServiceFrameKind;
  readonly rawType: string;
  readonly messageId?: string;
}

export type WholeTurnTerminalOutcome =
  | { readonly state: 'success'; readonly assistantMessageId: string }
  | { readonly state: 'failure'; readonly assistantMessageId: string; readonly cause: string }
  | { readonly state: 'none' };

export interface TerminalWitnessState {
  readonly messages: Map<string, WitnessMessage>;
  readonly terminalByMessageId: Map<string, AssistantTerminalMetadata>;
  readonly terminalAuthorityFrameByMessageId: Map<string, number>;
  readonly terminalizationAttemptsById: Map<string, boolean>;
  readonly frames: ServiceFrameRecord[];
  streamCompleteSeen: boolean;
  terminalAuthorityAfterFrame: number;
}

export function createTerminalWitnessState(): TerminalWitnessState {
  return {
    messages: new Map(),
    terminalByMessageId: new Map(),
    terminalAuthorityFrameByMessageId: new Map(),
    terminalizationAttemptsById: new Map(),
    frames: [],
    streamCompleteSeen: false,
    terminalAuthorityAfterFrame: 0,
  };
}

export function invalidateTerminalEvidenceForContinuation(state: TerminalWitnessState): void {
  state.terminalAuthorityAfterFrame = state.frames.length;
}


const GROUNDED_WHOLE_TURN_FAILURE_STATUSES = new Set(['finished_failed', 'interrupted']);
const GROUNDED_WHOLE_TURN_FAILURE_CONTENT_TYPES = new Set(['execution_error']);

function frameCarriesExplicitEndTurn(message: Record<string, unknown>): boolean {
  return message.end_turn === true || message.end_turn === false;
}

function isGroundedWholeTurnFailureTerminal(
  endTurn: boolean | undefined,
  terminal: AssistantTerminalMetadata,
): boolean {
  if (endTurn !== true) return false;
  if (terminal.status && GROUNDED_WHOLE_TURN_FAILURE_STATUSES.has(terminal.status)) return true;
  if (terminal.contentType && GROUNDED_WHOLE_TURN_FAILURE_CONTENT_TYPES.has(terminal.contentType)) return true;
  return false;
}

const GROUNDED_WHOLE_TURN_SUCCESS_FINISH_DETAILS = new Set(['stop']);
const GROUNDED_WHOLE_TURN_SUCCESS_STATUSES = new Set(['finished_successfully']);

function hasUnknownTerminalStatus(status: string | undefined): boolean {
  if (!status) return false;
  if (GROUNDED_WHOLE_TURN_SUCCESS_STATUSES.has(status)) return false;
  if (GROUNDED_WHOLE_TURN_FAILURE_STATUSES.has(status)) return false;
  return true;
}

function isGroundedWholeTurnSuccessTerminal(metadata: AssistantTerminalMetadata): boolean {
  if (metadata.endTurn !== true) return false;
  if (hasUnknownTerminalStatus(metadata.status)) return false;
  if (metadata.contentType && GROUNDED_WHOLE_TURN_FAILURE_CONTENT_TYPES.has(metadata.contentType)) return false;
  if (metadata.contentType && metadata.contentType !== 'text') return false;
  return metadata.finishDetailsType === 'stop';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function witnessRole(value: unknown): WitnessMessageRole | undefined {
  const role = asRecord(value)?.role;
  if (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system') return role;
  return undefined;
}

function mergeTerminalMetadata(
  existing: AssistantTerminalMetadata | undefined,
  next: AssistantTerminalMetadata,
): AssistantTerminalMetadata {
  return {
    endTurn: next.endTurn ?? existing?.endTurn,
    finishDetailsType: next.finishDetailsType ?? existing?.finishDetailsType,
    status: next.status ?? existing?.status,
    contentType: next.contentType ?? existing?.contentType,
    contentText: next.contentText ?? existing?.contentText,
  };
}

function contentTextFromMessage(message: Record<string, unknown>): string | undefined {
  const content = asRecord(message.content);
  const parts = content?.parts;
  if (!Array.isArray(parts)) return undefined;
  const text = parts.filter((part): part is string => typeof part === 'string').join('');
  return text.length > 0 ? text : undefined;
}

function terminalMetadataFromMessage(message: Record<string, unknown>): AssistantTerminalMetadata {
  const metadata = asRecord(message.metadata);
  const finishDetails = asRecord(metadata?.finish_details);
  const finishDetailsType = typeof finishDetails?.type === 'string' ? finishDetails.type : undefined;
  const endTurn = message.end_turn === true ? true : message.end_turn === false ? false : undefined;
  const status = typeof message.status === 'string' ? message.status : undefined;
  const content = asRecord(message.content);
  const contentType = typeof content?.content_type === 'string' ? content.content_type : undefined;
  const contentText = contentTextFromMessage(message);
  return { endTurn, finishDetailsType, status, contentType, contentText };
}

function recordGroundedDeltaMessage(
  state: TerminalWitnessState,
  message: Record<string, unknown>,
  role: WitnessMessageRole,
): string | undefined {
  const id = typeof message.id === 'string' ? message.id : undefined;
  if (!id || id.length < 8) return undefined;
  const parent = typeof message.parent === 'string' ? message.parent : undefined;
  state.messages.set(id, { id, role, ...(parent ? { parent } : {}) });
  const incoming = terminalMetadataFromMessage(message);
  const existing = state.terminalByMessageId.get(id);
  const next: AssistantTerminalMetadata = { ...existing };
  if (frameCarriesExplicitEndTurn(message)) {
    next.endTurn = message.end_turn === true;
  }
  if (incoming.finishDetailsType !== undefined) next.finishDetailsType = incoming.finishDetailsType;
  if (incoming.status !== undefined) next.status = incoming.status;
  if (incoming.contentType !== undefined) next.contentType = incoming.contentType;
  if (incoming.contentText !== undefined) next.contentText = incoming.contentText;
  const touched = frameCarriesExplicitEndTurn(message)
    || incoming.finishDetailsType !== undefined
    || incoming.status !== undefined
    || incoming.contentType !== undefined
    || incoming.contentText !== undefined;
  if (touched) state.terminalByMessageId.set(id, next);
  if (frameCarriesExplicitEndTurn(message) && (
    isGroundedWholeTurnSuccessTerminal(next)
    || isGroundedWholeTurnFailureTerminal(next.endTurn, next)
  )) {
    state.terminalAuthorityFrameByMessageId.set(id, state.frames.length - 1);
  }
  return id;
}

function terminalAuthorityFrame(
  state: TerminalWitnessState,
  messageId: string,
): number {
  return state.terminalAuthorityFrameByMessageId.get(messageId) ?? Number.NEGATIVE_INFINITY;
}

function hasCurrentTerminalAuthority(state: TerminalWitnessState, messageId: string): boolean {
  return terminalAuthorityFrame(state, messageId) >= state.terminalAuthorityAfterFrame;
}

function classifyFrameType(rawType: string): ServiceFrameKind {
  if (rawType === 'input_message') return 'input_message';
  if (rawType === 'message_marker') return 'message_marker';
  if (/stream.?complete/i.test(rawType)) return 'stream_complete';
  if (rawType === 'patch' || rawType === 'apply_patch') return 'patch';
  if (rawType === 'delta' || rawType === 'server_ste_metadata' || rawType === 'message') return 'delta';
  return 'other';
}

export function noteTerminalizationAttempt(
  state: TerminalWitnessState,
  payload: Record<string, unknown>,
): void {
  const candidates = [
    asRecord(asRecord(payload.v)?.message),
    asRecord(payload.message),
  ];
  for (const message of candidates) {
    if (!message) continue;
    const id = typeof message.id === 'string' ? message.id : '';
    if (id.length >= 8 && message.end_turn === true) {
      state.terminalizationAttemptsById.set(id, true);
    }
  }
}

export function ingestServicePayload(state: TerminalWitnessState, payload: Record<string, unknown>): void {
  noteTerminalizationAttempt(state, payload);
  const rawType = typeof payload.type === 'string' ? payload.type : 'other';
  const kind = classifyFrameType(rawType);
  state.frames.push({ kind, rawType });

  if (kind === 'stream_complete') {
    state.streamCompleteSeen = true;
    return;
  }

  if (rawType === 'input_message') {
    const input = asRecord(payload.input_message);
    const id = typeof input?.id === 'string' ? input.id : undefined;
    if (id && id.length >= 8) state.messages.set(id, { id, role: 'user' });
    return;
  }

  if (rawType === 'message_marker') {
    const messageId = typeof payload.message_id === 'string' ? payload.message_id : undefined;
    if (messageId) state.frames[state.frames.length - 1] = { kind, rawType, messageId };
    return;
  }

  if (rawType === 'delta') {
    const message = asRecord(asRecord(payload.v)?.message);
    const role = witnessRole(asRecord(message?.author));
    if (message && role) {
      const messageId = recordGroundedDeltaMessage(state, message, role);
      if (messageId) state.frames[state.frames.length - 1] = { kind, rawType, messageId };
    }
    return;
  }

  if (kind === 'patch') {
    return;
  }
}


const UNGROUNDED_SERVICE_WRAPPER_TYPES = new Set(['rogue_wrapper', 'rogue_terminal_frame']);

export function ingestServicePayloadTree(
  state: TerminalWitnessState,
  value: unknown,
  witnessOnly = false,
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) ingestServicePayloadTree(state, item, witnessOnly);
    return;
  }
  const obj = value as Record<string, unknown>;
  const rawType = typeof obj.type === 'string' ? obj.type : '';
  if (witnessOnly) {
    noteTerminalizationAttempt(state, obj);
    if (obj.payload !== undefined) ingestServicePayloadTree(state, obj.payload, true);
    if (obj.nested !== undefined) ingestServicePayloadTree(state, obj.nested, true);
    return;
  }
  if (UNGROUNDED_SERVICE_WRAPPER_TYPES.has(rawType)) {
    ingestServicePayloadTree(state, obj, true);
    return;
  }
  if (rawType) ingestServicePayload(state, obj);
  if (typeof obj.encoded_item === 'string') {
    for (const raw of obj.encoded_item.split(/\r?\n/)) {
      const line = raw.startsWith('data:') ? raw.slice(5).trim() : raw.trim();
      if (!line || line === '[DONE]') continue;
      try { ingestServicePayload(state, JSON.parse(line) as Record<string, unknown>); } catch { /* ignore */ }
    }
  }
}


export function isMessageAttributedToUserTurn(
  messageId: string,
  userMessageId: string,
  messages: ReadonlyMap<string, WitnessMessage>,
): boolean {
  let current: string | undefined = messageId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    if (current === userMessageId) return true;
    visited.add(current);
    current = messages.get(current)?.parent;
  }
  return false;
}

export function wholeTurnTerminalOutcome(
  metadata: AssistantTerminalMetadata | undefined,
): 'success' | 'failure' | 'none' {
  if (!metadata || metadata.endTurn !== true) return 'none';
  if (metadata.status && GROUNDED_WHOLE_TURN_FAILURE_STATUSES.has(metadata.status)) return 'failure';
  if (metadata.contentType && GROUNDED_WHOLE_TURN_FAILURE_CONTENT_TYPES.has(metadata.contentType)) {
    return 'failure';
  }
  if (isGroundedWholeTurnSuccessTerminal(metadata)) return 'success';
  return 'none';
}

export function nodeLocalStopWithoutWholeTurn(metadata: AssistantTerminalMetadata | undefined): boolean {
  if (!metadata) return false;
  return metadata.finishDetailsType === 'stop' && metadata.endTurn !== true;
}

export function resolveWholeTurnTerminal(
  userMessageId: string,
  state: TerminalWitnessState,
): WholeTurnTerminalOutcome {
  let latestSuccess: { assistantMessageId: string; index: number } | undefined;
  for (const [messageId, message] of state.messages) {
    if (message.role !== 'assistant') continue;
    if (!isMessageAttributedToUserTurn(messageId, userMessageId, state.messages)) continue;
    if (!hasCurrentTerminalAuthority(state, messageId)) continue;
    const metadata = state.terminalByMessageId.get(messageId);
    const outcome = wholeTurnTerminalOutcome(metadata);
    if (outcome === 'failure') {
      const cause = metadata?.status === 'interrupted'
        ? 'terminal_interrupted'
        : 'terminal_generation_error';
      return { state: 'failure', assistantMessageId: messageId, cause };
    }
    if (outcome === 'success') {
      const index = terminalAuthorityFrame(state, messageId);
      if (!latestSuccess || index >= latestSuccess.index) {
        latestSuccess = {
          assistantMessageId: messageId,
          index,
        };
      }
    }
  }
  if (latestSuccess) {
    return { state: 'success', assistantMessageId: latestSuccess.assistantMessageId };
  }
  return { state: 'none' };
}


export function hasTerminalWitnessActivityForAssistant(
  state: TerminalWitnessState,
  assistantMessageId: string,
): boolean {
  const metadata = state.terminalByMessageId.get(assistantMessageId);
  if (!metadata) return false;
  if (nodeLocalStopWithoutWholeTurn(metadata)) return false;
  return metadata.endTurn === true
    || (metadata.status !== undefined && metadata.status !== 'in_progress');
}

export function deltaPatchOrStreamCompleteWithoutTerminal(
  state: TerminalWitnessState,
  terminal: WholeTurnTerminalOutcome,
): boolean {
  if (terminal.state !== 'none') return false;
  return state.frames.some((frame) => frame.kind === 'delta' || frame.kind === 'patch' || frame.kind === 'stream_complete');
}

export function registerLegacyObservation(
  state: TerminalWitnessState,
  observation: WitnessMessage,
): void {
  if (!observation.id || observation.id.length < 8) return;
  const existing = state.messages.get(observation.id);
  state.messages.set(observation.id, {
    id: observation.id,
    role: observation.role,
    parent: observation.parent ?? existing?.parent,
  });
}

export const DIRECT_PUBLICATION_POLICY = 'direct-publication/v1' as const;
export const SERVICE_OBSERVED_ISSUE_COMMENT = 'service-observed-issue-comment/v1' as const;
export const FAILED_WRITE_FINAL_ASSISTANT = 'failed-write-final-assistant/v1' as const;

export interface DirectPublicationTarget {
  readonly repositoryFullName: string;
  readonly issueNumber: number;
  readonly sourceRevision: string;
  readonly invocationId: string;
  readonly userMessageId?: string;
}

export interface DirectPublicationConfig {
  readonly target: DirectPublicationTarget;
  readonly reviewerSource: string;
  readonly reviewerSourceOutput: string;
}

export interface DirectPublicationInvocation {
  readonly action: 'add_comment_to_issue';
  readonly toolCallId: string;
  readonly repositoryFullName: string;
  readonly issueNumber: number;
  readonly comment: string;
  readonly assistantMessageId?: string;
  readonly parentUserMessageId?: string;
}

export type DirectPublicationNoCommitClass =
  | 'adapter-rejected-before-dispatch'
  | 'github-create-comment-definitive-rejection';

export interface DirectPublicationResult {
  readonly toolCallId: string;
  readonly action: 'add_comment_to_issue';
  readonly repositoryFullName: string;
  readonly issueNumber: number;
  readonly outcome: 'success' | 'no-commit' | 'other';
  readonly noCommitClass?: DirectPublicationNoCommitClass;
  readonly status?: number;
  readonly commentId?: string;
  readonly commentUrl?: string;
  readonly assistantMessageId?: string;
  readonly parentUserMessageId?: string;
}

export interface DirectPublicationObservationState {
  readonly invocations: DirectPublicationInvocation[];
  readonly results: DirectPublicationResult[];
}

export function createDirectPublicationObservationState(): DirectPublicationObservationState {
  return { invocations: [], results: [] };
}

export interface DirectPublicationSettlement {
  readonly state: 'success' | 'failed-write' | 'possible-delivery';
  readonly cause: string;
  readonly invocation?: DirectPublicationInvocation;
  readonly result?: DirectPublicationResult;
  readonly sourceBytes?: string;
}

const ISSUE_COMMENT_ACTION = 'add_comment_to_issue';
const DEFINITIVE_REJECTION_STATUSES = new Set([401, 403, 404, 410, 422]);
const DIRECT_POLICY_IDENTITY_RE = /^([^#\s]+)#capture=(final-node\/v1|issue-comment-api-harvest\/v1|direct-publication\/v1)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_LINE_RE = /^Read revision: #([1-9][0-9]*) (r[0-9]+)$/;

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value);
  }
  return undefined;
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return recordValue(value);
  try {
    return recordValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function actionName(value: Record<string, unknown>): string | undefined {
  const fn = recordValue(value.function);
  const tool = recordValue(value.tool);
  const action = stringValue(
    value.name,
    value.tool_name,
    value.toolName,
    value.action,
    value.operation,
    fn?.name,
    tool?.name,
  );
  return action?.toLowerCase();
}

function toolCallId(value: Record<string, unknown>): string | undefined {
  return stringValue(value.tool_call_id, value.toolCallId, value.call_id, value.callId);
}

function targetFields(value: Record<string, unknown>): {
  repositoryFullName?: string;
  issueNumber?: number;
  comment?: string;
} {
  const args = jsonRecord(value.arguments ?? value.args ?? value.parameters ?? value.input);
  const source = args ?? value;
  return {
    repositoryFullName: stringValue(
      source.repository_full_name,
      source.repository,
      source.repo,
      value.repository_full_name,
      value.repository,
    ),
    issueNumber: numberValue(
      source.issue_number,
      source.issueNumber,
      source.issue,
      value.issue_number,
      value.issueNumber,
    ),
    comment: stringValue(source.comment, source.body, value.comment),
  };
}

function recordNoCommitClass(
  value: Record<string, unknown>,
  status: number | undefined,
): DirectPublicationNoCommitClass | undefined {
  const response = jsonRecord(value.response ?? value.result ?? value.output);
  const dispatchFalse = value.no_external_request === true
    || value.no_request_dispatched === true
    || value.request_dispatched === false
    || value.external_request_dispatched === false
    || value.dispatch_status === 'not_dispatched'
    || response?.no_external_request === true
    || response?.request_dispatched === false;
  if (dispatchFalse) return 'adapter-rejected-before-dispatch';
  const complete = value.response_complete === true
    || value.complete === true
    || status !== undefined
    || (response?.status !== undefined && response?.status !== null);
  if (complete && status !== undefined && DEFINITIVE_REJECTION_STATUSES.has(status)) {
    return 'github-create-comment-definitive-rejection';
  }
  return undefined;
}

function resultOutcome(
  value: Record<string, unknown>,
  status: number | undefined,
  commentId: string | undefined,
  commentUrl: string | undefined,
): { outcome: DirectPublicationResult['outcome']; noCommitClass?: DirectPublicationNoCommitClass } {
  const noCommitClass = recordNoCommitClass(value, status);
  const success = value.success === true
    || value.ok === true
    || (commentId !== undefined && commentUrl !== undefined);
  if (success && commentId && commentUrl) return { outcome: 'success' };
  if (noCommitClass && !success && !commentId && !commentUrl) return { outcome: 'no-commit', noCommitClass };
  return { outcome: 'other' };
}

function observeDirectPublicationObject(
  state: DirectPublicationObservationState,
  value: Record<string, unknown>,
): void {
  const action = actionName(value);
  const fields = targetFields(value);
  const id = toolCallId(value);
  const assistantMessageId = stringValue(value.assistant_message_id, value.assistantMessageId, value.message_id);
  const parentUserMessageId = stringValue(value.parent_user_message_id, value.parentUserMessageId, value.parent);
  if (
    action === ISSUE_COMMENT_ACTION
    && id
    && fields.repositoryFullName
    && fields.issueNumber !== undefined
    && fields.comment !== undefined
  ) {
    const invocation: DirectPublicationInvocation = {
      action: ISSUE_COMMENT_ACTION,
      toolCallId: id,
      repositoryFullName: fields.repositoryFullName,
      issueNumber: fields.issueNumber,
      comment: fields.comment,
      ...(assistantMessageId ? { assistantMessageId } : {}),
      ...(parentUserMessageId ? { parentUserMessageId } : {}),
    };
    const existingIndex = state.invocations.findIndex((item) =>
      item.toolCallId === invocation.toolCallId
      && item.repositoryFullName === invocation.repositoryFullName
      && item.issueNumber === invocation.issueNumber
      && item.comment === invocation.comment);
    if (existingIndex < 0) state.invocations.push(invocation);
    else state.invocations[existingIndex] = { ...state.invocations[existingIndex]!, ...invocation };
  }

  const status = numberValue(value.status, value.http_status, value.httpStatus, recordValue(value.response)?.status);
  const commentId = stringValue(
    value.comment_id,
    value.commentId,
    recordValue(value.response)?.comment_id,
    recordValue(value.response)?.id,
  );
  const commentUrl = stringValue(
    value.comment_url,
    value.commentUrl,
    value.url,
    recordValue(value.response)?.comment_url,
    recordValue(value.response)?.html_url,
  );
  const looksLikeResult = Boolean(
    id
    && value.arguments === undefined
    && value.args === undefined
    && value.parameters === undefined
    && value.input === undefined
    && (value.result !== undefined
      || value.response !== undefined
      || value.error !== undefined
      || value.success !== undefined
      || value.ok !== undefined
      || value.status !== undefined
      || value.no_external_request !== undefined
      || value.request_dispatched !== undefined),
  );
  if (
    looksLikeResult
    && fields.repositoryFullName
    && fields.issueNumber !== undefined
    && action === ISSUE_COMMENT_ACTION
  ) {
    const classified = resultOutcome(value, status, commentId, commentUrl);
    const result: DirectPublicationResult = {
      toolCallId: id!,
      action: ISSUE_COMMENT_ACTION,
      repositoryFullName: fields.repositoryFullName,
      issueNumber: fields.issueNumber,
      outcome: classified.outcome,
      ...(classified.noCommitClass ? { noCommitClass: classified.noCommitClass } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(commentId ? { commentId } : {}),
      ...(commentUrl ? { commentUrl } : {}),
      ...(assistantMessageId ? { assistantMessageId } : {}),
      ...(parentUserMessageId ? { parentUserMessageId } : {}),
    };
    const signature = JSON.stringify(result);
    if (!state.results.some((item) => JSON.stringify(item) === signature)) state.results.push(result);
  }
}

export function observeDirectPublicationPayload(
  state: DirectPublicationObservationState,
  value: unknown,
): void {
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') {
      const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      let parsedAny = false;
      for (const line of lines) {
        const data = line.startsWith('data:') ? line.slice(5).trim() : line;
        if (!data || data === '[DONE]') continue;
        const parsed = jsonRecord(data);
        if (parsed) {
          parsedAny = true;
          observeDirectPublicationPayload(state, parsed);
        }
      }
      if (!parsedAny) {
        const parsed = jsonRecord(value);
        if (parsed) observeDirectPublicationPayload(state, parsed);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) observeDirectPublicationPayload(state, item);
    return;
  }
  const record = value as Record<string, unknown>;
  observeDirectPublicationObject(state, record);
  const inherited = {
    ...(actionName(record) ? { action: actionName(record) } : {}),
    ...(toolCallId(record) ? { tool_call_id: toolCallId(record) } : {}),
    ...(targetFields(record).repositoryFullName ? { repository: targetFields(record).repositoryFullName } : {}),
    ...(targetFields(record).issueNumber !== undefined ? { issue_number: targetFields(record).issueNumber } : {}),
  };
  for (const child of Object.values(record)) {
    if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(inherited).length > 0) {
      const childRecord = child as Record<string, unknown>;
      const enriched = {
        ...inherited,
        ...childRecord,
        ...(actionName(childRecord) ? {} : { action: inherited.action }),
        ...(toolCallId(childRecord) ? {} : { tool_call_id: inherited.tool_call_id }),
      };
      observeDirectPublicationPayload(state, enriched);
    } else {
      observeDirectPublicationPayload(state, child);
    }
  }
}

function matchingDirectPublicationPairs(
  state: DirectPublicationObservationState,
  target: DirectPublicationTarget,
): { invocations: DirectPublicationInvocation[]; results: DirectPublicationResult[] } {
  const invocations = state.invocations.filter((item) =>
    item.repositoryFullName === target.repositoryFullName
    && item.issueNumber === target.issueNumber
    && (!target.userMessageId || !item.parentUserMessageId || item.parentUserMessageId === target.userMessageId));
  const results = state.results.filter((item) =>
    item.repositoryFullName === target.repositoryFullName && item.issueNumber === target.issueNumber);
  return { invocations, results };
}

export function settleDirectPublication(
  state: DirectPublicationObservationState,
  target: DirectPublicationTarget,
  finalAssistantOutput?: string,
): DirectPublicationSettlement {
  const matching = matchingDirectPublicationPairs(state, target);
  if (matching.invocations.length !== 1) {
    return { state: 'possible-delivery', cause: 'direct_publication_invocation_ambiguous' };
  }
  const invocation = matching.invocations[0]!;
  const results = matching.results.filter((item) => item.toolCallId === invocation.toolCallId);
  if (results.length !== 1) {
    return {
      state: 'possible-delivery',
      cause: results.length === 0 ? 'direct_publication_result_missing' : 'direct_publication_result_ambiguous',
      invocation,
    };
  }
  const result = results[0]!;
  if (result.outcome === 'success' && result.commentId && result.commentUrl) {
    return {
      state: 'success',
      cause: 'direct_publication_success',
      invocation,
      result,
      sourceBytes: invocation.comment,
    };
  }
  if (result.outcome === 'no-commit' && result.noCommitClass && finalAssistantOutput !== undefined) {
    return {
      state: 'failed-write',
      cause: result.noCommitClass,
      invocation,
      result,
      sourceBytes: finalAssistantOutput,
    };
  }
  return {
    state: 'possible-delivery',
    cause: 'direct_publication_possible_delivery',
    invocation,
    result,
  };
}

export interface ParsedSourceRevision {
  readonly issueNumber: number;
  readonly sourceRevision: string;
  readonly findingCount: number;
}

export function rawFindingCount(source: string): number {
  let fenced = false;
  let count = 0;
  for (const line of source.split(/\n/)) {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (/^\s*```/.test(normalized)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && !/^\s*>/.test(normalized) && /^\s*id:\s*/i.test(normalized)) count += 1;
  }
  return count;
}

export function parseCanonicalSourceRevision(
  source: string,
  target: Pick<DirectPublicationTarget, 'repositoryFullName' | 'issueNumber' | 'sourceRevision'>,
): ParsedSourceRevision | null {
  const lines = source.split(/\n/);
  const firstNonEmpty = lines.find((line) => line.trim().length > 0)?.replace(/\r$/, '');
  const match = firstNonEmpty ? REVISION_LINE_RE.exec(firstNonEmpty) : null;
  const declarations = lines.filter((line) => REVISION_LINE_RE.test(line.replace(/\r$/, ''))).length;
  if (!match || declarations !== 1) return null;
  const issueNumber = Number(match[1]);
  const sourceRevision = match[2]!;
  if (issueNumber !== target.issueNumber || sourceRevision !== target.sourceRevision) return null;
  return { issueNumber, sourceRevision, findingCount: rawFindingCount(source) };
}

export function reviewerSourceMetadata(
  settlement: DirectPublicationSettlement,
  target: DirectPublicationTarget,
): import('./contracts.ts').ReviewerSourceV1 | null {
  if (!settlement.sourceBytes || !settlement.invocation || !settlement.result) return null;
  const parsed = parseCanonicalSourceRevision(settlement.sourceBytes, target);
  if (!parsed) return null;
  const metadata: import('./contracts.ts').ReviewerSourceV1 = {
    kind: settlement.state === 'success' ? SERVICE_OBSERVED_ISSUE_COMMENT : FAILED_WRITE_FINAL_ASSISTANT,
    byte_length: Buffer.byteLength(settlement.sourceBytes, 'utf8'),
    sha256: createHash('sha256').update(settlement.sourceBytes, 'utf8').digest('hex'),
    tool_call_id: settlement.invocation.toolCallId,
    repository_full_name: target.repositoryFullName,
    issue_number: target.issueNumber,
    source_revision: parsed.sourceRevision,
    finding_count: parsed.findingCount,
    ...(settlement.state === 'success' && settlement.result.commentId ? { comment_id: settlement.result.commentId } : {}),
    ...(settlement.state === 'success' && settlement.result.commentUrl ? { comment_url: settlement.result.commentUrl } : {}),
  };
  return metadata;
}

export function directPublicationReceipt(
  settlement: DirectPublicationSettlement,
  target: DirectPublicationTarget,
): string | null {
  if (settlement.state !== 'success') return null;
  const metadata = reviewerSourceMetadata(settlement, target);
  if (!metadata || !settlement.sourceBytes || !settlement.result?.commentUrl) return null;
  const verdict = settlement.sourceBytes.match(/^VERDICT:\s*(\S.*)$/m)?.[1]?.trim();
  if (!verdict) return null;
  return [
    `VERDICT: ${verdict}`,
    `COMMENT_URL: ${settlement.result.commentUrl}`,
    `REVISION: ${metadata.source_revision}`,
    `INVOCATION_ID: ${target.invocationId}`,
    `FINDING_COUNT: ${metadata.finding_count}`,
  ].join('\n');
}

export function parseReviewerSourceIdentity(
  value: string,
): { independentSourceId: string; policy: import('./contracts.ts').ReviewerSourcePolicy } | null {
  const match = DIRECT_POLICY_IDENTITY_RE.exec(value);
  return match
    ? { independentSourceId: match[1]!, policy: match[2]! as import('./contracts.ts').ReviewerSourcePolicy }
    : null;
}

export function validateDirectPublicationInputs(input: {
  readonly invocationId: string;
  readonly prompt: string;
  readonly reviewerSource: string;
  readonly repositoryFullName: string;
  readonly issueNumber: number;
  readonly sourceRevision: string;
}): string | null {
  if (!UUID_RE.test(input.invocationId)) return 'invocation_id_invalid';
  const marker = `INVOCATION_ID_TO_ECHO: ${input.invocationId}`;
  if (input.prompt.split(/\r?\n/).filter((line) => line === marker).length !== 1) return 'invocation_id_prompt_mismatch';
  const sourceIdentity = parseReviewerSourceIdentity(input.reviewerSource);
  if (!sourceIdentity || sourceIdentity.policy !== DIRECT_PUBLICATION_POLICY) return 'reviewer_source_policy_invalid';
  if (!input.repositoryFullName || !Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) {
    return 'reviewer_target_invalid';
  }
  if (!/^r[0-9]+$/.test(input.sourceRevision)) return 'reviewer_revision_invalid';
  return null;
}
