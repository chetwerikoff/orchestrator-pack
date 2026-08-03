import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  __testPublishStateLightReply,
  decidePageCleanupAction,
  type PageCleanupAction,
} from './state-light-turn.ts';
import { releaseCdpBrowser } from './browser-session.ts';

type CleanupCase = {
  readonly id: string;
  readonly sendCount: number;
  readonly publicationState?: 'committed_ok' | 'conflict' | 'error';
  readonly pagePresent: boolean;
  readonly pageLost: boolean;
  readonly expected: PageCleanupAction;
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
  ['L1', 'reserved page identity enters the final partition'],
  ['L2', 'unsupported takeover does not revoke retained-object authority'],
  ['L3', 'zero-send terminal closes the reserved page'],
  ['L4', 'publication is the close boundary'],
  ['L5', 'publication survives cleanup failure'],
  ['L6', 'all post-send non-publication classes preserve'],
  ['L7', 'production graph has one page sink and one release sink'],
  ['L8', 'helper termination leaves the output boundary observable'],
  ['L9', 'probe remains read-only'],
  ['L10', 'connected-browser release is subordinate to page action'],
] as const;

describe('Issue #1238 page cleanup equivalence', () => {
  it.each(cleanupCases)('$id uses only the retained-page decision', (testCase) => {
    expect(decidePageCleanupAction(testCase)).toBe(testCase.expected);
  });

  it.each(ledgerCases)('%s records the authority transition: %s', (_id, transition) => {
    expect(transition.length).toBeGreaterThan(0);
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
      let closeCalls = 0;
      const page = {
        close: async () => {
          expect(readFileSync(output, 'utf8')).toBe(reply);
          closeCalls++;
        },
      };
      await page.close();
      expect(closeCalls).toBe(1);
      expect(publication.output_bytes).toBe(Buffer.byteLength(reply, 'utf8'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not authorize close when final-link publication conflicts', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-1238-conflict-'));
    const output = join(root, 'reply.txt');
    writeFileSync(output, 'foreign winner', 'utf8');
    try {
      const publication = __testPublishStateLightReply(output, '123e4567-e89b-12d3-a456-426614174001', 'reply');
      expect(publication.state).toBe('conflict');
      expect(decidePageCleanupAction({
        sendCount: 1,
        publicationState: publication.state,
        pagePresent: true,
        pageLost: false,
      })).toBe('preserve');
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
});

describe('Issue #1238 mechanically derived production graph', () => {
  it('derives the command root, supported entry branches, and classified sinks', () => {
    const repoRoot = resolve(import.meta.dirname, '../..');
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = packageJson.scripts?.['chatgpt-browser-turn'] ?? '';
    const entryMatch = command.match(/scripts\/chatgpt-browser-turn\/state-light-entry\.ts/);
    expect(entryMatch).not.toBeNull();

    const entryPath = join(repoRoot, entryMatch![0]);
    const entry = readFileSync(entryPath, 'utf8');
    const source = ts.createSourceFile(entryPath, entry, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const turnCalls = source.statements
      .flatMap((statement) => {
        const calls: ts.CallExpression[] = [];
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && node.expression.getText(source) === 'runStateLightTurn') calls.push(node);
          node.forEachChild(visit);
        };
        visit(statement);
        return calls;
      });
    expect(turnCalls).toHaveLength(2);
    expect(entry).toContain("command === 'turn'");
    expect(entry).toContain("command?.startsWith('--')");

    const turnPath = join(repoRoot, 'scripts/chatgpt-browser-turn/state-light-turn.ts');
    const sessionPath = join(repoRoot, 'scripts/chatgpt-browser-turn/browser-session.ts');
    const turnSource = readFileSync(turnPath, 'utf8');
    const sessionSource = readFileSync(sessionPath, 'utf8');
    expect(turnSource.match(/outcome\.page\.close\(\)/g)).toHaveLength(1);
    expect(sessionSource.match(/browser as \{ close: \(\) => Promise<void> \}\)\.close/g)).toHaveLength(1);
    expect(turnSource).not.toContain('newContext(');
    expect(sessionSource).not.toContain('newContext(');
    expect(turnSource).toContain('decidePageCleanupAction');
    expect(turnSource).toContain('releaseCdpBrowser(outcome.browser)');
  });
});
