import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  __testFinalizeTurn,
  __testPublishStateLightReply,
  type CompactTurnResult,
} from './state-light-turn.ts';
import { releaseCdpBrowser } from './browser-session.ts';

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

    const sinks: Array<{ kind: string; file: string; receiver: string }> = [];
    const unknownSinks: string[] = [];
    for (const filePath of files) {
      const source = ts.createSourceFile(
        filePath,
        readFileSync(filePath, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const kind = node.expression.name.text;
          if (['close', 'contexts', 'newContext', 'newPage', 'pages'].includes(kind)) {
            const receiver = node.expression.expression.getText(source);
            sinks.push({ kind, file: relative(repoRoot, filePath), receiver });
            if (!/(page|browser|context|ctx|opened|state|outcome)/i.test(receiver)) {
              unknownSinks.push(`${relative(repoRoot, filePath)}: ${receiver}.${kind}()`);
            }
          }
        }
        node.forEachChild(visit);
      };
      visit(source);
    }

    expect(unresolved).toEqual([]);
    expect(files.size).toBeGreaterThan(1);
    expect(sinks.filter(({ kind }) => kind === 'close')).not.toHaveLength(0);
    expect(sinks.filter(({ kind }) => kind === 'contexts')).not.toHaveLength(0);
    expect(sinks.filter(({ kind }) => kind === 'newPage')).not.toHaveLength(0);
    expect(sinks.filter(({ kind }) => kind === 'newContext')).toEqual([]);
    expect(unknownSinks).toEqual([]);
  });
});
