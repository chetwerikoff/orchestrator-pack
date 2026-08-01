import { describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  browserQueue: [] as any[],
  prompt: 'PROMPT',
  nowMs: 10_000,
  appendFileSync: vi.fn((_path: string, _data: string, _encoding: string) => undefined),
  mkdirSync: vi.fn((_path: string, _options?: object) => undefined),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    appendFileSync: runtimeMocks.appendFileSync,
    mkdirSync: runtimeMocks.mkdirSync,
  };
});

vi.mock('./browser-session.ts', () => ({
  RESOURCE_CLEANUP_BOUND_MS: 5_000,
  boundedResourceCleanup: vi.fn(async (cleanup: () => Promise<void>) => {
    await cleanup();
    return 'confirmed';
  }),
  releaseCdpBrowser: vi.fn(async () => undefined),
}));

vi.mock('./coordination.ts', () => ({
  destinationIdentity: vi.fn((path: string) => ({ identity: `identity:${path}`, finalPath: path })),
}));

vi.mock('./input.ts', () => ({
  readStableInput: vi.fn(() => ({
    text: runtimeMocks.prompt,
    bytes: new Uint8Array([...runtimeMocks.prompt].map((char) => char.charCodeAt(0))),
    byteLength: runtimeMocks.prompt.length,
    dev: 1n,
    ino: 1n,
  })),
}));

vi.mock('./ui-adapter.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui-adapter.ts')>();
  return {
    ...actual,
    loadChromium: vi.fn(() => ({
      connectOverCDP: vi.fn(async () => {
        const browser = runtimeMocks.browserQueue.shift();
        if (!browser) throw new Error('no fake browser queued');
        return browser;
      }),
    })),
    productStatusText: vi.fn(async () => ''),
    verifyProfile: vi.fn(async () => ({ state: 'verified', cause: 'verified', evidence: 'test' })),
  };
});

import {
  readAssistantTurnCompletionReady,
  readAssistantTurnGenerating,
} from './ui-adapter.ts';
import {
  ASSISTANT_MESSAGE_SELECTOR,
  ASSISTANT_TURN_ANCESTOR_XPATH,
  COMPOSER_SELECTOR,
  MESSAGE_AUTHOR_ROLE_ATTR,
  MESSAGE_IDENTITY_ATTR,
  MESSAGE_NODE_SELECTOR,
  SEND_BUTTON_SELECTOR,
  matchesStopButtonSelector,
  messageIdentitySelector,
} from './product-page-selectors.ts';
import { browserFor, collectionLocator, messageLocator, scalarLocator, type StateLightTestMessage, type StateLightTestSnapshot } from './state-light-turn.test-fixtures.ts';
import {
  buildObservationHeartbeat,
  classifyOwnedIdentityAdmission,
  classifyPageObservation,
  establishOwnedTailBoundary,
  ownedPromptMatches,
  readPageObservation,
  readTailPageObservation,
  runStateLightTurn,
  replyStabilityMatches,
  replyStabilityFingerprint,
  resolveBoundOwnedWindow,
  type PageNodeObservation,
  type PageObservationResult,
} from './state-light-turn.ts';

function makeTurnContainerPage(options: {
  assistantText: string;
  actionButtonsInTurn: boolean;
  generating?: boolean;
}) {
  const assistant = scalarLocator({
    count: vi.fn(async () => 1),
    getAttribute: vi.fn(async (name: string) => {
      if (name === MESSAGE_AUTHOR_ROLE_ATTR) return 'assistant';
      if (name === 'data-is-streaming') return options.generating ? 'true' : null;
      return null;
    }),
    innerText: vi.fn(async () => options.assistantText),
    locator: vi.fn((selector: string) => {
      if (selector.startsWith('xpath=')) {
        return options.actionButtonsInTurn
          ? scalarLocator({ turnActionButtons: true, count: vi.fn(async () => 1) })
          : scalarLocator({ count: vi.fn(async () => 0) });
      }
      return scalarLocator();
    }),
  });
  const assistants = scalarLocator({
    count: vi.fn(async () => 1),
    nth: vi.fn(() => assistant),
  });
  return {
    locator: vi.fn((selector: string) => {
      if (selector === ASSISTANT_MESSAGE_SELECTOR) return assistants;
      if (matchesStopButtonSelector(selector)) return scalarLocator();
      return scalarLocator();
    }),
    getByText: vi.fn(() => scalarLocator()),
    getByRole: vi.fn(() => scalarLocator()),
  };
}

describe('state-light page observation driver', () => {
  it('treats turn-container action buttons as completion-ready even when absent from the assistant node', async () => {
    const page = makeTurnContainerPage({
      assistantText: 'RETRY-OK',
      actionButtonsInTurn: true,
    });

    await expect(readAssistantTurnGenerating(page)).resolves.toBe(false);
    await expect(readAssistantTurnCompletionReady(page)).resolves.toBe(true);
  });

  it('stays waiting when action buttons are missing from both assistant and turn container', async () => {
    const page = makeTurnContainerPage({
      assistantText: 'RETRY-OK',
      actionButtonsInTurn: false,
    });

    await expect(readAssistantTurnCompletionReady(page)).resolves.toBe(false);
  });
});

