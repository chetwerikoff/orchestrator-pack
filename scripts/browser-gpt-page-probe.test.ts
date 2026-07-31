import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import {
  buildExportExpression,
  INSPECTION_EXPRESSION,
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

class FakeNode {
  readonly innerText: string;
  readonly textContent: string;
  readonly attrs: Record<string, string>;

  constructor(role: 'user' | 'assistant', innerText: string, textContent: string, attrs: Record<string, string> = {}) {
    this.innerText = innerText;
    this.textContent = textContent;
    this.attrs = { 'data-message-author-role': role, ...attrs };
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
}

async function evaluateExpression(expression: string, nodes: FakeNode[], generating = false, pageUrl = 'https://chatgpt.com/c/test'): Promise<any> {
  const document = {
    title: 'Fixture title',
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
});

test('target listing is bounded, passive, and excludes unrelated pages', async () => {
  let evaluateCalls = 0;
  const targets: CdpTarget[] = Array.from({ length: MAX_TARGETS + 7 }, (_, index) => ({
    id: `t-${index}`,
    type: 'page',
    url: `https://chatgpt.com/c/${index}`,
    title: `Title ${index}`,
    webSocketDebuggerUrl: `ws://example/${index}`,
  }));
  targets.push({ id: 'other', type: 'page', url: 'https://example.com/private', title: 'Private' });
  const result = await runProbe({ operation: 'list', cdp: 'http://127.0.0.1:9222' }, deps({
    listTargets: async () => targets,
    evaluate: async () => { evaluateCalls++; throw new Error('must not attach'); },
  }));
  assert.equal(result.status, 'ok');
  assert.equal((result.targets as unknown[]).length, MAX_TARGETS);
  assert.equal(result.targets_truncated, true);
  assert.equal(result.observed_compatible_targets, MAX_TARGETS + 7);
  assert.equal(evaluateCalls, 0);
  assert.ok(!(JSON.stringify(result).includes('example.com/private')));
});

test('URL targeting fails closed on zero and duplicate exact normalized matches', async () => {
  await assert.rejects(
    runProbe({ operation: 'inspect', cdp: 'http://127.0.0.1:9222', conversationUrl: 'https://chatgpt.com/c/missing' }, deps()),
    (error: any) => error.status === 'not_found',
  );
  await assert.rejects(
    runProbe({ operation: 'inspect', cdp: 'http://127.0.0.1:9222', conversationUrl: 'https://chatgpt.com/c/test' }, deps({
      listTargets: async () => [
        { id: 'a', type: 'page', url: 'https://chatgpt.com/c/test', webSocketDebuggerUrl: 'ws://a' },
        { id: 'b', type: 'page', url: 'https://chatgpt.com/c/test?x=1', webSocketDebuggerUrl: 'ws://b' },
      ],
    })),
    (error: any) => error.status === 'ambiguous',
  );
});

test('inspection keeps innerText and textContent distinct and emits bounded witnesses', async () => {
  const nodes = [
    new FakeNode('user', 'Question', 'Question', { 'data-message-id': 'u-1' }),
    new FakeNode('assistant', 'Visible answer', 'hidden-prefix Visible answer', {
      'data-message-id': 'a-1',
      'data-testid': 'conversation-turn-2',
      'data-ignored-secret': 'must-not-appear',
    }),
  ];
  const raw = await evaluateExpression(INSPECTION_EXPRESSION, nodes, false);
  assert.equal(raw.status, 'ok');
  assert.equal(raw.generation_in_progress, false);
  assert.equal(raw.observed_user_nodes, 1);
  assert.equal(raw.observed_assistant_nodes, 1);
  assert.notEqual(raw.nodes[1].innerText.byte_length, raw.nodes[1].textContent.byte_length);
  assert.notEqual(raw.nodes[1].innerText.sha256, raw.nodes[1].textContent.sha256);
  assert.equal(raw.nodes[1].message_id, 'a-1');
  assert.equal(raw.nodes[1].attributes['data-message-id'], 'a-1');
  assert.equal(raw.nodes[1].attributes['data-ignored-secret'], undefined);
  assert.equal(raw.last_assistant_sha256, sha256('Visible answer'));
});

test('missing message structure stays surface_unknown rather than fabricating zero counts', async () => {
  const raw = await evaluateExpression(INSPECTION_EXPRESSION, []);
  assert.equal(raw.status, 'surface_unknown');
  assert.equal(raw.reason, 'message_nodes_missing');
});

test('duplicate message IDs are not promoted to exact identities', async () => {
  const raw = await evaluateExpression(INSPECTION_EXPRESSION, [
    new FakeNode('assistant', 'one', 'one', { 'data-message-id': 'dup' }),
    new FakeNode('assistant', 'two', 'two', { 'data-message-id': 'dup' }),
  ]);
  assert.equal(raw.nodes[0].message_id, null);
  assert.equal(raw.nodes[0].message_id_unique, false);
  assert.equal(raw.nodes[1].message_id, null);
});

test('export revalidates exact representation bytes and refuses stale or under-specified witnesses', async () => {
  const nodes = [new FakeNode('assistant', 'Visible', 'hidden Visible', { 'data-message-id': 'a-1' })];
  const exact = await evaluateExpression(buildExportExpression({
    role: 'assistant',
    ordinal: 0,
    messageId: 'a-1',
    representation: 'textContent',
    expectedByteLength: Buffer.byteLength('hidden Visible'),
    expectedSha256: sha256('hidden Visible'),
  }), nodes);
  assert.equal(exact.status, 'ok');
  assert.equal(exact.text, 'hidden Visible');

  const stale = await evaluateExpression(buildExportExpression({
    role: 'assistant',
    ordinal: 0,
    messageId: 'a-1',
    representation: 'textContent',
    expectedByteLength: Buffer.byteLength('changed'),
    expectedSha256: sha256('changed'),
  }), nodes);
  assert.equal(stale.status, 'stale_node');
  assert.equal(stale.reason, 'representation_witness_mismatch');

  const missingId = await evaluateExpression(buildExportExpression({
    role: 'assistant',
    ordinal: 0,
    representation: 'innerText',
    expectedByteLength: Buffer.byteLength('Visible'),
    expectedSha256: sha256('Visible'),
  }), nodes);
  assert.equal(missingId.status, 'stale_node');
  assert.equal(missingId.reason, 'message_id_required');
});

test('successful export writes only one exact selected representation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'probe-export-'));
  const destination = join(directory, 'node.txt');
  const value = 'hidden-prefix Visible answer';
  const result = await runProbe({
    operation: 'export',
    cdp: 'http://127.0.0.1:9222',
    targetId: 'target-1',
    role: 'assistant',
    ordinal: 0,
    messageId: 'a-1',
    representation: 'textContent',
    expectedByteLength: Buffer.byteLength(value),
    expectedSha256: sha256(value),
    output: destination,
  }, deps({ publish: publishExactBytes }));
  assert.equal(result.status, 'ok');
  assert.equal(await readFile(destination, 'utf8'), value);
  assert.equal(result.sha256, sha256(value));
  assert.equal(result.byte_length, Buffer.byteLength(value));
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600);
});

