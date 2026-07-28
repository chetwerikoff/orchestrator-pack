import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { abandonLatePageHandle, boundedResourceCleanup, RESOURCE_CLEANUP_BOUND_MS } from './browser-session.ts';
import { revalidateProcessDestinationReservations } from './coordination.ts';
import {
  assertDispatchObservationReadyForDispatch,
  DispatchObservationEstablishmentError,
  establishDispatchObservationBoundary,
  evaluateDispatchRequestNotObserved,
  recordDispatchObservationDiagnostic,
  type DispatchObservationBoundary,
} from './dispatch-observation.ts';
import { configuredProfileKey } from './storage-common.ts';
import {
  mergeContinuationSegments,
  SEMANTIC_UI_FILTER,
  serializeSemanticNodes,
  type SemanticNode,
} from './semantic.ts';
import {
  createTerminalWitnessState,
  ingestServicePayload,
  ingestServicePayloadTree,
  invalidateTerminalEvidenceForContinuation,
  isMessageAttributedToUserTurn,
  registerLegacyObservation,
  resolveWholeTurnTerminal,
  type TerminalWitnessState,
} from './terminal-witness.ts';

const require = createRequire(import.meta.url);

export interface BrowserConfig {
  cdp: string;
  profile: string;
  projectUrl?: string;
  chatUrl?: string;
  newChat: boolean;
  timeoutMs: number;
}

export interface ProfileVerification {
  state: 'verified'|'unavailable'|'mismatch';
  cause: string;
  evidence: string;
}

interface CdpOwnerModule {
  verifyCdpProfile(input: { cdp: string; profile: string }): { ok?: boolean; message?: string; reason?: string } | undefined;
  verifyCdpProfileBounded?(input: { cdp: string; profile: string; timeoutMs: number }): Promise<{ ok?: boolean; message?: string; reason?: string; timedOut?: boolean } | undefined>;
  isCdpReachable(cdp: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<boolean>;
}

async function loadCdpOwnerModule(): Promise<CdpOwnerModule> {
  const modulePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../.claude/skills/discuss-with-gpt/verify-cdp-owner.mjs',
  );
  return await import(pathToFileURL(modulePath).href) as CdpOwnerModule;
}

export async function verifyProfile(
  config: BrowserConfig,
  segmentBudget?: TurnOperationBudget,
): Promise<ProfileVerification> {
  try {
    const mod = await loadCdpOwnerModule();
    if (segmentBudget) {
      const ownerWaitMs = segmentBudget.clampOperationWaitMs();
      if (ownerWaitMs <= 0) throw new BrowserOperationTimeoutError('profile_segment_exhausted');
      const bounded = mod.verifyCdpProfileBounded;
      if (!bounded) throw new BrowserOperationTimeoutError('owner_probe', 'bounded_mode_missing');
      const result = await bounded({ cdp: config.cdp, profile: config.profile, timeoutMs: ownerWaitMs });
      if (result?.timedOut || result?.message === 'owner_probe_timeout') {
        throw new BrowserOperationTimeoutError('owner_probe');
      }
      if (result?.ok) return { state: 'verified', cause: 'verified', evidence: String(result.message ?? result.reason ?? 'verified') };
      const reachWaitMs = segmentBudget.clampOperationWaitMs();
      if (reachWaitMs <= 0) throw new BrowserOperationTimeoutError('profile_segment_exhausted');
      try {
        const reachable = await mod.isCdpReachable(config.cdp, { timeoutMs: reachWaitMs });
        if (!reachable) return { state: 'unavailable', cause: 'chrome_not_running', evidence: 'cdp_unreachable' };
      } catch (reachError) {
        if (isCdpReachabilityTimeout(reachError)) throw new BrowserOperationTimeoutError('cdp_reachability');
        throw reachError;
      }
      return { state: 'mismatch', cause: String(result?.reason ?? 'owner_unverifiable'), evidence: String(result?.message ?? 'profile mismatch') };
    }
    const result = mod.verifyCdpProfile({ cdp: config.cdp, profile: config.profile });
    if (result?.ok) return { state: 'verified', cause: 'verified', evidence: String(result.message ?? result.reason ?? 'verified') };
    const reachable = await mod.isCdpReachable(config.cdp).catch(() => false);
    if (!reachable) return { state: 'unavailable', cause: 'chrome_not_running', evidence: 'cdp_unreachable' };
    return { state: 'mismatch', cause: String(result?.reason ?? 'owner_unverifiable'), evidence: String(result?.message ?? 'profile mismatch') };
  } catch (error) {
    if (error instanceof BrowserOperationTimeoutError) throw error;
    return { state: 'mismatch', cause: 'owner_unverifiable', evidence: error instanceof Error ? error.message : String(error) };
  }
}

export function loadChromium(): any {
  for (const path of [
    join(homedir(), '.local/share/discuss-with-gpt/node_modules/playwright-core'),
    'playwright-core', 'playwright', join(homedir(), 'pw-cost-probe/node_modules/playwright'),
  ]) {
    try { return require(path).chromium; } catch { /* continue */ }
  }
  throw new Error('playwright_missing');
}

export function normalizeConversationUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export interface CausalMessageObservation {
  id: string;
  role: 'user'|'assistant';
  parent?: string;
}

interface NetworkMessage extends CausalMessageObservation {
  conversationId?: string;
}

export const __testTiming: { now?: () => number } = {};

export const MAX_BROWSER_OPERATION_WAIT_MS = 30_000;
export const WITNESS_INSTALL_MAX_WAIT_MS = 10_000;

export interface TurnOperationBudget {
  readonly endsAtMs: number;
  remainingMs(now?: number): number;
  clampOperationWaitMs(now?: number): number;
  canStartOperation(now?: number): boolean;
}

export function createTurnOperationBudget(budgetMs: number, now = Date.now()): TurnOperationBudget {
  const endsAtMs = now + Math.max(0, budgetMs);
  return {
    endsAtMs,
    remainingMs(now = Date.now()) {
      return Math.max(0, endsAtMs - now);
    },
    clampOperationWaitMs(now = Date.now()) {
      return Math.min(MAX_BROWSER_OPERATION_WAIT_MS, Math.max(0, endsAtMs - now));
    },
    canStartOperation(now = Date.now()) {
      return now < endsAtMs;
    },
  };
}

export function createPreSendSegmentBudget(timeoutMs: number, now = Date.now()): TurnOperationBudget {
  return createTurnOperationBudget(Math.min(timeoutMs, MAX_BROWSER_OPERATION_WAIT_MS), now);
}

export class BrowserOperationTimeoutError extends Error {
  readonly operationClass: string;

  constructor(operationClass: string, detail?: string) {
    const prefix = 'browser_operation_timeout:' + operationClass;
    super(detail ? prefix + ':' + detail : prefix);
    this.name = 'BrowserOperationTimeoutError';
    this.operationClass = operationClass;
  }
}

export function isPlaywrightTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError'
    || /timeout/i.test(error.message)
    || /Timeout \d+ms exceeded/i.test(error.message);
}

export function coerceBrowserOperationTimeout(error: unknown, operationClass: string): unknown {
  if (error instanceof BrowserOperationTimeoutError) return error;
  if (isPlaywrightTimeoutError(error)) return new BrowserOperationTimeoutError(operationClass);
  return error;
}

export function browserOperationClassFromError(error: unknown): string | undefined {
  if (error instanceof BrowserOperationTimeoutError) return error.operationClass;
  if (error instanceof Error && error.message.startsWith('browser_operation_timeout:')) {
    return error.message.split(':')[1] ?? undefined;
  }
  if (isCdpReachabilityTimeout(error)) return 'cdp_reachability';
  if (isPlaywrightTimeoutError(error)) return 'playwright_operation';
  return undefined;
}

function isCdpReachabilityTimeout(error: unknown): boolean {
  return error instanceof Error
    && (error.message === 'cdp_reachability_timeout' || error.name === 'CdpReachabilityTimeoutError');
}

function wallClock(): number {
  return __testTiming.now?.() ?? Date.now();
}

function loopOperationWaitMs(loopEndsAt: number, now = wallClock()): number {
  return Math.min(MAX_BROWSER_OPERATION_WAIT_MS, Math.max(0, loopEndsAt - now));
}

function segmentOperationWait(
  segmentBudget?: TurnOperationBudget,
  fallbackMs = MAX_BROWSER_OPERATION_WAIT_MS,
): number {
  return segmentBudget?.clampOperationWaitMs() ?? fallbackMs;
}

async function boundedPlaywrightOperation<T>(waitMs: number, operation: () => Promise<T>): Promise<T> {
  if (waitMs <= 0) throw new BrowserOperationTimeoutError('playwright_operation');
  return await Promise.race([
    operation(),
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new BrowserOperationTimeoutError('playwright_operation')), waitMs);
    }),
  ]);
}

async function boundedLocatorCount(locator: any, waitMs: number): Promise<number> {
  if (waitMs <= 0) return 0;
  return await boundedPlaywrightOperation(waitMs, () => locator.count());
}

export function witnessInstallOperationWaitMs(segmentBudget?: TurnOperationBudget): number {
  const remainder = segmentBudget?.clampOperationWaitMs() ?? MAX_BROWSER_OPERATION_WAIT_MS;
  return Math.min(remainder, WITNESS_INSTALL_MAX_WAIT_MS);
}

function playwrightTimeout(waitMs: number): { timeout: number } | undefined {
  return waitMs > 0 ? { timeout: waitMs } : undefined;
}

type OperationWaitSource = number | (() => number);

function resolveOperationWaitMs(source?: OperationWaitSource): number {
  const ms = typeof source === 'function' ? source() : (source ?? MAX_BROWSER_OPERATION_WAIT_MS);
  return ms > 0 ? ms : 0;
}