describe('state-light prompt attribution classification', () => {
  const baseline = [
    { role: 'user' as const, text: 'OLD' },
    { role: 'assistant' as const, text: 'OLD ANSWER' },
  ];

  it('waits on truncated lazy-render of the owned prompt until the full echo appears', () => {
    const longPrompt = `${'A'.repeat(120)} ${'detail '.repeat(40)}`;
    const truncatedEcho = `${'A'.repeat(20)}`;

    expect(ownedPromptMatches(truncatedEcho, longPrompt)).toBe(false);
    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: truncatedEcho }, { role: 'assistant', text: 'working' }],
      baseline.length,
      longPrompt,
      true,
    )).toEqual({ state: 'waiting' });

    const fullEcho = `${'A'.repeat(120)} ${'detail '.repeat(40)}`;
    expect(ownedPromptMatches(fullEcho, longPrompt)).toBe(true);
    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: fullEcho }, { role: 'assistant', text: 'FINAL', }],
      baseline.length,
      longPrompt,
      false,
    )).toEqual({ state: 'ready', reply: 'FINAL' });
  });

  it('treats a transient duplicate owned user render as waiting, not uncertain', () => {
    expect(classifyPageObservation(
      [
        ...baseline,
        { role: 'user', text: 'PROMPT' },
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: 'working' },
      ],
      baseline.length,
      'PROMPT',
      true,
    )).toEqual({ state: 'waiting' });
  });

  it('does not attribute a matching historical prompt before the send baseline', () => {
    const continuation = [
      { role: 'user' as const, text: 'PROMPT', domIndex: 0 },
      { role: 'assistant' as const, text: 'HISTORICAL', domIndex: 1 },
    ];

    expect(classifyPageObservation(
      continuation,
      continuation.length,
      'PROMPT',
      false,
    )).toEqual({ state: 'waiting' });
  });


  it('captures the owned reply before a later foreign user turn', () => {
    expect(classifyPageObservation(
      [
        ...baseline,
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: 'OWNED ANSWER' },
        { role: 'user', text: 'FOREIGN' },
        { role: 'assistant', text: 'FOREIGN ANSWER' },
      ],
      baseline.length,
      'PROMPT',
      false,
    )).toEqual({ state: 'ready', reply: 'OWNED ANSWER' });
  });

  it('flags genuinely foreign user text as uncertain when no owned reply is ready', () => {
    expect(classifyPageObservation(
      [
        ...baseline,
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: 'partial' },
        { role: 'user', text: 'FOREIGN' },
      ],
      baseline.length,
      'PROMPT',
      true,
    )).toEqual({
      state: 'uncertain',
      cause: 'foreign_user_after_owned_send',
      observedUserHeads: ['FOREIGN'],
    });
  });

  it('never publishes a partial owned reply when a later foreign turn completed', () => {
    expect(classifyPageObservation(
      [
        ...baseline,
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: 'PARTIAL' },
        { role: 'user', text: 'FOREIGN' },
        { role: 'assistant', text: 'FOREIGN COMPLETE' },
      ],
      baseline.length,
      'PROMPT',
      true,
    )).toEqual({
      state: 'uncertain',
      cause: 'foreign_user_after_owned_send',
      observedUserHeads: ['FOREIGN'],
    });
  });

  it('matches owned text when visible echo uses Unicode whitespace separators', () => {
    const prompt = 'helper healthy -> helper-only fast path';
    const withNbsp = 'helper healthy\n\u00A0-> helper-only fast path';
    const withIdeographic = 'helper healthy\u3000-> helper-only fast path';
    const combined = 'helper healthy\n\u00A0\u202F-> helper-only fast path';

    expect(ownedPromptMatches(withNbsp, prompt)).toBe(true);
    expect(ownedPromptMatches(withIdeographic, prompt)).toBe(true);
    expect(ownedPromptMatches(combined, prompt)).toBe(true);
    expect(ownedPromptMatches('helper broken -> other path', prompt)).toBe(false);
  });

  it('matches owned text when markdown and line breaking normalize to the same string', () => {
    const longPrompt = `Problem:\nFlow-manager misclassifies.\n\nGoal:\nFix echo matching.\n${'detail '.repeat(80)}`;
    const rendered = `Problem: Flow-manager misclassifies. Goal: Fix echo matching. ${'detail '.repeat(80)}`.trim();

    expect(ownedPromptMatches(rendered, longPrompt)).toBe(true);
    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: rendered }, { role: 'assistant', text: 'working' }],
      baseline.length,
      longPrompt,
      true,
    )).toEqual({ state: 'waiting' });
  });

  it('rejects partial windows that are not the full normalized prompt', () => {
    const longPrompt = `PREFIX ${'alpha '.repeat(100)}MIDDLE ${'beta '.repeat(100)}SUFFIX`;
    const middleWindow = 'MIDDLE beta beta beta';

    expect(ownedPromptMatches(middleWindow, longPrompt)).toBe(false);
  });

  it('matches owned text only after UI collapse affixes are stripped', () => {
    const prompt = 'Line one. Line two with enough content to exceed minimum overlap requirements for the matcher.';
    const visible = 'Line one. Line two with enough content to exceed minimum overlap requirements for the matcher.';

    expect(ownedPromptMatches(visible, prompt)).toBe(true);
    expect(ownedPromptMatches('Line one. Line two with enough content show more', prompt)).toBe(false);
  });

  it('returns promptly for long genuinely foreign visible text', () => {
    const prompt = `owned ${'detail '.repeat(500)}`;
    const foreign = `FOREIGN ${'noise '.repeat(300)}`;
    const started = performance.now();
    expect(ownedPromptMatches(foreign, prompt)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('accepts a long markdown prompt when the rendered visible text normalizes to the same string', () => {
    const body = Array.from({ length: 520 }, () => 'detail').join(' ');
    const longPrompt = `# Issue #1120 pulse\n\n## OUTPUT CONSTRAINTS\n- Keep answer under 500 words\n- Use \`backticks\` sparingly\n\n${body}`;
    const renderedVisible = `Issue #1120 pulse OUTPUT CONSTRAINTS Keep answer under 500 words Use backticks sparingly ${body}`;

    expect(longPrompt.length).toBeGreaterThanOrEqual(3000);
    expect(renderedVisible.length).toBeGreaterThanOrEqual(3000);
    expect(ownedPromptMatches(renderedVisible, longPrompt)).toBe(true);
    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: renderedVisible }, { role: 'assistant', text: 'working' }],
      baseline.length,
      longPrompt,
      true,
    )).toEqual({ state: 'waiting' });
  });

  it('does not treat genuinely foreign long markdown-adjacent text as owned', () => {
    const prompt = `# Owned\n\n${'owned detail '.repeat(300)}`;
    const foreign = `FOREIGN INTERLOPER ${'noise '.repeat(500)}`;

    expect(prompt.length).toBeGreaterThanOrEqual(3000);
    expect(foreign.length).toBeGreaterThanOrEqual(3000);
    expect(ownedPromptMatches(foreign, prompt)).toBe(false);
    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: foreign }, { role: 'assistant', text: 'working' }],
      baseline.length,
      prompt,
      true,
    )).toEqual({ state: 'waiting' });
  });

  it('rejects textContent with sr-only prefix while rendered innerText matches', () => {
    const prompt = 'Issue #1120 strict-matcher smoke cell OUTPUT CONSTRAINTS Keep answer under 500 words';
    const rendered = prompt;
    const textContentWithSrOnly = `You said: ${rendered}`;

    expect(ownedPromptMatches(rendered, prompt)).toBe(true);
    expect(ownedPromptMatches(textContentWithSrOnly, prompt)).toBe(false);
    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: rendered }, { role: 'assistant', text: 'working' }],
      baseline.length,
      prompt,
      true,
    )).toEqual({ state: 'waiting' });
  });

  it('keeps short prompt strict equality unchanged', () => {
    const prompt = 'PROMPT-SHORT owned echo baseline';
    const visible = 'PROMPT-SHORT owned echo baseline';

    expect(ownedPromptMatches(visible, prompt)).toBe(true);
  });

  it('keeps genuinely unrelated text non-owned', () => {
    const prompt = `owned ${'detail '.repeat(80)}`;
    expect(ownedPromptMatches('FOREIGN INTERLOPER TEXT', prompt)).toBe(false);
  });

  it('does not classify owned truncated renderings as uncertain', () => {
    const longPrompt = `${'A'.repeat(120)} ${'detail '.repeat(40)}`;
    const truncA = `${'A'.repeat(20)}`;
    const truncB = `${'A'.repeat(30)}`;

    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: truncA }, { role: 'assistant', text: 'working' }],
      baseline.length,
      longPrompt,
      true,
    )).toEqual({ state: 'waiting' });
    expect(classifyPageObservation(
      [...baseline, { role: 'user', text: truncB }, { role: 'assistant', text: 'working' }],
      baseline.length,
      longPrompt,
      true,
    )).toEqual({ state: 'waiting' });
  });

  it('never publishes a foreign answer when the owned prompt is not recognized', () => {
    expect(classifyPageObservation(
      [
        ...baseline,
        { role: 'user', text: 'PARTIAL-OWNED' },
        { role: 'user', text: 'FOREIGN' },
        { role: 'assistant', text: 'FOREIGN ANSWER' },
      ],
      baseline.length,
      'FULL-OWNED-PROMPT',
      false,
    )).toEqual({ state: 'waiting' });
  });

  it('treats render-different assistant reads as stable when normalized text matches', () => {
    const body = `${'detail '.repeat(60)} Section footer with enough words.`;
    const renderA = `Intro paragraph.\n\n${body}`;
    const renderB = `Intro paragraph. ${body} show more`;

    expect(replyStabilityMatches(renderB, renderA)).toBe(true);
    expect(replyStabilityMatches(`${renderA} extra tail`, renderA)).toBe(false);
  });

  it('treats large mid-body length swings as stable when head and tail fingerprints match', () => {
    const head = `INTRO ${'A'.repeat(180)}`;
    const tail = `${'Z'.repeat(180)} OUTRO`;
    const longRead = `${head}${'M'.repeat(4500)}${tail}`;
    const shortRead = `${head}${'M'.repeat(200)}${tail}`;

    expect(replyStabilityFingerprint(longRead)).toBe(replyStabilityFingerprint(shortRead));
    expect(replyStabilityMatches(longRead, shortRead)).toBe(true);
    expect(longRead.length - shortRead.length).toBeGreaterThan(1000);
  });
});

