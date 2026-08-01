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

  it('does not attribute a historical byte-identical original prompt', () => {
    expect(classify([
      { role: 'user', text: 'ORIGINAL PROMPT' },
      { role: 'assistant', text: 'historical reply' },
    ])).toEqual({ state: 'waiting' });
  });

  it('fails closed on duplicate marker nodes', () => {
    expect(classify([
      ...baseline,
      { role: 'user', text: markedPrompt },
      { role: 'assistant', text: 'first' },
      { role: 'user', text: `\u200B${markedPrompt}` },
    ])).toEqual({ state: 'uncertain', cause: 'owned_prompt_marker_ambiguous' });
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
