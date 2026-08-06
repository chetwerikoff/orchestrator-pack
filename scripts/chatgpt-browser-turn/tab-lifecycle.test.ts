import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, expect, it, test, vi } from 'vitest';

import {
  __testFinalizeTurn,
  __testPublishStateLightReply,
  type CompactTurnResult,
  runStateLightTurn,
} from './state-light-turn.ts';
import { BEFORE_CDP_BROWSER_RELEASE, releaseCdpBrowser } from './browser-session.ts';
import { configuredProfileKey } from './storage-common.ts';
import {
  parsePostSettlementCloseArgs,
  rewritePreservedTurnResult,
  runEnhancedPageProbeCli,
  runPostSettlementClose,
  type CdpTarget,
  type ExactTargetChannel,
  type PostSettlementCloseDependencies,
} from '../browser-gpt-post-settlement-close.ts';
import { runStateLightEntry } from './state-light-entry.ts';
import { loadChromium } from './ui-adapter.ts';
import {
  buildBrowserTurnCancellationReceipt,
  cancelOwnedGenerationFromReceipt,
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
        '--chat-url', 'https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174003',
        '--timeout-ms', '1000',
        '--poll-ms', '1',
      ], {
        runTurn: (argv) => runStateLightTurn(argv, {
          runTurn: async () => ({
            result: makeTurnResult({ send_count: 1 }),
            page,
            browser,
            publicationState: publication.state,
          }),
        }),
      });
      const result = JSON.parse(writes.at(-1) ?? '{}') as CompactTurnResult;
      expect(exitCode).toBe(0);
      expect(result.cleanup).toBe('confirmed');
      expect(result.send_count).toBe(1);
      expect(pageCloseCalls).toBe(1);
      expect(browserCloseCalls).toBe(1);
      expect(readFileSync(output, 'utf8')).toBe(reply);
    } finally {
      foreignTargetOpen = true;
      stdout.mockRestore();
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
      'contexts:browser-contexts:browser:defaultEnumeratePages',
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
      'pages:context-pages:contexts[0]:defaultEnumeratePages',
      'pages:context-pages:context:attachPlaywrightContextCdpObservers',
      'pages:context-pages:contexts[0]:recoverCurrentObservation',
      'pages:context-pages:context:runGateBCharacterization',
      'pages:context-pages:ctx:openGateBCharacterizationPage',
      'pages:context-pages:ctx:openTurnPage',
    ].sort());
  });
});


describe('Issue #1283 explicit Stop authority', () => {
  function nonOkResult() {
    return makeTurnResult({
      state: 'no_reply',
      scope: 'invocation',
      cause: 'observation_exhausted_no_resend',
      send_count: 1,
    });
  }

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
    expect(stopClick).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('Stops the explicit proven target once and never closes it on non-ok', async () => {
    const stopClick = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const control = {
      click: stopClick,
      waitFor: vi.fn(async () => undefined),
    };
    const page = {
      isClosed: () => false,
      close,
      locator: () => ({
        count: vi.fn(async () => 1),
        first: () => control,
      }),
    };
    const browser = { isConnected: () => true, close: vi.fn(async () => undefined) };
    const result = await __testFinalizeTurn({
      page,
      stopAuthorityPage: page,
      browser,
      result: nonOkResult(),
    });
    expect(stopClick).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(result.cleanup).toBe('skipped');
    expect(result.incidents).toContain('owned_generation_stop_confirmed');
  });

  it('forfeiture suppresses even an otherwise explicit Stop target', async () => {
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
    expect(stopClick).not.toHaveBeenCalled();
    expect(result.incidents).toContain('owned_generation_stop_unavailable');
  });
});


