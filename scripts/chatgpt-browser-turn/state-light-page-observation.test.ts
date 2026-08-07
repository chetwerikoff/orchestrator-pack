import { describe, expect, it, vi } from 'vitest';

import './too-many-requests-capture.test-cases.ts';
import {
  readAssistantTurnCompletionReady,
  readAssistantTurnGenerating,
} from './ui-adapter.ts';
import {
  ASSISTANT_MESSAGE_SELECTOR,
  ASSISTANT_TURN_ANCESTOR_XPATH,
  MESSAGE_AUTHOR_ROLE_ATTR,
  MESSAGE_NODE_SELECTOR,
  matchesStopButtonSelector,
} from './product-page-selectors.ts';
import {
  buildObservationHeartbeat,
  classifyBrowserGptPageTurnStatus,
  classifyPageObservation,
  ownedPromptMatches,
  readPageObservation,
  replyStabilityFingerprint,
  replyStabilityMatches,
} from './state-light-turn.ts';
import {
  generateOwnedPromptMarker,
  isOwnedPromptMarker,
  wrapOwnedPromptPayload,
} from './owned-prompt-marker.ts';
import {
  collectionLocator,
  messageLocator,
  scalarLocator,
  TEST_OWNED_MARKER,
  type StateLightTestMessage,
} from './state-light-turn.test-fixtures.ts';

const marker = TEST_OWNED_MARKER;
const markedPrompt = `${marker}\n\nORIGINAL PROMPT`;
const baseline: StateLightTestMessage[] = [
  { role: 'user', text: 'historical prompt' },
  { role: 'assistant', text: 'historical reply' },
];

function classify(messages: StateLightTestMessage[], inProgress = false) {
  return classifyPageObservation(messages, baseline.length, marker, inProgress);
}

function runNoResendRefusalFixture(messages: StateLightTestMessage[]) {
  const observation = classify(messages);
  const terminal = observation.state === 'waiting'
    ? { state: 'ui_contract_mismatch', cause: 'owned_prompt_marker_unresolved' }
    : observation.state === 'uncertain'
      ? { state: 'ui_contract_mismatch', cause: observation.cause }
      : { state: 'unexpected_owned_reply', cause: 'fixture_invalid' };
  return {
    observation,
    terminal,
    send_count: 1,
    published: false,
  } as const;
}

async function runProductAttributeChurnFixture() {
  const ids: Array<string | null> = [null, 'user-service-12345678', 'user-service-replaced-12345678'];
  let idIndex = 0;
  const ownedNode = {
    getAttribute: vi.fn(async (name: string) => {
      if (name === MESSAGE_AUTHOR_ROLE_ATTR) return 'user';
      if (name === 'data-message-id') return ids[Math.min(idIndex++, ids.length - 1)];
      return null;
    }),
    innerText: vi.fn(async () => markedPrompt),
    textContent: vi.fn(async () => markedPrompt),
  };
  const nodes = scalarLocator({
    count: vi.fn(async () => 1),
    nth: vi.fn(() => ownedNode),
  });
  const page = {
    locator: vi.fn((selector: string) => selector === MESSAGE_NODE_SELECTOR
      ? nodes
      : scalarLocator()),
  };
  const observations: Array<{ messageId: string | null; markerHead: string; owned: boolean }> = [];
  for (const expectedId of ids) {
    const observation = await readPageObservation(page);
    const messageId = await ownedNode.getAttribute('data-message-id');
    const text = observation.messages[0]?.text ?? '';
    const markerHead = text.split(/\s+/u, 1)[0] ?? '';
    observations.push({
      messageId,
      markerHead,
      owned: observation.messages.filter(
        (message) => message.role === 'user' && ownedPromptMatches(message.text, marker),
      ).length === 1,
    });
    expect(messageId).toBe(expectedId);
  }
  return { observations, send_count: 1, published: true };
}