async function readLocatorAttribute(locator: any, attr: string, waitSource?: OperationWaitSource): Promise<string | null> {
  const waitMs = resolveOperationWaitMs(waitSource);
  if (waitMs <= 0) return null;
  try {
    return await locator.getAttribute(attr, playwrightTimeout(waitMs)!);
  } catch (error) {
    throw coerceBrowserOperationTimeout(error, 'service_attribute');
  }
}

async function readWitnessAttribute(locator: any, attr: string, waitSource: OperationWaitSource): Promise<string | null> {
  const waitMs = resolveOperationWaitMs(waitSource);
  if (waitMs <= 0) throw new BrowserOperationTimeoutError('witness_surface');
  try {
    return await locator.getAttribute(attr, playwrightTimeout(waitMs)!);
  } catch (error) {
    throw coerceBrowserOperationTimeout(error, 'witness_surface');
  }
}

function requireOperationWait(waitSource?: OperationWaitSource, operationClass = 'product_status'): number {
  const waitMs = resolveOperationWaitMs(waitSource);
  if (waitMs <= 0) throw new BrowserOperationTimeoutError(operationClass);
  return waitMs;
}

interface NetworkWitnessState {
  readonly messages: NetworkMessage[];
  readonly dispatchCandidateIds: Set<string>;
  readonly serviceSubmittedUserIds: Set<string>;
  readonly rejectedServiceUserIds: Set<string>;
  readonly terminal: TerminalWitnessState;
  dispatchArmed: boolean;
  turnDispatchCommitted: boolean;
  ingestingDispatchServiceFrames: boolean;
  dispatchRequestUserId?: string;
  dispatchRequestWitnessed: boolean;
  dispatchTurnExchangeId?: string;
  dispatchExchangeAmbiguous: boolean;
  witnessedTurnExchangeIds: Set<string>;
  provisionalServiceId?: string;
  dispatchWitnessFrozen: boolean;
  frozenDispatchExchangeAmbiguous: boolean;
  frozenDispatchTurnExchangeId?: string;
  frozenDispatchRequestUserId?: string;
  frozenDispatchCandidateIds: Set<string>;
  pendingServiceInputMessageIds: Set<string>;
  encodedItemWitnessTurnUserId?: string;
  pendingPatchAssistantId?: string;
  provenTurnStreamId?: string;
  pendingStreamTurnIdByUserId: Map<string, string>;
  turnStreamTerminalTargetByTurnId: Map<string, string>;
  pendingStreamMarkersByTurnId: Map<string, string>;
  pendingStreamAppendOpsByTurnId: Map<string, { content: string }[]>;
  pendingStreamPatchOpsByTurnId: Map<string, Record<string, unknown>[][]>;
  activeTurnUserId?: string;
  rawSseDecodingPatchTargetId?: string;
  witnessInstall: Promise<void>;
  armDispatch(): void;
}

function boundDispatchTurnExchangeId(state: NetworkWitnessState): string | undefined {
  return state.dispatchWitnessFrozen ? state.frozenDispatchTurnExchangeId : state.dispatchTurnExchangeId;
}

function boundDispatchRequestUserId(state: NetworkWitnessState): string | undefined {
  return state.dispatchWitnessFrozen ? state.frozenDispatchRequestUserId : state.dispatchRequestUserId;
}

function boundDispatchCandidateIds(state: NetworkWitnessState): Set<string> {
  return state.dispatchWitnessFrozen ? state.frozenDispatchCandidateIds : state.dispatchCandidateIds;
}

function dispatchExchangeIsAmbiguous(state: NetworkWitnessState): boolean {
  return state.dispatchWitnessFrozen ? state.frozenDispatchExchangeAmbiguous : state.dispatchExchangeAmbiguous;
}

function freezeDispatchWitness(state: NetworkWitnessState): void {
  state.dispatchWitnessFrozen = true;
  syncFrozenDispatchWitness(state);
}

function syncFrozenDispatchWitness(state: NetworkWitnessState): void {
  if (!state.dispatchWitnessFrozen) return;
  state.frozenDispatchExchangeAmbiguous = state.dispatchExchangeAmbiguous;
  state.frozenDispatchTurnExchangeId = state.dispatchTurnExchangeId;
  state.frozenDispatchRequestUserId = state.dispatchRequestUserId;
  state.frozenDispatchCandidateIds = new Set(state.dispatchCandidateIds);
}

function promotePendingServiceUserIds(state: NetworkWitnessState): void {
  for (const pendingId of [...state.pendingServiceInputMessageIds]) {
    recordServiceSubmittedUserId(state, pendingId);
  }
}

function witnessDispatchRequest(state: NetworkWitnessState, request: any): void {
  const url = String(request.url());
  if (!/conversation|messages|responses/i.test(url)) return;
  const turnExchangeId = parseRequestTurnExchangeId(request);
  if (turnExchangeId) {
    state.witnessedTurnExchangeIds.add(turnExchangeId);
    if (state.dispatchTurnExchangeId && state.dispatchTurnExchangeId !== turnExchangeId) {
      state.dispatchExchangeAmbiguous = true;
    } else if (!state.dispatchTurnExchangeId) {
      state.dispatchTurnExchangeId = turnExchangeId;
    }
  }
  for (const message of parseRequestBody(request)) {
    if (message.role === 'user') {
      state.dispatchCandidateIds.add(message.id);
      if (state.dispatchRequestUserId && state.dispatchRequestUserId !== message.id) {
        state.dispatchExchangeAmbiguous = true;
      } else if (!state.dispatchRequestUserId) {
        state.dispatchRequestUserId = message.id;
      }
    }
  }
  state.dispatchRequestWitnessed = true;
  syncFrozenDispatchWitness(state);
  promotePendingServiceUserIds(state);
}

function provenActiveTurnUserId(state: NetworkWitnessState): string | undefined {
  const id = state.activeTurnUserId;
  if (!id || !state.serviceSubmittedUserIds.has(id)) return undefined;
  return id;
}

export function resolveCausalAssistant(
  userMessageId: string,
  observations: readonly CausalMessageObservation[],
): { state: 'matched'; assistantMessageId: string } | { state: 'none' | 'ambiguous' } {
  const exactIds = new Set(
    observations
      .filter((message) => message.role === 'assistant' && message.parent === userMessageId && message.id.length >= 8)
      .map((message) => message.id),
  );
  if (exactIds.size === 0) return { state: 'none' };
  if (exactIds.size !== 1) return { state: 'ambiguous' };
  const [assistantMessageId] = exactIds;
  return assistantMessageId ? { state: 'matched', assistantMessageId } : { state: 'none' };
}

function recursivelyCollectMessages(value: unknown, out: NetworkMessage[], inheritedConversation?: string): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) recursivelyCollectMessages(item, out, inheritedConversation);
    return;
  }
  const obj = value as Record<string, unknown>;
  const conversation = typeof obj.conversation_id === 'string' ? obj.conversation_id : inheritedConversation;
  const message = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : obj;
  const author = message.author && typeof message.author === 'object' ? message.author as Record<string, unknown> : undefined;
  const role = author?.role;
  const id = message.id;
  if ((role === 'user' || role === 'assistant') && typeof id === 'string' && id.length >= 8) {
    const parent = typeof message.parent === 'string' ? message.parent : typeof obj.parent === 'string' ? obj.parent : undefined;
    out.push({ id, role, ...(parent ? { parent } : {}), ...(conversation ? { conversationId: conversation } : {}) });
  }
  for (const child of Object.values(obj)) recursivelyCollectMessages(child, out, conversation);
}

function parseStreamingBody(text: string): NetworkMessage[] {
  const messages: NetworkMessage[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.startsWith('data:') ? raw.slice(5).trim() : raw.trim();
    if (!line || line === '[DONE]') continue;
    try { recursivelyCollectMessages(JSON.parse(line), messages); } catch { /* not JSON */ }
  }
  return messages;
}

function parseRequestBody(request: any): NetworkMessage[] {
  try {
    const body = typeof request.postData === 'function' ? request.postData() : null;
    if (!body) return [];
    const messages: NetworkMessage[] = [];
    recursivelyCollectMessages(JSON.parse(String(body)), messages);
    return messages;
  } catch {
    return [];
  }
}

function parseRequestTurnExchangeId(request: any): string | undefined {
  try {
    const body = typeof request.postData === 'function' ? request.postData() : null;
    if (!body) return undefined;
    return findTurnExchangeId(JSON.parse(String(body)));
  } catch {
    return undefined;
  }
}

function findTurnExchangeId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTurnExchangeId(item);
      if (found) return found;
    }
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const metadata = obj.metadata;
  if (metadata && typeof metadata === 'object') {
    const turnExchangeId = (metadata as Record<string, unknown>).turn_exchange_id;
    if (typeof turnExchangeId === 'string' && turnExchangeId.length >= 8) return turnExchangeId;
  }
  for (const child of Object.values(obj)) {
    const found = findTurnExchangeId(child);
    if (found) return found;
  }
  return undefined;
}


interface StreamTurnContext {
  readonly turnId?: string;
  readonly topicId?: string;
}

function streamTurnIdFromTopic(topicId: string | undefined): string | undefined {
  if (!topicId) return undefined;
  const prefix = 'conversation-turn-';
  return topicId.startsWith(prefix) ? topicId.slice(prefix.length) : undefined;
}

