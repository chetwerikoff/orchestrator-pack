import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
  failNextObservationMutationRmdir: false,
  failNextObservationMutationRename: null as 'before' | 'after' | null,
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
    linkSync: actual.linkSync,
    rmdirSync: (path: any, options?: any) => {
      if (
        mocks.failNextObservationMutationRmdir
        && /state-light-turn-observation-[0-9a-f]{64}\.slot$/u.test(String(path))
      ) {
        mocks.failNextObservationMutationRmdir = false;
        const error = new Error('injected_observation_mutation_retirement_failure') as NodeJS.ErrnoException;
        error.code = 'ENOTEMPTY';
        throw error;
      }
      return actual.rmdirSync(path, options);
    },
    renameSync: (source: any, target: any) => {
      const isMutationInstall = /\.state-light-turn-observation-[0-9a-f]{64}\.[^/]+\.tmp$/u.test(String(source))
        && /state-light-turn-observation-[0-9a-f]{64}\.slot$/u.test(String(target));
      const mode = isMutationInstall ? mocks.failNextObservationMutationRename : null;
      if (!mode) return actual.renameSync(source, target);
      mocks.failNextObservationMutationRename = null;
      if (mode === 'before') {
        const error = new Error('injected_observation_mutation_install_before_rename') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      actual.renameSync(source, target);
      const error = new Error('injected_observation_mutation_install_after_rename') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    },
  };
});