async function runCollapsedDuplicateFixture() {
  const payload = `# byte-identical collapsed payload\n\n${'| cell | value |\n|---|---|\n| same | payload |\n'.repeat(400)}`;
  const historicalMarker = `OPKTURNV1${'22'.repeat(16)}`;
  const historicalText = wrapOwnedPromptPayload(historicalMarker, payload);
  const currentText = wrapOwnedPromptPayload(marker, payload);
  const makeCollapsedNode = (text: string) => ({
    collapsed: true,
    showMore: true,
    getAttribute: vi.fn(async (name: string) => name === MESSAGE_AUTHOR_ROLE_ATTR ? 'user' : null),
    innerText: vi.fn(async () => text),
    textContent: vi.fn(async () => 'collapsed preview'),
  });
  const nodesData = [makeCollapsedNode(historicalText), makeCollapsedNode(currentText)];
  const nodes = scalarLocator({
    count: vi.fn(async () => nodesData.length),
    nth: vi.fn((index: number) => nodesData[index]),
  });
  const page = {
    locator: vi.fn((selector: string) => selector === MESSAGE_NODE_SELECTOR
      ? nodes
      : scalarLocator()),
  };
  const observation = await readPageObservation(page);
  const userTexts = observation.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.text);
  const classification = classify([
    ...baseline,
    { role: 'user', text: historicalText },
    { role: 'assistant', text: 'historical reply' },
    { role: 'user', text: currentText },
    { role: 'assistant', text: 'owned reply' },
  ]);
  return {
    payload,
    userTexts,
    markerHeads: userTexts.map((text) => text.split(/\s+/u, 1)[0] ?? ''),
    collapsedShapes: nodesData.map((node) => ({ collapsed: node.collapsed, showMore: node.showMore })),
    expectedMarkerMatches: userTexts.filter((text) => ownedPromptMatches(text, marker)).length,
    classification,
    send_count: 1,
    published: true,
  } as const;
}

describe('browser turn page evidence classification', () => {
  it('distinguishes dead, long-running, and completed turns from the existing probe fields', () => {
    expect(classifyBrowserGptPageTurnStatus(false, 0)).toBe('dead');
    expect(classifyBrowserGptPageTurnStatus(true, 0)).toBe('long_running');
    expect(classifyBrowserGptPageTurnStatus(false, 1)).toBe('completed');
    expect(classifyBrowserGptPageTurnStatus(false, 3)).toBe('completed');
  });

  it('fails closed when generation evidence is unknown and never calls active generation dead', () => {
    expect(classifyBrowserGptPageTurnStatus('unknown', 0)).toBe('unknown');
    expect(classifyBrowserGptPageTurnStatus('unknown', 2)).toBe('unknown');
    expect(classifyBrowserGptPageTurnStatus(true, 2)).toBe('long_running');
  });
});

describe('state-light completion probes', () => {
  function makeTurnContainerPage(actionButtons: boolean, generating = false) {
    const assistant = scalarLocator({
      count: vi.fn(async () => 1),
      getAttribute: vi.fn(async (name: string) => {
        if (name === MESSAGE_AUTHOR_ROLE_ATTR) return 'assistant';
        if (name === 'data-is-streaming') return generating ? 'true' : null;
        return null;
      }),
      innerText: vi.fn(async () => 'FINAL'),
      locator: vi.fn((selector: string) => {
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=')) {
          return scalarLocator({ count: vi.fn(async () => actionButtons ? 1 : 0) });
        }
        if (matchesStopButtonSelector(selector)) return scalarLocator({ count: vi.fn(async () => generating ? 1 : 0) });
        return scalarLocator();
      }),
    });
    return {
      locator: vi.fn((selector: string) => selector === ASSISTANT_MESSAGE_SELECTOR
        ? collectionLocator([{ role: 'assistant', text: 'FINAL' }], generating)
        : assistant),
      getByRole: vi.fn(() => scalarLocator({ count: vi.fn(async () => actionButtons ? 1 : 0) })),
    };
  }

  it('requires completion actions and rejects an in-progress assistant', async () => {
    await expect(readAssistantTurnGenerating(makeTurnContainerPage(true, true))).resolves.toBe(true);
    await expect(readAssistantTurnCompletionReady(makeTurnContainerPage(false))).resolves.toBe(false);
  });
});

