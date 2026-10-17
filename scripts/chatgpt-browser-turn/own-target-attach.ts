import {
  createOwnCdpTarget,
  listCdpPageTargets,
  OwnTargetCdpProxy,
  type CdpPageTarget,
} from './own-target-cdp-proxy.ts';

export interface CdpChromium {
  connectOverCDP(endpoint: string, options?: { timeout?: number }): Promise<any>;
}

export interface OwnTargetAttachOptions {
  readonly mode: 'own-target';
  readonly cdp: string;
  readonly deadlineMs: number;
  readonly cleanupBudgetMs?: number;
  /** Existing chat must be an exact conversation URL. */
  readonly chatUrl?: string;
  readonly newChat: boolean;
  /** Trusted exact ID from this invocation; never reselect by URL on reconnect. */
  readonly pinnedTargetId?: string;
  /** Post-Send reconnect is one observation-only attach, never an attach retry. */
  readonly postSend?: boolean;
}

export interface OwnTargetAttachResult {
  readonly browser: any;
  readonly page: any;
  readonly targetId: string;
  readonly created: boolean;
  readonly attachAttempts: number;
}

export interface AttachAttemptError extends Error {
  readonly attachAttempts: number;
}

interface AttachedConnection {
  readonly proxy: OwnTargetCdpProxy;
  readonly initialTargetId: string;
  readonly created: boolean;
}

const connections = new WeakMap<object, AttachedConnection>();
const TRANSIENT = /timeout|timed out|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|connection closed|websocket|cdp_proxy_backend|cdp_proxy_disconnected/iu;
const BACKOFF_MS = [150, 350] as const;