vi.mock('./browser-session.ts', () => {
  const session = createBrowserSessionModuleMock(mocks);
  return Object.assign(session, {
    abandonLatePageHandle: vi.fn(async (page: { close: () => Promise<void> }) => {
      if (mocks.cleanupOutcome !== 'confirmed') return 'unconfirmed' as const;
      await page.close();
      return 'confirmed' as const;
    }),
  });
});
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
  const selectors = await import('./product-page-selectors.ts');
  return {
    ...mock,
    ...selectors,
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
  type StateLightTestSnapshot,
} from './state-light-turn.test-fixtures.ts';
import { classifyPageObservation, classifySendLandingEvidence, runStateLightTurn } from './state-light-turn.ts';
import { readStateLightTurnObservation } from './state-light-turn-observation.ts';
import {
  EXPLICIT_CANCELLATION_AUTHORITY,
  readRecoveryAuthoritativeUserMessages,
  stopOwnedGeneration,
} from './state-light-cancellation.ts';
import * as uiAdapter from './ui-adapter.ts';
import {
  ASSISTANT_MESSAGE_SELECTOR,
  ASSISTANT_TURN_ANCESTOR_XPATH,
  COMPOSER_SELECTOR,
  matchesNewChatControlSelector,
  matchesStopButtonSelector,
  MESSAGE_NODE_SELECTOR,
  SEND_BUTTON_SELECTOR,
  STOP_BUTTON_TESTID,
  USER_MESSAGE_SELECTOR,
} from './product-page-selectors.ts';
import {
  acquireStateLightNewChatSendSlot,
  newChatSendSlotEnabled,
  isBlankProjectSurfaceUrl,
  openBlankProjectChatSurface,
  prepareStateLightFreshConversation,
  projectConversationPrefix,
  navigateToProjectConversationIfNeeded,
  ownedConversationIdentityMatches,
  readProjectConversationUrl,
  projectSurfaceUrlsEquivalent,
  readStateLightAdvisoryWall,
  recordStateLightAdvisoryWall,
  releaseStateLightFreshConversationClaim,
  releaseStateLightNewChatSendSlot,
  StateLightNavigationCounter,
  STATE_LIGHT_ADVISORY_WALL_TTL_MS,
  STATE_LIGHT_MAX_NAVIGATIONS_PER_INVOCATION,
  tryClaimStateLightFreshConversation,
  verifyStateLightSendSlotOwnerFence,
  verifyStateLightFreshClaimOwnerFence,
  STATE_LIGHT_SEND_SLOT_TTL_MS,
  STATE_LIGHT_PASSIVE_FRESH_CLAIM_TTL_MS,
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

function makeLoserPage(prompt: string, reply: string, onSend?: () => void) {
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
      onSend?.();
    }),
  });
  const sendButton = scalarLocator({
    count: vi.fn(async () => 1),
    click: vi.fn(async () => {
      sends++;
      sent = true;
      url = sends === 1 ? SHARED_CONV : LOSER_CONV;
      onSend?.();
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

async function runNewChatTurn(
  page: any,
  outputPath: string,
  timeoutMs = '5000',
  invocationId = randomUUID(),
) {
  enqueueBrowserForTurn(mocks, page);
  return runStateLightTurnWithStdoutCapture(runStateLightTurn, [
    ...STATE_LIGHT_TURN_BASE_ARGV,
    '--invocation-id', invocationId,
    '--output', outputPath,
    '--new-chat',
    '--project-url', PROJECT_URL,
    '--timeout-ms', timeoutMs,
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
    mocks.failNextObservationMutationRmdir = false;
    mocks.verifyProfile.mockReset();
    mocks.verifyProfile.mockResolvedValue({ state: 'verified' });
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

  it('proceeds through its owned page when a prior invocation recorded an unexpired wall', async () => {
    const profileKey = 'collision-profile';
    recordStateLightAdvisoryWall(profileKey, 'rate_limit', 'rate_limit_detected', 'prior-invocation');

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-LOSER'));
    const loser = makeLoserPage('PROMPT-LOSER', 'LOSER-OK');
    const outcome = await runNewChatTurn(loser.page, '/tmp/advisory.txt');

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'ok',
      cause: 'completed_page_only',
      send_count: 1,
    });
    expect(outcome.result.goto_count).toBeGreaterThan(0);
    expect(loser.page.goto).toHaveBeenCalled();
  });

  it('regresses if a stored wall becomes an invocation refusal again', async () => {
    const profileKey = 'collision-profile';
    recordStateLightAdvisoryWall(profileKey, 'quota', 'quota_detected', 'prior-invocation', 1_000_000, mocks.nowMs);

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-QUOTA'));
    const page = makeLoserPage('PROMPT-QUOTA', 'QUOTA-OK');
    const outcome = await runNewChatTurn(page.page, '/tmp/advisory-regression.txt');

    expect(outcome.code).toBe(0);
    expect(outcome.result.state).toBe('ok');
    expect(outcome.result.send_count).toBe(1);
    expect(readStateLightAdvisoryWall(profileKey)).toMatchObject({
      state: 'quota',
      cause: 'quota_detected',
    });
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

  it('does not bind a delayed fresh-chat URL until that surface proves the owned marker', async () => {
    const prompt = 'PROMPT-LATE-BIND';
    const reply = 'OWNED FINAL';
    const output = join(stateDir, 'late-bind.txt');
    const invocationId = randomUUID();
    let sent = false;
    let composerText = '';
    let surface: 'project' | 'foreign' | 'owned' = 'project';
    let ownedObservationIndex = 0;
    const waiterDeadline = mocks.nowMs + 1_000;
    const ownedFrames = readyTurnObservationFrames(prompt, reply).map((messages, index) => ({
      messages,
      generating: index < 2,
    }));
    const foreignMessages: StateLightTestMessage[] = [
      { role: 'user', text: 'FOREIGN PROMPT' },
      { role: 'assistant', text: 'FOREIGN ANSWER', finalAction: true, finalActionInTurnContainer: true },
    ];
    let activeMessages: StateLightTestMessage[] = [];
    let activeGenerating = false;

    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async (value: string) => { composerText = value; }),
      innerText: vi.fn(async () => composerText),
      textContent: vi.fn(async () => composerText),
      press: vi.fn(async () => { sent = true; }),
    });
    const sendButton = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => { sent = true; }),
    });
    const page: any = {
      __fakeBrowserGptPage: true,
      goto: vi.fn(async (target: string) => {
        if (target === PROJECT_URL) surface = 'project';
        else if (target === LOSER_CONV) surface = 'foreign';
        else if (target === SHARED_CONV) surface = 'owned';
      }),
      url: vi.fn(() => {
        if (!sent || mocks.nowMs < waiterDeadline) return PROJECT_URL;
        if (surface === 'project') surface = 'foreign';
        return surface === 'foreign' ? LOSER_CONV : SHARED_CONV;
      }),
      isClosed: vi.fn(() => false),
      waitForTimeout: vi.fn(async (ms: number) => {
        const before = mocks.nowMs;
        mocks.nowMs += ms;
        if (sent && before >= waiterDeadline && surface === 'foreign') surface = 'owned';
      }),
      close: vi.fn(async () => undefined),
      getByText: vi.fn(() => scalarLocator()),
      getByRole: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return sendButton;
        if (matchesNewChatControlSelector(selector)) return scalarLocator({ count: vi.fn(async () => 0) });
        if (selector === MESSAGE_NODE_SELECTOR) {
          if (!sent) return collectionLocator([]);
          if (surface === 'foreign') {
            activeMessages = foreignMessages;
            activeGenerating = false;
          } else {
            const frame = ownedFrames[Math.min(ownedObservationIndex, ownedFrames.length - 1)]!;
            ownedObservationIndex++;
            activeMessages = frame.messages;
            activeGenerating = frame.generating;
          }
          return collectionLocator(activeMessages, activeGenerating);
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          const last = activeMessages.at(-1);
          if (last?.finalActionInTurnContainer) return messageLocator(last, activeGenerating);
          return scalarLocator({ count: vi.fn(async () => 0) });
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          return collectionLocator(
            activeMessages.filter((message: StateLightTestMessage) => message.role === 'assistant'),
            activeGenerating,
          );
        }
        if (selector.includes(STOP_BUTTON_TESTID)) return scalarLocator();
        return scalarLocator();
      }),
    };

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output, '1000', invocationId);

    expect(outcome, JSON.stringify(outcome)).toMatchObject({ code: 0 });
    expect(outcome.result).toMatchObject({
      state: 'ok',
      send_count: 1,
      conversation_id: SHARED_CONV,
    });
    expect(readStateLightTurnObservation('collision-profile', invocationId)).toMatchObject({
      phase: 'harvested',
      conversation_url: SHARED_CONV,
    });
    expect(readFileSync(output, 'utf8')).toBe(reply);
    expect(composerText).toContain(prompt);
  });

  it('surfaces committed post-send observation retirement cleanup without resend', async () => {
    const prompt = 'PROMPT-CLEANUP-POST-SEND';
    const invocationId = randomUUID();
    const output = join(stateDir, 'cleanup-post-send.txt');
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED', () => {
      mocks.failNextObservationMutationRmdir = true;
    });

    const outcome = await runNewChatTurn(turn.page, output, '5000', invocationId);

    expect(outcome.result).toMatchObject({
      state: 'driver_error',
      cause: 'observation_mutation_retirement_cleanup_required',
      send_count: 1,
      retirement_cleanup_required: true,
    });
    expect(outcome.result.incidents).toContain('observation_mutation_retirement_cleanup_required');
    expect(turn.getSends()).toBe(1);
    expect(readStateLightTurnObservation('collision-profile', invocationId)).toMatchObject({
      phase: 'sent_unbound',
      send_witness: 'numeric_send_count',
    });
  });

  it('surfaces committed pre-send not_sent retirement cleanup without changing transport truth', async () => {
    const invocationId = randomUUID();
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-CLEANUP-PRE-SEND'));
    mocks.verifyProfile.mockImplementationOnce(async () => {
      mocks.failNextObservationMutationRmdir = true;
      return { state: 'mismatch', cause: 'profile_mismatch' };
    });
    const page = makeLoserPage('PROMPT-CLEANUP-PRE-SEND', 'UNREACHED');

    const outcome = await runNewChatTurn(
      page.page,
      join(stateDir, 'cleanup-pre-send.txt'),
      '5000',
      invocationId,
    );

    expect(outcome.result).toMatchObject({
      state: 'profile_mismatch',
      cause: 'profile_mismatch',
      send_count: 0,
      retirement_cleanup_required: true,
    });
    expect(outcome.result.incidents).toContain('observation_mutation_retirement_cleanup_required');
    expect(page.getSends()).toBe(0);
    expect(readStateLightTurnObservation('collision-profile', invocationId)).toMatchObject({
      phase: 'not_sent',
      send_witness: 'numeric_send_count',
    });
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

  it('navigates onto a materialized project conversation url when the owned page lags', async () => {
    const conversation = `${PROJECT_URL}/c/33333333-3333-4333-8333-333333333333`;
    const navigation = new StateLightNavigationCounter();
    let url = PROJECT_URL;
    const page = {
      goto: vi.fn(async (target: string) => { url = target; }),
      url: vi.fn(() => url),
    };
    await navigateToProjectConversationIfNeeded(page, conversation, navigation, 5_000);
    expect(page.goto).toHaveBeenCalledWith(conversation, expect.any(Object));
    expect(url).toBe(conversation);
  });

  it('reads project conversation urls only when a conversation uuid is present', () => {
    const conversation = `${PROJECT_URL}/c/33333333-3333-4333-8333-333333333333`;
    expect(readProjectConversationUrl({ url: () => conversation }, PROJECT_URL)).toBe(conversation);
    expect(readProjectConversationUrl({ url: () => PROJECT_URL }, PROJECT_URL)).toBeUndefined();
  });

  it('returns fresh_conversation_landing_mismatch when url and owned prompt never materialize', async () => {
    const prompt = 'PROMPT-STUCK-FRESH';
    let sent = false;
    let url = PROJECT_URL;
    const staleAssistant: StateLightTestSnapshot = {
      messages: [{ role: 'assistant', text: 'foreign', finalAction: true, finalActionInTurnContainer: true }],
      generating: false,
    };
    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
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
          return collectionLocator(staleAssistant.messages, staleAssistant.generating);
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          return messageLocator(staleAssistant.messages[0]!, staleAssistant.generating);
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          return collectionLocator(staleAssistant.messages);
        }
        if (selector.includes(STOP_BUTTON_TESTID)) return scalarLocator();
        return scalarLocator();
      }),
    };

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, '/tmp/fresh-landing-mismatch.txt', '3000');

    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'fresh_conversation_landing_mismatch',
      send_count: 1,
    });
    expect(outcome.result.incidents).toContain('conversation_landing_mismatch');
    expect(outcome.result.poll_count).toBeLessThan(20);
  });

});

