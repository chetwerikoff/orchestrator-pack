// @vitest-ci-lane light
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadChromium } from './ui-adapter-base.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectCdpBrowser } from './browser-session.ts';
import { attachOwnTarget, countUninspectedRecoveryTargets, getOwnTargetInfo } from './own-target-attach.ts';
import { takeRecoveryCensus, type PostSendRecoveryAdapter } from './state-light-turn-recovery.ts';

const CDP = 'http://127.0.0.1:9222';
const CHAT = 'https://chatgpt.com/c/26252625-2625-4625-8625-262526252625';
const FOREIGN = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';
const NativeWebSocket = globalThis.WebSocket;

type Target = { id: string; type: string; url: string };
let targets: Target[];
let targetCounter: number;
let chromeCommands: Array<Record<string, any>>;

type Listener = (event: { data?: unknown }) => void;
class FakeChromeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly sockets: FakeChromeSocket[] = [];
  readonly url: string;
  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeChromeSocket.sockets.push(this);
    queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); });
  }

  addEventListener(type: string, listener: Listener, _options?: unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitProtocol(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) });
  }

  send(text: string): void {
    const command = JSON.parse(text) as Record<string, any>;
    chromeCommands.push(command);
    queueMicrotask(() => {
      if (this.readyState !== 1) return;
      if (command.method === 'Target.attachToTarget') {
        const target = targets.find((candidate) => candidate.id === command.params?.targetId);
        if (target) {
          this.emitProtocol({
            method: 'Target.attachedToTarget',
            params: { sessionId: 'session-' + target.id, targetInfo: {
              targetId: target.id, type: target.type, url: target.url,
            }, waitingForDebugger: false },
          });
        }
        this.emitProtocol({ id: command.id, result: { sessionId: 'session-' + command.params.targetId } });
      } else if (command.method === 'Target.getTargets') {
        this.emitProtocol({ id: command.id, result: { targetInfos: targets.map((target) => ({
          targetId: target.id, type: target.type, url: target.url,
        })) } });
      } else if (command.method === 'Target.createTarget') {
        const id = 'successor-' + ++targetCounter;
        const target = { id, type: 'page', url: command.params.url ?? 'about:blank' };
        targets.push(target);
        this.emitProtocol({ method: 'Target.targetCreated', params: { targetInfo: {
          targetId: id, type: 'page', url: target.url,
        } } });
        this.emitProtocol({ id: command.id, result: { targetId: id } });
      } else if (command.method === 'Page.navigate') {
        const target = targets.find((candidate) => 'session-' + candidate.id === command.sessionId);
        if (target) target.url = command.params.url;
        this.emitProtocol({ id: command.id, sessionId: command.sessionId, result: { frameId: 'owned-frame' } });
      } else if (command.method === 'Runtime.evaluate') {
        this.emitProtocol({ id: command.id, sessionId: command.sessionId,
          result: { result: { type: 'string', value: 'owned page' } } });
      } else {
        this.emitProtocol({ id: command.id, ...(command.sessionId ? { sessionId: command.sessionId } : {}), result: {} });
      }
    });
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', {}));
  }
}

function setupChrome(known: readonly Target[]): void {
  targets = [...known];
  targetCounter = 0;
  chromeCommands = [];
  FakeChromeSocket.sockets.length = 0;
  vi.stubGlobal('WebSocket', FakeChromeSocket);
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string, options?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/json/list') return new Response(JSON.stringify(targets), { status: 200 });
    if (url.pathname === '/json/version') {
      return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://fake-chrome/devtools/browser/1' }), { status: 200 });
    }
    if (url.pathname === '/json/new' && options?.method === 'PUT') {
      const id = 'created-' + ++targetCounter;
      const newTarget = { id, type: 'page', url: 'about:blank' };
      targets.push(newTarget);
      return new Response(JSON.stringify(newTarget), { status: 200 });
    }
    throw new Error('unexpected HTTP CDP endpoint: ' + url);
  }));
}