test('existing, symlinked, directory, and special output targets are refused without modification', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'probe-unsafe-'));
  const existing = join(directory, 'existing.txt');
  await writeFile(existing, 'original');
  await assert.rejects(publishExactBytes(existing, Buffer.from('replacement')), (error: any) => error.status === 'unsafe_output');
  assert.equal(await readFile(existing, 'utf8'), 'original');

  const targetFile = join(directory, 'target.txt');
  await writeFile(targetFile, 'target');
  const link = join(directory, 'link.txt');
  await symlink(targetFile, link);
  await assert.rejects(publishExactBytes(link, Buffer.from('replacement')), (error: any) => error.status === 'unsafe_output');
  assert.equal(await readFile(targetFile, 'utf8'), 'target');

  const outputDirectory = join(directory, 'output-dir');
  await mkdir(outputDirectory);
  await assert.rejects(publishExactBytes(outputDirectory, Buffer.from('replacement')), (error: any) => error.status === 'unsafe_output');

  if (process.platform === 'win32') {
    t.diagnostic('Unix-domain socket special-target fixture is not available on Windows');
    return;
  }
  const socketPath = join(directory, 'socket');
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    await assert.rejects(
      publishExactBytes(socketPath, Buffer.from('replacement')),
      (error: any) => error.status === 'unsafe_output',
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('a post-create write failure removes the incomplete artifact', async () => {
  const calls: string[] = [];
  const fakeHandle = {
    stat: async () => ({ isFile: () => true }),
    write: async () => { throw new Error('injected_write_failure'); },
    sync: async () => {},
    close: async () => { calls.push('close'); },
  };
  const ops = {
    lstat: async (path: any) => {
      if (String(path).endsWith('/parent')) return { isDirectory: () => true };
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    },
    open: async () => fakeHandle,
    unlink: async () => { calls.push('unlink'); },
  } as unknown as PublishOperations;
  await assert.rejects(
    publishExactBytes('/parent/output.txt', Buffer.from('bytes'), ops),
    (error: any) => error.status === 'export_failed',
  );
  assert.deepEqual(calls, ['close', 'unlink']);
});

test('the fixed browser expressions contain no mutation or arbitrary-evaluation surface', () => {
  for (const expression of [INSPECTION_EXPRESSION, buildExportExpression({
    role: 'assistant', ordinal: 0, representation: 'innerText', expectedByteLength: 0, expectedSha256: '0'.repeat(64),
  })]) {
    for (const forbidden of ['.click(', '.focus(', '.scroll', '.remove(', '.append(', '.submit(', 'location.href =', 'window.open(', 'Runtime.evaluate']) {
      assert.equal(expression.includes(forbidden), false, forbidden);
    }
  }
});

test('summaries bound heads and tails by Unicode code points', () => {
  const value = `${'😀'.repeat(170)}middle${'x'.repeat(170)}`;
  const summary = summarizeText(value);
  assert.equal(Array.from(summary.head).length, 160);
  assert.equal(Array.from(summary.tail).length, 160);
  assert.equal(summary.sha256, sha256(value));
});

test('compatible target conversion never exposes websocket URLs in list-facing metadata by itself', () => {
  const converted = toCompatibleTargets([
    { id: 'one', type: 'page', url: 'https://chatgpt.com/c/one', title: 'One', webSocketDebuggerUrl: 'ws://secret' },
    { id: 'two', type: 'page', url: 'https://example.com', title: 'Other', webSocketDebuggerUrl: 'ws://other' },
  ]);
  assert.equal(converted.length, 1);
  assert.equal(converted[0]?.target_id, 'one');
});


test('inspect preserves exact aggregate counts while bounding node summaries', async () => {
  const nodes: FakeNode[] = [];
  for (let index = 0; index < MAX_TARGETS + 75; index++) {
    const role = index % 2 === 0 ? 'user' : 'assistant';
    nodes.push(new FakeNode(role, `${role}-${index}`, `${role}-${index}`, { 'data-message-id': `m-${index}` }));
  }
  const result = await runProbe(
    { operation: 'inspect', cdp: 'http://127.0.0.1:9222', targetId: 'target-1' },
    deps({ evaluate: async (_target, expression) => await evaluateExpression(expression, nodes) }),
  );
  assert.equal(result.status, 'ok');
  const snapshot = result.snapshot as any;
  assert.equal(snapshot.observed_message_nodes, nodes.length);
  assert.equal(snapshot.observed_user_nodes + snapshot.observed_assistant_nodes, nodes.length);
  assert.equal(snapshot.nodes.length, 100);
  assert.equal(snapshot.nodes_truncated, true);
  assert.equal(snapshot.nodes[0].document_ordinal, nodes.length - 100);
});

test('URL-bound inspection fails when the page navigates, while target-ID inspection remains bound to the exact target', async () => {
  const movedUrl = 'https://chatgpt.com/c/moved';
  const evaluate = async (_target: any, expression: string) => await evaluateExpression(expression, [
    new FakeNode('user', 'Question', 'Question'),
    new FakeNode('assistant', 'Answer', 'Answer'),
  ], false, movedUrl);

  await assert.rejects(
    runProbe({ operation: 'inspect', cdp: 'http://127.0.0.1:9222', conversationUrl: 'https://chatgpt.com/c/test' }, deps({ evaluate })),
    (error: any) => error.status === 'not_found' && error.reason === 'target_url_changed',
  );

  const result = await runProbe(
    { operation: 'inspect', cdp: 'http://127.0.0.1:9222', targetId: 'target-1' },
    deps({ evaluate }),
  );
  assert.equal(result.status, 'ok');
  assert.equal((result.snapshot as any).page_url, movedUrl);
});

test('generation observation degrades to unknown when the fixed marker query cannot be interpreted', async () => {
  const document = {
    title: 'Fixture title',
    querySelectorAll: () => [new FakeNode('assistant', 'Answer', 'Answer')],
    querySelector: () => { throw new Error('changed surface'); },
  };
  const value = await runInNewContext(INSPECTION_EXPRESSION, {
    document,
    location: { href: 'https://chatgpt.com/c/test' },
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
  assert.equal(value.status, 'ok');
  assert.equal(value.generation_in_progress, 'unknown');
});

test('the implementation has no browser mutation, helper lifecycle, state-write, or polling path', async () => {
  const source = await readFile(new URL('./browser-gpt-page-probe.ts', import.meta.url), 'utf8');
  for (const forbidden of [
    '.click(', '.focus(', '.scroll(', '.goto(', '.reload(', '.close({', 'newPage(',
    'chatgpt-browser-turn', 'browser-turn-recurrence', 'setInterval(', 'while (true)',
    'Runtime.callFunctionOn', 'Page.navigate', 'Input.dispatch', 'Target.closeTarget',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
