import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import assert from 'node:assert/strict';
import { describe, expect, it, test, vi } from 'vitest';

import {
  __testConversationPageSelection,
  __testFinalizeTurn,
  __testPublishStateLightReply,
  __testSendDelivery,
  type CompactTurnResult,
  recordChatBindings,
  runStateLightTurn,
} from './state-light-turn.ts';
import { BEFORE_CDP_BROWSER_RELEASE, releaseCdpBrowser } from './browser-session.ts';
import { parsePackReviewPreflightArgs, runPackReviewPreflight, runStateLightEntry } from './state-light-entry.ts';
import { readChatBinding } from './chat-bindings.ts';
import { configuredProfileKey } from './storage-common.ts';
import { admitStateLightTurnObservation, transitionStateLightTurnObservation } from './state-light-turn-observation.ts';
import { TURN_STATES } from './contracts.ts';
import { COMPOSER_SELECTOR, loadChromium, SEND_BUTTON_SELECTOR } from './ui-adapter.ts';
import { fakeTurnPage } from './fixtures/fake-turn-page.ts';
import {
  buildBrowserTurnCancellationReceipt,
  cancelOwnedGenerationFromReceipt,
  EXPLICIT_CANCELLATION_AUTHORITY,
  isSupportedChatGptConversationUrl,
  stopOwnedGeneration,
} from './state-light-cancellation.ts';
import {
  runPostSendRecovery,
  type PostSendRecoveryState,
} from './state-light-turn-recovery.ts';

type CleanupCase = {
  readonly id: string;
  readonly sendCount: number;
  readonly publicationState?: 'committed_ok' | 'conflict' | 'error';
  readonly pagePresent: boolean;
  readonly pageLost: boolean;
  readonly expected: 'close' | 'preserve' | 'skip';
};

const cleanupCases: readonly CleanupCase[] = [
  { id: 'K1', sendCount: 1, publicationState: 'committed_ok', pagePresent: true, pageLost: false, expected: 'close' },
  { id: 'K2', sendCount: 1, publicationState: 'committed_ok', pagePresent: true, pageLost: true, expected: 'skip' },
  { id: 'K3', sendCount: 1, publicationState: 'conflict', pagePresent: true, pageLost: false, expected: 'preserve' },
  { id: 'K4', sendCount: 1, publicationState: 'committed_ok', pagePresent: true, pageLost: false, expected: 'close' },
  { id: 'K5', sendCount: 1, pagePresent: true, pageLost: false, expected: 'preserve' },
  { id: 'K6', sendCount: 1, publicationState: 'error', pagePresent: true, pageLost: false, expected: 'preserve' },
  { id: 'K7', sendCount: 0, pagePresent: true, pageLost: false, expected: 'close' },
  { id: 'K8', sendCount: 1, pagePresent: true, pageLost: false, expected: 'preserve' },
  { id: 'K9', sendCount: 0, pagePresent: false, pageLost: true, expected: 'skip' },
  { id: 'K10', sendCount: 1, pagePresent: false, pageLost: true, expected: 'skip' },
  { id: 'K11', sendCount: 1, pagePresent: true, pageLost: false, expected: 'preserve' },
  { id: 'K12', sendCount: 1, publicationState: 'committed_ok', pagePresent: true, pageLost: false, expected: 'close' },
  { id: 'K13', sendCount: 1, pagePresent: true, pageLost: false, expected: 'preserve' },
  { id: 'K14', sendCount: 1, pagePresent: true, pageLost: false, expected: 'preserve' },
  { id: 'K15', sendCount: 1, pagePresent: false, pageLost: true, expected: 'skip' },
  { id: 'K16', sendCount: 1, publicationState: 'error', pagePresent: true, pageLost: false, expected: 'preserve' },
  { id: 'K17', sendCount: 1, publicationState: 'committed_ok', pagePresent: true, pageLost: false, expected: 'close' },
  { id: 'K18', sendCount: 0, pagePresent: true, pageLost: false, expected: 'close' },
  { id: 'K19', sendCount: 1, publicationState: 'committed_ok', pagePresent: true, pageLost: false, expected: 'close' },
  { id: 'K20', sendCount: 1, pagePresent: true, pageLost: false, expected: 'preserve' },
];

const ledgerCases = [
  { id: 'L1', transition: 'reserved page identity enters the final partition', sendCount: 1, publicationState: 'committed_ok' as const, pagePresent: true, pageLost: false, expectedCleanup: 'confirmed' as const, expectedPageCloseCalls: 1 },
  { id: 'L2', transition: 'unsupported takeover retains the owned page', sendCount: 1, pagePresent: true, pageLost: false, expectedCleanup: 'skipped' as const, expectedPageCloseCalls: 0 },
  { id: 'L3', transition: 'zero-send terminal closes the reserved page', sendCount: 0, pagePresent: true, pageLost: false, expectedCleanup: 'confirmed' as const, expectedPageCloseCalls: 1 },
  { id: 'L4', transition: 'publication is the close boundary', sendCount: 1, publicationState: 'committed_ok' as const, pagePresent: true, pageLost: false, expectedCleanup: 'confirmed' as const, expectedPageCloseCalls: 1 },
  { id: 'L5', transition: 'publication survives cleanup failure', sendCount: 1, publicationState: 'committed_ok' as const, pagePresent: true, pageLost: false, closeError: true, expectedCleanup: 'unconfirmed' as const, expectedPageCloseCalls: 1 },
  { id: 'L6', transition: 'post-send non-publication preserves the page', sendCount: 1, publicationState: 'conflict' as const, pagePresent: true, pageLost: false, expectedCleanup: 'skipped' as const, expectedPageCloseCalls: 0 },
  { id: 'L7', transition: 'production graph enumerates page and browser sinks', sendCount: 1, publicationState: 'committed_ok' as const, pagePresent: true, pageLost: false, expectedCleanup: 'confirmed' as const, expectedPageCloseCalls: 1 },
  { id: 'L8', transition: 'helper termination leaves publication observable', sendCount: 1, pagePresent: true, pageLost: false, expectedCleanup: 'skipped' as const, expectedPageCloseCalls: 0 },
  { id: 'L9', transition: 'probe remains read-only while the page is retained', sendCount: 1, pagePresent: true, pageLost: false, expectedCleanup: 'skipped' as const, expectedPageCloseCalls: 0 },
  { id: 'L10', transition: 'browser release remains observable after page action', sendCount: 0, pagePresent: true, pageLost: false, expectedCleanup: 'confirmed' as const, expectedPageCloseCalls: 1 },
] as const;

type FinalizerCase = {
  readonly sendCount: number;
  readonly publicationState?: 'committed_ok' | 'conflict' | 'error';
  readonly pagePresent: boolean;
  readonly pageLost: boolean;
  readonly closeError?: boolean;
  readonly beforePageClose?: () => void;
};

function makeTurnResult(overrides: Partial<Omit<CompactTurnResult, 'cleanup'>> = {}): Omit<CompactTurnResult, 'cleanup'> {
  return {
    schema: 'turn-result/v1',
    state: 'ok',
    scope: 'none',
    cause: 'completed',
    invocation_id: '123e4567-e89b-12d3-a456-426614174099',
    configured_profile_key: 'profile-1238-fixture',
    send_count: 0,
    poll_count: 0,
    goto_count: 0,
    new_chat_click_count: 0,
    navigation_count: 0,
    incidents: [],
    ...overrides,
  };
}

