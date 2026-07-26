import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { revalidateProcessDestinationReservations } from './coordination.ts';
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
  isCdpReachable(cdp: string): Promise<boolean>;
}

async function loadCdpOwnerModule(): Promise<CdpOwnerModule> {
  const modulePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../.claude/skills/discuss-with-gpt/verify-cdp-owner.mjs',
  );
  return await import(pathToFileURL(modulePath).href) as CdpOwnerModule;
}

export async function verifyProfile(config: BrowserConfig): Promise<ProfileVerification> {
  try {
    const mod = await loadCdpOwnerModule();
    const result = mod.verifyCdpProfile({ cdp: config.cdp, profile: config.profile });
    if (result?.ok) return { state: 'verified', cause: 'verified', evidence: String(result.message ?? result.reason ?? 'verified') };
    const reachable = await mod.isCdpReachable(config.cdp).catch(() => false);
    if (!reachable) return { state: 'unavailable', cause: 'chrome_not_running', evidence: 'cdp_unreachable' };
    return { state: 'mismatch', cause: String(result?.reason ?? 'owner_unverifiable'), evidence: String(result?.message ?? 'profile mismatch') };
  } catch (error) {
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

function wallClock(): number {
  return __testTiming.now?.() ?? Date.now();
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
  activeTurnUserId?: string;
  activePatchMessageId?: string;
  witnessTeardown?: () => Promise<void>;
  witnessInstall: Promise<void>;
  armDispatch(): void;
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

function applyStreamingPatchOperation(
  state: NetworkWitnessState,
  payload: Record<string, unknown>,
): void {
  const op = payload.o;
  if (op === 'add') {
    const value = payload.v as Record<string, unknown> | undefined;
    const message = value?.message as Record<string, unknown> | undefined;
    if (!message || typeof message.id !== 'string') return;
    const author = message.author as Record<string, unknown> | undefined;
    const role = author?.role;
    if (role !== 'user' && role !== 'assistant') return;
    ingestServicePayload(state.terminal, { type: 'delta', v: { message } });
    const parent = typeof message.parent === 'string' ? message.parent : undefined;
    state.messages.push({
      id: message.id,
      role,
      ...(parent ? { parent } : {}),
    });
    if (role === 'assistant') state.activePatchMessageId = message.id;
    return;
  }
  if (op !== 'patch' || !Array.isArray(payload.v)) return;
  const targetId = state.activePatchMessageId;
  if (!targetId || targetId.length < 8) return;
  const patchMessage: Record<string, unknown> = {
    id: targetId,
    author: { role: 'assistant' },
  };
  let touched = false;
  for (const item of payload.v) {
    const patch = item as Record<string, unknown>;
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

function ingestEncodedItemWitness(state: NetworkWitnessState, encodedItem: string): void {
  if (!encodedItem) return;
  state.messages.push(...parseStreamingBody(encodedItem));
  let streamEvent = '';
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
        applyStreamingPatchOperation(state, payload);
      } else {
        ingestServicePayload(state.terminal, payload);
        recursivelyCollectMessages(payload, state.messages);
        if (payload.type === 'input_message') {
          const input = payload.input_message as Record<string, unknown> | undefined;
          const id = typeof input?.id === 'string' ? input.id : '';
          const metadata = input?.metadata as Record<string, unknown> | undefined;
          const turnExchangeId = typeof metadata?.turn_exchange_id === 'string' ? metadata.turn_exchange_id : undefined;
          if (id) recordServiceSubmittedUserId(state, id, turnExchangeId);
        }
        if (payload.type === 'message_marker' && payload.marker === 'user_visible_token') {
          const assistantId = typeof payload.message_id === 'string' ? payload.message_id : '';
          if (assistantId && state.activeTurnUserId) {
            const observation = { id: assistantId, role: 'assistant' as const, parent: state.activeTurnUserId };
            state.messages.push(observation);
            registerLegacyObservation(state.terminal, observation);
            state.activePatchMessageId = assistantId;
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
}

function walkEncodedItemEnvelopes(state: NetworkWitnessState, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walkEncodedItemEnvelopes(state, item);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.encoded_item === 'string') ingestEncodedItemWitness(state, obj.encoded_item);
  for (const child of Object.values(obj)) walkEncodedItemEnvelopes(state, child);
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

  if (turnExchangeId && state.dispatchTurnExchangeId && turnExchangeId !== state.dispatchTurnExchangeId) {
    state.rejectedServiceUserIds.add(id);
    return;
  }

  if (state.dispatchCandidateIds.has(id)) {
    state.serviceSubmittedUserIds.add(id);
    state.messages.push({ id, role: 'user' });
    state.activeTurnUserId = id;
    state.provisionalServiceId = id;
    return;
  }

  const requestUserId = state.dispatchRequestUserId;
  const canCorrelateProvisional = Boolean(
    requestUserId
    && state.ingestingDispatchServiceFrames
    && state.dispatchCandidateIds.has(requestUserId)
    && !state.provisionalServiceId
    && id !== requestUserId
    && turnExchangeId
    && state.dispatchTurnExchangeId
    && turnExchangeId === state.dispatchTurnExchangeId,
  );
  if (canCorrelateProvisional) {
    state.provisionalServiceId = id;
    state.serviceSubmittedUserIds.add(id);
    state.messages.push({ id, role: 'user' });
    state.activeTurnUserId = id;
    return;
  }

  if (
    state.ingestingDispatchServiceFrames
    && state.dispatchCandidateIds.size === 0
    && state.serviceSubmittedUserIds.size === 0
    && turnExchangeId
    && state.dispatchTurnExchangeId
    && turnExchangeId === state.dispatchTurnExchangeId
  ) {
    state.serviceSubmittedUserIds.add(id);
    state.messages.push({ id, role: 'user' });
    state.activeTurnUserId = id;
    state.provisionalServiceId = id;
    return;
  }

  state.rejectedServiceUserIds.add(id);
}

function collectInputMessageWitness(state: NetworkWitnessState, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectInputMessageWitness(state, item);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj.type === 'input_message') {
    const input = obj.input_message as Record<string, unknown> | undefined;
    const id = typeof input?.id === 'string' ? input.id : '';
    const metadata = input?.metadata as Record<string, unknown> | undefined;
    const turnExchangeId = typeof metadata?.turn_exchange_id === 'string' ? metadata.turn_exchange_id : undefined;
    if (id) recordServiceSubmittedUserId(state, id, turnExchangeId);
  }
  const payload = obj.payload;
  if (payload && typeof payload === 'object') {
    const nested = (payload as Record<string, unknown>).payload;
    collectInputMessageWitness(state, nested ?? payload);
  }
  for (const child of Object.values(obj)) collectInputMessageWitness(state, child);
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

async function installWebSocketWitness(page: any, state: NetworkWitnessState): Promise<() => Promise<void>> {
  const teardowns: Array<() => Promise<void>> = [];
  const onPayload = (payloadData: string) => {
    ingestWebSocketWitnessPayload(state, payloadData);
  };

  if (typeof page.on === 'function') {
    const onWebSocket = (ws: { on: (event: string, handler: (frame: { payload?: string }) => void) => void }) => {
      ws.on('framereceived', (frame) => {
        onPayload(frame.payload ?? '');
      });
    };
    page.on('websocket', onWebSocket);
    teardowns.push(async () => {
      try {
        if (typeof page.off === 'function') page.off('websocket', onWebSocket);
      } catch { /* teardown best-effort; full page teardown is #1007 */ }
    });
  }

  const context = page.context?.();
  if (context && typeof context.newCDPSession === 'function') {
    try {
      const cdp = await Promise.race([
        context.newCDPSession(page),
        new Promise<null>((resolve) => { setTimeout(() => resolve(null), 5_000); }),
      ]);
      if (cdp) {
        await cdp.send('Network.enable');
        const onFrame = (event: { response?: { payloadData?: string } }) => {
          onPayload(event.response?.payloadData ?? '');
        };
        cdp.on('Network.webSocketFrameReceived', onFrame);
        teardowns.push(async () => {
          try {
            if (typeof cdp.off === 'function') cdp.off('Network.webSocketFrameReceived', onFrame);
            if (typeof cdp.detach === 'function') await cdp.detach();
          } catch { /* teardown best-effort; full page teardown is #1007 */ }
        });
      }
    } catch { /* CDP witness remains optional when Playwright websocket is available */ }
  }

  return async () => {
    await Promise.race([
      Promise.all(teardowns.map((teardown) => teardown())),
      new Promise<void>((resolve) => { setTimeout(resolve, 2_000); }),
    ]).catch(() => {});
  };
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
    armDispatch() { this.dispatchArmed = true; },
    witnessInstall: Promise.resolve(),
  };
  state.witnessInstall = installWebSocketWitness(page, state).then((teardown) => {
    state.witnessTeardown = teardown;
  }).catch(() => {});
  page.on('request', (request: any) => {
    try {
      if (!state.dispatchArmed || !state.ingestingDispatchServiceFrames) return;
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

async function serviceId(locator: any): Promise<string> {
  for (const attr of ['data-message-id', 'data-turn-id']) {
    const direct = await locator.getAttribute(attr).catch(() => null);
    if (direct && direct.length >= 8) return direct;
    const parent = locator.locator(`[${attr}]`).first();
    const nested = await parent.getAttribute(attr).catch(() => null);
    if (nested && nested.length >= 8) return nested;
  }
  return '';
}

async function parentServiceId(locator: any): Promise<string> {
  for (const attr of ['data-parent-message-id', 'data-parent-turn-id']) {
    const direct = await locator.getAttribute(attr).catch(() => null);
    if (direct && direct.length >= 8) return direct;
    const nested = await locator.locator(`[${attr}]`).first().getAttribute(attr).catch(() => null);
    if (nested && nested.length >= 8) return nested;
  }
  return '';
}

export async function runtimeWitnessSurfaceAvailable(page: any): Promise<boolean> {
  const messages = page.locator('[data-message-author-role]');
  const count = await messages.count().catch(() => 0);
  if (count === 0) return false;
  const userIds = new Set<string>();
  const assistantParents: string[] = [];
  for (let index = Math.max(0, count - 8); index < count; index++) {
    const locator = messages.nth(index);
    const role = await locator.getAttribute('data-message-author-role').catch(() => null);
    if (role === 'user') {
      const id = await serviceId(locator);
      if (id) userIds.add(id);
    } else if (role === 'assistant') {
      const id = await serviceId(locator);
      const parent = await parentServiceId(locator);
      if (id && parent) assistantParents.push(parent);
    }
  }
  if (assistantParents.some((parent) => userIds.has(parent))) return true;
  for (let index = Math.max(0, count - 8); index < count - 1; index++) {
    const locator = messages.nth(index);
    const next = messages.nth(index + 1);
    const role = await locator.getAttribute('data-message-author-role').catch(() => null);
    const nextRole = await next.getAttribute('data-message-author-role').catch(() => null);
    if (role !== 'user' || nextRole !== 'assistant') continue;
    const userId = await serviceId(locator);
    const turnStart = await next.getAttribute('data-turn-start-message').catch(() => null);
    if (userId && turnStart === 'true') return true;
  }
  return false;
}

export interface ProductStatusSurface {
  readonly text: string;
  readonly composer: boolean;
}

export async function productStatusText(page: any): Promise<ProductStatusSurface> {
  const composer = (await page.locator('#prompt-textarea').count().catch(() => 0)) > 0;
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
    const count = Math.min(await locator.count().catch(() => 0), 8);
    for (let index = 0; index < count; index++) {
      const text = await locator.nth(index).innerText().catch(() => '');
      if (text) parts.push(text);
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

async function pageWalls(page: any): Promise<{ state?: string; cause?: string }> {
  return classifyProductWall(await productStatusText(page));
}

async function semanticNodes(locator: any): Promise<SemanticNode[]> {
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
  }, SEMANTIC_UI_FILTER);
}

async function assistantText(locator: any): Promise<string> {
  return serializeSemanticNodes(await semanticNodes(locator));
}

async function observedDispatchUserIds(
  page: any,
  network: NetworkWitnessState,
  baselineIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const serviceIds = [...network.serviceSubmittedUserIds].filter((id) => !baselineIds.has(id));
  if (serviceIds.length === 1) return new Set(serviceIds);
  if (serviceIds.length > 1) return new Set(serviceIds);
  const observed = new Set<string>();
  if (network.dispatchCandidateIds.size === 0) return observed;
  const users = page.locator('[data-message-author-role="user"]');
  const count = await users.count().catch(() => 0);
  for (let index = Math.max(0, count - 8); index < count; index++) {
    const id = await serviceId(users.nth(index));
    if (id && !baselineIds.has(id) && network.dispatchCandidateIds.has(id)) observed.add(id);
  }
  for (const message of network.messages) {
    if (message.role === 'user' && !baselineIds.has(message.id) && network.dispatchCandidateIds.has(message.id)) {
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

export async function openTurnPage(browser: any, config: BrowserConfig): Promise<{ page: any; owned: boolean; provisionalId?: string }> {
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
      await matches[0].bringToFront().catch(() => {});
      return { page: matches[0], owned: false };
    }
    const page = await ctx.newPage();
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    if (normalizeConversationUrl(page.url()) !== target) {
      await page.close().catch(() => {});
      throw new Error('ui_contract_mismatch:conversation_redirect');
    }
    return { page, owned: true };
  }
  if (!config.projectUrl) throw new Error('ui_contract_mismatch:project_url_required');
  const page = await ctx.newPage();
  await page.goto(config.projectUrl, { waitUntil: 'domcontentloaded' });
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
): Promise<TurnBrowserResult> {
  const network = attachNetworkWitness(page);
  const releaseWitness = async () => {
    if (process.env.CHATGPT_BROWSER_TURN_AC3_TIMING_TEST === '1') {
      await witnessPollDelay(page, 2_000);
      return;
    }
    await Promise.race([
      network.witnessTeardown?.() ?? Promise.resolve(),
      new Promise<void>((resolve) => { setTimeout(resolve, 2_000); }),
    ]).catch(() => {});
  };
  try {
  const composer = page.locator('#prompt-textarea');
  const readyDeadline = Date.now() + Math.min(config.timeoutMs, 30_000);
  while (Date.now() < readyDeadline) {
    const wall = await pageWalls(page);
    if (wall.state) return { state: wall.state as TurnBrowserResult['state'], cause: wall.cause!, possibleDelivery: false };
    if (await composer.count().catch(() => 0)) break;
    await witnessPollDelay(page, 500);
  }
  if (!(await composer.count().catch(() => 0))) {
    return { state: 'ui_contract_mismatch', cause: 'composer_unavailable', possibleDelivery: false };
  }

  const role = '[data-message-author-role]';
  const baseline = page.locator(role);
  const baselineIds = new Set<string>();
  for (let index = 0, count = await baseline.count(); index < count; index++) {
    const id = await serviceId(baseline.nth(index));
    if (id) baselineIds.add(id);
  }

  await composer.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
  const send = page.locator('[data-testid="send-button"]');
  const sendAvailable = (await send.count()) > 0;
  revalidateProcessDestinationReservations();
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
  await Promise.race([
    network.witnessInstall,
    new Promise<void>((resolve) => { setTimeout(resolve, 10_000); }),
  ]);
  network.armDispatch();
  try {
    network.ingestingDispatchServiceFrames = true;
    if (sendAvailable) await send.click();
    else await page.keyboard.press('Enter');
    network.turnDispatchCommitted = true;
  } catch {
    network.ingestingDispatchServiceFrames = false;
    return { state: 'recovery_required', cause: 'dispatch_exception_after_possible_delivery_boundary', possibleDelivery: true };
  }

  let userId = '';
  const deliveredDeadline = wallClock() + 30_000;
  while (wallClock() < deliveredDeadline && !userId) {
    if (network.dispatchExchangeAmbiguous) {
      return { state: 'foreign_activity', cause: 'submitted_turn_ambiguous', possibleDelivery: true };
    }
    const canonicalEarly = canonicalSubmittedUserId(network, baselineIds);
    if (!canonicalEarly && network.dispatchCandidateIds.size > 1) {
      return { state: 'foreign_activity', cause: 'submitted_turn_ambiguous', possibleDelivery: true };
    }
    const observed = await observedDispatchUserIds(page, network, baselineIds);
    if (observed.size > 1) return { state: 'foreign_activity', cause: 'submitted_turn_ambiguous', possibleDelivery: true };
    userId = observed.values().next().value ?? '';
    if (!userId) await witnessPollDelay(page, 250);
  }
  network.ingestingDispatchServiceFrames = false;
  if (!userId) return { state: 'recovery_required', cause: 'submitted_turn_id_unproven', possibleDelivery: true };
  userId = canonicalSubmittedUserId(network, baselineIds) || userId;

  const segments: string[] = [];
  let boundAssistantId = '';
  let terminalSuccessSeen = false;
  let contentStablePolls = 0;
  let lastTerminalContent = '';
  let continuationActive = false;
  let awaitingFreshTerminalAfterContinuation = false;
  let terminalPublishEligible = true;
  const deadline = Date.now() + config.timeoutMs;
  while (Date.now() < deadline) {
    const wall = await pageWalls(page);
    const canonicalUserIdEarly = canonicalSubmittedUserId(network, baselineIds);
    if (!canonicalUserIdEarly && network.dispatchCandidateIds.size > 1) {
      return { state: 'foreign_activity', cause: 'submitted_turn_ambiguous', possibleDelivery: true, userMessageId: userId };
    }
    const observedDispatch = await observedDispatchUserIds(page, network, baselineIds);
    const canonicalUserId = canonicalSubmittedUserId(network, baselineIds);
    if (canonicalUserId) userId = canonicalUserId;
    if (observedDispatch.size > 1) {
      return { state: 'foreign_activity', cause: 'submitted_turn_ambiguous', possibleDelivery: true, userMessageId: userId };
    }
    if (observedDispatch.size === 1 && !observedDispatch.has(userId)) {
      return { state: 'foreign_activity', cause: 'submitted_turn_witness_changed', possibleDelivery: true, userMessageId: userId };
    }

    const users = page.locator('[data-message-author-role="user"]');
    const newUserIds = new Set<string>();
    for (let index = 0, count = await users.count(); index < count; index++) {
      const id = await serviceId(users.nth(index));
      if (id && !baselineIds.has(id)) newUserIds.add(id);
    }
    if ([...newUserIds].some((id) => id !== userId)) {
      return { state: 'foreign_activity', cause: 'unexpected_user_turn', possibleDelivery: true, userMessageId: userId };
    }

    const assistants = page.locator('[data-message-author-role="assistant"]');
    const assistantLocators = new Map<string, any>();
    for (let index = 0, count = await assistants.count(); index < count; index++) {
      const locator = assistants.nth(index);
      const id = await serviceId(locator);
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

    const cont = page.getByText(/continue generating/i);
    if (await cont.count().catch(() => 0)) {
      let continuationLocator: any = null;
      if (boundAssistantId) {
        continuationLocator = assistantLocators.get(boundAssistantId) ?? null;
      }
      if (!continuationLocator) {
        for (let index = 0, count = await assistants.count(); index < count; index++) {
          const locator = assistants.nth(index);
          const id = await serviceId(locator);
          if (id && isMessageAttributedToUserTurn(id, userId, network.terminal.messages)) {
            continuationLocator = locator;
            break;
          }
        }
      }
      if (continuationLocator) {
        const current = await assistantText(continuationLocator).catch(() => '');
        if (current && (!segments.length || segments[segments.length - 1] !== current)) segments.push(current);
        await cont.first().click().catch(() => {});
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
        for (let index = 0, count = await assistants.count(); index < count; index++) {
          if (await serviceId(assistants.nth(index)) === boundAssistantId) {
            matched = assistants.nth(index);
            break;
          }
        }
      }
      if (matched && terminalPublishEligible) {
        const current = await assistantText(matched).catch(() => '');
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
    await witnessPollDelay(page, 750);
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
  const statusText = (await productStatusText(page)).text;
  if (/error generating|something went wrong|unable to generate/i.test(statusText)) {
    return { state: 'no_reply', cause: 'terminal_no_reply_evidence', possibleDelivery: true, userMessageId: userId };
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
  } finally {
    await releaseWitness();
  }
}
