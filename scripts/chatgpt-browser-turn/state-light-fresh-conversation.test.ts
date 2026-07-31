import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  browserQueue: [] as any[],
  cleanupOutcome: 'confirmed' as 'confirmed' | 'unconfirmed',
  verifyProfile: vi.fn(async () => ({ state: 'verified' })),
  legacyPublishReply: vi.fn(() => {
    throw new Error('legacy publication state unavailable');
  }),
  appendFileSync: vi.fn(() => undefined),
  linkSync: vi.fn(() => undefined),
  releaseBrowser: vi.fn(async () => undefined),
  nowMs: 10_000,
  readStableInput: vi.fn(() => ({
    text: 'PROMPT',
    bytes: new Uint8Array([80, 82, 79, 77, 80, 84]),
    byteLength: 6,
    dev: 1n,
    ino: 1n,
  })),
  productStatusText: vi.fn(async () => ''),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    appendFileSync: mocks.appendFileSync,
    linkSync: mocks.linkSync,
  };
  it('replays journal symptom send_observation_deferred/fresh_conversation_url_not_observed', async () => {
    const prompt = 'PROMPT-JOURNAL-DEFER';
    const reply = 'JOURNAL-OK';
    let sent = false;
    let url = PROJECT_URL;
    let observationIndex = 0;
    const snapshotFrames = readyTurnObservationFrames(prompt, reply).map((messages, index) => ({
      messages,
      generating: index < 2,
    }));

    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
      innerText: vi.fn(async () => (sent ? '' : prompt)),
      textContent: vi.fn(async () => (sent ? '' : prompt)),
      press: vi.fn(async () => { sent = true; }),
    });
    const sendButton = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => { sent = true; }),
    });

    const page: any = {
      __fakeBrowserGptPage: true,
      goto: vi.fn(async (target: string) => { url = target; }),
      url: vi.fn(() => url),
      isClosed: vi.fn(() => false),
      waitForTimeout: vi.fn(async (ms: number) => { mocks.nowMs += ms; }),
      close: vi.fn(async () => undefined),
      getByText: vi.fn(() => scalarLocator()),
      getByRole: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return sendButton;
        if (matchesNewChatControlSelector(selector)) {
          return scalarLocator({ count: vi.fn(async () => 0) });
        }
        if (selector === MESSAGE_NODE_SELECTOR) {
          if (!sent) return collectionLocator([]);
          const frame = snapshotFrames[Math.min(observationIndex, snapshotFrames.length - 1)]!;
          observationIndex++;
          return collectionLocator(frame.messages, frame.generating);
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          const frame = snapshotFrames[Math.min(observationIndex - 1, snapshotFrames.length - 1)]!;
          const last = frame.messages.at(-1);
          if (last?.finalActionInTurnContainer) return messageLocator(last);
          return scalarLocator({ count: vi.fn(async () => 0) });
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          const frame = snapshotFrames[Math.min(observationIndex - 1, snapshotFrames.length - 1)]!;
          return collectionLocator(
            frame.messages.filter((message: StateLightTestMessage) => message.role === 'assistant'),
            frame.generating,
          );
        }
        if (selector.includes(STOP_BUTTON_TESTID)) return scalarLocator();
        return scalarLocator();
      }),
    };

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, '/tmp/journal-defer-replay.txt');

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.result.incidents).toContain('send_observation_deferred');
    expect(outcome.result.state).not.toBe('send_failed');
  });

});

vi.mock('./browser-session.ts', () => createBrowserSessionModuleMock(mocks));
vi.mock('./coordination.ts', () => createCoordinationModuleMock());

vi.mock('./input.ts', () => ({
  readStableInput: mocks.readStableInput,
}));

vi.mock('./publication.ts', () => ({ publishReply: mocks.legacyPublishReply }));
vi.mock('./storage-common.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage-common.ts')>();
  return {
    ...actual,
    configuredProfileKey: vi.fn(() => 'collision-profile'),
  };
});

vi.mock('./ui-adapter.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui-adapter.ts')>();
  const { buildUiAdapterTestMock } = await import('./state-light-turn.test-fixtures.ts');
  const mock = buildUiAdapterTestMock(actual, mocks);
  return {
    ...mock,
    productStatusText: mocks.productStatusText,
  };
});