// A protocol-level Playwright equivalent: it performs the CDP handshake over
// a real masked client WebSocket, awaits Target.attachedToTarget, then exercises
// Page.navigate, Runtime.evaluate and Target.createTarget on the returned Page.
// Chrome upstream is a deterministic protocol peer, not a browser fixture.
function protocolChromium() {
  const seenEvents: Record<string, any>[] = [];
  const clientSockets: WebSocket[] = [];
  const connectOverCDP = vi.fn(async (endpoint: string): Promise<any> => {
    const client = new NativeWebSocket(endpoint);
    clientSockets.push(client);
    const pending = new Map<number, (data: any) => void>();
    let nextId = 0;
    const pages = new Map<string, any>();
    let onAttached: (() => void) | undefined;

    const send = (method: string, params: Record<string, unknown>, sessionId?: string): Promise<any> => {
      const id = ++nextId;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        client.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    };
    client.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, any>;
      seenEvents.push(message);
      if (message.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo } = message.params;
        const targetId = targetInfo.targetId as string;
        pages.set(targetId, {
          url: () => targets.find((target) => target.id === targetId)?.url ?? 'about:blank',
          goto: async (url: string) => {
            const result = await send('Page.navigate', { url }, sessionId);
            if (result.error) throw new Error(result.error.message);
          },
          title: async () => {
            const result = await send('Runtime.evaluate', { expression: 'document.title' }, sessionId);
            return result.result?.result?.value;
          },
          close: async () => { await send('Target.closeTarget', { targetId }); },
          isClosed: () => false,
        });
        onAttached?.();
      }
      if (typeof message.id === 'number') pending.get(message.id)?.(message);
      if (typeof message.id === 'number') pending.delete(message.id);
    });
    await new Promise<void>((resolve, reject) => {
      client.addEventListener('open', () => resolve(), { once: true });
      client.addEventListener('error', () => reject(new Error('fake playwright socket failed')), { once: true });
    });
    const initial = send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    });
    await initial;
    if (pages.size === 0) await new Promise<void>((resolve) => { onAttached = resolve; });
    const visible = await send('Target.getTargets', {});
    if (visible.result.targetInfos.length !== 1) throw new Error('foreign target visible to client');
    return {
      contexts: () => [{ pages: () => [...pages.values()], newPage: async () => {
        const previous = pages.size;
        const created = await send('Target.createTarget', { url: 'about:blank' });
        if (created.error) throw new Error(created.error.message);
        if (pages.size === previous) await new Promise<void>((resolve) => { onAttached = resolve; });
        return pages.get(created.result.targetId);
      } }],
      close: async () => {
        if (client.readyState !== NativeWebSocket.OPEN) return;
        await new Promise<void>((resolve) => {
          client.addEventListener('close', () => resolve(), { once: true });
          client.close();
        });
      },
      isConnected: () => client.readyState === NativeWebSocket.OPEN,
    };
  });
  return { connectOverCDP, seenEvents, clientSockets };
}