describe('marker ownership classification', () => {
  it('admits exactly one current user marker and publishes its reply window', () => {
    expect(classify([
      ...baseline,
      { role: 'user', text: markedPrompt },
      { role: 'assistant', text: 'FINAL' },
    ])).toEqual({ state: 'ready', reply: 'FINAL' });
  });

  it('does not attribute a historical byte-identical original prompt after one send', () => {
    const result = runNoResendRefusalFixture([
      { role: 'user', text: 'ORIGINAL PROMPT' },
      { role: 'assistant', text: 'historical reply' },
    ]);

    expect(result).toEqual({
      observation: { state: 'waiting' },
      terminal: { state: 'ui_contract_mismatch', cause: 'owned_prompt_marker_unresolved' },
      send_count: 1,
      published: false,
    });
  });

  it('fails closed on duplicate marker nodes after one send', () => {
    const result = runNoResendRefusalFixture([
      ...baseline,
      { role: 'user', text: markedPrompt },
      { role: 'assistant', text: 'first' },
      { role: 'user', text: `\u200B${markedPrompt}` },
    ]);

    expect(result).toEqual({
      observation: { state: 'uncertain', cause: 'owned_prompt_marker_ambiguous' },
      terminal: { state: 'ui_contract_mismatch', cause: 'owned_prompt_marker_ambiguous' },
      send_count: 1,
      published: false,
    });
  });

  it('ignores assistant echoes and marker-like payload content', () => {
    expect(classify([
      ...baseline,
      { role: 'assistant', text: `echo ${marker}` },
      { role: 'user', text: 'The payload mentions OPKTURNV1 but is not prefixed' },
    ])).toEqual({ state: 'waiting' });
  });

  it('uses the closed prefix scan and exact comparison', () => {
    expect(ownedPromptMatches(` \uFEFF\u200B\t${marker} body`, marker)).toBe(true);
    expect(ownedPromptMatches(`\u200B\uFEFF \u200B${marker}`, marker)).toBe(true);
    expect(ownedPromptMatches(`.${marker}`, marker)).toBe(false);
    expect(ownedPromptMatches(`**${marker}**`, marker)).toBe(false);
    expect(ownedPromptMatches(`wrong-${marker}`, marker)).toBe(false);
  });

  it('closes publication at the next user node', () => {
    expect(classify([
      ...baseline,
      { role: 'user', text: markedPrompt },
      { role: 'assistant', text: 'FINAL' },
      { role: 'user', text: 'foreign later user' },
      { role: 'assistant', text: 'foreign reply' },
    ])).toEqual({ state: 'ready', reply: 'FINAL' });
  });

  it('keeps marker ownership through absent, present, and replaced data-message-id values', async () => {
    const result = await runProductAttributeChurnFixture();
    expect(result).toEqual({
      observations: [
        { messageId: null, markerHead: marker, owned: true },
        { messageId: 'user-service-12345678', markerHead: marker, owned: true },
        { messageId: 'user-service-replaced-12345678', markerHead: marker, owned: true },
      ],
      send_count: 1,
      published: true,
    });
  });

  it('uses complete innerText to exclude a collapsed byte-identical historical duplicate', async () => {
    const result = await runCollapsedDuplicateFixture();
    expect(result.payload.length).toBeGreaterThan(18_000);
    expect(result.userTexts).toHaveLength(2);
    expect(result.userTexts[0]?.slice(result.userTexts[0].indexOf('\n\n') + 2))
      .toBe(result.userTexts[1]?.slice(result.userTexts[1].indexOf('\n\n') + 2));
    expect(result.markerHeads).toEqual([`OPKTURNV1${'22'.repeat(16)}`, marker]);
    expect(result.collapsedShapes).toEqual([
      { collapsed: true, showMore: true },
      { collapsed: true, showMore: true },
    ]);
    expect(result.expectedMarkerMatches).toBe(1);
    expect(result.classification).toEqual({ state: 'ready', reply: 'owned reply' });
    expect(result.send_count).toBe(1);
    expect(result.published).toBe(true);
  });
});