describe('observation heartbeat', () => {
  it('builds a machine-greppable heartbeat payload', () => {
    const heartbeat = buildObservationHeartbeat(
      { state: 'ready', reply: 'FINAL' },
      1,
      4,
      true,
      'FINAL',
    );
    expect(heartbeat).toMatchObject({
      schema: 'observation-heartbeat/v1',
      poll_count: 4,
      observation_state: 'ready_unstable',
      stable_reads: 1,
      completion_ready: true,
      last_reply_length: 5,
    });
    expect(heartbeat.last_reply_sha256_head).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('readPageObservation transcript reads', () => {
  it('marks transcript incomplete when a mid-list node read throws but still returns later nodes', async () => {
    const messages = [
      { role: 'user' as const, text: 'ONE' },
      { role: 'assistant' as const, text: 'A1' },
      { role: 'user' as const, text: 'PROMPT' },
      { role: 'assistant' as const, text: 'FINAL' },
    ];
    let observationPass = 0;
    const page = {
      locator: vi.fn((selector: string) => {
        if (selector !== MESSAGE_NODE_SELECTOR) return scalarLocator();
        return scalarLocator({
          count: vi.fn(async () => messages.length),
          nth: vi.fn((index: number) => {
            const message = messages[index]!;
            if (index === 1) {
              return scalarLocator({
                count: vi.fn(async () => 1),
                getAttribute: vi.fn(async (name: string) => {
                  if (observationPass === 0) throw new Error('locator.getAttribute: Timeout');
                  if (name === MESSAGE_AUTHOR_ROLE_ATTR) return message.role;
                  return null;
                }),
                innerText: vi.fn(async () => message.text),
                textContent: vi.fn(async () => message.text),
              });
            }
            return messageLocator(message);
          }),
        });
      }),
    };

    const first = await readPageObservation(page);
    observationPass += 1;
    expect(first.transcriptIncomplete).toBe(true);
    expect(first.messages.some((m) => m.role === 'user' && m.text === 'PROMPT')).toBe(true);

    const second = await readPageObservation(page);
    expect(second.transcriptIncomplete).toBe(false);
    expect(second.messages).toHaveLength(4);
  });
});


describe('bounded pre-send tail observation', () => {
  it('reads only the last-user suffix on a long continuation with unreadable distant history', async () => {
    const messageCount = 1_202;
    const accessed: number[] = [];
    const page = {
      locator: vi.fn((selector: string) => {
        const selectedIdentity = independentlyDecodeMessageIdentitySelector(selector);
        if (selectedIdentity === 'tail-user') {
          return collectionLocator([{ role: 'user', text: '', identity: 'tail-user' }]);
        }
        if (selector !== MESSAGE_NODE_SELECTOR) return scalarLocator();
        return scalarLocator({
          count: vi.fn(async () => messageCount),
          nth: vi.fn((index: number) => {
            accessed.push(index);
            if (index < 1_200) throw new Error('distant history must not be read');
            return messageLocator(index === 1_200
              ? { role: 'user', text: '', identity: 'tail-user' }
              : { role: 'assistant', text: '', identity: 'tail-assistant' });
          }),
        });
      }),
    };

    const first = await readTailPageObservation(page, false);
    const second = await readTailPageObservation(page, false);

    expect(accessed).toEqual([1_201, 1_200, 1_201, 1_200]);
    expect(first.nodeCount).toBe(messageCount);
    expect(establishOwnedTailBoundary(first, second, false)).toEqual({
      kind: 'anchor',
      anchorIdentity: 'tail-user',
      suffix: [
        { role: 'user', identity: 'tail-user' },
        { role: 'assistant', identity: 'tail-assistant' },
      ],
    });
  });
});
function identityObservation(
  nodes: readonly PageNodeObservation[],
  nodeListReadFailed = false,
  tailAnchorExactState: 'ok' | 'missing' | 'unresolved' | 'changed' = 'ok',
): PageObservationResult {
  return {
    ...(nodes.some((node) => node.role === 'user')
      ? { tailAnchorExactResolution: { state: tailAnchorExactState } }
      : {}),
    nodes: [...nodes],
    messages: nodes.flatMap((node) => node.role
      ? [{
          role: node.role,
          text: node.text,
          ...(node.identity ? { identity: node.identity } : {}),
          domIndex: node.domIndex,
        }]
      : []),
    ownedWindowCompletionReady: false,
    transcriptIncomplete: nodeListReadFailed || nodes.some(
      (node) => node.roleReadFailed || (node.role !== undefined && node.textReadFailed),
    ),
    nodeListReadFailed,
  };
}

function identityNode(
  domIndex: number,
  role: 'user' | 'assistant',
  text: string,
  identity?: string,
): PageNodeObservation {
  return {
    domIndex,
    role,
    ...(identity ? { identity } : {}),
    text,
    roleReadFailed: false,
    identityReadFailed: false,
    textReadFailed: false,
  };
}

const unreadableHistoricalNode: PageNodeObservation = {
  domIndex: 0,
  text: '',
  roleReadFailed: true,
  identityReadFailed: true,
  textReadFailed: true,
};

function decodeCssStringToken(value: string): string | undefined {
  let decoded = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === '"' || char === '\n' || char === '\r' || char === '\f') {
      return undefined;
    }
    if (char !== '\\') {
      decoded += char;
      continue;
    }
    index += 1;
    if (index >= value.length) return undefined;
    const escaped = value[index]!;
    if (/[0-9a-f]/iu.test(escaped)) {
      let hex = escaped;
      while (
        hex.length < 6
        && index + 1 < value.length
        && /[0-9a-f]/iu.test(value[index + 1]!)
      ) {
        index += 1;
        hex += value[index]!;
      }
      if (index + 1 < value.length && /\s/u.test(value[index + 1]!)) index += 1;
      const codePoint = Number.parseInt(hex, 16);
      decoded += codePoint === 0 ? '\uFFFD' : String.fromCodePoint(codePoint);
      continue;
    }
    if (escaped === '\n' || escaped === '\r' || escaped === '\f') return undefined;
    decoded += escaped;
  }
  return decoded;
}

function independentlyDecodeMessageIdentitySelector(selector: string): string | undefined {
  const prefix = `[${MESSAGE_AUTHOR_ROLE_ATTR}][${MESSAGE_IDENTITY_ATTR}="`;
  if (!selector.startsWith(prefix) || !selector.endsWith('"]')) return undefined;
  return decodeCssStringToken(selector.slice(prefix.length, -2));
}
describe('state-light owned message identity', () => {
  it('builds an exact opaque selector accepted by an independent selector decoder', () => {
    const identity = 'opaque"\\[]\u0001\u007f"][data-message-author-role="assistant';
    const selector = messageIdentitySelector(identity);
    expect(independentlyDecodeMessageIdentitySelector(selector)).toBe(identity);

    const malformed = `[${MESSAGE_AUTHOR_ROLE_ATTR}][${MESSAGE_IDENTITY_ATTR}="${identity}"]`;
    expect(independentlyDecodeMessageIdentitySelector(malformed)).toBeUndefined();
  });

  it('establishes a stable tail anchor while ignoring unreadable distant history', () => {
    const first = identityObservation([
      unreadableHistoricalNode,
      identityNode(1, 'user', 'OLD PROMPT', 'old-user'),
      identityNode(2, 'assistant', 'OLD ANSWER', 'old-assistant'),
    ]);
    const second = identityObservation([
      unreadableHistoricalNode,
      identityNode(1, 'user', 'OLD PROMPT', 'old-user'),
      identityNode(2, 'assistant', 'OLD ANSWER', 'old-assistant'),
    ]);

    expect(establishOwnedTailBoundary(first, second, false)).toEqual({
      kind: 'anchor',
      anchorIdentity: 'old-user',
      suffix: [
        { role: 'user', identity: 'old-user' },
        { role: 'assistant', identity: 'old-assistant' },
      ],
    });
  });

  it('falls back when the anchor suffix is not fully readable', () => {
    const stable = identityObservation([
      identityNode(0, 'user', 'OLD PROMPT', 'old-user'),
      identityNode(1, 'assistant', 'OLD ANSWER', 'old-assistant'),
    ]);
    const unreadableSuffix = identityObservation([
      identityNode(0, 'user', 'OLD PROMPT', 'old-user'),
      {
        ...identityNode(1, 'assistant', 'OLD ANSWER', 'old-assistant'),
        identityReadFailed: true,
      },
    ]);

    expect(establishOwnedTailBoundary(stable, unreadableSuffix, false)).toEqual({
      kind: 'text_fallback',
      cause: 'stable_tail_suffix_unreadable',
    });
  });

  it('admits the unique post-tail identity without comparing rendered prompt text', () => {
    const boundary = {
      kind: 'anchor' as const,
      anchorIdentity: 'old-user',
      suffix: [
        { role: 'user' as const, identity: 'old-user' },
        { role: 'assistant' as const, identity: 'old-assistant' },
      ],
    };
    const observation = identityObservation([
      unreadableHistoricalNode,
      identityNode(1, 'user', 'OLD PROMPT', 'old-user'),
      identityNode(2, 'assistant', 'OLD ANSWER', 'old-assistant'),
      identityNode(3, 'user', 'Rendered text differs from input markdown', 'owned-user'),
    ]);

    expect(classifyOwnedIdentityAdmission(boundary, observation)).toEqual({
      state: 'candidate',
      identity: 'owned-user',
    });
  });

  it('fails admission immediately when two post-tail user nodes exist, including identityless nodes', () => {
    const boundary = { kind: 'fresh' as const };
    const observation = identityObservation([
      identityNode(0, 'user', 'OWNED', 'owned-user'),
      identityNode(1, 'user', 'FOREIGN'),
    ]);

    expect(classifyOwnedIdentityAdmission(boundary, observation)).toEqual({
      state: 'unresolved',
      immediate: true,
    });
  });

  it('uses the fresh-chat sentinel after two zero-user snapshots and ignores a historical greeting', () => {
    const first = identityObservation([
      identityNode(0, 'assistant', 'How can I help?', 'greeting'),
    ]);
    const second = identityObservation([
      identityNode(0, 'assistant', 'How can I help?', 'greeting'),
    ]);
    const boundary = establishOwnedTailBoundary(first, second, true);
    expect(boundary).toEqual({ kind: 'fresh' });

    const postSend = identityObservation([
      identityNode(0, 'assistant', 'How can I help?', 'greeting'),
      identityNode(1, 'user', 'VISIBLE OWNED PROMPT', 'owned-user'),
    ]);
    expect(classifyOwnedIdentityAdmission(boundary, postSend)).toEqual({
      state: 'candidate',
      identity: 'owned-user',
    });
  });

  it('marks an identityless single candidate for bounded strict-text fallback', () => {
    expect(classifyOwnedIdentityAdmission(
      { kind: 'fresh' },
      identityObservation([identityNode(0, 'user', 'VISIBLE OWNED PROMPT')]),
    )).toEqual({ state: 'identityless' });
  });

  it('re-resolves a recreated bound node and closes the owned window at the next user', () => {
    const recreated = identityObservation([
      unreadableHistoricalNode,
      identityNode(1, 'user', 'VISIBLE OWNED PROMPT', 'owned-user'),
      identityNode(2, 'assistant', 'OWNED ANSWER', 'owned-assistant'),
      identityNode(3, 'user', 'FOREIGN', 'foreign-user'),
      identityNode(4, 'assistant', 'FOREIGN ANSWER', 'foreign-assistant'),
    ]);

    expect(resolveBoundOwnedWindow(
      recreated,
      'owned-user',
    )).toEqual({
      state: 'ok',
      messages: [
        {
          role: 'user',
          text: 'VISIBLE OWNED PROMPT',
          identity: 'owned-user',
          domIndex: 1,
        },
        {
          role: 'assistant',
          text: 'OWNED ANSWER',
          identity: 'owned-assistant',
          domIndex: 2,
        },
      ],
      boundUserDomIndex: 1,
      lastAssistantDomIndex: 2,
    });
  });

  it('fails closed on duplicate or non-user nodes under the bound identity', () => {
    const duplicate = identityObservation([
      identityNode(0, 'user', 'VISIBLE OWNED PROMPT', 'owned-user'),
      identityNode(1, 'user', 'VISIBLE OWNED PROMPT', 'owned-user'),
    ]);
    expect(resolveBoundOwnedWindow(
      duplicate,
      'owned-user',
    )).toEqual({ state: 'changed' });

    const nonUser = identityObservation([
      identityNode(0, 'assistant', 'REPLACEMENT', 'owned-user'),
    ]);
    expect(resolveBoundOwnedWindow(
      nonUser,
      'owned-user',
    )).toEqual({ state: 'changed' });
  });

  it('keeps identity authority when the bound user rendering changes after DOM recreation', () => {
    const rerendered = identityObservation([
      identityNode(0, 'user', 'Expanded rendered markdown', 'owned-user'),
      identityNode(1, 'assistant', 'OWNED ANSWER', 'owned-assistant'),
    ]);
    expect(resolveBoundOwnedWindow(rerendered, 'owned-user')).toMatchObject({
      state: 'ok',
      lastAssistantDomIndex: 1,
    });
  });
});

function makeIdentityRuntimePage(
  preSendMessages: StateLightTestMessage[],
  snapshots: StateLightTestSnapshot[],
  options: {
    exactStates?: Record<string, Array<'ok' | 'missing' | 'unresolved' | 'duplicate'>>;
  } = {},
) {
  let sent = false;
  let closed = false;
  let filled = '';
  let observationIndex = 0;
  let activeSnapshot: StateLightTestSnapshot = { messages: preSendMessages, generating: false };
  const exactReadIndex = new Map<string, number>();
  const metrics = { sends: 0, closes: 0, messageReads: 0, reloads: 0 };

  const composer = scalarLocator({
    count: vi.fn(async () => 1),
    fill: vi.fn(async (value: string) => { filled = value; }),
    press: vi.fn(async (key: string) => {
      if (key !== 'Enter') throw new Error(`unexpected key: ${key}`);
      sent = true;
      metrics.sends += 1;
    }),
  });
  const sendButton = scalarLocator({
    count: vi.fn(async () => 1),
    click: vi.fn(async () => {
      sent = true;
      metrics.sends += 1;
    }),
  });

  const page: any = {
    __fakeBrowserGptPage: true,
    goto: vi.fn(async () => undefined),
    reload: vi.fn(async () => { metrics.reloads += 1; }),
    url: vi.fn(() => 'https://chatgpt.com/c/existing'),
    isClosed: vi.fn(() => closed),
    waitForTimeout: vi.fn(async (ms: number) => { runtimeMocks.nowMs += ms; }),
    close: vi.fn(async () => {
      closed = true;
      metrics.closes += 1;
    }),
    getByRole: vi.fn(() => scalarLocator()),
    getByText: vi.fn(() => scalarLocator()),
    locator: vi.fn((selector: string) => {
      if (selector === COMPOSER_SELECTOR) return composer;
      if (selector === SEND_BUTTON_SELECTOR) return sendButton;
      if (selector === MESSAGE_NODE_SELECTOR) {
        if (!sent) {
          activeSnapshot = { messages: preSendMessages, generating: false };
          return collectionLocator(preSendMessages);
        }
        activeSnapshot = snapshots[Math.min(observationIndex, Math.max(0, snapshots.length - 1))]
          ?? { messages: [...preSendMessages, { role: 'user', text: filled }], generating: true };
        observationIndex += 1;
        metrics.messageReads += 1;
        if (activeSnapshot.nodeListReadFailed) {
          return scalarLocator({ count: vi.fn(async () => { throw new Error('node list unreadable'); }) });
        }
        return collectionLocator(activeSnapshot.messages, activeSnapshot.generating);
      }
      const selectedIdentity = independentlyDecodeMessageIdentitySelector(selector);
      const exactIdentityMatches = selectedIdentity === undefined
        ? []
        : activeSnapshot.messages.filter((message) => message.identity === selectedIdentity);
      if (selectedIdentity !== undefined && sent && options.exactStates?.[selectedIdentity]) {
        const states = options.exactStates[selectedIdentity]!;
        const index = exactReadIndex.get(selectedIdentity) ?? 0;
        exactReadIndex.set(selectedIdentity, index + 1);
        const state = states[Math.min(index, states.length - 1)] ?? 'ok';
        if (state === 'missing') return scalarLocator();
        if (state === 'unresolved') {
          return scalarLocator({ count: vi.fn(async () => { throw new Error('exact identity unreadable'); }) });
        }
        if (state === 'duplicate') {
          const seed = exactIdentityMatches[0]
            ?? { role: 'user' as const, text: 'PROMPT', identity: selectedIdentity };
          return collectionLocator([seed, { ...seed }], activeSnapshot.generating);
        }
      }
      if (exactIdentityMatches.length > 0) {
        return collectionLocator(exactIdentityMatches, activeSnapshot.generating);
      }
      if (selector === ASSISTANT_MESSAGE_SELECTOR) {
        return collectionLocator(
          activeSnapshot.messages.filter((message) => message.role === 'assistant'),
          activeSnapshot.generating,
        );
      }
      if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
        const lastAssistant = activeSnapshot.messages.filter((message) => message.role === 'assistant').at(-1);
        return lastAssistant ? messageLocator(lastAssistant, activeSnapshot.generating) : scalarLocator();
      }
      if (matchesStopButtonSelector(selector)) return scalarLocator();
      return scalarLocator();
    }),
  };

  return { page, metrics };
}

function identityRuntimeFrames(
  identity: string,
  reply: string,
  options: { includeHistory?: boolean; renderedPrompt?: string } = {},
): StateLightTestSnapshot[] {
  const history: StateLightTestMessage[] = options.includeHistory === false
    ? []
    : [
        { role: 'user', text: 'OLD', identity: 'history-user' },
        { role: 'assistant', text: 'OLD ANSWER', identity: 'history-assistant', finalAction: true },
      ];
  const renderedPrompt = options.renderedPrompt ?? 'PROMPT';
  const working: StateLightTestSnapshot = {
    messages: [
      ...history,
      { role: 'user', text: renderedPrompt, identity },
      { role: 'assistant', text: 'working', identity: `${identity}-working` },
    ],
    generating: true,
  };
  const ready: StateLightTestSnapshot = {
    messages: [
      ...history,
      { role: 'user', text: renderedPrompt, identity },
      { role: 'assistant', text: reply, identity: `${identity}-answer`, finalAction: true },
    ],
    generating: false,
  };
  // The runtime performs an additional exact-bound completion lookup through the
  // message collection after binding. Duplicate ready frames keep that lookup and
  // the following stability poll on the same logical page state.
  return [working, ready, ready, ready, ready];
}

async function runIdentityRuntimeTurn(
  page: any,
  prompt = 'PROMPT',
  timeoutMs = '1000',
): Promise<{ code: number; result: any; output?: string }> {
  const { readFileSync, rmSync } = await import('node:fs');
  const outputPath = `/tmp/issue-1148-${Math.random().toString(16).slice(2)}.txt`;
  runtimeMocks.prompt = prompt;
  runtimeMocks.nowMs = 10_000;
  runtimeMocks.browserQueue.length = 0;
  runtimeMocks.appendFileSync.mockClear();
  const { browser } = browserFor(page);
  runtimeMocks.browserQueue.push(browser);
  const writes: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const now = vi.spyOn(Date, 'now').mockImplementation(() => runtimeMocks.nowMs);
  try {
    const code = await runStateLightTurn([
      '--profile', '/tmp/profile',
      '--cdp', 'http://127.0.0.1:9222',
      '--input', '/tmp/prompt.txt',
      '--output', outputPath,
      '--chat-url', 'https://chatgpt.com/c/existing',
      '--timeout-ms', timeoutMs,
      '--poll-ms', '1',
    ]);
    const rows = writes
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const result = rows.filter((row) => row.schema === 'turn-result/v1').at(-1) ?? {};
    let output: string | undefined;
    try { output = readFileSync(outputPath, 'utf8'); } catch { /* no publication */ }
    return { code, result, ...(output !== undefined ? { output } : {}) };
  } finally {
    stdout.mockRestore();
    now.mockRestore();
    try { rmSync(outputPath, { force: true }); } catch { /* best effort */ }
  }
}

describe('Issue #1148 runtime identity binding', () => {
  const preSend: StateLightTestMessage[] = [
    { role: 'user', text: 'OLD', identity: 'history-user' },
    { role: 'assistant', text: 'OLD ANSWER', identity: 'history-assistant', finalAction: true },
  ];

  it('publishes only from an independently evaluated opaque exact selector', async () => {
    const identity = 'owned"\\[]\u0001\u007f"][data-message-author-role="assistant';
    const selectorPreSend: StateLightTestMessage[] = [
      { role: 'user', text: 'DECOY', identity: `${identity}-prefix` },
      { role: 'assistant', text: 'DECOY ANSWER', identity: `${identity}-assistant` },
      ...preSend,
    ];
    const fake = makeIdentityRuntimePage(
      selectorPreSend,
      identityRuntimeFrames(identity, 'FINAL-IDENTITY', {
        renderedPrompt: 'Rendered markdown and Unicode spacing are intentionally different',
      }),
    );
    const outcome = await runIdentityRuntimeTurn(fake.page, '# PROMPT\n\n*canonical body*');

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.result.incidents).not.toContain('owned_message_identity_text_fallback');
    expect(outcome.output).toBe('FINAL-IDENTITY');
    expect(fake.metrics.sends).toBe(1);
    expect(fake.metrics.closes).toBe(1);
    expect(fake.metrics.reloads).toBe(0);
  });

  it('fails closed when an opaque exact selector becomes duplicate after binding', async () => {
    const identity = 'duplicate"\\[]\u0001\u007f"][data-message-id="other';
    const working: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT', identity },
        { role: 'assistant', text: 'working', identity: 'working' },
      ],
      generating: true,
    };
    const duplicate: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT', identity },
        { role: 'assistant', text: 'NOT-PUBLISHED', identity: 'answer', finalAction: true },
        { role: 'user', text: 'PROMPT', identity },
      ],
      generating: false,
    };
    const fake = makeIdentityRuntimePage(preSend, [working, working, working, duplicate]);
    const outcome = await runIdentityRuntimeTurn(fake.page);

    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'owned_message_identity_changed',
      send_count: 1,
    });
    expect(outcome.output).toBeUndefined();
  });

  it('does not inherit completion from historical turns before the exact bound reply is complete', async () => {
    const identity = 'owned-no-historical-completion-leak';
    const candidateOnly: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'Rendered prompt differs', identity },
      ],
      generating: false,
    };
    const partial: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'Rendered prompt differs', identity },
        { role: 'assistant', text: 'PARTIAL-NOT-PUBLISHABLE', identity: `${identity}-partial` },
      ],
      generating: false,
    };
    const final: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'Rendered prompt differs', identity },
        { role: 'assistant', text: 'FINAL-AFTER-EXACT-COMPLETION', identity: `${identity}-final`, finalAction: true },
      ],
      generating: false,
    };
    const fake = makeIdentityRuntimePage(preSend, [
      candidateOnly,
      partial,
      partial,
      partial,
      partial,
      ...Array.from({ length: 12 }, () => final),
    ]);
    const outcome = await runIdentityRuntimeTurn(fake.page, '# Canonical prompt', '5000');

    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.output).toBe('FINAL-AFTER-EXACT-COMPLETION');
    expect(outcome.output).not.toBe('PARTIAL-NOT-PUBLISHABLE');
    expect(outcome.result.incidents).not.toContain('owned_message_identity_text_fallback');
  });

  it('defers zero-node admission, then binds the later unique user identity without resend', async () => {
    const empty: StateLightTestSnapshot = { messages: preSend, generating: false };
    const fake = makeIdentityRuntimePage(preSend, [
      ...Array.from({ length: 12 }, () => empty),
      ...identityRuntimeFrames('deferred-owned', 'DEFERRED-FINAL'),
    ]);
    const outcome = await runIdentityRuntimeTurn(fake.page, 'PROMPT', '5000');

    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.result.incidents).toContain('send_observation_deferred');
    expect(outcome.result.incidents).not.toContain('owned_message_identity_text_fallback');
    expect(outcome.output).toBe('DEFERRED-FINAL');
    expect(fake.metrics.sends).toBe(1);
  });

  it('waits boundedly for one identityless node and then uses visible strict-text fallback', async () => {
    const identityless: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: 'FINAL-FALLBACK', finalAction: true },
      ],
      generating: false,
    };
    const fake = makeIdentityRuntimePage(preSend, [
      identityless,
      identityless,
      identityless,
      identityless,
    ]);
    const outcome = await runIdentityRuntimeTurn(fake.page);

    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.result.incidents).toContain('owned_message_identity_text_fallback');
    expect(outcome.output).toBe('FINAL-FALLBACK');
    expect(fake.metrics.sends).toBe(1);
  });

  it('fails closed on identified-plus-identityless admission multiplicity', async () => {
    const ambiguous: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT', identity: 'owned-candidate' },
        { role: 'user', text: 'FOREIGN' },
      ],
      generating: true,
    };
    const fake = makeIdentityRuntimePage(preSend, [ambiguous]);
    const outcome = await runIdentityRuntimeTurn(fake.page);

    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'owned_message_identity_unresolved',
      send_count: 1,
    });
    expect(outcome.output).toBeUndefined();
    expect(fake.metrics.sends).toBe(1);
  });

  it('fails closed on two identityless post-tail user nodes before fallback', async () => {
    const ambiguous: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT' },
        { role: 'user', text: 'PROMPT' },
      ],
      generating: true,
    };
    const fake = makeIdentityRuntimePage(preSend, [ambiguous]);
    const outcome = await runIdentityRuntimeTurn(fake.page);

    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'owned_message_identity_unresolved',
      send_count: 1,
    });
    expect(outcome.result.incidents).not.toContain('owned_message_identity_text_fallback');
    expect(outcome.output).toBeUndefined();
  });

  it('does not rebind when the sole candidate identity churns before binding', async () => {
    const candidateA: StateLightTestSnapshot = {
      messages: [...preSend, { role: 'user', text: 'PROMPT', identity: 'candidate-a' }],
      generating: true,
    };
    const candidateB: StateLightTestSnapshot = {
      messages: [...preSend, { role: 'user', text: 'PROMPT', identity: 'candidate-b' }],
      generating: true,
    };
    const fake = makeIdentityRuntimePage(preSend, [candidateA, candidateB]);
    const outcome = await runIdentityRuntimeTurn(fake.page);

    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'owned_message_identity_changed',
      send_count: 1,
    });
    expect(outcome.result.incidents).not.toContain('owned_message_identity_text_fallback');
    expect(outcome.output).toBeUndefined();
  });

