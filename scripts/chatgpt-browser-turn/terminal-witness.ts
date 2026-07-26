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
  readonly frames: ServiceFrameRecord[];
  streamCompleteSeen: boolean;
  terminalAuthorityAfterFrame: number;
}

export function createTerminalWitnessState(): TerminalWitnessState {
  return {
    messages: new Map(),
    terminalByMessageId: new Map(),
    terminalAuthorityFrameByMessageId: new Map(),
    frames: [],
    streamCompleteSeen: false,
    terminalAuthorityAfterFrame: 0,
  };
}

export function invalidateTerminalEvidenceForContinuation(state: TerminalWitnessState): void {
  state.terminalAuthorityAfterFrame = state.frames.length;
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
  const terminal = terminalMetadataFromMessage(message);
  if (
    terminal.endTurn !== undefined
    || terminal.finishDetailsType !== undefined
    || terminal.status !== undefined
    || terminal.contentType !== undefined
  ) {
    state.terminalByMessageId.set(id, mergeTerminalMetadata(state.terminalByMessageId.get(id), terminal));
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

export function ingestServicePayload(state: TerminalWitnessState, payload: Record<string, unknown>): void {
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

export function ingestServicePayloadTree(state: TerminalWitnessState, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) ingestServicePayloadTree(state, item);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.type === 'string') ingestServicePayload(state, obj);
  if (typeof obj.encoded_item === 'string') {
    for (const raw of obj.encoded_item.split(/\r?\n/)) {
      const line = raw.startsWith('data:') ? raw.slice(5).trim() : raw.trim();
      if (!line || line === '[DONE]') continue;
      try { ingestServicePayload(state, JSON.parse(line) as Record<string, unknown>); } catch { /* ignore */ }
    }
  }
  const payload = obj.payload;
  if (payload && typeof payload === 'object') {
    const nested = asRecord(payload)?.payload;
    ingestServicePayloadTree(state, nested ?? payload);
  }
  for (const child of Object.values(obj)) ingestServicePayloadTree(state, child);
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
  const status = metadata.status?.toLowerCase() ?? '';
  if (status.includes('interrupt')) return 'failure';
  if (
    status.includes('error')
    || status.includes('failed')
    || metadata.contentType === 'execution_error'
  ) {
    return 'failure';
  }
  return 'success';
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
      const status = metadata?.status?.toLowerCase() ?? '';
      const cause = status.includes('interrupt')
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
