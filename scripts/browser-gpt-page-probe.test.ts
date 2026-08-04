import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import { runProcess } from './kernel/subprocess.ts';
import {
  buildExportExpression,
  CDP_REQUEST_TIMEOUT_MS,
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

test('target listing rejects oversized target identity and normalized URL metadata', async () => {
  const result = await runProbe({ operation: 'list', cdp: 'http://127.0.0.1:9222' }, deps({
    listTargets: async () => [
      { id: 'x'.repeat(257), type: 'page', url: 'https://chatgpt.com/c/oversized-id', title: 'bad-id' },
      { id: 'valid-id', type: 'page', url: `https://chatgpt.com/c/${'x'.repeat(MAX_NORMALIZED_URL_CODE_POINTS)}`, title: 'bad-url' },
      { id: 'valid', type: 'page', url: 'https://chatgpt.com/c/valid', title: 'valid' },
    ],
  }));
  assert.deepEqual(result.targets, [{ target_id: 'valid', normalized_url: 'https://chatgpt.com/c/valid', title: 'valid' }]);
  assert.equal(result.observed_compatible_targets, 1);
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

test('host rejects malformed successful inspection snapshots instead of fabricating defaults', async () => {
  await assert.rejects(
    runProbe(
      { operation: 'inspect', cdp: 'http://127.0.0.1:9222', targetId: 'target-1' },
      deps({ evaluate: async () => ({ status: 'ok', page_url: 'https://chatgpt.com/c/test', title: 'partial', nodes: [] }) }),
    ),
    (error: any) => error.status === 'surface_unknown' && error.reason === 'malformed_snapshot',
  );
});

test('host rejects over-broad or inconsistent inspection node evidence', async () => {
  const raw = await evaluateExpression(INSPECTION_EXPRESSION, [new FakeNode('assistant', 'Answer', 'Answer', { 'data-message-id': 'a-1' })]);
  raw.nodes[0].attributes['data-testid'] = 'x'.repeat(161);
  await assert.rejects(
    runProbe(
      { operation: 'inspect', cdp: 'http://127.0.0.1:9222', targetId: 'target-1' },
      deps({ evaluate: async () => raw }),
    ),
    (error: any) => error.status === 'surface_unknown' && error.reason === 'malformed_snapshot',
  );
});

test('host rejects cross-field inconsistent inspection summary evidence', async () => {
  const mutations: Array<(raw: any) => void> = [
    (raw) => { raw.nodes[0].innerText.byte_length = 0; },
    (raw) => { raw.nodes[0].innerText.sha256 = '0'.repeat(64); },
    (raw) => { raw.nodes[0].attributes['data-message-author-role'] = 'user'; },
    (raw) => { raw.nodes[0].attributes['data-message-id'] = 'other'; },
    (raw) => { raw.last_assistant_text_byte_length = 0; },
    (raw) => { raw.last_assistant_sha256 = '0'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const raw = await evaluateExpression(
      INSPECTION_EXPRESSION,
      [new FakeNode('assistant', 'Answer', 'Answer', { 'data-message-id': 'a-1' })],
    );
    mutate(raw);
    await assert.rejects(
      runProbe(
        { operation: 'inspect', cdp: 'http://127.0.0.1:9222', targetId: 'target-1' },
        deps({ evaluate: async () => raw }),
      ),
      (error: any) => error.status === 'surface_unknown' && error.reason === 'malformed_snapshot',
    );
  }
});

test('host accepts ignored unsupported roles before, between, and after observed messages', async () => {
  const layouts = [
    {
      nodes: [
        new FakeNode('tool', 'Tool', 'Tool'),
        new FakeNode('user', 'Question', 'Question', { 'data-message-id': 'u-1' }),
        new FakeNode('assistant', 'Answer', 'Answer', { 'data-message-id': 'a-1' }),
      ],
      documentOrdinals: [1, 2],
    },
    {
      nodes: [
        new FakeNode('user', 'Question', 'Question', { 'data-message-id': 'u-1' }),
        new FakeNode('tool', 'Tool', 'Tool'),
        new FakeNode('assistant', 'Answer', 'Answer', { 'data-message-id': 'a-1' }),
      ],
      documentOrdinals: [0, 2],
    },
    {
      nodes: [
        new FakeNode('user', 'Question', 'Question', { 'data-message-id': 'u-1' }),
        new FakeNode('assistant', 'Answer', 'Answer', { 'data-message-id': 'a-1' }),
        new FakeNode('tool', 'Tool', 'Tool'),
      ],
      documentOrdinals: [0, 1],
    },
  ];

  for (const { nodes, documentOrdinals } of layouts) {
    const result = await runProbe(
      { operation: 'inspect', cdp: 'http://127.0.0.1:9222', targetId: 'target-1' },
      deps({ evaluate: async (_target, expression) => await evaluateExpression(expression, nodes) }),
    );
    assert.equal(result.status, 'ok');
    const snapshot = result.snapshot as any;
    assert.equal(snapshot.observed_user_nodes, 1);
    assert.equal(snapshot.observed_assistant_nodes, 1);
    assert.equal(snapshot.observed_message_nodes, 2);
    assert.deepEqual(Array.from(snapshot.nodes, (node: any) => node.document_ordinal), documentOrdinals);
  }
});

test('host accepts internally consistent long bounded summary evidence', async () => {
  const value = `${'😀'.repeat(170)}tail`;
  const result = await runProbe(
    { operation: 'inspect', cdp: 'http://127.0.0.1:9222', targetId: 'target-1' },
    deps({
      evaluate: async (_target, expression) => await evaluateExpression(
        expression,
        [new FakeNode('assistant', value, value, { 'data-message-id': 'a-1' })],
      ),
    }),
  );
  assert.equal(result.status, 'ok');
  const snapshot = result.snapshot as any;
  assert.equal(snapshot.nodes[0].innerText.code_point_length, 174);
  assert.equal(Array.from(snapshot.nodes[0].innerText.head).length, 160);
  assert.equal(Array.from(snapshot.nodes[0].innerText.tail).length, 160);
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

test('host re-binds exported bytes and identity to the caller inspection witness before publication', async () => {
  const expected = 'hidden-prefix Visible answer';
  const different = 'self-consistent but different';
  let publishCalls = 0;
  await assert.rejects(
    runProbe({
      operation: 'export',
      cdp: 'http://127.0.0.1:9222',
      targetId: 'target-1',
      role: 'assistant',
      ordinal: 0,
      messageId: 'a-1',
      representation: 'textContent',
      expectedByteLength: Buffer.byteLength(expected),
      expectedSha256: sha256(expected),
      output: '/unused/output.txt',
    }, deps({
      evaluate: async () => ({
        status: 'ok',
        page_url: 'https://chatgpt.com/c/test',
        role: 'assistant',
        ordinal: 0,
        document_ordinal: 1,
        message_id: 'a-1',
        representation: 'textContent',
        byte_length: Buffer.byteLength(different),
        sha256: sha256(different),
        text: different,
      }),
      publish: async () => { publishCalls++; },
    })),
    (error: any) => error.status === 'stale_node' && error.reason === 'inspection_witness_mismatch',
  );
  assert.equal(publishCalls, 0);
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

test('existing, symlinked, directory, and special output targets are refused without modification', async () => {
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

  if (process.platform === 'win32') return;
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

test('legacy inspection preserves readable loading snapshots outside acquired readiness', async () => {
  const loadingNodes = [
    new FakeNode('user', 'Question', 'Question', { 'data-message-id': 'u-loading' }),
    new FakeNode('assistant', 'Answer', 'Answer', { 'data-message-id': 'a-loading' }),
  ];
  const evaluate = async (_target: any, expression: string) => await evaluateExpression(
    expression,
    loadingNodes,
    false,
    'https://chatgpt.com/c/test',
    'loading',
  );

  const byId = await runProbe(
    { operation: 'inspect', cdp: 'http://127.0.0.1:9222', targetId: 'target-1' },
    deps({ evaluate }),
  );
  assert.equal(byId.status, 'ok');
  assert.equal((byId.snapshot as any).ready_state, 'loading');

  const byUrl = await runProbe(
    { operation: 'inspect', cdp: 'http://127.0.0.1:9222', conversationUrl: 'https://chatgpt.com/c/test' },
    deps({ evaluate }),
  );
  assert.equal(byUrl.status, 'ok');
  assert.equal((byUrl.snapshot as any).ready_state, 'loading');
});

test('generation observation degrades to unknown when the fixed marker query cannot be interpreted', async () => {
  const document = {
    title: 'Fixture title',
    querySelectorAll: () => [new FakeNode('assistant', 'Answer', 'Answer')],
    querySelector : () => { throw new Error('changed surface'); },
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

test('contract proof: owner isolation and deadline-isolated liveness', async () => {
  const requested = 'https://chat.openai.com/c/proof';
  const ownedId = 'created-proof';
  const closeCalls: string[] = [];
  let sample = 0;
  let fakeNow = 0;
  const createdTarget: CdpTarget = {
    id: ownedId,
    type: 'page',
    url: requested,
    title: 'Created proof',
    webSocketDebuggerUrl: `ws://example/${ownedId}`,
  };
  const acquired = await runProbe({
    operation: 'inspect',
    cdp: 'http://127.0.0.1:9222',
    conversationUrl: requested,
    openIfMissing: true,
  }, deps({
    listTargets: async () => [],
    createPage: async () => createdTarget,
    closePage: async (_cdp, targetId) => { closeCalls.push(targetId); return 'closed'; },
    now: () => fakeNow,
    sleep: async (delay) => { fakeNow += delay; },
    evaluate: async (_target, expression) => {
      assert.equal(expression, INSPECTION_EXPRESSION);
      sample += 1;
      return sample === 1
        ? await evaluateExpression(INSPECTION_EXPRESSION, [], false, requested)
        : await evaluateExpression(INSPECTION_EXPRESSION, [
          new FakeNode('user', 'Question', 'Question', { 'data-message-id': 'u-proof' }),
          new FakeNode('assistant', 'Answer', 'Answer', { 'data-message-id': 'a-proof' }),
        ], false, requested);
    },
  }));
  assert.equal(acquired.status, 'ok');
  assert.equal(acquired.acquisition, 'created');
  assert.equal(acquired.owned_target_id, ownedId);
  assert.deepEqual(closeCalls, [ownedId]);

  const reusedCloseCalls: string[] = [];
  const reused = await runProbe({
    operation: 'inspect',
    cdp: 'http://127.0.0.1:9222',
    conversationUrl: 'https://chatgpt.com/c/reused',
    openIfMissing: true,
  }, deps({
    listTargets: async () => [{
      id: 'reused', type: 'page', url: 'https://chatgpt.com/c/reused', title: 'Reused',
      webSocketDebuggerUrl: 'ws://example/reused',
    }],
    closePage: async (_cdp, targetId) => { reusedCloseCalls.push(targetId); return 'closed'; },
    evaluate: async (_target, expression) => await evaluateExpression(expression, [
      new FakeNode('user', 'Question', 'Question', { 'data-message-id': 'u-reused' }),
      new FakeNode('assistant', 'Answer', 'Answer', { 'data-message-id': 'a-reused' }),
    ], false, 'https://chatgpt.com/c/reused'),
  }));
  assert.equal(reused.acquisition, 'reused');
  assert.deepEqual(reusedCloseCalls, []);

  const starts: string[] = [];
  const settled: string[] = [];
  const evaluateCalls: string[] = [];
  let settledBeforeAllStarted = false;
  let mutations = 0;
  const livenessTargets: CdpTarget[] = Array.from({ length: LIVENESS_FAN_OUT }, (_, index) => ({
    id: `live-${index}`,
    type: 'page',
    url: `https://chatgpt.com/c/live-${index}`,
    title: `Live ${index}`,
    webSocketDebuggerUrl: `ws://example/live-${index}`,
  }));
  const liveness = await runProbe({ operation: 'liveness', cdp: 'http://127.0.0.1:9222' }, deps({
    listTargets: async () => livenessTargets,
    evaluate: async (target, expression) => {
      assert.equal(expression, LIVENESS_EXPRESSION);
      starts.push(target.target_id);
      evaluateCalls.push(target.target_id);
      if (target.target_id === 'live-0') return await new Promise<never>(() => {});
      return Promise.resolve({ status: 'ok', ready_state: 'complete' }).then((value) => {
        if (starts.length < LIVENESS_FAN_OUT) settledBeforeAllStarted = true;
        settled.push(target.target_id);
        return value;
      });
    },
    createPage: async () => { mutations += 1; return createdTarget; },
    closePage: async () => { mutations += 1; return 'closed'; },
  }));
  assert.equal(liveness.status, 'ok');
  assert.equal(CDP_REQUEST_TIMEOUT_MS + LIVENESS_TARGET_TIMEOUT_MS < LIVENESS_TOTAL_TIMEOUT_MS, true);
  assert.equal((liveness.targets as unknown[]).length, LIVENESS_FAN_OUT);
  assert.equal(starts.length, LIVENESS_FAN_OUT);
  assert.deepEqual(liveness.unresponsive_target_ids, ['live-0']);
  assert.equal((liveness.targets as any[]).every((row) => row.liveness !== 'not_started'), true);
  assert.equal(mutations, 0);
  assert.equal(settled.length, LIVENESS_FAN_OUT - 1);
  assert.equal(settledBeforeAllStarted, false);
  const observedRows = liveness.targets as Array<{ target_id: string; liveness: string }>;
  const observedSettledTargetIds = observedRows.filter((row) => row.liveness !== 'unresponsive').map((row) => row.target_id);
  const observedUnresponsiveTargetIds = starts.filter((targetId) => !settled.includes(targetId));
  assert.deepEqual([...observedSettledTargetIds].sort(), [...settled].sort());
  assert.deepEqual(liveness.unresponsive_target_ids, observedUnresponsiveTargetIds);
  assert.equal(evaluateCalls.length - starts.length, 0);
  const proof = {
    schema: 'browser-gpt-page-probe-contract-proof/v1',
    result: 'owner-isolation-and-liveness-deadline-isolation',
    created_target_id: ownedId,
    close_calls: closeCalls,
    reused_close_calls: reusedCloseCalls,
    admitted_target_ids: starts,
    started_target_ids: starts,
    settled_target_ids: [...observedSettledTargetIds, ...observedUnresponsiveTargetIds],
    admitted_target_count: starts.length,
    settled_target_count: observedRows.length,
    unresponsive_target_ids: observedUnresponsiveTargetIds,
    retry_count: evaluateCalls.length - starts.length,
    diagnostic_only: true,
    workflow_authority: 'none',
  };
  process.stdout.write(`${JSON.stringify(proof)}\n`);
});

test('acquisition rejects redirect and malformed creation, while exposing cleanup failure', async () => {
  const requested = 'https://chat.openai.com/c/redirect';
  const createdTarget: CdpTarget = {
    id: 'owned-redirect', type: 'page', url: requested, title: 'Owned',
    webSocketDebuggerUrl: 'ws://example/owned-redirect',
  };
  const closeCalls: string[] = [];
  await assert.rejects(
    runProbe({ operation: 'inspect', cdp: 'http://127.0.0.1:9222', conversationUrl: requested, openIfMissing: true }, deps({
      listTargets: async () => [],
      createPage: async () => createdTarget,
      closePage: async (_cdp, targetId) => { closeCalls.push(targetId); return 'closed'; },
      evaluate: async (_target, expression) => await evaluateExpression(expression, [
        new FakeNode('user', 'Question', 'Question', { 'data-message-id': 'u-redirect' }),
      ], false, 'https://chatgpt.com/c/redirect'),
    })),
    (error: any) => error.status === 'surface_unknown'
      && error.reason === 'conversation_identity_mismatch'
      && error.details?.cleanup === 'closed',
  );
  assert.deepEqual(closeCalls, ['owned-redirect']);

  let malformedCloseCalls = 0;
  await assert.rejects(
    runProbe({ operation: 'inspect', cdp: 'http://127.0.0.1:9222', conversationUrl: 'https://chatgpt.com/c/malformed', openIfMissing: true }, deps({
      listTargets: async () => [],
      createPage: async () => [createdTarget, createdTarget],
      closePage: async () => { malformedCloseCalls += 1; return 'closed'; },
    })),
    (error: any) => error.status === 'unavailable' && error.reason === 'create_result_ambiguous',
  );
  assert.equal(malformedCloseCalls, 0);

  let samples = 0;
  await assert.rejects(
    runProbe({ operation: 'inspect', cdp: 'http://127.0.0.1:9222', conversationUrl: 'https://chatgpt.com/c/cleanup', openIfMissing: true }, deps({
      listTargets: async () => [],
      createPage: async () => ({ ...createdTarget, id: 'owned-cleanup', url: 'https://chatgpt.com/c/cleanup' }),
      closePage: async () => { throw new Error('refused'); },
      now: () => samples * 250,
      sleep: async () => { samples += 1; },
      evaluate: async (_target, expression) => await evaluateExpression(expression, [
        new FakeNode('user', 'Question', 'Question', { 'data-message-id': 'u-cleanup' }),
      ], false, 'https://chatgpt.com/c/cleanup'),
    })),
    (error: any) => error.status === 'cleanup_failed' && error.details?.cleanup === 'cleanup_failed',
  );
});

test('acquired readiness accepts stable user nodes across interactive to complete', async () => {
  const requested = 'https://chatgpt.com/c/interactive-complete';
  const createdTarget: CdpTarget = {
    id: 'owned-interactive-complete',
    type: 'page',
    url: 'about:blank',
    title: 'Loading',
    webSocketDebuggerUrl: 'ws://example/owned-interactive-complete',
  };
  const readyStates: Array<'interactive' | 'complete'> = ['interactive', 'complete'];
  let evaluateCalls = 0;
  const closeCalls: string[] = [];

  const result = await runProbe({
    operation: 'inspect',
    cdp: 'http://127.0.0.1:9222',
    conversationUrl: requested,
    openIfMissing: true,
  }, deps({
    listTargets: async () => [],
    createPage: async () => createdTarget,
    closePage: async (_cdp, targetId) => {
      closeCalls.push(targetId);
      return 'closed';
    },
    evaluate: async (_target, expression) => {
      const readyState = readyStates[Math.min(evaluateCalls++, readyStates.length - 1)]!;
      return evaluateExpression(expression, [
        new FakeNode('user', 'Question', 'Question', { 'data-message-id': 'u-transition' }),
        new FakeNode('assistant', 'Answer', 'Answer', { 'data-message-id': 'a-transition' }),
      ], false, requested, readyState);
    },
  }));

  assert.equal(result.status, 'ok');
  assert.equal(evaluateCalls, 2);
  assert.equal((result.snapshot as any).ready_state, 'complete');
  assert.deepEqual(closeCalls, [createdTarget.id]);
});

test('created ownership survives transient URLs and rejects contradictory target IDs', async () => {
  const requested = 'https://chatgpt.com/c/transient';
  const closeCalls: string[] = [];
  const acquired = await runProbe({
    operation: 'inspect', cdp: 'http://127.0.0.1:9222', conversationUrl: requested, openIfMissing: true,
  }, deps({
    listTargets: async () => [],
    createPage: async () => ({
      id: 'created-transient', type: 'page', url: 'about:blank', title: 'Loading',
      webSocketDebuggerUrl: 'ws://example/created-transient',
    }),
    closePage: async (_cdp, targetId) => { closeCalls.push(targetId); return 'closed'; },
    evaluate: async (_target, expression) => evaluateExpression(expression, [
      new FakeNode('user', 'Question', 'Question', { 'data-message-id': 'u-transient' }),
      new FakeNode('assistant', 'Answer', 'Answer', { 'data-message-id': 'a-transient' }),
    ], false, requested),
  }));
  assert.equal(acquired.status, 'ok');
  assert.deepEqual(closeCalls, ['created-transient']);

  const contradictoryCloseCalls: string[] = [];
  await assert.rejects(
    runProbe({
      operation: 'inspect', cdp: 'http://127.0.0.1:9222', conversationUrl: 'https://chatgpt.com/c/contradictory', openIfMissing: true,
    }, deps({
      listTargets: async () => [{ id: 'foreign', type: 'page', url: 'about:blank', title: 'Foreign' }],
      createPage: async () => ({
        id: 'foreign', type: 'page', url: 'https://chatgpt.com/c/contradictory', title: 'Foreign',
        webSocketDebuggerUrl: 'ws://example/foreign',
      }),
      closePage: async (_cdp, targetId) => { contradictoryCloseCalls.push(targetId); return 'closed'; },
    })),
    (error: any) => error.status === 'unavailable' && error.reason === 'create_result_contradictory',
  );
  assert.deepEqual(contradictoryCloseCalls, []);
});

test('acquisition rejects collisions with pre-existing non-page target IDs without cleanup', async () => {
  const closeCalls: string[] = [];
  await assert.rejects(
    runProbe({
      operation: 'inspect',
      cdp: 'http://127.0.0.1:9222',
      conversationUrl: 'https://chatgpt.com/c/non-page-collision',
      openIfMissing: true,
    }, deps({
      listTargets: async () => [{
        id: 'foreign-worker',
        type: 'service_worker',
        url: 'https://chatgpt.com/c/non-page-collision',
      }],
      createPage: async () => ({
        id: 'foreign-worker',
        type: 'page',
        url: 'https://chatgpt.com/c/non-page-collision',
        title: 'Contradictory',
        webSocketDebuggerUrl: 'ws://example/foreign-worker',
      }),
      closePage: async (_cdp, targetId) => {
        closeCalls.push(targetId);
        return 'closed';
      },
    })),
    (error: any) => error.status === 'unavailable' && error.reason === 'create_result_contradictory',
  );
  assert.deepEqual(closeCalls, []);
});

test('acquisition reports already_gone after successful inspection and exact owner cleanup', async () => {
  const ownedId = 'owned-already-gone';
  const closeCalls: string[] = [];
  const result = await runProbe({
    operation: 'inspect',
    cdp: 'http://127.0.0.1:9222',
    conversationUrl: 'https://chatgpt.com/c/already-gone',
    openIfMissing: true,
  }, deps({
    listTargets: async () => [],
    createPage: async () => ({
      id: ownedId,
      type: 'page',
      url: 'about:blank',
      title: 'Loading',
      webSocketDebuggerUrl: `ws://example/${ownedId}`,
    }),
    closePage: async (_cdp, targetId) => {
      closeCalls.push(targetId);
      return 'already_gone';
    },
    evaluate: async (_target, expression) => await evaluateExpression(expression, [
      new FakeNode('user', 'Question', 'Question', { 'data-message-id': 'u-already-gone' }),
      new FakeNode('assistant', 'Answer', 'Answer', { 'data-message-id': 'a-already-gone' }),
    ], false, 'https://chatgpt.com/c/already-gone'),
  }));

  assert.equal(result.status, 'ok');
  assert.equal(result.cleanup, 'already_gone');
  assert.equal(result.owned_target_id, ownedId);
  assert.deepEqual(closeCalls, [ownedId]);
});

test('readiness rejects loading documents at the bounded deadline', async () => {
  let sample = 0;
  await assert.rejects(
    runProbe({
      operation: 'inspect', cdp: 'http://127.0.0.1:9222', conversationUrl: 'https://chatgpt.com/c/loading', openIfMissing: true,
    }, deps({
      listTargets: async () => [],
      createPage: async () => ({
        id: 'loading', type: 'page', url: 'about:blank', title: 'Loading',
        webSocketDebuggerUrl: 'ws://example/loading',
      }),
      closePage: async () => 'closed',
      now: () => sample * 250,
      sleep: async () => { sample += 1; },
      evaluate: async (_target, expression) => evaluateExpression(expression, [
        new FakeNode('user', 'Question', 'Question'),
        new FakeNode('assistant', 'Answer', 'Answer'),
      ], false, 'https://chatgpt.com/c/loading', 'loading'),
    })),
    (error: any) => error.status === 'surface_unknown' && error.reason === 'readiness_timeout',
  );
});

test('production-shaped liveness evaluation timeout is unresponsive', async () => {
  const result = await runProbe({ operation: 'liveness', cdp: 'http://127.0.0.1:9222' }, deps({
    listTargets: async () => [{
      id: 'hung', type: 'page', url: 'https://chatgpt.com/c/hung', title: 'Hung',
      webSocketDebuggerUrl: 'ws://example/hung',
    }],
    evaluate: async () => { throw new Error('cdp_evaluate_timeout'); },
  }));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.unresponsive_target_ids, ['hung']);
  assert.equal((result.targets as any[])[0].reason, 'liveness_target_timeout');
});

test('liveness reports unavailable targets and truncation without mutation', async () => {
  let evaluateCalls = 0;
  const result = await runProbe({ operation: 'liveness', cdp: 'http://127.0.0.1:9222' }, deps({
    listTargets: async () => [
      { id: 'without-ws', type: 'page', url: 'https://chatgpt.com/c/without-ws', title: 'No WS' },
      { id: 'with-ws', type: 'page', url: 'https://chatgpt.com/c/with-ws', title: 'With WS', webSocketDebuggerUrl: 'ws://example/with-ws' },
    ],
    evaluate: async (_target, expression) => { evaluateCalls += 1; assert.equal(expression, LIVENESS_EXPRESSION); return { status: 'ok', ready_state: 'interactive' }; },
  }));
  assert.equal(result.status, 'ok');
  assert.deepEqual((result.targets as any[]).map((row) => row.liveness), ['unavailable', 'responsive']);
  assert.equal((result.targets as any[])[0].reason, 'target_websocket_unavailable');
  assert.equal(result.targets_truncated, false);
  assert.equal(evaluateCalls, 1);
});

test('the canonical npm entrypoint emits exactly one JSON result line', async () => {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const result = await runProcess({
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['run', '--silent', 'browser-gpt-page-probe', '--', 'bogus'],
    cwd: repoRoot,
    inheritParentEnv: true,
    timeoutMs: 30_000,
    allowEmptyStdout: true,
  });
  assert.equal(result.exitCode, 9, result.stderr);
  const lines = result.stdout.trimEnd().split(/\r?\n/u);
  assert.equal(lines.length, 1, result.stdout);
  assert.equal(JSON.parse(lines[0]!).status, 'input_invalid');
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