async function observeFinalizer(testCase: FinalizerCase) {
  let pageCloseCalls = 0;
  let browserCloseCalls = 0;
  let foreignTargetOpen = true;
  const page = testCase.pagePresent
    ? {
      close: async () => {
        testCase.beforePageClose?.();
        pageCloseCalls++;
        if (testCase.closeError) throw new Error('fixture_page_close_failed');
      },
      isClosed: () => testCase.pageLost,
    }
    : undefined;
  const browser = {
    close: async () => {
      expect(foreignTargetOpen).toBe(true);
      browserCloseCalls++;
    },
    isConnected: () => true,
  };
  const result = await __testFinalizeTurn({
    result: makeTurnResult({ send_count: testCase.sendCount }),
    page,
    browser,
    publicationState: testCase.publicationState,
  });
  return { result, pageCloseCalls, browserCloseCalls, foreignTargetOpen };
}

describe('Issue #2353 continuation tab bootstrap', () => {
  const chatUrl = 'https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614172353';
  const config = {
    cdp: 'http://127.0.0.1:9222',
    profile: 'fixture-profile',
    chatUrl,
    newChat: false,
    timeoutMs: 5_000,
  } as const;
  const operationBudget = { clampOperationWaitMs: () => 1_000 } as any;

  it('opens a missing conversation target and the selected page can send', async () => {
    const turnPage = fakeTurnPage();
    turnPage.page.url = () => chatUrl;
    const initialBrowser = {
      contexts: () => [],
      close: vi.fn(async () => undefined),
    };
    const reconnectedBrowser = {
      contexts: () => [{ pages: () => [turnPage.page] }],
      close: vi.fn(async () => undefined),
    };
    const chromium = {
      connectOverCDP: vi.fn(async () => reconnectedBrowser),
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(String(input)).toBe(`http://127.0.0.1:9222/json/new?${encodeURIComponent(chatUrl)}`);
      expect(init?.method).toBe('PUT');
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'issue-2353-page', type: 'page', url: chatUrl }),
      } as Response;
    });

    try {
      const selected = await __testConversationPageSelection.selectConversationPage(
        initialBrowser,
        chromium,
        config,
        operationBudget,
      );
      expect(selected.page).toBe(turnPage.page);
      expect(selected.browser).toBe(reconnectedBrowser);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(initialBrowser.close).toHaveBeenCalledTimes(1);
      expect(chromium.connectOverCDP).toHaveBeenCalledTimes(1);

      const delivery = await __testSendDelivery.dispatchStateLightSendAndObserveDelivery({
        page: selected.page,
        browser: selected.browser,
        composer: selected.page.locator(COMPOSER_SELECTOR),
        sendButton: selected.page.locator(SEND_BUTTON_SELECTOR),
        hasSendButton: true,
        marker: 'issue-2353-owned-prompt',
        baselineUserNodeCount: 0,
        sendWaitMs: 1_000,
        invocationDeadlineMs: Date.now() + 5_000,
        deliveryProofWaitMs: 1_000,
      });
      expect(delivery.sendCount).toBe(1);
      expect(turnPage.getSendClicks()).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('reuses an already-open matching conversation without opening a second target', async () => {
    const turnPage = fakeTurnPage();
    turnPage.page.url = () => chatUrl;
    const initialBrowser = {
      contexts: () => [{ pages: () => [turnPage.page] }],
      close: vi.fn(async () => undefined),
    };
    const chromium = {
      connectOverCDP: vi.fn(async () => {
        throw new Error('unexpected reconnect');
      }),
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    try {
      const selected = await __testConversationPageSelection.selectConversationPage(
        initialBrowser,
        chromium,
        config,
        operationBudget,
      );
      expect(selected.page).toBe(turnPage.page);
      expect(selected.browser).toBe(initialBrowser);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(initialBrowser.close).not.toHaveBeenCalled();
      expect(chromium.connectOverCDP).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('Issue #1238 page cleanup equivalence', () => {
  it.each(cleanupCases)('$id observes the production finalizer', async (testCase) => {
    const observed = await observeFinalizer(testCase);
    expect(observed.result.cleanup).toBe(testCase.expected === 'close' ? 'confirmed' : 'skipped');
    expect(observed.result.send_count).toBe(testCase.sendCount);
    expect(observed.pageCloseCalls).toBe(testCase.expected === 'close' ? 1 : 0);
    expect(observed.browserCloseCalls).toBe(1);
    expect(observed.foreignTargetOpen).toBe(true);
  });

  it.each(ledgerCases)('$id observes the authority transition: $transition', async (testCase) => {
    const observed = await observeFinalizer(testCase);
    expect(observed.result.cleanup).toBe(testCase.expectedCleanup);
    expect(observed.result.send_count).toBe(testCase.sendCount);
    expect(observed.pageCloseCalls).toBe(testCase.expectedPageCloseCalls);
    expect(observed.browserCloseCalls).toBe(1);
    expect(observed.foreignTargetOpen).toBe(true);
  });
});

describe('Issue #1238 publication boundary', () => {
  const liveCdpEndpoint = process.env.OPK_1238_LIVE_CDP;

  it.skipIf(!liveCdpEndpoint)('characterizes live CDP release without closing foreign targets', async () => {
    const endpoint = liveCdpEndpoint;
    if (!endpoint) throw new Error('OPK_1238_LIVE_CDP is required for live characterization');
    const chromium = loadChromium();
    let browser: any;
    let reconnected: any;
    let foreign: any;
    try {
      try {
        browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
      } catch (error) {
        throw new Error(`live CDP unavailable at ${endpoint}: ${String(error)}`);
      }
      const contexts = browser.contexts();
      if (contexts.length !== 1) throw new Error(`live CDP context contract failed: ${contexts.length}`);
      const context = contexts[0];
      foreign = await context.newPage();
      const foreignUrl = 'about:blank#issue-1238-foreign';
      await foreign.goto(foreignUrl);
      const owned = await context.newPage();
      const beforeRelease = context.pages().map((page: any) => String(page.url())).sort();
      expect(beforeRelease).toContain(foreignUrl);
      await owned.close();
      await releaseCdpBrowser(browser);
      browser = undefined;

      reconnected = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
      const afterRelease = reconnected.contexts()[0].pages().map((page: any) => String(page.url()));
      expect(afterRelease).toContain(foreignUrl);
    } finally {
      if (foreign && reconnected) {
        await foreign.close().catch(() => {});
        foreign = undefined;
      }
      await releaseCdpBrowser(reconnected);
      await releaseCdpBrowser(browser);
    }
  });

  it('observes exact final bytes before the real retained-page close', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-1238-publish-'));
    const output = join(root, 'reply.txt');
    const reply = 'exact reply bytes\\nПривет 🌍';
    try {
      const publication = __testPublishStateLightReply(output, '123e4567-e89b-12d3-a456-426614174000', reply);
      expect(publication.state).toBe('committed_ok');
      const observed = await observeFinalizer({
        sendCount: 1,
        publicationState: publication.state,
        pagePresent: true,
        pageLost: false,
        beforePageClose: () => expect(readFileSync(output, 'utf8')).toBe(reply),
      });
      expect(observed.result.cleanup).toBe('confirmed');
      expect(observed.pageCloseCalls).toBe(1);
      expect(observed.browserCloseCalls).toBe(1);
      expect(observed.foreignTargetOpen).toBe(true);
      expect(publication.output_bytes).toBe(Buffer.byteLength(reply, 'utf8'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not authorize close when final-link publication conflicts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-1238-conflict-'));
    const output = join(root, 'reply.txt');
    writeFileSync(output, 'foreign winner', 'utf8');
    try {
      const publication = __testPublishStateLightReply(output, '123e4567-e89b-12d3-a456-426614174001', 'reply');
      expect(publication.state).toBe('conflict');
      const observed = await observeFinalizer({
        sendCount: 1,
        publicationState: publication.state,
        pagePresent: true,
        pageLost: false,
      });
      expect(observed.result.cleanup).toBe('skipped');
      expect(observed.pageCloseCalls).toBe(0);
      expect(observed.browserCloseCalls).toBe(1);
      expect(observed.foreignTargetOpen).toBe(true);
      expect(readFileSync(output, 'utf8')).toBe('foreign winner');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps cleanup and browser release subordinate to committed output', async () => {
    let browserCloseCalls = 0;
    let foreignTabOpen = true;
    await releaseCdpBrowser({
      close: async () => {
        browserCloseCalls++;
        expect(foreignTabOpen).toBe(true);
      },
    });
    expect(browserCloseCalls).toBe(1);
    expect(foreignTabOpen).toBe(true);
    foreignTabOpen = false;
  });

  it('publishes before a real cleanup failure and keeps the result authoritative', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-1238-cleanup-failure-'));
    const output = join(root, 'reply.txt');
    const reply = 'published before cleanup failure';
    try {
      const publication = __testPublishStateLightReply(output, '123e4567-e89b-12d3-a456-426614174002', reply);
      const observed = await observeFinalizer({
        sendCount: 1,
        publicationState: publication.state,
        pagePresent: true,
        pageLost: false,
        closeError: true,
        beforePageClose: () => expect(readFileSync(output, 'utf8')).toBe(reply),
      });
      expect(observed.result.cleanup).toBe('unconfirmed');
      expect(observed.result.incidents).toContain('owned_tab_cleanup_failed');
      expect(observed.pageCloseCalls).toBe(1);
      expect(observed.browserCloseCalls).toBe(1);
      expect(observed.foreignTargetOpen).toBe(true);
      expect(readFileSync(output, 'utf8')).toBe(reply);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drives the committed publication boundary through the production entrypoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-1238-entrypoint-'));
    const input = join(root, 'prompt.txt');
    const output = join(root, 'reply.txt');
    const reply = 'production entrypoint publication';
    const chatUrl = 'https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174003';
    vi.stubEnv('HOME', join(root, 'home'));
    writeFileSync(input, 'prompt', 'utf8');
    let pageCloseCalls = 0;
    let browserCloseCalls = 0;
    let foreignTargetOpen = true;
    const page = {
      close: async () => {
        pageCloseCalls++;
      },
      isClosed: () => false,
    };
    const browser = {
      close: async () => {
        expect(foreignTargetOpen).toBe(true);
        browserCloseCalls++;
      },
      isConnected: () => true,
    };
    const publication = __testPublishStateLightReply(
      output,
      '123e4567-e89b-12d3-a456-426614174003',
      reply,
    );
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const exitCode = await runStateLightEntry([
        'turn',
        '--profile', join(root, 'profile'),
        '--cdp', 'http://127.0.0.1:9222',
        '--input', input,
        '--output', output,
        '--chat-url', chatUrl,
        '--timeout-ms', '1000',
        '--poll-ms', '1',
      ], {
        runTurn: (argv, options) => {
          expect(options).toMatchObject({ entryLivenessHeartbeat: true, recordChatBinding: true });
          return runStateLightTurn(argv, {
            ...options,
            runTurn: async () => ({
              result: makeTurnResult({ send_count: 1, conversation_id: chatUrl }),
              page,
              browser,
              publicationState: publication.state,
            }),
          });
        },
      });
      const result = JSON.parse(writes.at(-1) ?? '{}') as CompactTurnResult;
      expect(exitCode).toBe(0);
      expect(result.cleanup).toBe('confirmed');
      expect(result.send_count).toBe(1);
      expect(pageCloseCalls).toBe(1);
      expect(browserCloseCalls).toBe(1);
      expect(readFileSync(output, 'utf8')).toBe(reply);
      expect(readChatBinding(chatUrl)?.worktree).toBe(process.cwd());
    } finally {
      foreignTargetOpen = true;
      stdout.mockRestore();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Issue #2340 early chat binding', () => {
  it('binds a fresh chat from the cancellation receipt before the turn result', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-2340-binding-'));
    const chatUrl = 'https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174040';
    vi.stubEnv('HOME', join(root, 'home'));
    vi.stubEnv('XDG_STATE_HOME', join(root, 'isolated-agent-state'));
    try {
      recordChatBindings(`${JSON.stringify({
        schema: 'browser-turn-cancellation-receipt/v1',
        invocation_id: 'inv-2340',
        configured_profile_key: 'profile',
        conversation_url: chatUrl,
        marker: 'marker',
        send_count: 1,
      })}\n`);
      expect(readChatBinding(chatUrl)?.worktree).toBe(process.cwd());
      expect(existsSync(join(root, 'home', '.local', 'state', 'orchestrator-fleet', 'chat-bindings', '123e4567-e89b-12d3-a456-426614174040.json'))).toBe(true);
      expect(existsSync(join(root, 'isolated-agent-state'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Issue #2359 review chat binding', () => {
  it('binds to the worktree passed by the review runner instead of the pack-root cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-2359-binding-'));
    const chatUrl = 'https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174059';
    const manager = join(root, 'leopoker-mgr-134');
    vi.stubEnv('HOME', join(root, 'home'));
    vi.stubEnv('OPK_CHAT_BINDING_WORKTREE', manager);
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_manager');
    try {
      recordChatBindings(`${JSON.stringify({ schema: 'turn-result/v1', conversation_id: chatUrl })}\n`);
      expect(readChatBinding(chatUrl)?.worktree).toBe(manager);
      expect(readChatBinding(chatUrl)).not.toHaveProperty('terminal_handle');
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Issue #1238 mechanically derived production graph', () => {
  it('resolves every reachable production source and enumerates lifecycle sinks', () => {
    const repoRoot = resolve(import.meta.dirname, '../..');
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = packageJson.scripts?.['chatgpt-browser-turn'] ?? '';
    const entryMatch = command.match(/scripts\/chatgpt-browser-turn\/state-light-entry\.ts/);
    expect(entryMatch).not.toBeNull();

    const entryPath = join(repoRoot, entryMatch![0]);
    const compilerOptions: ts.CompilerOptions = {
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      resolveJsonModule: true,
    };
    const queue = [entryPath];
    const files = new Set<string>();
    const unresolved: string[] = [];
    while (queue.length > 0) {
      const filePath = queue.shift()!;
      if (files.has(filePath)) continue;
      files.add(filePath);
      const source = ts.createSourceFile(
        filePath,
        readFileSync(filePath, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      for (const imported of ts.preProcessFile(source.getFullText(), true, true).importedFiles) {
        if (!imported.fileName.startsWith('.')) continue;
        const resolved = ts.resolveModuleName(imported.fileName, filePath, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
        if (!resolved) {
          unresolved.push(`${relative(repoRoot, filePath)} -> ${imported.fileName}`);
        } else if (resolved.endsWith('.ts') || resolved.endsWith('.tsx')) {
          queue.push(resolve(resolved));
        }
      }
    }

    const sinks: Array<{ kind: string; file: string; receiver: string; owner: string; category: string }> = [];
    const functionNames = new Set<string>();
    const functionCalls = new Map<string, Set<string>>();
    const unknownSinks: string[] = [];
    for (const filePath of files) {
      const source = ts.createSourceFile(
        filePath,
        readFileSync(filePath, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const classifySink = (kind: string, receiver: string): string => {
        if (kind === 'newContext') return 'forbidden-context-create';
        if (kind === 'contexts' && (receiver === '(activeBrowser as any)' || /(?:^|\.)browser$|state\.browser$|browser as/.test(receiver))) return 'browser-contexts';
        if (kind === 'pages' && /^(?:ctx|context|contexts\[0\])$|contexts\[0\] as/.test(receiver)) return 'context-pages';
        if (kind === 'newPage' && /^(?:ctx|context|contexts\[0\])$|contexts\[0\] as/.test(receiver)) return 'context-new-page';
        if (kind === 'close' && /browser as/.test(receiver)) return 'browser-release';
        if (kind === 'close' && /(?:page|opened\.page|outcome\.page|state\.page|secondaryPage)/.test(receiver)) return 'owned-page-close';
        return 'unknown';
      };
      const visit = (node: ts.Node, owner = 'MODULE') => {
        let nextOwner = owner;
        if (ts.isFunctionDeclaration(node) && node.name) nextOwner = node.name.text;
        else if (ts.isMethodDeclaration(node) && node.name) nextOwner = node.name.getText(source);
        else if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
          nextOwner = node.name.getText(source);
        }
        if (nextOwner !== 'MODULE') {
          functionNames.add(nextOwner);
          if (!functionCalls.has(nextOwner)) functionCalls.set(nextOwner, new Set());
        }
        if (ts.isCallExpression(node)) {
          const expression = node.expression;
          if (ts.isIdentifier(expression)) functionCalls.get(nextOwner)?.add(expression.text);
          if (ts.isPropertyAccessExpression(expression)) {
            const kind = expression.name.text;
            if (['close', 'contexts', 'newContext', 'newPage', 'pages'].includes(kind)) {
              const receiver = expression.expression.getText(source);
              const category = classifySink(kind, receiver);
              sinks.push({ kind, file: relative(repoRoot, filePath), receiver, owner: nextOwner, category });
              if (category === 'unknown') unknownSinks.push(`${relative(repoRoot, filePath)}: ${receiver}.${kind}()`);
            }
          }
        }
        node.forEachChild((child) => visit(child, nextOwner));
      };
      visit(source);
    }

    const reachableOwners = new Set([
      'runStateLightEntry',
      'runStateLightTurn',
      'runStateLightSession',
      'runCli',
      'cancelOwnedGenerationFromReceipt',
    ]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const owner of reachableOwners) {
        for (const callee of functionCalls.get(owner) ?? []) {
          if (functionNames.has(callee) && !reachableOwners.has(callee)) {
            reachableOwners.add(callee);
            expanded = true;
          }
        }
      }
    }
    const unreachableSinks = sinks.filter(({ owner }) => !reachableOwners.has(owner));
    const sinkInventory = sinks
      .map(({ kind, receiver, owner, category }) => `${kind}:${category}:${receiver}:${owner}`)
      .sort();
    expect(unresolved).toEqual([]);
    expect(files.size).toBeGreaterThan(1);
    expect(unreachableSinks).toEqual([]);
    expect(unknownSinks).toEqual([]);
    expect(sinkInventory).toEqual([
      'close:browser-release:(browser as { close: () => Promise<void> }):releaseCdpBrowser',
      'close:owned-page-close:(opened.page as { close: () => Promise<void> }):closeOwnedTurnPage',
      'close:owned-page-close:(page as { close: () => Promise<void> }):abandonLatePageHandle',
      'close:owned-page-close:opened.page:runGateBCharacterizationCommand',
      'close:owned-page-close:outcome.page:finalizeTurn',
      'close:owned-page-close:page:adoptNewPageWithBudget',
      'close:owned-page-close:secondaryPage:runGateBCharacterization',
      'close:owned-page-close:state.page:cleanupSession',
      'contexts:browser-contexts:(activeBrowser as any):recoverCurrentObservation',
      'contexts:browser-contexts:browser:findOpenConversationPage',
      'contexts:browser-contexts:browser:openGateBCharacterizationPage',
      'contexts:browser-contexts:browser:createDedicatedTurnPage',
      'contexts:browser-contexts:browser:openTurnPage',
      'contexts:browser-contexts:(browser as { contexts: () => unknown[] }):probeProfileReady',
      'contexts:browser-contexts:state.browser:setupOwnedPage',
      'newPage:context-new-page:contexts[0]:createDedicatedTurnPage',
      'newPage:context-new-page:contexts[0]:setupOwnedPage',
      'newPage:context-new-page:context:runGateBCharacterization',
      'newPage:context-new-page:ctx:adoptNewPageWithBudget',
      'newPage:context-new-page:ctx:openGateBCharacterizationPage',
      'pages:context-pages:(contexts[0] as { pages: () => unknown[] }):probeProfileReady',
      'pages:context-pages:context:attachGateBWebSocketObservers',
      'pages:context-pages:contexts[0]:findOpenConversationPage',
      'pages:context-pages:context:attachPlaywrightContextCdpObservers',
      'pages:context-pages:contexts[0]:recoverCurrentObservation',
      'pages:context-pages:context:runGateBCharacterization',
      'pages:context-pages:ctx:openGateBCharacterizationPage',
      'pages:context-pages:ctx:openTurnPage',
    ].sort());
  });
});


describe('Issue #1377 explicit abandonment authority', () => {
  function nonOkResult() {
    return makeTurnResult({
      state: 'no_reply',
      scope: 'invocation',
      cause: 'observation_exhausted_no_resend',
      send_count: 1,
    });
  }

  it('preserves every current non-ok state/cause with no Stop authority', async () => {
    const stopClick = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const page = {
      isClosed: () => false,
      close,
      locator: () => ({
        count: vi.fn(async () => 1),
        first: () => ({ click: stopClick, waitFor: vi.fn(async () => undefined) }),
      }),
    };
    const browser = { isConnected: () => true, close: vi.fn(async () => undefined) };

    for (const state of TURN_STATES) {
      if (state === 'ok') continue;
      const result = await __testFinalizeTurn({
        page,
        stopAuthorityPage: page,
        browser,
        result: makeTurnResult({
          state,
          scope: 'invocation',
          cause: `post_send_${state}`,
          send_count: 1,
        }),
      });
      expect(result).toMatchObject({
        state,
        cause: `post_send_${state}`,
        cleanup: 'skipped',
      });
      expect(result.incidents).toContain('owned_generation_stop_not_attempted_authority_absent');
    }

    expect(stopClick).toHaveBeenCalledTimes(0);
    expect(close).toHaveBeenCalledTimes(0);
  });

  it('does not Stop or close an unproven reachable page through runStateLightTurn', async () => {
    const stopClick = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const page = {
      isClosed: () => false,
      close,
      locator: () => ({
        count: vi.fn(async () => 1),
        first: () => ({ click: stopClick, waitFor: vi.fn(async () => undefined) }),
      }),
    };
    const browser = { isConnected: () => true, close: vi.fn(async () => undefined) };
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runStateLightTurn(['--profile', 'fixture'], {
        runTurn: async () => ({ page, browser, result: nonOkResult() }),
      });
    } finally {
      write.mockRestore();
    }
    expect(stopClick).toHaveBeenCalledTimes(0);
    expect(close).toHaveBeenCalledTimes(0);
  });

  it('does not treat an explicit owned page handle as independent cancellation authority', async () => {
    const stopClick = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const page = {
      isClosed: () => false,
      close,
      locator: () => ({
        count: vi.fn(async () => 1),
        first: () => ({
          click: stopClick,
          waitFor: vi.fn(async () => undefined),
        }),
      }),
    };
    const browser = { isConnected: () => true, close: vi.fn(async () => undefined) };
    const result = await __testFinalizeTurn({
      page,
      stopAuthorityPage: page,
      browser,
      result: nonOkResult(),
    });
    expect(stopClick).toHaveBeenCalledTimes(0);
    expect(close).toHaveBeenCalledTimes(0);
    expect(result.cleanup).toBe('skipped');
    expect(result.incidents).toContain('owned_generation_stop_not_attempted_authority_absent');
  });

  it('forfeiture suppresses even an otherwise exact owned target', async () => {
    const stopClick = vi.fn(async () => undefined);
    const page = {
      isClosed: () => false,
      close: vi.fn(async () => undefined),
      locator: () => ({
        count: vi.fn(async () => 1),
        first: () => ({ click: stopClick, waitFor: vi.fn(async () => undefined) }),
      }),
    };
    const result = await __testFinalizeTurn({
      page,
      stopAuthorityPage: page,
      ownershipForfeited: true,
      browser: { isConnected: () => true, close: vi.fn(async () => undefined) },
      result: nonOkResult(),
    });
    expect(stopClick).toHaveBeenCalledTimes(0);
    expect(result.incidents).toContain('owned_generation_stop_not_attempted_authority_absent');
  });
});


describe('Issue #2434 cancellation is no-effect without original tab+generation proof', () => {
  const marker = `OPKTURNV1${'12'.repeat(16)}`;
  const cdp = 'http://127.0.0.1:9222';
  const ownedUrl = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';

  function admittedSentFixture() {
    const root = mkdtempSync(join(tmpdir(), 'opk-2434-cancel-'));
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
    const profileKey = configuredProfileKey('synthetic-profile', cdp);
    const invocationId = 'synthetic-cancel-invocation';
    admitStateLightTurnObservation({ profileKey, invocationId, marker });
    transitionStateLightTurnObservation({ profileKey, invocationId, phase: 'dispatching', reason: 'synthetic_dispatch' });
    transitionStateLightTurnObservation({
      profileKey, invocationId, phase: 'sent_unharvested', reason: 'synthetic_send',
      sendCount: 1, sendWitness: 'numeric_send_count', conversationUrl: ownedUrl,
    });
    const receipt = buildBrowserTurnCancellationReceipt({
      invocationId, profileKey, conversationUrl: ownedUrl, marker, sendCount: 1,
    })!;
    return { root, profileKey, invocationId, receipt };
  }

  it('accepts only exact ChatGPT UUID conversation URL shapes', () => {
    expect(isSupportedChatGptConversationUrl(ownedUrl)).toBe(true);
    expect(isSupportedChatGptConversationUrl(`${ownedUrl}?model=auto#x`)).toBe(true);
    expect(isSupportedChatGptConversationUrl('https://evil.example/c/11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(isSupportedChatGptConversationUrl('https://chatgpt.com/not-c/11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(isSupportedChatGptConversationUrl('https://chatgpt.com/c/not-a-uuid')).toBe(false);
  });

  it('never inspects or clicks Stop from caller-supplied explicit authority alone', async () => {
    const count = vi.fn(async () => 1);
    const click = vi.fn(async () => undefined);
    const page = { isClosed: () => false, locator: () => ({
      count, first: () => ({ click, waitFor: vi.fn(async () => undefined) }),
    }) };
    expect(await stopOwnedGeneration(page)).toBe('not_attempted_authority_absent');
    expect(await stopOwnedGeneration(page, EXPLICIT_CANCELLATION_AUTHORITY)).toBe('not_attempted_identity_unproven');
    expect(count).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('does not connect, click Stop or report cancelled even for an exact URL and historical marker', async () => {
    const { root, receipt } = admittedSentFixture();
    const page = { url: () => ownedUrl, close: vi.fn(), locator: vi.fn() };
    const sibling = { url: () => ownedUrl, close: vi.fn(), locator: vi.fn() };
    const connect = vi.fn(async () => ({}));
    const enumeratePages = vi.fn(async () => [page, sibling]);
    const readUserMessages = vi.fn(async () => ({
      messages: [{ role: 'user' as const, text: `${marker}\n\nprompt` }], incomplete: false,
    }));
    const stop = vi.fn(async () => 'confirmed' as const);
    try {
      const result = await cancelOwnedGenerationFromReceipt(receipt, cdp, EXPLICIT_CANCELLATION_AUTHORITY, {
        connect, enumeratePages, readUserMessages, stop,
      });
      expect(result).toMatchObject({
        state: 'driver_error', cause: 'cancellation_owned_tab_and_generation_unproven',
        sendCount: 1, stopOutcome: 'not_attempted_identity_unproven',
        identityProven: false, conversationUrl: ownedUrl,
      });
      expect(connect).toHaveBeenCalledTimes(0);
      expect(enumeratePages).toHaveBeenCalledTimes(0);
      expect(readUserMessages).toHaveBeenCalledTimes(0);
      expect(stop).toHaveBeenCalledTimes(0);
      expect(page.close).not.toHaveBeenCalled();
      expect(sibling.close).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects foreign profile/marker and missing exact durable observations without Stop', async () => {
    const { root, receipt } = admittedSentFixture();
    try {
      const foreignMarkerReceipt = {
        ...receipt, marker: `OPKTURNV1${'34'.repeat(16)}`,
      };
      expect((await cancelOwnedGenerationFromReceipt(
        foreignMarkerReceipt, cdp, EXPLICIT_CANCELLATION_AUTHORITY,
      )).cause).toBe('cancellation_durable_identity_or_phase_mismatch');
      expect((await cancelOwnedGenerationFromReceipt(
        { ...receipt, configured_profile_key: 'unrelated-profile' },
        cdp, EXPLICIT_CANCELLATION_AUTHORITY,
      )).cause).toBe('cancellation_durable_invocation_unreadable');
      expect((await cancelOwnedGenerationFromReceipt(
        receipt, cdp,
      )).stopOutcome).toBe('not_attempted_authority_absent');
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exposes the native cancel command and returns non-success without any browser effects', async () => {
    const { root, receipt } = admittedSentFixture();
    const receiptFile = join(root, 'receipt.json');
    writeFileSync(receiptFile, JSON.stringify(receipt), 'utf8');
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const code = await runStateLightEntry(['cancel', '--receipt-file', receiptFile, '--cdp', cdp]);
      expect(code).not.toBe(0);
      expect(writes.join('')).toContain('"state":"driver_error"');
      expect(writes.join('')).toContain('"stop_outcome":"not_attempted_identity_unproven"');
      expect(writes.join('')).not.toContain('"state":"cancelled"');
    } finally {
      spy.mockRestore();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('Issue #1377 production runStateLightTurn recovery integration', () => {
  const marker = `OPKTURNV1${'78'.repeat(16)}`;
  const ownedUrl = 'https://chatgpt.com/c/77777777-7777-4777-8777-777777777777';
  const foreignUrl = 'https://chatgpt.com/c/88888888-8888-4888-8888-888888888888';

  function trackedPage(url: string, stopVisible = false) {
    let visible = stopVisible;
    const stopClick = vi.fn(async () => { visible = false; });
    const close = vi.fn(async () => undefined);
    const page = {
      url: () => url,
      isClosed: () => false,
      close,
      locator: () => ({
        count: vi.fn(async () => visible ? 1 : 0),
        first: () => ({
          click: stopClick,
          waitFor: vi.fn(async () => undefined),
        }),
      }),
    };
    return { page, stopClick, close };
  }

  async function runEntry(runTurn: () => Promise<any>) {
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const code = await runStateLightTurn(['--profile', 'fixture'], { runTurn });
      const result = writes
        .flatMap((chunk) => chunk.split(/\r?\n/))
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((row) => row.schema === 'turn-result/v1');
      expect(result).toBeDefined();
      return { code, result };
    } finally {
      stdout.mockRestore();
    }
  }

  it('recovers an exact owned page after page loss without resend, foreign Stop, or close', async () => {
    const lost = { url: () => ownedUrl, isClosed: () => true };
    const recovered = trackedPage(ownedUrl);
    const foreign = trackedPage(foreignUrl, true);
    const browser = { isConnected: () => true, close: vi.fn(async () => undefined) };
    let sends = 0;
    const state: PostSendRecoveryState = {
      lossEpoch: 0,
      successorCreated: false,
      immutableConversationUrl: ownedUrl,
      cleanupAuthorityPage: lost,
      stopAuthorityPage: lost,
    };

    const outcome = await runEntry(async () => {
      sends += 1;
      const recovery = await runPostSendRecovery({
        browser,
        currentPage: lost,
        marker,
        hardDeadlineMs: 100,
        pollMs: 1,
        state,
        adapter: {
          enumeratePages: vi.fn(async () => [foreign.page, recovered.page]),
          pageUrl: (page) => String((page as any).url()),
          normalizeConversationUrl: (value) => value,
          isSupportedConversationUrl: () => true,
          readAuthoritativeMessages: vi.fn(async (page) => ({
            messages: page === recovered.page
              ? [{ role: 'user' as const, text: `${marker}\n\nprompt` }]
              : [{ role: 'user' as const, text: 'foreign prompt' }],
            incomplete: false,
          })),
          browserDefinitelyDisconnected: () => false,
          pageDefinitelyLost: (page) => page === lost,
          reconnect: vi.fn(async () => { throw new Error('unexpected reconnect'); }),
          createSuccessor: vi.fn(async () => { throw new Error('unexpected successor'); }),
          sleep: vi.fn(async () => undefined),
          now: () => 1,
        },
      });
      expect(recovery).toMatchObject({
        kind: 'recovered',
        page: recovered.page,
        conversationUrl: ownedUrl,
        cleanupOwned: false,
      });
      if (recovery.kind !== 'recovered') throw new Error(recovery.cause);
      return {
        page: recovery.page,
        browser: recovery.browser,
        cleanupAction: 'preserve' as const,
        result: makeTurnResult({
          state: 'ok',
          scope: 'none',
          cause: 'completed_page_only',
          send_count: sends,
        }),
      };
    });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(sends).toBe(1);
    expect(recovered.stopClick).not.toHaveBeenCalled();
    expect(recovered.close).not.toHaveBeenCalled();
    expect(foreign.stopClick).not.toHaveBeenCalled();
    expect(foreign.close).not.toHaveBeenCalled();
  });

  it('reconnects after browser loss and binds only the exact owned conversation without resend', async () => {
    const lost = { url: () => ownedUrl, isClosed: () => true };
    const recovered = trackedPage(ownedUrl);
    const foreign = trackedPage(foreignUrl, true);
    const deadBrowser = { isConnected: () => false, close: vi.fn(async () => undefined) };
    const liveBrowser = { isConnected: () => true, close: vi.fn(async () => undefined) };
    const reconnect = vi.fn(async () => liveBrowser);
    let sends = 0;
    const state: PostSendRecoveryState = {
      lossEpoch: 0,
      successorCreated: false,
      immutableConversationUrl: ownedUrl,
      cleanupAuthorityPage: lost,
      stopAuthorityPage: lost,
    };

    const outcome = await runEntry(async () => {
      sends += 1;
      const recovery = await runPostSendRecovery({
        browser: deadBrowser,
        currentPage: lost,
        marker,
        hardDeadlineMs: 100,
        pollMs: 1,
        state,
        adapter: {
          enumeratePages: vi.fn(async (browser) => {
            expect(browser).toBe(liveBrowser);
            return [foreign.page, recovered.page];
          }),
          pageUrl: (page) => String((page as any).url()),
          normalizeConversationUrl: (value) => value,
          isSupportedConversationUrl: () => true,
          readAuthoritativeMessages: vi.fn(async (page) => ({
            messages: page === recovered.page
              ? [{ role: 'user' as const, text: `${marker}\n\nprompt` }]
              : [{ role: 'user' as const, text: 'foreign prompt' }],
            incomplete: false,
          })),
          browserDefinitelyDisconnected: (browser) => browser === deadBrowser,
          pageDefinitelyLost: (page) => page === lost,
          reconnect,
          createSuccessor: vi.fn(async () => { throw new Error('unexpected successor'); }),
          sleep: vi.fn(async () => undefined),
          now: () => 1,
        },
      });
      expect(recovery).toMatchObject({
        kind: 'recovered',
        browser: liveBrowser,
        page: recovered.page,
        conversationUrl: ownedUrl,
      });
      if (recovery.kind !== 'recovered') throw new Error(recovery.cause);
      return {
        page: recovery.page,
        browser: recovery.browser,
        cleanupAction: 'preserve' as const,
        result: makeTurnResult({
          state: 'ok',
          scope: 'none',
          cause: 'completed_page_only',
          send_count: sends,
        }),
      };
    });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(sends).toBe(1);
    expect(recovered.stopClick).not.toHaveBeenCalled();
    expect(recovered.close).not.toHaveBeenCalled();
    expect(foreign.stopClick).not.toHaveBeenCalled();
    expect(foreign.close).not.toHaveBeenCalled();
  });

  it('emits truthful exhaustion and preserves the still-running exact successor', async () => {
    const owned = trackedPage(ownedUrl, true);
    const foreign = trackedPage(foreignUrl, true);
    const browser = { isConnected: () => true, close: vi.fn(async () => undefined) };
    let sends = 0;
    const state: PostSendRecoveryState = {
      lossEpoch: 1,
      successorCreated: true,
      immutableConversationUrl: ownedUrl,
      cleanupAuthorityPage: owned.page,
      stopAuthorityPage: owned.page,
      successorPage: owned.page,
    };

    const outcome = await runEntry(async () => {
      sends += 1;
      const recovery = await runPostSendRecovery({
        browser,
        marker,
        hardDeadlineMs: 0,
        pollMs: 1,
        state,
        adapter: {
          enumeratePages: vi.fn(async () => [foreign.page]),
          pageUrl: (page) => String((page as any).url()),
          normalizeConversationUrl: (value) => value,
          isSupportedConversationUrl: () => true,
          readAuthoritativeMessages: vi.fn(async () => ({
            messages: [{ role: 'user' as const, text: 'foreign prompt' }],
            incomplete: false,
          })),
          browserDefinitelyDisconnected: () => false,
          pageDefinitelyLost: () => false,
          reconnect: vi.fn(async () => { throw new Error('unexpected reconnect'); }),
          createSuccessor: vi.fn(async () => { throw new Error('unexpected successor'); }),
          sleep: vi.fn(async () => undefined),
          now: () => 1,
        },
      });
      expect(recovery).toMatchObject({
        kind: 'failure',
        state: 'no_reply',
        cause: 'observation_exhausted_no_resend',
        stopAuthorityPage: owned.page,
      });
      if (recovery.kind !== 'failure') throw new Error('expected exhaustion');
      return {
        page: recovery.stopAuthorityPage,
        stopAuthorityPage: recovery.stopAuthorityPage,
        browser: recovery.browser,
        cleanupAction: 'preserve' as const,
        result: makeTurnResult({
          state: recovery.state,
          scope: 'invocation',
          cause: recovery.cause,
          send_count: sends,
        }),
      };
    });

    expect(outcome.code).not.toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'no_reply',
      cause: 'observation_exhausted_no_resend',
      send_count: 1,
      cleanup: 'skipped',
    });
    expect(outcome.result.incidents).toContain('owned_generation_stop_not_attempted_authority_absent');
    expect(sends).toBe(1);
    expect(owned.stopClick).not.toHaveBeenCalled();
    expect(owned.close).not.toHaveBeenCalled();
    expect(foreign.stopClick).not.toHaveBeenCalled();
    expect(foreign.close).not.toHaveBeenCalled();
  });

  it('fixes capture and disconnects without pressing Stop before emitting the result', async () => {
    const order: string[] = [];
    const stopClick = vi.fn(async () => { order.push('stop'); });
    const page = {
      url: () => ownedUrl,
      isClosed: () => false,
      close: vi.fn(async () => undefined),
      locator: () => ({
        count: vi.fn(async () => 1),
        first: () => ({
          click: stopClick,
          waitFor: vi.fn(async () => undefined),
        }),
      }),
    };
    const browser = {
      isConnected: () => true,
      [BEFORE_CDP_BROWSER_RELEASE]: vi.fn(async () => {
        expect(stopClick).not.toHaveBeenCalled();
        order.push('capture');
      }),
      close: vi.fn(async () => { order.push('disconnect'); }),
    };
    const outcome = await runEntry(async () => ({
      page,
      stopAuthorityPage: page,
      browser,
      cleanupAction: 'preserve' as const,
      result: makeTurnResult({
        state: 'no_reply',
        scope: 'invocation',
        cause: 'observation_exhausted_no_resend',
        send_count: 1,
      }),
    }));
    expect(outcome.code).not.toBe(0);
    expect(order).toEqual(['capture', 'disconnect']);
    expect(outcome.result).toMatchObject({ cleanup: 'skipped', send_count: 1 });
  });
});

describe('Issue #2461 selected pack-review CDP preflight', () => {
  const args = ['--route', 'pack-gpt-reviewer', '--project', 'orchestrator-pack', '--timeout-ms', '5000'];
  const cdpA = 'http://127.0.0.1:49221';
  const cdpB = 'http://127.0.0.1:49222';
  const projectUrl = 'https://example.test/project';
  const selectedCard = {
    projectId: 'orchestrator-pack',
    repository: 'chetwerikoff/orchestrator-pack',
    browserGpt: { projectUrl },
  } as ReturnType<typeof import('../lib/target-context.ts').resolveTargetContext>;

  it('accepts only the named route, exact card and bounded project; rejects arbitrary browser overrides', () => {
    expect(parsePackReviewPreflightArgs(args)).toEqual({ projectId: 'orchestrator-pack', timeoutMs: 5000 });
    for (const invalid of [
      [...args, '--profile', '/tmp/foreign'],
      [...args, '--cdp', cdpB],
      [...args.slice(0, 1), 'manager', ...args.slice(2)],
      [...args.slice(0, -1), '0'],
    ]) expect(() => parsePackReviewPreflightArgs(invalid)).toThrow();
  });

  it('proves selected pair A only; a second individually healthy pair B cannot rescue failed A', async () => {
    const inspected: string[] = [];
    const reached: string[] = [];
    const browserConfig = vi.fn((env: NodeJS.ProcessEnv) => {
      expect(env.OPK_PROJECT_ID).toBe('orchestrator-pack');
      return { profile: '/synthetic/selected-A', cdpUrl: cdpA, projectUrl };
    });
    const fake = {
      resolveTarget: () => selectedCard,
      resolveBrowserConfig: browserConfig,
      inspectOwner: async ({ cdp }: { cdp: string }) => {
        inspected.push(cdp);
        return { ok: cdp === cdpB, reason: 'not_listening' };
      },
      isReachable: async (cdp: string) => {
        reached.push(cdp);
        return cdp === cdpB;
      },
    };
    const result = await runPackReviewPreflight(args, fake, { OPK_PROJECT_ID: 'orchestrator-pack' });
    expect(result).toMatchObject({
      route: 'pack-gpt-reviewer', outcome: 'incomplete', reason: 'owner_not_listening', handle_present: false,
    });
    expect(inspected).toEqual([cdpA]);
    expect(reached).toEqual([]);
    expect(browserConfig).toHaveBeenCalledTimes(1);

    const mismatch = await runPackReviewPreflight(args, fake, { OPK_PROJECT_ID: 'foreign' });
    expect(mismatch.reason).toBe('project_selector_mismatch');
    const absent = await runPackReviewPreflight(args, fake, {});
    expect(absent.reason).toBe('project_selector_mismatch');
    expect(browserConfig).toHaveBeenCalledTimes(1);
    const cardMismatch = await runPackReviewPreflight(args, {
      ...fake, resolveTarget: () => ({ ...selectedCard, repository: 'foreign/repository' }),
    }, { OPK_PROJECT_ID: 'orchestrator-pack' });
    expect(cardMismatch.reason).toBe('selected_pack_card_mismatch');
    expect(browserConfig).toHaveBeenCalledTimes(1);
  });

  it('binds the actual unchanged pack-review resolver to the selected project card, never a foreign healthy pair', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'opk2461-card-'));
    const cardDir = join(configRoot, 'orchestrator-pack', 'projects');
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, 'orchestrator-pack.json'), JSON.stringify({
      projectId: 'orchestrator-pack',
      repository: 'chetwerikoff/orchestrator-pack',
      primaryRoot: process.cwd(),
      defaultBranch: 'main',
      orcaWorkspacePattern: '.*',
      orchestratorTitlePattern: '.*',
      browserGpt: { projectUrl },
    }));
    const inspected: string[] = [];
    const foreignPair = { profile: '/synthetic/foreign-B', cdp: cdpB, ownerMatches: true, reachable: true };
    expect(foreignPair.ownerMatches && foreignPair.reachable).toBe(true);
    try {
      const result = await runPackReviewPreflight(args, {
        inspectOwner: async (input) => {
          inspected.push(input.cdp);
          return { ok: input.cdp === foreignPair.cdp, reason: 'not_listening' };
        },
        isReachable: async (cdp) => cdp === foreignPair.cdp,
      }, {
        OPK_PROJECT_ID: 'orchestrator-pack',
        XDG_CONFIG_HOME: configRoot,
        PACK_GPT_BROWSER_PROFILE: '/synthetic/selected-A',
        PACK_GPT_BROWSER_CDP: cdpA,
      });
      expect(result).toMatchObject({
        route: 'pack-gpt-reviewer', outcome: 'incomplete', reason: 'owner_not_listening',
      });
      expect(inspected).toEqual([cdpA]);
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  it('uses the real additive pure owner inspector for success, mismatch, timeout and absent owner file', async () => {
    const verifier = await import(new URL('../../.claude/skills/discuss-with-gpt/verify-cdp-owner.mjs', import.meta.url).href) as {
      inspectCdpProfileBounded: (
        options: { cdp: string; profile: string; timeoutMs: number },
        observer?: { findListenerPid?: () => Promise<string>; readCommandLine?: () => Promise<string> },
      ) => Promise<{ ok: boolean; reason?: string; timedOut?: boolean }>;
      verifyCdpProfileBounded: (
        options: { cdp: string; profile: string; timeoutMs: number },
        observer?: { findListenerPid?: () => Promise<string>; readCommandLine?: () => Promise<string> },
      ) => Promise<{ ok: boolean }>;
    };
    const root = mkdtempSync(join(tmpdir(), 'opk2461-owner-'));
    const ownerFile = join(root, '.local/state/discuss-with-gpt', 'cdp-49221-owner.json');
    const sentinel = 'literal-existing-owner-sentinel\\n';
    const profile = join(root, 'selected-A');
    const observer = {
      findListenerPid: async () => '4242',
      readCommandLine: async () => `chrome --user-data-dir="${profile}" --remote-debugging-port=49221`,
    };
    // The fixture state is isolated. The production preflight never redirects HOME.
    vi.stubEnv('HOME', root);
    try {
      mkdirSync(join(root, '.local/state/discuss-with-gpt'), { recursive: true });
      writeFileSync(ownerFile, sentinel);
      const success = await verifier.inspectCdpProfileBounded({ cdp: cdpA, profile, timeoutMs: 1000 }, observer);
      expect(success).toMatchObject({ ok: true });
      expect(readFileSync(ownerFile, 'utf8')).toBe(sentinel);
      const mismatch = await verifier.inspectCdpProfileBounded({
        cdp: cdpA, profile: join(root, 'foreign-B'), timeoutMs: 1000,
      }, observer);
      expect(mismatch).toMatchObject({ ok: false, reason: 'profile_mismatch' });
      expect(readFileSync(ownerFile, 'utf8')).toBe(sentinel);
      const timeout = await verifier.inspectCdpProfileBounded({ cdp: cdpA, profile, timeoutMs: 0 }, observer);
      expect(timeout).toMatchObject({ ok: false, timedOut: true });
      expect(readFileSync(ownerFile, 'utf8')).toBe(sentinel);
      rmSync(ownerFile);
      const absent = await verifier.inspectCdpProfileBounded({ cdp: cdpA, profile, timeoutMs: 1000 }, observer);
      expect(absent.ok).toBe(true);
      expect(existsSync(ownerFile)).toBe(false);
      // The unchanged normal writer is deliberately *not* pure on success.
      // Verify its real write against the fixture-only HOME, never the operator's.
      expect(homedir()).toBe(root);
      const writing = await verifier.verifyCdpProfileBounded({ cdp: cdpA, profile, timeoutMs: 1000 }, observer);
      expect(writing.ok).toBe(true);
      expect(existsSync(ownerFile)).toBe(true);
      expect(JSON.parse(readFileSync(ownerFile, 'utf8'))).toMatchObject({ port: '49221' });
      // The old normal writer retains its recordCdpOwner-on-success call.
      const original = readFileSync(new URL('../../.claude/skills/discuss-with-gpt/verify-cdp-owner.mjs', import.meta.url), 'utf8');
      expect(original).toMatch(/if \(result\.ok\) recordCdpOwner/u);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preflight emits only scrubbed selected-route evidence and never enters normal turn', async () => {
    const writes: string[] = [];
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const runTurn = vi.fn(async () => 0);
    vi.stubEnv('OPK_PROJECT_ID', 'orchestrator-pack');
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'synthetic-terminal-locator');
    try {
      const result = await runStateLightEntry(['preflight', ...args], {
        runTurn,
        preflight: {
          resolveTarget: () => selectedCard,
          resolveBrowserConfig: () => ({ profile: '/secret/selected-profile', cdpUrl: cdpA, projectUrl }),
          inspectOwner: async () => ({ ok: true }),
          isReachable: async () => true,
        },
      });
      expect(result).toBe(0);
      const report = JSON.parse(writes.join('')) as Record<string, unknown>;
      expect(report).toMatchObject({
        route: 'pack-gpt-reviewer', outcome: 'pass',
        reason: 'selected_route_reachable', handle_present: true,
      });
      expect(writes.join('')).not.toMatch(/secret|49221|synthetic-terminal-locator|profile|cdpUrl/u);
      expect(runTurn).not.toHaveBeenCalled();
      expect(Object.keys(report).sort()).toEqual(['elapsed_ms', 'handle_present', 'outcome', 'reason', 'route']);
    } finally {
      output.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('treats owner and reachability timeouts as incomplete, not a future-send PASS', async () => {
    const common = {
      resolveTarget: () => selectedCard,
      resolveBrowserConfig: () => ({ profile: '/selected', cdpUrl: cdpA, projectUrl }),
    };
    expect((await runPackReviewPreflight(args, {
      ...common, inspectOwner: async () => ({ ok: false, timedOut: true }),
      isReachable: async () => true,
    }, { OPK_PROJECT_ID: 'orchestrator-pack' })).reason).toBe('owner_probe_timeout');
    const late = await runPackReviewPreflight(args, {
      ...common, inspectOwner: async () => ({ ok: true }),
      isReachable: async () => { throw Object.assign(new Error('cdp_reachability_timeout'), { name: 'CdpReachabilityTimeoutError' }); },
    }, { OPK_PROJECT_ID: 'orchestrator-pack' });
    expect(late).toMatchObject({ outcome: 'incomplete', reason: 'cdp_reachability_timeout' });
  });
});