function mergeStreamTurnContext(
  obj: Record<string, unknown>,
  inherited?: StreamTurnContext,
): StreamTurnContext | undefined {
  const topicId = typeof obj.topic_id === 'string' ? obj.topic_id : inherited?.topicId;
  let turnId = inherited?.turnId;
  const payload = obj.payload;
  if (payload && typeof payload === 'object') {
    const nested = (payload as Record<string, unknown>).payload;
    if (nested && typeof nested === 'object') {
      const streamItem = nested as Record<string, unknown>;
      if (typeof streamItem.turn_id === 'string') turnId = streamItem.turn_id;
    }
  }
  const resolvedTurnId = turnId ?? streamTurnIdFromTopic(topicId);
  if (!resolvedTurnId && !topicId) return inherited;
  return {
    turnId: resolvedTurnId,
    topicId: topicId ?? (resolvedTurnId ? `conversation-turn-${resolvedTurnId}` : undefined),
  };
}

function turnMatchesProvenStream(state: NetworkWitnessState, turnContext?: StreamTurnContext): boolean {
  const proven = state.provenTurnStreamId;
  if (!proven || !turnContext?.turnId) return false;
  return proven === turnContext.turnId;
}



function provenTurnStreamTerminalTarget(
  state: NetworkWitnessState,
  turnContext?: StreamTurnContext,
): string | undefined {
  if (!turnMatchesProvenStream(state, turnContext)) return undefined;
  const turnId = turnContext?.turnId;
  if (!turnId) return undefined;
  return state.turnStreamTerminalTargetByTurnId.get(turnId);
}

function isOwnedStreamTurn(state: NetworkWitnessState, turnContext?: StreamTurnContext): boolean {
  const turnId = turnContext?.turnId;
  if (!turnId) return false;
  if (state.provenTurnStreamId === turnId) return true;
  for (const tid of state.pendingStreamTurnIdByUserId.values()) {
    if (tid === turnId) return true;
  }
  return false;
}

function rememberPendingStreamMarker(
  state: NetworkWitnessState,
  assistantId: string,
  turnContext?: StreamTurnContext,
): void {
  const turnId = turnContext?.turnId;
  if (!turnId || !assistantId || !isOwnedStreamTurn(state, turnContext)) return;
  state.pendingStreamMarkersByTurnId.set(turnId, assistantId);
}

function bufferPendingStreamAppend(
  state: NetworkWitnessState,
  turnContext: StreamTurnContext | undefined,
  content: string,
): void {
  const turnId = turnContext?.turnId;
  if (!turnId || !content || !isOwnedStreamTurn(state, turnContext)) return;
  const queue = state.pendingStreamAppendOpsByTurnId.get(turnId) ?? [];
  queue.push({ content });
  state.pendingStreamAppendOpsByTurnId.set(turnId, queue);
}

function bufferPendingStreamPatch(
  state: NetworkWitnessState,
  turnContext: StreamTurnContext | undefined,
  items: Record<string, unknown>[],
): void {
  const turnId = turnContext?.turnId;
  if (!turnId || !items.length || !isOwnedStreamTurn(state, turnContext)) return;
  const queue = state.pendingStreamPatchOpsByTurnId.get(turnId) ?? [];
  queue.push(items);
  state.pendingStreamPatchOpsByTurnId.set(turnId, queue);
}

function flushPendingStreamTurnEvidence(state: NetworkWitnessState, turnId: string): void {
  const turnContext: StreamTurnContext = {
    turnId,
    topicId: `conversation-turn-${turnId}`,
  };
  const marker = state.pendingStreamMarkersByTurnId.get(turnId);
  if (marker) bindTurnScopedTerminalTarget(state, marker, turnContext);
  const userId = provenActiveTurnUserId(state);
  const targetId = state.turnStreamTerminalTargetByTurnId.get(turnId) ?? marker;
  if (!userId || !targetId) return;
  for (const { content } of state.pendingStreamAppendOpsByTurnId.get(turnId) ?? []) {
    ingestServicePayload(state.terminal, {
      type: 'delta',
      v: {
        message: {
          id: targetId,
          author: { role: 'assistant' },
          parent: userId,
          content: { content_type: 'text', parts: [content] },
        },
      },
    });
  }
  for (const items of state.pendingStreamPatchOpsByTurnId.get(turnId) ?? []) {
    applyStreamingPatchItems(state, targetId, items);
  }
  state.pendingStreamMarkersByTurnId.delete(turnId);
  state.pendingStreamAppendOpsByTurnId.delete(turnId);
  state.pendingStreamPatchOpsByTurnId.delete(turnId);
}

function rememberInputMessageTurnStream(
  state: NetworkWitnessState,
  userId: string,
  turnContext?: StreamTurnContext,
): void {
  if (!userId || !turnContext?.turnId) return;
  state.pendingStreamTurnIdByUserId.set(userId, turnContext.turnId);
  promoteStreamTurnProof(state, userId);
}

function promoteStreamTurnProof(state: NetworkWitnessState, userId: string): void {
  if (!state.serviceSubmittedUserIds.has(userId)) return;
  const turnId = state.pendingStreamTurnIdByUserId.get(userId);
  if (!turnId) return;
  state.provenTurnStreamId = turnId;
  flushPendingStreamTurnEvidence(state, turnId);
}

function bindTurnScopedTerminalTarget(
  state: NetworkWitnessState,
  assistantId: string,
  turnContext?: StreamTurnContext,
): void {
  if (!assistantId || assistantId.length < 8) return;
  if (!turnMatchesProvenStream(state, turnContext)) return;
  const userId = provenActiveTurnUserId(state);
  if (!userId) return;
  const turnId = turnContext?.turnId;
  if (!turnId) return;
  state.turnStreamTerminalTargetByTurnId.set(turnId, assistantId);
  state.pendingPatchAssistantId = undefined;
  if (!state.terminal.messages.has(assistantId)) {
    ingestServicePayload(state.terminal, {
      type: 'delta',
      v: { message: { id: assistantId, author: { role: 'assistant' }, parent: userId } },
    });
    state.messages.push({ id: assistantId, role: 'assistant', parent: userId });
  }
}

function ensurePositionalPatchTarget(
  state: NetworkWitnessState,
  turnContext?: StreamTurnContext,
): string | undefined {
  const userId = provenActiveTurnUserId(state);
  if (!userId) return undefined;

  if (turnMatchesProvenStream(state, turnContext)) {
    const targetId = provenTurnStreamTerminalTarget(state, turnContext);
    if (!targetId || targetId.length < 8) return undefined;
    if (!isMessageAttributedToUserTurn(targetId, userId, state.terminal.messages)) {
      bindTurnScopedTerminalTarget(state, targetId, turnContext);
      if (!isMessageAttributedToUserTurn(targetId, userId, state.terminal.messages)) return undefined;
    }
    return targetId;
  }

  if (!turnContext?.turnId) {
    const targetId = state.rawSseDecodingPatchTargetId;
    if (!targetId || targetId.length < 8) return undefined;
    if (!isMessageAttributedToUserTurn(targetId, userId, state.terminal.messages)) return undefined;
    return targetId;
  }

  return undefined;
}

function ingestTurnScopedAssistantDelta(
  state: NetworkWitnessState,
  message: Record<string, unknown>,
  turnContext?: StreamTurnContext,
): void {
  const author = message.author as Record<string, unknown> | undefined;
  if (author?.role !== 'assistant' || typeof message.id !== 'string') return;
  const userId = provenActiveTurnUserId(state);
  if (!userId || !turnMatchesProvenStream(state, turnContext)) return;
  if (message.id === provenTurnStreamTerminalTarget(state, turnContext)) {
    bindTurnScopedTerminalTarget(state, message.id, turnContext);
    ingestServicePayload(state.terminal, {
      type: 'delta',
      v: { message: { ...message, parent: userId } },
    });
    return;
  }
  const content = message.content as Record<string, unknown> | undefined;
  const contentType = typeof content?.content_type === 'string' ? content.content_type : undefined;
  if (contentType === 'model_editable_context' || contentType === 'reasoning_recap') {
    ingestServicePayload(state.terminal, { type: 'delta', v: { message } });
  }
}


function applyStreamingPatchItems(
  state: NetworkWitnessState,
  targetId: string,
  items: Record<string, unknown>[],
): void {
  const patchMessage: Record<string, unknown> = {
    id: targetId,
    author: { role: 'assistant' },
  };
  let touched = false;
  for (const patch of items) {
    if (patch.p === '/message/end_turn' && patch.o === 'replace') {
      patchMessage.end_turn = patch.v === true;
      touched = true;
    }
    if (patch.p === '/message/status' && patch.o === 'replace' && typeof patch.v === 'string') {
      patchMessage.status = patch.v;
      touched = true;
    }
    if (patch.p === '/message/metadata' && patch.o === 'append') {
      const metadata = patch.v as Record<string, unknown> | undefined;
      if (metadata?.finish_details) {
        patchMessage.metadata = metadata;
        touched = true;
      }
    }
  }
  if (!touched) return;
  ingestServicePayload(state.terminal, { type: 'delta', v: { message: patchMessage } });
}

function registerPatchTargetAssistant(
  state: NetworkWitnessState,
  targetId: string,
  patchOwnerUserId: string,
  turnContext?: StreamTurnContext,
): void {
  if (turnMatchesProvenStream(state, turnContext)) {
    const turnId = turnContext?.turnId;
    if (turnId) state.turnStreamTerminalTargetByTurnId.set(turnId, targetId);
  } else if (!turnContext?.turnId) {
    const userId = provenActiveTurnUserId(state);
    if (userId && patchOwnerUserId === userId) state.rawSseDecodingPatchTargetId = targetId;
  }
  state.pendingPatchAssistantId = undefined;
  if (!state.terminal.messages.has(targetId)) {
    ingestServicePayload(state.terminal, {
      type: 'delta',
      v: { message: { id: targetId, author: { role: 'assistant' }, parent: patchOwnerUserId } },
    });
    state.messages.push({ id: targetId, role: 'assistant', parent: patchOwnerUserId });
  }
}