beforeEach(() => setupChrome([{ id: 'foreign-id', type: 'page', url: FOREIGN }]));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Issue #2625 own-target attach isolation', () => {
  it('adapts a marked legacy Vitest Page fixture without Chrome HTTP and retains newPage spy counts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const page = { __fakeBrowserGptPage: true, url: () => CHAT };
    const context: any = { newPage: vi.fn(async () => page) };
    const browser = { contexts: () => [context], close: vi.fn(async () => undefined) };
    const chromium = { connectOverCDP: vi.fn(async () => browser) };

    const attached = await attachOwnTarget(chromium, {
      mode: 'own-target', cdp: CDP, deadlineMs: Date.now() + 3_000,
      newChat: false, chatUrl: CHAT,
    });
    expect(attached.page).toBe(page);
    expect(attached.created).toBe(true);
    expect(attached.attachAttempts).toBe(1);
    expect(context.newPage).toHaveBeenCalledTimes(1);
    expect(context.pages()).toEqual([page]);
    expect(getOwnTargetInfo(browser)?.targetId).toBe(attached.targetId);
    expect(chromium.connectOverCDP).toHaveBeenCalledWith(CDP, { timeout: 30_000 });

    const unmarked = { contexts: () => [{ newPage: vi.fn(async () => ({ url: () => CHAT })) }],
      close: vi.fn(async () => undefined) };
    await expect(attachOwnTarget({ connectOverCDP: vi.fn(async () => unmarked) }, {
      mode: 'own-target', cdp: CDP, deadlineMs: Date.now() + 3_000,
      newChat: false, chatUrl: CHAT,
    })).rejects.toThrow('unit_fixture_page_not_fake');
    expect(unmarked.close).toHaveBeenCalledTimes(1);
  });

  it('preserves synthetic pre-Send page selection then restores the legacy recovery census', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const owned = { __fakeBrowserGptPage: true, url: () => CHAT };
    const unrelated = { url: () => FOREIGN };
    const context = {
      newPage: vi.fn(async () => owned),
      pages: vi.fn(() => [owned, unrelated]),
    };
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => undefined) };
    const chromium = { connectOverCDP: vi.fn(async () => browser) };
    const attached = await attachOwnTarget(chromium, {
      mode: 'own-target', cdp: CDP, deadlineMs: Date.now() + 3_000, newChat: true,
    });
    expect(attached.page).toBe(owned);
    expect(context.pages()).toEqual([owned]);
    expect(context.pages()).toEqual([owned]);
    expect(context.pages()).toEqual([owned, unrelated]);
    expect(context.newPage).toHaveBeenCalledTimes(1);
    expect(getOwnTargetInfo(browser)?.created).toBe(true);
  });

  it('bounds pending synthetic newPage and disposes a late-created page without touching foreign pages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    let resolvePage!: (page: any) => void;
    const pending = new Promise<any>((resolve) => { resolvePage = resolve; });
    const foreign = { close: vi.fn(async () => undefined) };
    const late = { close: vi.fn(async () => undefined), goto: vi.fn(async () => undefined) };
    const context = { newPage: vi.fn(() => pending), pages: vi.fn(() => [foreign]) };
    const browser = { contexts: vi.fn(() => [context]), close: vi.fn(async () => undefined) };
    const chromium = { connectOverCDP: vi.fn(async () => browser) };
    await expect(attachOwnTarget(chromium, {
      mode: 'own-target', cdp: CDP, deadlineMs: Date.now() + 30,
      newChat: true, cleanupBudgetMs: 2_000,
    })).rejects.toThrow('browser_operation_timeout:new_page');
    expect(context.newPage).toHaveBeenCalledTimes(1);
    resolvePage(late);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(late.goto).not.toHaveBeenCalled();
    expect(foreign.close).not.toHaveBeenCalled();
  });

  it('initializes and navigates only the owned Page while a foreign tab remains untouched', async () => {
    const chromium = protocolChromium();
    const attached = await attachOwnTarget(chromium, {
      mode: 'own-target', cdp: CDP, deadlineMs: Date.now() + 10_000,
      newChat: true, cleanupBudgetMs: 2_000,
    });
    expect(attached.created).toBe(true);
    expect(attached.attachAttempts).toBe(1);
    await attached.page.goto(CHAT);
    expect(await attached.page.title()).toBe('owned page');
    const originalId = attached.targetId;
    expect(getOwnTargetInfo(attached.browser)?.targetId).toBe(originalId);

    const fakeChrome = FakeChromeSocket.sockets.at(-1)!;
    fakeChrome.emitProtocol({ method: 'Target.targetCreated', params: { targetInfo: {
      targetId: 'new-foreign-id', type: 'page', url: FOREIGN,
    } } });
    await Promise.resolve();

    const second = await attached.browser.contexts()[0].newPage();
    expect(await second.title()).toBe('owned page');
    const owned = getOwnTargetInfo(attached.browser)!;
    expect(owned.successorTargetIds).toHaveLength(1);
    expect(chromeCommands.filter((command) => command.method === 'Target.attachToTarget')
      .map((command) => command.params.targetId)).toEqual([originalId, ...owned.successorTargetIds]);
    expect(chromeCommands.some((command) => command.method === 'Target.setAutoAttach'
      || command.method === 'Target.detachFromTarget')).toBe(false);
    expect(chromeCommands.every((command) => command.params?.targetId !== 'foreign-id'
      && command.params?.targetId !== 'new-foreign-id')).toBe(true);
    expect(chromium.seenEvents.some((event) => JSON.stringify(event).includes('new-foreign-id'))).toBe(false);
    expect(targets.find((target) => target.id === 'foreign-id')?.url).toBe(FOREIGN);
    await attached.browser.close();
    expect(fakeChrome.readyState).toBe(FakeChromeSocket.CLOSED);
  });

  it('selects a single matching existing conversation target, not a same-profile foreign tab', async () => {
    setupChrome([
      { id: 'foreign-id', type: 'page', url: FOREIGN },
      { id: 'existing-id', type: 'page', url: CHAT + '/' },
    ]);
    const chromium = protocolChromium();
    const attached = await attachOwnTarget(chromium, {
      mode: 'own-target', cdp: CDP, deadlineMs: Date.now() + 10_000,
      newChat: false, chatUrl: CHAT,
    });
    expect(attached.created).toBe(false);
    expect(attached.targetId).toBe('existing-id');
    expect(attached.page.url()).toBe(CHAT + '/');
    expect(getOwnTargetInfo(attached.browser)?.created).toBe(false);
    expect(chromeCommands.filter((command) => command.method === 'Target.attachToTarget')
      .map((command) => command.params.targetId)).toEqual(['existing-id']);
    await attached.browser.close();
  });

  it('fails closed on duplicate same-conversation targets before any WebSocket attach', async () => {
    setupChrome([
      { id: 'one', type: 'page', url: CHAT },
      { id: 'two', type: 'page', url: CHAT + '/' },
    ]);
    const chromium = protocolChromium();
    await expect(attachOwnTarget(chromium, {
      mode: 'own-target', cdp: CDP, deadlineMs: Date.now() + 3_000,
      newChat: false, chatUrl: CHAT,
    })).rejects.toThrow('ambiguous_conversation_targets');
    expect(chromium.connectOverCDP).not.toHaveBeenCalled();
    expect(chromeCommands).toEqual([]);
  });

  it('pins the initial target ID through two transient pre-Send attach failures', async () => {
    const protocol = protocolChromium();
    let attempt = 0;
    const chromium = {
      connectOverCDP: vi.fn(async (endpoint: string) => {
        attempt++;
        if (attempt < 3) throw new Error('ECONNRESET');
        return protocol.connectOverCDP(endpoint);
      }),
    };
    const attached = await attachOwnTarget(chromium, {
      mode: 'own-target', cdp: CDP, deadlineMs: Date.now() + 10_000,
      newChat: true, cleanupBudgetMs: 2_000,
    });
    expect(attached.attachAttempts).toBe(3);
    expect(targets.filter((target) => target.id.startsWith('created-'))).toHaveLength(1);
    expect(FakeChromeSocket.sockets.slice(0, 2).every((socket) => socket.readyState === 3)).toBe(true);
    await attached.browser.close();
  });

  it('terminates after three failed pre-Send attempts with numeric attempt evidence', async () => {
    const chromium = { connectOverCDP: vi.fn(async () => { throw new Error('ECONNRESET'); }) };
    const error = await attachOwnTarget(chromium, {
      mode: 'own-target', cdp: CDP, deadlineMs: Date.now() + 10_000,
      newChat: true, cleanupBudgetMs: 2_000,
    }).then(() => undefined, (cause: Error & { attachAttempts?: number }) => cause);
    expect(error?.attachAttempts).toBe(3);
    expect(chromium.connectOverCDP).toHaveBeenCalledTimes(3);
    expect(FakeChromeSocket.sockets.every((socket) => socket.readyState === 3)).toBe(true);
  });

  it('does not retry post-Send attach and refuses lost pinned targets', async () => {
    setupChrome([{ id: 'owned-id', type: 'page', url: CHAT }]);
    const chromium = { connectOverCDP: vi.fn(async () => { throw new Error('ECONNRESET'); }) };
    const error = await attachOwnTarget(chromium, {
      mode: 'own-target', cdp: CDP, deadlineMs: Date.now() + 10_000,
      newChat: false, chatUrl: CHAT, pinnedTargetId: 'owned-id', postSend: true,
    }).then(() => undefined, (cause: Error & { attachAttempts?: number }) => cause);
    expect(error?.attachAttempts).toBe(1);
    expect(chromium.connectOverCDP).toHaveBeenCalledTimes(1);
    targets = [];
    await expect(attachOwnTarget(chromium, {
      mode: 'own-target', cdp: CDP, deadlineMs: Date.now() + 10_000,
      newChat: false, chatUrl: CHAT, pinnedTargetId: 'owned-id', postSend: true,
    })).rejects.toThrow('own_target_lost');
    expect(chromium.connectOverCDP).toHaveBeenCalledTimes(1);
  });

  it('leaves a filtered recovery census incomplete for a hidden same-chat target', async () => {
    setupChrome([
      { id: 'owned-id', type: 'page', url: CHAT },
      { id: 'hidden-foreign-id', type: 'page', url: CHAT },
    ]);
    expect(await countUninspectedRecoveryTargets(CDP, ['owned-id'], CHAT, Date.now() + 3_000)).toBe(1);
    const ownedPage = {};
    const read = vi.fn(async () => ({ messages: [{ role: 'user' as const, text: 'owned-marker' }], incomplete: false }));
    const adapter: PostSendRecoveryAdapter = {
      enumeratePages: async () => [ownedPage],
      uninspectedPotentialPages: async () => countUninspectedRecoveryTargets(
        CDP, ['owned-id'], CHAT, Date.now() + 3_000,
      ),
      pageUrl: () => CHAT,
      normalizeConversationUrl: (value) => value,
      isSupportedConversationUrl: (value) => value === CHAT,
      readAuthoritativeMessages: read,
      browserDefinitelyDisconnected: () => false,
      pageDefinitelyLost: () => false,
      reconnect: async () => ({}),
      createSuccessor: async () => ({}),
      sleep: async () => undefined,
      now: Date.now,
    };
    const census = await takeRecoveryCensus({}, 'owned-marker', adapter, CHAT);
    expect(census.complete).toBe(false);
    expect(census.incompleteReason).toBe('enumeration_failed');
    expect(census.pages).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps the fifth legacy CDP call unfiltered and retries only transport errors', async () => {
    const chromium = { connectOverCDP: vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ legacy: true }) };
    const result = await connectCdpBrowser(chromium, CDP);
    expect(result).toEqual({ legacy: true });
    expect(chromium.connectOverCDP).toHaveBeenCalledTimes(3);
    expect(chromium.connectOverCDP.mock.calls.every((args: any[]) => args[0] === CDP)).toBe(true);
    expect(FakeChromeSocket.sockets).toHaveLength(0);
  });
});