describe('Issue #1283 receipt-bound cancellation primitive', () => {
  const marker = `OPKTURNV1${'12'.repeat(16)}`;
  const ownedUrl = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
  const foreignUrl = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';

  it('accepts only closed ChatGPT conversation origins and UUID paths', () => {
    expect(isSupportedChatGptConversationUrl(ownedUrl)).toBe(true);
    expect(isSupportedChatGptConversationUrl(`${ownedUrl}?model=auto#x`)).toBe(true);
    expect(isSupportedChatGptConversationUrl('https://evil.example/c/11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(isSupportedChatGptConversationUrl('https://chatgpt.com/not-c/11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(isSupportedChatGptConversationUrl('https://chatgpt.com/c/not-a-uuid')).toBe(false);
  });

  it('treats a missing Stop control as unconfirmed rather than completed', async () => {
    const page = {
      isClosed: () => false,
      locator: () => ({ count: vi.fn(async () => 0) }),
    };
    await expect(stopOwnedGeneration(page)).resolves.toBe('unconfirmed');
  });

  it('Stops exactly one receipt-proven owned page and never closes a sibling', async () => {
    const owned = { url: () => ownedUrl, close: vi.fn() };
    const sibling = { url: () => foreignUrl, close: vi.fn() };
    const stop = vi.fn(async () => 'confirmed' as const);
    const receipt = buildBrowserTurnCancellationReceipt({
      invocationId: 'inv-1283',
      profileKey: 'profile-1283',
      conversationUrl: ownedUrl,
      marker,
      sendCount: 1,
    });
    expect(receipt).not.toBeNull();
    const result = await cancelOwnedGenerationFromReceipt(receipt!, 'http://127.0.0.1:9222', {
      connect: vi.fn(async () => ({})),
      releaseBrowser: vi.fn(async () => undefined),
      enumeratePages: vi.fn(async () => [sibling, owned]),
      readUserMessages: vi.fn(async (page) => ({
        messages: page === owned
          ? [{ role: 'user' as const, text: `${marker}\n\nprompt` }]
          : [{ role: 'user' as const, text: 'foreign prompt' }],
        incomplete: false,
      })),
      stop,
    });
    expect(result).toMatchObject({
      state: 'no_reply',
      cause: 'child_stdout_eof_timeout_generation_stopped',
      sendCount: 1,
      stopOutcome: 'confirmed',
      identityProven: true,
      conversationUrl: ownedUrl,
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(owned);
    expect(owned.close).not.toHaveBeenCalled();
    expect(sibling.close).not.toHaveBeenCalled();
  });
});



describe('Issue #1283 production runStateLightTurn recovery integration', () => {
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

  it('emits truthful exhaustion, Stops the exact successor once, and preserves every tab', async () => {
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
    expect(outcome.result.incidents).toContain('owned_generation_stop_confirmed');
    expect(sends).toBe(1);
    expect(owned.stopClick).toHaveBeenCalledTimes(1);
    expect(owned.close).not.toHaveBeenCalled();
    expect(foreign.stopClick).not.toHaveBeenCalled();
    expect(foreign.close).not.toHaveBeenCalled();
  });

  it('runs Stop, then fixes capture, then disconnects before emitting the production result', async () => {
    const { BEFORE_CDP_BROWSER_RELEASE } = await import('./browser-session.ts');
    const order: string[] = [];
    let stopVisible = true;
    const stopClick = vi.fn(async () => {
      order.push('stop');
      stopVisible = false;
    });
    const page = {
      url: () => ownedUrl,
      isClosed: () => false,
      close: vi.fn(async () => undefined),
      locator: () => ({
        count: vi.fn(async () => stopVisible ? 1 : 0),
        first: () => ({
          click: stopClick,
          waitFor: vi.fn(async () => undefined),
        }),
      }),
    };
    const browser = {
      isConnected: () => true,
      [BEFORE_CDP_BROWSER_RELEASE]: vi.fn(async () => {
        expect(stopClick).toHaveBeenCalledTimes(1);
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
    expect(order).toEqual(['stop', 'capture', 'disconnect']);
    expect(outcome.result).toMatchObject({ cleanup: 'skipped', send_count: 1 });
  });
});

const profile = '/tmp/opk-profile-1266';
const cdp = 'http://127.0.0.1:9222';
const profileKey = configuredProfileKey(profile, cdp);
const reply = 'settled browser reply';
const replyBytes = Buffer.from(reply, 'utf8');
const replySha = createHash('sha256').update(replyBytes).digest('hex');

const target: CdpTarget = {
  id: 'target-owned',
  type: 'page',
  url: 'https://chatgpt.com/c/owned',
  webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/target-owned',
};
const sibling: CdpTarget = {
  id: 'target-sibling',
  type: 'page',
  url: 'https://chatgpt.com/c/sibling',
  webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/target-sibling',
};

function directResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'turn-result/v1',
    state: 'ok',
    scope: 'none',
    cause: 'completed_page_only',
    invocation_id: 'invocation-1266',
    configured_profile_key: profileKey,
    send_count: 1,
    cleanup: 'skipped',
    witness: {
      user_message_id: 'user-1',
      assistant_message_id: 'assistant-1',
      relation: 'reply_to',
      source: 'service',
    },
    post_settlement_target: {
      disposition: 'preserved_after_settlement',
      configured_profile_key: profileKey,
      target_id: target.id,
      normalized_url: target.url,
      assistant_message_id: 'assistant-1',
      representation: 'innerText',
      byte_length: replyBytes.byteLength,
      sha256: replySha,
      document_ordinal: 1,
      observed_user_nodes: 1,
      observed_assistant_nodes: 1,
      observed_message_nodes: 2,
      generation_in_progress: false,
      nodes_truncated: false,
    },
    ...overrides,
  };
}

function probeResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'browser-gpt-page-probe/v1',
    operation: 'export',
    status: 'ok',
    diagnostic_only: true,
    workflow_authority: 'none',
    configured_profile_key: profileKey,
    target_id: target.id,
    normalized_url: target.url,
    page_url: target.url,
    node: {
      role: 'assistant',
      ordinal: 0,
      document_ordinal: 1,
      message_id: 'assistant-1',
    },
    assistant_message_id: 'assistant-1',
    representation: 'innerText',
    byte_length: replyBytes.byteLength,
    sha256: replySha,
    output_identity: {
      path: '/tmp/reply-1266.txt',
      byte_length: replyBytes.byteLength,
      sha256: replySha,
    },
    observed_user_nodes: 1,
    observed_assistant_nodes: 1,
    observed_message_nodes: 2,
    generation_in_progress: false,
    nodes_truncated: false,
    last_assistant: true,
    last_message: true,
    ...overrides,
  };
}

function guard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    normalized_url: target.url,
    byte_length: replyBytes.byteLength,
    sha256: replySha,
    observed_user_nodes: 1,
    observed_assistant_nodes: 1,
    observed_message_nodes: 2,
    generation_in_progress: false,
    nodes_truncated: false,
    assistant_message_id: 'assistant-1',
    representation: 'innerText',
    document_ordinal: 1,
    ordinal: 0,
    last_assistant: true,
    last_message: true,
    completion_ready: true,
    continuation_available: false,
    ...overrides,
  };
}

function fixture(overrides: {
  direct?: Record<string, unknown>;
  probe?: Record<string, unknown>;
  harvest?: Uint8Array;
  initialTargets?: readonly CdpTarget[];
  remainingTargets?: readonly CdpTarget[];
  guards?: readonly Record<string, unknown>[];
  closeThrows?: boolean;
  remainingCensusThrows?: boolean;
  beforeFinalGuard?: () => void;
} = {}): {
  deps: PostSettlementCloseDependencies;
  closeCalls: () => number;
  openedIds: () => readonly string[];
} {
  let closeCount = 0;
  let censusCount = 0;
  let evaluateCount = 0;
  const opened: string[] = [];
  const channel: ExactTargetChannel = {
    evaluate: async () => (overrides.guards ?? [guard(), guard()])[evaluateCount++]!,
    close: async () => {
      closeCount++;
      if (overrides.closeThrows) throw new Error('close_dispatch_failed');
      return 'acknowledged';
    },
    disconnect: () => {},
  };
  return {
    deps: {
      readText: async (path) => JSON.stringify(path === 'turn.json'
        ? (overrides.direct ?? directResult())
        : (overrides.probe ?? probeResult())),
      readBytes: async () => overrides.harvest ?? replyBytes,
      listTargets: async () => {
        if (censusCount++ > 0 && overrides.remainingCensusThrows) {
          throw new Error('fresh_absence_census_failed');
        }
        return censusCount === 1
          ? (overrides.initialTargets ?? [target, sibling])
          : (overrides.remainingTargets ?? [sibling]);
      },
      openExactTargetChannel: async (candidate) => {
        opened.push(candidate.id);
        return channel;
      },
      ...(overrides.beforeFinalGuard ? { beforeFinalGuard: overrides.beforeFinalGuard } : {}),
    },
    closeCalls: () => closeCount,
    openedIds: () => opened,
  };
}

const args = {
  turnResult: 'turn.json',
  probeResult: 'probe.json',
  harvest: 'reply.txt',
  profile,
  cdp,
};

test('fixed CLI accepts only five governed artifact and namespace inputs', () => {
  assert.deepEqual(parsePostSettlementCloseArgs([
    '--turn-result', 'turn.json',
    '--probe-result', 'probe.json',
    '--harvest', 'reply.txt',
    '--profile', profile,
    '--cdp', cdp,
  ]), args);
  assert.throws(() => parsePostSettlementCloseArgs([
    '--turn-result', 'turn.json', '--target-id', String(target.id),
  ]), /argument_invalid|argument_set_invalid/u);
});

test('closes exactly the byte-bound completed owned target and leaves sibling present', async () => {
  const state = fixture();
  const result = await runPostSettlementClose(args, state.deps);
  assert.equal(result.status, 'closed');
  assert.equal(result.close_attempt_count, 1);
  assert.deepEqual(state.openedIds(), [target.id]);
  assert.equal(state.closeCalls(), 1);
  assert.equal(result.resend_authority, 'none');
});

test('settled target already absent is success with zero close attempts', async () => {
  const state = fixture({ initialTargets: [sibling] });
  const result = await runPostSettlementClose(args, state.deps);
  assert.equal(result.status, 'already_absent');
  assert.equal(result.close_attempt_count, 0);
  assert.equal(state.closeCalls(), 0);
});

test('prior close or capture-failure terminal records never authorize CDP', async () => {
  for (const direct of [
    directResult({ cleanup: 'confirmed' }),
    directResult({ cleanup: 'unconfirmed' }),
    directResult({
      post_settlement_target_capture: { status: 'unavailable', cause: 'surface_incomplete' },
    }),
  ]) {
    const state = fixture({ direct });
    const result = await runPostSettlementClose(args, state.deps);
    assert.equal(result.status, 'settlement_untrusted');
    assert.equal(result.close_attempt_count, 0);
    assert.deepEqual(state.openedIds(), []);
    assert.equal(state.closeCalls(), 0);
  }
});

test('launcher and generic recovery envelopes never become close authority', async () => {
  for (const direct of [
    { schema: 'flow-manager-long-running-child-terminal/v1' },
    directResult({
      state: 'recovery_required',
      scope: 'conversation',
      cause: 'generic_recovery_required',
    }),
  ]) {
    const state = fixture({ direct });
    const result = await runPostSettlementClose(args, state.deps);
    assert.equal(result.status, 'settlement_untrusted');
    assert.equal(result.close_attempt_count, 0);
    assert.deepEqual(state.openedIds(), []);
  }
});

test('profile namespace, probe evidence and harvested bytes must all match', async () => {
  for (const state of [
    fixture({ direct: directResult({ configured_profile_key: 'profile-wrong' }) }),
    fixture({ probe: probeResult({ configured_profile_key: 'profile-wrong' }) }),
    fixture({ harvest: Buffer.from('different', 'utf8') }),
  ]) {
    const result = await runPostSettlementClose(args, state.deps);
    assert.ok(result.status === 'settlement_untrusted' || result.status === 'harvest_untrusted');
    assert.equal(result.close_attempt_count, 0);
    assert.equal(state.closeCalls(), 0);
  }
});

test('mutation between initial and final same-channel guards is stale_harvest', async () => {
  let mutated = false;
  const state = fixture({
    guards: [guard(), guard({ ok: false, sha256: '0'.repeat(64) })],
    beforeFinalGuard: () => { mutated = true; },
  });
  const result = await runPostSettlementClose(args, state.deps);
  assert.equal(mutated, true);
  assert.equal(result.status, 'stale_harvest');
  assert.equal(result.close_attempt_count, 0);
  assert.equal(state.closeCalls(), 0);
});

test('active, resumable or completion-unproven replies fail the final guard', async () => {
  for (const changed of [
    { generation_in_progress: true },
    { continuation_available: true },
    { completion_ready: false },
  ]) {
    const state = fixture({ guards: [guard(changed)] });
    const result = await runPostSettlementClose(args, state.deps);
    assert.equal(result.status, 'stale_harvest');
    assert.equal(result.close_attempt_count, 0);
    assert.equal(state.closeCalls(), 0);
  }
});

test('appended, resumed and older-node surfaces cannot close', async () => {
  for (const changed of [
    { observed_message_nodes: 3, last_message: false },
    { sha256: '1'.repeat(64), continuation_available: true },
    { document_ordinal: 0, last_assistant: false, last_message: false },
  ]) {
    const state = fixture({ guards: [guard(changed)] });
    const result = await runPostSettlementClose(args, state.deps);
    assert.equal(result.status, 'stale_harvest');
    assert.equal(result.close_attempt_count, 0);
    assert.equal(state.closeCalls(), 0);
  }
});

test('same id with changed URL fails closed without replacement or sibling close', async () => {
  const state = fixture({ initialTargets: [{ ...target, url: sibling.url }, sibling] });
  const result = await runPostSettlementClose(args, state.deps);
  assert.equal(result.status, 'target_identity_mismatch');
  assert.equal(result.close_attempt_count, 0);
  assert.deepEqual(state.openedIds(), []);
});

test('one dispatched close without fresh absence proof is close_unconfirmed', async () => {
  const state = fixture({ remainingTargets: [target, sibling] });
  const result = await runPostSettlementClose(args, state.deps);
  assert.equal(result.status, 'close_unconfirmed');
  assert.equal(result.close_attempt_count, 1);
  assert.equal(state.closeCalls(), 1);
});

test('post-dispatch census failure preserves close_unconfirmed and count one', async () => {
  const state = fixture({ remainingCensusThrows: true });
  const result = await runPostSettlementClose(args, state.deps);
  assert.equal(result.status, 'close_unconfirmed');
  assert.equal(result.close_attempt_count, 1);
  assert.equal(state.closeCalls(), 1);
  assert.match(result.reason ?? '', /fresh_absence_census_failed/u);
});

test('a close transport error is still one attempt and requires fresh absence proof', async () => {
  const state = fixture({ closeThrows: true, remainingTargets: [target, sibling] });
  const result = await runPostSettlementClose(args, state.deps);
  assert.equal(result.status, 'close_unconfirmed');
  assert.equal(result.close_attempt_count, 1);
  assert.equal(state.closeCalls(), 1);
});

test('preserved eligible direct result receives witnesses only before any prior cleanup', () => {
  const causalWitness = {
    user_message_id: 'user-1',
    assistant_message_id: 'assistant-1',
    relation: 'reply_to' as const,
    source: 'service' as const,
  };
  const targetWitness = directResult().post_settlement_target as Record<string, unknown>;
  const capture = {
    config: {
      profile,
      cdp,
      profileKey,
      repositoryFullName: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1266,
    },
    causalWitness,
    targetWitness: targetWitness as any,
  };
  const eligible = {
    ...directResult(),
    state: 'recovery_required',
    scope: 'conversation',
    cause: 'direct_publication_receipt_invalid',
    witness: undefined,
    post_settlement_target: undefined,
  };
  const rewritten = rewritePreservedTurnResult(eligible, capture);
  assert.deepEqual(rewritten.witness, causalWitness);
  assert.deepEqual(rewritten.post_settlement_target, targetWitness);
  for (const ineligible of [
    { ...eligible, cleanup: 'confirmed' },
    { ...eligible, post_settlement_target_capture: { status: 'unavailable', cause: 'timeout' } },
    { ...eligible, cause: 'generic_recovery_required' },
  ]) {
    assert.deepEqual(rewritePreservedTurnResult(ineligible, capture), ineligible);
  }
});

test('production browser release awaits capture hook before disconnect', async () => {
  const order: string[] = [];
  let releaseCapture!: () => void;
  const capture = new Promise<void>((resolve) => { releaseCapture = resolve; });
  const browser = {
    [BEFORE_CDP_BROWSER_RELEASE]: async () => {
      order.push('capture-start');
      await capture;
      order.push('capture-fixed');
    },
    close: async () => { order.push('disconnect'); },
  };
  const release = releaseCdpBrowser(browser);
  await Promise.resolve();
  assert.deepEqual(order, ['capture-start']);
  releaseCapture();
  await release;
  assert.deepEqual(order, ['capture-start', 'capture-fixed', 'disconnect']);
});

test('enhanced production probe entrypoint is read-only and enriches two observations', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const calls: string[] = [];
  try {
    const code = await runEnhancedPageProbeCli([
      'export',
      '--cdp', cdp,
      '--target-id', String(target.id),
      '--role', 'assistant',
      '--ordinal', '0',
      '--message-id', 'assistant-1',
      '--representation', 'innerText',
      '--expected-byte-length', String(replyBytes.byteLength),
      '--expected-sha256', replySha,
      '--output', '/tmp/reply-1266.txt',
      '--profile', profile,
    ], {
      runProbe: async (parsed) => {
        calls.push(parsed.operation);
        if (parsed.operation === 'export') return {
          ...probeResult(),
          configured_profile_key: undefined,
          normalized_url: undefined,
          assistant_message_id: undefined,
          output_identity: undefined,
          observed_user_nodes: undefined,
          observed_assistant_nodes: undefined,
          observed_message_nodes: undefined,
          last_assistant: undefined,
          last_message: undefined,
          output: '/tmp/reply-1266.txt',
        };
        return {
          schema: 'browser-gpt-page-probe/v1',
          operation: 'inspect',
          status: 'ok',
          diagnostic_only: true,
          workflow_authority: 'none',
          target_id: target.id,
          snapshot: {
            page_url: target.url,
            observed_user_nodes: 1,
            observed_assistant_nodes: 1,
            observed_message_nodes: 2,
            generation_in_progress: false,
            nodes_truncated: false,
            nodes: [
              { role: 'user', ordinal: 0, document_ordinal: 0, message_id: 'user-1' },
              {
                role: 'assistant',
                ordinal: 0,
                document_ordinal: 1,
                message_id: 'assistant-1',
                innerText: { byte_length: replyBytes.byteLength, sha256: replySha },
              },
            ],
          },
        };
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, ['export', 'inspect']);
    const emitted = JSON.parse(String(stdout.mock.calls.at(-1)?.[0] ?? '{}')) as Record<string, unknown>;
    assert.equal(emitted.workflow_authority, 'none');
    assert.equal(emitted.configured_profile_key, profileKey);
    assert.equal(emitted.last_message, true);
  } finally {
    stdout.mockRestore();
  }
});