describe('state-light ownership TTL and owner fences (#1145)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'slt-ttl-'));
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = stateDir;
    disableSendSlotForTest();
    mocks.browserQueue.length = 0;
    mocks.cleanupOutcome = 'confirmed';
    mocks.failNextObservationMutationRmdir = false;
    mocks.verifyProfile.mockReset();
    mocks.verifyProfile.mockResolvedValue({ state: 'verified' });
    mocks.nowMs = 1_700_000_000_000;
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

  it('accepts timeout-ms through 1_800_000 and rejects larger values before effects', async () => {
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-MAX'));
    const solo = makeLoserPage('PROMPT-MAX', 'MAX-OK');
    const okOutcome = await runNewChatTurn(solo.page, '/tmp/max-timeout-ok.txt', '1800000');
    expect(okOutcome.result.send_count).toBe(1);

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-OVER'));
    const overOutcome = await runNewChatTurn(solo.page, '/tmp/max-timeout-over.txt', '1800001');
    expect(overOutcome.result).toMatchObject({
      state: 'input_invalid',
      cause: 'timeout_ms_exceeds_maximum',
      send_count: 0,
    });
    expect(overOutcome.result.goto_count).toBe(0);
  });

  it('treats 2x timeout-ms as a decision threshold that may return after an awaited pass', async () => {
    const prompt = 'PROMPT-THRESHOLD';
    const reply = 'THRESHOLD-OK';
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
          const frame = snapshotFrames[Math.min(Math.max(observationIndex - 1, 0), snapshotFrames.length - 1)]!;
          const last = frame.messages.at(-1);
          if (last?.finalActionInTurnContainer) return messageLocator(last);
          return scalarLocator({ count: vi.fn(async () => 0) });
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          const frame = snapshotFrames[Math.min(Math.max(observationIndex - 1, 0), snapshotFrames.length - 1)]!;
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
    const startedAt = mocks.nowMs;
    const outcome = await runNewChatTurn(page, '/tmp/threshold-after-2x.txt', '1000');
    expect(outcome.code).toBe(0);
    expect(mocks.nowMs).toBeGreaterThanOrEqual(startedAt + 2000);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
  });

  it('recovers expired and corrupt ownership artifacts through bounded exclusive create', async () => {
    clearSendSlotDisableEnv();
    const profileKey = 'collision-profile';
    const { writeFileSync } = await import('node:fs');
    const { sha256 } = await import('./storage-common.ts');

    await acquireStateLightNewChatSendSlot(profileKey, 'stale-owner', 5_000);
    const slotPath = join(stateDir, profileKey, 'locks', 'state-light-new-chat-send.slot');
    writeFileSync(slotPath, `${JSON.stringify({
      schema: 'state-light-new-chat-send-slot/v1',
      version: 1,
      invocation_id: 'expired-foreign',
      pid: 999_999,
      acquired_at: new Date(mocks.nowMs - STATE_LIGHT_SEND_SLOT_TTL_MS - 1).toISOString(),
      expires_at: new Date(mocks.nowMs - 1).toISOString(),
    })}\n`);

    await acquireStateLightNewChatSendSlot(profileKey, 'successor', 5_000);
    expect(verifyStateLightSendSlotOwnerFence(profileKey, 'successor')).toBe('valid');
    releaseStateLightNewChatSendSlot(profileKey, 'successor');

    const claimDir = join(stateDir, profileKey, 'state-light-fresh-claims');
    mkdirSync(claimDir, { recursive: true });
    const claimPath = join(claimDir, `${sha256(SHARED_CONV)}.json`);
    writeFileSync(claimPath, '{not-json');
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'successor-claim', 5_000)).toBe('claimed');
    writeFileSync(claimPath, '{}\n');
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'successor-claim-schema-invalid', 5_000)).toBe('claimed');
    releaseStateLightFreshConversationClaim(profileKey, SHARED_CONV, 'successor-claim-schema-invalid', 5_000);
    writeFileSync(claimPath, `${JSON.stringify({
      schema: 'state-light-fresh-claim/v1',
      version: 1,
      invocation_id: 'expired-foreign',
      conversation_id: SHARED_CONV,
      pid: 999_999,
      claimed_at: new Date(mocks.nowMs - STATE_LIGHT_PASSIVE_FRESH_CLAIM_TTL_MS - 1).toISOString(),
      expires_at: new Date(mocks.nowMs - 1).toISOString(),
    })}\n`);
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'successor-claim-2', 5_000)).toBe('claimed');
    releaseStateLightFreshConversationClaim(profileKey, SHARED_CONV, 'successor-claim-2', 5_000);
  });

  it('emits rollback-readable v1 records with optional expires_at only', async () => {
    clearSendSlotDisableEnv();
    const profileKey = 'collision-profile';
    await acquireStateLightNewChatSendSlot(profileKey, 'writer', 5_000);
    const slotPath = join(stateDir, profileKey, 'locks', 'state-light-new-chat-send.slot');
    const slotRaw = readFileSync(slotPath, 'utf8');
    const slot = JSON.parse(slotRaw);
    expect(slot).toMatchObject({
      schema: 'state-light-new-chat-send-slot/v1',
      version: 1,
      invocation_id: 'writer',
      pid: expect.any(Number),
      acquired_at: expect.any(String),
      expires_at: expect.any(String),
    });
    releaseStateLightNewChatSendSlot(profileKey, 'writer');

    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'writer', 5_000)).toBe('claimed');
    const claimPath = join(
      stateDir,
      profileKey,
      'state-light-fresh-claims',
      (await import('./storage-common.ts')).sha256(SHARED_CONV) + '.json',
    );
    const claim = JSON.parse(readFileSync(claimPath, 'utf8'));
    expect(claim.schema).toBe('state-light-fresh-claim/v1');
    expect(claim.version).toBe(1);
    expect(claim.expires_at).toEqual(expect.any(String));
    const legacyShaped = {
      schema: 'state-light-fresh-claim/v1',
      version: 1,
      invocation_id: 'legacy',
      conversation_id: SHARED_CONV,
      pid: process.pid,
      claimed_at: new Date(mocks.nowMs).toISOString(),
    };
    expect(legacyShaped.invocation_id).toBe('legacy');
    releaseStateLightFreshConversationClaim(profileKey, SHARED_CONV, 'writer', 5_000);
  });

  it('preserves a successor claim present before the owner final read', () => {
    const profileKey = 'collision-profile';
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'owner', 5_000)).toBe('claimed');
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'successor', 5_000)).toBe('contended');
    releaseStateLightFreshConversationClaim(profileKey, SHARED_CONV, 'owner', 5_000);
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'successor', 5_000)).toBe('claimed');
    releaseStateLightFreshConversationClaim(profileKey, SHARED_CONV, 'successor', 5_000);
  });

  it('forfeits send-slot authority after expiry so the stale owner cannot dispatch', async () => {
    clearSendSlotDisableEnv();
    const profileKey = 'collision-profile';
    await acquireStateLightNewChatSendSlot(profileKey, 'expired-owner', 5_000);
    expect(verifyStateLightSendSlotOwnerFence(profileKey, 'expired-owner')).toBe('valid');
    mocks.nowMs += STATE_LIGHT_SEND_SLOT_TTL_MS + 1;
    expect(verifyStateLightSendSlotOwnerFence(profileKey, 'expired-owner')).toBe('lost');
    await acquireStateLightNewChatSendSlot(profileKey, 'successor', 5_000);
    expect(verifyStateLightSendSlotOwnerFence(profileKey, 'successor')).toBe('valid');
    releaseStateLightNewChatSendSlot(profileKey, 'successor');
  });

  it('forfeits fresh-claim authority after expiry before continuation or publication', async () => {
    const profileKey = 'collision-profile';
    const { writeFileSync } = await import('node:fs');
    const { sha256 } = await import('./storage-common.ts');
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'owner', 5_000)).toBe('claimed');
    const claimPath = join(stateDir, profileKey, 'state-light-fresh-claims', `${sha256(SHARED_CONV)}.json`);
    writeFileSync(claimPath, `${JSON.stringify({
      schema: 'state-light-fresh-claim/v1',
      version: 1,
      invocation_id: 'owner',
      conversation_id: SHARED_CONV,
      pid: process.pid,
      claimed_at: new Date(mocks.nowMs).toISOString(),
      expires_at: new Date(mocks.nowMs - 1).toISOString(),
    })}\n`);
    expect(verifyStateLightFreshClaimOwnerFence(profileKey, SHARED_CONV, 'owner', 5_000)).toBe('lost');
    releaseStateLightFreshConversationClaim(profileKey, SHARED_CONV, 'owner', 5_000);
  });
});