function applyStreamingPatchOperation(
  state: NetworkWitnessState,
  payload: Record<string, unknown>,
  turnContext?: StreamTurnContext,
): void {
  const op = payload.o;
  if (op === undefined || op === null) {
    const value = payload.v as Record<string, unknown> | undefined;
    const message = value?.message as Record<string, unknown> | undefined;
    if (message) ingestTurnScopedAssistantDelta(state, message, turnContext);
    return;
  }
  if (op === 'append') {
    const partPath = typeof payload.p === 'string' ? payload.p : '';
    if (!partPath.includes('/content/parts/')) return;
    const content = typeof payload.v === 'string' ? payload.v : '';
    if (!content) return;
    const targetId = ensurePositionalPatchTarget(state, turnContext);
    if (!targetId) {
      bufferPendingStreamAppend(state, turnContext, content);
      return;
    }
    const userId = provenActiveTurnUserId(state);
    if (!userId) return;
    ingestServicePayload(state.terminal, {
      type: 'delta',
      v: {
        message: {
          id: targetId,
          author: { role: 'assistant' },
          parent: userId,
          content: { content_type: 'text', parts: [content] },
        },
      },
    });
    return;
  }
  if (op === 'add') {
    const value = payload.v as Record<string, unknown> | undefined;
    const message = value?.message as Record<string, unknown> | undefined;
    if (!message || typeof message.id !== 'string') return;
    const author = message.author as Record<string, unknown> | undefined;
    const role = author?.role;
    if (role !== 'user' && role !== 'assistant') return;
    const content = message.content as Record<string, unknown> | undefined;
    const contentType = typeof content?.content_type === 'string' ? content.content_type : undefined;
    if (role === 'assistant' && (contentType === 'model_editable_context' || contentType === 'reasoning_recap')) {
      ingestServicePayload(state.terminal, { type: 'delta', v: { message } });
      return;
    }
    const parent = typeof message.parent === 'string' ? message.parent : undefined;
    const userId = provenActiveTurnUserId(state);
    const effectiveParent = role === 'assistant'
      ? (parent ?? (message.id === provenTurnStreamTerminalTarget(state, turnContext) ? userId : undefined)
        ?? (message.id === state.pendingPatchAssistantId ? userId : undefined))
      : parent;
    if (role === 'assistant') {
      if (!userId || effectiveParent !== userId) return;
      registerPatchTargetAssistant(state, message.id, userId, turnContext);
      ingestServicePayload(state.terminal, { type: 'delta', v: { message: { ...message, parent: userId } } });
      return;
    }
    ingestServicePayload(state.terminal, { type: 'delta', v: { message: { ...message, ...(effectiveParent ? { parent: effectiveParent } : {}) } } });
    state.messages.push({
      id: message.id,
      role,
      ...(effectiveParent ? { parent: effectiveParent } : {}),
    });
    return;
  }
  if (op !== 'patch' || !Array.isArray(payload.v)) return;
  const targetId = ensurePositionalPatchTarget(state, turnContext);
  if (!targetId) {
    bufferPendingStreamPatch(state, turnContext, payload.v as Record<string, unknown>[]);
    return;
  }
  applyStreamingPatchItems(state, targetId, payload.v as Record<string, unknown>[]);
}

function ingestEncodedItemWitness(state: NetworkWitnessState, encodedItem: string, turnContext?: StreamTurnContext): void {
  if (!encodedItem) return;
  const rawSseDecode = !turnContext?.turnId;
  if (rawSseDecode) state.rawSseDecodingPatchTargetId = undefined;
  state.encodedItemWitnessTurnUserId = undefined;
  state.messages.push(...parseStreamingBody(encodedItem));
  let streamEvent = '';
  try {
  for (const raw of encodedItem.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('event:')) {
      streamEvent = trimmed.slice(6).trim();
      continue;
    }
    const line = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!line || line === '[DONE]') continue;
    if (line.startsWith('"') && streamEvent !== 'delta') {
      streamEvent = '';
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        streamEvent = '';
        continue;
      }
      const payload = parsed as Record<string, unknown>;
      if (streamEvent === 'delta') {
        applyStreamingPatchOperation(state, payload, turnContext);
      } else {
        ingestServicePayload(state.terminal, payload);
        recursivelyCollectMessages(payload, state.messages);
        if (payload.type === 'input_message') {
          const input = payload.input_message as Record<string, unknown> | undefined;
          const id = typeof input?.id === 'string' ? input.id : '';
          const metadata = input?.metadata as Record<string, unknown> | undefined;
          const turnExchangeId = typeof metadata?.turn_exchange_id === 'string' ? metadata.turn_exchange_id : undefined;
          if (id) {
            rememberInputMessageTurnStream(state, id, turnContext);
            recordServiceSubmittedUserId(state, id, turnExchangeId);
            if (state.serviceSubmittedUserIds.has(id)) state.encodedItemWitnessTurnUserId = id;
          }
        }
        if (payload.type === 'message_marker' && payload.marker === 'user_visible_token') {
          const assistantId = typeof payload.message_id === 'string' ? payload.message_id : '';
          const userId = state.encodedItemWitnessTurnUserId ?? provenActiveTurnUserId(state);
          if (assistantId && isOwnedStreamTurn(state, turnContext)) {
            rememberPendingStreamMarker(state, assistantId, turnContext);
            if (userId && state.serviceSubmittedUserIds.has(userId)) {
              bindTurnScopedTerminalTarget(state, assistantId, turnContext);
            }
          }
        }
        const delta = payload.v as Record<string, unknown> | undefined;
        const message = delta?.message as Record<string, unknown> | undefined;
        const author = message?.author as Record<string, unknown> | undefined;
        const role = author?.role;
        if (message && typeof message.id === 'string' && (role === 'user' || role === 'assistant')) {
          const parent = typeof message.parent === 'string' ? message.parent : undefined;
          state.messages.push({
            id: message.id,
            role,
            ...(parent ? { parent } : {}),
          });
        }
      }
    } catch { /* non-JSON stream lines remain fail-closed */ }
    streamEvent = '';
  }
  } finally {
    if (rawSseDecode) state.rawSseDecodingPatchTargetId = undefined;
  }
}

function walkEncodedItemEnvelopes(
  state: NetworkWitnessState,
  value: unknown,
  inherited?: StreamTurnContext,
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walkEncodedItemEnvelopes(state, item, inherited);
    return;
  }
  const obj = value as Record<string, unknown>;
  const context = mergeStreamTurnContext(obj, inherited);
  if (typeof obj.encoded_item === 'string') {
    ingestEncodedItemWitness(state, obj.encoded_item, context);
    return;
  }
  for (const child of Object.values(obj)) walkEncodedItemEnvelopes(state, child, context ?? inherited);
}

// PR #1003 stopped correlating service input_message ids with dispatch proof: observedDispatchUserIds
// required dispatchCandidateIds before consulting network witness, and input_message ids were not recorded
// in network.messages. Live sends often prove only through WebSocket input_message, not DOM mirrors.

function canonicalSubmittedUserId(state: NetworkWitnessState, baselineIds: ReadonlySet<string>): string {
  for (const id of state.serviceSubmittedUserIds) {
    if (!baselineIds.has(id)) return id;
  }
  return '';
}

function recordServiceSubmittedUserId(
  state: NetworkWitnessState,
  id: string,
  turnExchangeId?: string,
): void {
  if (!state.dispatchArmed || id.length < 8) return;
  if (state.rejectedServiceUserIds.has(id)) return;

  const boundExchangeId = boundDispatchTurnExchangeId(state);
  if (turnExchangeId && boundExchangeId && turnExchangeId !== boundExchangeId) {
    state.rejectedServiceUserIds.add(id);
    return;
  }

  const requestUserId = boundDispatchRequestUserId(state);
  const dispatchBound = state.turnDispatchCommitted || state.ingestingDispatchServiceFrames || state.dispatchWitnessFrozen;

  // Live wire proof: the client-generated user-message id in the outbound request matches
  // the service-issued id echoed in input_message. No turn_exchange_id is required.
  if (requestUserId && id === requestUserId && dispatchBound) {
    state.serviceSubmittedUserIds.add(id);
    state.messages.push({ id, role: 'user' });
    state.activeTurnUserId = id;
    state.provisionalServiceId = id;
    state.pendingServiceInputMessageIds.delete(id);
    promoteStreamTurnProof(state, id);
    return;
  }

  const boundCandidates = boundDispatchCandidateIds(state);
  if (boundCandidates.has(id)) {
    state.serviceSubmittedUserIds.add(id);
    state.messages.push({ id, role: 'user' });
    state.activeTurnUserId = id;
    state.provisionalServiceId = id;
    state.pendingServiceInputMessageIds.delete(id);
    promoteStreamTurnProof(state, id);
    return;
  }

  const canCorrelateProvisional = Boolean(
    requestUserId
    && dispatchBound
    && boundCandidates.has(requestUserId)
    && !state.provisionalServiceId
    && id !== requestUserId
    && turnExchangeId
    && boundExchangeId
    && turnExchangeId === boundExchangeId,
  );
  if (canCorrelateProvisional) {
    state.provisionalServiceId = id;
    state.serviceSubmittedUserIds.add(id);
    state.messages.push({ id, role: 'user' });
    state.activeTurnUserId = id;
    state.pendingServiceInputMessageIds.delete(id);
    promoteStreamTurnProof(state, id);
    return;
  }

  if (
    dispatchBound
    && boundCandidates.size === 0
    && state.serviceSubmittedUserIds.size === 0
    && turnExchangeId
    && boundExchangeId
    && turnExchangeId === boundExchangeId
  ) {
    state.serviceSubmittedUserIds.add(id);
    state.messages.push({ id, role: 'user' });
    state.activeTurnUserId = id;
    state.provisionalServiceId = id;
    state.pendingServiceInputMessageIds.delete(id);
    promoteStreamTurnProof(state, id);
    return;
  }

  if (
    dispatchBound
    && !requestUserId
    && boundCandidates.size === 0
    && !boundExchangeId
  ) {
    state.pendingServiceInputMessageIds.add(id);
    return;
  }

  state.rejectedServiceUserIds.add(id);
}

