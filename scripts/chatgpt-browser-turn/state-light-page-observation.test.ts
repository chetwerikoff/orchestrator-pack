import { describe, expect, it, vi } from 'vitest';

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