describe('Issue #1283 production runStateLightTurn recovery integration', () => {
  let integrationStateDir: string;

  beforeEach(() => {
    integrationStateDir = mkdtempSync(join(tmpdir(), 'slt-recovery-'));
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = integrationStateDir;
    disableSendSlotForTest();
    mocks.browserQueue.length = 0;
    mocks.cleanupOutcome = 'confirmed';
    mocks.failNextObservationMutationRmdir = false;
    mocks.verifyProfile.mockReset();
    mocks.verifyProfile.mockResolvedValue({ state: 'verified' });
    mocks.nowMs = 10_000;
    mocks.productStatusText.mockReset();
    mocks.productStatusText.mockResolvedValue({ text: '', composer: true });
    mocks.readStableInput.mockReset();
    vi.spyOn(Date, 'now').mockImplementation(() => mocks.nowMs);
  });

  afterEach(() => {
    delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
    clearSendSlotDisableEnv();
    rmSync(integrationStateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function browserWithPages(
    newPage: any,
    pages: any[],
    connected: () => boolean,
  ) {
    const context = {
      newPage: vi.fn(async () => newPage),
      pages: vi.fn(() => pages),
    };
    return {
      contexts: vi.fn(() => [context]),
      isConnected: vi.fn(connected),
      close: vi.fn(async () => undefined),
    };
  }

  function runProductionNewChat(outputPath: string, timeoutMs: string) {
    return runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--invocation-id', randomUUID(),
      '--output', outputPath,
      '--new-chat',
      '--project-url', PROJECT_URL,
      '--timeout-ms', timeoutMs,
      '--poll-ms', '1',
    ]);
  }

  it('reconnects after post-send browser loss, claims the exact recovered conversation, and never resends or mutates a foreign page', async () => {
    const prompt = 'PROMPT-RECOVER';
    const reply = 'RECOVERED FINAL';
    const output = join(integrationStateDir, 'recovered.txt');
    let sends = 0;
    let lost = false;
    let composerText = '';
    let initialUrl = PROJECT_URL;

    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async (value: string) => { composerText = value; }),
      innerText: vi.fn(async () => composerText),
      textContent: vi.fn(async () => composerText),
      press: vi.fn(async () => { sends += 1; initialUrl = SHARED_CONV; lost = true; }),
    });
    const sendButton = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => { sends += 1; initialUrl = SHARED_CONV; lost = true; }),
    });
    const initialClose = vi.fn(async () => undefined);
    const initialPage: any = {
      __fakeBrowserGptPage: true,
      goto: vi.fn(async (target: string) => { initialUrl = target; }),
      url: vi.fn(() => initialUrl),
      isClosed: vi.fn(() => lost),
      waitForTimeout: vi.fn(async (ms: number) => { mocks.nowMs += ms; }),
      close: initialClose,
      getByText: vi.fn(() => scalarLocator()),
      getByRole: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return sendButton;
        if (matchesNewChatControlSelector(selector)) return scalarLocator({ count: vi.fn(async () => 0) });
        if (selector === MESSAGE_NODE_SELECTOR) return collectionLocator([]);
        if (selector === ASSISTANT_MESSAGE_SELECTOR) return collectionLocator([]);
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          return scalarLocator({ count: vi.fn(async () => 0) });
        }
        if (selector.includes(STOP_BUTTON_TESTID)) return scalarLocator();
        return scalarLocator();
      }),
    };

    const recoveredMessages = (): StateLightTestMessage[] => [
      { role: 'user', text: composerText },
      {
        role: 'assistant',
        text: reply,
        finalAction: true,
        finalActionInTurnContainer: true,
      },
    ];
    const recoveredClose = vi.fn(async () => undefined);
    const recoveredPage: any = {
      __fakeBrowserGptPage: true,
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => SHARED_CONV),
      isClosed: vi.fn(() => false),
      waitForTimeout: vi.fn(async (ms: number) => { mocks.nowMs += ms; }),
      close: recoveredClose,
      getByText: vi.fn(() => scalarLocator()),
      getByRole: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === MESSAGE_NODE_SELECTOR) return collectionLocator(recoveredMessages(), false);
        if (selector === USER_MESSAGE_SELECTOR) {
          return collectionLocator(recoveredMessages().filter((message) => message.role === 'user'), false);
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          return collectionLocator(
            recoveredMessages().filter((message: StateLightTestMessage) => message.role === 'assistant'),
            false,
          );
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          const last = recoveredMessages().at(-1)!;
          return messageLocator(last, false);
        }
        if (selector.includes(STOP_BUTTON_TESTID)) return scalarLocator();
        return scalarLocator();
      }),
    };

    const foreignStop = vi.fn(async () => undefined);
    const foreignClose = vi.fn(async () => undefined);
    const foreignMessages: StateLightTestMessage[] = [
      { role: 'user', text: 'FOREIGN PROMPT' },
      { role: 'assistant', text: 'FOREIGN ANSWER', finalAction: true },
    ];
    const foreignPage: any = {
      __fakeBrowserGptPage: true,
      url: vi.fn(() => LOSER_CONV),
      isClosed: vi.fn(() => false),
      close: foreignClose,
      locator: vi.fn((selector: string) => {
        if (selector === MESSAGE_NODE_SELECTOR) return collectionLocator(foreignMessages, false);
        if (selector === USER_MESSAGE_SELECTOR) {
          return collectionLocator(foreignMessages.filter((message) => message.role === 'user'), false);
        }
        if (selector.includes(STOP_BUTTON_TESTID)) {
          return scalarLocator({ count: vi.fn(async () => 1), click: foreignStop });
        }
        return scalarLocator();
      }),
      getByRole: vi.fn(() => scalarLocator()),
      getByText: vi.fn(() => scalarLocator()),
    };

    expect(await readRecoveryAuthoritativeUserMessages(recoveredPage)).toMatchObject({ incomplete: false });
    expect(await readRecoveryAuthoritativeUserMessages(foreignPage)).toMatchObject({ incomplete: false });

    const initialBrowser = browserWithPages(initialPage, [initialPage], () => !lost);
    const recoveredBrowser = browserWithPages(recoveredPage, [foreignPage, recoveredPage], () => true);
    mocks.browserQueue.push(initialBrowser, recoveredBrowser);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));

    const outcome = await runProductionNewChat(output, '50');

    expect(outcome, JSON.stringify(outcome)).toMatchObject({ code: 0 });
    expect(outcome.result).toMatchObject({
      state: 'ok',
      cause: 'completed_page_only',
      send_count: 1,
      conversation_id: SHARED_CONV,
    });
    expect(outcome.result.output).toEqual({
      byte_length: 15,
      sha256: '574877027739d7ff52e587b7003cf11b863f623083bb43607417c82cc38cfd8b',
    });
    expect(sends).toBe(1);
    expect(mocks.browserQueue).toHaveLength(0);
    expect(initialClose).not.toHaveBeenCalled();
    expect(foreignStop).not.toHaveBeenCalled();
    expect(foreignClose).not.toHaveBeenCalled();
  });

  it('terminates observation exhaustion truthfully after one send without stopping and preserves every tab', async () => {
    const prompt = 'PROMPT-EXHAUST';
    const output = join(integrationStateDir, 'exhausted.txt');
    let sends = 0;
    let sent = false;
    let url = PROJECT_URL;
    let composerText = '';
    let ownedStopped = false;
    const ownedStop = vi.fn(async () => { ownedStopped = true; });
    const ownedClose = vi.fn(async () => undefined);
    const foreignStop = vi.fn(async () => undefined);
    const foreignClose = vi.fn(async () => undefined);
    const waitingMessages = (): StateLightTestMessage[] => [
      { role: 'user', text: composerText },
      { role: 'assistant', text: 'working', inProgress: true },
    ];

    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async (value: string) => { composerText = value; }),
      innerText: vi.fn(async () => composerText),
      textContent: vi.fn(async () => composerText),
      press: vi.fn(async () => { sends += 1; sent = true; url = SHARED_CONV; }),
    });
    const sendButton = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => { sends += 1; sent = true; url = SHARED_CONV; }),
    });
    const ownedPage: any = {
      __fakeBrowserGptPage: true,
      goto: vi.fn(async (target: string) => { url = target; }),
      url: vi.fn(() => url),
      isClosed: vi.fn(() => false),
      waitForTimeout: vi.fn(async (ms: number) => { mocks.nowMs += Math.max(1, ms); }),
      close: ownedClose,
      getByText: vi.fn(() => scalarLocator()),
      getByRole: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return sendButton;
        if (matchesNewChatControlSelector(selector)) return scalarLocator({ count: vi.fn(async () => 0) });
        if (selector === MESSAGE_NODE_SELECTOR) return sent
          ? collectionLocator(waitingMessages(), true)
          : collectionLocator([]);
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          return sent
            ? collectionLocator(
              waitingMessages().filter((message: StateLightTestMessage) => message.role === 'assistant'),
              true,
            )
            : collectionLocator([]);
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          const last = waitingMessages().at(-1)!;
          return sent ? messageLocator(last, true) : scalarLocator({ count: vi.fn(async () => 0) });
        }
        if (matchesStopButtonSelector(selector)) {
          return scalarLocator({
            count: vi.fn(async () => sent && !ownedStopped ? 1 : 0),
            click: ownedStop,
          });
        }
        return scalarLocator();
      }),
    };

    const foreignPage: any = {
      __fakeBrowserGptPage: true,
      url: vi.fn(() => LOSER_CONV),
      isClosed: vi.fn(() => false),
      close: foreignClose,
      locator: vi.fn((selector: string) => matchesStopButtonSelector(selector)
        ? scalarLocator({ count: vi.fn(async () => 1), click: foreignStop })
        : scalarLocator()),
      getByRole: vi.fn(() => scalarLocator()),
      getByText: vi.fn(() => scalarLocator()),
    };

    const stopProbeClick = vi.fn(async () => undefined);
    const stopProbePage = {
      isClosed: vi.fn(() => false),
      locator: vi.fn((selector: string) => matchesStopButtonSelector(selector)
        ? scalarLocator({
          count: vi.fn()
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(0),
          click: stopProbeClick,
        })
        : scalarLocator()),
    };
    expect(await stopOwnedGeneration(stopProbePage, EXPLICIT_CANCELLATION_AUTHORITY))
      .toBe('confirmed');
    expect(stopProbeClick).toHaveBeenCalledTimes(1);

    mocks.browserQueue.push(browserWithPages(ownedPage, [ownedPage, foreignPage], () => true));
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));

    const outcome = await runProductionNewChat(output, '5');

    expect(outcome.result).toMatchObject({
      state: 'no_reply',
      cause: 'observation_exhausted_no_resend',
      send_count: 1,
      cleanup: 'skipped',
    });
    expect(outcome.result.incidents).toContain('observation_exhausted');
    expect(ownedStop, JSON.stringify(outcome)).not.toHaveBeenCalled();
    expect(outcome.result.incidents).toEqual([
      'observation_exhausted',
      'owned_generation_stop_not_attempted_authority_absent',
    ]);
    expect(sends).toBe(1);
    expect(foreignStop).not.toHaveBeenCalled();
    expect(ownedClose).not.toHaveBeenCalled();
    expect(foreignClose).not.toHaveBeenCalled();
  });
});