import {
  collectionLocator,
  createBrowserSessionModuleMock,
  createCoordinationModuleMock,
  enqueueBrowserForTurn,
  messageLocator,
  readyTurnObservationFrames,
  runStateLightTurnWithStdoutCapture,
  scalarLocator,
  stableTurnInput,
  STATE_LIGHT_TURN_BASE_ARGV,
  type StateLightTestMessage,
} from './state-light-turn.test-fixtures.ts';
import { classifyPageObservation, classifySendLandingEvidence, runStateLightTurn } from './state-light-turn.ts';
import * as uiAdapter from './ui-adapter.ts';
import {
  ASSISTANT_MESSAGE_SELECTOR,
  ASSISTANT_TURN_ANCESTOR_XPATH,
  COMPOSER_SELECTOR,
  matchesNewChatControlSelector,
  MESSAGE_NODE_SELECTOR,
  SEND_BUTTON_SELECTOR,
  STOP_BUTTON_TESTID,
} from './product-page-selectors.ts';
import {
  acquireStateLightNewChatSendSlot,
  newChatSendSlotEnabled,
  isBlankProjectSurfaceUrl,
  openBlankProjectChatSurface,
  prepareStateLightFreshConversation,
  projectConversationPrefix,
  ownedConversationIdentityMatches,
  projectSurfaceUrlsEquivalent,
  readStateLightAdvisoryWall,
  recordStateLightAdvisoryWall,
  releaseStateLightFreshConversationClaim,
  releaseStateLightNewChatSendSlot,
  StateLightNavigationCounter,
  STATE_LIGHT_ADVISORY_WALL_TTL_MS,
  STATE_LIGHT_MAX_NAVIGATIONS_PER_INVOCATION,
  tryClaimStateLightFreshConversation,
} from './state-light-fresh-conversation.ts';

const PROJECT_URL = 'https://chatgpt.com/g/g-p-test/project';
const SHARED_CONV = `${PROJECT_URL}/c/11111111-1111-4111-8111-111111111111`;
const LOSER_CONV = `${PROJECT_URL}/c/22222222-2222-4222-8222-222222222222`;

function disableSendSlotForTest(): void {
  process.env.OPK_STATE_LIGHT_DISABLE_NEW_CHAT_SEND_SLOT = '1';
  process.env.OPK_STATE_LIGHT_ALLOW_SEND_SLOT_DISABLE = '1';
  process.env.OPK_STATE_LIGHT_SEND_SLOT_DISABLE_REASON = 'unit-test';
}

function clearSendSlotDisableEnv(): void {
  delete process.env.OPK_STATE_LIGHT_DISABLE_NEW_CHAT_SEND_SLOT;
  delete process.env.OPK_STATE_LIGHT_ALLOW_SEND_SLOT_DISABLE;
  delete process.env.OPK_STATE_LIGHT_SEND_SLOT_DISABLE_REASON;
}

function makeLoserPage(prompt: string, reply: string) {
  let sends = 0;
  let sent = false;
  let url = PROJECT_URL;
  let observationIndex = 0;
  const snapshotFrames = readyTurnObservationFrames(prompt, reply).map((messages, index) => ({
    messages,
    generating: index < 2,
  }));
  let activeSnapshot = snapshotFrames[0]!;

  const composer = scalarLocator({
    count: vi.fn(async () => 1),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    innerText: vi.fn(async () => (sent ? '' : prompt)),
    textContent: vi.fn(async () => (sent ? '' : prompt)),
    press: vi.fn(async () => {
      sends++;
      sent = true;
      url = sends === 1 ? SHARED_CONV : LOSER_CONV;
    }),
  });
  const sendButton = scalarLocator({
    count: vi.fn(async () => 1),
    click: vi.fn(async () => {
      sends++;
      sent = true;
      url = sends === 1 ? SHARED_CONV : LOSER_CONV;
    }),
  });

  const page: any = {
    __fakeBrowserGptPage: true,
    goto: vi.fn(async (target: string) => {
      url = target;
      if (target === PROJECT_URL) sent = false;
    }),
    url: vi.fn(() => url),
    isClosed: vi.fn(() => false),
    waitForTimeout: vi.fn(async (ms: number) => {
      mocks.nowMs += ms;
    }),
    close: vi.fn(async () => undefined),
    getByText: vi.fn(() => scalarLocator()),
    getByRole: vi.fn(() => scalarLocator()),
    locator: vi.fn((selector: string) => {
      if (selector === COMPOSER_SELECTOR) return composer;
      if (selector === SEND_BUTTON_SELECTOR) return sendButton;
      if (matchesNewChatControlSelector(selector)) {
        return scalarLocator({ count: vi.fn(async () => 0) });
      }
      if (selector === MESSAGE_NODE_SELECTOR) {
        if (!sent) return collectionLocator([]);
        activeSnapshot = snapshotFrames[Math.min(observationIndex, snapshotFrames.length - 1)]!;
        observationIndex++;
        return collectionLocator(activeSnapshot.messages, activeSnapshot.generating);
      }
      if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
        const last = activeSnapshot.messages.at(-1);
        if (last?.finalActionInTurnContainer) return messageLocator(last);
        return scalarLocator({ count: vi.fn(async () => 0) });
      }
      if (selector === ASSISTANT_MESSAGE_SELECTOR) {
        return collectionLocator(
          activeSnapshot.messages.filter((message: StateLightTestMessage) => message.role === 'assistant'),
          activeSnapshot.generating,
        );
      }
      if (selector.includes(STOP_BUTTON_TESTID)) return scalarLocator();
      return scalarLocator();
    }),
  };

  return { page, getSends: () => sends };
}