describe('owned marker primitive', () => {
  it('generates the fixed version-1 grammar with one source call', () => {
    const source = vi.fn(() => Uint8Array.from({ length: 16 }, (_, index) => index));
    const generated = generateOwnedPromptMarker(source);

    expect(generated).toMatch(/^OPKTURNV1[0-9a-f]{32}$/);
    expect(isOwnedPromptMarker(generated)).toBe(true);
    expect(source).toHaveBeenCalledOnce();
    expect(source).toHaveBeenCalledWith(16);
  });

  it('generates distinct valid markers for byte-identical payloads', () => {
    const source = vi.fn()
      .mockReturnValueOnce(Uint8Array.from({ length: 16 }, () => 0x11))
      .mockReturnValueOnce(Uint8Array.from({ length: 16 }, () => 0x22));
    const payload = 'same payload bytes';
    const first = generateOwnedPromptMarker(source);
    const second = generateOwnedPromptMarker(source);

    expect(first).not.toBe(second);
    expect(isOwnedPromptMarker(first)).toBe(true);
    expect(isOwnedPromptMarker(second)).toBe(true);
    expect(wrapOwnedPromptPayload(first, payload).endsWith(`\n\n${payload}`)).toBe(true);
    expect(wrapOwnedPromptPayload(second, payload).endsWith(`\n\n${payload}`)).toBe(true);
    expect(source).toHaveBeenCalledTimes(2);
    expect(source).toHaveBeenNthCalledWith(1, 16);
    expect(source).toHaveBeenNthCalledWith(2, 16);
  });

  it('places the marker at the payload head without rewriting the payload', () => {
    const payload = '# table\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const wrapped = wrapOwnedPromptPayload(marker, payload);

    expect(wrapped).toBe(`${marker}\n\n${payload}`);
  });
});