function collectInputMessageWitness(
  state: NetworkWitnessState,
  value: unknown,
  inherited?: StreamTurnContext,
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectInputMessageWitness(state, item, inherited);
    return;
  }
  const obj = value as Record<string, unknown>;
  const context = mergeStreamTurnContext(obj, inherited);
  if (obj.type === 'input_message') {
    const input = obj.input_message as Record<string, unknown> | undefined;
    const id = typeof input?.id === 'string' ? input.id : '';
    const metadata = input?.metadata as Record<string, unknown> | undefined;
    const turnExchangeId = typeof metadata?.turn_exchange_id === 'string' ? metadata.turn_exchange_id : undefined;
    if (id) {
      rememberInputMessageTurnStream(state, id, context);
      recordServiceSubmittedUserId(state, id, turnExchangeId);
    }
  }
  if (obj.type === 'message_marker' && obj.marker === 'user_visible_token') {
    const assistantId = typeof obj.message_id === 'string' ? obj.message_id : '';
    const userId = provenActiveTurnUserId(state);
    if (assistantId && isOwnedStreamTurn(state, context)) {
      rememberPendingStreamMarker(state, assistantId, context);
      if (userId && state.serviceSubmittedUserIds.has(userId)) {
        bindTurnScopedTerminalTarget(state, assistantId, context);
      }
    }
  }
  const payload = obj.payload;
  if (payload && typeof payload === 'object') {
    const nested = (payload as Record<string, unknown>).payload;
    collectInputMessageWitness(state, nested ?? payload, context ?? inherited);
  }
  for (const child of Object.values(obj)) collectInputMessageWitness(state, child, context ?? inherited);
}

function ingestWitnessJsonTree(state: NetworkWitnessState, value: unknown): void {
  ingestServicePayloadTree(state.terminal, value);
  collectInputMessageWitness(state, value);
  walkEncodedItemEnvelopes(state, value);
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) ingestWitnessJsonTree(state, item);
    return;
  }
}

function ingestWebSocketWitnessPayload(state: NetworkWitnessState, payloadData: string): void {
  if (!payloadData) return;
  try {
    ingestWitnessJsonTree(state, JSON.parse(payloadData));
  } catch {
    ingestEncodedItemWitness(state, payloadData);
  }
}

async function installWebSocketWitness(page: any, state: NetworkWitnessState): Promise<void> {
  const onPayload = (payloadData: string) => {
    ingestWebSocketWitnessPayload(state, payloadData);
  };

  if (typeof page.on === 'function') {
    page.on('websocket', (ws: { on: (event: string, handler: (frame: { payload?: string }) => void) => void }) => {
      ws.on('framereceived', (frame) => {
        onPayload(frame.payload ?? '');
      });
    });
  }

  const context = page.context?.();
  if (!context || typeof context.newCDPSession !== 'function') return;
  try {
    const cdp = await Promise.race([
      context.newCDPSession(page),
      new Promise<null>((resolve) => { setTimeout(() => resolve(null), 5_000); }),
    ]);
    if (!cdp) return;
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketFrameReceived', (event: { response?: { payloadData?: string } }) => {
      onPayload(event.response?.payloadData ?? '');
    });
  } catch { /* CDP witness remains optional when Playwright websocket is available */ }
}

function attachNetworkWitness(page: any): NetworkWitnessState {
  const state: NetworkWitnessState = {
    messages: [],
    dispatchCandidateIds: new Set<string>(),
    serviceSubmittedUserIds: new Set<string>(),
    rejectedServiceUserIds: new Set<string>(),
    terminal: createTerminalWitnessState(),
    dispatchArmed: false,
    turnDispatchCommitted: false,
    ingestingDispatchServiceFrames: false,
    dispatchRequestWitnessed: false,
    dispatchExchangeAmbiguous: false,
    witnessedTurnExchangeIds: new Set<string>(),
    dispatchWitnessFrozen: false,
    frozenDispatchExchangeAmbiguous: false,
    frozenDispatchCandidateIds: new Set<string>(),
    pendingServiceInputMessageIds: new Set<string>(),
    pendingStreamTurnIdByUserId: new Map<string, string>(),
    turnStreamTerminalTargetByTurnId: new Map<string, string>(),
    pendingStreamMarkersByTurnId: new Map<string, string>(),
    pendingStreamAppendOpsByTurnId: new Map<string, { content: string }[]>(),
    pendingStreamPatchOpsByTurnId: new Map<string, Record<string, unknown>[][]>(),
    armDispatch() { this.dispatchArmed = true; },
    witnessInstall: Promise.resolve(),
  };
  state.witnessInstall = installWebSocketWitness(page, state).catch(() => {});
  page.on('request', (request: any) => {
    try {
      if (!state.dispatchArmed) return;
      if (!state.ingestingDispatchServiceFrames && !(state.turnDispatchCommitted && !state.dispatchRequestWitnessed)) return;
      witnessDispatchRequest(state, request);
    } catch { /* missing request witness remains fail-closed */ }
  });
  page.on('response', async (response: any) => {
    try {
      const url = String(response.url());
      if (!/conversation|messages|responses/i.test(url)) return;
      const body = await response.text();
      state.messages.push(...parseStreamingBody(body));
      try {
        ingestWitnessJsonTree(state, JSON.parse(body));
      } catch {
        ingestEncodedItemWitness(state, body);
      }
    } catch { /* streaming/opaque responses may not expose a body; DOM witness remains available */ }
  });
  return state;
}

async function serviceId(locator: any, waitSource?: OperationWaitSource): Promise<string> {
  for (const attr of ['data-message-id', 'data-turn-id']) {
    const direct = await readLocatorAttribute(locator, attr, waitSource);
    if (direct && direct.length >= 8) return direct;
    const parent = locator.locator(`[${attr}]`).first();
    const nested = await readLocatorAttribute(parent, attr, waitSource);
    if (nested && nested.length >= 8) return nested;
  }
  return '';
}

async function parentServiceId(locator: any, waitSource?: OperationWaitSource): Promise<string> {
  for (const attr of ['data-parent-message-id', 'data-parent-turn-id']) {
    const direct = await readLocatorAttribute(locator, attr, waitSource);
    if (direct && direct.length >= 8) return direct;
    const nested = await readLocatorAttribute(locator.locator(`[${attr}]`).first(), attr, waitSource);
    if (nested && nested.length >= 8) return nested;
  }
  return '';
}

export type WitnessSurfaceProbe = 'available' | 'absent' | 'empty';

export function witnessSurfaceProbeRequiresDowngrade(
  probe: WitnessSurfaceProbe,
  freshConversation: boolean,
): boolean {
  if (probe === 'available') return false;
  if (probe === 'empty' && freshConversation) return false;
  return true;
}

export async function runtimeWitnessSurfaceAvailable(
  page: any,
  segmentBudget?: TurnOperationBudget,
): Promise<WitnessSurfaceProbe> {
  const clampWitnessWait = (): number => {
    const waitMs = segmentBudget?.clampOperationWaitMs() ?? MAX_BROWSER_OPERATION_WAIT_MS;
    if (segmentBudget && waitMs <= 0) throw new BrowserOperationTimeoutError('witness_surface');
    return waitMs;
  };
  let waitMs = clampWitnessWait();
  const messages = page.locator('[data-message-author-role]');
  let count: number;
  try {
    count = await boundedLocatorCount(messages, waitMs);
  } catch (error) {
    if (error instanceof BrowserOperationTimeoutError) throw error;
    return 'absent';
  }
  if (count === 0) return 'empty';
  const userIds = new Set<string>();
  const assistantParents: string[] = [];
  for (let index = Math.max(0, count - 8); index < count; index++) {
    waitMs = clampWitnessWait();
    const locator = messages.nth(index);
    const role = await readWitnessAttribute(locator, 'data-message-author-role', clampWitnessWait);
    if (role === 'user') {
      const id = await serviceId(locator, clampWitnessWait);
      if (id) userIds.add(id);
    } else if (role === 'assistant') {
      const id = await serviceId(locator, clampWitnessWait);
      const parent = await parentServiceId(locator, clampWitnessWait);
      if (id && parent) assistantParents.push(parent);
    }
  }
  if (assistantParents.some((parent) => userIds.has(parent))) return 'available';
  for (let index = Math.max(0, count - 8); index < count - 1; index++) {
    waitMs = clampWitnessWait();
    const locator = messages.nth(index);
    const next = messages.nth(index + 1);
    const role = await readWitnessAttribute(locator, 'data-message-author-role', clampWitnessWait);
    const nextRole = await readWitnessAttribute(next, 'data-message-author-role', clampWitnessWait);
    if (role !== 'user' || nextRole !== 'assistant') continue;
    const userId = await serviceId(locator, clampWitnessWait);
    const turnStart = await readWitnessAttribute(next, 'data-turn-start-message', clampWitnessWait);
    if (userId && turnStart === 'true') return 'available';
  }
  return 'absent';
}

export interface ProductStatusSurface {
  readonly text: string;
  readonly composer: boolean;
}

