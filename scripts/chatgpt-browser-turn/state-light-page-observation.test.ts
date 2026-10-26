import { afterEach, describe, expect, it, vi } from 'vitest';

import './too-many-requests-capture.test-cases.ts';
import {
  COMPOSER_SELECTOR,
  readAssistantTurnCompletionReady,
  readAssistantTurnGenerating,
} from './ui-adapter.ts';
import {
  ASSISTANT_MESSAGE_SELECTOR,
  ASSISTANT_TURN_ANCESTOR_XPATH,
  ASSISTANT_TURN_ACTION_SELECTOR,
  ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
  MESSAGE_AUTHOR_ROLE_ATTR,
  CONNECTION_RECOVERY_STATUS_SELECTOR,
  MESSAGE_NODE_SELECTOR,
  RENDERED_STOP_BUTTON_SELECTOR,
  matchesStopButtonSelector,
} from './product-page-selectors.ts';
import { __testComposerMutation, __testSendDelivery, __testWaitForExistingGeneration, atomicSnapshotSignature, keyedHarvestCandidate, revalidateKeyedHarvest } from './state-light-turn-base.ts';
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
  proseMirrorEditorSurface,
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
      if (name === MESSAGE_AUTHOR_ROLE_ATTR) return 'user-message';
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
    getAttribute: vi.fn(async (name: string) => name === MESSAGE_AUTHOR_ROLE_ATTR ? 'user-message' : null),
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
        if (name === MESSAGE_AUTHOR_ROLE_ATTR) return 'assistant-message';
        if (name === 'data-is-streaming') return generating ? 'true' : null;
        return null;
      }),
      innerText: vi.fn(async () => 'FINAL'),
      locator: vi.fn((selector: string) => {
        if (selector === `[${MESSAGE_AUTHOR_ROLE_ATTR}]`) {
          return scalarLocator({
            count: vi.fn(async () => 1),
            getAttribute: vi.fn(async () => 'assistant-message'),
          });
        }
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
  // Small rendered-DOM mock: synthetic UI nodes expose only the browser
  // primitives consumed by the actual evaluateAll callbacks, no Markdown source.
  type RichBlock = { prose: string; tag?: string; displayContents?: boolean } | { directText: string } | {
    code: string; label?: string; extraLabel?: string; nested?: boolean;
    divHeader?: boolean; headerClass?: boolean;
    hidden?: boolean; copyControl?: boolean; directPre?: boolean; interleavedProse?: string; spanProse?: string;
    excludedCodeDescendant?: 'aria-hidden' | 'inert' | 'role-button' | 'button';
  };
  function richNode(
    tagName: string, innerText = '', attrs: Record<string, string> = {}, shown = true,
    displayContents = false,
  ): any {
    const children: any[] = [];
    const node: any = {
      nodeType: 1, tagName, innerText, textContent: innerText, children, childNodes: [] as any[],
      parentElement: null, attributes: attrs, shown, displayContents,
      ownerDocument: {
        defaultView: {
          getComputedStyle: (element: any) => ({
            display: element.displayContents ? 'contents' : !element.shown ? 'none' : (element.computedDisplay ?? 'block'), visibility: 'visible',
          }),
        },
      },
      getClientRects: () => shown ? [{}] : [],
      getBoundingClientRect: () => ({ height: shown ? 1 : 0 }),
      getAttribute: (name: string) => attrs[name] ?? null,
      hasAttribute: (name: string) => Object.hasOwn(attrs, name),
      append(child: any) {
        child.parentElement = node;
        children.push(child);
        node.childNodes.push(child);
        return node;
      },
      appendText(text: string) {
        node.childNodes.push({ nodeType: 3, textContent: text, parentElement: node });
        return node;
      },
      querySelectorAll(selector: string): any[] {
        // Small generic-tree selector interpreter: membership follows tags,
        // classes, attributes and ancestry, not the renderer selector string.
        const simple = (candidate: any, token: string): boolean => {
          if (/^[a-z][a-z0-9-]*$/iu.test(token)) return candidate.tagName === token.toUpperCase();
          if (/^\.[a-z][a-z0-9_-]*$/iu.test(token))
            return (candidate.getAttribute('class') ?? '').split(/\s+/u).includes(token.slice(1));
          const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/u.exec(token);
          if (attr) return candidate.hasAttribute(attr[1]!) && (attr[2] === undefined
            || candidate.getAttribute(attr[1]!) === attr[2]);
          return false;
        };
        const matches = (candidate: any): boolean => selector.split(/,\s*/u).some((group) => {
          const chain = group.trim().split(/\s+/u);
          if (!simple(candidate, chain.pop() ?? '')) return false;
          let ancestor = candidate.parentElement;
          for (let i = chain.length - 1; i >= 0; i--) {
            while (ancestor && !simple(ancestor, chain[i]!)) ancestor = ancestor.parentElement;
            if (!ancestor) return false;
            ancestor = ancestor.parentElement;
          }
          return true;
        });
        const walk = (parent: any): any[] => parent.children.flatMap((child: any) =>
          [...(matches(child) ? [child] : []), ...walk(child)]);
        return walk(node);
      },
      querySelector(selector: string): any { return node.querySelectorAll(selector)[0] ?? null; },
    };
    return node;
  }

  function richAssistantNode(outerText: string, blocks: RichBlock[], key = 'assistant-rich-12345678') {
    const outer = richNode('ARTICLE', outerText);
    // Explicitly derived hashed root shape; no authenticated live CDP capture is claimed.
    const root = richNode('DIV', '', { class: 'MarkdownRoot_boundedFixture__7Zd9' });
    outer.append(root);
    for (const block of blocks) {
      if ('directText' in block) {
        root.appendText(block.directText);
        continue;
      }
      if ('prose' in block) {
        const prose = richNode((block.tag ?? 'P').toUpperCase(), block.prose);
        if (block.displayContents) {
          // The wrapper has no rectangle while its child text is rendered.
          const wrapper = richNode('DIV', '', {}, false, true);
          wrapper.append(prose);
          root.append(wrapper);
        } else {
          root.append(prose);
        }
        continue;
      }
      const container = richNode(block.nested ? 'BLOCKQUOTE' : 'DIV');
      if (block.label || block.extraLabel) {
        // A semantic header is distinguishable from ordinary prose SPANs.
        const header = richNode(block.divHeader ? 'DIV' : 'HEADER', '', block.headerClass ? { class: 'header' } : {});
        if (block.label) header.append(richNode('SPAN', block.label));
        if (block.extraLabel) header.append(richNode('SPAN', block.extraLabel));
        if (block.copyControl && block.divHeader) header.append(richNode('BUTTON', 'Copy'));
        container.append(header);
      }
      if (block.spanProse) container.append(richNode('SPAN', block.spanProse));
      if (block.copyControl && !block.divHeader) container.append(richNode('BUTTON', 'Copy'));
      if (block.interleavedProse) container.append(richNode('P', block.interleavedProse));
      const pre = richNode('PRE', '', {}, !block.hidden);
      const code = richNode('CODE', block.code, {}, !block.hidden);
      if (block.excludedCodeDescendant) {
        const kind = block.excludedCodeDescendant;
        const attrs = kind === 'aria-hidden' ? { 'aria-hidden': 'true' }
          : kind === 'inert' ? { inert: '' }
            : kind === 'role-button' ? { role: 'button' } : {};
        code.append(richNode(kind === 'button' ? 'BUTTON' : 'SPAN', 'UI', attrs));
      }
      pre.append(code);
      if (block.directPre) root.append(pre);
      else { container.append(pre); root.append(container); }
    }
    const baseQuery = outer.querySelector.bind(outer);
    Object.assign(outer, {
      getAttribute: (name: string) => name === MESSAGE_AUTHOR_ROLE_ATTR
        ? 'assistant-message' : name === 'data-message-id' ? key : null,
      querySelector: (selector: string) => selector === `[${MESSAGE_AUTHOR_ROLE_ATTR}]`
        ? { getAttribute: () => 'assistant-message' } : baseQuery(selector),
      closest: () => ({ querySelector: (selector: string) =>
        selector === ASSISTANT_TURN_ACTION_SELECTOR ? {} : null }),
    });
    // Give content root and descendants the same ownerDocument as outer.
    const doc = outer.ownerDocument;
    const propagate = (node: any) => { node.ownerDocument = doc; for (const child of node.children) propagate(child); };
    propagate(outer);
    return outer;
  }

  async function readAtomicEvidence(
    messages: Array<{ role: 'user' | 'assistant'; text: string; code?: { visible: string; domTextContent: string }; domTextContent?: string }>,
    generationQuery: () => unknown,
  ) {
    const elements = messages.map((message, index) => {
      if (message.role === 'assistant' && message.code) {
        return richAssistantNode(message.text, [
          { prose: 'Before' },
          { code: message.code.visible, copyControl: true },
          { prose: 'Following  prose\nEXECUTION_STATUS: complete' },
        ], `assistant-${index}-12345678`);
      }
      return {
        getAttribute: (name: string) => {
          if (name === MESSAGE_AUTHOR_ROLE_ATTR) return message.role === 'user' ? 'user-message' : 'assistant-message';
          if (name === 'data-message-id') return `${message.role}-${index}-12345678`;
          return null;
        },
        closest: () => ({ querySelector: (selector: string) => message.code && selector === ASSISTANT_TURN_ACTION_SELECTOR ? {} : null }),
        querySelector: (selector: string) => selector === `[${MESSAGE_AUTHOR_ROLE_ATTR}]`
          ? { getAttribute: () => message.role === 'user' ? 'user-message' : 'assistant-message' }
          : null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ height: 1 }),
        innerText: message.text,
        textContent: message.domTextContent,
      };
    });
    const querySelectorAll = vi.fn((selector: string) => {
      if (selector !== '[data-testid="stop-button"], button[aria-label*="Stop"], [aria-busy="true"], [data-is-streaming="true"], [data-testid*="tool"][data-state="running"], [data-testid*="tool"][data-state="loading"]') return [];
      const match = generationQuery();
      return match ? [match] : [];
    });
    const priorDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { querySelectorAll };
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
      return { result: await readPageObservation(page), querySelectorAll, page };
    } finally {
      if (priorDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = priorDocument;
    }
  }

  it('carries the exact probe tuple from one atomic production DOM read', async () => {
    const dead = await readAtomicEvidence([{ role: 'user', text: markedPrompt }], () => null);
    expect(dead.result.pageTurnEvidence).toMatchObject({ generationInProgress: false, observedAssistantNodes: 0, continueGeneratingVisible: false });
    expect(classifyBrowserGptPageTurnStatus(
      dead.result.pageTurnEvidence!.generationInProgress,
      dead.result.pageTurnEvidence!.observedAssistantNodes,
    )).toBe('dead');

    const live = await readAtomicEvidence(
      [{ role: 'user', text: markedPrompt }],
      () => ({ getBoundingClientRect: () => ({ height: 1 }) }),
    );
    expect(live.result.pageTurnEvidence).toMatchObject({ generationInProgress: true, observedAssistantNodes: 0, continueGeneratingVisible: false });
    expect(classifyBrowserGptPageTurnStatus(
      live.result.pageTurnEvidence!.generationInProgress,
      live.result.pageTurnEvidence!.observedAssistantNodes,
    )).toBe('long_running');

    const completed = await readAtomicEvidence([
      { role: 'user', text: markedPrompt },
      { role: 'assistant', text: 'historical or completed assistant' },
    ], () => null);
    expect(completed.result.pageTurnEvidence).toMatchObject({ generationInProgress: false, observedAssistantNodes: 1, continueGeneratingVisible: false });
    expect(classifyBrowserGptPageTurnStatus(
      completed.result.pageTurnEvidence!.generationInProgress,
      completed.result.pageTurnEvidence!.observedAssistantNodes,
    )).toBe('completed');
    expect(completed.querySelectorAll).toHaveBeenCalledWith(
      '[data-testid="stop-button"], button[aria-label*="Stop"], [aria-busy="true"], [data-is-streaming="true"], [data-testid*="tool"][data-state="running"], [data-testid*="tool"][data-state="loading"]',
    );
  });

  it('captures an actionable text-named Continue generating control on its own assistant turn', async () => {
    const button = {
      getAttribute: (name: string) => name === 'aria-label' ? null : null,
      innerText: 'Continue generating',
      textContent: 'Continue generating',
      getBoundingClientRect: () => ({ width: 120, height: 24 }),
      hasAttribute: () => false,
    };
    const turn = {
      querySelector: (selector: string) => selector === ASSISTANT_TURN_ACTION_SELECTOR ? {} : null,
      querySelectorAll: (selector: string) => selector === 'button' ? [button] : [],
    };
    const makeMessage = (role: 'user' | 'assistant', text: string) => ({
      getAttribute: (name: string) => name === MESSAGE_AUTHOR_ROLE_ATTR
        ? `${role}-message`
        : name === 'data-message-id' ? null : null,
      closest: () => turn,
      querySelector: (selector: string) => selector === `[${MESSAGE_AUTHOR_ROLE_ATTR}]`
        ? { getAttribute: () => `${role}-message` }
        : selector === ASSISTANT_TURN_ACTION_SELECTOR && role === 'assistant' ? {} : null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ height: 1 }),
      innerText: text,
    });
    const elements = [makeMessage('user', markedPrompt), makeMessage('assistant', 'partial reply')];
    const nodes = scalarLocator({
      evaluateAll: vi.fn(async (callback: (items: Element[], args: unknown) => unknown, args: unknown) => (
        callback(elements as unknown as Element[], args)
      )),
    });
    const page = { locator: vi.fn((selector: string) => selector === MESSAGE_NODE_SELECTOR ? nodes : scalarLocator()) };
    const priorDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { querySelectorAll: () => [] };
    try {
      const observation = await readPageObservation(page, marker, 0);
      expect(observation.transcriptIncomplete).toBe(false);
      expect(observation.snapshot?.carriers[1]).toMatchObject({
        role: 'assistant',
        continuationVisible: true,
        completionReady: false,
      });
      expect(observation.ownedWindowCompletionReady).toBe(false);
    } finally {
      if (priorDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = priorDocument;
    }
  });

  it('does not count an unrendered Stop as generation in progress', async () => {
    const finished = await readAtomicEvidence([
      { role: 'assistant', text: 'finished reply' },
    ], () => ({ getBoundingClientRect: () => ({ height: 0 }) }));
    expect(finished.result.pageTurnEvidence).toMatchObject({ generationInProgress: false, observedAssistantNodes: 1, continueGeneratingVisible: false });
  });

  it('preserves a valid transcript and fails closed when generation reading throws', async () => {
    const observation = await readAtomicEvidence(
      [{ role: 'user', text: markedPrompt }],
      () => { throw new Error('generation read failed'); },
    );
    expect(observation.result.messages).toEqual([{ role: 'user', text: markedPrompt }]);
    expect(observation.result.transcriptIncomplete).toBe(false);
    expect(observation.result.pageTurnEvidence).toMatchObject({
      generationInProgress: 'unknown',
      observedAssistantNodes: 0,
      continueGeneratingVisible: false,
    });
    expect(classifyBrowserGptPageTurnStatus(
      observation.result.pageTurnEvidence!.generationInProgress,
      observation.result.pageTurnEvidence!.observedAssistantNodes,
    )).toBe('unknown');
  });


  it('preserves all raw Python indentation, tabs and blank lines from an atomic assistant observation', async () => {
    const full = [
      'Before  code',
      '',
      'def process():',
      '    if ready:',
      '        print("eight spaces")',
      '\t\tprint("two tabs")',
      '',
      'After  code',
      'EXECUTION_STATUS: complete',
    ].join('\n');
    const { result } = await readAtomicEvidence([
      { role: 'user', text: markedPrompt },
      { role: 'assistant', text: full },
    ], () => null);
    expect(result.messages[1]?.text).toBe(full);
    expect(classifyPageObservation(result.messages, 0, marker, false)).toEqual({ state: 'ready', reply: full });
    expect(replyStabilityMatches(full, full.replace('        print', '       print'))).toBe(false);
  });

  const parentPrefix2590 = [
    'def compare_digests():',
    '    if serial_digest.digest() != pooled_digest.digest():',
  ].join('\n');
  const threeVisibleLines2590 = parentPrefix2590 + '\n        raise ValueError("different")';
  const fullVisibleCode2590 = threeVisibleLines2590 + '\n    return True';

  it.each([
    {
      caseName: 'parent shorter than fully rendered code child',
      visible: fullVisibleCode2590, domTextContent: fullVisibleCode2590, expectedCode: fullVisibleCode2590,
    },
    {
      // <pre><code>visible text<span style="display:none">HIDDEN-DESCENDANT</span></code></pre>
      caseName: 'hidden descendant after complete visible code',
      visible: fullVisibleCode2590, domTextContent: fullVisibleCode2590 + 'HIDDEN-DESCENDANT', expectedCode: fullVisibleCode2590,
    },
    {
      caseName: 'child innerText extends parent but textContent alone has a further line',
      visible: threeVisibleLines2590, domTextContent: fullVisibleCode2590, expectedCode: threeVisibleLines2590,
    },
    {
      caseName: 'only a hidden descendant extends textContent',
      visible: parentPrefix2590, domTextContent: parentPrefix2590 + '\n        HIDDEN-DESCENDANT', expectedCode: parentPrefix2590,
    },
  ])('uses only atomic rendered code and preserves following prose ($caseName)', async ({ visible, domTextContent, expectedCode }) => {
    // Fixture-only evidence. AC1 remains unverified: two tabs, zero assistant code blocks.
    const footer = '\n\nFollowing  prose\nEXECUTION_STATUS: complete';
    const partialOuter = 'Before\n\n' + parentPrefix2590 + footer;
    const expected = 'Before\n\n```\n' + expectedCode + (expectedCode.endsWith('\n') ? '' : '\n') + '```' + footer;
    const { result, page } = await readAtomicEvidence([
      { role: 'user', text: markedPrompt },
      { role: 'assistant', text: partialOuter, code: { visible, domTextContent }, domTextContent: 'SCREEN-READER-ONLY' },
    ], () => null);
    expect(result.messages[1]?.text).toBe(expected);
    expect(result.messages[1]?.text).not.toContain('HIDDEN-DESCENDANT');
    expect(result.messages[1]?.text).not.toContain('SCREEN-READER-ONLY');
    expect(result.snapshot?.carriers[1]?.text).toBe(expected);
    const snapshot = result.snapshot!;
    const userKey = snapshot.carriers[0]!.key!;
    const previous = { complete: true, carriers: [] };
    const candidate = keyedHarvestCandidate(snapshot, previous, userKey);
    expect(candidate.state).toBe('ready');
    if (candidate.state !== 'ready') throw new Error('expected_keyed_candidate');
    expect(candidate.reply).toBe(expected);
    expect(await revalidateKeyedHarvest(page, previous, userKey, {
      ...candidate,
      snapshotSignature: atomicSnapshotSignature(snapshot),
    })).toEqual({ state: 'ready', reply: expected });
  });

  function richPage(
    blocks: RichBlock[], historical?: RichBlock[],
    options: { initialHistoricalOnly?: boolean; laterForeign?: boolean } = {},
  ) {
    const current = richAssistantNode('OUTER MISLEADING FIRST LINE; UI COPY; HIDDEN', blocks);
    const user = {
      getAttribute: (name: string) => name === MESSAGE_AUTHOR_ROLE_ATTR ? 'user-message'
        : name === 'data-message-id' ? 'owned-user-12345678' : null,
      querySelector: (selector: string) => selector === '[' + MESSAGE_AUTHOR_ROLE_ATTR + ']'
        ? { getAttribute: () => 'user-message' } : null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ height: 1 }),
      innerText: markedPrompt,
    };
    const history = historical
      ? [richAssistantNode('HISTORICAL WHOLE ROW', historical, 'assistant-old-12345678')]
      : [];
    const historicalUser = { ...user, innerText: 'HISTORICAL PROMPT',
      getAttribute: (name: string) => name === MESSAGE_AUTHOR_ROLE_ATTR ? 'user-message'
        : name === 'data-message-id' ? 'historical-user-12345678' : null };
    const prior = options.initialHistoricalOnly ? [historicalUser, ...history] : history;
    const foreignUser = { ...user, innerText: 'FOREIGN USER PROMPT',
      getAttribute: (name: string) => name === MESSAGE_AUTHOR_ROLE_ATTR ? 'user-message'
        : name === 'data-message-id' ? 'foreign-user-12345678' : null };
    const foreign = options.laterForeign
      ? [foreignUser, richAssistantNode('FOREIGN WHOLE ROW', [{ prose: 'FOREIGN WHOLE ROW' }], 'assistant-foreign-12345678')]
      : [];
    let historicalOnly = options.initialHistoricalOnly === true;
    let lateContinue = false;
    const nodes = scalarLocator({
      evaluateAll: vi.fn(async (callback: (items: Element[], args: unknown) => unknown, args: unknown) => {
        const old = (globalThis as { document?: unknown }).document;
        const continueButton = {
          getBoundingClientRect: () => ({ height: 20 }),
          hasAttribute: () => false,
          getAttribute: () => null,
          ownerDocument: { defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) } },
        };
        (globalThis as { document?: unknown }).document = {
          querySelectorAll: (selector: string) => selector.includes('continue-generating') && lateContinue
            ? [continueButton] : [],
        };
        try {
          const rows = historicalOnly ? prior : [...prior, user, current, ...foreign];
          return callback(rows as unknown as Element[], args);
        }
        finally {
          if (old === undefined) delete (globalThis as { document?: unknown }).document;
          else (globalThis as { document?: unknown }).document = old;
        }
      }),
    });
    return {
      page: { locator: (selector: string) => selector === MESSAGE_NODE_SELECTOR ? nodes : scalarLocator() },
      current,
      setLateContinue: (value: boolean) => { lateContinue = value; },
      setHistoricalOnly: (value: boolean) => { historicalOnly = value; },
    };
  }


  // Explicitly derived UI structures, not current authenticated CDP specimens.
  // Keep the content root's original children and real ancestor relationships:
  // selectors in richNode walk the generic element tree, not a copied selector.
  function wrapRichContent(current: any) {
    const content = current.children[0]!;
    current.children.splice(0, 1);
    current.childNodes.splice(current.childNodes.indexOf(content), 1);
    const layout = richNode('DIV');
    current.append(layout);
    layout.append(content);
    return { layout, content };
  }


  it('replays the redacted owned rich-code hierarchy without code action UI in the reply (#2694)', async () => {
    // Bounded live structural provenance (not a new capture or a code-language witness):
    // invocation inv_issue2694_capture_r04_20261024_6196313751cf
    // UTC 2026-10-23T20:17:58.986Z; owned NEW project-chat conversation (URL redacted).
    // Read-only Playwright Page.evaluate through exact-owned attachOwnTarget/CDP.
    // state-light-turn-observation/v1, unique marker, source project/URL, profile
    // key/CDP fingerprint and pinned target 4F3CDE8EF469545BBD3449B4BDC26859
    // were checked on the same Page before/after; user/assistant subtree stable.
    // Exact-bound harvest: completed, 419 output bytes, SHA-256
    // 1f2e4a9e595b5b1f67c5b20b42c5e684e43b284634e7335608aa9f4475a19a29.
    // The supplied redacted minimum specifies tag hierarchy, retained classes,
    // attribute/display boundaries, six inline prose spans and highlighted CODE
    // spans, but omits individual masks and measured whitespace positions.
    // The text masks/whitespace below are REDACTED NON-SEMANTIC stand-ins, not
    // reconstructed source bytes; their literal equality is a regression oracle
    // for this tree only, not a claim of equality to the 419-byte harvested reply.
    // This is reply evidence only: not composer, floating, active or causal proof.
    const fixture = richPage([]);
    const assistant = fixture.current;
    assistant.tagName = 'DIV';
    assistant.children.length = 0;
    assistant.childNodes.length = 0;
    const append = (
      parent: any, tag: string, literal = '', attrs: Record<string, string> = {},
      shown = true, displayContents = false,
    ): any => {
      const node = richNode(tag, literal, attrs, shown, displayContents);
      parent.append(node);
      return node;
    };

    const srOnly = append(assistant, 'H4', 'z'.repeat(13), { class: 'sr-only' });
    const shell = append(assistant, 'DIV');
    const group = append(shell, 'DIV', '', { class: 'group flex min-w-0 flex-col' });
    const markdown = append(group, 'DIV', '', {
      class: 'MarkdownRoot-rZKhxa', 'data-markdown-text-style': 'assistant-message',
    });
    const margin = append(markdown, 'DIV', '', { class: 'my-4' });
    const inset = append(margin, 'DIV', '', { style: '--entity-prose-inset:0px' });
    const hiddenChild = append(inset, 'DIV', '', {}, false);
    const portal = append(inset, 'DIV', '', {
      class: 'relative PortalBoundary-TFj9W2 Renderer-ojZscX',
    });
    const renderer = append(portal, 'DIV', '', {
      class: 'DilRenderer-tB76Jj DilResponseRoot-HfQrEh Reveal-k2IWvM',
    });
    renderer.computedDisplay = 'flex';

    const proseParts = ['xxx', ' ', 'xxxx', '  ', 'xxxxx', '.'];
    const proseText = proseParts.join('');
    const prose = append(renderer, 'P', proseText, { class: 'TextBase-hXhSqg Text-lIMP0_' });
    for (const part of proseParts) append(prose, 'SPAN', part);

    const codeOuter = append(renderer, 'DIV');
    const codeBlock = append(codeOuter, 'DIV', '', { class: 'CodeBlock-zu1QM3' });
    const surface = append(codeBlock, 'DIV', '', {
      class: 'Root-iW7ipz CodeSurface-UAMd1A Surface-BCuIs1',
    });
    const uiOne = 'q'.repeat(7);
    const uiTwo = 'q'.repeat(9);
    const actionBar = append(surface, 'DIV', uiOne + uiTwo, {
      class: 'ActionBar-KWWAct', contenteditable: 'false',
    });
    append(actionBar, 'SVG');
    append(actionBar, 'BUTTON', uiOne);
    const transparent = append(actionBar, 'SPAN', '', { class: 'contents' }, false, true);
    append(transparent, 'BUTTON', uiTwo);

    const relative = append(surface, 'DIV', '', { class: 'relative' });
    const codePane = append(relative, 'DIV', '', { class: 'InlineCodePane-EYx4bd' });
    const viewer = append(codePane, 'DIV', '', { class: 'Viewer-ALA646' });
    const scrollport = append(viewer, 'DIV', '', { class: 'chatgpt-code-scrollport' });
    const pre = append(scrollport, 'PRE', '', {
      class: 'ViewerContent-Cg8AgN whitespace-pre',
    });
    const codeParts = ['xxx', '  ', 'xxxx', '\n    ', 'xx', '\n'];
    const codeText = codeParts.join('');
    const code = append(pre, 'CODE', codeText);
    append(code, 'SPAN', codeParts[0]!);
    code.appendText(codeParts[1]!);
    append(code, 'SPAN', codeParts[2]!);
    code.appendText(codeParts[3]!);
    append(code, 'SPAN', codeParts[4]!);
    code.appendText(codeParts[5]!);

    const footerParts = ['yyyy', ' ', 'yyyyy'];
    const footerText = footerParts.join('');
    const footer = append(renderer, 'P', footerText, { class: 'TextBase-hXhSqg Text-lIMP0_' });
    for (const part of footerParts) append(footer, 'SPAN', part);
    const trailingAction = append(portal, 'BUTTON', 'q'.repeat(11), {
      'aria-hidden': 'true', class: 'opacity-0 pointer-events-none',
    });
    assistant.innerText = srOnly.innerText + proseText + actionBar.innerText
      + codeText + footerText + trailingAction.innerText;
    assistant.textContent = assistant.innerText;

    expect(assistant.querySelectorAll('pre code')).toHaveLength(1);
    expect(assistant.querySelectorAll('.contents button')).toHaveLength(1);
    expect(assistant.querySelectorAll('[data-markdown-text-style="assistant-message"]')).toHaveLength(1);
    expect(renderer.children.map((item: any) => item.tagName)).toEqual(['P', 'DIV', 'P']);
    expect(renderer.ownerDocument.defaultView.getComputedStyle(renderer).display).toBe('flex');
    expect(hiddenChild.ownerDocument.defaultView.getComputedStyle(hiddenChild).display).toBe('none');
    expect(transparent.ownerDocument.defaultView.getComputedStyle(transparent).display).toBe('contents');
    expect(actionBar.getAttribute('contenteditable')).toBe('false');
    expect(code.innerText).toBe(codeText);
    expect(code.textContent).toBe(codeText);

    const fence = String.fromCharCode(96).repeat(3);
    const expected = [proseText, fence + '\n' + codeText + fence, footerText].join('\n\n');
    const observed = await readPageObservation(fixture.page, marker, 0);
    expect(observed.transcriptIncomplete).toBe(false);
    expect(observed.snapshot?.complete).toBe(true);
    expect(observed.snapshot?.carriers.filter((row) => row.role === 'assistant')).toHaveLength(1);
    expect(observed.snapshot?.carriers.at(-1)?.text).toBe(expected);
    expect(observed.messages.at(-1)?.text).toBe(expected);
    for (const uiOnly of [srOnly.innerText, uiOne, uiTwo, trailingAction.innerText]) {
      expect(expected).not.toContain(uiOnly);
      expect(observed.messages.at(-1)?.text).not.toContain(uiOnly);
    }

    const previous = { complete: true, carriers: [] } as const;
    const ownKey = observed.snapshot!.carriers.find((row) => row.role === 'user')!.key!;
    const candidate = keyedHarvestCandidate(observed.snapshot!, previous, ownKey);
    expect(candidate).toMatchObject({ state: 'ready', reply: expected });
    if (candidate.state !== 'ready') throw new Error('captured_structure_not_ready');
    await expect(revalidateKeyedHarvest(fixture.page, previous, ownKey, {
      ...candidate, snapshotSignature: atomicSnapshotSignature(observed.snapshot!),
    })).resolves.toEqual({ state: 'ready', reply: expected });

    // Derived negative only: visible non-control action-bar text is NOT in the
    // captured witness and must revoke completeness rather than be dropped.
    actionBar.appendText('UNACCOUNTED_NON_CONTROL_TEXT');
    const changed = await readPageObservation(fixture.page, marker, 0);
    expect(changed.transcriptIncomplete).toBe(true);
    expect(changed.snapshot?.complete).toBe(false);
    await expect(revalidateKeyedHarvest(fixture.page, previous, ownKey, {
      ...candidate, snapshotSignature: atomicSnapshotSignature(observed.snapshot!),
    })).resolves.toEqual({ state: 'continuity-unproven' });
  });

  // Live ChatGPT reply scaffold (#2694 follow-up captures): assistant markdown root,
  // DilRenderer content root, labelled code-block action bars.
  const liveReplyFixture = () => {
    const fixture = richPage([]);
    const assistant = fixture.current;
    assistant.tagName = 'DIV';
    assistant.children.length = 0;
    assistant.childNodes.length = 0;
    const append = (
      parent: any, tag: string, literal = '', attrs: Record<string, string> = {},
      shown = true, displayContents = false,
    ): any => {
      const node = richNode(tag, literal, attrs, shown, displayContents);
      parent.append(node);
      return node;
    };
    append(assistant, 'H4', 'ChatGPT said:', { class: 'sr-only' });
    const group = append(append(assistant, 'DIV'), 'DIV', '', { class: 'group flex min-w-0 flex-col' });
    const markdown = append(group, 'DIV', '', {
      class: 'MarkdownRoot-rZKhxa', 'data-markdown-text-style': 'assistant-message',
    });
    const copyRoot = append(markdown, 'DIV', '', { 'data-markdown-copy': 'contents' });
    const inset = append(copyRoot, 'DIV');
    append(inset, 'DIV', '', { hidden: '' }, false);
    const portal = append(inset, 'DIV', '', { class: 'PortalBoundary-TFj9W2' });
    const renderer = append(portal, 'DIV', '', { class: 'DilRenderer-tB76Jj' });
    renderer.computedDisplay = 'flex';
    const prose = (text: string) => {
      const p = append(renderer, 'P', text, { class: 'TextBase-hXhSqg' });
      for (const word of text.split(/(?<= )/u)) append(p, 'SPAN', word);
    };
    const codeBlock = (label: string, run: boolean, body: (surface: any) => void) => {
      const wrapper = append(append(renderer, 'DIV'), 'DIV', '', { class: 'CodeBlock-zu1QM3' });
      const root = append(wrapper, 'DIV', '', { 'data-code-block': 'true', 'data-markdown-copy': 'code-block' });
      const bar = append(root, 'DIV', label + (run ? 'Run' : ''), {
        'data-markdown-copy': 'exclude', contenteditable: 'false', class: 'ActionBar-KWWAct',
      });
      append(bar, 'SVG');
      append(bar, 'DIV', label).appendText(label);
      const controls = append(append(bar, 'DIV'), 'DIV', '', {
        'data-code-block-controls': 'true', role: 'presentation',
      });
      const tooltip = append(controls, 'SPAN', '', { 'data-state': 'closed', class: 'contents' }, false, true);
      append(tooltip, 'BUTTON', '', { 'aria-label': 'Enable word wrap' });
      append(controls, 'BUTTON', '', { 'aria-label': 'Copy code' });
      if (run) append(controls, 'BUTTON', 'Run', { 'aria-label': 'Run code' });
      const relative = append(root, 'DIV', '', { class: 'relative' });
      body(relative);
      append(relative, 'BUTTON', '', { 'aria-hidden': 'true', 'aria-label': 'Scroll to bottom' });
    };
    return { fixture, assistant, markdown, append, prose, codeBlock };
  };

  it('replays the live canary reply: PRE>CODE sql block + CodeMirror python block, labelled action bars (#2694 follow-up)', async () => {
    // Structure from a live capture of a synthetic canary reply (2026-10-23T21:33Z,
    // new chat in the orchestrator-pack project): ChatGPT marks code roots
    // data-code-block=true and each action bar data-markdown-copy=exclude. The bar
    // holds an SVG, a visible language label and display:contents tooltip wrappers
    // around buttons ("Run" has text). The runnable python block has no PRE: it is a
    // CodeMirror .cm-content textbox.
    const { fixture, assistant, append, prose, codeBlock } = liveReplyFixture();
    const sql = 'SELECT\n    1 AS result\nFROM dual;';
    const python = 'def canary():\n    return True';
    prose('The canary check is ready.');
    codeBlock('SQL', false, (relative) => {
      const pre = append(append(relative, 'DIV'), 'PRE');
      const code = append(pre, 'CODE', sql);
      append(code, 'SPAN', 'SELECT');
    });
    prose('The Python function follows.');
    let cmContent: any;
    codeBlock('Python', true, (relative) => {
      const scroller = append(append(append(relative, 'DIV'), 'DIV', '', { class: 'cm-editor' }), 'DIV', '', {
        class: 'cm-scroller',
      });
      cmContent = append(scroller, 'DIV', python, {
        contenteditable: 'true', role: 'textbox', 'aria-label': 'Edit code',
        'data-language': 'python', class: 'cm-content',
      });
      for (const line of python.split('\n')) append(cmContent, 'DIV', line, { class: 'cm-line' });
    });
    prose('CANARY-DONE');
    assistant.innerText = 'The canary check is ready.\n\nSQL\n' + sql + '\n\nThe Python function follows.\n\nPython\nRun\n'
      + python + '\n\nCANARY-DONE';
    assistant.textContent = assistant.innerText;

    const fence = String.fromCharCode(96).repeat(3);
    // Fence labels are the rendered bar labels lower-cased.
    const expected = 'The canary check is ready.\n\n' + fence + 'sql\n' + sql + '\n' + fence
      + '\n\nThe Python function follows.\n\n' + fence + 'python\n' + python + '\n' + fence + '\n\nCANARY-DONE';
    const observed = await readPageObservation(fixture.page, marker, 0);
    expect(observed.transcriptIncomplete).toBe(false);
    expect(observed.snapshot?.complete).toBe(true);
    expect(observed.snapshot?.carriers.at(-1)?.text).toBe(expected);
    expect(observed.messages.at(-1)?.text).toBe(expected);
    expect(expected).not.toMatch(/Run|Copy code|word wrap/u);

    const previous = { complete: true, carriers: [] } as const;
    const ownKey = observed.snapshot!.carriers.find((row) => row.role === 'user')!.key!;
    const candidate = keyedHarvestCandidate(observed.snapshot!, previous, ownKey);
    expect(candidate).toMatchObject({ state: 'ready', reply: expected });
    if (candidate.state !== 'ready') throw new Error('live_canary_not_ready');
    await expect(revalidateKeyedHarvest(fixture.page, previous, ownKey, {
      ...candidate, snapshotSignature: atomicSnapshotSignature(observed.snapshot!),
    })).resolves.toEqual({ state: 'ready', reply: expected });

    // A virtualized CodeMirror body (.cm-gap instead of rendered lines) is partial code.
    append(cmContent, 'DIV', '', { class: 'cm-gap' });
    const virtualized = await readPageObservation(fixture.page, marker, 0);
    expect(virtualized.transcriptIncomplete).toBe(true);
    expect(virtualized.snapshot?.complete).toBe(false);
    cmContent.children.pop();
    cmContent.childNodes.pop();
    expect((await readPageObservation(fixture.page, marker, 0)).snapshot?.complete).toBe(true);

    // Unknown visible text in a labelled bar stays refused.
    append(assistant.querySelectorAll('[data-markdown-copy="exclude"]')[1], 'DIV', 'EXTRA').appendText('EXTRA');
    const changed = await readPageObservation(fixture.page, marker, 0);
    expect(changed.transcriptIncomplete).toBe(true);
    expect(changed.snapshot?.complete).toBe(false);
  });

  it('serializes live data-d divider, table and badge blocks beside a code block (#2704, #2712)', async () => {
    // Live LeoPoker 6adc9be1 and AppliedIn 6adc8ac5 (2026-10-24): a markdown rule is an
    // empty DIV[data-d-component=divider]; a table is DIV[data-d-component=table] > DIV >
    // TABLE beside an aria-hidden DIV. Both refused the whole reply before #2704.
    // AppliedIn 6add61b6 and LeoPoker 6add6360 (2026-10-25): a status pill is a
    // text-only DIV[data-d-component=badge]; it refused the whole reply before #2712.
    const { fixture, assistant, append, prose, codeBlock } = liveReplyFixture();
    const renderer = assistant.querySelector('.DilRenderer-tB76Jj');
    const python = 'assert ok';
    const tableText = 'Check\tResult\nNode\tPassed';
    prose('Status follows.');
    codeBlock('Python', false, (relative) => {
      const pre = append(append(relative, 'DIV'), 'PRE');
      append(pre, 'CODE', python);
    });
    const divider = append(renderer, 'DIV', '', { 'data-d-component': 'divider' });
    const tableWrap = append(renderer, 'DIV', tableText, { 'data-d-component': 'table' });
    const table = append(append(tableWrap, 'DIV', tableText), 'TABLE', tableText);
    append(tableWrap, 'DIV', '', { 'aria-hidden': 'true' });
    const badgeText = 'Commit published';
    const badge = append(renderer, 'DIV', badgeText, { 'data-d-component': 'badge' });
    prose('DONE');

    const fence = String.fromCharCode(96).repeat(3);
    const expected = 'Status follows.\n\n' + fence + 'python\n' + python + '\n' + fence
      + '\n\n---\n\n' + tableText + '\n\n' + badgeText + '\n\nDONE';
    const observed = await readPageObservation(fixture.page, marker, 0);
    expect(observed.transcriptIncomplete).toBe(false);
    expect(observed.snapshot?.carriers.at(-1)?.text).toBe(expected);
    const previous = { complete: true, carriers: [] } as const;
    const ownKey = observed.snapshot!.carriers.find((row) => row.role === 'user')!.key!;
    const candidate = keyedHarvestCandidate(observed.snapshot!, previous, ownKey);
    expect(candidate).toMatchObject({ state: 'ready', reply: expected });
    if (candidate.state !== 'ready') throw new Error('data_d_blocks_not_ready');
    await expect(revalidateKeyedHarvest(fixture.page, previous, ownKey, {
      ...candidate, snapshotSignature: atomicSnapshotSignature(observed.snapshot!),
    })).resolves.toEqual({ state: 'ready', reply: expected });

    // Visible text outside the TABLE, a second TABLE, or a non-empty divider stays refused.
    const refused = async () => {
      const read = await readPageObservation(fixture.page, marker, 0);
      expect(read.transcriptIncomplete).toBe(true);
      expect(read.snapshot?.complete).toBe(false);
    };
    tableWrap.innerText = tableText + '\nCAPTION';
    await refused();
    tableWrap.innerText = tableText;
    append(tableWrap.children[0], 'TABLE', '');
    await refused();
    tableWrap.children[0].children.pop();
    tableWrap.children[0].childNodes.pop();
    divider.innerText = 'RULE';
    await refused();
    divider.innerText = '';
    // CSS-hidden content leaves innerText empty but is still not an empty rule.
    divider.textContent = 'HIDDEN-BY-CSS';
    await refused();
    divider.textContent = '';
    // A badge with nested markup or CSS-hidden text is not a plain status pill.
    append(badge, 'SPAN', badgeText);
    await refused();
    badge.children.pop();
    badge.childNodes.pop();
    badge.textContent = badgeText + 'HIDDEN-BY-CSS';
    await refused();
    badge.textContent = badgeText;
    expect((await readPageObservation(fixture.page, marker, 0)).snapshot?.carriers.at(-1)?.text).toBe(expected);
    expect(table.tagName).toBe('TABLE');
  });

  it('reads a live code-free reply without the unit screen-reader heading (#2694 follow-up)', async () => {
    // Live LeoPoker review replies (2026-10-23) rendered pretty JSON as prose. The unit
    // innerText starts with the sr-only "ChatGPT said:" heading, which the review
    // parser rejected as free-form prose.
    const { fixture, assistant, markdown, prose } = liveReplyFixture();
    const reply = '{\n"findings": []\n}';
    prose(reply);
    markdown.innerText = reply;
    assistant.innerText = 'ChatGPT said:\n\n' + reply;
    assistant.textContent = assistant.innerText;

    const observed = await readPageObservation(fixture.page, marker, 0);
    expect(observed.transcriptIncomplete).toBe(false);
    expect(observed.snapshot?.complete).toBe(true);
    expect(observed.snapshot?.carriers.at(-1)?.text).toBe(reply);
    expect(observed.messages.at(-1)?.text).toBe(reply);

    const previous = { complete: true, carriers: [] } as const;
    const ownKey = observed.snapshot!.carriers.find((row) => row.role === 'user')!.key!;
    const candidate = keyedHarvestCandidate(observed.snapshot!, previous, ownKey);
    expect(candidate).toMatchObject({ state: 'ready', reply });
    if (candidate.state !== 'ready') throw new Error('live_code_free_not_ready');
    await expect(revalidateKeyedHarvest(fixture.page, previous, ownKey, {
      ...candidate, snapshotSignature: atomicSnapshotSignature(observed.snapshot!),
    })).resolves.toEqual({ state: 'ready', reply });
  });

  it('replays a live code-only reply: one labelled JSON block and no prose (#2694 follow-up)', async () => {
    // Live LeoPoker turns (2026-10-23T23:03Z/23:17Z) answered with a single JSON code
    // block. The common semantic ancestor then sits inside the code block root, so its
    // labelled action bar ("JSON") was outside the root and the read never completed.
    const { fixture, assistant, append, codeBlock } = liveReplyFixture();
    const json = '{\n  "findings": []\n}';
    codeBlock('JSON', false, (relative) => {
      append(append(relative, 'DIV'), 'PRE').append(richNode('CODE', json));
    });
    assistant.innerText = 'JSON\n' + json;
    assistant.textContent = assistant.innerText;

    const fence = String.fromCharCode(96).repeat(3);
    const expected = fence + 'json\n' + json + '\n' + fence;
    const observed = await readPageObservation(fixture.page, marker, 0);
    expect(observed.transcriptIncomplete).toBe(false);
    expect(observed.snapshot?.complete).toBe(true);
    expect(observed.snapshot?.carriers.at(-1)?.text).toBe(expected);
    expect(observed.messages.at(-1)?.text).toBe(expected);

    const previous = { complete: true, carriers: [] } as const;
    const ownKey = observed.snapshot!.carriers.find((row) => row.role === 'user')!.key!;
    const candidate = keyedHarvestCandidate(observed.snapshot!, previous, ownKey);
    expect(candidate).toMatchObject({ state: 'ready', reply: expected });
    if (candidate.state !== 'ready') throw new Error('live_code_only_not_ready');
    await expect(revalidateKeyedHarvest(fixture.page, previous, ownKey, {
      ...candidate, snapshotSignature: atomicSnapshotSignature(observed.snapshot!),
    })).resolves.toEqual({ state: 'ready', reply: expected });
  });

  it('preserves complete ordered prose + direct PRE + trailing prose under a layout wrapper at both reads (#2694)', async () => {
    const code = 'literal  spaces\n  leading tab\t\n';
    const fixture = richPage([
      { prose: 'Before code' }, { code, directPre: true }, { prose: 'After code\nEXECUTION_STATUS: complete' },
    ]);
    wrapRichContent(fixture.current);
    const expected = ['Before code', '```\n' + code + '```', 'After code\nEXECUTION_STATUS: complete'].join('\n\n');
    const observed = await readPageObservation(fixture.page, marker, 0);
    expect(observed.transcriptIncomplete).toBe(false);
    expect(observed.snapshot?.carriers.at(-1)?.text).toBe(expected);
    const previous = { complete: true, carriers: [] } as const;
    const ownKey = observed.snapshot!.carriers.find((row) => row.role === 'user')!.key!;
    const candidate = keyedHarvestCandidate(observed.snapshot!, previous, ownKey);
    expect(candidate).toMatchObject({ state: 'ready', reply: expected });
    if (candidate.state !== 'ready') throw new Error('nested_root_not_ready');
    await expect(revalidateKeyedHarvest(fixture.page, previous, ownKey, {
      ...candidate, snapshotSignature: atomicSnapshotSignature(observed.snapshot!),
    })).resolves.toEqual({ state: 'ready', reply: expected });
  });

  it.each(['outer-span-status', 'outer-p-status', 'nested-prose-wrapper', 'nested-code-status'] as const)(
    'refuses unexplained rich-root wrapper/status text (%s) at observation and keyed revalidation (#2694)',
    async (variant) => {
      const fixture = richPage([
        { prose: 'Before code' }, { code: 'example\n', directPre: true }, { prose: 'After code' },
      ]);
      const { layout, content } = wrapRichContent(fixture.current);
      if (variant === 'outer-span-status') layout.append(richNode('DIV').append(richNode('SPAN', 'Copied')));
      if (variant === 'outer-p-status') layout.append(richNode('DIV').append(richNode('P', 'Copied')));
      if (variant === 'nested-prose-wrapper') content.append(richNode('DIV').append(richNode('SPAN', 'Copied')));
      if (variant === 'nested-code-status') {
        const extra = richNode('DIV');
        extra.append(richNode('SPAN', 'Copied'));
        extra.append(richNode('PRE').append(richNode('CODE', 'non-answer code')));
        content.append(extra);
      }
      const observed = await readPageObservation(fixture.page, marker, 0);
      expect(observed.transcriptIncomplete).toBe(true);
      expect(observed.snapshot?.complete).toBe(false);
      const previous = { complete: true, carriers: [] } as const;
      const ownKey = observed.snapshot!.carriers.find((row) => row.role === 'user')!.key!;
      expect(keyedHarvestCandidate(observed.snapshot!, previous, ownKey).state).not.toBe('ready');
      await expect(revalidateKeyedHarvest(fixture.page, previous, ownKey, {
        reply: 'untrusted', assistantKey: 'data-message-id:assistant-rich-12345678',
        snapshotSignature: atomicSnapshotSignature(observed.snapshot!),
      })).resolves.toEqual({ state: 'continuity-unproven' });
    },
  );

  it.each(['article-span-sibling', 'nested-layout-paragraph-sibling'] as const)(
    'rejects rendered prose inside rectless display:contents %s outside code root at both reads (#2694)',
    async (placement) => {
      const fixture = richPage([{ code: 'safe code\n' }]);
      const transparent = richNode('DIV', '', {}, false, true);
      transparent.append(richNode(placement === 'article-span-sibling' ? 'SPAN' : 'P',
        'TRAILING PROSE NOT INSIDE CODE'));
      if (placement === 'article-span-sibling') fixture.current.append(transparent);
      else wrapRichContent(fixture.current).layout.append(transparent);
    const observed = await readPageObservation(fixture.page, marker, 0);
    expect(observed.transcriptIncomplete).toBe(true);
    expect(observed.snapshot?.complete).toBe(false);
    const previous = { complete: true, carriers: [] } as const;
    const ownKey = observed.snapshot!.carriers.find((row) => row.role === 'user')!.key!;
    expect(keyedHarvestCandidate(observed.snapshot!, previous, ownKey).state).not.toBe('ready');
    await expect(revalidateKeyedHarvest(fixture.page, previous, ownKey, {
      reply: '```\nsafe code\n```',
      assistantKey: 'data-message-id:assistant-rich-12345678',
      snapshotSignature: atomicSnapshotSignature(observed.snapshot!),
    })).resolves.toEqual({ state: 'continuity-unproven' });
    },
  );

  it.each([
    ['IMG', false], ['SVG', true], ['svg', true], ['math', false],
    ['CANVAS', false], ['VIDEO', true],
  ] as const)(
    'refuses a visible unsupported non-text %s sibling of the selected rich reply at both reads (#2694)',
    async (tag, nested) => {
      // Derived generic DOM tree: media has no innerText, but is visible and
      // cannot be omitted from a supposedly complete assistant reply.
      const fixture = richPage([
        { prose: 'Before code' }, { code: 'literal code\n' }, { prose: 'After code' },
      ]);
      if (nested) {
        const { layout } = wrapRichContent(fixture.current);
        layout.append(richNode('DIV').append(richNode(tag)));
      } else fixture.current.append(richNode(tag));
      const observed = await readPageObservation(fixture.page, marker, 0);
      expect(observed.transcriptIncomplete).toBe(true);
      expect(observed.snapshot?.complete).toBe(false);
      const previous = { complete: true, carriers: [] } as const;
      const ownKey = observed.snapshot!.carriers.find((row) => row.role === 'user')!.key!;
      expect(keyedHarvestCandidate(observed.snapshot!, previous, ownKey).state).not.toBe('ready');
      await expect(revalidateKeyedHarvest(fixture.page, previous, ownKey, {
        reply: 'Before code\n\n```\nliteral code\n```\n\nAfter code',
        assistantKey: 'data-message-id:assistant-rich-12345678',
        snapshotSignature: atomicSnapshotSignature(observed.snapshot!),
      })).resolves.toEqual({ state: 'continuity-unproven' });
    },
  );

  it('refuses a selected answer whose visible direct text lies outside the derived root (#2694)', async () => {
    const fixture = richPage([{ code: 'diff --git a/a b/a\n' }]);
    fixture.current.appendText('DO_NOT_LOSE_OUTSIDE_ROOT');
    const observed = await readPageObservation(fixture.page, marker, 0);
    expect(observed.transcriptIncomplete).toBe(true);
    expect(observed.snapshot?.complete).toBe(false);
    expect(observed.messages.some((row) => row.role === 'assistant'
      && row.text.includes('OUTER MISLEADING'))).toBe(false);
  });

  it('fails loudly when the selected rich root structure is missing (#2694, derived canary)', async () => {
    // Derived negative: malformed selected content cannot acquire a plausible
    // complete response from outer-row text or an unrelated control.
    const fixture = richPage([{ prose: 'Before' }, { code: 'inside\n' }, { prose: 'After' }]);
    const baseline = await readPageObservation(fixture.page, marker, 0);
    expect(baseline.transcriptIncomplete).toBe(false);
    // Rebind the selected root as an unsupported compound structure while
    // leaving the status/control witnesses unchanged.
    const impossible = richPage([{ code: 'inside', nested: true }]);
    const observed = await readPageObservation(impossible.page, marker, 0);
    expect(observed.transcriptIncomplete).toBe(true);
    expect(observed.snapshot?.complete).toBe(false);
    expect(observed.messages.some((message) => message.role === 'assistant'
      && message.text.includes('OUTER MISLEADING'))).toBe(false);
  });

  it('serializes two complete visible diff blocks into one literal UTF-8 keyed and final reply', async () => {
    const diffOne = 'diff --git a/alpha b/alpha\n--- a/alpha\n+++ b/alpha\n@@ -1 +1 @@\n old\n-foo\n+bar\n';
    const diffTwo = 'diff --git a/beta b/beta\n--- a/beta\n+++ b/beta\n@@ -2 +2 @@\n  nested  spaces\n\t+tab\n\n```';
    const proseOne = 'Summary before code';
    const proseTwo = 'Between diff blocks';
    const proseThree = 'After diff blocks\nEXECUTION_STATUS: complete';
    const fixture = richPage([
      { prose: proseOne, tag: 'H2' },
      { code: diffOne, label: 'diff', copyControl: true },
      { prose: proseTwo, tag: 'UL' },
      { code: diffTwo, label: 'diff', copyControl: true },
      { prose: proseThree },
    ]);
    const expected = [
      proseOne,
      '```diff\n' + diffOne + '```',
      proseTwo,
      '````diff\n' + diffTwo + '\n````',
      proseThree,
    ].join('\n\n');
    const observation = await readPageObservation(fixture.page, marker, 0);
    expect(observation.transcriptIncomplete).toBe(false);
    expect(observation.snapshot?.carriers.at(-1)?.text).toBe(expected);
    expect(observation.messages.at(-1)?.text).toBe(expected);
    expect(expected).not.toContain('Copy');
    expect(expected).not.toContain('OUTER MISLEADING');
    const base = { complete: true, carriers: [] } as const;
    const ownedKey = observation.snapshot!.carriers.find((row) => row.role === 'user')!.key!;
    const candidate = keyedHarvestCandidate(observation.snapshot!, base, ownedKey);
    expect(candidate.state).toBe('ready');
    if (candidate.state !== 'ready') throw new Error('expected_ready_candidate');
    expect(candidate.reply).toBe(expected);
    const signature = atomicSnapshotSignature(observation.snapshot!);
    expect(await revalidateKeyedHarvest(fixture.page, base, ownedKey, {
      ...candidate, snapshotSignature: signature,
    })).toEqual({ state: 'ready', reply: expected });
    expect(Buffer.from(candidate.reply, 'utf8')).toEqual(Buffer.from(expected, 'utf8'));
  });

  it('uses whole-row fallback only for nonselected history; rejects unsupported selected code', async () => {
    const withHistory = richPage([{ prose: 'FINAL OWNED' }], [{ code: 'historical', nested: true }]);
    const observation = await readPageObservation(withHistory.page, marker, 0);
    expect(observation.transcriptIncomplete).toBe(false);
    expect(observation.snapshot?.carriers[0]?.text).toBe('HISTORICAL WHOLE ROW');
    const invalid = richPage([{ code: 'must-not-publish', nested: true }]);
    expect((await readPageObservation(invalid.page, marker, 0)).transcriptIncomplete).toBe(true);
    const ambiguous = richPage([{ code: 'x', label: 'diff', extraLabel: 'javascript' }]);
    expect((await readPageObservation(ambiguous.page, marker, 0)).transcriptIncomplete).toBe(true);
  });


  it('rejects interleaved visible prose in a code wrapper at observation and keyed revalidation', async () => {
    const code = 'diff --git a/a b/a\n';
    const fixture = richPage([{ code, interleavedProse: 'FAIL' }]);
    const observation = await readPageObservation(fixture.page, marker, 0);
    expect(observation.transcriptIncomplete).toBe(true);
    expect(observation.snapshot?.complete).toBe(false);
    const base = { complete: true, carriers: [] } as const;
    const userKey = observation.snapshot!.carriers.find((row) => row.role === 'user')!.key!;
    expect(keyedHarvestCandidate(observation.snapshot!, base, userKey).state).not.toBe('ready');
    await expect(revalidateKeyedHarvest(fixture.page, base, userKey, {
      reply: '```FAIL\n' + code + '```',
      assistantKey: 'data-message-id:assistant-rich-12345678',
      snapshotSignature: atomicSnapshotSignature(observation.snapshot!),
    })).resolves.toEqual({ state: 'continuity-unproven' });
  });


  async function expectUnsupportedSelectedRichBlock(blocks: RichBlock[], corruptedReply: string) {
    const fixture = richPage(blocks);
    const observation = await readPageObservation(fixture.page, marker, 0);
    expect(observation.transcriptIncomplete).toBe(true);
    expect(observation.snapshot?.complete).toBe(false);
    const baseline = { complete: true, carriers: [] } as const;
    const ownedKey = observation.snapshot!.carriers.find((row) => row.role === 'user')!.key!;
    expect(keyedHarvestCandidate(observation.snapshot!, baseline, ownedKey).state).not.toBe('ready');
    await expect(revalidateKeyedHarvest(fixture.page, baseline, ownedKey, {
      reply: corruptedReply,
      assistantKey: 'data-message-id:assistant-rich-12345678',
      snapshotSignature: atomicSnapshotSignature(observation.snapshot!),
    })).resolves.toEqual({ state: 'continuity-unproven' });
  }

  it('rejects visible direct .markdown Text nodes before and after code instead of truncating bytes', async () => {
    const code = 'diff --git a/a b/a\n';
    await expectUnsupportedSelectedRichBlock([
      { directText: 'INTRO ' }, { code }, { directText: ' DO_NOT_MERGE' },
    ], '```\n' + code + '```');

    const whitespace = richPage([{ directText: '  \n\t  ' }, { code }]);
    const observation = await readPageObservation(whitespace.page, marker, 0);
    expect(observation.transcriptIncomplete).toBe(false);
    expect(observation.snapshot?.carriers.at(-1)?.text).toBe('```\n' + code + '```');
  });

  it('does not recast a token-shaped ordinary sibling SPAN into a language header', async () => {
    const code = 'diff --git a/a b/a\n';
    await expectUnsupportedSelectedRichBlock([
      { code, spanProse: 'DO_NOT_MERGE' },
    ], '```DO_NOT_MERGE\n' + code + '```');
  });

  it.each(['aria-hidden', 'inert', 'role-button', 'button'] as const)(
    'rejects %s descendants of CODE instead of publishing contaminated visible code bytes',
    async (excludedCodeDescendant) => {
      const code = 'UIdiff --git a/a b/a\n';
      await expectUnsupportedSelectedRichBlock([
        { code, excludedCodeDescendant },
      ], '```\n' + code + '```');
    },
  );


  it('keeps an unsupported final historical rich baseline and accepts the new owned reply', async () => {
    const code = 'diff --git a/owned b/owned\n';
    const fixture = richPage(
      [{ code, label: 'diff' }], [{ code: 'unsupported historical', nested: true }],
      { initialHistoricalOnly: true },
    );
    const before = await readPageObservation(fixture.page, undefined, undefined, true, Date.now() + 5_000, true);
    expect(before.transcriptIncomplete).toBe(false);
    expect(before.snapshot?.complete).toBe(true);
    expect(before.messages.at(-1)?.text).toBe('HISTORICAL WHOLE ROW');

    fixture.setHistoricalOnly(false);
    const after = await readPageObservation(fixture.page, marker, before.messages.length);
    const expected = '```diff\n' + code + '```';
    expect(after.transcriptIncomplete).toBe(false);
    expect(after.messages.at(-1)?.text).toBe(expected);
    expect(classifyPageObservation(after.messages, before.messages.length, marker, false))
      .toEqual({ state: 'ready', reply: expected });
    const ownedKey = after.snapshot!.carriers.find((row) => row.role === 'user' && row.text === markedPrompt)!.key!;
    const candidate = keyedHarvestCandidate(after.snapshot!, before.snapshot!, ownedKey);
    expect(candidate).toMatchObject({ state: 'ready', reply: expected });
    if (candidate.state !== 'ready') throw new Error('expected_owned_continuation');
    await expect(revalidateKeyedHarvest(fixture.page, before.snapshot, ownedKey, {
      ...candidate, snapshotSignature: atomicSnapshotSignature(after.snapshot!),
    })).resolves.toEqual({ state: 'ready', reply: expected });
  });

  it('keeps unsupported owned rich replies incomplete despite a later foreign user and assistant', async () => {
    const fixture = richPage([{ code: 'compound diff', nested: true }], undefined, { laterForeign: true });
    const observed = await readPageObservation(fixture.page, marker, 0);
    expect(observed.transcriptIncomplete).toBe(true);
    expect(observed.snapshot?.complete).toBe(false);
    expect(observed.messages.some((row) =>
      row.role === 'assistant' && row.text === 'OUTER MISLEADING FIRST LINE; UI COPY; HIDDEN')).toBe(false);
    expect(classifyPageObservation(observed.messages, 0, marker, false).state).not.toBe('ready');
    expect(keyedHarvestCandidate(
      observed.snapshot!, { complete: true, carriers: [] }, 'data-message-id:owned-user-12345678',
    ).state).not.toBe('ready');
  });

  it('serializes a unique DIV code-header label beside Copy, not unrelated or ambiguous prose', async () => {
    const code = 'diff --git a/one b/one\n';
    const expected = '```diff\n' + code + '```';
    for (const headerClass of [false, true]) {
      const fixture = richPage([{ code, label: 'diff', copyControl: true, divHeader: true, headerClass }]);
      const observed = await readPageObservation(fixture.page, marker, 0);
      expect(observed.transcriptIncomplete).toBe(false);
      expect(observed.messages.at(-1)?.text).toBe(expected);
      const baseline = { complete: true, carriers: [] } as const;
      const userKey = observed.snapshot!.carriers.find((row) => row.role === 'user')!.key!;
      const candidate = keyedHarvestCandidate(observed.snapshot!, baseline, userKey);
      expect(candidate.state).toBe('ready');
      if (candidate.state !== 'ready') throw new Error('expected_div_header_candidate');
      await expect(revalidateKeyedHarvest(fixture.page, baseline, userKey, {
        ...candidate, snapshotSignature: atomicSnapshotSignature(observed.snapshot!),
      })).resolves.toEqual({ state: 'ready', reply: expected });
    }
    for (const block of [
      { code, label: 'diff', copyControl: true, divHeader: true, interleavedProse: 'DO_NOT_MERGE' },
      { code, label: 'diff', extraLabel: 'javascript', copyControl: true, divHeader: true },
    ]) {
      const observed = await readPageObservation(richPage([block]).page, marker, 0);
      expect(observed.transcriptIncomplete).toBe(true);
      expect(observed.snapshot?.complete).toBe(false);
    }
  });

  it('rejects a rectless display: contents wrapper with visible prose next to code', async () => {
    const code = 'diff --git a/safe b/safe\n';
    await expectUnsupportedSelectedRichBlock([
      { prose: 'DO_NOT_MERGE', displayContents: true },
      { code },
    ], '```\n' + code + '```');
  });

  it('rejects unchanged keyed bytes when Continue generating appears page-wide only at revalidation', async () => {
    const fixture = richPage([{ code: 'line\n', label: 'diff' }]);
    const observation = await readPageObservation(fixture.page, marker, 0);
    expect(observation.snapshot?.complete).toBe(true);
    const base = { complete: true, carriers: [] } as const;
    const userKey = observation.snapshot!.carriers.find((row) => row.role === 'user')!.key!;
    const candidate = keyedHarvestCandidate(observation.snapshot!, base, userKey);
    expect(candidate.state).toBe('ready');
    if (candidate.state !== 'ready') throw new Error('expected_candidate');
    fixture.setLateContinue(true);
    await expect(revalidateKeyedHarvest(fixture.page, base, userKey, {
      ...candidate, snapshotSignature: atomicSnapshotSignature(observation.snapshot!),
    })).resolves.toEqual({ state: 'continuity-unproven' });
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
    expect(heartbeat).toMatchObject({
      schema: 'observation-heartbeat/v1',
      phase: 'post_send_observation',
      poll_count: 4,
      stable_reads: 1,
    });
    expect(replyStabilityMatches('same', 'same')).toBe(true);
    expect(replyStabilityFingerprint('same')).toContain('same');
    const longA = `${'H'.repeat(320)}middle-A${'T'.repeat(320)}`;
    const longB = `${'H'.repeat(320)}middle-B${'T'.repeat(320)}`;
    expect(replyStabilityMatches(longA, longB)).toBe(false);
    expect(replyStabilityMatches('first\n   middle\nlast', 'first\n middle\nlast')).toBe(false);
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

describe('Issue #2660 AC12 bounded pre-Send Page cleanup authority', () => {
  it('closes only a proven non-last Page; preserves the sole Page, protected /project and uncertain Pages', async () => {
    const { randomUUID } = await import('node:crypto');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { __testFinalizeTurn, __testConversationPageSelection } = await import('./state-light-turn.ts');
    const {
      admitStateLightTurnObservation, bindStateLightOwnedTarget, transitionStateLightTurnObservation,
    } = await import('./state-light-turn-observation.ts');
    const { __testAttachOwnTargetFixture } = await import('./own-target-attach.ts');
    const {
      COMPOSER_SELECTOR, RENDERED_STOP_BUTTON_SELECTOR, ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
    } = await import('./ui-adapter.ts');
    const { USER_MESSAGE_SELECTOR } = await import('./product-page-selectors.ts');
    const stateDir = mkdtempSync(join(tmpdir(), 'opk-2660-ac12-'));
    const priorDir = process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = stateDir;
    const exact = 'https://chatgpt.com/g/g-p-11111111111111111111111111111111-test/c/11111111-1111-4111-8111-111111111111';
    const profileKey = 'ac12-fetch-429';
    const makeOutcome = (page: any, invocationId: string, sendAttempted = false) => ({
      page,
      ownedPreSendFetch429Page: page,
      ownedPreSendFetch429Url: exact,
      result: {
        schema: 'turn-result/v1' as const,
        state: 'rate_limit' as const,
        scope: 'invocation' as const,
        cause: 'conversation_fetch_http_429',
        invocation_id: invocationId,
        configured_profile_key: profileKey,
        send_count: 0,
        poll_count: 0,
        goto_count: 1,
        new_chat_click_count: 0,
        navigation_count: 1,
        incidents: [],
        ...(sendAttempted ? { send_attempted: true } : {}),
      },
    });
    const prepare = (invocationId: string) => {
      admitStateLightTurnObservation({ profileKey, invocationId, marker: 'OPKTURNV1' + '12'.repeat(16) });
      transitionStateLightTurnObservation({
        profileKey, invocationId, phase: 'prepared', reason: 'existing_conversation_bound_before_send',
        conversationUrl: exact,
      });
    };
    const page = () => ({
      url: () => exact,
      isClosed: () => false,
      close: vi.fn(async () => undefined),
    });
    try {
      // The positive close requires a real exact-ID witness, not just the Page
      // handle and 429 reason. Keep the production CDP census and physical
      // disappearance checks active in this synthetic test.
      const targetId = 'fixture-own-target';
      const cdp = 'http://127.0.0.1:9222';
      const protectedProjectUrl =
        'https://chatgpt.com/g/g-p-6a1920e1c1608191bef6089396d947b4-orchestrator-pack/project';
      const protectedProject = {
        url: () => protectedProjectUrl,
        close: vi.fn(async () => { throw new Error('must_not_close_protected_project'); }),
        goto: vi.fn(async () => { throw new Error('must_not_navigate_protected_project'); }),
      };
      const finishCreatedPage = async (withProtectedSibling: boolean) => {
        let stillOpen = true;
        const owned = {
          __fakeBrowserGptPage: true,
          url: () => exact,
          isClosed: () => !stillOpen,
          close: vi.fn(async () => { stillOpen = false; }),
          locator: (selector: string) => {
            if (selector === COMPOSER_SELECTOR) return {
              count: async () => 1,
              evaluate: async () => ({ content: '', visible: '' }),
            };
            if (selector === USER_MESSAGE_SELECTOR
              || selector === RENDERED_STOP_BUTTON_SELECTOR
              || selector === ASSISTANT_TURN_IN_PROGRESS_SELECTOR) {
              return { count: async () => 0 };
            }
            return { count: async () => 0 };
          },
        };
        const context = {
          newPage: vi.fn(async () => owned),
          pages: vi.fn(() => withProtectedSibling ? [protectedProject] : [] as any[]),
        };
        const browser = {
          contexts: vi.fn(() => [context]),
          close: vi.fn(async () => undefined),
          isConnected: () => true,
        };
        const ownedInvocation = randomUUID();
        prepare(ownedInvocation);
        const attached = await __testAttachOwnTargetFixture({
          connectOverCDP: vi.fn(async () => browser),
        }, {
          mode: 'own-target', cdp, newChat: true,
          deadlineMs: Date.now() + 15_000,
        }, true);
        expect(attached.created).toBe(true);
        expect(attached.targetId).toBe(targetId);
        bindStateLightOwnedTarget({
          profileKey, invocationId: ownedInvocation,
          targetId, created: true, cdp, initialRoute: exact,
        });
        // The census distinguishes a sole turn Page from one with a separate
        // protected project tab. The latter is presence evidence, never a close
        // or navigation target; exact-ID disappearance is still checked.
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
          new Response(JSON.stringify([
            ...(stillOpen ? [{ id: targetId, type: 'page', url: exact }] : []),
            ...(withProtectedSibling ? [{
              id: 'fixture-protected-project', type: 'page', url: protectedProjectUrl,
            }] : []),
          ]), { status: 200 }));
        try {
          const result = await __testFinalizeTurn({
            ...makeOutcome(owned, ownedInvocation), browser,
          }, cdp);
          expect(result).toMatchObject({
            state: 'rate_limit', cause: 'conversation_fetch_http_429',
            send_count: 0, cleanup: withProtectedSibling ? 'confirmed' : 'unconfirmed',
            ...(!withProtectedSibling ? { cleanup_status: 'cleanup_unconfirmed' } : {}),
          });
          expect(owned.close).toHaveBeenCalledTimes(withProtectedSibling ? 1 : 0);
          expect(stillOpen).toBe(!withProtectedSibling);
          expect(protectedProject.close).not.toHaveBeenCalled();
          expect(protectedProject.goto).not.toHaveBeenCalled();
        } finally {
          fetchSpy.mockRestore();
        }
      };
      // Regression: never close the shared browser's last Page, even when the
      // exact invocation-created target and idle route/marker are otherwise proven.
      await finishCreatedPage(false);
      // With a non-owned /project sibling, retire only the exact created Page.
      await finishCreatedPage(true);

      const selected = page();
      const selectedInvocation = randomUUID();
      prepare(selectedInvocation);
      __testConversationPageSelection.markSelectedPageUnowned(selected);
      const retained = await __testFinalizeTurn(makeOutcome(selected, selectedInvocation));
      expect(retained.cleanup).toBe('skipped');
      expect(selected.close).not.toHaveBeenCalled();

      const forfeited = page();
      const forfeitedInvocation = randomUUID();
      prepare(forfeitedInvocation);
      const notOwned = await __testFinalizeTurn({ ...makeOutcome(forfeited, forfeitedInvocation), ownershipForfeited: true });
      expect(notOwned.cleanup).toBe('skipped');
      expect(forfeited.close).not.toHaveBeenCalled();

      const attempted = page();
      const attemptedInvocation = randomUUID();
      prepare(attemptedInvocation);
      const maybeSent = await __testFinalizeTurn(makeOutcome(attempted, attemptedInvocation, true));
      expect(maybeSent.cleanup).toBe('skipped');
      expect(attempted.close).not.toHaveBeenCalled();

      const redirected = page();
      const redirectedInvocation = randomUUID();
      prepare(redirectedInvocation);
      const foreign = await __testFinalizeTurn({
        ...makeOutcome(redirected, redirectedInvocation),
        ownedPreSendFetch429Url: 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222',
      });
      expect(foreign.cleanup).toBe('skipped');
      expect(redirected.close).not.toHaveBeenCalled();

      // Same UUID must not authorize close after a route or project redirect.
      const uuid = '11111111-1111-4111-8111-111111111111';
      for (const target of [
        'https://chatgpt.com/c/' + uuid,
        'https://chatgpt.com/g/g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-other/c/' + uuid,
      ]) {
        const changedRoute = { ...page(), url: () => target };
        const redirectedInvocation = randomUUID();
        prepare(redirectedInvocation);
        const result = await __testFinalizeTurn(makeOutcome(changedRoute, redirectedInvocation));
        expect(result.cleanup).toBe('skipped');
        expect(changedRoute.close).not.toHaveBeenCalled();
      }

      const failedClose = page();
      failedClose.close.mockRejectedValue(new Error('close failed'));
      const failedInvocation = randomUUID();
      prepare(failedInvocation);
      const failed = await __testFinalizeTurn(makeOutcome(failedClose, failedInvocation));
      expect(failed.cleanup).not.toBe('confirmed');
      // The detached synthetic handle is deliberately not a proven created
      // target. It must never reach even a rejecting Page.close().
      expect(failed.cleanup).toBe('skipped');
      expect(failedClose.close).not.toHaveBeenCalled();
    } finally {
      if (priorDir === undefined) delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
      else process.env.CHATGPT_BROWSER_TURN_STATE_DIR = priorDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('Issue #1430 retirement cleanup visibility', () => {
  it('keeps committed primary success while surfacing mutation-retirement cleanup failure', async () => {
    const { randomUUID } = await import('node:crypto');
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const {
      admitStateLightTurnObservation,
      finalizeStateLightPrimaryPublication,
      observationRecordKey,
      readStateLightTurnObservation,
      transitionStateLightTurnObservation,
    } = await import('./state-light-turn-observation.ts');
    const { profileDirs } = await import('./storage-common.ts');

    const root = mkdtempSync(join(tmpdir(), 'opk-1430-retirement-'));
    const priorStateDir = process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(root, 'state');
    const profileKey = 'retirement-profile';
    const invocationId = randomUUID();
    const retirementMarker = `OPKTURNV1${'44'.repeat(16)}`;
    const conversationUrl = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
    const output = join(root, 'reply.txt');
    const reply = 'RETIREMENT FINAL';

    try {
      admitStateLightTurnObservation({ profileKey, invocationId, marker: retirementMarker });
      transitionStateLightTurnObservation({
        profileKey,
        invocationId,
        phase: 'dispatching',
        reason: 'retirement_fault_dispatch_boundary',
      });
      transitionStateLightTurnObservation({
        profileKey,
        invocationId,
        phase: 'sent_unharvested',
        reason: 'retirement_fault_send',
        sendCount: 1,
        sendWitness: 'numeric_send_count',
        conversationUrl,
      });

      const mutationSlot = join(
        profileDirs(profileKey).locks,
        `state-light-turn-observation-${observationRecordKey(invocationId)}.slot`,
      );
      const result = await finalizeStateLightPrimaryPublication({
        profileKey,
        invocationId,
        target: output,
        bytes: reply,
        publish: async () => {
          writeFileSync(output, reply, { flag: 'wx' });
          writeFileSync(join(mutationSlot, 'retirement-blocker'), 'block');
          return {
            state: 'committed_ok',
            output_bytes: Buffer.byteLength(reply, 'utf8'),
            output_sha256: (await import('node:crypto')).createHash('sha256').update(reply).digest('hex'),
          };
        },
      });

      expect(result).toMatchObject({
        state: 'committed_ok',
        retirement_cleanup_required: true,
        output_bytes: Buffer.byteLength(reply, 'utf8'),
      });
      expect(readFileSync(output, 'utf8')).toBe(reply);
      expect(readStateLightTurnObservation(profileKey, invocationId).phase).toBe('harvested');
    } finally {
      if (priorStateDir === undefined) delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
      else process.env.CHATGPT_BROWSER_TURN_STATE_DIR = priorStateDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps retirement_cleanup_required in the public normal-turn final result', async () => {
    const { randomUUID } = await import('node:crypto');
    const { __testFinalizeTurn } = await import('./state-light-turn.ts');
    const invocationId = randomUUID();
    const outcome: Parameters<typeof __testFinalizeTurn>[0] = {
      result: {
        schema: 'turn-result/v1',
        state: 'ok',
        scope: 'none',
        cause: 'completed_page_only',
        invocation_id: invocationId,
        configured_profile_key: 'profile-test',
        send_count: 1,
        poll_count: 2,
        goto_count: 0,
        new_chat_click_count: 0,
        navigation_count: 0,
        incidents: [],
        retirement_cleanup_required: true,
      },
    };

    await expect(__testFinalizeTurn(outcome)).resolves.toMatchObject({
      state: 'ok',
      invocation_id: invocationId,
      retirement_cleanup_required: true,
      cleanup: 'skipped',
    });
  });
});

describe('Issue #1430 deterministic observation admission crash recovery', () => {
  it('leaves no canonical record before the hard-link and preserves one after a post-link crash', async () => {
    const actualFs = await import('node:fs');
    const { randomUUID } = await import('node:crypto');
    const { join } = await import('node:path');
    let linkMode: 'before' | 'after' | null = null;

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        linkSync: (source: any, target: any) => {
          if (linkMode === 'before') {
            linkMode = null;
            throw new Error('injected_observation_admission_before_link');
          }
          actual.linkSync(source, target);
          if (linkMode === 'after') {
            linkMode = null;
            throw new Error('injected_observation_admission_after_link');
          }
        },
      };
    });
    vi.resetModules();

    const root = actualFs.mkdtempSync(join((await import('node:os')).tmpdir(), 'opk-1430-admission-crash-'));
    const priorStateDir = process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(root, 'state');
    const profileKey = 'admission-crash-profile';
    const invocationId = randomUUID();
    const marker = `OPKTURNV1${'AB'.repeat(16)}`;

    try {
      const {
        admitStateLightTurnObservation,
        observationRecordPath,
        readStateLightTurnObservation,
      } = await import('./state-light-turn-observation.ts');
      const canonicalPath = observationRecordPath(profileKey, invocationId);

      linkMode = 'before';
      expect(() => admitStateLightTurnObservation({ profileKey, invocationId, marker }))
        .toThrow('injected_observation_admission_before_link');
      expect(actualFs.existsSync(canonicalPath)).toBe(false);

      linkMode = 'after';
      expect(() => admitStateLightTurnObservation({ profileKey, invocationId, marker }))
        .toThrow('injected_observation_admission_after_link');
      expect(actualFs.existsSync(canonicalPath)).toBe(true);
      expect(readStateLightTurnObservation(profileKey, invocationId)).toMatchObject({
        phase: 'prepared',
        invocation_id: invocationId,
        marker,
      });

      expect(admitStateLightTurnObservation({ profileKey, invocationId, marker }))
        .toMatchObject({ phase: 'prepared', invocation_id: invocationId, marker });
      expect(() => admitStateLightTurnObservation({
        profileKey,
        invocationId,
        marker: `OPKTURNV1${'CD'.repeat(16)}`,
      })).toThrow('observation_marker_conflict');
    } finally {
      if (priorStateDir === undefined) delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
      else process.env.CHATGPT_BROWSER_TURN_STATE_DIR = priorStateDir;
      actualFs.rmSync(root, { recursive: true, force: true });
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

describe('Issue #2726 observation owner pid', () => {
  it('records the binding pid, keeps it across transitions and validates it', async () => {
    const { randomUUID } = await import('node:crypto');
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    vi.resetModules();
    const root = mkdtempSync(join(tmpdir(), 'opk-2726-owner-pid-'));
    const priorStateDir = process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(root, 'state');
    const profileKey = 'owner-pid-profile';
    const invocationId = randomUUID();
    try {
      const observation = await import('./state-light-turn-observation.ts');
      const admitted = observation.admitStateLightTurnObservation({
        profileKey, invocationId, marker: `OPKTURNV1${'EF'.repeat(16)}`,
      });
      expect(admitted.owner_pid).toBeUndefined();
      const bound = observation.bindStateLightOwnedTarget({
        profileKey, invocationId, targetId: 'TARGET-2726', created: true,
        cdp: 'http://127.0.0.1:9222', initialRoute: 'https://chatgpt.com/g/g-p-x/project',
      });
      expect(bound.owner_pid).toBe(process.pid);
      const sent = observation.transitionStateLightTurnObservation({
        profileKey, invocationId, phase: 'dispatching', reason: 'test_dispatch',
      });
      expect(sent.owner_pid).toBe(process.pid);

      const path = observation.observationRecordPath(profileKey, invocationId);
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      for (const invalid of [0, -1, 1.5, '7']) {
        writeFileSync(path, `${JSON.stringify({ ...raw, owner_pid: invalid })}\n`);
        expect(() => observation.readStateLightTurnObservation(profileKey, invocationId))
          .toThrow('observation_owner_pid_invalid');
      }
      const { owner_pid: _ignored, ...legacy } = raw;
      writeFileSync(path, `${JSON.stringify(legacy)}\n`);
      expect(observation.readStateLightTurnObservation(profileKey, invocationId).owner_pid).toBeUndefined();
    } finally {
      if (priorStateDir === undefined) delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
      else process.env.CHATGPT_BROWSER_TURN_STATE_DIR = priorStateDir;
      rmSync(root, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});

describe('Issue #2457 unproven terminal locator', () => {
  it('sends through the fake page as unowned and omits the handle from the chat binding', async () => {
    const { randomUUID } = await import('node:crypto');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const fixture = await import('./state-light-turn.test-fixtures.ts');
    const runtimeMocks = {
      browserQueue: [] as any[],
      cleanupOutcome: 'confirmed' as const,
      releaseBrowser: vi.fn(async () => undefined),
      verifyProfile: vi.fn(async () => ({ state: 'verified' as const })),
    };
    vi.doMock('./browser-session.ts', () => fixture.createBrowserSessionModuleMock(runtimeMocks));
    vi.doMock('./coordination.ts', () => fixture.createCoordinationModuleMock());
    vi.doMock('./input.ts', () => ({ readStableInput: vi.fn(() => fixture.stableTurnInput('synthetic prompt')) }));
    vi.doMock('./ui-adapter.ts', async (original) => fixture.buildUiAdapterTestMock(
      await original<typeof import('./ui-adapter.ts')>(), runtimeMocks,
    ));
    vi.resetModules();
    const selectors = await import('./product-page-selectors.ts');
    const { configuredProfileKey } = await import('./storage-common.ts');
    const { readStateLightTurnObservation } = await import('./state-light-turn-observation.ts');
    const { readChatBinding } = await import('./chat-bindings.ts');
    const { runStateLightTurn } = await import('./state-light-turn.ts');
    const root = mkdtempSync(join(tmpdir(), 'opk-2457-unowned-send-'));
    const originalStateDir = process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
    const originalHome = process.env.HOME;
    const originalHandle = process.env.ORCA_TERMINAL_HANDLE;
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(root, 'state');
    process.env.HOME = join(root, 'home');
    const profile = join(root, 'fake-profile');
    const cdp = 'http://127.0.0.1:9222';
    const input = join(root, 'input.txt');
    const projectUrl = 'https://chatgpt.com/g/g-p-11111111111111111111111111111111/project';
    writeFileSync(input, 'synthetic prompt', 'utf8');
    // Keep this fake browser independent of the host's live CDP metadata.
    const metadataFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    try {
      for (const handle of ['pane-recycled', '', undefined]) {
        if (handle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
        else process.env.ORCA_TERMINAL_HANDLE = handle;
        const invocationId = randomUUID();
        const conversationUrl = `https://chatgpt.com/c/${randomUUID()}`;
        let currentUrl = projectUrl;
        let composerText = '';
        let sent = false;
        const composer = fixture.scalarLocator({
          count: vi.fn(async () => 1),
          fill: vi.fn(async (value: string) => { composerText = value; }),
          innerText: vi.fn(async () => composerText),
          textContent: vi.fn(async () => composerText),
        });
        const sendButton = fixture.scalarLocator({
          count: vi.fn(async () => 1),
          click: vi.fn(async () => { sent = true; currentUrl = conversationUrl; }),
        });
        const historicalUser = { role: 'user' as const, text: 'historical user' };
        const finalMessages = () => [
          ...(currentUrl === conversationUrl ? [historicalUser] : []),
          ...(sent ? [
            { role: 'user' as const, text: composerText },
            { role: 'assistant' as const, text: 'synthetic reply', finalAction: true, finalActionInTurnContainer: true },
          ] : []),
        ];
        const page: any = {
          __fakeBrowserGptPage: true,
          goto: vi.fn(async (url: string) => { currentUrl = url; }),
          url: vi.fn(() => currentUrl),
          isClosed: vi.fn(() => false),
          waitForTimeout: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
          getByText: vi.fn(() => fixture.scalarLocator()),
          getByRole: vi.fn(() => fixture.scalarLocator()),
          locator: vi.fn((selector: string) => {
            if (selector === selectors.COMPOSER_SELECTOR) return composer;
            if (selector === selectors.SEND_BUTTON_SELECTOR) return sendButton;
            if (selector === selectors.USER_MESSAGE_SELECTOR) return fixture.collectionLocator(
              finalMessages().filter((message) => message.role === 'user'),
            );
            if (selector === selectors.MESSAGE_NODE_SELECTOR) {
              const messages = finalMessages();
              if (currentUrl !== conversationUrl) return fixture.collectionLocator(messages);
              return Object.assign(fixture.collectionLocator(messages), {
                evaluateAll: vi.fn(async () => ({
                  rows: messages.map((message, domIndex) => ({
                    role: message.role, text: message.text, key: `historical-user-2457-${domIndex}`,
                    domIndex, complete: true,
                    completionReady: Boolean('finalActionInTurnContainer' in message && message.finalActionInTurnContainer),
                    continuationVisible: false,
                  })),
                  pageTurnEvidence: {
                    generationInProgress: false,
                    observedAssistantNodes: sent ? 1 : 0, continueGeneratingVisible: false,
                  },
                })),
              });
            }
            if (selector === selectors.ASSISTANT_MESSAGE_SELECTOR) return fixture.collectionLocator(
              finalMessages().filter((message) => message.role === 'assistant'),
            );
            if (selector === selectors.ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
              const last = finalMessages().at(-1);
              return last?.role === 'assistant' && last.finalActionInTurnContainer
                ? fixture.messageLocator(last) : fixture.scalarLocator();
            }
            return fixture.scalarLocator();
          }),
        };
        fixture.enqueueBrowserForTurn(runtimeMocks, page);
        const profileKey = configuredProfileKey(profile, cdp);
        const { code, result } = await fixture.runStateLightTurnWithStdoutCapture(
          (argv) => runStateLightTurn(argv, { recordChatBinding: true }),
          [
            '--profile', profile, '--cdp', cdp, '--input', input,
            '--output', join(root, invocationId + '.txt'), '--chat-url', conversationUrl,
            '--invocation-id', invocationId,
            '--timeout-ms', '5000', '--poll-ms', '1',
          ],
        );
        expect(code, JSON.stringify(result)).toBe(0);
        expect(sendButton.click).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ state: 'ok', send_count: 1 });
        expect(readStateLightTurnObservation(profileKey, invocationId)).not.toHaveProperty('owner');
        expect(readChatBinding(conversationUrl)).not.toHaveProperty('terminal_handle');
      }
    } finally {
      metadataFetch.mockRestore();
      vi.doUnmock('./browser-session.ts');
      vi.doUnmock('./coordination.ts');
      vi.doUnmock('./input.ts');
      vi.doUnmock('./ui-adapter.ts');
      vi.resetModules();
      if (originalStateDir === undefined) delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
      else process.env.CHATGPT_BROWSER_TURN_STATE_DIR = originalStateDir;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
      else process.env.ORCA_TERMINAL_HANDLE = originalHandle;
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('Issue #2467 committed composer readiness under the absolute deadline', () => {
  it('accepts a composer that mounts after 20 seconds while DCL is still pending', async () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const composer = scalarLocator({
        count: vi.fn(async () => now >= 30_000 ? 1 : 0),
        evaluate: vi.fn(async () => ({ visible: true, enabled: true, contentEditable: true })),
      });
      const page = {
        __fakeBrowserGptPage: true,
        locator: (selector: string) => selector === COMPOSER_SELECTOR ? composer : scalarLocator(),
        waitForTimeout: async (ms: number) => { now += ms; },
      };
      const result = await __testComposerMutation.waitForComposer(page, 45_000, true);
      expect(result).toEqual({ state: 'ready' });
      expect(now).toBeGreaterThanOrEqual(30_000);
      expect(now).toBeLessThan(45_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('terminates truthfully with composer_unavailable only when the shared deadline expires', async () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const page = {
        __fakeBrowserGptPage: true,
        locator: () => scalarLocator({ count: vi.fn(async () => 0) }),
        waitForTimeout: async (ms: number) => { now += ms; },
      };
      const result = await __testComposerMutation.waitForComposer(page, 24_000, true);
      expect(result).toEqual({ state: 'ui_contract_mismatch', cause: 'composer_unavailable' });
      expect(now).toBe(24_000);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('Issue #2669 invocation-bound composer reads', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(['count', 'evaluate'] as const)('accepts a slow %s beyond the former 5s bound', async (operation) => {
    vi.useFakeTimers();
    const slow = async () => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return operation === 'count' ? 1 : { visible: true, enabled: true, contentEditable: true };
    };
    const composer = {
      count: operation === 'count' ? slow : async () => 1,
      evaluate: operation === 'evaluate' ? slow : async () => ({ visible: true, enabled: true, contentEditable: true }),
    };
    const pending = __testComposerMutation.readComposerReadiness({ locator: () => composer }, Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await pending).toBe(true);
  });

  it.each(['count', 'evaluate'] as const)('bounds a stalled %s by invocation expiry', async (operation) => {
    vi.useFakeTimers();
    const never = () => new Promise(() => undefined);
    const composer = {
      count: operation === 'count' ? never : async () => 1,
      evaluate: operation === 'evaluate' ? never : async () => ({ visible: true, enabled: true, contentEditable: true }),
    };
    const pending = __testComposerMutation.readComposerReadiness({ locator: () => composer }, Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBe(false);
  });
});

describe('Issue #2541 observed composer readiness diagnostics', () => {
  it.each([
    { visible: true, enabled: true, contentEditable: true, expected: 'ready', ok: true },
    { visible: true, enabled: false, contentEditable: true, expected: 'disabled', ok: false },
    { visible: false, enabled: true, contentEditable: true, expected: 'hidden', ok: false },
    { visible: true, enabled: true, contentEditable: false, expected: 'not_editable', ok: false },
  ] as const)('observes $expected without inferring a network failure', async ({ visible, enabled, contentEditable, expected, ok }) => {
    const observed: string[] = [];
    const composer = {
      count: vi.fn(async () => 1),
      evaluate: vi.fn(async () => ({ visible, enabled, contentEditable })),
    };
    const page = { locator: vi.fn((selector: string) => selector === COMPOSER_SELECTOR ? composer : scalarLocator()) };
    expect(await __testComposerMutation.readComposerReadiness(
      page, Date.now() + 2_000, (state) => observed.push(state),
    )).toBe(ok);
    expect(observed).toEqual([expected]);
  });

  it('records positive absence instead of interpreting a sibling or timeout as activity', async () => {
    const observed: string[] = [];
    const page = { locator: vi.fn(() => ({ count: vi.fn(async () => 0) })) };
    expect(await __testComposerMutation.readComposerReadiness(
      page, Date.now() + 2_000, (state) => observed.push(state),
    )).toBe(false);
    expect(observed).toEqual(['absent']);
  });
  it.each([
    ['locator count', 'browser_operation_timeout:locator_count', 'browser_operation_timeout:locator_count'],
    ['network evaluation', 'page.evaluate: net::ERR_NETWORK_CHANGED', 'network_changed'],
  ])('retains a witnessed %s failure through exhausted readiness (#2541 AC4)', async (kind, errorText, cause) => {
    let now = 10_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const composer = {
        count: vi.fn(async () => {
          if (kind === 'locator count') throw new Error(errorText);
          return 1;
        }),
        evaluate: vi.fn(async () => { throw new Error(errorText); }),
      };
      const page = {
        __fakeBrowserGptPage: true,
        locator: (selector: string) => selector === COMPOSER_SELECTOR ? composer : scalarLocator(),
        waitForTimeout: async (ms: number) => { now += ms; },
      };
      const result = await __testComposerMutation.waitForComposer(page, now + 1_500, true);
      expect(result).toEqual({ state: 'ui_contract_mismatch', cause });
      expect(now).toBeGreaterThanOrEqual(11_500);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['absent', 'disabled', 'ordinary read timeout'] as const)(
    'does not invent a network or locator failure for a %s composer (#2541 AC4)', async (kind) => {
      let now = 10_000;
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const composer = {
          count: vi.fn(async () => kind === 'absent' ? 0 : 1),
          evaluate: vi.fn(async () => {
            if (kind === 'ordinary read timeout') throw new Error('TimeoutError: slow hydration');
            return { visible: true, enabled: false, contentEditable: true };
          }),
        };
        const page = {
          __fakeBrowserGptPage: true,
          locator: (selector: string) => selector === COMPOSER_SELECTOR ? composer : scalarLocator(),
          waitForTimeout: async (ms: number) => { now += ms; },
        };
        expect(await __testComposerMutation.waitForComposer(page, now + 1_500, true)).toEqual({
          state: 'ui_contract_mismatch', cause: 'composer_unavailable',
        });
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('a ready composer supersedes an earlier observed network failure (#2541 AC4)', async () => {
    let now = 10_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let attempts = 0;
    try {
      const composer = {
        count: vi.fn(async () => 1),
        evaluate: vi.fn(async () => {
          if (++attempts === 1) throw new Error('net::ERR_NETWORK_CHANGED');
          return { visible: true, enabled: true, contentEditable: true };
        }),
      };
      const page = {
        __fakeBrowserGptPage: true,
        locator: (selector: string) => selector === COMPOSER_SELECTOR ? composer : scalarLocator(),
        waitForTimeout: async (ms: number) => { now += ms; },
      };
      expect(await __testComposerMutation.waitForComposer(page, now + 1_500, true)).toEqual({ state: 'ready' });
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('existing generation behind a connection-recovery status', () => {
  function recoveryPage(recoveryShown: boolean) {
    const state = { stopped: false, recovery: recoveryShown };
    const click = vi.fn(async () => { state.stopped = true; state.recovery = false; });
    const count = (value: () => number) => ({ count: vi.fn(async () => value()) });
    const page = {
      __fakeBrowserGptPage: true,
      waitForTimeout: vi.fn(async () => undefined),
      locator: vi.fn((selector: string) => {
        if (selector === CONNECTION_RECOVERY_STATUS_SELECTOR) return count(() => (state.recovery ? 1 : 0));
        if (selector === RENDERED_STOP_BUTTON_SELECTOR) return { ...count(() => (state.stopped ? 0 : 1)), first: () => ({ click }) };
        return { ...count(() => 0), last: () => ({ locator: () => count(() => 0) }) };
      }),
    };
    return { page, click };
  }

  it('presses Stop once and settles when the recovery status is shown', async () => {
    const { page, click } = recoveryPage(true);
    await expect(__testWaitForExistingGeneration(page, Date.now() + 60_000)).resolves.toBe('settled');
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('never presses Stop for an ordinary running generation', async () => {
    const { page, click } = recoveryPage(false);
    await expect(__testWaitForExistingGeneration(page, Date.now() + 200)).resolves.toBe('busy');
    expect(click).not.toHaveBeenCalled();
  });
});

describe('Issue #2669 coherent structured composer verification', () => {
  const payload = `${marker}\n\nkeep separate words\n  indented\tline\n`;
  function editor(text = payload, rendering: 'paragraphs' | 'autolink' = 'paragraphs') {
    const element = proseMirrorEditorSurface(text, rendering);
    const composer = {
      innerText: async () => element.innerText,
      evaluate: async (callback: (element: unknown, arg?: unknown) => unknown, arg?: unknown) => callback(element, arg),
    };
    return { element, composer };
  }
  const matches = (composer: unknown, expected = payload) =>
    __testSendDelivery.composerPayloadMatchesBeforeSend(composer, expected, Date.now() + 2_000);

  it.each(['paragraphs', 'autolink'] as const)('reconstructs exact %s content from one coherent DOM', async (rendering) => {
    const expected = payload + '`https://example.com/2669`';
    const { element, composer } = editor(expected, rendering);
    expect(await composer.innerText()).toBe(element.innerText);
    expect(element.innerText).not.toBe(expected);
    expect(element.textContent).not.toBe(expected);
    expect(await matches(composer, expected)).toBe(true);
  });

  it('preserves an entire single 100 KB line through structured verification', async () => {
    const expected = `${marker}\n\n` + 'x'.repeat(102_400);
    expect(await matches(editor(expected).composer, expected)).toBe(true);
  });

  it('retains a hard line break while ignoring only a final ProseMirror placeholder', async () => {
    const expected = `${marker}\n\nfirst\nsecond`;
    const { element, composer } = editor(expected);
    const paragraphs = element.childNodes;
    paragraphs[2].childNodes.push({ nodeType: 1, tagName: 'BR', childNodes: [],
      classList: { contains: () => false }, getAttribute: () => null });
    paragraphs[2].childNodes.push(...paragraphs[3].childNodes);
    paragraphs.pop();
    expect(await matches(composer, expected)).toBe(true);
  });

  it.each(['indentation', 'line-break', 'trailing-newline', 'extra-space'] as const)(
    'accepts equivalent rendered %s whitespace (#2671)', async (kind) => {
      const damaged = kind === 'indentation' ? payload.replace('\n  indented', '\nindented')
        : kind === 'line-break' ? payload.replace('words\n', 'words ')
          : kind === 'trailing-newline' ? payload.slice(0, -1) : payload + ' ';
      expect(await matches(editor(damaged).composer)).toBe(true);
    },
  );

  it.each(['joined-marker', 'split-marker'] as const)(
    'rejects normalized content with an unrecognizable %s (#2671 review)', async (kind) => {
      const damaged = kind === 'joined-marker' ? payload.replace('\n\n', '')
        : payload.replace(marker, marker.slice(0, 9) + ' ' + marker.slice(9));
      expect(await matches(editor(damaged).composer)).toBe(false);
    },
  );

  it.each([' ', '\n\n\n', '\u00a0'] as const)(
    'accepts an intact leading marker with rendered boundary %j (#2671 review)', async (boundary) => {
      expect(await matches(editor(payload.replace('\n\n', boundary)).composer)).toBe(true);
    },
  );

  it.each(['marker', 'middle-content', 'truncated-tail'] as const)(
    'rejects genuine %s differences despite matching surrounding whitespace (#2671)', async (kind) => {
      const damaged = kind === 'marker' ? payload.replace(marker, 'different-marker')
        : kind === 'middle-content' ? payload.replace('separate', 'different') : payload.trimEnd().slice(0, -1);
      expect(await matches(editor(damaged).composer)).toBe(false);
    },
  );

  it.each(['unknown-element', 'hidden', 'aria-hidden', 'noneditable', 'css-hidden', 'misplaced-placeholder', 'unknown-editor'] as const)(
    'refuses unprovable structure: %s', async (kind) => {
      const { element, composer } = editor();
      // Exercise the exact structured fallback without a normalized visible witness.
      composer.innerText = async () => 'unverified draft';
      const paragraph = element.childNodes[2];
      const readAttribute = paragraph.getAttribute;
      if (kind === 'unknown-element') paragraph.tagName = 'SCRIPT';
      else if (kind === 'css-hidden') {
        element.ownerDocument.defaultView.getComputedStyle = () => ({ display: 'none', visibility: 'visible' });
      } else if (kind === 'unknown-editor') element.classList.contains = () => false;
      else if (kind === 'misplaced-placeholder') {
        paragraph.childNodes.unshift(element.childNodes[1].childNodes[0]);
      } else {
        paragraph.getAttribute = (name: string) => name === (kind === 'noneditable' ? 'contenteditable' : kind)
          ? kind === 'noneditable' ? 'false' : kind === 'aria-hidden' ? 'true' : '' : readAttribute(name);
      }
      expect(await matches(composer)).toBe(false);
    },
  );

  it.each(['depth', 'nodes'] as const)('bounds excessive DOM %s', async (kind) => {
    const { element, composer } = editor();
    composer.innerText = async () => 'unverified draft';
    const paragraph = element.childNodes[2];
    if (kind === 'nodes') {
      paragraph.childNodes.unshift(...Array.from({ length: 1_000 }, () => ({ nodeType: 3, nodeValue: '' })));
    } else {
      for (let i = 0; i < 40; i++) {
        paragraph.childNodes = [{ nodeType: 1, tagName: 'SPAN', childNodes: paragraph.childNodes,
          getAttribute: () => null }];
      }
    }
    expect(await matches(composer)).toBe(false);
  });

  it('makes no browser call after the invocation deadline', async () => {
    const composer = { innerText: vi.fn(), evaluate: vi.fn() };
    expect(await __testSendDelivery.composerPayloadMatchesBeforeSend(composer, payload, Date.now() - 1)).toBe(false);
    expect(composer.innerText).not.toHaveBeenCalled();
    expect(composer.evaluate).not.toHaveBeenCalled();
  });

  it('bounds an unresponsive DOM read to the invocation deadline', async () => {
    const { composer } = editor();
    composer.innerText = async () => 'unverified draft';
    composer.evaluate = () => new Promise(() => {});
    const started = Date.now();
    expect(await __testSendDelivery.composerPayloadMatchesBeforeSend(composer, payload, started + 30)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('accepts normalized content without waiting for an unavailable exact reader (#2671)', async () => {
    const { composer } = editor();
    composer.evaluate = () => new Promise(() => {});
    expect(await matches(composer)).toBe(true);
  });
});

describe('Issue #2718 SENDING phase in the existing observation grammar', () => {
  it('adds prepared -> sending -> dispatching|not_sent through the existing writer only', async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const observation = await import('./state-light-turn-observation.ts');
    const root = mkdtempSync(join(tmpdir(), 'issue-2718-sending-'));
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', root);
    try {
      const profileKey = 'profile-2718';
      const admit = (invocationId: string) => observation.admitStateLightTurnObservation({
        profileKey, invocationId, marker: 'OPKTURNV1' + invocationId,
      });
      const move = (invocationId: string, phase: Parameters<typeof observation.transitionStateLightTurnObservation>[0]['phase']) =>
        observation.transitionStateLightTurnObservation({ profileKey, invocationId, phase, reason: 'pr_author_send_claim:acme/widgets#7' });

      admit('claim-dispatch');
      expect(move('claim-dispatch', 'sending')).toMatchObject({
        schema: 'state-light-turn-observation/v1', phase: 'sending', transition_reason: 'pr_author_send_claim:acme/widgets#7',
      });
      expect(move('claim-dispatch', 'sending').phase).toBe('sending');
      expect(move('claim-dispatch', 'dispatching').phase).toBe('dispatching');

      admit('claim-refused');
      move('claim-refused', 'sending');
      expect(move('claim-refused', 'not_sent').phase).toBe('not_sent');
      expect(() => move('claim-refused', 'sending')).toThrow('observation_phase_transition_invalid');

      // SENDING never stands for a dispatch or a delivery witness.
      admit('claim-skip');
      move('claim-skip', 'sending');
      for (const phase of ['sent_unbound', 'sent_unharvested', 'harvested', 'prepared'] as const) {
        expect(() => move('claim-skip', phase)).toThrow('observation_phase_transition_invalid');
      }
      expect(observation.readStateLightTurnObservation(profileKey, 'claim-skip').phase).toBe('sending');

      // Per-invocation read of a persisted SENDING record; older phases keep their meaning.
      const path = observation.observationRecordPath(profileKey, 'claim-skip');
      expect(JSON.parse(readFileSync(path, 'utf8')).phase).toBe('sending');
      admit('legacy');
      expect(move('legacy', 'dispatching').phase).toBe('dispatching');
      writeFileSync(path, readFileSync(path, 'utf8').replace('"phase":"sending"', '"phase":"claiming"'));
      expect(() => observation.readStateLightTurnObservation(profileKey, 'claim-skip')).toThrow('observation_record_malformed');
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