// Real-client regression for AC3. Unlike protocolChromium(), this launches a
// separate Chrome and uses the installed playwright-core Chromium client.
// The pack intentionally does not package operator-local playwright-core or
// Chrome: require the test explicitly in that environment by setting
// OPK_REQUIRE_REAL_CDP_TEST=1 (absence then fails, never silently skips).
const liveChromium = (() => {
  try { return loadChromium(); } catch { return undefined; }
})();
const chromeExecutable = [
  process.env.OPK_TEST_CHROME_BIN,
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((candidate) => Boolean(candidate && existsSync(candidate)));
const requireRealCdp = process.env.OPK_REQUIRE_REAL_CDP_TEST === '1';

it.skipIf(!requireRealCdp && (!liveChromium || !chromeExecutable))(
  'uses real Playwright against the proxy while an independent client runs foreign JavaScript',
  async () => {
    if (!liveChromium || !chromeExecutable) {
      throw new Error('real CDP regression requires installed playwright-core and Chrome');
    }

    // A fresh isolated process avoids touching the shared automation profile.
    const profile = mkdtempSync(join(tmpdir(), 'opk-real-cdp-'));
    const chrome = spawn(chromeExecutable, [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check',
      '--remote-allow-origins=*', '--remote-debugging-port=0',
      '--user-data-dir=' + profile, 'about:blank',
    ], { stdio: 'ignore' });
    chrome.on('error', () => {});
    let independent: any;
    let owned: Awaited<ReturnType<typeof attachOwnTarget>> | undefined;
    let reconnected: Awaited<ReturnType<typeof attachOwnTarget>> | undefined;
    try {
      const activePortFile = join(profile, 'DevToolsActivePort');
      let port = 0;
      for (let i = 0; i < 80; i++) {
        if (existsSync(activePortFile)) {
          const candidate = Number(readFileSync(activePortFile, 'utf8').split(/\r?\n/u)[0]);
          if (Number.isInteger(candidate) && candidate > 0) { port = candidate; break; }
        }
        if (chrome.exitCode !== null) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      if (!port) throw new Error('headless Chrome did not expose a CDP port');
      const endpoint = 'http://127.0.0.1:' + port;

      vi.unstubAllGlobals();
      independent = await liveChromium.connectOverCDP(endpoint, { timeout: 8_000 });
      const independentContext = independent.contexts()[0];
      const foreignBefore = await independentContext.newPage();
      await foreignBefore.goto('data:text/html,<title>foreign-before</title>');
      const targetIdOf = async (page: any): Promise<string> => {
        const session = await independentContext.newCDPSession(page);
        try {
          const result = await session.send('Target.getTargetInfo');
          return result.targetInfo.targetId as string;
        } finally {
          await session.detach();
        }
      };

      // Include Chrome's pre-existing blank page as foreign, too.
      const beforeTargets = await (await fetch(endpoint + '/json/list')).json() as
        Array<{ id: string; type: string }>;
      const foreignIds = new Set(beforeTargets.filter((target) => target.type === 'page')
        .map((target) => target.id));
      const foreignBeforeId = await targetIdOf(foreignBefore);
      expect(foreignIds.has(foreignBeforeId)).toBe(true);

      type Command = {
        method?: string;
        sessionId?: string;
        params?: Record<string, any>;
      };
      const forwarded: Command[] = [];
      const withheld: Command[] = [];
      const sessionTarget = new Map<string, string>();
      const neverReply = new Set(['Page.enable', 'Page.getFrameTree', 'Runtime.enable']);
      class ObservedBackendWebSocket extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener('message', (event) => {
            const message = JSON.parse(String(event.data)) as {
              method?: string;
              params?: { sessionId?: string; targetInfo?: { targetId?: string } };
            };
            if (message.method === 'Target.attachedToTarget'
              && message.params?.sessionId && message.params.targetInfo?.targetId) {
              sessionTarget.set(message.params.sessionId, message.params.targetInfo.targetId);
            }
          });
        }

        override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
          const command = JSON.parse(String(data)) as Command;
          forwarded.push(command);
          // An attempted foreign session initialization would never answer:
          // Playwright must not need or issue one for a protected own-page attach.
          if (command.sessionId
            && foreignIds.has(sessionTarget.get(command.sessionId) ?? '')
            && neverReply.has(command.method ?? '')) {
            withheld.push(command);
            return;
          }
          super.send(data);
        }
      }
      vi.stubGlobal('WebSocket', ObservedBackendWebSocket);

      owned = await attachOwnTarget(liveChromium, {
        mode: 'own-target', cdp: endpoint, deadlineMs: Date.now() + 12_000,
        cleanupBudgetMs: 2_000, newChat: true,
      });
      expect(owned.attachAttempts).toBe(1);
      expect(owned.created).toBe(true);
      expect(owned.browser.contexts()).toHaveLength(1);
      expect(owned.browser.contexts()[0].pages()).toHaveLength(1);
      await owned.page.goto('data:text/html,<title>protected-own</title>');
      expect(await owned.page.title()).toBe('protected-own');

      // Real BrowserContext.newPage() must remain available after bootstrap.
      const successor = await owned.browser.contexts()[0].newPage();
      await successor.goto('data:text/html,<title>protected-successor</title>');
      expect(await successor.title()).toBe('protected-successor');
      expect(getOwnTargetInfo(owned.browser)?.successorTargetIds).toHaveLength(1);
      await successor.close();

      // This page is created by a different, independently connected client
      // AFTER the protected connection is live. Its JS must execute normally.
      const foreignDuring = await independentContext.newPage();
      const foreignDuringId = await targetIdOf(foreignDuring);
      foreignIds.add(foreignDuringId);
      await foreignDuring.goto('data:text/html,<title>foreign-during</title>');
      expect(await foreignDuring.evaluate('globalThis.__opkForeignExecuted = 4242')).toBe(4242);
      expect(await foreignDuring.evaluate('globalThis.__opkForeignExecuted')).toBe(4242);
      expect(await foreignBefore.title()).toBe('foreign-before');
      expect(foreignDuring.isClosed()).toBe(false);

      const pinned = owned.targetId;
      await owned.browser.close();
      owned = undefined;
      reconnected = await attachOwnTarget(liveChromium, {
        mode: 'own-target', cdp: endpoint, deadlineMs: Date.now() + 12_000,
        cleanupBudgetMs: 2_000, newChat: false, pinnedTargetId: pinned,
        postSend: true,
      });
      expect(reconnected.targetId).toBe(pinned);
      expect(await reconnected.page.title()).toBe('protected-own');
      expect(await foreignDuring.evaluate('globalThis.__opkForeignExecuted')).toBe(4242);

      expect(withheld).toEqual([]);
      // The real client may request browser-level metadata, but the protected
      // proxy must never auto-attach, detach, or send page commands to foreign IDs.
      expect(forwarded.filter((command) => command.method === 'Target.setAutoAttach')).toEqual([]);
      expect(forwarded.filter((command) => command.method === 'Target.attachToTarget'
        && foreignIds.has(String(command.params?.targetId ?? '')))).toEqual([]);
      expect(forwarded.filter((command) => command.sessionId
        && foreignIds.has(sessionTarget.get(command.sessionId) ?? ''))).toEqual([]);
      expect(forwarded.filter((command) => command.method === 'Target.detachFromTarget'
        && foreignIds.has(sessionTarget.get(String(command.params?.sessionId ?? '')) ?? ''))).toEqual([]);
      expect(forwarded.filter((command) => command.method === 'Target.closeTarget'
        && foreignIds.has(String(command.params?.targetId ?? '')))).toEqual([]);
      expect(await foreignBefore.title()).toBe('foreign-before');
      expect(await foreignDuring.title()).toBe('foreign-during');
    } finally {
      await reconnected?.browser.close().catch(() => {});
      await owned?.browser.close().catch(() => {});
      await independent?.close().catch(() => {});
      vi.unstubAllGlobals();
      if (chrome.exitCode === null) {
        const exited = new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
        chrome.kill('SIGTERM');
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
        if (chrome.exitCode === null) chrome.kill('SIGKILL');
      }
      rmSync(profile, { recursive: true, force: true });
    }
  },
  35_000,
);
