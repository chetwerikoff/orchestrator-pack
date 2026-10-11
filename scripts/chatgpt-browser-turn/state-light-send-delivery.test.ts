// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  browserQueue: [] as any[],
  cleanupOutcome: 'confirmed' as const,
  releaseBrowser: vi.fn(async () => undefined),
  verifyProfile: vi.fn(async () => ({ state: 'verified' })),
}));
vi.mock('./browser-session.ts', () => createBrowserSessionModuleMock(mocks));
vi.mock('./coordination.ts', () => createCoordinationModuleMock());
vi.mock('./input.ts', () => ({ readStableInput: vi.fn(() => stableTurnInput('PROMPT')) }));
vi.mock('./ui-adapter.ts', async (original) => buildUiAdapterTestMock(
  await original<typeof import('./ui-adapter.ts')>(), mocks,
));

import { buildUiAdapterTestMock, collectionLocator, createBrowserSessionModuleMock, createCoordinationModuleMock, enqueueBrowserForTurn, runStateLightTurnWithStdoutCapture, scalarLocator, stableTurnInput } from './state-light-turn.test-fixtures.ts';
import { COMPOSER_SELECTOR, SEND_BUTTON_SELECTOR, MESSAGE_NODE_SELECTOR, MESSAGE_AUTHOR_ROLE_ATTR, USER_MESSAGE_STYLE } from './product-page-selectors.ts';
import { __testSendDelivery, runStateLightTurn } from './state-light-turn-base.ts';
import { readStateLightTurnObservation } from './state-light-turn-observation.ts';
import { configuredProfileKey } from './storage-common.ts';
import { readTerminalEnvelope, runLaunch } from '../flow-manager-long-running-child.ts';
import { authoritativePreSend } from '../pack-review-no-review-reconcile.ts';

const MARKER = `OPKTURNV1${'ab'.repeat(16)}`;
const MARKED_PROMPT = `${MARKER}\n\nPROMPT`;

type Transport = 'click' | 'enter';
type DeliveryEffect = 'none' | 'owned_user_node' | 'composer_cleared' | 'both';

function createHarness(transport: Transport, effect: DeliveryEffect, actionThrows = false) {
  let composerText = MARKED_PROMPT;
  const userTexts = ['historical user'];
  const applyDeliveryEffect = vi.fn(async () => {
    if (effect === 'owned_user_node' || effect === 'both') {
      userTexts.push(MARKED_PROMPT);
    }
    if (effect === 'composer_cleared' || effect === 'both') {
      composerText = '';
    }
    if (actionThrows) throw Object.assign(new Error('locator.click: Timeout 5000ms exceeded after dispatch'), { name: 'TimeoutError' });
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
      getAttribute: vi.fn(async (name: string) => name === MESSAGE_AUTHOR_ROLE_ATTR ? USER_MESSAGE_STYLE : null),
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
    baselineUserNodeCount: 1,
    sendWaitMs: 1_000,
    invocationDeadlineMs: Date.now() + 1_000,
    deliveryProofWaitMs: 10,
  });
}