it('treats a transient exact-selector miss after prefix materialization as bounded disappearance', async () => {
  const identity = 'owned-prefix-shift';
  const working: StateLightTestSnapshot = {
    messages: [
      ...preSend,
      { role: 'user', text: 'PROMPT', identity },
      { role: 'assistant', text: 'working', identity: 'working' },
    ],
    generating: true,
  };
  const materializedPrefix: StateLightTestMessage[] = [
    { role: 'user', text: 'OLDER', identity: 'older-user' },
    { role: 'assistant', text: 'OLDER ANSWER', identity: 'older-assistant' },
  ];
  const shiftedMissing: StateLightTestSnapshot = {
    messages: [...materializedPrefix, ...preSend],
    generating: false,
  };
  const shiftedReady: StateLightTestSnapshot = {
    messages: [
      ...materializedPrefix,
      ...preSend,
      { role: 'user', text: 'PROMPT', identity },
      { role: 'assistant', text: 'SHIFTED-FINAL', identity: 'shifted-answer', finalAction: true },
    ],
    generating: false,
  };
  const fake = makeIdentityRuntimePage(preSend, [
    working,
    working,
    working,
    shiftedMissing,
    shiftedReady,
    shiftedReady,
    shiftedReady,
    shiftedReady,
  ]);
  const outcome = await runIdentityRuntimeTurn(fake.page, 'PROMPT', '5000');

  expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
  expect(outcome.output).toBe('SHIFTED-FINAL');
  expect(outcome.result.cause).toBe('completed_page_only');
  expect(fake.metrics.reloads).toBe(0);
});
  it('reports bounded disappearance after binding and never initiates reload', async () => {
    const ownedWorking: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT', identity: 'owned-disappear' },
        { role: 'assistant', text: 'working', identity: 'working' },
      ],
      generating: true,
    };
    const ownedReady: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT', identity: 'owned-disappear' },
        { role: 'assistant', text: 'NOT-PUBLISHED', identity: 'answer', finalAction: true },
      ],
      generating: false,
    };
    const absent: StateLightTestSnapshot = { messages: preSend, generating: false };
    const fake = makeIdentityRuntimePage(preSend, [
      ownedWorking,
      ownedReady,
      ownedReady,
      ...Array.from({ length: 12 }, () => absent),
    ]);
    const outcome = await runIdentityRuntimeTurn(fake.page, 'PROMPT', '5000');

    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'owned_message_identity_disappeared',
      send_count: 1,
    });
    expect(outcome.output).toBeUndefined();
    expect(fake.metrics.reloads).toBe(0);
  });

  it('survives DOM recreation and former-anchor virtualization, then stops at the next user boundary', async () => {
    const ownedWorking: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT', identity: 'owned-recreated' },
        { role: 'assistant', text: 'working', identity: 'working' },
      ],
      generating: true,
    };
    const boundWorking: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT', identity: 'owned-recreated' },
        { role: 'assistant', text: 'working', identity: 'working' },
      ],
      generating: true,
    };
    const recreatedWindow: StateLightTestSnapshot = {
      messages: [
        { role: 'user', text: 'Expanded render', identity: 'owned-recreated' },
        { role: 'assistant', text: 'OWNED-FINAL', identity: 'owned-answer', finalAction: true },
        { role: 'user', text: 'FOREIGN' },
        { role: 'assistant', text: 'FOREIGN-FINAL', identity: 'foreign-answer', finalAction: true },
      ],
      generating: false,
    };
    const fake = makeIdentityRuntimePage(preSend, [
      ownedWorking,
      boundWorking,
      boundWorking,
      recreatedWindow,
      recreatedWindow,
      recreatedWindow,
      recreatedWindow,
    ]);
    const outcome = await runIdentityRuntimeTurn(fake.page);

    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.output).toBe('OWNED-FINAL');
    expect(outcome.result.cause).toBe('completed_page_only');
    expect(fake.metrics.reloads).toBe(0);
  });

