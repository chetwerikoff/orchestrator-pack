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
  INSPECTION_EXPRESSION,
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

test('Duplicate message IDs are not promoted to exact identities', async () => {
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
  const value = `${'ğŸ˜€'.repeat(170)}middle${'x'.repeat(170)}`;
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

test('URL-bound inspection fails when the page navigates, while target-ID inspection remainqÌ‰½Õ¹Ñ¼Ñ¡”•á…ĞÑ…É•Ğœ°…Íå¹Œ€ ¤€ôøì(€½¹ÍĞµ½Ù•‘UÉ°€ô€¡ÑÑÁÌè¼½¡…ÑÁĞ¹½´½Œ½µ½Ù•œì(€½¹ÍĞ•Ù…±Õ…Ñ”€ô…Íå¹Œ€¡}Ñ…É•Ğè…¹ä°•áÁÉ•ÍÍ¥½¸èÍÑÉ¥¹œ¤€ôø…İ…¥Ğ•Ù…±Õ…Ñ•áÁÉ•ÍÍ¥½¸¡•áÁÉ•ÍÍ¥½¸°l(€€€¹•Ü…­•9½‘” ÕÍ•Èœ°€EÕ•ÍÑ¥½¸œ°€EÕ•ÍÑ¥½¸œ¤°(€€€¹•Ü…­•9½‘” …ÍÍ¥ÍÑ…¹Ğœ°€¹Íİ•Èœ°€¹Íİ•Èœ¤°(€t°™…±Í”°µ½Ù•‘UÉ°¤ì((€…İ…¥Ğ…ÍÍ•ÉĞ¹É•©•ÑÌ (€€€ÉÕ¹AÉ½‰”¡ì½Á•É…Ñ¥½¸è€¥¹ÍÁ•Ğœ°‘Àè€¡ÑÑÀè¼¼ÄÈÜ¸À¸À¸ÄèäÈÈÈœ°½¹Ù•ÉÍ…Ñ¥½¹UÉ°è€¡ÑÑÁÌè¼½¡…ÑÁĞ¹½´½Œ½Ñ•ÍĞœô°‘•ÁÌ¡ì•Ù…±Õ…Ñ”ô¤¤°(€€€€¡•ÉÉ½Èè…¹ä¤€ôø•ÉÉ½È¹ÍÑ…ÑÕÌ€ôôô€¹½Ñ}™½Õ¹œ€˜˜•ÉÉ½È¹É•…Í½¸€ôôô€Ñ…É•Ñ}ÕÉ±}¡…¹•œ°(€€¤ì((€½¹ÍĞÉ•ÍÕ±Ğ€ô…İ…¥ĞÉÕ¹AÉ½‰” (€€€ì½Á•É…Ñ¥½¸è€¥¹ÍÁ•Ğœ°‘Àè€¡ÑÑÀè¼¼ÄÈÜ¸À¸À¸ÄèäÈÈÈœ°Ñ…É•Ñ%è€Ñ…É•Ğ´Äœô°(€€€‘•ÁÌ¡ì•Ù…±Õ…Ñ”ô¤°(€€¤ì(€…ÍÍ•ÉĞ¹•ÅÕ…°¡É•ÍÕ±Ğ¹ÍÑ…ÑÕÌ°€½¬œ¤ì(€…ÍÍ•ÉĞ¹•ÅÕ…° ¡É•ÍÕ±Ğ¹Í¹…ÁÍ¡½Ğ…Ì…¹ä¤¹Á…•}ÕÉ°°µ½Ù•‘UÉ°¤ì)ô¤ì()Ñ•ÍĞ •¹•É…Ñ¥½¸½‰Í•ÉÙ…Ñ¥½¸‘•É…‘•ÌÑ¼Õ¹­¹½İ¸İ¡•¸Ñ¡”™¥á•µ…É­•ÈÅÕ•Éä…¹¹½Ğ‰”¥¹Ñ•ÉÁÉ•Ñ•œ°…Íå¹Œ€ ¤€ôøì(€½¹ÍĞ‘½Õµ•¹Ğ€ôì(€€€Ñ¥Ñ±”è€¥áÑÕÉ”Ñ¥Ñ±”œ°(€€€ÅÕ•ÉåM•±•Ñ½É±°è€ ¤€ôøm¹•Ü…­•9½‘” …ÍÍ¥ÍÑ…¹Ğœ°€¹Íİ•Èœ°€¹Íİ•Èœ¥t°(€€€ÅÕ•ÉåM•±•Ñ½Èè€ ¤€ôøìÑ¡É½Ü¹•ÜÉÉ½È ¡…¹•ÍÕÉ™…”œ¤ìô°(€ôì(€½¹ÍĞÙ…±Õ”€ô…İ…¥ĞÉÕ¹%¹9•İ½¹Ñ•áĞ¡%9MAQ%=9}aAIMM%=8°ì(€€€‘½Õµ•¹Ğ°(€€€±½…Ñ¥½¸èì¡É•˜è€¡ÑÑÁÌè¼½¡…ÑÁĞ¹½´½Œ½Ñ•ÍĞœô°(€€€ÉåÁÑ¼èİ•‰ÉåÁÑ¼°(€€€Q•áÑ¹½‘•È°(€€€Q•áÑ•½‘•È°(€€€U¥¹ĞáÉÉ…ä°(€€€ÉÉ…ä°(€€€5…À°(€€€5…Ñ °(€€€)M=8°(€€€…Ñ½ˆ°(€ô¤ì(€…ÍÍ•ÉĞ¹•ÅÕ…°¡Ù…±Õ”¹ÍÑ…ÑÕÌ°€½¬œ¤ì(€…ÍÍ•ÉĞ¹•ÅÕ…°¡Ù…±Õ”¹•¹•É…Ñ¥½¹}¥¹}ÁÉ½É•ÍÌ°€Õ¹­¹½İ¸œ¤ì)ô¤ì()Ñ•ÍĞ Ñ¡”…¹½¹¥…°¹Á´•¹ÑÉåÁ½¥¹Ğ•µ¥ÑÌ•á…Ñ±ä½¹”)M=8É•ÍÕ±Ğ±¥¹”œ°…Íå¹Œ€ ¤€ôøì(€½¹ÍĞÉ•Á½I½½Ğ€ô™¥±•UI1Q½A…Ñ ¡¹•ÜUI0 œ¸¸¼œ°¥µÁ½ÉĞ¹µ•Ñ„¹ÕÉ°¤¤ì(€½¹ÍĞÉ•ÍÕ±Ğ€ô…İ…¥ĞÉÕ¹AÉ½•ÍÌ¡ì(€€€½µµ…¹èÁÉ½•ÍÌ¹Á±…Ñ™½É´€ôôô€İ¥¸ÌÈœ€ü€¹Á´¹µœ€è€¹Á´œ°(€€€…ÉÌèlÉÕ¸œ°€œ´µÍ¥±•¹Ğœ°€‰É½İÍ•ÈµÁĞµÁ…”µÁÉ½‰”œ°€œ´´œ°€‰½ÕÌt°(€€€İèÉ•Á½I½½Ğ°(€€€¥¹¡•É¥ÑA…É•¹Ñ¹ØèÑÉÕ”°(€€€Ñ¥µ•½ÕÑ5Ìè€ÌÁ|ÀÀÀ°(€€€…±±½İµÁÑåMÑ‘½ÕĞèÑÉÕ”°(€ô¤ì(€…ÍÍ•ÉĞ¹•ÅÕ…°¡É•ÍÕ±Ğ¹•á¥Ñ½‘”°€ä°É•ÍÕ±Ğ¹ÍÑ‘•ÉÈ¤ì(€½¹ÍĞ±¥¹•Ì€ôÉ•ÍÕ±Ğ¹ÍÑ‘½ÕĞ¹ÑÉ¥µ¹ ¤¹ÍÁ±¥Ğ ½qÈıq¸½Ô¤ì(€…ÍÍ•ÉĞ¹•ÅÕ…°¡±¥¹•Ì¹±•¹Ñ °€Ä°É•ÍÕ±Ğ¹ÍÑ‘½ÕĞ¤ì(€…ÍÍ•ÉĞ¹•ÅÕ…°¡)M=8¹Á…ÉÍ”¡±¥¹•ÍlÁt„¤¹ÍÑ…ÑÕÌ°€¥¹ÁÕÑ}¥¹Ù…±¥œ¤ì)ô¤ì()Ñ•ÍĞ Ñ¡”¥µÁ±•µ•¹Ñ…Ñ¥½¸¡…Ì¹¼‰É½İÍ•ÈµÕÑ…Ñ¥½¸°¡•±Á•È±¥™•å±”°ÍÑ…Ñ”µİÉ¥Ñ”°½ÈÁ½±±¥¹œÁ…Ñ œ°…Íå¹Œ€ ¤€ôøì(€½¹ÍĞÍ½ÕÉ”€ô…İ…¥ĞÉ•…‘¥±”¡¹•ÜUI0 œ¸½‰É½İÍ•ÈµÁĞµÁ…”µÁÉ½‰”¹ÑÌœ°¥µÁ½ÉĞ¹µ•Ñ„¹ÕÉ°¤°€ÕÑ˜àœ¤ì(€™½È€¡½¹ÍĞ™½É‰¥‘‘•¸½˜l(€€€€œ¹±¥¬ œ°€œ¹™½ÕÌ œ°€œ¹ÍÉ½±° œ°€œ¹½Ñ¼ œ°€œ¹É•±½… œ°€œ¹±½Í”¡ìœ°€¹•İA…” œ°(€€€€¡…ÑÁĞµ‰É½İÍ•ÈµÑÕÉ¸œ°€‰É½İÍ•ÈµÑÕÉ¸µÉ•ÕÉÉ•¹”œ°€Í•Ñ%¹Ñ•ÉÙ…° œ°€İ¡¥±”€¡ÑÉÕ”¤œ°(€€€€IÕ¹Ñ¥µ”¹…±±Õ¹Ñ¥½¹=¸œ°€A…”¹¹…Ù¥…Ñ”œ°€%¹ÁÕĞ¹‘¥ÍÁ…Ñ œ°€Q…É•Ğ¹±½Í•Q…É•Ğœ°(€t¤ì(€€€…ÍÍ•ÉĞ¹•ÅÕ…°¡Í½ÕÉ”¹¥¹±Õ‘•Ì¡™½É‰¥‘‘•¸¤°™…±Í”°™½É‰¥‘‘•¸¤ì(€ô)ô¤ì