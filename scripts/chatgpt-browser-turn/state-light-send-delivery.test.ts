import { describe, expect, it, vi } from 'vitest';

import { __testSendDelivery } from './state-light-turn-base.ts';

const MARKER = `OPKTURNV1${'ab'.repeat(16)}`;
const MARKED_PROMPT = `${MARKER}\n\nPROMPT`;

type Transport = 'click' | 'enter';
type DeliveryEffect = 'none' | 'owned_user_node' | 'composer_cleared' | 'both';

function createHarness(transport: Transport, effect: DeliveryEffect) {
  let composerText = MARKED_PROMPT;
  const userTexts = ['historical user'];
  const applyDeliveryEffect = vi.fn(async () => {
    if (effect === 'owned_user_node' || effect === 'both') {
      userTexts.push(MARKED_PROMPT);
    }
    if (effect === 'composer_cleared' || effect === 'both') {
      composerText = '';
    }
  });

  const composer = {
    innerText: vi.fn(async () => composerText),
    press: vi.fn(async (key: string) => {
      expect(key).toBe('Enter');
      await applyDeliveryEffect();
    }),
  };
  const sendButton = {
    click: vi.fn(async () => {
      await applyDeliveryEffect();
    }),
  };
  const userNodes = {
    count: vi.fn(async () => userTexts.length),
    nth: vi.fn((index: number) => ({
      innerText: vi.fn(async () => userTexts[index] ?? ''),
    })),
  };
  const page = {
    __fakeBrowserGptPage: true,
    locator: vi.fn(() => userNodes),
    waitForTimeout: vi.fn(async (milliseconds: number) => {
      if (milliseconds > 0) await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    }),
  };

  return {
    page,
    composer,
    sendButton,
    transport,
    getComposerText: () => composerText,
  };
}

async function dispatch(harness: ReturnType<typeof createHarness>) {
  return await __testSendDelivery.dispatchStateLightSendAndObserveDelivery({
    page: harness.page,
    composer: harness.composer,
    sendButton: harness.sendButton,
    hasSendButton: harness.transport === 'click',
    marker: MARKER,
    sendWaitMs: 1_000,
    invocationDeadlineMs: Date.now() + 1_000,
    deliveryProofWaitMs: 10,
  });
}

describe('state-light send delivery accounting', () => {
  it.each<Transport>(['click', 'enter'])(
    '%s keeps send_count at 0 when the prompt remains and no owned user node appears, so retry stays allowed',
    async (transport) => {
      const harness = createHarness(transport, 'none');

      expect(await dispatch(harness)).toEqual({ sendCount: 0, witness: 'unproven' });
      expect(harness.getComposerText()).toBe(MARKED_PROMPT);

      // A second invocation of the same dispatch boundary is still allowed because
      // the first attempt produced no delivery witness and therefore no send count.
      expect(await dispatch(harness)).toEqual({ sendCount: 0, witness: 'unproven' });

      if (transport === 'click') {
        expect(harness.sendButton.click).toHaveBeenCalledTimes(2);
        expect(harness.composer.press).not.toHaveBeenCalled();
      } else {
        expect(harness.composer.press).toHaveBeenCalledTimes(2);
        expect(harness.sendButton.click).not.toHaveBeenCalled();
      }
    },
  );

  it('counts a newly appearing owned live-user node exactly once even when the composer still contains the prompt', async () => {
    const harness = createHarness('click', 'owned_user_node');

    expect(await dispatch(harness)).toEqual({ sendCount: 1, witness: 'owned_user_node' });
    expect(harness.getComposerText()).toBe(MARKED_PROMPT);
    expect(harness.sendButton.click).toHaveBeenCalledTimes(1);
  });

  it('counts cleared composer text exactly once even when no owned user node appears', async () => {
    const harness = createHarness('enter', 'composer_cleared');

    expect(await dispatch(harness)).toEqual({ sendCount: 1, witness: 'composer_cleared' });
    expect(harness.getComposerText()).toBe('');
    expect(harness.composer.press).toHaveBeenCalledTimes(1);
  });

  it('still counts exactly one delivery when both allowed witnesses appear', async () => {
    const harness = createHarness('click', 'both');

    expect((await dispatch(harness)).sendCount).toBe(1);
    expect(harness.sendButton.click).toHaveBeenCalledTimes(1);
  });
});