describe('Issue #1430 mutation-generation crash and restart coverage', () => {
  it('recovers a generation installed before an owner crash and retires it safely', async () => {
    const { randomUUID } = await import('node:crypto');
    const {
      acquireObservationMutation,
      admitStateLightTurnObservation,
      observationRecordKey,
      releaseObservationMutation,
    } = await import('./state-light-turn-observation.ts');
    const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { profileDirs } = await import('./storage-common.ts');

    const root = mkdtempSync(join(tmpdir(), 'slt-mutation-crash-'));
    const priorStateDir = process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = root;
    const profileKey = 'mutation-crash-profile';
    const invocationId = randomUUID();
    const marker = `OPKTURNV1${'12'.repeat(16)}`;

    try {
      admitStateLightTurnObservation({ profileKey, invocationId, marker });
      const recordKey = observationRecordKey(invocationId);
      const slotPath = join(
        profileDirs(profileKey).locks,
        `state-light-turn-observation-${recordKey}.slot`,
      );

      mocks.failNextObservationMutationRename = 'before';
      expect(() => acquireObservationMutation(profileKey, invocationId))
        .toThrow('injected_observation_mutation_install_before_rename');
      expect(existsSync(slotPath)).toBe(false);

      mocks.failNextObservationMutationRename = 'after';
      expect(() => acquireObservationMutation(profileKey, invocationId))
        .toThrow('injected_observation_mutation_install_after_rename');
      const incumbentChild = readdirSync(slotPath)[0];
      expect(incumbentChild).toMatch(/^owner-/u);
      const incumbentPath = join(slotPath, incumbentChild);
      const incumbent = JSON.parse(readFileSync(incumbentPath, 'utf8')) as { owner: string; pid: number };
      writeFileSync(incumbentPath, `${JSON.stringify({ ...incumbent, pid: 999999 })}\n`);

      const restarted = acquireObservationMutation(profileKey, invocationId);
      expect(restarted.owner).not.toBe(incumbent.owner);
      expect(releaseObservationMutation(restarted)).toBe(true);
      expect(existsSync(slotPath)).toBe(false);

      const retiring = acquireObservationMutation(profileKey, invocationId);
      writeFileSync(join(retiring.slotPath, 'retirement-crash-blocker'), 'block');
      mocks.failNextObservationMutationRmdir = true;
      expect(releaseObservationMutation(retiring)).toBe(false);
      expect(existsSync(retiring.slotPath)).toBe(true);
      rmSync(join(retiring.slotPath, 'retirement-crash-blocker'));
      mocks.failNextObservationMutationRmdir = false;
      const afterRetirement = acquireObservationMutation(profileKey, invocationId);
      expect(afterRetirement.owner).not.toBe(retiring.owner);
      expect(releaseObservationMutation(afterRetirement)).toBe(true);
      expect(existsSync(retiring.slotPath)).toBe(false);
    } finally {
      if (priorStateDir === undefined) delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
      else process.env.CHATGPT_BROWSER_TURN_STATE_DIR = priorStateDir;
      mocks.failNextObservationMutationRename = null;
      mocks.failNextObservationMutationRmdir = false;
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('Issue #1752 production liveness regressions', () => {
  let livenessStateDir: string;

  beforeEach(() => {
    livenessStateDir = mkdtempSync(join(tmpdir(), 'slt-liveness-'));
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = livenessStateDir;
    process.env.OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS = '200';
    process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS = '10';
    process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS = '30';
    disableSendSlotForTest();
    mocks.browserQueue.length = 0;
    mocks.cleanupOutcome = 'confirmed';
    mocks.verifyProfile.mockReset();
    mocks.verifyProfile.mockResolvedValue({ state: 'verified' });
    mocks.releaseBrowser.mockReset();
    mocks.releaseBrowser.mockResolvedValue(undefined);
    mocks.nowMs = 10_000;
    mocks.productStatusText.mockReset();
    mocks.productStatusText.mockResolvedValue({ text: '', composer: true });
    mocks.readStableInput.mockReset();
    vi.spyOn(Date, 'now').mockImplementation(() => mocks.nowMs);
  });

  afterEach(() => {
    delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
    delete process.env.OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS;
    delete process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS;
    delete process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS;
    clearSendSlotDisableEnv();
    rmSync(livenessStateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function livenessArgv(outputPath: string, timeoutMs = '5000') {
    return [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--invocation-id', randomUUID(),
      '--output', outputPath,
      '--new-chat',
      '--project-url', PROJECT_URL,
      '--timeout-ms', timeoutMs,
      '--poll-ms', '1',
    ];
  }

  function parseRecords(writes: readonly string[]): Array<Record<string, unknown>> {
    return writes
      .flatMap((chunk) => chunk.split('\n'))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('emits healthy heartbeats while profile verification exceeds the recurring idle window', async () => {
    const prompt = 'PROMPT-LIVENESS-PROFILE';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    mocks.verifyProfile.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 45));
      return { state: 'verified' };
    });
    const fake = makeLoserPage(prompt, 'PROFILE-FINAL');
    enqueueBrowserForTurn(mocks, fake.page);

    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const code = await runStateLightTurn(
        livenessArgv(join(livenessStateDir, 'profile.txt')),
        { entryLivenessHeartbeat: true },
      );
      expect(code).toBe(0);
      const records = parseRecords(writes);
      const heartbeats = records.filter((record) => record.schema === 'observation-heartbeat/v1');
      expect(heartbeats.length).toBeGreaterThan(2);
      expect(heartbeats.filter((record) => record.phase === 'admitted_pre_send').length)
        .toBeGreaterThan(2);
      expect(records.at(-1)).toMatchObject({
        schema: 'turn-result/v1',
        state: 'ok',
        send_count: 1,
      });
    } finally {
      stdout.mockRestore();
    }
  });

  it('keeps heartbeats flowing through delayed finalization and stops them before turn-result publication', async () => {
    const prompt = 'PROMPT-LIVENESS-FINALIZE';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const fake = makeLoserPage(prompt, 'FINALIZE-FINAL');
    enqueueBrowserForTurn(mocks, fake.page);

    const writes: string[] = [];
    let releaseStartedAtWrite = -1;
    mocks.releaseBrowser.mockImplementationOnce(async () => {
      releaseStartedAtWrite = writes.length;
      await new Promise((resolve) => setTimeout(resolve, 45));
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const code = await runStateLightTurn(
        livenessArgv(join(livenessStateDir, 'finalize.txt')),
        { entryLivenessHeartbeat: true },
      );
      expect(code).toBe(0);
      expect(releaseStartedAtWrite).toBeGreaterThanOrEqual(0);

      const finalizationRecords = parseRecords(writes.slice(releaseStartedAtWrite));
      expect(finalizationRecords.filter((record) => record.schema === 'observation-heartbeat/v1').length)
        .toBeGreaterThan(2);
      const records = parseRecords(writes);
      expect(records.at(-1)).toMatchObject({
        schema: 'turn-result/v1',
        state: 'ok',
        send_count: 1,
      });

      const terminalWriteCount = writes.length;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(writes).toHaveLength(terminalWriteCount);
    } finally {
      stdout.mockRestore();
    }
  });

  it('times out initial newPage without liveness loss, abandons a late page, and leaves foreign tabs untouched', async () => {
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-LIVENESS-INITIAL'));

    let resolveLatePage!: (page: any) => void;
    const pendingPage = new Promise<any>((resolve) => {
      resolveLatePage = resolve;
    });
    const latePage = {
      close: vi.fn(async () => undefined),
      goto: vi.fn(async () => undefined),
    };
    const foreignPage = {
      close: vi.fn(async () => undefined),
      url: vi.fn(() => 'https://chatgpt.com/c/foreign'),
    };
    const context = {
      newPage: vi.fn(() => pendingPage),
      pages: vi.fn(() => [foreignPage]),
    };
    const browser = {
      contexts: vi.fn(() => [context]),
      isConnected: vi.fn(() => true),
      close: vi.fn(async () => undefined),
    };
    mocks.browserQueue.push(browser);

    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const code = await runStateLightTurn(
        livenessArgv(join(livenessStateDir, 'initial-page.txt'), '45'),
        { entryLivenessHeartbeat: true },
      );
      expect(code).not.toBe(0);
      const records = parseRecords(writes);
      expect(records.filter((record) => record.schema === 'observation-heartbeat/v1').length)
        .toBeGreaterThan(2);
      expect(records.at(-1)).toMatchObject({
        schema: 'turn-result/v1',
        state: 'driver_error',
        cause: 'browser_operation_timeout:new_page',
        send_count: 0,
      });

      resolveLatePage(latePage);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(latePage.close).toHaveBeenCalledTimes(1);
      expect(latePage.goto).not.toHaveBeenCalled();
      expect(foreignPage.close).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });

  it('keeps heartbeats flowing during recovery newPage timeout and abandons its late successor without resend', async () => {
    const prompt = 'PROMPT-LIVENESS-RECOVERY';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));

    let sends = 0;
    let sent = false;
    let lost = false;
    let url = PROJECT_URL;
    let composerText = '';
    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async (value: string) => { composerText = value; }),
      innerText: vi.fn(async () => sent ? '' : composerText),
      textContent: vi.fn(async () => sent ? '' : composerText),
      press: vi.fn(async () => { sends += 1; sent = true; url = SHARED_CONV; }),
    });
    const sendButton = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => { sends += 1; sent = true; url = SHARED_CONV; }),
    });
    const workingMessages = (): StateLightTestMessage[] => [
      { role: 'user', text: composerText },
      { role: 'assistant', text: 'working', inProgress: true },
    ];
    const initialClose = vi.fn(async () => undefined);
    const initialPage: any = {
      __fakeBrowserGptPage: true,
      goto: vi.fn(async (target: string) => { url = target; }),
      url: vi.fn(() => url),
      isClosed: vi.fn(() => lost),
      waitForTimeout: vi.fn(async (ms: number) => { mocks.nowMs += ms; }),
      close: initialClose,
      getByText: vi.fn(() => scalarLocator()),
      getByRole: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return sendButton;
        if (matchesNewChatControlSelector(selector)) return scalarLocator({ count: vi.fn(async () => 0) });
        if (selector === MESSAGE_NODE_SELECTOR) {
          return sent ? collectionLocator(workingMessages(), true) : collectionLocator([]);
        }
        if (selector === USER_MESSAGE_SELECTOR) {
          return sent
            ? collectionLocator(workingMessages().filter((message) => message.role === 'user'), true)
            : collectionLocator([]);
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          return sent
            ? collectionLocator(workingMessages().filter((message) => message.role === 'assistant'), true)
            : collectionLocator([]);
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          return sent ? messageLocator(workingMessages().at(-1)!, true) : scalarLocator({ count: vi.fn(async () => 0) });
        }
        if (selector.includes(STOP_BUTTON_TESTID)) return scalarLocator();
        return scalarLocator();
      }),
    };

    let resolveLateSuccessor!: (page: any) => void;
    const pendingSuccessor = new Promise<any>((resolve) => {
      resolveLateSuccessor = resolve;
    });
    const lateSuccessor = {
      close: vi.fn(async () => undefined),
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => 'about:blank#late-recovery-successor'),
    };
    const foreignPage = {
      close: vi.fn(async () => undefined),
      url: vi.fn(() => LOSER_CONV),
      isClosed: vi.fn(() => false),
    };
    const context = {
      newPage: vi.fn()
        .mockResolvedValueOnce(initialPage)
        .mockImplementationOnce(() => pendingSuccessor),
      pages: vi.fn(() => lost ? [foreignPage] : [initialPage]),
    };
    const browser = {
      contexts: vi.fn(() => [context]),
      isConnected: vi.fn(() => true),
      close: vi.fn(async () => undefined),
    };
    mocks.browserQueue.push(browser);

    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const code = await runStateLightTurn(
        livenessArgv(join(livenessStateDir, 'recovery-page.txt'), '50'),
        {
          entryLivenessHeartbeat: true,
          recoveryHooks: {
            faultActuator: () => { lost = true; },
          },
        },
      );
      expect(code).not.toBe(0);
      const records = parseRecords(writes);
      const heartbeats = records.filter((record) => record.schema === 'observation-heartbeat/v1');
      expect(heartbeats.length).toBeGreaterThan(3);
      expect(heartbeats.some((record) => record.phase === 'post_send_observation')).toBe(true);
      expect(records.at(-1)).toMatchObject({
        schema: 'turn-result/v1',
        state: 'driver_error',
        cause: 'replacement_observation_page_create_failed',
        send_count: 1,
      });
      expect(sends).toBe(1);
      expect(context.newPage).toHaveBeenCalledTimes(2);
      expect(initialClose).not.toHaveBeenCalled();
      expect(foreignPage.close).not.toHaveBeenCalled();

      resolveLateSuccessor(lateSuccessor);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(lateSuccessor.close).toHaveBeenCalledTimes(1);
      expect(lateSuccessor.goto).not.toHaveBeenCalled();
      expect(foreignPage.close).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });
});