describe('DOM observation boundary', () => {
  async function readAtomicEvidence(
    messages: Array<{ role: 'user' | 'assistant'; text: string }>,
    generationQuery: () => unknown,
  ) {
    const elements = messages.map((message, index) => ({
      getAttribute: (name: string) => {
        if (name === MESSAGE_AUTHOR_ROLE_ATTR) return message.role;
        if (name === 'data-message-id') return `${message.role}-${index}-12345678`;
        return null;
      },
      querySelectorAll: () => [],
      innerText: message.text,
    }));
    const querySelector = vi.fn(generationQuery);
    const priorDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { querySelector };
    const nodes = scalarLocator({
      evaluateAll: vi.fn(async (callback: (items: Element[], args: unknown) => unknown, args: unknown) => (
        callback(elements as unknown as Element[], args)
      )),
    });
    const page = {
      locator: vi.fn((selector: string) => selector === MESSAGE_NODE_SELECTOR
        ? nodes
        : scalarLocator()),
    };
    try {
      return { result: await readPageObservation(page), querySelector };
    } finally {
      if (priorDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = priorDocument;
    }
  }

  it('carries the exact probe tuple from one atomic production DOM read', async () => {
    const dead = await readAtomicEvidence([{ role: 'user', text: markedPrompt }], () => null);
    expect(dead.result.pageTurnEvidence).toEqual({ generationInProgress: false, observedAssistantNodes: 0 });
    expect(classifyBrowserGptPageTurnStatus(
      dead.result.pageTurnEvidence!.generationInProgress,
      dead.result.pageTurnEvidence!.observedAssistantNodes,
    )).toBe('dead');

    const live = await readAtomicEvidence([{ role: 'user', text: markedPrompt }], () => ({}));
    expect(live.result.pageTurnEvidence).toEqual({ generationInProgress: true, observedAssistantNodes: 0 });
    expect(classifyBrowserGptPageTurnStatus(
      live.result.pageTurnEvidence!.generationInProgress,
      live.result.pageTurnEvidence!.observedAssistantNodes,
    )).toBe('long_running');

    const completed = await readAtomicEvidence([
      { role: 'user', text: markedPrompt },
      { role: 'assistant', text: 'historical or completed assistant' },
    ], () => null);
    expect(completed.result.pageTurnEvidence).toEqual({ generationInProgress: false, observedAssistantNodes: 1 });
    expect(classifyBrowserGptPageTurnStatus(
      completed.result.pageTurnEvidence!.generationInProgress,
      completed.result.pageTurnEvidence!.observedAssistantNodes,
    )).toBe('completed');
    expect(completed.querySelector).toHaveBeenCalledWith(
      '[data-testid="stop-button"], button[aria-label*="Stop"], [aria-busy="true"], [data-is-streaming="true"], [data-testid*="tool"][data-state="running"], [data-testid*="tool"][data-state="loading"]',
    );
  });

  it('preserves a valid transcript and fails closed when generation reading throws', async () => {
    const observation = await readAtomicEvidence(
      [{ role: 'user', text: markedPrompt }],
      () => { throw new Error('generation read failed'); },
    );
    expect(observation.result.messages).toEqual([{ role: 'user', text: markedPrompt }]);
    expect(observation.result.transcriptIncomplete).toBe(false);
    expect(observation.result.pageTurnEvidence).toEqual({
      generationInProgress: 'unknown',
      observedAssistantNodes: 0,
    });
    expect(classifyBrowserGptPageTurnStatus(
      observation.result.pageTurnEvidence!.generationInProgress,
      observation.result.pageTurnEvidence!.observedAssistantNodes,
    )).toBe('unknown');
  });

  it('reads complete rendered innerText and never textContent', async () => {
    const user = {
      ...({ role: 'user', text: markedPrompt } as const),
      domTextContent: `You said: ${markedPrompt}`,
    };
    const page = {
      locator: vi.fn((selector: string) => selector === MESSAGE_NODE_SELECTOR
        ? collectionLocator([user])
        : scalarLocator()),
    };
    const result = await readPageObservation(page);
    expect(result.messages).toEqual([{ role: 'user', text: markedPrompt }]);
    expect(result.transcriptIncomplete).toBe(false);
  });

  it('keeps later nodes while marking an unreadable node as incomplete', async () => {
    const unreadable = messageLocator({ role: 'user', text: markedPrompt });
    unreadable.innerText = vi.fn(async () => { throw new Error('read failed'); });
    const readable = messageLocator({ role: 'assistant', text: 'FINAL' });
    let index = 0;
    const nodes = scalarLocator({
      count: vi.fn(async () => 2),
      nth: vi.fn(() => index++ === 0 ? unreadable : readable),
    });
    const page = { locator: vi.fn((selector: string) => selector === MESSAGE_NODE_SELECTOR ? nodes : scalarLocator()) };
    const result = await readPageObservation(page);
    expect(result.transcriptIncomplete).toBe(true);
    expect(result.messages.at(-1)).toEqual({ role: 'assistant', text: 'FINAL' });
  });
});

describe('unchanged observation diagnostics', () => {
  it('retains heartbeat and stability contracts', () => {
    const heartbeat = buildObservationHeartbeat({ state: 'ready', reply: 'FINAL' }, 1, 4, true, 'FINAL');
    expect(heartbeat).toMatchObject({ schema: 'observation-heartbeat/v1', poll_count: 4, stable_reads: 1 });
    expect(replyStabilityMatches('same', 'same')).toBe(true);
    expect(replyStabilityFingerprint('same')).toContain('same');
  });
});

describe('issue 1168 source tooling', () => {
  const sourceMarker = '<!-- issue-1168-too-many-requests-production-shape:v2 -->';

  function exactShape() {
    return {
      schema: 'too-many-requests-dialog-shape/v2',
      dialog: {
        page_dialog_ordinal: 0,
        tag_name: 'div',
        role_attribute_class: 'dialog',
        aria_modal_attribute_class: 'true',
        aria_owns_attribute_class: 'absent',
      },
      heading: {
        child_index_path: [0],
        tag_name: 'h2',
        role_attribute_class: 'heading',
      },
      acknowledgement: {
        child_index_path: [1],
        tag_name: 'button',
        role_attribute_class: 'button',
      },
    } as const;
  }

  it('rejects duplicate keys and accepts only canonical compact source bytes', async () => {
    const {
      parseJsonRejectingDuplicateKeys,
      parseSourceCommentBody,
      shapeSha256,
    } = await import('./too-many-requests-source.ts');
    expect(() => parseJsonRejectingDuplicateKeys('{"a":1,"a":2}')).toThrow('json_duplicate_key');
    const shape = exactShape();
    const source = {
      schema: 'issue-1168-too-many-requests-production-shape/v2',
      issue: 1168,
      observation_kind: 'natural',
      observed_at: '2026-08-03T00:00:00.000Z',
      source_local_occurrence: 'capture:test',
      operator_attestation: 'scrubbed-no-private-data',
      shape_sha256: shapeSha256(shape),
      shape,
    } as const;
    const body = `${sourceMarker}\n${JSON.stringify(source)}`;
    expect(parseSourceCommentBody(body)).toEqual(source);
    expect(() => parseSourceCommentBody(`${body}\n`)).toThrow('body_grammar_invalid');
    expect(() => parseSourceCommentBody(body.replace('"issue":1168', '"issue":1168,"issue":1168')))
      .toThrow('body_grammar_invalid');
  });

  it('binds live identity, exact body bytes, canonical shape, and fixture bytes', async () => {
    const { createHash } = await import('node:crypto');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { shapeSha256, verifyLiveSource } = await import('./too-many-requests-source.ts');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const shape = exactShape();
    const source = {
      schema: 'issue-1168-too-many-requests-production-shape/v2',
      issue: 1168,
      observation_kind: 'natural',
      observed_at: '2026-08-03T00:00:00.000Z',
      source_local_occurrence: 'capture:test',
      operator_attestation: 'scrubbed-no-private-data',
      shape_sha256: shapeSha256(shape),
      shape,
    } as const;
    const body = `${sourceMarker}\n${JSON.stringify(source)}`;
    const root = mkdtempSync(join(tmpdir(), 'issue-1168-source-'));
    const fixturePath = join(root, 'fixture.json');
    const bindingPath = join(root, 'binding.json');
    const commentId = 5161000000;
    const commentUrl = `https://github.com/chetwerikoff/orchestrator-pack/issues/1168#issuecomment-${commentId}`;
    writeFileSync(fixturePath, JSON.stringify(shape));
    writeFileSync(bindingPath, JSON.stringify({
      schema: 'issue-1168-source-binding/v1',
      comment_id: commentId,
      comment_url: commentUrl,
      updated_at: '2026-08-03T00:00:00Z',
      body_sha256: hash(body),
      shape_sha256: source.shape_sha256,
    }));
    const result = await verifyLiveSource({
      bindingPath,
      fixturePath,
      selector: 'too-many-requests-source-verifier',
    }, {
      transport: {
        runGh: () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            id: commentId,
            html_url: commentUrl,
            updated_at: '2026-08-03T00:00:00Z',
            body,
          }),
          stderr: '',
        }),
      },
    });
    expect(result).toMatchObject({
      status: 'verified',
      selector: 'too-many-requests-source-verifier',
      body_sha256: hash(body),
      shape_sha256: source.shape_sha256,
      fixture_sha256: source.shape_sha256,
    });
  });

  it('captures only the minimized exact public surface and fails closed on ambiguity', async () => {
    const { captureTooManyRequestsSource } = await import('./too-many-requests-source.ts');
    class ElementNode {
      parentElement: ElementNode | null = null;
      readonly children: ElementNode[] = [];
      constructor(readonly tagName: string) {}
      append(child: ElementNode) {
        child.parentElement = this;
        this.children.push(child);
        return this;
      }
    }
    class Locator {
      constructor(readonly elements: ElementNode[], readonly attributes: Record<string, string | null> = {}, readonly enabled = true) {}
      async count() { return this.elements.length; }
      nth(index: number) { return new Locator(this.elements[index] ? [this.elements[index]!] : [], this.attributes, this.enabled); }
      async isVisible() { return this.elements.length === 1; }
      async isEnabled() { return this.enabled; }
      async getAttribute(name: string) { return this.attributes[name] ?? null; }
      async elementHandle() { return this.elements[0] ?? null; }
      async evaluate<T, A>(callback: (element: Element, arg: A) => T, arg?: A) {
        const element = this.elements[0];
        if (!element) throw new Error('missing_element');
        return callback(element as unknown as Element, arg as A);
      }
      getByRole(role: string, options: { name: string; exact: boolean }) {
        const dialog = this.elements[0];
        if (!dialog || !options.exact) return new Locator([]);
        const target = role === 'heading' && options.name === 'Too many requests'
          ? dialog.children[0]
          : role === 'button' && options.name === 'Got it'
            ? dialog.children[1]
            : undefined;
        return new Locator(target ? [target] : [], {}, true);
      }
    }
    const dialog = new ElementNode('DIV').append(new ElementNode('H2')).append(new ElementNode('BUTTON'));
    const page = {
      locator: vi.fn(() => new Locator([dialog], { role: 'dialog', 'aria-modal': 'true', 'aria-owns': null })),
    };
    const captured = await captureTooManyRequestsSource(page, {
      observedAt: '2026-08-03T00:00:00.000Z',
      sourceLocalOccurrence: 'capture:test',
    });
    expect(captured.shape).toEqual(exactShape());
    const ambiguousPage = { locator: vi.fn(() => new Locator([dialog, dialog], { role: 'dialog', 'aria-modal': 'true' })) };
    await expect(captureTooManyRequestsSource(ambiguousPage)).rejects.toThrow('capture_ambiguous_visible_match');
  });
});