async function runNewChatTurn(page: any, outputPath: string) {
  enqueueBrowserForTurn(mocks, page);
  return runStateLightTurnWithStdoutCapture(runStateLightTurn, [
    ...STATE_LIGHT_TURN_BASE_ARGV,
    '--output', outputPath,
    '--new-chat',
    '--project-url', PROJECT_URL,
    '--timeout-ms', '5000',
    '--poll-ms', '1',
  ]);
}

describe('state-light fresh conversation collision recovery', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'slt-fresh-'));
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = stateDir;
    disableSendSlotForTest();
    mocks.browserQueue.length = 0;
    mocks.cleanupOutcome = 'confirmed';
    mocks.nowMs = 10_000;
    mocks.productStatusText.mockReset();
    mocks.productStatusText.mockResolvedValue({ text: '', composer: true });
    vi.spyOn(Date, 'now').mockImplementation(() => mocks.nowMs);
    mocks.readStableInput.mockReset();
  });

  afterEach(() => {
    delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
    clearSendSlotDisableEnv();
    rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('serializes conversation claims so only the owner holds the shared surface', () => {
    const profileKey = 'collision-profile';
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'winner')).toBe('claimed');
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'loser')).toBe('contended');
    releaseStateLightFreshConversationClaim(profileKey, SHARED_CONV, 'winner');
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'loser')).toBe('claimed');
    releaseStateLightFreshConversationClaim(profileKey, SHARED_CONV, 'loser');
  });

  it('blocks a second new-chat invocation while the profile send slot is held', async () => {
    clearSendSlotDisableEnv();
    const profileKey = 'collision-profile';

    await acquireStateLightNewChatSendSlot(profileKey, 'winner-invocation', 5_000);

    let loserAcquired = false;
    const loserAcquire = acquireStateLightNewChatSendSlot(profileKey, 'loser-invocation', 5_000).then(() => {
      loserAcquired = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(loserAcquired).toBe(false);

    releaseStateLightNewChatSendSlot(profileKey, 'winner-invocation');
    await loserAcquire;
    expect(loserAcquired).toBe(true);

    releaseStateLightNewChatSendSlot(profileKey, 'loser-invocation');
  });

  it('requires explicit opt-in and reason before the send slot can be disabled', () => {
    clearSendSlotDisableEnv();
    expect(newChatSendSlotEnabled()).toBe(true);

    process.env.OPK_STATE_LIGHT_DISABLE_NEW_CHAT_SEND_SLOT = '1';
    expect(newChatSendSlotEnabled()).toBe(true);

    process.env.OPK_STATE_LIGHT_ALLOW_SEND_SLOT_DISABLE = '1';
    expect(newChatSendSlotEnabled()).toBe(true);

    process.env.OPK_STATE_LIGHT_SEND_SLOT_DISABLE_REASON = 'unit-test';
    expect(newChatSendSlotEnabled()).toBe(false);
  });

  it('terminates contended recovery without a second send when the prompt already landed', async () => {
    const profileKey = 'collision-profile';
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'winner-invocation')).toBe('claimed');

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-LOSER'));
    const loser = makeLoserPage('PROMPT-LOSER', 'LOSER-OK');
    const loserOutcome = await runNewChatTurn(loser.page, '/tmp/loser.txt');

    expect(loserOutcome.code).toBe(13);
    expect(loserOutcome.result).toMatchObject({
      state: 'driver_error',
      cause: 'fresh_conversation_collision_send_landed',
      send_count: 1,
      navigation_count: expect.any(Number),
    });
    expect(loserOutcome.result.incidents).toContain('fresh_conversation_collision');
    expect(loser.getSends()).toBe(1);

    releaseStateLightFreshConversationClaim(profileKey, SHARED_CONV, 'winner-invocation');
  });

  it('returns advisory wall state without navigating when a fresh marker exists', async () => {
    const profileKey = 'collision-profile';
    recordStateLightAdvisoryWall(profileKey, 'rate_limit', 'rate_limit_detected', 'prior-invocation');

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-LOSER'));
    const loser = makeLoserPage('PROMPT-LOSER', 'LOSER-OK');
    const outcome = await runNewChatTurn(loser.page, '/tmp/advisory.txt');

    expect(outcome.code).toBe(12);
    expect(outcome.result).toMatchObject({
      state: 'rate_limit',
      cause: 'rate_limit_detected',
      send_count: 0,
      goto_count: 0,
      new_chat_click_count: 0,
      navigation_count: 0,
    });
    expect(loser.page.goto).not.toHaveBeenCalled();
  });

  it('ignores expired advisory wall markers fail-open', () => {
    const profileKey = 'collision-profile';
    recordStateLightAdvisoryWall(profileKey, 'quota', 'quota_detected', 'prior-invocation', 1_000, 0);
    expect(readStateLightAdvisoryWall(profileKey, STATE_LIGHT_ADVISORY_WALL_TTL_MS + 1)).toBeNull();
  });

  it('uses exactly one goto on the happy-path fresh turn', async () => {
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-SOLO'));
    const solo = makeLoserPage('PROMPT-SOLO', 'SOLO-OK');
    const outcome = await runNewChatTurn(solo.page, '/tmp/solo.txt');

    expect(outcome.code).toBe(0);
    expect(outcome.result.goto_count).toBe(1);
    expect(outcome.result.navigation_count).toBe(
      outcome.result.goto_count + outcome.result.new_chat_click_count,
    );
    expect(outcome.result.navigation_count).toBeLessThanOrEqual(STATE_LIGHT_MAX_NAVIGATIONS_PER_INVOCATION);
    expect(solo.page.goto).toHaveBeenCalledTimes(1);
  });

  it('returns rate_limit from prepare without additional navigation rounds', async () => {
    vi.mocked(uiAdapter.classifyProductWall).mockImplementation((surface) => {
      const text = typeof surface === 'string' ? surface : surface.text;
      if (/temporarily limited/i.test(text)) return { state: 'rate_limit', cause: 'rate_limit_detected' };
      return {};
    });
    mocks.productStatusText.mockResolvedValue({ text: 'temporarily limited access', composer: false });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-SOLO'));
    const solo = makeLoserPage('PROMPT-SOLO', 'SOLO-OK');
    const outcome = await runNewChatTurn(solo.page, '/tmp/rate-limit-prepare.txt');

    expect(outcome.code).toBe(12);
    expect(outcome.result).toMatchObject({
      state: 'rate_limit',
      cause: 'rate_limit_detected',
      send_count: 0,
    });
    expect(outcome.result.navigation_count).toBeLessThanOrEqual(3);
    expect(readStateLightAdvisoryWall('collision-profile')).toMatchObject({ state: 'rate_limit' });
  });

  it('continues observing after fresh-conversation URL wait expiry without send_failed', async () => {
    const prompt = 'PROMPT-SOLO';
    const reply = 'SOLO-OK';
    let sent = false;
    let url = PROJECT_URL;
    let observationIndex = 0;
    const snapshotFrames = readyTurnObservationFrames(prompt, reply).map((messages, index) => ({
      messages,
      generating: index < 2,
    }));

    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
      innerText: vi.fn(async () => (sent ? '' : prompt)),
      textContent: vi.fn(async () => (sent ? '' : prompt)),
      press: vi.fn(async () => { sent = true; }),
    });
    const sendButton = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => { sent = true; }),
    });

    const page: any = {
      __fakeBrowserGptPage: true,
      goto: vi.fn(async (target: string) => { url = target; }),
      url: vi.fn(() => url),
      isClosed: vi.fn(() => false),
      waitForTimeout: vi.fn(async (ms: number) => { mocks.nowMs += ms; }),
      close: vi.fn(async () => undefined),
      getByText: vi.fn(() => scalarLocator()),
      getByRole: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return sendButton;
        if (matchesNewChatControlSelector(selector)) {
          return scalarLocator({ count: vi.fn(async () => 0) });
        }
        if (selector === MESSAGE_NODE_SELECTOR) {
          if (!sent) return collectionLocator([]);
          const frame = snapshotFrames[Math.min(observationIndex, snapshotFrames.length - 1)]!;
          observationIndex++;
          return collectionLocator(frame.messages, frame.generating);
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          const frame = snapshotFrames[Math.min(observationIndex - 1, snapshotFrames.length - 1)]!;
          const last = frame.messages.at(-1);
          if (last?.finalActionInTurnContainer) return messageLocator(last);
          return scalarLocator({ count: vi.fn(async () => 0) });
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          const frame = snapshotFrames[Math.min(observationIndex - 1, snapshotFrames.length - 1)]!;
          return collectionLocator(
            frame.messages.filter((message: StateLightTestMessage) => message.role === 'assistant'),
            frame.generating,
          );
        }
        if (selector.includes(STOP_BUTTON_TESTID)) return scalarLocator();
        return scalarLocator();
      }),
    };

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, '/tmp/url-wait-expiry.txt');

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'ok',
      send_count: 1,
    });
    expect(outcome.result.state).not.toBe('send_failed');
    expect(outcome.result.incidents).toContain('send_observation_deferred');
  });

  it('classifies send landing evidence from page state', async () => {
    const prompt = 'PROMPT-LOSER';
    const page = {
      url: vi.fn(() => PROJECT_URL),
      getByRole: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) {
          return scalarLocator({
            count: vi.fn(async () => 1),
            innerText: vi.fn(async () => prompt),
            textContent: vi.fn(async () => prompt),
          });
        }
        if (selector === MESSAGE_NODE_SELECTOR) return collectionLocator([]);
        return scalarLocator();
      }),
    };

    expect(await classifySendLandingEvidence(page, prompt)).toBe('not_landed');
    expect(await classifySendLandingEvidence(page, prompt, SHARED_CONV)).toBe('landed');
  });

  it('still rejects real foreign human activity after the owned prompt', () => {
    const baseline: StateLightTestMessage[] = [
      { role: 'user', text: 'OLD' },
      { role: 'assistant', text: 'OLD ANSWER' },
    ];
    const decision = classifyPageObservation(
      [
        ...baseline,
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: 'partial' },
        { role: 'user', text: 'FOREIGN' },
      ],
      baseline.length,
      'PROMPT',
      false,
    );

    expect(decision).toMatchObject({
      state: 'ready',
      reply: 'partial',
    });
  });

  it('matches project-scoped and bare conversation urls with the same uuid', () => {
    const uuid = '6a6c32b2-51a0-83ec-9fe6-521e171ba785';
    const project = `https://chatgpt.com/g/g-p-test-project/c/${uuid}`;
    const bare = `https://chatgpt.com/c/${uuid}`;
    expect(ownedConversationIdentityMatches(project, bare)).toBe(true);
    expect(ownedConversationIdentityMatches(bare, project)).toBe(true);
  });

  it('rejects different conversation uuids', () => {
    const left = 'https://chatgpt.com/c/6a6c32b2-51a0-83ec-9fe6-521e171ba785';
    const right = 'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111';
    expect(ownedConversationIdentityMatches(left, right)).toBe(false);
  });

  it('treats equivalent project URL variants as the same blank surface', () => {
    const canonical = PROJECT_URL;
    expect(projectSurfaceUrlsEquivalent(`${canonical}/`, canonical)).toBe(true);
    expect(projectSurfaceUrlsEquivalent(`${canonical}?ref=home`, canonical)).toBe(true);
    expect(projectSurfaceUrlsEquivalent(`${canonical}#composer`, canonical)).toBe(true);
    expect(isBlankProjectSurfaceUrl(canonical, canonical)).toBe(true);
    expect(projectSurfaceUrlsEquivalent(SHARED_CONV, canonical)).toBe(false);
  });

  it('reloads the project surface when the current URL still carries a conversation id', async () => {
    const navigation = new StateLightNavigationCounter();
    let url = SHARED_CONV;
    const page = {
      goto: vi.fn(async (target: string) => {
        url = target;
      }),
      url: vi.fn(() => url),
      locator: vi.fn(() => scalarLocator({ count: vi.fn(async () => 0) })),
    };

    await openBlankProjectChatSurface(page, PROJECT_URL, 5_000, navigation);

    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith(projectConversationPrefix(PROJECT_URL), expect.any(Object));
    expect(navigation.snapshotGoto()).toBe(1);
  });

  it('prepareStateLightFreshConversation skips a second goto when already on a blank project surface', async () => {
    const navigation = new StateLightNavigationCounter();
    const page = {
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => `${PROJECT_URL}/?ref=home`),
      locator: vi.fn(() => scalarLocator({ count: vi.fn(async () => 0) })),
    };

    const prepared = await prepareStateLightFreshConversation(
      page,
      {
        cdp: 'http://127.0.0.1:9222',
        profile: '/tmp/profile',
        newChat: true,
        projectUrl: PROJECT_URL,
        timeoutMs: 5_000,
        pollMs: 1,
      },
      'collision-profile',
      'prepare-invocation',
      navigation,
    );

    expect(prepared).toEqual({ state: 'ready' });
    expect(page.goto).not.toHaveBeenCalled();
    expect(navigation.snapshotGoto()).toBe(0);
  });

  it('enforces the per-invocation navigation budget', async () => {
    const navigation = new StateLightNavigationCounter(1);
    let url = SHARED_CONV;
    const page = {
      goto: vi.fn(async (target: string) => {
        url = target;
      }),
      url: vi.fn(() => url),
      locator: vi.fn(() => scalarLocator({ count: vi.fn(async () => 0) })),
    };
    await openBlankProjectChatSurface(page, PROJECT_URL, 5_000, navigation);
    url = SHARED_CONV;
    await expect(openBlankProjectChatSurface(page, PROJECT_URL, 5_000, navigation)).rejects.toThrow(
      'state_light_navigation_budget_exhausted',
    );
  });
  it('replays journal symptom send_observation_deferred/fresh_conversation_url_not_observed', async () => {
    const prompt = 'PROMPT-JOURNAL-DEFER';
    const reply = 'JOURNAL-OK';
    let sent = false;
    let url = PROJECT_URL;
    let observationIndex = 0;
    const snapshotFrames = readyTurnObservationFrames(prompt, reply).map((messages, index) => ({
      messages,
      generating: index < 2,
    }));

    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
      innerText: vi.fn(async () => (sent ? '' : prompt)),
      textContent: vi.fn(async () => (sent ? '' : prompt)),
      press: vi.fn(async () => { sent = true; }),
    });
    const sendButton = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => { sent = true; }),
    });

    const page: any = {
      __fakeBrowserGptPage: true,
      goto: vi.fn(async (target: string) => { url = target; }),
      url: vi.fn(() => url),
      isClosed: vi.fn(() => false),
      waitForTimeout: vi.fn(async (ms: number) => { mocks.nowMs += ms; }),
      close: vi.fn(async () => undefined),
      getByText: vi.fn(() => scalarLocator()),
      getByRole: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return sendButton;
        if (matchesNewChatControlSelector(selector)) {
          return scalarLocator({ count: vi.fn(async () => 0) });
        }
        if (selector === MESSAGE_NODE_SELECTOR) {
          if (!sent) return collectionLocator([]);
          const frame = snapshotFrames[Math.min(observationIndex, snapshotFrames.length - 1)]!;
          observationIndex++;
          return collectionLocator(frame.messages, frame.generating);
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          const frame = snapshotFrames[Math.min(observationIndex - 1, snapshotFrames.length - 1)]!;
          const last = frame.messages.at(-1);
          if (last?.finalActionInTurnContainer) return messageLocator(last);
          return scalarLocator({ count: vi.fn(async () => 0) });
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          const frame = snapshotFrames[Math.min(observationIndex - 1, snapshotFrames.length - 1)]!;
          return collectionLocator(
            frame.messages.filter((message: StateLightTestMessage) => message.role === 'assistant'),
            frame.generating,
          );
        }
        if (selector.includes(STOP_BUTTON_TESTID)) return scalarLocator();
        return scalarLocator();
      }),
    };

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, '/tmp/journal-defer-replay.txt');

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.result.incidents).toContain('send_observation_deferred');
    expect(outcome.result.state).not.toBe('send_failed');
  });

});
