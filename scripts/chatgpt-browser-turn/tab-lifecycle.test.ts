import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import {
  __testFinalizeTurn,
  __testPublishStateLightReply,
  type CompactTurnResult,
  runStateLightTurn,
} from './state-light-turn.ts';
import { releaseCdpBrowser } from './browser-session.ts';
import { runStateLightEntry } from './state-light-entry.ts';
import { loadChromium } from './ui-adapter.ts';

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

    const reachableOwners = new Set(['runStateLightEntry', 'runStateLightTurn', 'runStateLightSession', 'runCli']);
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
      'contexts:browser-contexts:(activeBrowser as any):enumeratePages',
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
      'pages:context-pages:context:attachPlaywrightContextCdpObservers',
      'pages:context-pages:context:enumeratePages',
      'pages:context-pages:context:runGateBCharacterization',
      'pages:context-pages:ctx:openGateBCharacterizationPage',
      'pages:context-pages:ctx:openTurnPage',
    ].sort());
  });
});