export async function productStatusText(page: any, waitSource?: OperationWaitSource): Promise<ProductStatusSurface> {
  const composer = (await boundedLocatorCount(
    page.locator('#prompt-textarea'),
    requireOperationWait(waitSource, 'product_status'),
  )) > 0;
  const selectors = [
    '[role="alert"]',
    '[role="dialog"]',
    '[data-testid*="quota"]',
    '[data-testid*="limit"]',
    '[data-testid*="challenge"]',
    '[data-testid*="login"]',
    '[data-testid*="auth"]',
    '[data-testid*="error"]',
    'a[href*="/auth/login"]',
    'a[href*="/auth/signup"]',
  ];
  const parts: string[] = [];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const countWait = requireOperationWait(waitSource, 'product_status');
    const count = Math.min(await boundedLocatorCount(locator, countWait), 8);
    for (let index = 0; index < count; index++) {
      const textWait = requireOperationWait(waitSource, 'product_status');
      const text = await boundedPlaywrightOperation(textWait, () => locator.nth(index).innerText(playwrightTimeout(textWait)!));
      if (text) parts.push(String(text));
    }
  }
  return { text: parts.join('\n'), composer };
}

export function classifyProductWall(surface: ProductStatusSurface): { state?: 'quota'|'challenge'|'login'; cause?: string } {
  if (/verify you are human|checking your browser|just a moment|unusual activity/i.test(surface.text)) {
    return { state: 'challenge', cause: 'challenge_detected' };
  }
  if (/you(?:'|’)ve reached|usage limit|message limit|reached the current usage|please try again later/i.test(surface.text)) {
    return { state: 'quota', cause: 'quota_detected' };
  }
  if (!surface.composer && /log in|sign in/i.test(surface.text)) return { state: 'login', cause: 'login_required' };
  return {};
}

async function pageWalls(page: any, waitSource?: OperationWaitSource): Promise<{ state?: string; cause?: string }> {
  return classifyProductWall(await productStatusText(page, waitSource));
}

async function semanticNodes(locator: any, waitMs = MAX_BROWSER_OPERATION_WAIT_MS): Promise<SemanticNode[]> {
  return await locator.evaluate((root: Element, filter: {
    skippedTags: readonly string[];
    testidPattern: string;
    classPattern: string;
  }) => {
    type N = SemanticNode;
    const testidPattern = new RegExp(filter.testidPattern, 'i');
    const classPattern = new RegExp(filter.classPattern, 'i');
    const skip = (el: Element) => {
      const tag = el.tagName.toLowerCase();
      if (filter.skippedTags.includes(tag)) return true;
      if (el.getAttribute('aria-hidden') === 'true') return true;
      if (testidPattern.test(el.getAttribute('data-testid') ?? '')) return true;
      if (classPattern.test(el.getAttribute('class') ?? '')) return true;
      return false;
    };
    const walkChildren = (el: Element): N[] => Array.from(el.childNodes).flatMap((child): N[] => {
      if (child.nodeType === Node.TEXT_NODE) return child.textContent ? [{ type: 'text', text: child.textContent }] : [];
      if (child.nodeType !== Node.ELEMENT_NODE) return [];
      return walk(child as Element);
    });
    const walk = (el: Element): N[] => {
      if (skip(el)) return [];
      const tag = el.tagName.toLowerCase();
      if (tag === 'br') return [{ type: 'line_break' }];
      if (tag === 'pre') return [{ type: 'code_block', text: (el.textContent ?? '').replace(/\r\n?/g, '\n') }];
      if (tag === 'code') return [{ type: 'inline_code', text: el.textContent ?? '' }];
      if (tag === 'p') return [{ type: 'paragraph', children: walkChildren(el) }];
      if (/^h[1-6]$/.test(tag)) return [{ type: 'heading', children: walkChildren(el) }];
      if (tag === 'blockquote') return [{ type: 'blockquote', children: walkChildren(el) }];
      if (tag === 'a') return [{ type: 'link', children: walkChildren(el) }];
      if (tag === 'ul') {
        const items = Array.from(el.children).filter((child) => child.tagName.toLowerCase() === 'li').map((li) => walkChildren(li));
        return [{ type: 'unordered_list', items }];
      }
      if (tag === 'ol') {
        const start = Number(el.getAttribute('start') ?? '1') || 1;
        const lis = Array.from(el.children).filter((child) => child.tagName.toLowerCase() === 'li');
        return [{ type: 'ordered_list', items: lis.map((li, index) => ({ ordinal: li.getAttribute('value') ?? String(start + index), children: walkChildren(li) })) }];
      }
      if (tag === 'li') return [{ type: 'group', children: walkChildren(el) }];
      return walkChildren(el);
    };
    return walkChildren(root);
  }, SEMANTIC_UI_FILTER, { timeout: waitMs });
}

async function assistantText(locator: any, waitMs = MAX_BROWSER_OPERATION_WAIT_MS): Promise<string> {
  return serializeSemanticNodes(await semanticNodes(locator, waitMs));
}

async function observedDispatchUserIds(
  page: any,
  network: NetworkWitnessState,
  baselineIds: ReadonlySet<string>,
  waitSource?: OperationWaitSource,
): Promise<Set<string>> {
  const serviceIds = [...network.serviceSubmittedUserIds].filter((id) => !baselineIds.has(id));
  if (serviceIds.length === 1) return new Set(serviceIds);
  if (serviceIds.length > 1) return new Set(serviceIds);
  const observed = new Set<string>();
  const candidates = boundDispatchCandidateIds(network);
  if (candidates.size === 0) return observed;
  const users = page.locator('[data-message-author-role="user"]');
  const countWait = resolveOperationWaitMs(waitSource);
  if (countWait <= 0) return observed;
  const count = await boundedLocatorCount(users, countWait);
  for (let index = Math.max(0, count - 8); index < count; index++) {
    const id = await serviceId(users.nth(index), waitSource);
    if (id && !baselineIds.has(id) && candidates.has(id)) observed.add(id);
  }
  for (const message of network.messages) {
    if (message.role === 'user' && !baselineIds.has(message.id) && candidates.has(message.id)) {
      observed.add(message.id);
    }
  }
  return observed;
}

export interface TurnBrowserResult {
  state: 'ok'|'quota'|'challenge'|'login'|'stream_timeout'|'send_failed'|'no_reply'|'ui_contract_mismatch'|'foreign_activity'|'recovery_required'|'orphaned_fresh_turn'|'output_conflict';
  cause: string;
  conversationId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  reply?: string;
  possibleDelivery: boolean;
}



export async function openGateBCharacterizationPage(browser: any, chatUrl = 'https://chatgpt.com/'): Promise<{ page: any; owned: boolean }> {
  const contexts = browser.contexts();
  if (contexts.length !== 1) throw new Error('ui_contract_mismatch:context_count');
  const ctx = contexts[0];
  const existing = ctx.pages().find((page: { url: () => string }) => {
    try { return page.url().includes('chatgpt.com'); } catch { return false; }
  });
  if (existing) {
    await existing.bringToFront().catch(() => {});
    return { page: existing, owned: false };
  }
  const page = await ctx.newPage();
  await page.goto(chatUrl, { waitUntil: 'domcontentloaded' });
  return { page, owned: true };
}

async function adoptNewPageWithBudget(
  ctx: any,
  goto: (page: any, gotoWaitMs: number) => Promise<void>,
  segmentBudget?: TurnOperationBudget,
  fallbackMs = MAX_BROWSER_OPERATION_WAIT_MS,
): Promise<any> {
  let waitMs = segmentOperationWait(segmentBudget, fallbackMs);
  if (segmentBudget && waitMs <= 0) throw new BrowserOperationTimeoutError('new_page');
  const pagePromise = ctx.newPage();
  let page: any;
  try {
    page = await boundedPlaywrightOperation(waitMs, () => pagePromise);
  } catch (error) {
    pagePromise
      .then((latePage: any) => abandonLatePageHandle(latePage, RESOURCE_CLEANUP_BOUND_MS))
      .catch(() => {});
    if (error instanceof BrowserOperationTimeoutError) throw new BrowserOperationTimeoutError('new_page');
    throw coerceBrowserOperationTimeout(error, 'new_page');
  }
  waitMs = segmentOperationWait(segmentBudget, fallbackMs);
  if (segmentBudget && waitMs <= 0) throw new BrowserOperationTimeoutError('goto');
  try {
    await boundedPlaywrightOperation(waitMs, () => goto(page, waitMs));
    return page;
  } catch (error) {
    await boundedResourceCleanup(() => page.close(), RESOURCE_CLEANUP_BOUND_MS);
    throw coerceBrowserOperationTimeout(error, 'goto');
  }
}

export async function openTurnPage(
  browser: any,
  config: BrowserConfig,
  options?: { segmentBudget?: TurnOperationBudget },
): Promise<{ page: any; owned: boolean; provisionalId?: string }> {
  const segmentBudget = options?.segmentBudget;
  const fallbackGotoMs = Math.min(config.timeoutMs, MAX_BROWSER_OPERATION_WAIT_MS);
  if (segmentBudget && !segmentBudget.canStartOperation()) throw new BrowserOperationTimeoutError('open_turn_page');
  const contexts = browser.contexts();
  if (contexts.length !== 1) throw new Error('ui_contract_mismatch:context_count');
  const ctx = contexts[0];
  if (!config.newChat) {
    if (!config.chatUrl) throw new Error('ui_contract_mismatch:chat_url_required');
    const target = normalizeConversationUrl(config.chatUrl);
    const matches = ctx.pages().filter((page: any) => {
      try { return normalizeConversationUrl(page.url()) === target; } catch { return false; }
    });
    if (matches.length > 1) throw new Error('ui_contract_mismatch:duplicate_tabs');
    if (matches.length === 1) {
      const reused = matches[0];
      try {
        if (normalizeConversationUrl(reused.url()) === target) {
          return { page: reused, owned: false };
        }
      } catch {
        /* unreadable tab URL — do not goto a foreign shared handle */
      }
    }
    const page = await adoptNewPageWithBudget(ctx, async (opened, gotoWaitMs) => {
      await opened.goto(target, { waitUntil: 'domcontentloaded', timeout: gotoWaitMs });
      if (normalizeConversationUrl(opened.url()) !== target) {
        throw new Error('ui_contract_mismatch:conversation_redirect');
      }
    }, segmentBudget, fallbackGotoMs);
    return { page, owned: true };
  }
  if (!config.projectUrl) throw new Error('ui_contract_mismatch:project_url_required');
  const page = await adoptNewPageWithBudget(ctx, async (opened, gotoWaitMs) => {
    await opened.goto(config.projectUrl, { waitUntil: 'domcontentloaded', timeout: gotoWaitMs });
  }, segmentBudget, fallbackGotoMs);
  return { page, owned: true, provisionalId: crypto.randomUUID() };
}

function witnessDelay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function witnessPollDelay(page: any, ms: number): Promise<void> {
  if ((page as { __fakeTurnPage?: boolean }).__fakeTurnPage && typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(ms);
    return;
  }
  await witnessDelay(ms);
}

export async function sendTurn(
  page: any,
  text: string,
  config: BrowserConfig,
  provisionalId?: string,
  onBeforeSend?: () => void | Promise<void>,
  segmentBudget?: TurnOperationBudget,
): Promise<TurnBrowserResult> {
  const network = attachNetworkWitness(page);
  const composer = page.locator('#prompt-textarea');
  const readyEndsAt = segmentBudget?.endsAtMs ?? wallClock() + Math.min(config.timeoutMs, MAX_BROWSER_OPERATION_WAIT_MS);
  while (wallClock() < readyEndsAt) {
    const waitMs = loopOperationWaitMs(readyEndsAt, wallClock());
    if (waitMs <= 0) break;
    const wall = await boundedPlaywrightOperation(waitMs, () => pageWalls(page, () => segmentOperationWait(segmentBudget, waitMs)));
    if (wall.state) return { state: wall.state as TurnBrowserResult['state'], cause: wall.cause!, possibleDelivery: false };
    const composerVisible = await boundedLocatorCount(composer, waitMs);
    if (composerVisible) break;
    await witnessPollDelay(page, Math.min(500, waitMs));
  }
  const composerReadyWait = loopOperationWaitMs(readyEndsAt, wallClock());
  if (!(await boundedLocatorCount(composer, composerReadyWait))) {
    if (segmentBudget && wallClock() >= readyEndsAt) {
      throw new BrowserOperationTimeoutError('composer_readiness');
    }
    return { state: 'ui_contract_mismatch', cause: 'composer_unavailable', possibleDelivery: false };
  }

  const role = '[data-message-author-role]';
  const baseline = page.locator(role);
  const baselineIds = new Set<string>();
  let baselineWait = segmentBudget?.clampOperationWaitMs() ?? MAX_BROWSER_OPERATION_WAIT_MS;
  if (segmentBudget && baselineWait <= 0) throw new BrowserOperationTimeoutError('pre_send_baseline');
  const baselineCount = await boundedLocatorCount(baseline, baselineWait);
  for (let index = 0; index < baselineCount; index++) {
    baselineWait = segmentBudget?.clampOperationWaitMs() ?? MAX_BROWSER_OPERATION_WAIT_MS;
    if (segmentBudget && baselineWait <= 0) throw new BrowserOperationTimeoutError('pre_send_baseline');
    const id = await serviceId(baseline.nth(index), () => segmentBudget?.clampOperationWaitMs() ?? MAX_BROWSER_OPERATION_WAIT_MS);
    if (id) baselineIds.add(id);
  }

  const usersBeforeDispatch = page.locator('[data-message-author-role="user"]');
  let preDispatchUserNodeCount = 0;
  let userNodeBaselineReliable = true;
  try {
    preDispatchUserNodeCount = await usersBeforeDispatch.count();
  } catch {
    userNodeBaselineReliable = false;
    preDispatchUserNodeCount = -1;
  }

  let preDispatchNormalizedUrl = '';
  let urlBaselineReliable = true;
  try {
    preDispatchNormalizedUrl = normalizeConversationUrl(page.url());
  } catch {
    urlBaselineReliable = false;
    preDispatchNormalizedUrl = '';
  }

  let dispatchObservation: DispatchObservationBoundary;
  try {
    dispatchObservation = await establishDispatchObservationBoundary(page, {
      newChatMode: config.newChat,
      preDispatchUserNodeCount,
      preDispatchNormalizedUrl,
      userNodeBaselineReliable,
      urlBaselineReliable,
      profileKey: configuredProfileKey(config.profile, config.cdp),
      cdp: config.cdp,
    });
  } catch (error) {
    if (error instanceof DispatchObservationEstablishmentError) {
      throw error;
    }
    throw new DispatchObservationEstablishmentError('dispatch_observation_establishment_failed');
  }

  let mutationWait = segmentBudget?.clampOperationWaitMs() ?? MAX_BROWSER_OPERATION_WAIT_MS;
  if (segmentBudget && mutationWait <= 0) throw new BrowserOperationTimeoutError('pre_send_mutation');
  try {
    await composer.click(playwrightTimeout(mutationWait)!);
    mutationWait = segmentBudget?.clampOperationWaitMs() ?? MAX_BROWSER_OPERATION_WAIT_MS;
    if (segmentBudget && mutationWait <= 0) throw new BrowserOperationTimeoutError('pre_send_mutation');
    await composer.fill(text, playwrightTimeout(mutationWait)!);
  } catch (error) {
    throw coerceBrowserOperationTimeout(error, 'pre_send_mutation');
  }
  const send = page.locator('[data-testid="send-button"]');
  mutationWait = segmentBudget?.clampOperationWaitMs() ?? MAX_BROWSER_OPERATION_WAIT_MS;
  const sendAvailable = (await boundedLocatorCount(send, mutationWait)) > 0;
  revalidateProcessDestinationReservations();
  try {
    assertDispatchObservationReadyForDispatch(dispatchObservation);
  } catch (error) {
    if (error instanceof DispatchObservationEstablishmentError) {
      throw error;
    }
    throw new DispatchObservationEstablishmentError('dispatch_observation_establishment_failed');
  }
  await onBeforeSend?.();
  try {
    revalidateProcessDestinationReservations();
  } catch (error) {
    return {
      state: 'output_conflict',
      cause: error instanceof Error ? error.message : 'output_conflict:changed_before_dispatch',
      possibleDelivery: false,
    };
  }
  const witnessInstallWait = witnessInstallOperationWaitMs(segmentBudget);
  if (segmentBudget && witnessInstallWait <= 0) throw new BrowserOperationTimeoutError('witness_install');
  await boundedPlaywrightOperation(witnessInstallWait, () => network.witnessInstall);
  const dispatchWait = segmentBudget?.clampOperationWaitMs() ?? MAX_BROWSER_OPERATION_WAIT_MS;
  if (segmentBudget && dispatchWait <= 0) throw new BrowserOperationTimeoutError('dispatch');
  const dispatchTimeout = playwrightTimeout(dispatchWait);
  network.armDispatch();
  dispatchObservation.armDispatchObservation();
  try {
    network.ingestingDispatchServiceFrames = true;
    if (sendAvailable) await boundedPlaywrightOperation(dispatchWait, () => send.click(dispatchTimeout));
    else {
      const composer = page.locator('#prompt-textarea');
      if ((await boundedLocatorCount(composer, dispatchWait)) <= 0) throw new BrowserOperationTimeoutError('dispatch');
      await boundedPlaywrightOperation(dispatchWait, () => composer.press('Enter', { timeout: dispatchWait }));
    }
    network.turnDispatchCommitted = true;
  } catch {
    network.ingestingDispatchServiceFrames = false;
    return { state: 'recovery_required', cause: 'dispatch_exception_after_possible_delivery_boundary', possibleDelivery: true };
  }
  freezeDispatchWitness(network);
  network.ingestingDispatchServiceFrames = false;

  let userId = '';
  const deliveredEndsAt = wallClock() + MAX_BROWSER_OPERATION_WAIT_MS;
  while (wallClock() < deliveredEndsAt && !userId) {
    if (dispatchExchangeIsAmbiguous(network)) {
      return { state: 'foreign_activity', cause: 'submitted_turn_ambiguous', possibleDelivery: true };
    }
    const canonicalEarly = canonicalSubmittedUserId(network, baselineIds);
    if (!canonicalEarly && boundDispatchCandidateIds(network).size > 1) {
      return { state: 'foreign_activity', cause: 'submitted_turn_ambiguous', possibleDelivery: true };
    }
    const deliveredWait = loopOperationWaitMs(deliveredEndsAt);
    if (deliveredWait <= 0) break;
    const observed = await boundedPlaywrightOperation(deliveredWait, () => observedDispatchUserIds(page, network, baselineIds, () => loopOperationWaitMs(deliveredEndsAt)));
    if (observed.size > 1) return { state: 'foreign_activity', cause: 'submitted_turn_ambiguous', possibleDelivery: true };
    userId = observed.values().next().value ?? '';
    if (!userId) await witnessPollDelay(page, Math.min(250, deliveredWait));
  }
  if (!userId) {
    const nonDelivery = await evaluateDispatchRequestNotObserved(
      dispatchObservation,
      page,
      baselineIds,
      async (targetPage) => await targetPage.locator('[data-message-author-role="user"]').count(),
      serviceId,
    );
    if (nonDelivery.proven) {
      recordDispatchObservationDiagnostic(nonDelivery.diagnostic, 'dispatch_request_not_observed');
      return {
        state: 'send_failed',
        cause: 'dispatch_request_not_observed',
        possibleDelivery: false,
      };
    }
    return { state: 'recovery_required', cause: 'submitted_turn_id_unproven', possibleDelivery: true };
  }
  userId = canonicalSubmittedUserId(network, baselineIds) || userId;

  const segments: string[] = [];
  let boundAssistantId = '';
  let terminalSuccessSeen = false;
  let contentStablePolls = 0;
  let lastTerminalContent = '';
  let continuationActive = false;
  let awaitingFreshTerminalAfterContinuation = false;
  let terminalPublishEligible = true;
  const deadline = wallClock() + config.timeoutMs;
  while (wallClock() < deadline) {
    let replyWait = loopOperationWaitMs(deadline, wallClock());
    if (replyWait <= 0) break;
    const wall = await boundedPlaywrightOperation(replyWait, () => pageWalls(page, loopOperationWaitMs(deadline, wallClock())));
    const canonicalUserIdEarly = canonicalSubmittedUserId(network, baselineIds);
    if (!canonicalUserIdEarly && boundDispatchCandidateIds(network).size > 1) {
      return { state: 'foreign_activity', cause: 'submitted_turn_ambiguous', possibleDelivery: true, userMessageId: userId };
    }
    replyWait = loopOperationWaitMs(deadline, wallClock());
    if (replyWait <= 0) break;
    const observedDispatch = await boundedPlaywrightOperation(replyWait, () => observedDispatchUserIds(page, network, baselineIds, () => loopOperationWaitMs(deadline, wallClock())));
    const canonicalUserId = canonicalSubmittedUserId(network, baselineIds);
    if (canonicalUserId) userId = canonicalUserId;
    if (observedDispatch.size > 1) {
      return { state: 'foreign_activity', cause: 'submitted_turn_ambiguous', possibleDelivery: true, userMessageId: userId };
    }
    if (observedDispatch.size === 1 && !observedDispatch.has(userId)) {
      return { state: 'foreign_activity', cause: 'submitted_turn_witness_changed', possibleDelivery: true, userMessageId: userId };
    }

    replyWait = loopOperationWaitMs(deadline, wallClock());
    if (replyWait <= 0) break;
    const users = page.locator('[data-message-author-role="user"]');
    const newUserIds = new Set<string>();
    const userCount = await boundedLocatorCount(users, replyWait);
    for (let index = 0; index < userCount; index++) {
      replyWait = loopOperationWaitMs(deadline, wallClock());
      if (replyWait <= 0) break;
      const id = await serviceId(users.nth(index), () => loopOperationWaitMs(deadline, wallClock()));
      if (id && !baselineIds.has(id)) newUserIds.add(id);
    }
    if ([...newUserIds].some((id) => id !== userId)) {
      return { state: 'foreign_activity', cause: 'unexpected_user_turn', possibleDelivery: true, userMessageId: userId };
    }

    replyWait = loopOperationWaitMs(deadline, wallClock());
    if (replyWait <= 0) break;
    const assistants = page.locator('[data-message-author-role="assistant"]');
    const assistantLocators = new Map<string, any>();
    const assistantCount = await boundedLocatorCount(assistants, replyWait);
    for (let index = 0; index < assistantCount; index++) {
      replyWait = loopOperationWaitMs(deadline, wallClock());
      if (replyWait <= 0) break;
      const locator = assistants.nth(index);
      const id = await serviceId(locator, () => loopOperationWaitMs(deadline, wallClock()));
      if (!id || baselineIds.has(id)) continue;
      assistantLocators.set(id, locator);
    }
    for (const message of network.messages) {
      if (!baselineIds.has(message.id)) {
        registerLegacyObservation(network.terminal, message);
      }
    }

    for (const [assistantMessageId, message] of network.terminal.messages) {
      if (message.role !== 'assistant' || baselineIds.has(assistantMessageId)) continue;
      if (isMessageAttributedToUserTurn(assistantMessageId, userId, network.terminal.messages)) continue;
      for (const foreignUserId of newUserIds) {
        if (foreignUserId === userId) continue;
        if (isMessageAttributedToUserTurn(assistantMessageId, foreignUserId, network.terminal.messages)) {
          return {
            state: 'foreign_activity',
            cause: 'foreign_assistant_turn',
            possibleDelivery: true,
            userMessageId: userId,
          };
        }
      }
    }

    replyWait = loopOperationWaitMs(deadline, wallClock());
    if (replyWait <= 0) break;
    const cont = page.getByText(/continue generating/i);
    if (await boundedLocatorCount(cont, replyWait)) {
      let continuationLocator: any = null;
      if (boundAssistantId) {
        continuationLocator = assistantLocators.get(boundAssistantId) ?? null;
      }
      if (!continuationLocator) {
        for (let index = 0; index < assistantCount; index++) {
          replyWait = loopOperationWaitMs(deadline, wallClock());
          if (replyWait <= 0) break;
          const locator = assistants.nth(index);
          const id = await serviceId(locator, () => loopOperationWaitMs(deadline, wallClock()));
          if (id && isMessageAttributedToUserTurn(id, userId, network.terminal.messages)) {
            continuationLocator = locator;
            break;
          }
        }
      }
      if (continuationLocator) {
        replyWait = loopOperationWaitMs(deadline, wallClock());
        if (replyWait <= 0) break;
        const current = await boundedPlaywrightOperation(replyWait, () => assistantText(continuationLocator, replyWait)).catch(() => '');
        if (current && (!segments.length || segments[segments.length - 1] !== current)) segments.push(current);
        replyWait = loopOperationWaitMs(deadline, wallClock());
        if (replyWait > 0) {
          await boundedPlaywrightOperation(replyWait, () => cont.first().click(playwrightTimeout(replyWait)!)).catch(() => {});
        }
        continuationActive = true;
        awaitingFreshTerminalAfterContinuation = true;
        terminalPublishEligible = false;
        terminalSuccessSeen = false;
        boundAssistantId = '';
        invalidateTerminalEvidenceForContinuation(network.terminal);
        contentStablePolls = 0;
        lastTerminalContent = '';
      }
    }

    const terminal = resolveWholeTurnTerminal(userId, network.terminal);
    if (terminal.state === 'failure') {
      return {
        state: 'no_reply',
        cause: terminal.cause,
        possibleDelivery: true,
        userMessageId: userId,
        assistantMessageId: terminal.assistantMessageId,
      };
    }

    if (terminal.state === 'success') {
      if (awaitingFreshTerminalAfterContinuation) {
        awaitingFreshTerminalAfterContinuation = false;
        terminalPublishEligible = true;
        contentStablePolls = 0;
        lastTerminalContent = '';
      }
      terminalSuccessSeen = true;
      boundAssistantId = terminal.assistantMessageId;
      let matched = assistantLocators.get(boundAssistantId) ?? null;
      if (!matched) {
        for (let index = 0; index < assistantCount; index++) {
          replyWait = loopOperationWaitMs(deadline, wallClock());
          if (replyWait <= 0) break;
          if (await serviceId(assistants.nth(index), () => loopOperationWaitMs(deadline, wallClock())) === boundAssistantId) {
            matched = assistants.nth(index);
            break;
          }
        }
      }
      if (matched && terminalPublishEligible) {
        replyWait = loopOperationWaitMs(deadline, wallClock());
        if (replyWait <= 0) break;
        const current = await boundedPlaywrightOperation(replyWait, () => assistantText(matched, replyWait)).catch(() => '');
        if (current) {
          if (!segments.length || segments[segments.length - 1] !== current) segments.push(current);
          const replyCandidate = continuationActive ? mergeContinuationSegments(segments) : current;
          if (current === lastTerminalContent) {
            contentStablePolls++;
            if (contentStablePolls >= 1) {
              const conversationId = normalizeConversationUrl(page.url());
              return {
                state: 'ok',
                cause: 'completed',
                possibleDelivery: true,
                userMessageId: userId,
                assistantMessageId: boundAssistantId,
                conversationId,
                reply: replyCandidate,
              };
            }
          } else {
            contentStablePolls = 0;
          }
          lastTerminalContent = current;
        }
      }
    }

    if (wall.state) {
      return {
        state: 'recovery_required',
        cause: `profile_wall:${wall.state}`,
        possibleDelivery: true,
        userMessageId: userId,
        ...(boundAssistantId ? { assistantMessageId: boundAssistantId } : {}),
      };
    }
    replyWait = loopOperationWaitMs(deadline, wallClock());
    if (replyWait <= 0) break;
    await witnessPollDelay(page, Math.min(750, replyWait));
  }

  if (terminalSuccessSeen) {
    return {
      state: 'stream_timeout',
      cause: 'terminal_content_incomplete',
      possibleDelivery: true,
      userMessageId: userId,
      ...(boundAssistantId ? { assistantMessageId: boundAssistantId } : {}),
    };
  }
  const finalStatusSource = () => loopOperationWaitMs(deadline, wallClock());
  if (resolveOperationWaitMs(finalStatusSource) > 0) {
    try {
      const statusText = (await productStatusText(page, finalStatusSource)).text;
      if (/error generating|something went wrong|unable to generate/i.test(statusText)) {
        return { state: 'no_reply', cause: 'terminal_no_reply_evidence', possibleDelivery: true, userMessageId: userId };
      }
    } catch (error) {
      if (!(error instanceof BrowserOperationTimeoutError)) throw error;
    }
  }
  if (process.env.CHATGPT_BROWSER_TURN_DEBUG === '1') {
    console.error(JSON.stringify({
      debug: 'no_terminal_evidence',
      userMessageId: userId,
      frameKinds: network.terminal.frames.map((frame) => frame.kind),
      terminalMessages: [...network.terminal.messages.entries()].map(([id, message]) => ({ id, role: message.role, parent: message.parent })),
      terminalMeta: [...network.terminal.terminalByMessageId.entries()].map(([id, meta]) => ({ id, ...meta })),
    }));
  }
  return { state: 'stream_timeout', cause: 'no_terminal_evidence', possibleDelivery: true, userMessageId: userId };
}
