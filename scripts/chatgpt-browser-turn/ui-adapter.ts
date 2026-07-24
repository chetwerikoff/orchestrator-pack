import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  mergeContinuationSegments,
  SEMANTIC_UI_FILTER,
  serializeSemanticNodes,
  type SemanticNode,
} from './semantic.ts';

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
  url.hash = ''; url.search = '';
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
  if (Array.isArray(value)) { for (const item of value) recursivelyCollectMessages(item, out, inheritedConversation); return; }
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

function attachNetworkWitness(page: any): { messages: NetworkMessage[]; attached: boolean } {
  const state = { messages: [] as NetworkMessage[], attached: true };
  page.on('response', async (response: any) => {
    try {
      const url = String(response.url());
      if (!/conversation|messages|responses/i.test(url)) return;
      const body = await response.text();
      state.messages.push(...parseStreamingBody(body));
    } catch { /* response may be streaming/opaque; DOM witness remains available */ }
  });
  return state;
}

async function serviceId(locator: any): Promise<string> {
  for (const attr of ['data-message-id','data-turn-id']) {
    const direct = await locator.getAttribute(attr).catch(() => null);
    if (direct && direct.length >= 8) return direct;
    const parent = locator.locator(`[${attr}]`).first();
    const nested = await parent.getAttribute(attr).catch(() => null);
    if (nested && nested.length >= 8) return nested;
  }
  return '';
}