it('uses a controlled identity-to-window swap for byte-identical prompts across pages', async () => {
  const { readFileSync, rmSync } = await import('node:fs');
  const outputA = `/tmp/issue-1148-a-${Math.random().toString(16).slice(2)}.txt`;
  const outputB = `/tmp/issue-1148-b-${Math.random().toString(16).slice(2)}.txt`;
  const swappedFrames = (
    ownedIdentity: string,
    ownedReply: string,
    decoyIdentity: string,
    decoyReply: string,
  ): StateLightTestSnapshot[] => {
    const working: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'BYTE-IDENTICAL-PROMPT', identity: ownedIdentity },
        { role: 'assistant', text: 'working', identity: `${ownedIdentity}-working` },
      ],
      generating: true,
    };
    const boundWorking: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'BYTE-IDENTICAL-PROMPT', identity: ownedIdentity },
        { role: 'assistant', text: 'working', identity: `${ownedIdentity}-working` },
      ],
      generating: true,
    };
    const ownedWindow: StateLightTestMessage[] = [
      { role: 'user', text: 'BYTE-IDENTICAL-PROMPT', identity: ownedIdentity },
      { role: 'assistant', text: ownedReply, identity: `${ownedIdentity}-answer`, finalAction: true },
    ];
    const decoyWindow: StateLightTestMessage[] = [
      { role: 'user', text: 'BYTE-IDENTICAL-PROMPT', identity: decoyIdentity },
      { role: 'assistant', text: decoyReply, identity: `${decoyIdentity}-answer`, finalAction: true },
    ];
    const swappedReady: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        ...(ownedIdentity === 'owned-a'
          ? [...decoyWindow, ...ownedWindow]
          : [...ownedWindow, ...decoyWindow]),
      ],
      generating: false,
    };
    return [working, boundWorking, boundWorking, swappedReady, swappedReady, swappedReady, swappedReady];
  };
  const fakeA = makeIdentityRuntimePage(
    preSend,
    swappedFrames('owned-a', 'REPLY-A', 'owned-b', 'DECOY-B-ON-A'),
  );
  const fakeB = makeIdentityRuntimePage(
    preSend,
    swappedFrames('owned-b', 'REPLY-B', 'owned-a', 'DECOY-A-ON-B'),
  );
  runtimeMocks.prompt = 'BYTE-IDENTICAL-PROMPT';
  runtimeMocks.nowMs = 10_000;
  runtimeMocks.browserQueue.length = 0;
  runtimeMocks.browserQueue.push(browserFor(fakeA.page).browser, browserFor(fakeB.page).browser);
  const writes: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const now = vi.spyOn(Date, 'now').mockImplementation(() => runtimeMocks.nowMs);
  const argv = (output: string) => [
    '--profile', '/tmp/profile',
    '--cdp', 'http://127.0.0.1:9222',
    '--input', '/tmp/prompt.txt',
    '--output', output,
    '--chat-url', 'https://chatgpt.com/c/existing',
    '--timeout-ms', '5000',
    '--poll-ms', '1',
  ];
  try {
    const codes = await Promise.all([
      runStateLightTurn(argv(outputA)),
      runStateLightTurn(argv(outputB)),
    ]);
    expect(codes).toEqual([0, 0]);
    expect(readFileSync(outputA, 'utf8')).toBe('REPLY-A');
    expect(readFileSync(outputB, 'utf8')).toBe('REPLY-B');
    expect(readFileSync(outputA, 'utf8')).not.toBe('DECOY-B-ON-A');
    expect(readFileSync(outputB, 'utf8')).not.toBe('DECOY-A-ON-B');
    const results = writes
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.schema === 'turn-result/v1');
    expect(results).toHaveLength(2);
    expect(results.every((row) => row.state === 'ok' && row.send_count === 1)).toBe(true);
    expect(fakeA.metrics.sends).toBe(1);
    expect(fakeB.metrics.sends).toBe(1);
  } finally {
    stdout.mockRestore();
    now.mockRestore();
    rmSync(outputA, { force: true });
    rmSync(outputB, { force: true });
  }
});

  it('falls back when the bounded tail anchor is globally duplicate outside the scanned suffix', async () => {
    const messages: StateLightTestMessage[] = [
      { role: 'user', text: 'OLDER', identity: 'tail-user', identityReadFailed: true },
      { role: 'assistant', text: 'OLDER ANSWER', identity: 'older-answer' },
      { role: 'user', text: 'TAIL', identity: 'tail-user' },
      { role: 'assistant', text: 'TAIL ANSWER', identity: 'tail-answer' },
    ];
    const page = {
      locator: vi.fn((selector: string) => {
        const selectedIdentity = independentlyDecodeMessageIdentitySelector(selector);
        if (selectedIdentity === 'tail-user') {
          return collectionLocator([
            { role: 'user', text: 'OLDER', identity: 'tail-user' },
            { role: 'user', text: 'TAIL', identity: 'tail-user' },
          ]);
        }
        if (selector === MESSAGE_NODE_SELECTOR) return collectionLocator(messages);
        return scalarLocator();
      }),
    };

    const first = await readTailPageObservation(page, false);
    const second = await readTailPageObservation(page, false);
    expect(first.nodes.map((node) => node.domIndex)).toEqual([2, 3]);
    expect(establishOwnedTailBoundary(first, second, false)).toEqual({
      kind: 'text_fallback',
      cause: 'stable_tail_anchor_unavailable',
    });
  });

  it('bounds repeated exact-candidate unreadability as changed', async () => {
    const identity = 'exact-unreadable';
    const working: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT', identity },
        { role: 'assistant', text: 'working', identity: 'working' },
      ],
      generating: true,
    };
    const fake = makeIdentityRuntimePage(preSend, [working, working, working], {
      exactStates: { [identity]: ['unresolved', 'unresolved'] },
    });
    const outcome = await runIdentityRuntimeTurn(fake.page, 'PROMPT', '5000');
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'owned_message_identity_changed',
      send_count: 1,
    });
    expect(outcome.output).toBeUndefined();
  });

  it('does not bind across exact success, unreadability, then success', async () => {
    const identity = 'interrupted-stability';
    const single: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT', identity },
        { role: 'assistant', text: 'working', identity: 'working' },
      ],
      generating: true,
    };
    const multiple: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT', identity },
        { role: 'user', text: 'PROMPT', identity: `${identity}-other` },
      ],
      generating: false,
    };
    const fake = makeIdentityRuntimePage(preSend, [single, single, single, multiple], {
      exactStates: { [identity]: ['ok', 'unresolved', 'ok'] },
    });
    const outcome = await runIdentityRuntimeTurn(fake.page, 'PROMPT', '5000');
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'owned_message_identity_changed',
      send_count: 1,
    });
    expect(outcome.output).toBeUndefined();
  });

  it('reports admitted boundary unreadability as changed after bounded rereads', async () => {
    const unreadable: StateLightTestSnapshot = {
      messages: [],
      generating: false,
      nodeListReadFailed: true,
    };
    const fake = makeIdentityRuntimePage(preSend, [unreadable, unreadable]);
    const outcome = await runIdentityRuntimeTurn(fake.page, 'PROMPT', '5000');
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'owned_message_identity_changed',
      send_count: 1,
    });
  });

  it('ignores distant-history materialization while identity admission is deferred', async () => {
    const prefix: StateLightTestMessage[] = [
      { role: 'user', text: 'OLDER', identity: 'older-user' },
      { role: 'assistant', text: 'OLDER ANSWER', identity: 'older-answer', finalAction: true },
    ];
    const deferred: StateLightTestSnapshot = {
      messages: [...prefix, ...preSend],
      generating: false,
    };
    const identity = 'deferred-owned';
    const working: StateLightTestSnapshot = {
      messages: [
        ...prefix,
        ...preSend,
        { role: 'user', text: 'PROMPT', identity },
        { role: 'assistant', text: 'working', identity: 'working' },
      ],
      generating: true,
    };
    const ready: StateLightTestSnapshot = {
      messages: [
        ...prefix,
        ...preSend,
        { role: 'user', text: 'PROMPT', identity },
        { role: 'assistant', text: 'DEFERRED-FINAL', identity: 'answer', finalAction: true },
      ],
      generating: false,
    };
    const fake = makeIdentityRuntimePage(preSend, [
      ...Array.from({ length: 12 }, () => deferred),
      working,
      working,
      ready,
      ready,
      ready,
    ]);
    const outcome = await runIdentityRuntimeTurn(fake.page, 'PROMPT', '5000');
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.result.incidents).toContain('send_observation_deferred');
    expect(outcome.output).toBe('DEFERRED-FINAL');
  });

  it('uses the pinned owned assistant for completion across a prefix virtualization race', async () => {
    const identity = 'pinned-completion';
    const working: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT', identity },
        { role: 'assistant', text: 'working', identity: 'working' },
      ],
      generating: true,
    };
    const partial: StateLightTestSnapshot = {
      messages: [
        ...preSend,
        { role: 'user', text: 'PROMPT', identity },
        { role: 'assistant', text: 'PARTIAL', identity: 'owned-answer' },
      ],
      generating: false,
    };
    const shifted: StateLightTestSnapshot = {
      messages: [
        { role: 'user', text: 'PROMPT', identity },
        { role: 'assistant', text: 'PARTIAL', identity: 'owned-answer' },
        { role: 'user', text: 'FOREIGN', identity: 'foreign-user' },
        { role: 'assistant', text: 'FOREIGN-FINAL', identity: 'foreign-answer', finalAction: true },
      ],
      generating: false,
    };
    const final: StateLightTestSnapshot = {
      messages: [
        { role: 'user', text: 'PROMPT', identity },
        { role: 'assistant', text: 'OWNED-FINAL', identity: 'owned-answer', finalAction: true },
        { role: 'user', text: 'FOREIGN', identity: 'foreign-user' },
        { role: 'assistant', text: 'FOREIGN-FINAL', identity: 'foreign-answer', finalAction: true },
      ],
      generating: false,
    };
    const fake = makeIdentityRuntimePage(preSend, [
      working,
      working,
      working,
      partial,
      shifted,
      shifted,
      final,
      final,
      final,
    ]);
    const outcome = await runIdentityRuntimeTurn(fake.page, 'PROMPT', '5000');
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.output).toBe('OWNED-FINAL');
    expect(outcome.output).not.toBe('PARTIAL');
    expect(outcome.output).not.toBe('FOREIGN-FINAL');
  });

  it('never publishes a historical equal-prompt reply while the sent fallback node is absent', async () => {
    const fallbackPreSend: StateLightTestMessage[] = [
      { role: 'user', text: 'PROMPT', identityReadFailed: true },
      { role: 'assistant', text: 'HISTORICAL', identity: 'historical-answer', finalAction: true },
    ];
    const absent: StateLightTestSnapshot = {
      messages: fallbackPreSend,
      generating: false,
    };
    const laterReady: StateLightTestSnapshot = {
      messages: [
        ...fallbackPreSend,
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: 'CURRENT-FINAL', finalAction: true },
      ],
      generating: false,
    };
    const fake = makeIdentityRuntimePage(fallbackPreSend, [
      absent,
      absent,
      absent,
      laterReady,
      laterReady,
      laterReady,
    ]);
    const outcome = await runIdentityRuntimeTurn(fake.page, 'PROMPT', '5000');
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.result.incidents).toContain('owned_message_identity_text_fallback');
    expect(outcome.output).toBe('CURRENT-FINAL');
    expect(outcome.output).not.toBe('HISTORICAL');
  });

});