describe('state-light send delivery accounting', () => {
  it.each<Transport>(['click', 'enter'])(
    '%s attempts exactly once when delivery is unwitnessed',
    async (transport) => {
      const harness = createHarness(transport, 'none');

      expect(await dispatch(harness)).toEqual({ sendCount: 0, witness: 'unproven' });
      expect(harness.getComposerText()).toBe(MARKED_PROMPT);

      if (transport === 'click') {
        expect(harness.sendButton.click).toHaveBeenCalledTimes(1);
        expect(harness.composer.press).not.toHaveBeenCalled();
      } else {
        expect(harness.composer.press).toHaveBeenCalledTimes(1);
        expect(harness.sendButton.click).not.toHaveBeenCalled();
      }
    },
  );

  it.each<Transport>(['click', 'enter'])('%s observes an owned node after a transport TimeoutError', async (transport) => {
    const harness = createHarness(transport, 'owned_user_node', true);
    expect(await dispatch(harness)).toMatchObject({ sendCount: 1, witness: 'owned_user_node', actionError: expect.stringContaining('Timeout 5000ms') });
    expect(harness.sendButton.click.mock.calls.length + harness.composer.press.mock.calls.length).toBe(1);
  });

  it.each<Transport>(['click', 'enter'])('%s observes uncertainty after a transport TimeoutError without manufacturing a count', async (transport) => {
    const harness = createHarness(transport, 'none', true);
    expect(await dispatch(harness)).toMatchObject({ sendCount: 0, witness: 'unproven', actionError: expect.stringContaining('Timeout 5000ms') });
    expect(harness.sendButton.click.mock.calls.length + harness.composer.press.mock.calls.length).toBe(1);
  });

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

describe('Issue #2487 fresh-send readiness, positive non-dispatch evidence and Stop', () => {
  it.each([2_000, 27_000, 31_000, 58_000])(
    'observes an enabled button at %i ms without waiting for the end of a 30s window',
    async (enabledAt) => {
      let clock = 50_000;
      const startedAt = clock;
      const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
      try {
        const page = {
          locator: vi.fn(() => ({ count: async () => 0 })),
          waitForTimeout: vi.fn(async (ms: number) => { clock += ms; }),
          __fakeBrowserGptPage: true,
        };
        const button = {
          count: vi.fn(async () => 1),
          isVisible: vi.fn(async () => true),
          isEnabled: vi.fn(async () => clock - startedAt >= enabledAt),
        };
        expect(await __testSendDelivery.waitForFreshSendButton(
          page, button, () => {}, startedAt,
        )).toBe('enabled');
        expect(clock - startedAt).toBeGreaterThanOrEqual(enabledAt);
        expect(clock - startedAt).toBeLessThan(enabledAt + 500);
      } finally {
        now.mockRestore();
      }
    },
  );

  it('exhausts exactly 60 seconds when Send never becomes actionable', async () => {
    let clock = 10_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const page = {
        locator: vi.fn(() => ({ count: async () => 0 })),
        waitForTimeout: vi.fn(async (ms: number) => { clock += ms; }),
        __fakeBrowserGptPage: true,
      };
      const button = {
        count: vi.fn(async () => 1),
        isVisible: vi.fn(async () => true),
        isEnabled: vi.fn(async () => false),
      };
      expect(await __testSendDelivery.waitForFreshSendButton(page, button, () => {}, 10_000))
        .toBe('never_enabled');
      expect(clock).toBe(70_000);
    } finally {
      now.mockRestore();
    }
  });

  it('requires actual positive Playwright pre-actionability proof, not timeout naming', () => {
    const callLog = 'TimeoutError: locator.click: Timeout 5000ms exceeded\nCall log:\n - waiting for element to be visible, enabled and stable\n - element is not enabled';
    expect(__testSendDelivery.affirmativePreActionabilityTimeout(callLog)).toBe(true);
    expect(__testSendDelivery.affirmativePreActionabilityTimeout(
      'TimeoutError: locator.click: Timeout 5000ms exceeded',
    )).toBe(false);
    expect(__testSendDelivery.affirmativePreActionabilityTimeout(
      callLog + '\n - performing click action',
    )).toBe(false);
    expect(__testSendDelivery.affirmativePreActionabilityTimeout(
      callLog + '\n - click action done',
    )).toBe(false);
    expect(__testSendDelivery.affirmativePreActionabilityTimeout(
      callLog + '\n - scrolling into view',
    )).toBe(false);
    expect(__testSendDelivery.affirmativePreActionabilityTimeout(
      callLog + '\n - unknown later actionability progress',
    )).toBe(false);
    expect(__testSendDelivery.affirmativePreActionabilityTimeout(
      callLog.replace('element is not enabled', 'waiting for enabled element'),
    )).toBe(false);
    expect(__testSendDelivery.affirmativePreActionabilityTimeout(
      callLog.replace('TimeoutError', 'Error'),
    )).toBe(false);
  });

  it('accepts an attributable Stop discovered during delivery-proof polling after the first probe', async () => {
    const harness = createHarness('click', 'none');
    const previousLocator = harness.page.locator;
    let stopReads = 0;
    harness.page.locator = vi.fn((selector: string) => {
      if (selector.includes('stop-button') || selector.includes('Stop')) {
        return { count: vi.fn(async () => ++stopReads >= 3 ? 1 : 0), isVisible: vi.fn(async () => true) };
      }
      return previousLocator(selector);
    });
    const result = await __testSendDelivery.dispatchStateLightSendAndObserveDelivery({
      page: harness.page,
      composer: harness.composer,
      sendButton: harness.sendButton,
      hasSendButton: true,
      marker: MARKER,
      baselineUserNodeCount: 1,
      sendWaitMs: 1_000,
      invocationDeadlineMs: Date.now() + 1_000,
      deliveryProofWaitMs: 150,
      allowOwnedStopWitness: true,
    });
    expect(result).toMatchObject({ sendCount: 1, witness: 'owned_stop' });
    expect(stopReads).toBeGreaterThanOrEqual(3);
    expect(harness.sendButton.click).toHaveBeenCalledTimes(1);
  });

  it('treats newly attributable Stop after an owned click as delivered without numeric user nodes', async () => {
    const harness = createHarness('click', 'none');
    let stopped = false;
    const initialClick = harness.sendButton.click;
    harness.sendButton.click = vi.fn(async () => {
      await initialClick();
      stopped = true;
    });
    harness.page.locator = vi.fn((selector: string) => {
      if (selector.includes('stop-button') || selector.includes('Stop')) {
        return { count: vi.fn(async () => stopped ? 1 : 0), isVisible: vi.fn(async () => stopped) };
      }
      return { count: vi.fn(async () => 0) };
    });
    expect(await __testSendDelivery.dispatchStateLightSendAndObserveDelivery({
      page: harness.page,
      composer: harness.composer,
      sendButton: harness.sendButton,
      hasSendButton: true,
      marker: MARKER,
      baselineUserNodeCount: 1,
      sendWaitMs: 1_000,
      invocationDeadlineMs: Date.now() + 1_000,
      deliveryProofWaitMs: 10,
      allowOwnedStopWitness: true,
    })).toMatchObject({ sendCount: 1, witness: 'owned_stop' });
    expect(harness.sendButton.click).toHaveBeenCalledTimes(1);
  });
});

describe('production attempted-send result and durable envelope', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'attempted-send-'));
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mocks.browserQueue.length = 0;
  });

  it.each([
    ['positive-disabled', 2],
    ['generic-timeout', 1],
    ['possibly-clicked', 1],
    ['enter', 0],
    ['empty-baseline', 1],
    ['empty-after-click', 1],
    ['vanished-user', 1],
    ['reordered', 1],
    ['role-changed', 1],
    ['text-changed', 1],
    ['key-changed', 1],
    ['unreadable', 1],
    ['foreign-user', 1],
    ['active-generation', 1],
    ['unknown-generation', 1],
    ['stop-visible', 1],
    ['wrong-url', 1],
    ['changed-composer', 1],
    ['expired', 1],
  ] as const)('Issue #2495: %s allows exactly %i Send-button clicks', async (scenario, expectedClicks) => {
    const invocationId = randomUUID();
    const profile = join(root, 'profile');
    const cdp = 'http://127.0.0.1:9222';
    const chatUrl = 'https://chatgpt.com/c/synthetic-2495';
    let now = 50_000;
    let currentUrl = chatUrl;
    let composerText = '';
    let stop = false;
    let generation: boolean | 'unknown' = false;
    const messages: Array<{ role: string; text: string; key: string; complete?: boolean }> =
      scenario === 'empty-baseline' ? [] : [
        { role: 'user', text: 'historical user', key: 'user-key-2495' },
        { role: 'assistant', text: 'historical reply', key: 'assistant-key-2495' },
      ];
    const timeoutLog = 'locator.click: Timeout 5000ms exceeded\nCall log:\n - waiting for element to be visible, enabled and stable\n - element is not enabled';
    const firstAction = vi.fn(async () => {
      if (firstAction.mock.calls.length === 1) {
        switch (scenario) {
          case 'empty-after-click': messages.splice(0); break;
          case 'vanished-user': messages.splice(0, 1); break;
          case 'reordered': messages.reverse(); break;
          case 'role-changed': messages[0]!.role = 'assistant'; break;
          case 'text-changed': messages[0]!.text = 'changed'; break;
          case 'key-changed': messages[0]!.key = 'different-key-2495'; break;
          case 'unreadable': messages[0]!.complete = false; break;
          case 'foreign-user': messages.push({ role: 'user', text: 'foreign turn', key: 'foreign-key-2495' }); break;
          case 'active-generation': generation = true; break;
          case 'unknown-generation': generation = 'unknown'; break;
          case 'stop-visible': stop = true; break;
          case 'wrong-url': currentUrl = 'https://chatgpt.com/c/foreign'; break;
          case 'changed-composer': composerText = 'foreign draft'; break;
          case 'expired': now += 180_000; break;
        }
      }
      if (scenario === 'possibly-clicked') throw Object.assign(
        new Error(timeoutLog + '\n - performing click action'), { name: 'TimeoutError' },
      );
      if (scenario === 'generic-timeout') throw Object.assign(
        new Error('locator.click: Timeout 5000ms exceeded'), { name: 'TimeoutError' },
      );
      if (scenario !== 'enter') throw Object.assign(new Error(timeoutLog), { name: 'TimeoutError' });
    });
    const composer = scalarLocator({
      count: async () => 1,
      fill: async (value: string) => { composerText = value; },
      innerText: async () => composerText,
      press: firstAction,
    });
    const click = vi.fn(async () => { await firstAction(); });
    const messageNodes = {
      ...collectionLocator(messages as any[]),
      evaluateAll: vi.fn(async () => ({
        rows: messages.map((message, domIndex) => ({
          role: message.role, text: message.text, key: message.key, domIndex,
          complete: message.complete !== false, completionReady: false,
          continuationVisible: false,
        })),
        pageTurnEvidence: { generationInProgress: generation, observedAssistantNodes: 1, continueGeneratingVisible: false },
      })),
    };
    const page = {
      __fakeBrowserGptPage: true,
      url: () => currentUrl,
      isClosed: () => false,
      goto: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      waitForTimeout: vi.fn(async (ms: number) => { now += ms; }),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return scalarLocator({
          count: async () => scenario === 'enter' ? 0 : 1, click,
        });
        if (selector === MESSAGE_NODE_SELECTOR) return messageNodes;
        if (selector.includes('stop-button') || selector.includes('Stop')) {
          return scalarLocator({ count: async () => stop ? 1 : 0, isVisible: async () => stop });
        }
        return scalarLocator();
      }),
    };
    // Select an already-owned existing-chat tab; creation/navigation is not recovery.
    const browserFixture = enqueueBrowserForTurn(mocks, page);
    Object.assign(browserFixture.context, { pages: () => [page] });
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { result } = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
        '--profile', profile, '--cdp', cdp, '--input', join(root, 'synthetic-input'),
        '--output', join(root, invocationId + '.txt'), '--chat-url', chatUrl,
        '--invocation-id', invocationId, '--timeout-ms', '180000',
      ]);
      expect(click).toHaveBeenCalledTimes(expectedClicks);
      expect(firstAction).toHaveBeenCalledTimes(scenario === 'enter' ? 1 : expectedClicks);
      expect(result.send_count).toBe(0);
      expect(result.send_attempted).toBe(true);
      expect(page.close).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ['ready', 0, 1],
    ['late-hydration', 0, 1],
    ['reopen-ready', 1, 1],
    ['still-absent', 1, 0],
    ['redirected', 1, 0],
    ['busy', 0, 0],
    ['near-expiry', 0, 0],
  ] as const)('Issue #2495 composer: %s navigates %i times and sends %i times', async (
    scenario, expectedNavigations, expectedSends,
  ) => {
    const invocationId = randomUUID();
    const profile = join(root, 'profile');
    const cdp = 'http://127.0.0.1:9222';
    const chatUrl = 'https://chatgpt.com/c/synthetic-2495';
    let now = 50_000;
    const startedAt = now;
    let currentUrl = chatUrl;
    let composerText = '';
    let navigations = 0;
    const ready = () => scenario === 'ready'
      || (scenario === 'late-hydration' && now - startedAt >= 20_000)
      || (scenario === 'reopen-ready' && navigations === 1);
    const composer = scalarLocator({
      count: async () => ready() ? 1 : 0,
      fill: async (value: string) => { composerText = value; },
      innerText: async () => composerText,
    });
    const send = vi.fn(async () => {
      throw Object.assign(new Error('locator.click: Timeout 5000ms exceeded after dispatch'), { name: 'TimeoutError' });
    });
    const nodes = {
      ...collectionLocator([{ role: 'user', text: 'historical user' }]),
      evaluateAll: vi.fn(async () => ({
        rows: [{
          role: 'user', text: 'historical user', key: 'historical-user-key-2495',
          domIndex: 0, complete: true, completionReady: false, continuationVisible: false,
        }],
        pageTurnEvidence: { generationInProgress: false, observedAssistantNodes: 0, continueGeneratingVisible: false },
      })),
    };
    const goto = vi.fn(async (url: string) => {
      navigations++;
      currentUrl = scenario === 'redirected' ? 'https://chatgpt.com/c/foreign' : url;
    });
    const page = {
      __fakeBrowserGptPage: true,
      url: () => currentUrl,
      isClosed: () => false,
      goto,
      close: vi.fn(async () => undefined),
      waitForTimeout: vi.fn(async (ms: number) => { now += ms; }),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return scalarLocator({ count: async () => 1, click: send });
        if (selector === MESSAGE_NODE_SELECTOR) return nodes;
        if (selector.includes('stop-button') || selector.includes('Stop')) {
          return scalarLocator({
            count: async () => scenario === 'busy' && now - startedAt >= 30_000 ? 1 : 0,
            isVisible: async () => true,
          });
        }
        return scalarLocator();
      }),
    };
    // Select an already-owned existing-chat tab; creation/navigation is not recovery.
    const browserFixture = enqueueBrowserForTurn(mocks, page);
    Object.assign(browserFixture.context, { pages: () => [page] });
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { result } = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
        '--profile', profile, '--cdp', cdp, '--input', join(root, 'synthetic-input'),
        '--output', join(root, invocationId + '.txt'), '--chat-url', chatUrl,
        '--invocation-id', invocationId, '--timeout-ms', scenario === 'near-expiry' ? '10000' : '180000',
      ]);
      expect(goto).toHaveBeenCalledTimes(expectedNavigations);
      if (expectedNavigations === 1) expect(goto).toHaveBeenCalledWith(
        chatUrl, expect.objectContaining({ waitUntil: 'commit' }),
      );
      expect(send).toHaveBeenCalledTimes(expectedSends);
      expect(result.send_count).toBe(0);
      expect(result.send_attempted === true).toBe(expectedSends > 0);
      expect(page.close).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it.each((['click', 'enter'] as const).flatMap((transport) =>
    (['witness_then_throw', 'throw_no_witness', 'return_no_witness', 'pre_dispatch'] as const)
      .map((scenario) => ({ transport, scenario })),
  ))('preserves $transport dispatch authority: $scenario', async ({ transport, scenario }) => {
      const invocationId = randomUUID();
      const profile = join(root, 'profile');
      const cdp = 'http://127.0.0.1:9222';
      const chatUrl = 'https://chatgpt.com/c/synthetic-owned-turn';
      let now = 10_000;
      let text = '';
      let attempts = 0;
      const users = [{ role: 'user' as const, text: 'historical user' }];
      const send = vi.fn(async () => {
        attempts++;
        if (scenario === 'witness_then_throw') users.push({ role: 'user', text });
        if (scenario.includes('throw')) throw Object.assign(new Error('locator.click: Timeout 5000ms exceeded after dispatch'), { name: 'TimeoutError' });
      });
      const composer = scalarLocator({
        count: vi.fn(async () => 1),
        fill: vi.fn(async (value: string) => { text = value; }),
        innerText: vi.fn(async () => text),
        press: send,
      });
      const page = {
        __fakeBrowserGptPage: true,
        url: () => chatUrl,
        isClosed: () => false,
        goto: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        waitForTimeout: vi.fn(async (ms: number) => { now += ms; }),
        locator: vi.fn((selector: string) => {
          if (selector === COMPOSER_SELECTOR) return composer;
          if (selector === SEND_BUTTON_SELECTOR) return scalarLocator({ count: async () => transport === 'click' ? 1 : 0, click: send });
          if (selector === MESSAGE_NODE_SELECTOR) return collectionLocator(users);
          return scalarLocator();
        }),
      };
      enqueueBrowserForTurn(mocks, page);
      if (scenario === 'pre_dispatch') mocks.verifyProfile.mockImplementationOnce(async () => ({ state: 'mismatch', cause: 'profile_mismatch' }));
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const { result } = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
        '--profile', profile, '--cdp', cdp, '--input', join(root, 'synthetic-input'),
        '--output', join(root, `${invocationId}.txt`), '--chat-url', chatUrl,
        '--invocation-id', invocationId, '--timeout-ms', '1000',
      ]);
      clock.mockRestore();
      const observation = readStateLightTurnObservation(configuredProfileKey(profile, cdp), invocationId);
      const witnessed = scenario === 'witness_then_throw';
      const preDispatch = scenario === 'pre_dispatch';
      expect(attempts).toBe(preDispatch ? 0 : 1);
      expect(result.send_count).toBe(witnessed ? 1 : 0);
      expect(observation.phase).toBe(preDispatch ? 'not_sent' : witnessed ? 'sent_unharvested' : 'dispatching');
      if (!preDispatch) {
        expect(page.close).not.toHaveBeenCalled();
        if (!witnessed) {
          expect(result.send_attempted).toBe(true);
          expect(observation.send_count).toBeUndefined();
          expect(observation.send_witness).toBe('none');
        }
      }
      if (scenario === 'throw_no_witness') expect(result.cause).toContain('Timeout 5000ms');

      // Consume the real finalized production result through the unchanged
      // child settlement producer and the launcher's actual JSON parser.
      const envelopePath = join(root, `${invocationId}-terminal.json`);
      await runLaunch({
        runIdentity: `run-${invocationId}`, attemptIdentity: invocationId, cwd: root,
        handoffReceiptPath: join(root, `${invocationId}-handoff.json`), terminalEnvelopePath: envelopePath,
        terminalEnvelopeRoot: root,
        browserOutputPath: join(root, `${invocationId}-output.txt`),
        conversationLocator: chatUrl,
        childCommand: process.execPath, childArgs: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(result) + '\n')})`],
      });
      expect(readTerminalEnvelope(envelopePath)).toMatchObject({
        delivery: preDispatch ? 'not-sent' : 'POSSIBLY_DELIVERED',
        send_count: witnessed ? 1 : 0, observed_invocation_id: invocationId,
        ...(preDispatch ? {} : { recovery_available: true, conversation_locator: chatUrl }),
      });
      for (const terminalResult of [result, readTerminalEnvelope(envelopePath)!]) {
        expect(authoritativePreSend({
          slotId: 'source-01', ordinal: 1, lifecycle: 'terminal', invocationId,
          launchProfileKey: configuredProfileKey(profile, cdp), launchCdpUrl: cdp, terminalResult,
        }, observation)).toBe(preDispatch);
      }
  });
});