async function parentServiceId(locator: any): Promise<string> {
  for (const attr of ['data-parent-message-id','data-parent-turn-id']) {
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
  for (let i = Math.max(0, count - 8); i < count; i++) {
    const locator = messages.nth(i);
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
  return assistantParents.some((parent) => userIds.has(parent));
}

async function pageWalls(page: any): Promise<{ state?: string; cause?: string }> {
  const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 20000);
  if (/verify you are human|checking your browser|just a moment|unusual activity/i.test(text)) return { state: 'challenge', cause: 'challenge_detected' };
  if (/you(?:'|’)ve reached|usage limit|message limit|reached the current usage|please try again later/i.test(text)) return { state: 'quota', cause: 'quota_detected' };
  const composer = await page.locator('#prompt-textarea').count().catch(() => 0);
  if (!composer && /log in|sign in/i.test(text)) return { state: 'login', cause: 'login_required' };
  return {};
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

export interface TurnBrowserResult {
  state: 'ok'|'quota'|'challenge'|'login'|'stream_timeout'|'send_failed'|'no_reply'|'ui_contract_mismatch'|'foreign_activity'|'recovery_required'|'orphaned_fresh_turn';
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
    const matches = ctx.pages().filter((p: any) => {
      try { return normalizeConversationUrl(p.url()) === target; } catch { return false; }
    });
    if (matches.length > 1) throw new Error('ui_contract_mismatch:duplicate_tabs');
    if (matches.length === 1) { await matches[0].bringToFront().catch(() => {}); return { page: matches[0], owned: false }; }
    const page = await ctx.newPage();
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    if (normalizeConversationUrl(page.url()) !== target) { await page.close().catch(() => {}); throw new Error('ui_contract_mismatch:conversation_redirect'); }
    return { page, owned: true };
  }
  if (!config.projectUrl) throw new Error('ui_contract_mismatch:project_url_required');
  const page = await ctx.newPage();
  await page.goto(config.projectUrl, { waitUntil: 'domcontentloaded' });
  return { page, owned: true, provisionalId: crypto.randomUUID() };
}

export async function sendTurn(
  page: any,
  text: string,
  config: BrowserConfig,
  provisionalId?: string,
  onBeforeSend?: () => void | Promise<void>,
): Promise<TurnBrowserResult> {
  const network = attachNetworkWitness(page);
  const composer = page.locator('#prompt-textarea');
  const readyDeadline = Date.now() + Math.min(config.timeoutMs, 30_000);
  while (Date.now() < readyDeadline) {
    const wall = await pageWalls(page);
    if (wall.state) return { state: wall.state as TurnBrowserResult['state'], cause: wall.cause!, possibleDelivery: false };
    if (await composer.count().catch(() => 0)) break;
    await page.waitForTimeout(500);
  }
  if (!(await composer.count().catch(() => 0))) {
    return { state: 'ui_contract_mismatch', cause: 'composer_unavailable', possibleDelivery: false };
  }

  const role = '[data-message-author-role]';
  const baseline = page.locator(role);
  const baselineIds = new Set<string>();
  for (let i = 0, n = await baseline.count(); i < n; i++) { const id = await serviceId(baseline.nth(i)); if (id) baselineIds.add(id); }

  await composer.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
  const send = page.locator('[data-testid="send-button"]');
  await onBeforeSend?.();
  try { if (await send.count()) await send.click(); else await page.keyboard.press('Enter'); }
  catch { return { state: 'recovery_required', cause: 'dispatch_exception_after_possible_delivery_boundary', possibleDelivery: true }; }

  let userId = '';
  const deliveredDeadline = Date.now() + 30_000;
  while (Date.now() < deliveredDeadline && !userId) {
    const observed = new Set<string>();
    const users = page.locator('[data-message-author-role="user"]');
    for (let i = Math.max(0, (await users.count()) - 4); i < await users.count(); i++) {
      const id = await serviceId(users.nth(i));
      if (id && !baselineIds.has(id)) observed.add(id);
    }
    for (const message of network.messages) {
      if (message.role === 'user' && !baselineIds.has(message.id)) observed.add(message.id);
    }
    if (observed.size > 1) return { state: 'foreign_activity', cause: 'submitted_turn_ambiguous', possibleDelivery: true };
    userId = observed.values().next().value ?? '';
    if (!userId) await page.waitForTimeout(250);
  }
  if (!userId) return { state: 'recovery_required', cause: 'submitted_turn_id_unproven', possibleDelivery: true };

  const segments: string[] = [];
  let assistantId = '';
  let stable = 0;
  let last = '';
  const deadline = Date.now() + config.timeoutMs;
  while (Date.now() < deadline) {
    const wall = await pageWalls(page);
    const users = page.locator('[data-message-author-role="user"]');
    const newUserIds: string[] = [];
    for (let i = 0, n = await users.count(); i < n; i++) { const id = await serviceId(users.nth(i)); if (id && !baselineIds.has(id)) newUserIds.push(id); }
    if (new Set(newUserIds).size > 1) return { state: 'foreign_activity', cause: 'unexpected_user_turn', possibleDelivery: true, userMessageId: userId };

    const assistants = page.locator('[data-message-author-role="assistant"]');
    const observations: CausalMessageObservation[] = [];
    const assistantLocators = new Map<string, any>();
    for (let i = 0, n = await assistants.count(); i < n; i++) {
      const loc = assistants.nth(i);
      const id = await serviceId(loc);
      if (!id || baselineIds.has(id)) continue;
      const parent = await parentServiceId(loc);
      observations.push({ id, role: 'assistant', ...(parent ? { parent } : {}) });
      assistantLocators.set(id, loc);
    }
    for (const message of network.messages) {
      if (message.role === 'assistant' && !baselineIds.has(message.id)) observations.push(message);
    }
    const causal = resolveCausalAssistant(userId, observations);
    if (causal.state === 'ambiguous') {
      return { state: 'foreign_activity', cause: 'assistant_causal_ambiguity', possibleDelivery: true, userMessageId: userId };
    }
    let matched: any = null;
    if (causal.state === 'matched') {
      assistantId = causal.assistantMessageId;
      matched = assistantLocators.get(assistantId) ?? null;
      if (!matched) {
        for (let i = 0, n = await assistants.count(); i < n; i++) {
          if (await serviceId(assistants.nth(i)) === assistantId) { matched = assistants.nth(i); break; }
        }
      }
    }
    if (matched) {
      const current = await assistantText(matched).catch(() => '');
      if (current) {
        if (!segments.length || segments[segments.length - 1] !== current) segments.push(current);
        const busy = (await page.locator('[data-testid="stop-button"]').count().catch(() => 0)) > 0;
        const cont = page.getByText(/continue generating/i);
        if (await cont.count().catch(() => 0)) { await cont.first().click().catch(() => {}); stable = 0; }
        else if (!busy && current === last) { stable++; if (stable >= 2) {
          const conversationId = normalizeConversationUrl(page.url());
          return { state: 'ok', cause: 'completed', possibleDelivery: true, userMessageId: userId, assistantMessageId: assistantId,
            conversationId, reply: mergeContinuationSegments(segments) };
        } } else stable = 0;
        last = current;
      }
    }
    if (wall.state) return { state: 'recovery_required', cause: `profile_wall:${wall.state}`, possibleDelivery: true, userMessageId: userId, ...(assistantId ? { assistantMessageId: assistantId } : {}) };
    await page.waitForTimeout(750);
  }

  if (assistantId || last) return { state: 'stream_timeout', cause: 'deadline_before_terminal_stability', possibleDelivery: true, userMessageId: userId, ...(assistantId ? { assistantMessageId: assistantId } : {}) };
  const body = await page.locator('body').innerText().catch(() => '');
  if (/error generating|something went wrong|unable to generate/i.test(body)) return { state: 'no_reply', cause: 'terminal_no_reply_evidence', possibleDelivery: true, userMessageId: userId };
  return { state: 'stream_timeout', cause: 'no_terminal_evidence', possibleDelivery: true, userMessageId: userId };
}