function deadlineRemaining(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

function waitMs(deadlineMs: number): number {
  return Math.min(30_000, deadlineRemaining(deadlineMs));
}

function asAttemptError(error: unknown, attempts: number): AttachAttemptError {
  const result = error instanceof Error ? error : new Error(String(error));
  Object.assign(result, { attachAttempts: attempts });
  return result as AttachAttemptError;
}

function exactConversationUrl(value: string): string {
  const url = new URL(value);
  if ((url.origin !== 'https://chatgpt.com' && url.origin !== 'https://chat.openai.com')
    || url.username || url.password
    || !/^\/(?:c\/[0-9a-f-]{36}|g\/g-p-[^/]+\/c\/[0-9a-f-]{36})\/?$/iu.test(url.pathname)) {
    throw new Error('ui_contract_mismatch:chat_not_found');
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/$/u, '');
}

function sameUrl(actual: string, expected: string): boolean {
  try { return exactConversationUrl(actual) === expected; }
  catch { return false; }
}

interface PinnedTarget {
  id: string;
  created: boolean;
  /** Identity of selected pre-existing target; a retry cannot import another. */
  initialUrl?: string;
}

async function selectTarget(options: OwnTargetAttachOptions): Promise<PinnedTarget> {
  const remaining = waitMs(options.deadlineMs);
  if (remaining <= 0) throw new Error('browser_operation_timeout:connect_over_cdp');
  const pages = await listCdpPageTargets(options.cdp, remaining);
  if (options.pinnedTargetId) {
    const pinned = pages.find((item) => item.id === options.pinnedTargetId);
    if (!pinned) throw new Error('ui_contract_mismatch:own_target_lost');
    if (options.chatUrl && !sameUrl(pinned.url, exactConversationUrl(options.chatUrl))) {
      throw new Error('ui_contract_mismatch:own_target_identity_changed');
    }
    return { id: pinned.id, created: false, initialUrl: pinned.url };
  }
  if (options.newChat) {
    return { id: await createOwnCdpTarget(options.cdp, waitMs(options.deadlineMs)), created: true };
  }
  if (!options.chatUrl) throw new Error('ui_contract_mismatch:target_required');
  const chatUrl = exactConversationUrl(options.chatUrl);
  const candidates = pages.filter((item) => sameUrl(item.url, chatUrl));
  if (candidates.length > 1) throw new Error('ui_contract_mismatch:ambiguous_conversation_targets');
  if (candidates.length === 1) {
    return { id: candidates[0]!.id, created: false, initialUrl: chatUrl };
  }
  // Zero existing candidates: create a dedicated, attributable page. Its
  // navigation and exact identity are checked by the caller before Send.
  return { id: await createOwnCdpTarget(options.cdp, waitMs(options.deadlineMs)), created: true };
}

async function revalidateTarget(options: OwnTargetAttachOptions, target: PinnedTarget): Promise<void> {
  const pages = await listCdpPageTargets(options.cdp, Math.max(1, waitMs(options.deadlineMs)));
  const current = pages.find((item) => item.id === target.id);
  if (!current) throw new Error('ui_contract_mismatch:own_target_lost');
  if (target.initialUrl) {
    if (options.chatUrl ? !sameUrl(current.url, exactConversationUrl(options.chatUrl))
      : current.url !== target.initialUrl) {
      throw new Error('ui_contract_mismatch:own_target_identity_changed');
    }
  } else if (target.created && current.url !== 'about:blank'
    && (!options.chatUrl || !sameUrl(current.url, exactConversationUrl(options.chatUrl)))) {
    throw new Error('ui_contract_mismatch:own_target_identity_changed');
  }
}

function onlyAllowedPage(browser: any): any {
  const contexts = browser.contexts();
  if (!Array.isArray(contexts) || contexts.length !== 1
    || typeof contexts[0]?.pages !== 'function') {
    throw new Error('ui_contract_mismatch:context_count');
  }
  const pages = contexts[0].pages();
  if (!Array.isArray(pages) || pages.length !== 1 || pages[0]?.isClosed?.() === true) {
    throw new Error('ui_contract_mismatch:own_page_unavailable');
  }
  return pages[0];
}

async function waitForSettled(promise: Promise<any>, budgetMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), budgetMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function abortAttempt(input: {
  readonly browser?: any;
  readonly pendingConnect?: Promise<any>;
  readonly proxy?: OwnTargetCdpProxy;
  readonly cleanupBudgetMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + input.cleanupBudgetMs;
  // Tear down the proxy before any backoff, so even a late Playwright connect
  // cannot retain an active foreign/session transport.
  try {
    if (input.proxy) await input.proxy.dispose(Math.max(1, deadlineRemaining(deadline)));
    if (input.browser) {
      const close = Promise.resolve().then(() => input.browser.close());
      if (!(await waitForSettled(close, Math.max(1, deadlineRemaining(deadline))))) return false;
    }
    if (input.pendingConnect
      && !(await waitForSettled(input.pendingConnect, Math.max(1, deadlineRemaining(deadline))))) {
      return false;
    }
    return deadlineRemaining(deadline) > 0;
  } catch {
    return false;
  }
}

export async function attachOwnTarget(
  chromium: CdpChromium,
  options: OwnTargetAttachOptions,
): Promise<OwnTargetAttachResult> {
  // All target discovery/allocation occurs before Playwright bootstrap.
  let selected: PinnedTarget;
  try { selected = await selectTarget(options); }
  catch (error) { throw asAttemptError(error, 0); }
  const maxAttempts = options.postSend ? 1 : 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let proxy: OwnTargetCdpProxy | undefined;
    let browser: any;
    let connect: Promise<any> | undefined;
    let retire = false;
    try {
      await revalidateTarget(options, selected);
      if (waitMs(options.deadlineMs) <= 0) {
        throw new Error('browser_operation_timeout:connect_over_cdp');
      }
      proxy = await OwnTargetCdpProxy.open(options.cdp, [selected.id],
        selected.created ? [selected.id] : [], waitMs(options.deadlineMs));
      connect = chromium.connectOverCDP(proxy.endpoint, { timeout: waitMs(options.deadlineMs) });
      connect.then((late) => {
        if (retire) void Promise.resolve().then(() => late.close()).catch(() => {});
      }, () => {});
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        browser = await Promise.race([
          connect,
          new Promise<never>((_, reject) => {
            connectTimer = setTimeout(
              () => reject(new Error('browser_operation_timeout:connect_over_cdp')),
              Math.max(1, waitMs(options.deadlineMs)),
            );
          }),
        ]);
      } finally {
        if (connectTimer) clearTimeout(connectTimer);
      }
      const page = onlyAllowedPage(browser);
      const actual = String(page.url());
      if (selected.initialUrl && options.chatUrl
        && !sameUrl(actual, exactConversationUrl(options.chatUrl))) {
        throw new Error('ui_contract_mismatch:own_target_identity_changed');
      }
      connections.set(browser, { proxy, initialTargetId: selected.id, created: selected.created });
      const close = browser.close.bind(browser);
      let closed = false;
      browser.close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        try { await close(); }
        finally { await proxy!.dispose(options.cleanupBudgetMs ?? 5_000); }
      };
      return { browser, page, targetId: selected.id, created: selected.created, attachAttempts: attempt };
    } catch (error) {
      retire = true;
      lastError = error;
      const disposed = await abortAttempt({
        browser, pendingConnect: connect, proxy,
        cleanupBudgetMs: Math.min(options.cleanupBudgetMs ?? 5_000, deadlineRemaining(options.deadlineMs)),
      });
      if (!disposed) throw asAttemptError(new Error('browser_operation_timeout:connect_cleanup_unconfirmed'), attempt);
      if (attempt === maxAttempts || !TRANSIENT.test(error instanceof Error ? error.message : String(error))) {
        throw asAttemptError(error, attempt);
      }
      const backoff = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[1];
      if (deadlineRemaining(options.deadlineMs) <= backoff) {
        throw asAttemptError(new Error('browser_operation_timeout:connect_over_cdp'), attempt);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw asAttemptError(lastError, maxAttempts);
}

export async function connectWithLegacyRetry(
  chromium: CdpChromium, cdp: string, timeoutMs: number,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await chromium.connectOverCDP(cdp, { timeout: Math.max(1, deadlineRemaining(deadline)) });
    } catch (error) {
      last = error;
      if (!TRANSIENT.test(error instanceof Error ? error.message : String(error))
        || attempt === 3 || deadlineRemaining(deadline) <= (BACKOFF_MS[attempt - 1] ?? 350)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, BACKOFF_MS[attempt - 1] ?? 350));
    }
  }
  throw last;
}

export function getOwnTargetInfo(browser: unknown): {
  readonly targetId: string;
  readonly created: boolean;
  readonly successorTargetIds: readonly string[];
} | undefined {
  if (!browser || typeof browser !== 'object') return undefined;
  const record = connections.get(browser);
  if (!record) return undefined;
  return {
    targetId: record.initialTargetId,
    created: record.created,
    successorTargetIds: [...record.proxy.createdTargetIds].filter((id) => id !== record.initialTargetId),
  };
}

export async function countUninspectedRecoveryTargets(
  cdp: string,
  ownIds: readonly string[],
  conversationUrl: string | undefined,
  deadlineMs: number,
): Promise<number> {
  const candidates: CdpPageTarget[] = await listCdpPageTargets(cdp, Math.max(1, waitMs(deadlineMs)));
  return candidates.filter((candidate) => {
    if (ownIds.includes(candidate.id)) return false;
    if (conversationUrl) return sameUrl(candidate.url, exactConversationUrl(conversationUrl));
    // Without a bound fresh conversation, all ChatGPT conversation pages could
    // carry this invocation's marker. URL metadata cannot establish absence.
    return /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\/(?:c\/|g\/[^/]+\/c\/)/iu.test(candidate.url);
  }).length;
}
