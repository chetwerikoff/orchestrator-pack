import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import { runProcess } from './kernel/subprocess.ts';
import {
  buildExportExpression,
  ACQUISITION_READINESS_INTERVAL_MS,
  ACQUISITION_READINESS_TIMEOUT_MS,
  CDP_REQUEST_TIMEOUT_MS,
  HARVEST_EXPRESSION,
  INSPECTION_EXPRESSION,
  LIVENESS_EXPRESSION,
  LIVENESS_FAN_OUT,
  LIVENESS_TARGET_TIMEOUT_MS,
  LIVENESS_TOTAL_TIMEOUT_MS,
  MAX_NORMALIZED_URL_CODE_POINTS,
  MAX_TARGETS,
  normalizeConversationUrl,
  parseCliArgs,
  publishExactBytes,
  runProbe,
  summarizeText,
  toCompatibleTargets,
  type CdpTarget,
  type ProbeDependencies,
  type PublishOperations,
} from './browser-gpt-page-probe.ts';
import { configuredProfileKey } from './chatgpt-browser-turn/storage-common.ts';
import {
  admitStateLightTurnObservation,
  readStateLightTurnObservation,
  transitionStateLightTurnObservation,
} from './chatgpt-browser-turn/state-light-turn-observation.ts';
import { publishStateLightReply } from './chatgpt-browser-turn/state-light-turn.ts';

class FakeNode {
  readonly innerText: string;
  readonly textContent: string;
  readonly attrs: Record<string, string>;

  constructor(role: string, innerText: string, textContent: string, attrs: Record<string, string> = {}) {
    this.innerText = innerText;
    this.textContent = textContent;
    this.attrs = { 'data-message-author-role': role, ...attrs };
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  closest(_selector: string): FakeNode {
    return this;
  }

  querySelector(selector: string): object | null {
    if (selector.includes('copy-turn-action-button')
      || selector.includes('good-response-turn-action-button')
      || selector.includes('bad-response-turn-action-button')) return {};
    return null;
  }
}

async function evaluateExpression(expression: string, nodes: FakeNode[], generating = false, pageUrl = 'https://chatgpt.com/c/test', readyState: 'loading' | 'interactive' | 'complete' = 'complete'): Promise<any> {
  const document = {
    title: 'Fixture title',
    readyState,
    querySelectorAll(selector: string) {
      assert.equal(selector, '[data-message-author-role]');
      return nodes;
    },
    querySelector(selector: string) {
      assert.match(selector, /stop-button/);
      return generating ? {} : null;
    },
  };
  return await runInNewContext(expression, {
    document,
    location: { href: pageUrl },
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Array,
    Map,
    Math,
    JSON,
    atob,
  });
}

function deps(overrides: Partial<ProbeDependencies> = {}): ProbeDependencies {
  return {
    listTargets: async () => [{
      id: 'target-1',
      type: 'page',
      url: 'https://chatgpt.com/c/test?temporary=1#bottom',
      title: 'Fixture title',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/target-1',
    }],
    evaluate: async (_target, expression) => await evaluateExpression(expression, [
      new FakeNode('user', 'Question', 'Question', { 'data-message-id': 'u-1' }),
      new FakeNode('assistant', 'Visible answer', 'hidden-prefix Visible answer', { 'data-message-id': 'a-1', 'data-testid': 'conversation-turn-2' }),
    ]),
    publish: async () => {},
    ...overrides,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

test('normalizes only the address and preserves exact conversation identity', () => {
  assert.equal(
    normalizeConversationUrl('https://CHATGPT.com/c/abc/?temporary-chat=true#bottom'),
    'https://chatgpt.com/c/abc',
  );
});

test('closed CLI rejects arbitrary selectors, JavaScript, watch mode, and ambiguous page selection', () => {
  assert.throws(() => parseCliArgs(['watch', '--cdp', 'http://127.0.0.1:9222']), /unknown_operation/);
  assert.throws(() => parseCliArgs(['list', '--cdp', 'not-a-url']), /invalid_cdp_url/);
  assert.throws(() => parseCliArgs(['inspect', '--cdp', 'http://127.0.0.1:9222', '--selector', 'body']), /unknown_option/);
  assert.throws(() => parseCliArgs(['inspect', '--cdp', 'http://127.0.0.1:9222', '--target-id', 'x', '--url', 'https://chatgpt.com/c/x']), /exactly_one_page_selector_required/);
  assert.throws(() => parseCliArgs(['export', '--cdp', 'http://127.0.0.1:9222', '--target-id', 'x', '--role', 'assistant', '--ordinal', '0', '--representation', 'innerText', '--expected-byte-length', '1', '--expected-sha256', 'a'.repeat(64), '--output', '/tmp/x', '--javascript', 'alert(1)']), /unknown_option/);
  assert.deepEqual(
    parseCliArgs(['inspect', '--cdp', 'http://127.0.0.1:9222', '--url', 'https://chatgpt.com/c/x', '--open-if-missing', 'true']),
    { operation: 'inspect', cdp: 'http://127.0.0.1:9222', conversationUrl: 'https://chatgpt.com/c/x', openIfMissing: true },
  );
  assert.throws(() => parseCliArgs(['inspect', '--cdp', 'http://127.0.0.1:9222', '--url', 'https://chatgpt.com/c/x', '--open-if-missing', 'false']), /open_if_missing_must_be_true/);
  assert.throws(() => parseCliArgs(['inspect', '--cdp', 'http://127.0.0.1:9222', '--target-id', 'x', '--open-if-missing', 'true']), /open_if_missing_requires_url/);
  assert.deepEqual(parseCliArgs(['liveness', '--cdp', 'http://127.0.0.1:9222']), { operation: 'liveness', cdp: 'http://127.0.0.1:9222' });
  assert.deepEqual(
    parseCliArgs(['harvest', '--cdp', 'http://127.0.0.1:9222', '--profile', '/tmp/profile', '--invocation-id', 'inv-1', '--output', '/tmp/out']),
    { operation: 'harvest', cdp: 'http://127.0.0.1:9222', profile: '/tmp/profile', invocationId: 'inv-1', output: '/tmp/out' },
  );
  assert.throws(
    () => parseCliArgs(['harvest', '--cdp', 'http://127.0.0.1:9222', '--profile', '/tmp/profile', '--invocation-id', 'inv-1', '--output', '/tmp/out', '--url', 'https://chatgpt.com/c/x']),
    /unknown_option/,
  );
});

test('target listing is bounded, passive, and excludes unrelated pages', async () => {
  let evaluateCalls = 0;
  const targets: CdpTarget[] = Array.from({ length: MAX_TARGETS + 7 }, (_, index) => ({
    id: `t-${index}`,
    type: 'page' as const,
    url: `https://chatgpt.com/c/${index}`,
    title: `Title ${index}`,
    webSocketDebuggerUrl: `ws://example/${index}`,
  }));
  targets.push({ id: 'other', type: 'page', url: 'https://example.com/private', title: 'Private' });
  const result = await runProbe({ operation: 'list', cdp: 'http://127.0.0.1:9222' }, deps({
    listTargets: async () => targets,
    createPage: async () => { createCalls += 1; throw new Error('must_not_create'); },
    closePage: async () => { closeCalls += 1; return 'closed'; },
    evaluate: async (_target, expression) => {
      evaluateCalls += 1;
      assert.equal(expression, LIVENESS_EXPRESSION);
      return { status: 'ok', ready_state: 'interactive' };
    },
  }));
  assert.equal(result.status, 'ok');
  assert.equal((result.targets as unknown[]).length, MAX_TARGETS);
  assert.equal(result.targets_truncated, true);
  assert.equal(result.observed_compatible_targets, MAX_TARGETS + 7);
  assert.equal(evaluateCalls, 0);
  assert.ok(!(JSON.stringify(result).includes('example.com/private')));
});
