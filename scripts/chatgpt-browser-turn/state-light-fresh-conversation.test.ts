import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProcessSync } from '../kernel/subprocess.ts';

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

// Production CDP selection is exercised at protocol level in own-target-attach.test.ts.
// Existing turn/unit fixtures inject their Page *through* the new filtered attach
// contract, so these tests continue to test Send/observation, not Chrome HTTP.
vi.mock('./own-target-attach.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./own-target-attach.ts')>();
  return {
    ...actual,
    attachOwnTarget: vi.fn(actual.__testAttachOwnTargetFixture),
    countUninspectedRecoveryTargets: vi.fn(async () => 0),
  };
});


vi.mock('./own-target-cdp-proxy.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./own-target-cdp-proxy.ts')>();
  return { ...actual, probeCdpSiblingEvaluations: vi.fn(actual.probeCdpSiblingEvaluations) };
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
  proseMirrorEditorSurface,
  readyTurnObservationFrames,
  runStateLightTurnWithStdoutCapture,
  scalarLocator,
  stableTurnInput,
  STATE_LIGHT_TURN_BASE_ARGV,
  TEST_OWNED_MARKER,
  type StateLightTestMessage,
  type CapturedStateLightTurnResult,
  type StateLightTestSnapshot,
} from './state-light-turn.test-fixtures.ts';
import { classifyPageObservation, classifySendLandingEvidence, publishStateLightReply, readPageObservation, runStateLightTurn } from './state-light-turn.ts';
import { admitStateLightTurnObservation, finalizeStateLightPrimaryPublication, readStateLightTurnObservation } from './state-light-turn-observation.ts';
import { deriveDelivery } from '../flow-manager-long-running-child.ts';
import { __testBrowserOrPageDefinitelyLost, __testComposerMutation, __testSendDelivery, deriveComposerInsertionBudgetMs, POST_SEND_OBSERVATION_POLL_MS, probePageLiveness } from './state-light-turn-base.ts';
import { attachOwnTarget, __testAttachOwnTargetFixture } from './own-target-attach.ts';
import { probeCdpSiblingEvaluations } from './own-target-cdp-proxy.ts';
import { currentOwnedPromptMarker, wrapOwnedPromptPayload } from './owned-prompt-marker.ts';
import {
  EXPLICIT_CANCELLATION_AUTHORITY,
  isSupportedChatGptConversationUrl,
  readRecoveryAuthoritativeUserMessages,
  stopOwnedGeneration,
} from './state-light-cancellation.ts';
import * as uiAdapter from './ui-adapter.ts';
import {
  ASSISTANT_MESSAGE_SELECTOR,
  ASSISTANT_TURN_ANCESTOR_XPATH,
  COMPOSER_SELECTOR,
  MESSAGE_AUTHOR_ROLE_ATTR,
  matchesStopButtonSelector,
  MESSAGE_NODE_SELECTOR,
  RENDERED_STOP_BUTTON_SELECTOR,
  SEND_BUTTON_SELECTOR,
  STOP_BUTTON_TESTID,
  USER_MESSAGE_SELECTOR,
} from './product-page-selectors.ts';
import {
  acquireStateLightNewChatSendSlot,
  conversationUuidFromUrl,
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
  STATE_LIGHT_NAVIGATION_TIMEOUT_MS,
  tryClaimStateLightFreshConversation,
  verifyStateLightSendSlotOwnerFence,
  verifyStateLightFreshClaimOwnerFence,
  STATE_LIGHT_SEND_SLOT_TTL_MS,
  STATE_LIGHT_OWNER_PRE_DISPATCH_MS,
  STATE_LIGHT_PASSIVE_FRESH_CLAIM_TTL_MS,
} from './state-light-fresh-conversation.ts';

const PROJECT_URL = 'https://chatgpt.com/g/g-p-11111111111111111111111111111111-test/project';
const PROJECT_CONVERSATION_ROOT = 'https://chatgpt.com/g/g-p-11111111111111111111111111111111-test';
const SHARED_CONV = `${PROJECT_CONVERSATION_ROOT}/c/11111111-1111-4111-8111-111111111111`;
const LOCAL_ID_CONVERSATION_URL = `${PROJECT_CONVERSATION_ROOT}/c/local-chatgpt%3A11111111-1111-4111-8111-111111111111`;
const SHARED_CANONICAL_CONV = SHARED_CONV.replace('-test/c/', '/c/');
const LOSER_CONV = `${PROJECT_CONVERSATION_ROOT}/c/22222222-2222-4222-8222-222222222222`;
const ISSUE_PROJECT_URL = 'https://chatgpt.com/g/g-p-6a1920e1c1608191bef6089396d947b4-orchestrator-pack/project';
const ISSUE_CONVERSATION_URL = 'https://chatgpt.com/g/g-p-6a1920e1c1608191bef6089396d947b4-orchestrator-pack/c/6ab8cb78-4e14-83ec-92ff-3e7b67611185';
const OTHER_PROJECT_CONVERSATION_URL = 'https://chatgpt.com/g/g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-other/c/6ab8cb78-4e14-83ec-92ff-3e7b67611185';
const OTHER_ORIGIN_CONVERSATION_URL = 'https://example.com/g/g-p-6a1920e1c1608191bef6089396d947b4-orchestrator-pack/c/6ab8cb78-4e14-83ec-92ff-3e7b67611185';

// Synthetic fresh-chat turns exercise the locator-absent path. A real launcher
// locator must continue to fail closed in production until its original generation
// is independently proven; never inherit the test runner's terminal handle here.
beforeEach(() => {
  vi.stubEnv('ORCA_TERMINAL_HANDLE', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

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

function makeLoserPage(
  prompt: string, reply: string, onSend?: () => void, ownedPriorHistory = false,
  rendering?: 'paragraphs' | 'autolink' | 'blank-paragraphs',
  additionalWaitingFrames = 0,
) {
  let sends = 0;
  let sent = false;
  let composerText = '';
  let url = PROJECT_URL;
  let observationIndex = 0;
  const priorHistory: StateLightTestMessage[] = ownedPriorHistory
    ? [{ role: 'user', text: 'historical user' }] : [];
  const atomicOwnedHistory = (messages: StateLightTestMessage[], generating = false) =>
    Object.assign(collectionLocator(messages, generating), {
      evaluateAll: vi.fn(async () => ({
        rows: messages.map((message, domIndex) => ({
          role: message.role, text: message.text, key: `fixture-turn-${domIndex}`, domIndex,
          complete: true, completionReady: Boolean(message.finalActionInTurnContainer),
          continuationVisible: false,
        })),
        pageTurnEvidence: {
          generationInProgress: generating,
          observedAssistantNodes: messages.filter((message) => message.role === 'assistant').length,
          continueGeneratingVisible: false,
        },
      })),
    });
  const snapshotFrames = readyTurnObservationFrames(prompt, reply).map((messages, index) => ({
    messages: [...priorHistory, ...messages],
    generating: index < 2,
  }));
  let activeSnapshot = snapshotFrames[0]!;
  const editorSurface = () => rendering ? proseMirrorEditorSurface(
    sent ? '' : composerText + (rendering === 'blank-paragraphs' ? '\n' : ''),
    rendering === 'blank-paragraphs' ? 'paragraphs' : rendering,
  ) : undefined;

  const composer = scalarLocator({
    count: vi.fn(async () => 1),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async (value: string) => { composerText = value; }),
    innerText: vi.fn(async () => editorSurface()?.innerText ?? (sent ? '' : composerText)),
    textContent: vi.fn(async () => editorSurface()?.textContent ?? (sent ? '' : composerText)),
    // Browser-side callbacks execute against one live editable element. Do
    // not fake an always-true evaluate: atomic compare/clear and URL guards
    // must actually inspect the same state they can modify.
    evaluate: vi.fn(async (
      callback: (element: unknown, arg?: unknown) => unknown,
      arg?: unknown,
      options?: { timeout?: number },
    ) => {
      // The older readiness test adapter intentionally models a presence-only
      // locator. Its three-argument evaluate must keep the original fallback;
      // only the new lossless/atomic calls use the browser-element model below.
      if (options?.timeout !== undefined) return true;
      const surface = editorSurface();
      const element = {
        ...surface,
        isConnected: true,
        isContentEditable: true,
        ownerDocument: { defaultView: {
          location: { get href() { return String(page.url()); } },
          getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
        } },
        get textContent() { return surface?.textContent ?? (sent ? '' : composerText); },
        set textContent(value: string) { composerText = value; },
        get innerText() { return surface?.innerText ?? (sent ? '' : composerText); },
      };
      return callback(element, arg);
    }),
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
      if (selector === USER_MESSAGE_SELECTOR) {
        return collectionLocator(sent
          ? [...priorHistory, { role: 'user', text: `${TEST_OWNED_MARKER}\n\n${prompt}` }]
          : priorHistory);
      }
      if (selector === MESSAGE_NODE_SELECTOR) {
        if (!sent) return ownedPriorHistory ? atomicOwnedHistory(priorHistory) : collectionLocator([]);
        activeSnapshot = snapshotFrames[Math.min(Math.max(0, observationIndex - additionalWaitingFrames), snapshotFrames.length - 1)]!;
        observationIndex++;
        return ownedPriorHistory
          ? atomicOwnedHistory(activeSnapshot.messages, activeSnapshot.generating)
          : collectionLocator(activeSnapshot.messages, activeSnapshot.generating);
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

  return { page, composer, sendButton, getSends: () => sends,
    getComposerText: () => sent ? '' : composerText, getObservationReads: () => observationIndex };
}

// First-party driver keeps a CDP-pinned ID. Legacy synthetic Page fixtures
// need actual per-test census/retirement evidence to claim confirmed close.
function proveCreatedPageCanClose(page: any): void {
  const keepalive = { id: 'opk-keepalive', type: 'page', url: 'about:blank#opk-keepalive' };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (new URL(String(input)).pathname !== '/json/list') {
      throw new Error('unexpected CDP operation in exact-created-page fixture');
    }
    const closed = (page.close?.mock?.calls?.length ?? 0) > 0;
    return new Response(JSON.stringify([
      ...(!closed ? [{
        id: 'fixture-own-target', type: 'page', url: String(page.url()),
        webSocketDebuggerUrl: 'ws://example/fixture-own-target',
      }] : []),
      keepalive,
    ]), { status: 200 });
  });
}

// Negative fixture: a known original CDP target remains physically live even
// when its Playwright Page is closed or recovery used a different Page. Absence
// of a synthetic ID from a real Chrome census is not proof of its retirement.
function proveCreatedPageRemainsVisibleToCdp(page: any): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (new URL(String(input)).pathname !== '/json/list') {
      throw new Error('unexpected CDP operation in live-target negative fixture');
    }
    return new Response(JSON.stringify([
      { id: 'fixture-own-target', type: 'page', url: String(page.url()),
        webSocketDebuggerUrl: 'ws://example/fixture-own-target' },
      { id: 'opk-keepalive', type: 'page', url: 'about:blank#opk-keepalive' },
    ]), { status: 200 });
  });
}

async function runNewChatTurn(
  page: any,
  outputPath: string,
  timeoutMs = '90000',
  invocationId = randomUUID(),
  projectUrl = PROJECT_URL,
) {
  enqueueBrowserForTurn(mocks, page);
  return runStateLightTurnWithStdoutCapture(runStateLightTurn, [
    ...STATE_LIGHT_TURN_BASE_ARGV,
    '--invocation-id', invocationId,
    '--output', outputPath,
    '--new-chat',
    '--project-url', projectUrl,
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

  // Exercise the real held-Page GET witness, wrapper and finalizer (not a
  // fabricated TerminalEnvelope). The request must be from this exact Page.
  function installExistingChatFetch429(page: any) {
    const events = new EventEmitter();
    page.on = events.on.bind(events);
    page.off = events.off.bind(events);
    const request = {
      url: () => 'https://chatgpt.com/backend-api/conversations/11111111-1111-4111-8111-111111111111',
      method: () => 'GET',
    };
    return () => {
      events.emit('request', request);
      events.emit('response', { request: () => request, status: () => 429 });
    };
  }

  it('reports and pins a created tab after Playwright attach fails without closing the foreign survivor', async () => {
    const invocationId = randomUUID();
    const createdId = 'created-before-attach-failure';
    const connectionFailure = Object.assign(new Error('injected_connect_failure'), {
      attachAttempts: 3, createdTargetId: createdId,
    });
    const attach = vi.mocked(attachOwnTarget);
    attach.mockRejectedValueOnce(connectionFailure);
    // The exact-target cleanup reconnection also fails: no raw close, and
    // no replacement target selection is allowed as a fallback.
    attach.mockRejectedValueOnce(new Error('injected_cleanup_reattach_failure'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname !== '/json/list') throw new Error('unexpected_destructive_cdp_request');
      return new Response(JSON.stringify([
        { id: createdId, type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://example/created-attach-failed' },
        { id: 'foreign-survivor', type: 'page', url: 'https://chatgpt.com/c/foreign' },
      ]), { status: 200 });
    });
    try {
      const fixture = makeLoserPage('NO-SEND-AFTER-ATTACH-FAILURE', 'NEVER');
      const outcome = await runNewChatTurn(
        fixture.page, join(stateDir, 'attach-failure.txt'), '30000', invocationId,
      );
      expect(outcome.result).toMatchObject({
        state: 'driver_error',
        send_count: 0,
        attach_attempts: 3,
        owned_target_id: createdId,
        owned_target_created: true,
        cleanup: 'unconfirmed',
        cleanup_status: 'cleanup_unconfirmed',
      });
      expect(readStateLightTurnObservation('collision-profile', invocationId).owned_target).toMatchObject({
        id: createdId, created: true,
      });
      expect(fixture.getSends()).toBe(0);
      expect(fixture.page.close).not.toHaveBeenCalled();
      expect(fetchSpy.mock.calls.every(([input]) => new URL(String(input)).pathname === '/json/list')).toBe(true);
    } finally {
      attach.mockImplementation(__testAttachOwnTargetFixture);
      fetchSpy.mockRestore();
    }
  });

  it('AC12 closes only a freshly opened existing-chat Page after a witnessed pre-Send fetch 429', async () => {
    const fixture = makeLoserPage('NO-SEND-429', 'NEVER-SEND');
    proveCreatedPageCanClose(fixture.page);
    const notify429 = installExistingChatFetch429(fixture.page);
    const goto = fixture.page.goto.getMockImplementation()!;
    fixture.page.goto.mockImplementation(async (target: string) => {
      await goto(target);
      notify429(); // own-GET response follows this invocation's opening.
    });
    enqueueBrowserForTurn(mocks, fixture.page);
    const output = join(stateDir, 'fetch-429-owned.txt');
    const outcome = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--invocation-id', randomUUID(),
      '--output', output,
      '--chat-url', SHARED_CONV,
      '--timeout-ms', '60000',
      '--poll-ms', '1',
    ]);
    expect(outcome.result).toMatchObject({
      state: 'rate_limit', cause: 'conversation_fetch_http_429',
      send_count: 0, cleanup: 'confirmed',
    });
    expect(outcome.result.send_attempted).not.toBe(true);
    expect(fixture.page.close).toHaveBeenCalledTimes(1);
    expect(fixture.sendButton.click).not.toHaveBeenCalled();
  });

  it('keeps exact owned GET 429 cooldown but harvests the late stable DOM reply and retires its idle created target (#2678 R2)', async () => {
    const prompt = 'OWNED-GET-429-LATE';
    const reply = 'FOURTH-POLL-ASSISTANT-COMPLETE';
    let reportOwned429: () => void = () => undefined;
    const fixture = makeLoserPage(prompt, reply, () => reportOwned429(), true, undefined, 2);
    proveCreatedPageCanClose(fixture.page);
    reportOwned429 = installExistingChatFetch429(fixture.page);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    enqueueBrowserForTurn(mocks, fixture.page);
    const output = join(stateDir, 'owned-429-late-dom.txt');
    const invocationId = randomUUID();
    const outcome = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--invocation-id', invocationId,
      '--output', output,
      '--chat-url', SHARED_CONV,
      '--timeout-ms', '90000',
      '--poll-ms', '1',
    ]);
    expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({
      state: 'ok', send_count: 1, cleanup: 'confirmed',
    });
    expect(outcome.result.poll_count).toBeGreaterThanOrEqual(4);
    expect(fixture.getSends()).toBe(1);
    expect(fixture.page.close).toHaveBeenCalledTimes(1);
    expect(readFileSync(output, 'utf8')).toBe(reply);
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('harvested');
  });

  it('AC12 preserves a selected pre-existing 429 Page and its sibling', async () => {
    const fixture = makeLoserPage('NO-SEND-EXISTING', 'NEVER-SEND');
    fixture.page.url.mockImplementation(() => SHARED_CONV);
    const notify429 = installExistingChatFetch429(fixture.page);
    const originalLocator = fixture.page.locator.getMockImplementation()!;
    let triggered = false;
    fixture.page.locator.mockImplementation((selector: string) => {
      if (!triggered) { triggered = true; notify429(); }
      return originalLocator(selector);
    });
    const sibling = { url: () => LOSER_CONV, close: vi.fn(async () => undefined) };
    const harness = enqueueBrowserForTurn(mocks, fixture.page);
    Object.assign(harness.context, { pages: vi.fn(() => [fixture.page, sibling]) });
    const outcome = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--invocation-id', randomUUID(),
      '--output', join(stateDir, 'fetch-429-preexisting.txt'),
      '--chat-url', SHARED_CONV,
      '--timeout-ms', '60000',
      '--poll-ms', '1',
    ]);
    expect(outcome.result.send_count).toBe(0);
    expect(fixture.page.close).not.toHaveBeenCalled();
    expect(sibling.close).not.toHaveBeenCalled();
  });

  it('serializes conversation claims so only the owner holds the shared surface', () => {
    const profileKey = 'collision-profile';
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'winner')).toBe('claimed');
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'loser')).toBe('contended');
    releaseStateLightFreshConversationClaim(profileKey, SHARED_CONV, 'winner');
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'loser')).toBe('claimed');
    releaseStateLightFreshConversationClaim(profileKey, SHARED_CONV, 'loser');
  });

  it('fences slug aliases with one canonical claim, distinct projects and legacy URL hashes', async () => {
    const profileKey = 'alias-exclusion';
    const alternateAlias = SHARED_CANONICAL_CONV;
    const foreign = SHARED_CANONICAL_CONV.replace('g-p-11111111111111111111111111111111', 'g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const legacyFile = join(stateDir, profileKey, 'state-light-fresh-claims', `${(await import('./storage-common.ts')).sha256(SHARED_CONV)}.json`);
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'current-owner')).toBe('claimed');
    expect(tryClaimStateLightFreshConversation(profileKey, alternateAlias, 'foreign-owner')).toBe('contended');
    expect(tryClaimStateLightFreshConversation(profileKey, foreign, 'foreign-owner')).toBe('claimed');
    releaseStateLightFreshConversationClaim(profileKey, alternateAlias, 'foreign-owner');
    expect(verifyStateLightFreshClaimOwnerFence(profileKey, SHARED_CONV, 'current-owner', 5_000)).toBe('valid');
    releaseStateLightFreshConversationClaim(profileKey, SHARED_CONV, 'current-owner');
    releaseStateLightFreshConversationClaim(profileKey, foreign, 'foreign-owner');

    const { writeFileSync } = await import('node:fs');
    writeFileSync(legacyFile, JSON.stringify({
      schema: 'state-light-fresh-claim/v1',
      version: 1,
      invocation_id: 'legacy-owner',
      conversation_id: SHARED_CONV,
      pid: process.pid,
      claimed_at: new Date(mocks.nowMs).toISOString(),
    }) + '\n');
    expect(tryClaimStateLightFreshConversation(profileKey, alternateAlias, 'new-owner')).toBe('contended');
    expect(JSON.parse(readFileSync(legacyFile, 'utf8')).invocation_id).toBe('legacy-owner');
    writeFileSync(legacyFile, JSON.stringify({
      schema: 'state-light-fresh-claim/v1',
      version: 1,
      invocation_id: 'legacy-owner',
      conversation_id: SHARED_CONV,
      pid: process.pid,
      claimed_at: new Date(mocks.nowMs - STATE_LIGHT_PASSIVE_FRESH_CLAIM_TTL_MS - 1).toISOString(),
    }) + '\n');
    expect(tryClaimStateLightFreshConversation(profileKey, alternateAlias, 'new-owner')).toBe('claimed');
    releaseStateLightFreshConversationClaim(profileKey, alternateAlias, 'new-owner');
    expect(existsSync(legacyFile)).toBe(true);
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

  it('replaces a stale composer draft directly with this invocation payload (#2497 4b)', async () => {
    const prompt = 'PROMPT-FRESH-DRAFT';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'DRAFT-CLEAR-OK');
    await turn.composer.fill('SYNTHETIC-FOREIGN-DRAFT');
    turn.composer.fill.mockClear();
    const result = await runNewChatTurn(turn.page, '/tmp/fresh-draft-2487.txt');
    expect(result.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(turn.getSends()).toBe(1);
    expect(turn.composer.fill.mock.calls.map((args: unknown[]) => args[0])).toEqual([
      expect.stringContaining(prompt),
    ]);
  });

  it.each(['', '\n'])('sends a rendered five-newline separator and three-newline suffix for prompt suffix %j (#2492)', async (suffix) => {
    const prompt = `Reply with the single word OK.${suffix}`;
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'OK', undefined, false, 'paragraphs');
    const outcome = await runNewChatTurn(turn.page, join(stateDir, 'rendered-paragraphs.txt'));
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(turn.getSends()).toBe(1);
  });

  it('sends six blank lines with ProseMirror empty paragraphs and trailing breaks (#2671)', async () => {
    const prompt = ['Explain the two checks.', 'First check: draft content.',
      'Second check: exactly one Send.', 'Keep all six blank lines.',
      'Do not operate on other chats.', 'This is a synthetic regression.',
      'Reply with the result.'].join('\n\n').padEnd(1668, 'x');
    expect(Buffer.byteLength(prompt)).toBe(1668);
    expect(prompt.match(/\n\n/gu)).toHaveLength(6);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'Both checks passed.', undefined, false, 'blank-paragraphs');
    const outcome = await runNewChatTurn(turn.page, join(stateDir, 'blank-paragraphs-2671.txt'));
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(turn.getSends()).toBe(1);
  });

  it.each((['content', 'marker-boundary'] as const).flatMap((kind) =>
    (['fill', 'before-click'] as const).map((stage) => ({ kind, stage })),
  ))(
    'rejects a genuine $kind mismatch at $stage without Send (#2671)', async ({ kind, stage }) => {
      const prompt = 'Explain draft verification.\n\nReply with both checks.';
      mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
      const turn = makeLoserPage(prompt, 'must not send');
      const corrupt = (text: string) => kind === 'marker-boundary'
        ? text.replace('\n\n', '') : text.replace('both', 'neither');
      if (stage === 'fill') {
        const fill = turn.composer.fill.getMockImplementation()!;
        turn.composer.fill.mockImplementation(async (text: string) => fill(corrupt(text)));
      } else {
        turn.sendButton.isEnabled.mockImplementation(async () => {
          await turn.composer.fill(corrupt(await turn.composer.innerText()));
          return true;
        });
      }
      const outcome = await runNewChatTurn(turn.page, join(stateDir, `mismatch-${kind}-${stage}-2671.txt`));
      expect(outcome.result).toMatchObject({ cause: 'composer_payload_mismatch', send_count: 0 });
      expect(turn.getSends()).toBe(0);
    },
  );

  it('sends a backticked https URL when editor autolinking adds whitespace (#2497)', async () => {
    const prompt = 'Reply OK for `https://example.com/2497`';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'OK', undefined, false, 'autolink');
    const outcome = await runNewChatTurn(turn.page, join(stateDir, 'autolink-2497.txt'));
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(turn.getSends()).toBe(1);
  });

  it.each(['90000', '61000'])('does not reserve the whole profile while preparing (%s ms)', async (timeout) => {
    const { acquireDomainLock } = await import('./coordination.ts');
    const acquire = vi.mocked(acquireDomainLock);
    acquire.mockClear();
    const turn = makeLoserPage('PROMPT', 'OK');
    const outcome = await runNewChatTurn(turn.page, join(stateDir, `no-profile-lock-${timeout}.txt`), timeout);
    expect(outcome.result.send_count).toBe(timeout === '90000' ? 1 : 0);
    expect(acquire).not.toHaveBeenCalledWith(
      'collision-profile', 'fresh-send-composer', 0, { maxHoldMs: 15_000 },
    );
    if (timeout === '61000') {
      expect(turn.getComposerText()).toBe('');
      expect(turn.composer.fill).not.toHaveBeenCalledWith('', expect.anything());
    }
    expect(turn.page.bringToFront).not.toHaveBeenCalled();
  });

  it('allows two distinct owned Pages in the same profile to reach Send concurrently', async () => {
    const first = makeLoserPage('PROMPT', 'FIRST-REPLY');
    const second = makeLoserPage('PROMPT', 'SECOND-REPLY');
    second.page.url.mockImplementation(() => second.getSends() > 0 ? LOSER_CONV : PROJECT_URL);

    let entered = 0;
    let releasedTogether = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const timer = setTimeout(release, 1_000);
    for (const turn of [first, second]) {
      const original = turn.sendButton.click.getMockImplementation()!;
      turn.sendButton.click.mockImplementation(async () => {
        entered++;
        if (entered === 2) {
          releasedTogether = true;
          clearTimeout(timer);
          release();
        }
        await gate;
        await original();
      });
      enqueueBrowserForTurn(mocks, turn.page);
    }

    const captured: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const args = (id: string) => [
        ...STATE_LIGHT_TURN_BASE_ARGV,
        '--invocation-id', id,
        '--output', join(stateDir, id + '.txt'),
        '--new-chat', '--project-url', PROJECT_URL, '--timeout-ms', '90000', '--poll-ms', '1',
      ];
      const codes = await Promise.all([
        runStateLightTurn(args(randomUUID())),
        runStateLightTurn(args(randomUUID())),
      ]);
      expect(releasedTogether).toBe(true);
      expect(entered).toBe(2);
      expect(codes).toEqual([0, 0]);
      expect(first.getSends()).toBe(1);
      expect(second.getSends()).toBe(1);
      const terminals = captured.map((line) => {
        try { return JSON.parse(line) as { schema?: string; send_count?: number }; }
        catch { return {}; }
      }).filter((value) => value.schema === 'turn-result/v1');
      expect(terminals).toHaveLength(2);
      expect(terminals.every((value) => value.send_count === 1)).toBe(true);
    } finally {
      clearTimeout(timer);
      release();
      stdout.mockRestore();
    }
  });

  it('does not wait for a profile-wide composer lock even under simulated contention', async () => {
    const { acquireDomainLock } = await import('./coordination.ts');
    const acquire = vi.mocked(acquireDomainLock);
    acquire.mockClear();
    acquire.mockReturnValue(null);
    try {
      const turn = makeLoserPage('PROMPT', 'OK');
      const outcome = await runNewChatTurn(turn.page, join(stateDir, 'independent-page-no-profile-lock.txt'));
      expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
      expect(turn.getSends()).toBe(1);
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      acquire.mockReset();
    }
  });

  it('sends when the button becomes available after 40 seconds without a profile reservation', async () => {
    const prompt = 'PROMPT-2541-DELAYED-SEND';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'OK');
    const startedAt = mocks.nowMs;
    turn.sendButton.isEnabled.mockImplementation(async () => mocks.nowMs >= startedAt + 40_000);
    const outcome = await runNewChatTurn(turn.page, join(stateDir, 'delayed-send-2541.txt'), '90000');
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(mocks.nowMs).toBeGreaterThanOrEqual(startedAt + 40_000);
    expect(turn.getSends()).toBe(1);
    expect(turn.page.bringToFront).not.toHaveBeenCalled();
  });


  describe('Issue #2682 bounded frozen-sibling Send extension', () => {
    const sibling = { id: 'qualified-sibling', url: 'https://chatgpt.com/c/26822682-2682-4682-8682-268226822682' };
    const positive = () => ({
      nonresponsive: [sibling], responsive: [], disappearedOrChanged: [], unknown: [],
    });
    const empty = () => ({
      nonresponsive: [], responsive: [], disappearedOrChanged: [], unknown: [],
    });
    const journal = () => mocks.appendFileSync.mock.calls
      .map((args) => {
        try { return JSON.parse(String(args[1]).trim()) as Record<string, any>; }
        catch { return {}; }
      }).filter((row) => row.event_class === 'fresh_send_extended_readiness');

    beforeEach(() => {
      vi.mocked(probeCdpSiblingEvaluations).mockReset();
      vi.mocked(probeCdpSiblingEvaluations).mockResolvedValue(empty());
      mocks.appendFileSync.mockClear();
    });

    it('leaves the four incumbent 15s windows and zero-click never-enabled cause untouched without evidence', async () => {
      const prompt = '2682-NEGATIVE-SEND';
      mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
      const turn = makeLoserPage(prompt, 'UNREACHED');
      turn.sendButton.isEnabled.mockResolvedValue(false);
      const started = mocks.nowMs;
      const outcome = await runNewChatTurn(turn.page, join(stateDir, '2682-negative.txt'));
      expect(outcome.result).toMatchObject({
        state: 'send_failed', cause: 'fresh_send_button_never_enabled', send_count: 0,
      });
      expect(mocks.nowMs - started).toBeGreaterThanOrEqual(60_000);
      expect(mocks.nowMs - started).toBeLessThan(65_000);
      expect(probeCdpSiblingEvaluations).toHaveBeenCalledTimes(1);
      expect(turn.sendButton.click).not.toHaveBeenCalled();
      expect(journal()).toHaveLength(0);
    });

    it('sends the originally marked owned payload once after the 180s recovery, not to the sibling', async () => {
      const prompt = '2682-SEND-AT-180S';
      mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
      const turn = makeLoserPage(prompt, 'RECOVERED');
      const base = mocks.nowMs;
      turn.sendButton.isEnabled.mockImplementation(async () => mocks.nowMs >= base + 180_000);
      vi.mocked(probeCdpSiblingEvaluations).mockResolvedValueOnce(positive());
      const outcome = await runNewChatTurn(turn.page, join(stateDir, '2682-enabled.txt'), '900000');
      expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
      expect(outcome.result.send_attempted).not.toBe(false);
      expect(turn.getSends()).toBe(1);
      expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
      expect(mocks.nowMs - base).toBeGreaterThanOrEqual(180_000);
      expect(probeCdpSiblingEvaluations).toHaveBeenCalledTimes(1);
      expect(journal()).toEqual([expect.objectContaining({
        entry_nonresponsive_count: 1, outcome: 'enabled',
      })]);
      expect(journal()[0]?.terminal_nonresponsive_count).toBeUndefined();
      expect(JSON.stringify(journal())).not.toContain(sibling.id);
      expect(JSON.stringify(journal())).not.toContain(sibling.url);
      expect(JSON.stringify(journal())).not.toContain(prompt);
    });

    it.each([
      { result: positive(), cause: 'fresh_send_blocked_by_frozen_sibling', outcome: 'still_frozen', count: 1 },
      { result: { ...empty(), responsive: [sibling] }, cause: 'fresh_send_button_never_enabled',
        outcome: 'recovered_but_disabled', count: undefined },
      { result: { ...empty(), disappearedOrChanged: [sibling] }, cause: 'fresh_send_button_never_enabled',
        outcome: 'target_disappeared_or_changed', count: undefined },
      { result: { ...empty(), unknown: [sibling] }, cause: 'fresh_send_button_never_enabled',
        outcome: 'terminal_unknown', count: undefined },
    ])('rechecks original ID/URL once and returns zero clicks for $outcome', async ({ result, cause, outcome, count }) => {
      const prompt = '2682-NO-SEND-' + outcome;
      mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
      const turn = makeLoserPage(prompt, 'UNREACHED');
      turn.sendButton.isEnabled.mockResolvedValue(false);
      vi.mocked(probeCdpSiblingEvaluations).mockResolvedValueOnce(positive()).mockResolvedValueOnce(result);
      const started = mocks.nowMs;
      const resultTurn = await runNewChatTurn(turn.page, join(stateDir, '2682-' + outcome + '.txt'), '900000');
      expect(resultTurn.result).toMatchObject({ state: 'send_failed', scope: 'invocation', cause, send_count: 0 });
      expect(resultTurn.result.send_attempted).not.toBe(true);
      expect(turn.getSends()).toBe(0);
      expect(turn.sendButton.click).not.toHaveBeenCalled();
      expect(mocks.nowMs - started).toBeLessThanOrEqual(600_000);
      expect(probeCdpSiblingEvaluations).toHaveBeenCalledTimes(2);
      expect(vi.mocked(probeCdpSiblingEvaluations).mock.calls[1]?.[2]).toEqual([sibling]);
      expect(journal()).toEqual([expect.objectContaining({
        entry_nonresponsive_count: 1, outcome,
      })]);
      expect(journal()[0]?.terminal_nonresponsive_count).toBe(count);
      expect(JSON.stringify(journal())).not.toContain(prompt);
      expect(deriveDelivery({ ...resultTurn.result,
        resolved_send_count: resultTurn.result.send_count }, false)).toBe('not-sent');
      expect(resultTurn.result.next_action).toBeUndefined();
    });

    it('rejects extension when protected dispatch and cleanup reserves leave no time', async () => {
      const prompt = '2682-EARLY-BUDGET';
      mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
      const turn = makeLoserPage(prompt, 'UNREACHED');
      turn.sendButton.isEnabled.mockResolvedValue(false);
      vi.mocked(probeCdpSiblingEvaluations).mockResolvedValueOnce(positive());
      const outcome = await runNewChatTurn(turn.page, join(stateDir, '2682-budget.txt'), '90000');
      expect(outcome.result).toMatchObject({
        state: 'send_failed', cause: 'fresh_send_readiness_budget_exhausted', send_count: 0,
      });
      expect(outcome.result.send_attempted).not.toBe(true);
      expect(turn.sendButton.click).not.toHaveBeenCalled();
      expect(probeCdpSiblingEvaluations).toHaveBeenCalledTimes(1);
      expect(journal()).toEqual([expect.objectContaining({
        entry_nonresponsive_count: 1, outcome: 'budget_exhausted',
      })]);
      expect(journal()[0]?.terminal_nonresponsive_count).toBeUndefined();
    });
  });

  it('closes a proven owned, never-clicked draft only after 60s of disabled Send (#2487)', async () => {
    const prompt = 'PROMPT-FRESH-NEVER-ENABLED';
    const invocationId = randomUUID();
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'DO-NOT-SEND');
    turn.sendButton.isEnabled.mockResolvedValue(false);
    proveCreatedPageCanClose(turn.page);
    const outcome = await runNewChatTurn(turn.page, '/tmp/never-enabled-2487.txt', '90000', invocationId);
    expect(outcome.result).toMatchObject({
      state: 'send_failed', cause: 'fresh_send_button_never_enabled', send_count: 0,
    });
    expect(turn.getSends()).toBe(0);
    expect(turn.sendButton.click).not.toHaveBeenCalled();
    expect(turn.composer.evaluate).toHaveBeenCalled();
    expect(turn.getComposerText()).toBe('');
    expect(turn.composer.fill).not.toHaveBeenCalledWith('', expect.anything());
    expect(turn.page.close).toHaveBeenCalledTimes(1);
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('not_sent');
  });

  it('does not click Send when the owned marker is replaced during enablement polling (#2487)', async () => {
    const prompt = 'PROMPT-PRECLICK-IDENTITY';
    const invocationId = randomUUID();
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    turn.sendButton.isEnabled.mockImplementation(async () => {
      await turn.composer.fill('SYNTHETIC-FOREIGN-COMPOSER-EDIT');
      return true;
    });
    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, 'foreign-before-send.txt'), '90000', invocationId,
    );
    expect(outcome.result).toMatchObject({
      state: 'driver_error', cause: 'composer_payload_mismatch', send_count: 0,
    });
    expect(turn.getSends()).toBe(0);
    expect(turn.sendButton.click).not.toHaveBeenCalled();
    // An edited shared draft is neither ours to clear nor ours to close.
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(turn.getComposerText()).toBe('SYNTHETIC-FOREIGN-COMPOSER-EDIT');
    expect(turn.composer.fill).not.toHaveBeenCalledWith('', expect.anything());
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('not_sent');
  });

  it('rechecks the complete 60s Send reserve after a delayed final Stop read (#2487)', async () => {
    const prompt = 'PROMPT-SLOW-STOP-BOUNDARY';
    const invocationId = randomUUID();
    const invocationDeadlineMs = mocks.nowMs + 90_000;
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    const oldLocator = turn.page.locator.getMockImplementation()!;
    let lateProbeInjected = false;
    turn.page.locator.mockImplementation((selector: string) => {
      if (selector.includes(STOP_BUTTON_TESTID)) {
        return scalarLocator({ count: vi.fn(async () => {
          if (!lateProbeInjected && turn.composer.fill.mock.calls.some((args: unknown[]) => String(args[0]).includes(prompt))) {
            lateProbeInjected = true;
            // Before the probe there is just over a full window left. Its
            // async work consumes that reserve; no late Send is authorized.
            mocks.nowMs = invocationDeadlineMs - 59_000;
          }
          return 0;
        }) });
      }
      return oldLocator(selector);
    });
    turn.sendButton.isEnabled.mockImplementation(async () => mocks.nowMs >= invocationDeadlineMs + 500);
    proveCreatedPageCanClose(turn.page);
    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, 'slow-stop-reserve.txt'), '90000', invocationId,
    );
    expect(lateProbeInjected).toBe(true);
    expect(outcome.result).toMatchObject({
      state: 'driver_error', cause: 'state_light_new_chat_send_budget_unavailable', send_count: 0,
    });
    expect(turn.sendButton.click).not.toHaveBeenCalled();
    expect(turn.getComposerText()).toBe('');
    expect(turn.page.close).toHaveBeenCalledTimes(1);
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('not_sent');
  });

  it('closes its already-empty created tab when the budget aborts before any fill (#2487)', async () => {
    const prompt = 'PROMPT-PRE-FILL-BUDGET-FAILURE';
    const invocationId = randomUUID();
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    proveCreatedPageCanClose(turn.page);
    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, 'empty-pre-fill.txt'), '61000', invocationId,
    );
    expect(outcome.result).toMatchObject({
      state: 'driver_error', cause: 'state_light_new_chat_send_budget_unavailable', send_count: 0,
    });
    expect(turn.getComposerText()).toBe('');
    expect(turn.composer.fill).not.toHaveBeenCalledWith('', expect.anything());
    expect(turn.sendButton.click).not.toHaveBeenCalled();
    expect(turn.page.close).toHaveBeenCalledTimes(1);
    expect(outcome.result.incidents).not.toContain('owned_composer_cleanup_unavailable');
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('not_sent');
  });

  it('preserves a never-clicked draft when atomic compare-and-clear cannot be verified', async () => {
    const invocationId = randomUUID();
    const prompt = 'PROMPT-FAILED-COMPOSER-CLEAR';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'NOT-SENT');
    turn.sendButton.isEnabled.mockResolvedValue(false);
    const evaluate = turn.composer.evaluate.getMockImplementation()!;
    turn.composer.evaluate.mockImplementation(async (
      callback: (element: unknown, arg?: unknown) => unknown,
      arg?: unknown,
      options?: { timeout?: number },
    ) => {
      if (options?.timeout !== undefined) return evaluate(callback, arg, options);
      throw new Error('synthetic atomic composer evaluation failure');
    });

    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, 'failed-composer-clear-2510.txt'), '90000', invocationId,
    );
    expect(outcome.result).toMatchObject({
      state: 'send_failed', cause: 'fresh_send_button_never_enabled', send_count: 0,
    });
    expect(turn.composer.evaluate).toHaveBeenCalled();
    expect(turn.composer.fill).not.toHaveBeenCalledWith('', expect.anything());
    expect(turn.getComposerText()).toContain(prompt);
    expect(outcome.result.cleanup).not.toBe('confirmed');
    expect(outcome.result.incidents).toContain('owned_composer_cleanup_unavailable');
    expect(outcome.result.send_attempted).not.toBe(true);
    expect(turn.getSends()).toBe(0);
    expect(turn.sendButton.click).not.toHaveBeenCalled();
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(deriveDelivery({
      ...outcome.result,
      resolved_send_count: outcome.result.send_count,
    }, false)).toBe('not-sent');
    expect(outcome.code).not.toBe(0);
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('not_sent');
  });

  it('preserves an edited shared draft when atomic comparison sees a concurrent mutation', async () => {
    const prompt = 'PROMPT-ATOMIC-COMPARE-EDIT';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    turn.sendButton.isEnabled.mockResolvedValue(false);
    const evaluate = turn.composer.evaluate.getMockImplementation()!;
    let changed = false;
    turn.composer.evaluate.mockImplementation(async (
      callback: (element: unknown, arg?: unknown) => unknown,
      arg?: unknown,
      options?: { timeout?: number },
    ) => {
      const payload = typeof arg === 'string' ? arg : (arg as { payload?: string } | undefined)?.payload;
      if (!changed && typeof payload === 'string' && payload.includes(prompt)) {
        changed = true;
        await turn.composer.fill('FOREIGN-EDIT-BEFORE-ATOMIC-COMPARE');
      }
      return evaluate(callback, arg, options);
    });
    const outcome = await runNewChatTurn(turn.page, join(stateDir, 'atomic-shared-edit-2651.txt'));
    expect(changed).toBe(true);
    expect(outcome.result.send_count).toBe(0);
    expect(outcome.result.cleanup).not.toBe('confirmed');
    expect(turn.getComposerText()).toBe('FOREIGN-EDIT-BEFORE-ATOMIC-COMPARE');
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(turn.sendButton.click).not.toHaveBeenCalled();
  });

  it('does not clear a Page navigating during the single atomic compare-and-clear', async () => {
    const prompt = 'PROMPT-ATOMIC-NAVIGATION';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    turn.sendButton.isEnabled.mockResolvedValue(false);
    const originalUrl = turn.page.url.getMockImplementation()!;
    let navigated = false;
    turn.page.url.mockImplementation(() => navigated ? OTHER_PROJECT_CONVERSATION_URL : originalUrl());
    const evaluate = turn.composer.evaluate.getMockImplementation()!;
    turn.composer.evaluate.mockImplementation(async (
      callback: (element: unknown, arg?: unknown) => unknown,
      arg?: unknown,
      options?: { timeout?: number },
    ) => {
      const payload = typeof arg === 'string' ? arg : (arg as { payload?: string } | undefined)?.payload;
      if (!navigated && typeof payload === 'string' && payload.includes(prompt)) navigated = true;
      return evaluate(callback, arg, options);
    });
    const outcome = await runNewChatTurn(turn.page, join(stateDir, 'atomic-navigation-2651.txt'));
    expect(navigated).toBe(true);
    expect(outcome.result.send_count).toBe(0);
    expect(outcome.result.cleanup).not.toBe('confirmed');
    expect(turn.getComposerText()).toContain(prompt);
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(turn.sendButton.click).not.toHaveBeenCalled();
  });

  it('preserves a formerly owned tab that navigates during terminal composer cleanup (#2487)', async () => {
    const prompt = 'PROMPT-CLEANUP-PAGE-REPLACED';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    turn.sendButton.isEnabled.mockResolvedValue(false);
    const originalUrl = turn.page.url.getMockImplementation()!;
    const read = turn.composer.innerText.getMockImplementation()!;
    let repurposed = false;
    turn.page.url.mockImplementation(() => repurposed ? OTHER_PROJECT_CONVERSATION_URL : originalUrl());
    turn.composer.innerText.mockImplementation(async () => {
      const text = await read();
      if (mocks.nowMs >= 70_000) repurposed = true;
      return text;
    });
    const outcome = await runNewChatTurn(turn.page, join(stateDir, 'cleanup-tab-replaced.txt'));
    expect(outcome.result).toMatchObject({
      state: 'send_failed', cause: 'fresh_send_button_never_enabled', send_count: 0,
    });
    expect(repurposed).toBe(true);
    // Clearing while still owned is permitted. Navigation thereafter never
    // grants authority to close the now-foreign Page or fill its composer.
    expect(turn.page.url()).toBe(OTHER_PROJECT_CONVERSATION_URL);
    expect(turn.composer.fill).not.toHaveBeenCalledWith('', expect.anything());
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(outcome.result.incidents).toContain('owned_composer_cleanup_unavailable');
  });
  it('allows one and only one additional click after positive pre-actionability TimeoutError (#2487)', async () => {
    const prompt = 'PROMPT-RETRY-PROVEN';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'RETRY-OK');
    const clickEffect = turn.sendButton.click.getMockImplementation()!;
    const firstClick = [
      'locator.click: Timeout 5000ms exceeded',
      'Call log:',
      '  - waiting for element to be visible, enabled and stable',
      '  - element is not enabled',
    ].join('\n');
    turn.sendButton.click.mockImplementationOnce(async () => {
      throw Object.assign(new Error(firstClick), { name: 'TimeoutError' });
    }).mockImplementationOnce(clickEffect);
    const outcome = await runNewChatTurn(turn.page, '/tmp/retry-proven-2487.txt');
    expect(outcome.result.send_count).toBe(1);
    expect(turn.getSends()).toBe(1);
    expect(turn.sendButton.click).toHaveBeenCalledTimes(2);
  });

  it.each((['joined-marker', 'marker-content', 'middle-content', 'truncated-tail'] as const).flatMap((content) =>
    (['after-click', 'after-proof-read'] as const).map((when) => ({ content, when })),
  ))('vetoes a fresh retry with $content corruption $when (#2669)', async ({ content, when }) => {
    const prompt = 'keep separate words\n  indented line';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    const corrupt = (text: string) => content === 'joined-marker' ? text.replace('\n\n', '')
      : content === 'marker-content' ? text.replace('OPKTURNV1', 'OTHER-TURN')
        : content === 'middle-content' ? text.replace('indented', 'different') : text.slice(0, -1);
    let firstClickAt: number | undefined;
    let tailReads = 0;
    let injected = false;
    const read = turn.composer.innerText.getMockImplementation()!;
    turn.composer.innerText.mockImplementation(async () => {
      const visible = await read();
      // At the end of delivery probing, first comes its final composer read,
      // then the retry guard's read. Mutate after that read captures old text
      // to require a fresh payload check immediately before the physical retry.
      if (when === 'after-proof-read' && firstClickAt !== undefined
        && mocks.nowMs >= firstClickAt + 5_000 && ++tailReads === 2 && !injected) {
        await turn.composer.fill(corrupt(visible));
        injected = true;
      }
      return visible;
    });
    turn.sendButton.click.mockImplementationOnce(async () => {
      firstClickAt = mocks.nowMs;
      if (when === 'after-click') {
        await turn.composer.fill(corrupt(turn.getComposerText()));
        injected = true;
      }
      throw timeoutError();
    });
    const outcome = await runNewChatTurn(turn.page, join(stateDir, randomUUID() + '-retry-exact.txt'));
    expect(injected).toBe(true);
    expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
    expect(turn.getSends()).toBe(0);
    expect(outcome.result.send_count).toBe(0);
    expect(turn.page.close).not.toHaveBeenCalled();
  });

  it('never retries or clears an ambiguous first click (#2487)', async () => {
    const prompt = 'PROMPT-RETRY-UNPROVEN';
    const invocationId = randomUUID();
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'DO-NOT-SEND');
    turn.sendButton.click.mockRejectedValue(Object.assign(new Error('locator.click: Timeout 5000ms exceeded'), {
      name: 'TimeoutError',
    }));
    const outcome = await runNewChatTurn(turn.page, '/tmp/retry-unproven-2487.txt', '90000', invocationId);
    expect(outcome.result).toMatchObject({ state: 'observation_uncertain', send_count: 0, send_attempted: true });
    expect(outcome.result.cleanup).not.toBe('confirmed');
    expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
    expect(turn.composer.fill).not.toHaveBeenLastCalledWith('');
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(turn.getComposerText()).toContain(prompt);
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('dispatching');
  });


  const expectPossibleEffect = (result: CapturedStateLightTurnResult): void => {
    expect(deriveDelivery({
      ...result,
      resolved_send_count: result.send_count ?? 0,
    }, false)).toBe('POSSIBLY_DELIVERED');
  };

  // A positive first-actionability timeout is the *only* possible retry
  // admission witness. Every negative control below runs the production
  // driver, not just the static timeout parser.
  const provenPreActionabilityLog = [
    'locator.click: Timeout 5000ms exceeded',
    'Call log:',
    '  - waiting for element to be visible, enabled and stable',
    '  - element is not enabled',
  ].join('\n');
  const timeoutError = (message = provenPreActionabilityLog) =>
    Object.assign(new Error(message), { name: 'TimeoutError' });

  it.each([
    ['generic TimeoutError', 'locator.click: Timeout 5000ms exceeded'],
    ['missing Call log', 'locator.click: Timeout 5000ms exceeded\n - element is not enabled'],
    ['truncated Call log', 'locator.click: Timeout 5000ms exceeded\nCall log:\n - waiting for element to be visible'],
    ['post-dispatch action', provenPreActionabilityLog + '\n - performing click action'],
    ['explicit dispatched action', provenPreActionabilityLog + '\n - click done'],
    ['actual Playwright click completion', provenPreActionabilityLog + '\n - click action done'],
    ['late click progression', provenPreActionabilityLog + '\n - scrolling into view'],
  ] as const)('never retries or clears an unproven Playwright first action: %s (#2487)', async (_label, message) => {
    const invocationId = randomUUID();
    const prompt = 'PROMPT-2487-UNPROVEN-LOG';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    turn.sendButton.click.mockRejectedValueOnce(timeoutError(message));

    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, invocationId + '-log-guard.txt'), '90000', invocationId,
    );
    expect(outcome.result).toMatchObject({ send_count: 0, send_attempted: true, state: 'observation_uncertain' });
    expectPossibleEffect(outcome.result);
    expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
    expect(turn.getSends()).toBe(0);
    expect(turn.composer.fill).not.toHaveBeenLastCalledWith('', expect.anything());
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(turn.getComposerText()).toContain(prompt);
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('dispatching');
  });

  it.each(['marker_changed', 'user_baseline_changed', 'user_baseline_incomplete'] as const)(
    'rejects an individually invalid first-click retry DOM guard: %s (#2487)',
    async (scenario) => {
      const invocationId = randomUUID();
      const prompt = 'PROMPT-2487-DOM-GUARD';
      mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
      const turn = makeLoserPage(prompt, 'UNREACHED');
      const baselineLocator = turn.page.locator.getMockImplementation()!;
      let afterFirst = false;
      turn.page.locator.mockImplementation((selector: string) => {
        if (afterFirst && selector === MESSAGE_NODE_SELECTOR) {
          if (scenario === 'user_baseline_changed') {
            return collectionLocator([{ role: 'user', text: 'UNRELATED USER ENTRY' }]);
          }
          if (scenario === 'user_baseline_incomplete') {
            return scalarLocator({
              count: vi.fn(async () => { throw new Error('synthetic incomplete user census'); }),
            });
          }
        }
        return baselineLocator(selector);
      });
      turn.sendButton.click.mockImplementationOnce(async () => {
        afterFirst = true;
        if (scenario === 'marker_changed') await turn.composer.fill('FOREIGN EDITED DRAFT');
        throw timeoutError();
      });

      const outcome = await runNewChatTurn(
        turn.page, join(stateDir, invocationId + '-dom-guard.txt'), '90000', invocationId,
      );
      expect(outcome.result).toMatchObject({ send_count: 0, send_attempted: true, state: 'observation_uncertain' });
      expectPossibleEffect(outcome.result);
      expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
      expect(turn.getSends()).toBe(0);
      expect(turn.page.close).not.toHaveBeenCalled();
      if (scenario === 'marker_changed') expect(turn.getComposerText()).toBe('FOREIGN EDITED DRAFT');
      else expect(turn.getComposerText()).toContain(prompt);
      expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('dispatching');
    },
  );

  it('forbids retry after the original page identity changes during first click (#2487)', async () => {
    const invocationId = randomUUID();
    const prompt = 'PROMPT-2487-PAGE-IDENTITY';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    let foreign = false;
    const originalUrl = turn.page.url.getMockImplementation()!;
    turn.page.url.mockImplementation(() => foreign ? OTHER_PROJECT_CONVERSATION_URL : originalUrl());
    turn.sendButton.click.mockImplementationOnce(async () => { foreign = true; throw timeoutError(); });

    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, invocationId + '-page-identity.txt'), '90000', invocationId,
    );
    // The Page changed after onDispatch, so preserve the post-dispatch
    // failure classification and foreign-Page cleanup refusal, not a pre-Send error.
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch', send_count: 0, send_attempted: true,
      cause: 'helper_error_after_send_page_retained', cleanup: 'unconfirmed',
    });
    expect(outcome.result.incidents).toContain('helper_failure_after_send');
    expect(outcome.result.incidents).not.toContain('helper_failure_before_send');
    expectPossibleEffect(outcome.result);
    expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('dispatching');
  });

  it('does not close a created Page redirected to a foreign conversation after Send', async () => {
    const invocationId = randomUUID();
    const prompt = 'PROMPT-FOREIGN-POST-SEND-REDIRECT';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'REPLY-NOT-OWNED-AT-SETTLEMENT');
    const originalUrl = turn.page.url.getMockImplementation()!;
    const originalLocator = turn.page.locator.getMockImplementation()!;
    let redirected = false;
    turn.page.url.mockImplementation(() => redirected ? OTHER_PROJECT_CONVERSATION_URL : originalUrl());
    turn.page.locator.mockImplementation((selector: string) => {
      const locator = originalLocator(selector);
      if (selector === MESSAGE_NODE_SELECTOR && turn.getSends() === 1
        && turn.getObservationReads() >= 4) redirected = true;
      return locator;
    });

    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, 'foreign-after-send-2510.txt'), '90000', invocationId,
    );
    expect(redirected).toBe(true);
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'owned_conversation_identity_mismatch',
      send_count: 1,
      cleanup: 'unconfirmed',
    });
    expect(turn.getSends()).toBe(1);
    expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(deriveDelivery({
      ...outcome.result,
      resolved_send_count: outcome.result.send_count,
    }, false)).toBe('POSSIBLY_DELIVERED');
    expect(outcome.code).not.toBe(0);
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).not.toBe('not_sent');
  });

  it('allows the proven non-dispatch retry after the reservation is replaced (#2505)', async () => {
    clearSendSlotDisableEnv();
    const invocationId = randomUUID();
    const prompt = 'PROMPT-2487-OWNER-IDENTITY';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    const { acquireDomainLock } = await import('./coordination.ts');
    let replaced = false;
    vi.mocked(acquireDomainLock).mockReturnValueOnce({
      isOwned: () => !replaced,
      release: vi.fn(() => { if (replaced) throw new Error('lock_ownership_lost'); }),
    } as any);
    turn.sendButton.click.mockImplementationOnce(async () => {
      replaced = true;
      throw timeoutError();
    });

    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, invocationId + '-owner-identity.txt'), '90000', invocationId,
    );
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(turn.sendButton.click).toHaveBeenCalledTimes(2);
    expect(turn.getSends()).toBe(1);
  });

  it('never makes a third attempt after even an affirmative second pre-actionability timeout (#2487)', async () => {
    const invocationId = randomUUID();
    const prompt = 'PROMPT-2487-TWO-TIMEOUTS';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    turn.sendButton.click.mockImplementationOnce(async () => { throw timeoutError(); });
    turn.sendButton.click.mockImplementationOnce(async () => { throw timeoutError(); });

    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, invocationId + '-second-final.txt'), '90000', invocationId,
    );
    expect(outcome.result).toMatchObject({ send_count: 0, send_attempted: true, state: 'observation_uncertain' });
    expectPossibleEffect(outcome.result);
    expect(turn.sendButton.click).toHaveBeenCalledTimes(2);
    expect(turn.getSends()).toBe(0);
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(turn.getComposerText()).toContain(prompt);
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('dispatching');
  });

  it('uses a Stop appearing after the first click as delivery, never second-click authority (#2487)', async () => {
    const invocationId = randomUUID();
    const prompt = 'PROMPT-2487-STOP-FIRST';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    let ownedStop = false;
    const originalLocator = turn.page.locator.getMockImplementation()!;
    turn.page.locator.mockImplementation((selector: string) => selector.includes(STOP_BUTTON_TESTID)
      ? scalarLocator({
        count: vi.fn(async () => ownedStop ? 1 : 0),
        isVisible: vi.fn(async () => ownedStop),
      })
      : originalLocator(selector));
    turn.sendButton.click.mockImplementationOnce(async () => {
      ownedStop = true;
      throw timeoutError();
    });

    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, invocationId + '-stop-first.txt'), '90000', invocationId,
    );
    expect(outcome.result.send_count).toBe(1);
    expectPossibleEffect(outcome.result);
    expect(outcome.result.cause).not.toBe('fresh_conversation_landing_mismatch');
    expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(outcome.result.cleanup).toBe('unconfirmed');
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase)
      .toMatch(/sent_unbound|sent_unharvested/);
  });

  it('attributes Stop after the permitted second click as delivery without cleanup or third attempt (#2487)', async () => {
    const invocationId = randomUUID();
    const prompt = 'PROMPT-2487-STOP-SECOND';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    let ownedStop = false;
    const originalLocator = turn.page.locator.getMockImplementation()!;
    turn.page.locator.mockImplementation((selector: string) => selector.includes(STOP_BUTTON_TESTID)
      ? scalarLocator({
        count: vi.fn(async () => ownedStop ? 1 : 0),
        isVisible: vi.fn(async () => ownedStop),
      })
      : originalLocator(selector));
    turn.sendButton.click.mockImplementationOnce(async () => { throw timeoutError(); });
    turn.sendButton.click.mockImplementationOnce(async () => { ownedStop = true; });

    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, invocationId + '-stop-second.txt'), '90000', invocationId,
    );
    expect(outcome.result.send_count).toBe(1);
    expectPossibleEffect(outcome.result);
    expect(outcome.result.cause).not.toBe('fresh_conversation_landing_mismatch');
    expect(outcome.result.poll_count).toBeGreaterThan(0);
    expect(turn.sendButton.click).toHaveBeenCalledTimes(2);
    expect(turn.getSends()).toBe(0);
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(outcome.result.cleanup).toBe('unconfirmed');
    expect(turn.composer.fill).not.toHaveBeenLastCalledWith('', expect.anything());
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase)
      .toMatch(/sent_unbound|sent_unharvested/);
  });

  it('does not attribute a foreign Stop visible before the new-chat send (#2487)', async () => {
    const invocationId = randomUUID();
    const prompt = 'PROMPT-2487-FOREIGN-STOP';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    const originalLocator = turn.page.locator.getMockImplementation()!;
    turn.page.locator.mockImplementation((selector: string) => selector.includes(STOP_BUTTON_TESTID)
      ? scalarLocator({ count: vi.fn(async () => 1), isVisible: vi.fn(async () => true) })
      : originalLocator(selector));

    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, invocationId + '-foreign-stop.txt'), '90000', invocationId,
    );
    expect(outcome.result).toMatchObject({
      state: 'conversation_busy', send_count: 0, cause: 'fresh_conversation_busy_before_send',
    });
    expect(turn.sendButton.click).not.toHaveBeenCalled();
    expect(turn.getSends()).toBe(0);
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('not_sent');
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

  it('permits an ordinary unowned fresh send when the terminal locator is absent', async () => {
    expect(process.env.ORCA_TERMINAL_HANDLE).toBeUndefined();
    const invocationId = randomUUID();
    const prompt = 'PROMPT-UNOWNED';
    const reply = 'UNOWNED-OK';
    const output = join(stateDir, 'unowned-fresh-reply.txt');
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const ordinary = makeLoserPage(prompt, reply);
    const outcome = await runNewChatTurn(ordinary.page, output, '90000', invocationId);

    expect(outcome).toMatchObject({ code: 0, result: { state: 'ok', send_count: 1 } });
    expect(ordinary.getSends()).toBe(1);
    expect(readFileSync(output, 'utf8')).toBe(reply);
    const observation = readStateLightTurnObservation('collision-profile', invocationId);
    expect(observation).toMatchObject({ invocation_id: invocationId, send_count: 1 });
    expect(observation).not.toHaveProperty('owner');
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

  it('dispatches a late-mounted fresh composer after commit without DCL', async () => {
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-LATE'));
    const solo = makeLoserPage('PROMPT-LATE', 'LATE-OK');
    solo.composer.count.mockImplementation(async () => mocks.nowMs >= 30_000 ? 1 : 0);
    const outcome = await runNewChatTurn(solo.page, '/tmp/late-fresh.txt', '120000');
    expect(outcome.result.send_count).toBe(1);
    expect(solo.getSends()).toBe(1);
    expect(solo.page.goto).toHaveBeenCalledWith(projectConversationPrefix(PROJECT_URL), expect.objectContaining({
      waitUntil: 'commit',
      timeout: expect.any(Number),
    }));
    expect(mocks.nowMs).toBeGreaterThanOrEqual(30_000);
  });

  it('dispatches an existing-chat composer mounted 20 seconds after commit without DCL', async () => {
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-LATE-EXISTING'));
    const owned = makeLoserPage('PROMPT-LATE-EXISTING', 'LATE-EXISTING-OK', undefined, true);
    owned.composer.count.mockImplementation(async () => mocks.nowMs >= 30_000 ? 1 : 0);
    enqueueBrowserForTurn(mocks, owned.page);
    const outcome = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--invocation-id', randomUUID(),
      '--output', '/tmp/late-existing.txt',
      '--chat-url', SHARED_CONV,
      '--timeout-ms', '60000',
      '--poll-ms', '1',
    ]);
    expect(owned.page.goto).toHaveBeenCalledWith(SHARED_CONV, expect.objectContaining({
      waitUntil: 'commit',
      timeout: expect.any(Number),
    }));
    expect(outcome.result.send_count).toBe(1);
    expect(owned.getSends()).toBe(1);
    expect(mocks.nowMs).toBeGreaterThanOrEqual(30_000);
  });

  it('rejects a late foreign-project redirect after composer mutation, before fresh dispatch', async () => {
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-REDIRECT'));
    const solo = makeLoserPage('PROMPT-REDIRECT', 'SHOULD-NOT-SEND');
    const initialUrl = solo.page.url.getMockImplementation()!;
    let redirected = false;
    solo.page.url.mockImplementation(() => redirected ? OTHER_PROJECT_CONVERSATION_URL : initialUrl());
    solo.composer.fill.mockImplementation(async () => { redirected = true; });
    const outcome = await runNewChatTurn(solo.page, '/tmp/late-redirect-fresh.txt');
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'fresh_conversation_surface_unavailable',
      send_count: 0,
    });
    expect(solo.getSends()).toBe(0);
    expect(redirected).toBe(true);
  });

  it('rejects a late foreign existing-chat redirect after readiness and baseline', async () => {
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-REDIRECT'));
    const solo = makeLoserPage('PROMPT-REDIRECT', 'SHOULD-NOT-SEND', undefined, true);
    const initialUrl = solo.page.url.getMockImplementation()!;
    let redirected = false;
    solo.page.url.mockImplementation(() => redirected ? LOSER_CONV : initialUrl());
    const originalFill = solo.composer.fill.getMockImplementation()!;
    solo.composer.fill.mockImplementation(async (...args) => {
      await originalFill(...args);
      redirected = true;
    });
    enqueueBrowserForTurn(mocks, solo.page);
    const outcome = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--invocation-id', randomUUID(),
      '--output', '/tmp/late-redirect-existing.txt',
      '--chat-url', SHARED_CONV,
      '--timeout-ms', '60000',
      '--poll-ms', '1',
    ]);
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'owned_conversation_identity_mismatch',
      send_count: 0,
    });
    expect(solo.getSends()).toBe(0);
    expect(redirected).toBe(true);
  });

  it('rejects an existing-chat redirect during the final pre-send alert probe', async () => {
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-ALERT-REDIRECT'));
    const solo = makeLoserPage('PROMPT-ALERT-REDIRECT', 'SHOULD-NOT-SEND', undefined, true);
    const initialUrl = solo.page.url.getMockImplementation()!;
    let redirected = false;
    solo.page.url.mockImplementation(() => redirected ? LOSER_CONV : initialUrl());
    solo.page.evaluate = vi.fn(async () => { redirected = true; });
    enqueueBrowserForTurn(mocks, solo.page);
    const outcome = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--invocation-id', randomUUID(),
      '--output', '/tmp/late-alert-redirect-existing.txt',
      '--chat-url', SHARED_CONV,
      '--timeout-ms', '60000',
      '--poll-ms', '1',
    ]);
    expect(solo.page.evaluate).toHaveBeenCalledTimes(1);
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'owned_conversation_identity_mismatch',
      send_count: 0,
    });
    expect(solo.getSends()).toBe(0);
  });

  it('rejects a fresh-project redirect during the final pre-send alert probe', async () => {
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-ALERT-REDIRECT'));
    const solo = makeLoserPage('PROMPT-ALERT-REDIRECT', 'SHOULD-NOT-SEND');
    const initialUrl = solo.page.url.getMockImplementation()!;
    let redirected = false;
    solo.page.url.mockImplementation(() => redirected ? OTHER_PROJECT_CONVERSATION_URL : initialUrl());
    solo.page.evaluate = vi.fn(async () => { redirected = true; });
    const outcome = await runNewChatTurn(solo.page, '/tmp/late-alert-redirect-fresh.txt');
    expect(solo.page.evaluate).toHaveBeenCalledTimes(1);
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'fresh_conversation_surface_unavailable',
      send_count: 0,
    });
    expect(solo.getSends()).toBe(0);
  });

  it('uses the remaining absolute budget for a committed project goto', async () => {
    let url = SHARED_CONV;
    const navigation = new StateLightNavigationCounter();
    const goto = vi.fn(async (target: string) => { url = target; });
    const page = {
      url: () => url,
      goto,
      locator: () => scalarLocator({ count: vi.fn(async () => 0) }),
    };
    await openBlankProjectChatSurface(page, PROJECT_URL, navigation, mocks.nowMs + 900, () => mocks.nowMs);
    expect(goto).toHaveBeenCalledWith(projectConversationPrefix(PROJECT_URL), {
      waitUntil: 'commit',
      timeout: 900,
    });
    expect(navigation.snapshotGoto()).toBe(1);
  });

  it('stops at the same deadline after commit without starting wall or locator work', async () => {
    const deadline = mocks.nowMs + 1;
    let url = SHARED_CONV;
    const goto = vi.fn(async (target: string) => {
      url = target;
      mocks.nowMs = deadline;
    });
    const locator = vi.fn(() => scalarLocator({ count: vi.fn(async () => 0) }));
    const page = { url: () => url, goto, locator };
    const prepared = await prepareStateLightFreshConversation(
      page,
      { newChat: true, projectUrl: PROJECT_URL, timeoutMs: 60_000 } as uiAdapter.BrowserConfig,
      'collision-profile', 'near-expiry', new StateLightNavigationCounter(),
      deadline, () => mocks.nowMs,
    );
    expect(prepared).toMatchObject({ state: 'ui_contract_mismatch', cause: 'fresh_conversation_surface_unavailable' });
    expect(goto).toHaveBeenCalledTimes(1);
    expect(locator).not.toHaveBeenCalled();
    expect(mocks.productStatusText).not.toHaveBeenCalled();
  });

  it('ignores an unresolved new-chat control count and starts no click or retry', async () => {
    const navigation = new StateLightNavigationCounter();
    let url = SHARED_CONV;
    const goto = vi.fn(async (target: string) => { url = target; });
    const count = vi.fn(() => new Promise<number>(() => {}));
    const click = vi.fn(async () => undefined);
    const locator = vi.fn(() => ({ first: () => ({ count, click }) }));
    const page = { url: () => url, goto, locator };
    const prepared = await prepareStateLightFreshConversation(
      page,
      { newChat: true, projectUrl: PROJECT_URL, timeoutMs: 60_000 } as uiAdapter.BrowserConfig,
      'collision-profile', 'unresolved-locator', navigation,
      mocks.nowMs + 30, () => mocks.nowMs,
    );
    expect(prepared).toEqual({ state: 'ready' });
    expect(count).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(locator).not.toHaveBeenCalled();
    expect(goto).toHaveBeenCalledTimes(1);
    expect(navigation.snapshotNewChatClick()).toBe(0);
    expect(mocks.productStatusText).not.toHaveBeenCalled();
  });

  it('recovers from one observed pre-Send network navigation error on the same owned Page', async () => {
    const prompt = 'PROMPT-2541-ONE-NETWORK-OPEN-RETRY';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const solo = makeLoserPage(prompt, 'RECOVERED-SEND');
    solo.page.goto.mockRejectedValueOnce(new Error('page.goto: net::ERR_NETWORK_CHANGED'));
    const outcome = await runNewChatTurn(solo.page, join(stateDir, 'one-network-reopen.txt'));
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(solo.page.goto).toHaveBeenCalledTimes(2);
    expect(solo.getSends()).toBe(1);
  });

  it('classifies two observed network-changed navigation errors without attempting Send', async () => {
    const solo = makeLoserPage('PROMPT', 'SHOULD-NOT-SEND');
    solo.page.goto.mockRejectedValueOnce(new Error('page.goto: net::ERR_NETWORK_CHANGED'));
    solo.page.goto.mockRejectedValueOnce(new Error('page.goto: net::ERR_NETWORK_CHANGED'));
    const outcome = await runNewChatTurn(solo.page, join(stateDir, 'twice-network-changed.txt'));
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch', cause: 'network_changed', send_count: 0,
    });
    expect(solo.page.goto).toHaveBeenCalledTimes(2);
    expect(solo.getSends()).toBe(0);
  });

  it('keeps a failed no-commit navigation at zero send', async () => {
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-NOCOMMIT'));
    const solo = makeLoserPage('PROMPT-NOCOMMIT', 'SHOULD-NOT-SEND');
    solo.page.goto.mockRejectedValueOnce(new Error('page.goto: Timeout while waiting for commit'));
    solo.page.goto.mockRejectedValueOnce(new Error('page.goto: Timeout while waiting for commit'));
    const outcome = await runNewChatTurn(solo.page, '/tmp/no-commit.txt');
    expect(outcome.result.send_count).toBe(0);
    expect(outcome.result.state).not.toBe('ok');
    expect(solo.page.goto).toHaveBeenCalledTimes(2);
    expect(solo.getSends()).toBe(0);
  });

  it('continues a fresh send when a usage-remaining banner leaves the composer usable', async () => {
    const actual = await vi.importActual<typeof import('./ui-adapter.ts')>('./ui-adapter.ts');
    const classifier = vi.mocked(uiAdapter.classifyProductWall);
    const previousImplementation = classifier.getMockImplementation();
    classifier.mockImplementation(actual.classifyProductWall);
    try {
      mocks.productStatusText.mockResolvedValue({
        text: 'You have 20% usage remaining',
        composer: true,
        parts: [{ selector: '[role="alert"]', text: 'You have 20% usage remaining' }],
      });
      mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-REMAINING'));
      const solo = makeLoserPage('PROMPT-REMAINING', 'REMAINING-OK');
      const outcome = await runNewChatTurn(solo.page, '/tmp/remaining-warning.txt');

      expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
      expect(solo.getSends()).toBe(1);
      expect(readStateLightAdvisoryWall('collision-profile')).toBeNull();
    } finally {
      classifier.mockImplementation(previousImplementation ?? (() => ({})));
    }
  });

  it('reports a pre-send rate-limit status as advisory while still sending once', async () => {
    const actual = await vi.importActual<typeof import('./ui-adapter.ts')>('./ui-adapter.ts');
    vi.mocked(uiAdapter.classifyProductWall).mockImplementation(actual.classifyProductWall);
    mocks.productStatusText.mockResolvedValue({
      text: 'temporarily limited access',
      composer: false,
      parts: [{ selector: '[role="alert"]', text: 'temporarily limited access' }],
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-SOLO'));
    const solo = makeLoserPage('PROMPT-SOLO', 'SOLO-OK');
    const outcome = await runNewChatTurn(solo.page, '/tmp/rate-limit-prepare.txt');

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'ok',
      send_count: 1,
      product_wall_diagnostic: {
        wall_kind: 'rate_limit',
        matched_text: 'temporarily limited access',
        matched_selector: '[role="alert"]',
      },
    });
    expect(solo.getSends()).toBe(1);
    expect(readStateLightAdvisoryWall('collision-profile')).toMatchObject({
      state: 'rate_limit',
      matched_text: 'temporarily limited access',
      matched_selector: '[role="alert"]',
    });
  });

  // Drive a real held-Page request witness while DOM and owner URL lag behind the click.
  function countedOwnPostWithLateFreshUrl(prompt: string, reply: string, urlDelayMs: number, composerStays: boolean) {
    const turn = makeLoserPage(prompt, reply);
    const events = new EventEmitter();
    turn.page.on = events.on.bind(events);
    turn.page.off = events.off.bind(events);
    let submittedText = '';
    let sendAt = -1;
    turn.composer.fill.mockImplementation(async (text: string) => { submittedText = text; });
    turn.composer.innerText.mockImplementation(async () => composerStays || sendAt < 0 ? submittedText : '');
    turn.composer.textContent.mockImplementation(async () => composerStays || sendAt < 0 ? submittedText : '');
    const originalClick = turn.sendButton.click.getMockImplementation()!;
    turn.sendButton.click.mockImplementation(async () => {
      await originalClick();
      sendAt = mocks.nowMs;
      const request = {
        method: () => 'POST',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        postData: () => JSON.stringify({
          messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: [submittedText] } }],
        }),
      };
      events.emit('request', request);
      events.emit('request', request); // Repeated observation of one physical request.
      events.emit('response', { request: () => request, status: () => 200 });
    });
    turn.page.url.mockImplementation(() => sendAt >= 0 && mocks.nowMs - sendAt >= urlDelayMs
      ? SHARED_CONV : PROJECT_URL);
    const originalLocator = turn.page.locator.getMockImplementation()!;
    turn.page.locator.mockImplementation((selector: string) =>
      sendAt >= 0 && mocks.nowMs - sendAt < urlDelayMs
        && (selector === MESSAGE_NODE_SELECTOR || selector === USER_MESSAGE_SELECTOR)
        ? collectionLocator([]) : originalLocator(selector));
    return { turn, sentAt: () => sendAt };
  }

  it.each([
    { site: 'early', urlDelayMs: 1_200, boundary: 'before', offset: -1, admitted: true },
    { site: 'early', urlDelayMs: 1_200, boundary: 'after', offset: 1, admitted: false },
    { site: 'post', urlDelayMs: 43_000, boundary: 'before', offset: -1, admitted: true },
    { site: 'post', urlDelayMs: 43_000, boundary: 'after', offset: 1, admitted: false },
  ])('AC2 claim-time cutoff $boundary the bounded $site original Page census', async ({ site, urlDelayMs, boundary, offset, admitted }) => {
    const invocationId = randomUUID();
    const prompt = 'ISSUE-2660-CLAIM-TIME-' + site + '-' + boundary;
    const output = join(stateDir, invocationId + '-claim-race.txt');
    const cutoff = mocks.nowMs + 180_000 - 5_000 - 15_000 - 2_000;
    const { turn } = countedOwnPostWithLateFreshUrl(prompt, 'CLAIM-TIME-ANSWER', urlDelayMs, true);
    const originalLocator = turn.page.locator.getMockImplementation()!;
    let clockChangedInRead = false;
    turn.page.locator.mockImplementation((selector: string) => {
      const locator = originalLocator(selector);
      if ((selector !== USER_MESSAGE_SELECTOR && selector !== MESSAGE_NODE_SELECTOR) || turn.getSends() < 1) return locator;
      const originalNth = locator.nth.bind(locator);
      locator.nth = vi.fn((index: number) => {
        const row = originalNth(index);
        const originalInnerText = row.innerText.bind(row);
        row.innerText = vi.fn(async (...args: any[]) => {
          const text = await originalInnerText(...args);
          if (!clockChangedInRead && text.includes(TEST_OWNED_MARKER) && mocks.nowMs < cutoff) {
            mocks.nowMs = cutoff + offset;
            clockChangedInRead = true;
          }
          return text;
        });
        return row;
      });
      return locator;
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(turn.page, output, '180000', invocationId);
    expect(clockChangedInRead).toBe(true);
    expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
    expect(turn.getSends()).toBe(1);
    expect(outcome.result.send_count).toBe(1);
    // Both before and after the old URL subwindow, the original Page's
    // unique user marker and revalidated complete successor can publish.
    // A late URL may remain optional rather than becoming Send authority.
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(readFileSync(output, 'utf8')).toBe('CLAIM-TIME-ANSWER');
    if (admitted) expect(outcome.result.conversation_id).toBe(SHARED_CONV);
    else expect(turn.page.goto).toHaveBeenCalledTimes(1); // No preclaim navigation.
  });

  it('Issue #2636 review source-01: counted own POST with unchanged composer survives early fresh URL wait', async () => {
    const invocationId = randomUUID();
    const prompt = 'D46-COUNTED-STILL-DRAFT';
    const reply = 'D46-COUNTED-LATE-OWNER-ANSWER';
    const output = join(stateDir, invocationId + '-counted-still-draft.txt');
    const { turn, sentAt } = countedOwnPostWithLateFreshUrl(prompt, reply, 43_000, true);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));

    const outcome = await runNewChatTurn(turn.page, output, '180000', invocationId);
    expect(sentAt()).toBeGreaterThanOrEqual(0);
    expect(mocks.nowMs - sentAt()).toBeGreaterThanOrEqual(43_000);
    expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
    expect(turn.getSends()).toBe(1);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1, conversation_id: SHARED_CONV });
    expect(readStateLightTurnObservation('collision-profile', invocationId))
      .toMatchObject({ phase: 'harvested', conversation_url: SHARED_CONV, send_count: 1 });
    expect(readFileSync(output, 'utf8')).toBe(reply);
  });

  it('Issue #2636 review source-03: counted own POST with cleared composer survives post-send landing clock', async () => {
    const invocationId = randomUUID();
    const prompt = 'D46-COUNTED-CLEARED-COMPOSER';
    const reply = 'D46-COUNTED-POST-LOOP-LATE-OWNER';
    const output = join(stateDir, invocationId + '-counted-after-post-loop.txt');
    const { turn, sentAt } = countedOwnPostWithLateFreshUrl(prompt, reply, 78_000, false);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));

    const outcome = await runNewChatTurn(turn.page, output, '180000', invocationId);
    expect(sentAt()).toBeGreaterThanOrEqual(0);
    expect(mocks.nowMs - sentAt()).toBeGreaterThanOrEqual(78_000);
    expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
    expect(turn.getSends()).toBe(1);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1, conversation_id: SHARED_CONV });
    expect(readStateLightTurnObservation('collision-profile', invocationId))
      .toMatchObject({ phase: 'harvested', conversation_url: SHARED_CONV, send_count: 1 });
    expect(readFileSync(output, 'utf8')).toBe(reply);
  });

  it.each(['late-owned', 'permanently-null', 'foreign-project'] as const)(
    'Issue #2636: attempted-zero fresh Send preserves original Page owner through delayed URL (%s)',
    async (scenario) => {
      const invocationId = randomUUID();
      const prompt = 'D46-FRESH-DELAYED-OWNER';
      const reply = 'D46-FRESH-COMPLETE';
      const output = join(stateDir, invocationId + '-d46-fresh.txt');
      const turn = makeLoserPage(prompt, reply);
      let draft = '';
      let sendAt = -1;
      turn.composer.fill.mockImplementation(async (text: string) => { draft = text; });
      // Reproduce the unproved five-second delivery window: Send issued,
      // composer unchanged, transcript unreadable, and no usable own POST.
      turn.composer.innerText.mockImplementation(async () => draft);
      turn.composer.textContent.mockImplementation(async () => draft);
      const originalClick = turn.sendButton.click.getMockImplementation()!;
      turn.sendButton.click.mockImplementation(async () => {
        await originalClick();
        sendAt = mocks.nowMs;
      });
      const markerVisible = () => scenario === 'late-owned'
        && sendAt >= 0 && mocks.nowMs - sendAt >= 36_000;
      turn.page.url.mockImplementation(() => turn.getSends() === 0 || sendAt < 0
        || mocks.nowMs - sendAt < 36_000 || scenario === 'permanently-null'
        ? PROJECT_URL
        : scenario === 'foreign-project' ? OTHER_PROJECT_CONVERSATION_URL : SHARED_CONV);
      const originalLocator = turn.page.locator.getMockImplementation()!;
      turn.page.locator.mockImplementation((selector: string) => {
        if (turn.getSends() > 0
          && (selector === MESSAGE_NODE_SELECTOR || selector === USER_MESSAGE_SELECTOR)
          && !markerVisible()) return collectionLocator([]);
        return originalLocator(selector);
      });
      mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
      const result = await runNewChatTurn(turn.page, output, '180000', invocationId);
      expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
      expect(turn.getSends()).toBe(1);
      const observation = readStateLightTurnObservation('collision-profile', invocationId);
      if (scenario === 'late-owned') {
        expect(mocks.nowMs - sendAt).toBeGreaterThanOrEqual(36_000);
        expect(result.result).toMatchObject({
          state: 'ok', send_count: 1, conversation_id: SHARED_CONV,
        });
        expect(observation).toMatchObject({
          phase: 'harvested', conversation_url: SHARED_CONV, send_count: 1,
        });
        expect(readFileSync(output, 'utf8')).toBe(reply);
      } else {
        expect(result.result.state).not.toBe('ok');
        expect(result.result.send_count).toBe(0);
        expect(result.result.send_attempted).toBe(true);
        expect(result.result).not.toHaveProperty('conversation_id');
        expect(observation).toMatchObject({
          phase: 'dispatching', send_witness: 'none', conversation_url: null,
        });
        expect(existsSync(output)).toBe(false);
        expect(deriveDelivery({ ...result.result,
          resolved_send_count: result.result.send_count } as any, false)).toBe('POSSIBLY_DELIVERED');
      }
    },
  );

  it('Issue #2636 review source-01: attempted-zero foreign fresh Page never clicks Continue Generating', async () => {
    const invocationId = randomUUID();
    const prompt = 'D46-UNBOUND-FOREIGN-CONTINUE';
    const output = join(stateDir, invocationId + '-foreign-continue.txt');
    const turn = makeLoserPage(prompt, 'INCOMPLETE-FOREIGN-REPLY');
    let sentAt = -1;
    let composerText = '';
    turn.composer.fill.mockImplementation(async (text: string) => { composerText = text; });
    turn.composer.innerText.mockImplementation(async () => composerText);
    turn.composer.textContent.mockImplementation(async () => composerText);
    const originalClick = turn.sendButton.click.getMockImplementation()!;
    turn.sendButton.click.mockImplementation(async () => {
      await originalClick();
      sentAt = mocks.nowMs;
    });
    const visible = () => sentAt >= 0 && mocks.nowMs - sentAt >= 36_000;
    turn.page.url.mockImplementation(() => sentAt < 0 ? PROJECT_URL : OTHER_PROJECT_CONVERSATION_URL);
    const continueClick = vi.fn(async () => undefined);
    const continueControl = scalarLocator({ count: vi.fn(async () => 1), click: continueClick });
    const assistantTurn = scalarLocator({ getByRole: vi.fn(() => continueControl) });
    const assistantNode = scalarLocator({
      locator: vi.fn((selector: string) => selector === ASSISTANT_TURN_ANCESTOR_XPATH
        ? scalarLocator({ first: vi.fn(() => assistantTurn) })
        : scalarLocator()),
    });
    const ownedUser = { role: 'user' as const, text: `${TEST_OWNED_MARKER}\n\n${prompt}` };
    const incompleteAssistant = { role: 'assistant' as const, text: 'INCOMPLETE-FOREIGN-REPLY' };
    const messages = [ownedUser, incompleteAssistant];
    const atomicNodes = Object.assign(collectionLocator(messages), {
      evaluateAll: vi.fn(async () => ({
        rows: [
          { role: 'user', text: ownedUser.text, key: 'data-message-id:d46-foreign-user', domIndex: 0,
            complete: true, completionReady: false, continuationVisible: false },
          { role: 'assistant', text: incompleteAssistant.text, key: 'data-message-id:d46-foreign-assistant', domIndex: 1,
            complete: true, completionReady: false, continuationVisible: true },
        ],
        pageTurnEvidence: {
          generationInProgress: false, observedAssistantNodes: 1, continueGeneratingVisible: true,
        },
      })),
      nth: vi.fn((index: number) => index === 1 ? assistantNode : messageLocator(ownedUser)),
    });
    const originalLocator = turn.page.locator.getMockImplementation()!;
    turn.page.locator.mockImplementation((selector: string) => {
      if (!visible()) {
        if (selector === MESSAGE_NODE_SELECTOR || selector === USER_MESSAGE_SELECTOR) return collectionLocator([]);
      } else {
        if (selector === MESSAGE_NODE_SELECTOR) return atomicNodes;
        if (selector === USER_MESSAGE_SELECTOR) return collectionLocator([ownedUser]);
      }
      return originalLocator(selector);
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));

    const result = await runNewChatTurn(turn.page, output, '90000', invocationId);
    const observed = await readPageObservation(turn.page, TEST_OWNED_MARKER);
    expect(observed.snapshot.carriers[1]?.continuationVisible).toBe(true);
    expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
    expect(turn.getSends()).toBe(1);
    expect(continueClick).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({
      state: 'observation_uncertain', cause: 'fresh_conversation_owner_unproven',
      send_count: 0, send_attempted: true,
    });
    expect(result.result).not.toHaveProperty('conversation_id');
    expect(readStateLightTurnObservation('collision-profile', invocationId))
      .toMatchObject({ phase: 'dispatching', send_witness: 'none', conversation_url: null });
    expect(existsSync(output)).toBe(false);
  });

  it('Issue #2636: post-onDispatch network-change cannot become a pre-Send helper failure', async () => {
    const invocationId = randomUUID();
    const prompt = 'D46-POST-DISPATCH-ERROR';
    const turn = makeLoserPage(prompt, 'UNREACHED');
    turn.sendButton.click.mockRejectedValueOnce(new Error('locator.click: Timeout 5000ms exceeded'));
    const beforeWait = turn.page.waitForTimeout.getMockImplementation()!;
    turn.page.waitForTimeout.mockImplementation(async (ms: number) => {
      if (turn.sendButton.click.mock.calls.length > 0) {
        throw new Error('net::ERR_NETWORK_CHANGED');
      }
      return beforeWait(ms);
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const result = await runNewChatTurn(
      turn.page, join(stateDir, invocationId + '-post-dispatch-error.txt'), '90000', invocationId,
    );
    expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
    expect(result.result).toMatchObject({ state: 'driver_error', send_count: 0, send_attempted: true });
    expect(result.result.incidents).toContain('helper_failure_after_send');
    expect(result.result.incidents).not.toContain('helper_failure_before_send');
    expect(readStateLightTurnObservation('collision-profile', invocationId))
      .toMatchObject({ phase: 'dispatching', send_witness: 'none', conversation_url: null });
    expect(deriveDelivery({ ...result.result,
      resolved_send_count: result.result.send_count } as any, false)).toBe('POSSIBLY_DELIVERED');
  });

  it('continues observing after fresh-conversation URL wait expiry without send_failed', async () => {
    const prompt = 'PROMPT-SOLO';
    const reply = 'SOLO-OK';
    let sent = false;
    let composerText = '';
    let url = PROJECT_URL;
    let observationIndex = 0;
    const snapshotFrames = readyTurnObservationFrames(prompt, reply).map((messages, index) => ({
      messages,
      generating: index < 2,
    }));

    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async (value: string) => { composerText = value; }),
      innerText: vi.fn(async () => (sent ? '' : composerText)),
      textContent: vi.fn(async () => (sent ? '' : composerText)),
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
    const output = join(stateDir, 'url-wait-expiry.txt');
    const outcome = await runNewChatTurn(page, output);

    // No UUID/URL wait is needed after the original pinned Page proves its
    // unique user marker and a complete stable assistant successor.
    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.result).not.toHaveProperty('conversation_id');
    expect(readFileSync(output, 'utf8')).toBe(reply);
    expect(outcome.result.incidents).toContain('send_observation_deferred');
  });

  function unrenderedOwnedMessagePage(
    prompt: string,
    reply: string,
    renderAfterReload: boolean,
    ambiguousAssistant = false,
    streamRecoveryAlert: string | false = false,
    replySequence: readonly string[] = [reply],
    continueGeneratingSequence: readonly boolean[] = [],
    observationOverrides: {
      incompleteReads?: readonly number[];
      nonFinalReads?: readonly number[];
      nonFinalFromRead?: number;
      includeOwnedUser?: boolean;
      keyedOwnedMessages?: boolean;
      markerlessOwnedUserFromRead?: number;
      userMarkerlessFromRead?: number;
      assistantCarrierKeysByRead?: readonly string[];
      neverMarkerProof?: boolean;
      assistantCode?: { visible: string; domTextContent: string; secondVisible?: string; firstLanguage?: string; secondLanguage?: string; interleavedProse?: string; standaloneProseFromRead?: number };
    } = {},
  ) {
    const state = { sent: false, url: PROJECT_URL, reloads: 0, reads: 0, composerText: '' };
    const withCarrierKeys = (messages: StateLightTestMessage[]) => observationOverrides.keyedOwnedMessages
      ? messages.map((message) => ({ ...message, key: message.role === 'user' ? 'user-carrier-12345678' : 'assistant-carrier-12345678' }))
      : messages;
    const working = withCarrierKeys(readyTurnObservationFrames(prompt, reply)[0]!)
      .filter((message) => !observationOverrides.neverMarkerProof || message.role !== 'user');
    const final = withCarrierKeys(readyTurnObservationFrames(prompt, reply).at(-1)!)
      .filter((message) => !observationOverrides.neverMarkerProof || message.role !== 'user');
    const assistantOnlyFor = (text: string) => {
      const messages = [
        ...(ambiguousAssistant ? [{ role: 'assistant' as const, text: 'EARLIER ANSWER' }] : []),
        ...(observationOverrides.includeOwnedUser ? final.filter((message: StateLightTestMessage) => message.role === 'user') : []),
        ...final.filter((message: StateLightTestMessage) => message.role === 'assistant')
          .map((message: StateLightTestMessage) => ({ ...message, text })),
      ];
      return observationOverrides.assistantCarrierKeysByRead
        ? messages.map((message) => message.role === 'assistant'
          ? { ...message, key: observationOverrides.assistantCarrierKeysByRead![state.reads - 1] ?? `assistant-carrier-${state.reads}-0000` }
          : message)
        : messages;
    };
    let active: StateLightTestMessage[] = [];
    let generating = false;
    let continuationVisible = false;
    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async (value: string) => { state.composerText = value; }),
      innerText: vi.fn(async () => (state.sent ? '' : state.composerText)),
      textContent: vi.fn(async () => (state.sent ? '' : state.composerText)),
      press: vi.fn(async () => { state.sent = true; state.url = SHARED_CONV; }),
    });
    const sendButton = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => { state.sent = true; state.url = SHARED_CONV; }),
    });
    const page: any = {
      __fakeBrowserGptPage: true,
      goto: vi.fn(async (target: string) => {
        if (state.sent && target === SHARED_CONV) state.reloads += 1;
        state.url = target;
      }),
      url: vi.fn(() => state.url),
      isClosed: vi.fn(() => false),
      waitForTimeout: vi.fn(async (ms: number) => { mocks.nowMs += ms; }),
      close: vi.fn(async () => undefined),
      getByText: vi.fn(() => scalarLocator()),
      getByRole: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return sendButton;
        if (selector === USER_MESSAGE_SELECTOR) {
          return collectionLocator(state.sent && !observationOverrides.neverMarkerProof
            && (observationOverrides.userMarkerlessFromRead === undefined
              || state.reads < observationOverrides.userMarkerlessFromRead)
            ? [{ role: 'user', text: `${TEST_OWNED_MARKER}\n\n${prompt}` }]
            : []);
        }
        if (selector === MESSAGE_NODE_SELECTOR) {
          if (!state.sent) return collectionLocator([]);
          state.reads += 1;
          if (state.reads <= 2) {
            active = working;
            generating = true;
          } else if (state.reloads > 0 && renderAfterReload) {
            active = final;
            generating = false;
          } else {
            active = streamRecoveryAlert ? [] : assistantOnlyFor(replySequence[Math.min(state.reads - 3, replySequence.length - 1)] ?? reply)
              .map((message) => observationOverrides.markerlessOwnedUserFromRead !== undefined
                && state.reads >= observationOverrides.markerlessOwnedUserFromRead
                && message.role === 'user'
                ? { ...message, text: 'markerless rendered user carrier' }
                : message)
              .map((message) => (observationOverrides.nonFinalReads?.includes(state.reads) || state.reads >= (observationOverrides.nonFinalFromRead ?? Number.POSITIVE_INFINITY))
                && message.role === 'assistant'
                ? { ...message, finalActionInTurnContainer: false }
                : message);
            generating = false;
          }
          continuationVisible = continueGeneratingSequence[state.reads - 1] ?? false;
          const loc: any = collectionLocator(active, generating);
          loc.evaluateAll = async (callback: (elements: Element[], args: unknown) => unknown, args: unknown) => {
            const elements = active.map((message: StateLightTestMessage) => ({
              getAttribute: (name: string) => name === MESSAGE_AUTHOR_ROLE_ATTR
                ? (message.role === 'user' ? 'user-message' : 'assistant-message')
                : name === 'data-message-id' ? (message as StateLightTestMessage & { key?: string }).key ?? null : null,
              getBoundingClientRect: () => ({ height: 1 }),
              get innerText() {
                if (observationOverrides.incompleteReads?.includes(state.reads) && message.role === 'assistant') {
                  throw new Error('injected_incomplete_assistant_text');
                }
                return message.text;
              },
              querySelector: (query: string) => {
                if (query === `[${MESSAGE_AUTHOR_ROLE_ATTR}]`) return { getAttribute: () => message.role === 'user' ? 'user-message' : 'assistant-message' };
                if (query.includes('continue-generating') || query.includes('continue_generating')) return continuationVisible ? {} : null;
                if (query === uiAdapter.ASSISTANT_TURN_ACTION_SELECTOR) return message.finalActionInTurnContainer ? {} : null;
                if (query === uiAdapter.ASSISTANT_TURN_IN_PROGRESS_SELECTOR) return generating ? {} : null;
                return null;
              },
              querySelectorAll: (selector: string) => selector === 'pre code' && message.role === 'assistant' && observationOverrides.assistantCode
                ? [{
                  innerText: observationOverrides.assistantCode.visible,
                  textContent: observationOverrides.assistantCode.domTextContent,
                  getBoundingClientRect: () => ({ height: 1 }),
                }]
                : [],
              closest: () => ({
                querySelector: (query: string) => {
                  if (query.includes('continue-generating') || query.includes('continue_generating')) return continuationVisible ? {} : null;
                  if (query === uiAdapter.ASSISTANT_TURN_ACTION_SELECTOR) return message.finalActionInTurnContainer ? {} : null;
                  if (query === uiAdapter.ASSISTANT_TURN_IN_PROGRESS_SELECTOR) return generating ? {} : null;
                  return null;
                },
              }),
            }));
          // Mirror only the rendered DOM primitives used by both production
          // evaluateAll callbacks. The outer parent text intentionally differs
          // from the visible complete code child (#2590 and #2660).
          if (observationOverrides.assistantCode) {
            for (let i = 0; i < elements.length; i++) {
              if (active[i]?.role !== 'assistant') continue;
              const outer = elements[i] as any;
              const doc = { defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) } };
              const node = (tagName: string, innerText: string, attrs: Record<string, string> = {}) => {
                const value: any = {
                  nodeType: 1, tagName, innerText, children: [] as any[], childNodes: [] as any[], parentElement: null,
                  ownerDocument: doc,
                  getClientRects: () => [{}], getBoundingClientRect: () => ({ height: 1 }),
                  getAttribute: (name: string) => attrs[name] ?? null,
                  hasAttribute: (name: string) => Object.hasOwn(attrs, name),
                  querySelectorAll(selector: string): any[] {
                    const matches = (child: any) => selector === 'pre' ? child.tagName === 'PRE'
                      : selector === 'code' ? child.tagName === 'CODE'
                        : selector === '.markdown' ? child.getAttribute('class') === 'markdown'
                          : selector === 'pre code' ? child.tagName === 'CODE' && child.parentElement?.tagName === 'PRE'
                            : false;
                    const descendants = (parent: any): any[] => parent.children.flatMap((child: any) =>
                      [...(matches(child) ? [child] : []), ...descendants(child)]);
                    return descendants(value);
                  },
                  querySelector(selector: string): any { return value.querySelectorAll(selector)[0] ?? null; },
                };
                return value;
              };
              const attach = (parent: any, child: any) => {
                child.parentElement = parent;
                parent.children.push(child);
                parent.childNodes.push(child);
                return child;
              };
              outer.tagName = 'ARTICLE';
              outer.parentElement = null;
              outer.children = [];
              outer.childNodes = [];
              outer.ownerDocument = doc;
              outer.getClientRects = () => [{}];
              outer.hasAttribute = () => false;
              const root = attach(outer, node('DIV', '', { class: 'markdown' }));
              attach(root, node('P', 'Before'));
              const wrapper = attach(root, node('DIV', ''));
              if (observationOverrides.assistantCode.interleavedProse) {
                const proseParent = state.reads >= (observationOverrides.assistantCode.standaloneProseFromRead ?? Infinity)
                  ? root : wrapper;
                attach(proseParent, node('P', observationOverrides.assistantCode.interleavedProse));
              }
              if (observationOverrides.assistantCode.firstLanguage) {
                const header = attach(wrapper, node('HEADER', ''));
                attach(header, node('SPAN', observationOverrides.assistantCode.firstLanguage));
              }
              const pre = attach(wrapper, node('PRE', ''));
              attach(pre, node('CODE', observationOverrides.assistantCode.visible));
              const second = observationOverrides.assistantCode.secondVisible;
              const secondPre = second === undefined ? undefined : (() => {
                attach(root, node('UL', 'Between diff blocks'));
                const sibling = attach(root, node('DIV', ''));
                if (observationOverrides.assistantCode?.secondLanguage) {
                  const header = attach(sibling, node('HEADER', ''));
                  attach(header, node('SPAN', observationOverrides.assistantCode.secondLanguage));
                }
                const next = attach(sibling, node('PRE', ''));
                attach(next, node('CODE', second));
                return next;
              })();
              attach(root, node('P', secondPre ? 'After diff blocks\nEXECUTION_STATUS: complete'
                : 'Following  prose\nEXECUTION_STATUS: complete'));
              const originalQuerySelector = outer.querySelector;
              outer.querySelector = (selector: string) => selector === '.markdown'
                ? root : originalQuerySelector(selector);
              outer.querySelectorAll = (selector: string) => selector === '.markdown'
                ? [root] : selector === 'pre' ? [pre, ...(secondPre ? [secondPre] : [])]
                  : selector === 'pre code' ? [pre, ...(secondPre ? [secondPre] : [])]
                    .flatMap((item) => item.querySelectorAll('code')) : [];
            }
          }
            const previousDocument = (globalThis as { document?: unknown }).document;
            (globalThis as { document?: unknown }).document = {
              querySelectorAll: (query: string) => (query.includes('stop-button') && generating) || ((query.includes('continue-generating') || query.includes('continue_generating')) && continuationVisible) ? [{}] : [],
            };
            try { return callback(elements as unknown as Element[], args); }
            finally {
              if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
              else (globalThis as { document?: unknown }).document = previousDocument;
            }
          };
          return loc;
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          const last = active.at(-1);
          if (last?.finalActionInTurnContainer) return messageLocator(last, generating);
          return scalarLocator({ count: vi.fn(async () => 0) });
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          return collectionLocator(
            active.filter((message: StateLightTestMessage) => message.role === 'assistant'),
            generating,
          );
        }
        if (selector.includes(STOP_BUTTON_TESTID)) {
          return scalarLocator({ count: vi.fn(async () => (generating ? 1 : 0)) });
        }
        if (selector.startsWith('[role="alert"]')) {
          return scalarLocator({
            allInnerTexts: vi.fn(async () => (
              streamRecoveryAlert && state.reads > 2 ? [streamRecoveryAlert] : []
            )),
          });
        }
        return scalarLocator();
      }),
    };
    return { page, state };
  }

  it.each([
    ['locator timeout', 'count', 'browser_operation_timeout:locator_count', 'browser_operation_timeout:locator_count'],
    ['network change', 'evaluate', 'page.evaluate: net::ERR_NETWORK_CHANGED', 'network_changed'],
  ])('reports observed pre-Send %s without dispatching a fresh prompt (#2541 AC4)', async (_kind, source, failure, cause) => {
    const prompt = 'OBSERVED-PRE-SEND-FAILURE';
    const solo = makeLoserPage(prompt, 'SHOULD-NOT-SEND');
    if (source === 'count') solo.composer.count.mockRejectedValue(new Error(failure));
    else solo.composer.evaluate.mockRejectedValue(new Error(failure));
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(
      solo.page, join(stateDir, 'composer-probe-' + randomUUID() + '.txt'), '61000',
    );
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch', cause, send_count: 0,
    });
    expect(solo.getSends()).toBe(0);
    expect(solo.sendButton.click).not.toHaveBeenCalled();
  });

  it.each([
    ['root', 'https://chatgpt.com/c/not-a-uuid'],
    ['project', `${PROJECT_CONVERSATION_ROOT}/c/not-a-uuid`],
    ['legacy', 'https://chat.openai.com/c/11111111-1111-4111-8111-not-a-uuid'],
  ])('refuses a malformed existing-chat UUID on the %s route before navigation or Send (#2541 AC5)', async (_kind, chatUrl) => {
    const output = join(stateDir, 'malformed-' + randomUUID() + '.txt');
    const outcome = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--invocation-id', randomUUID(), '--output', output,
      '--chat-url', chatUrl, '--timeout-ms', '5000',
    ]);
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch', cause: 'chat_not_found', send_count: 0,
    });
    expect(mocks.verifyProfile).not.toHaveBeenCalled();
    expect(mocks.browserQueue).toHaveLength(0);
    expect(existsSync(output)).toBe(false);
  });

  it.each([
    ['root', 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111'],
    ['project', SHARED_CONV],
    ['legacy', 'https://chat.openai.com/c/11111111-1111-4111-8111-111111111111'],
  ])('keeps a canonical %s UUID unconfirmed without inventing chat_not_found (#2541 AC5)', async (_kind, chatUrl) => {
    const prompt = 'CANONICAL-UNCONFIRMED-ID';
    const page = makeLoserPage(prompt, 'NOT-SENT');
    page.page.url.mockReturnValue(chatUrl);
    page.composer.count.mockResolvedValue(0);
    enqueueBrowserForTurn(mocks, page.page);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--invocation-id', randomUUID(),
      '--output', join(stateDir, 'canonical-' + randomUUID() + '.txt'),
      '--chat-url', chatUrl, '--timeout-ms', '5000',
    ]);
    expect(mocks.verifyProfile).toHaveBeenCalled();
    expect(outcome.result.cause).not.toBe('chat_not_found');
    expect(outcome.result.send_count).toBe(0);
    expect(page.getSends()).toBe(0);
  });

  it('bounds the early local-ID landing wait even when the Send witness arrives near the absolute deadline', async () => {
    const prompt = 'SYNTHETIC-NEAR-DEADLINE-LOCAL-ID';
    const invocationId = randomUUID();
    const output = join(stateDir, 'late-local-id-unbound.txt');
    const turn = makeLoserPage(prompt, 'NO-CANONICAL-REPLY', () => { mocks.nowMs += 72_000; });
    turn.page.url.mockImplementation(() => turn.getSends() > 0 ? LOCAL_ID_CONVERSATION_URL : PROJECT_URL);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const start = mocks.nowMs;

    const outcome = await runNewChatTurn(turn.page, output, '90000', invocationId);

    // Even after the old URL-unbound cutoff, a unique own Page marker and
    // finished assistant answer may commit inside the original 90s maximum.
    expect(outcome.result).toMatchObject({
      state: 'ok', cause: 'completed_page_only', send_count: 1,
    });
    expect(mocks.nowMs - start).toBeLessThan(90_000);
    expect(turn.getSends()).toBe(1);
    expect(outcome.result).not.toHaveProperty('conversation_id');
    expect(readFileSync(output, 'utf8')).toBe('NO-CANONICAL-REPLY');
  });

  // The Send fetch can fail while the server executes. Model the owned local
  // page without an assistant answer and without dispatching Retry, then census
  // only already-open canonical server pages using the incumbent recovery path.
  function freshLocalFetchLossFixture(prompt: string, reply?: string) {
    const local = makeLoserPage(prompt, 'NO-LOCAL-ASSISTANT-REPLY');
    proveCreatedPageRemainsVisibleToCdp(local.page);
    const retryClicks = vi.fn(async () => undefined);
    local.page.url.mockImplementation(() => local.getSends() ? LOCAL_ID_CONVERSATION_URL : PROJECT_URL);
    local.page.getByText.mockImplementation((value: string) => value === 'Failed to fetch'
      ? scalarLocator({ count: vi.fn(async () => local.getSends() ? 1 : 0) })
      : scalarLocator());
    local.page.getByRole.mockImplementation((role: string, options?: { name?: string }) =>
      role === 'button' && options?.name === 'Retry'
        ? scalarLocator({ count: vi.fn(async () => local.getSends() ? 1 : 0), click: retryClicks })
        : scalarLocator());
    const localLocator = local.page.locator.getMockImplementation()!;
    local.page.locator.mockImplementation((selector: string) => {
      if (local.getSends() && (
        selector === MESSAGE_NODE_SELECTOR || selector === USER_MESSAGE_SELECTOR
        || selector === ASSISTANT_MESSAGE_SELECTOR
      )) return collectionLocator([]);
      return localLocator(selector);
    });

    let serverPage: any;
    if (reply) {
      serverPage = makeLoserPage(prompt, reply).page;
      serverPage.url.mockReturnValue(SHARED_CONV);
      const completeMessages = readyTurnObservationFrames(prompt, reply).at(-1)!;
      const serverLocator = serverPage.locator.getMockImplementation()!;
      serverPage.locator.mockImplementation((selector: string) => {
        if (selector === MESSAGE_NODE_SELECTOR) return collectionLocator(completeMessages, false);
        if (selector === USER_MESSAGE_SELECTOR) {
          return collectionLocator(completeMessages.filter((message) => message.role === 'user'), false);
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          return collectionLocator(completeMessages.filter((message) => message.role === 'assistant'), false);
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          return messageLocator(completeMessages.at(-1)!, false);
        }
        return serverLocator(selector);
      });
    }
    const harness = enqueueBrowserForTurn(mocks, local.page);
    Object.assign(harness.context, { pages: vi.fn(() => [local.page, ...(serverPage ? [serverPage] : [])]) });
    return {
      local, serverPage, context: harness.context, retryClicks,
      run: async (output: string, invocationId: string) => runStateLightTurnWithStdoutCapture(runStateLightTurn, [
        ...STATE_LIGHT_TURN_BASE_ARGV,
        '--invocation-id', invocationId, '--output', output,
        '--new-chat', '--project-url', PROJECT_URL, '--timeout-ms', '90000', '--poll-ms', '1',
      ]),
    };
  }

  it('binds and harvests after local-ID Failed to fetch when census finds exactly one owned server marker', async () => {
    const prompt = 'SYNTHETIC-LOCAL-FETCH-LOSS-WITH-SERVER-REPLY';
    const reply = 'SERVER-COMPLETED-WHILE-LOCAL-FETCH-FAILED';
    const output = join(stateDir, 'fetch-loss-server-reply.txt');
    const invocationId = randomUUID();
    const fixture = freshLocalFetchLossFixture(prompt, reply);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const start = mocks.nowMs;

    const outcome = await fixture.run(output, invocationId);

    expect(outcome).toMatchObject({ code: 0, result: {
      state: 'ok', send_count: 1, conversation_id: SHARED_CONV,
    } });
    expect(readFileSync(output, 'utf8')).toBe(reply);
    expect(readStateLightTurnObservation('collision-profile', invocationId)).toMatchObject({
      phase: 'harvested', conversation_url: SHARED_CONV, send_count: 1,
    });
    expect(mocks.nowMs - start).toBeLessThan(90_000);
    expect(fixture.local.getSends()).toBe(1);
    expect(fixture.retryClicks).not.toHaveBeenCalled();
    // This legacy recovery fixture has no post-recovery exact CDP re-attach
    // proof for its original local Page. The reply is real, but cleanup must
    // remain unconfirmed instead of closing the recovered or original handle.
    expect(outcome.result.cleanup).toBe('unconfirmed');
    expect(fixture.local.page.close).not.toHaveBeenCalled();
    expect(fixture.serverPage.close).not.toHaveBeenCalled();
  });

  it('closes only the proven-created root /c/local-chatgpt Page after unique positive recovery (#2541 AC7)', async () => {
    const prompt = 'ROOT-LOCAL-ID-POSITIVE';
    const reply = 'ROOT-SERVER-REPLY';
    const fixture = freshLocalFetchLossFixture(prompt, reply);
    const rootLocalUrl = LOCAL_ID_CONVERSATION_URL.replace(PROJECT_CONVERSATION_ROOT, 'https://chatgpt.com');
    fixture.local.page.url.mockImplementation(() => fixture.local.getSends() ? rootLocalUrl : PROJECT_URL);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await fixture.run(join(stateDir, 'root-local-positive.txt'), randomUUID());

    expect(outcome).toMatchObject({ code: 0, result: { state: 'ok', send_count: 1, conversation_id: SHARED_CONV } });
    expect(fixture.local.getSends()).toBe(1);
    expect(outcome.result.cleanup).toBe('unconfirmed'); // no verified exact CDP re-attach
    expect(fixture.local.page.close).not.toHaveBeenCalled();
    expect(fixture.serverPage.close).not.toHaveBeenCalled();
    expect(fixture.retryClicks).not.toHaveBeenCalled();
  });

  it('retains a foreign-project local-ID Page after the positive user-marker claim (#2541 AC9)', async () => {
    const prompt = 'FOREIGN-REDIRECT-AFTER-FETCH-LOSS';
    const fixture = freshLocalFetchLossFixture(prompt, 'OWNED-REPLY');
    const originalServerLocator = fixture.serverPage.locator.getMockImplementation()!;
    const foreignLocalUrl = LOCAL_ID_CONVERSATION_URL.replace(
      PROJECT_CONVERSATION_ROOT,
      'https://chatgpt.com/g/g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-foreign',
    );
    let redirected = false;
    fixture.serverPage.locator.mockImplementation((selector: string) => {
      if (selector === USER_MESSAGE_SELECTOR && !redirected) {
        redirected = true;
        fixture.local.page.url.mockReturnValue(foreignLocalUrl);
      }
      return originalServerLocator(selector);
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await fixture.run(join(stateDir, 'foreign-local-retained.txt'), randomUUID());

    expect(redirected).toBe(true);
    expect(outcome).toMatchObject({ code: 0, result: { state: 'ok', send_count: 1, conversation_id: SHARED_CONV } });
    expect(fixture.local.getSends()).toBe(1);
    expect(fixture.local.page.close).not.toHaveBeenCalled();
    expect(fixture.serverPage.close).not.toHaveBeenCalled();
    expect(fixture.retryClicks).not.toHaveBeenCalled();
  });

  it('retains the original local-ID Page when its Failed to fetch evidence disappears before close (#2541 AC9)', async () => {
    const prompt = 'FETCH-ERROR-VANISHED-BEFORE-CLOSE';
    const fixture = freshLocalFetchLossFixture(prompt, 'OWNED-REPLY');
    const originalGetByText = fixture.local.page.getByText.getMockImplementation()!;
    let fetchFailureReads = 0;
    fixture.local.page.getByText.mockImplementation((value: string, options: unknown) => value === 'Failed to fetch'
      ? scalarLocator({ count: vi.fn(async () => (++fetchFailureReads === 1 ? 1 : 0)) })
      : originalGetByText(value, options));
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await fixture.run(join(stateDir, 'fetch-error-vanished.txt'), randomUUID());

    expect(outcome).toMatchObject({ code: 0, result: { state: 'ok', send_count: 1, conversation_id: SHARED_CONV } });
    // No destructive close is attempted without exact current CDP proof;
    // the earlier failure may disappear after just the initial observation.
    expect(fetchFailureReads).toBeGreaterThanOrEqual(1);
    expect(outcome.result.cleanup).toBe('unconfirmed');
    expect(fixture.local.page.close).not.toHaveBeenCalled();
    expect(fixture.serverPage.close).not.toHaveBeenCalled();
    expect(fixture.retryClicks).not.toHaveBeenCalled();
  });

  it('keeps the full bound-reply observation window after a fresh fetch-loss recovery claim', async () => {
    const prompt = 'SYNTHETIC-RECOVERED-REPLY-OUTLIVES-UNBOUND-CUTOFF';
    const reply = 'RECOVERED-ANSWER-COMPLETED-AFTER-UNBOUND-CUTOFF';
    const output = join(stateDir, 'fetch-loss-late-owned-reply.txt');
    const invocationId = randomUUID();
    const fixture = freshLocalFetchLossFixture(prompt, reply);
    // timeout=90s; the old URL-unbound subwindow ends around 68s.
    // Complete at 70s, still after that cutoff but with space for the
    // bounded full-reply stability/revalidation before the original 90s cap.
    const start = mocks.nowMs;
    const replyReadyAt = start + 70_000;
    const originalLocator = fixture.serverPage.locator.getMockImplementation()!;
    const working = readyTurnObservationFrames(prompt, reply)[0]!;
    let workingReads = 0;
    let completeReads = 0;
    fixture.serverPage.locator.mockImplementation((selector: string) => {
      if (mocks.nowMs < replyReadyAt) {
        if (selector === MESSAGE_NODE_SELECTOR) {
          workingReads++;
          return collectionLocator(working, true);
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          return collectionLocator(working.filter((message) => message.role === 'assistant'), true);
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          return scalarLocator({ count: vi.fn(async () => 0) });
        }
      } else if (selector === MESSAGE_NODE_SELECTOR) {
        completeReads++;
      }
      return originalLocator(selector);
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));

    const outcome = await fixture.run(output, invocationId);

    expect(workingReads).toBeGreaterThan(0);
    // Put the terminal result first so a premature failure cannot masquerade
    // as a missing fixture selector/read counter.
    expect(outcome, JSON.stringify({ outcome, workingReads, completeReads, elapsed: mocks.nowMs - start })).toMatchObject({ code: 0, result: {
      state: 'ok', send_count: 1, conversation_id: SHARED_CONV,
    } });
    expect(completeReads).toBeGreaterThan(0);
    expect(mocks.nowMs - start).toBeGreaterThanOrEqual(70_000);
    expect(mocks.nowMs - start).toBeLessThan(180_000);
    expect(readFileSync(output, 'utf8')).toBe(reply);
    expect(readStateLightTurnObservation('collision-profile', invocationId)).toMatchObject({
      phase: 'harvested', conversation_url: SHARED_CONV, send_count: 1,
    });
    expect(fixture.local.getSends()).toBe(1);
    expect(fixture.retryClicks).not.toHaveBeenCalled();
  });

  it('skips an unreadable positively foreign project tab in a fresh fetch-loss census', async () => {
    const prompt = 'SYNTHETIC-RECOVERY-WITH-FOREIGN-TAB';
    const reply = 'COMPLETE-OWNED-DESPITE-FOREIGN-READ-FAILURE';
    const output = join(stateDir, 'fetch-loss-foreign-census.txt');
    const invocationId = randomUUID();
    const fixture = freshLocalFetchLossFixture(prompt, reply);
    const foreignPage = makeLoserPage('UNRELATED-PROMPT', 'UNRELATED-REPLY').page;
    foreignPage.url.mockReturnValue(OTHER_PROJECT_CONVERSATION_URL);
    const unreadableForeignRead = vi.fn(async () => { throw new Error('foreign_transcript_unreadable'); });
    const originalForeignLocator = foreignPage.locator.getMockImplementation()!;
    foreignPage.locator.mockImplementation((selector: string) => selector === USER_MESSAGE_SELECTOR
      ? scalarLocator({ count: unreadableForeignRead })
      : originalForeignLocator(selector));
    fixture.context.pages.mockReturnValue([fixture.local.page, foreignPage, fixture.serverPage]);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));

    const outcome = await fixture.run(output, invocationId);

    expect(outcome).toMatchObject({ code: 0, result: {
      state: 'ok', send_count: 1, conversation_id: SHARED_CONV,
    } });
    expect(readFileSync(output, 'utf8')).toBe(reply);
    expect(unreadableForeignRead).not.toHaveBeenCalled();
    expect(fixture.local.getSends()).toBe(1);
    expect(fixture.retryClicks).not.toHaveBeenCalled();
    expect(foreignPage.close).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'same-project', url: LOSER_CONV },
    { kind: 'unknown URL', url: null },
  ])('keeps an unreadable $kind census page fail-closed beside an owned candidate', async ({ kind, url }) => {
    const prompt = 'SYNTHETIC-RECOVERY-FAIL-CLOSED-' + kind;
    const output = join(stateDir, 'fetch-loss-census-uncertain-' + kind + '.txt');
    const invocationId = randomUUID();
    const fixture = freshLocalFetchLossFixture(prompt, 'SHOULD-NOT-HARVEST');
    const unreadablePage = makeLoserPage('UNRELATED-PROMPT', 'UNRELATED-REPLY').page;
    if (url === null) {
      unreadablePage.url.mockImplementation(() => { throw new Error('url_unreadable'); });
    } else {
      unreadablePage.url.mockReturnValue(url);
    }
    unreadablePage.locator.mockImplementation((selector: string) => selector === USER_MESSAGE_SELECTOR
      ? scalarLocator({ count: vi.fn(async () => { throw new Error('transcript_unreadable'); }) })
      : scalarLocator());
    fixture.context.pages.mockReturnValue([fixture.local.page, fixture.serverPage, unreadablePage]);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));

    const outcome = await fixture.run(output, invocationId);

    expect(outcome.result).toMatchObject({
      state: 'observation_uncertain', cause: 'owned_conversation_recovery_census_failed',
      send_count: 1,
    });
    expect(outcome.result).not.toHaveProperty('conversation_id');
    expect(existsSync(output)).toBe(false);
    expect(fixture.local.getSends()).toBe(1);
    expect(fixture.retryClicks).not.toHaveBeenCalled();
  });

  it('returns fresh_send_fetch_failed without locator or resend on local-ID Failed to fetch and zero census match', async () => {
    const prompt = 'SYNTHETIC-LOCAL-FETCH-LOSS-NO-SERVER-TAB';
    const output = join(stateDir, 'fetch-loss-no-server-output.txt');
    const invocationId = randomUUID();
    const fixture = freshLocalFetchLossFixture(prompt);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const start = mocks.nowMs;

    const outcome = await fixture.run(output, invocationId);

    expect(outcome.result).toMatchObject({
      state: 'observation_uncertain', cause: 'fresh_send_fetch_failed',
      send_count: 1, send_attempted: true,
    });
    expect(outcome.result).not.toHaveProperty('conversation_id');
    expect(outcome.result).not.toHaveProperty('output');
    expect(existsSync(output)).toBe(false);
    expect(mocks.nowMs - start).toBeLessThan(90_000);
    expect(fixture.local.getSends()).toBe(1);
    expect(fixture.retryClicks).not.toHaveBeenCalled();
    expect(fixture.local.page.close).not.toHaveBeenCalled();
  });

  // #2641: Fresh-local fixtures observe one physical Send on the created
  // Page. The finalizer seam tests below inject an already-counted outcome
  // (not a new dispatch) to model route drift after terminal authorization.
  function freshLocalPostSendFixture(options: {
    readonly alerts?: readonly (string | null)[];
    readonly localUrl?: string;
    readonly stop?: 'absent' | 'visible' | 'unknown';
    readonly incompletePoll?: number;
    readonly interruptPoll?: number;
    readonly afterAlertRead?: (readNumber: number) => void;
  } = {}) {
    let gotoAtSend = -1;
    let postSendUrl = options.localUrl ?? LOCAL_ID_CONVERSATION_URL;
    let currentStop = options.stop ?? 'absent';
    let renderedMessages: StateLightTestMessage[] = [];
    const pageFixture = makeLoserPage('PROMPT-LOCAL-2641', 'NEVER-REPLY', () => {
      gotoAtSend = pageFixture.page.goto.mock.calls.length;
    });
    pageFixture.page.url.mockImplementation(() =>
      pageFixture.getSends() === 0 ? PROJECT_URL : postSendUrl);
    const realLocator = pageFixture.page.locator.bind(pageFixture.page);
    const retry = vi.fn(async () => undefined);
    const stopClick = vi.fn(async () => undefined);
    let observationReads = 0;
    let alertReads = 0;
    let interruptionInjected = false;
    pageFixture.page.locator = vi.fn((selector: string) => {
      if (selector === MESSAGE_NODE_SELECTOR) {
        if (pageFixture.getSends() > 0 && renderedMessages.length > 0) return collectionLocator(renderedMessages);
        return scalarLocator({
          count: vi.fn(async () => {
            if (pageFixture.getSends() > 0) {
              observationReads++;
              // Inject exactly once after the first qualifying alert, not
              // during the preliminary Send/landing observations.
              if (alertReads === 1 && !interruptionInjected
                && (options.interruptPoll !== undefined || options.incompletePoll !== undefined)) {
                interruptionInjected = true;
                if (options.interruptPoll !== undefined) throw new Error('transcript read interrupted');
                return -1;
              }
            }
            return 0;
          }),
        });
      }
      if (selector === USER_MESSAGE_SELECTOR || selector === ASSISTANT_MESSAGE_SELECTOR) {
        return collectionLocator(renderedMessages.filter((message) =>
          message.role === (selector === USER_MESSAGE_SELECTOR ? 'user' : 'assistant')));
      }
      if (selector === RENDERED_STOP_BUTTON_SELECTOR) {
        return scalarLocator({
          count: vi.fn(async () => pageFixture.getSends() === 0 || currentStop === 'absent'
            ? 0 : currentStop === 'visible' ? 1 : Number.NaN),
          isVisible: vi.fn(async () => currentStop === 'visible'),
          click: stopClick,
        });
      }
      if (selector === uiAdapter.UNMARKED_ALERT_SELECTOR) {
        return scalarLocator({
          allInnerTexts: vi.fn(async () => {
            const alerts = options.alerts ?? [];
            const value = alerts[Math.min(alertReads, alerts.length - 1)];
            alertReads++;
            options.afterAlertRead?.(alertReads);
            return value ? [value] : [];
          }),
          click: retry,
        });
      }
      return realLocator(selector);
    });
    return {
      ...pageFixture,
      retry, stopClick,
      gotoAtSend: () => gotoAtSend,
      alertReads: () => alertReads,
      observationReads: () => observationReads,
      setPostSendUrl: (url: string) => { postSendUrl = url; },
      setStop: (stop: 'absent' | 'visible' | 'unknown') => { currentStop = stop; },
      setRenderedMessages: (messages: StateLightTestMessage[]) => { renderedMessages = messages; },
    };
  }

  it.each([
    ['Network error\nSomething went wrong while sending.\nRetry', 'product_network_error', LOCAL_ID_CONVERSATION_URL, 'Network error'],
    ['Resume stream unavailable\nRetry', 'stream_recovery_polling_timed_out', LOCAL_ID_CONVERSATION_URL.replace('%3A', ':'), 'Resume stream unavailable'],
    ['Unexpected failure\nRetry', 'product_error_banner', LOCAL_ID_CONVERSATION_URL, 'Unexpected failure'],
  ])('terminalizes two adjacent idle local %s alerts at the second poll (#2641 AC1-2)', async (alert, cause, localUrl, heading) => {
    const fixture = freshLocalPostSendFixture({ alerts: [alert, alert], localUrl });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-LOCAL-2641'));
    const startMs = mocks.nowMs;
    const outcome = await runNewChatTurn(fixture.page, join(stateDir, '2641-alert-' + randomUUID() + '.txt'));
    expect(outcome.result).toMatchObject({
      state: 'recovery_required', scope: 'invocation', cause, product_banner_text: heading,
      send_count: 1, cleanup: 'unconfirmed',
    });
    expect(outcome.result).not.toHaveProperty('conversation_id');
    expect(outcome.result.next_action).toContain('GitHub effects first');
    expect(outcome.result.next_action).toContain('20 minutes');
    expect(outcome.result.next_action).toContain('project sidebar');
    expect(fixture.alertReads()).toBe(2);
    expect(mocks.nowMs - startMs).toBeLessThan(68_000);
    expect(fixture.getSends()).toBe(1);
    expect(fixture.gotoAtSend()).toBeGreaterThan(0); // pre-Send navigation is permitted
    expect(fixture.page.goto).toHaveBeenCalledTimes(fixture.gotoAtSend());
    expect(fixture.page.close).not.toHaveBeenCalled();
    expect(fixture.stopClick).not.toHaveBeenCalled();
    expect(fixture.retry).not.toHaveBeenCalled();
  });

  it.each([
    ['cleared', ['Network error\nRetry', null, 'Network error\nRetry', 'Network error\nRetry']],
    ['changed', ['Network error\nRetry', 'Resume stream unavailable\nRetry', 'Network error\nRetry', 'Network error\nRetry']],
  ])('does not carry a local alert streak through %s observation (#2641 AC2)', async (_reason, alerts) => {
    const fixture = freshLocalPostSendFixture({ alerts });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-LOCAL-2641'));
    const outcome = await runNewChatTurn(fixture.page, join(stateDir, '2641-transient-' + randomUUID() + '.txt'));
    expect(outcome.result).toMatchObject({
      state: 'recovery_required', scope: 'invocation', cause: 'product_network_error', send_count: 1,
    });
    expect(fixture.alertReads()).toBe(4);
    expect(fixture.getSends()).toBe(1);
    expect(fixture.page.close).not.toHaveBeenCalled();
  });

  it('resets a local alert streak on an interrupted transcript poll (#2641 AC3)', async () => {
    const fixture = freshLocalPostSendFixture({
      alerts: ['Network error\nRetry', 'Network error\nRetry', 'Network error\nRetry'],
      interruptPoll: 2,
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-LOCAL-2641'));
    const outcome = await runNewChatTurn(fixture.page, join(stateDir, '2641-interrupted.txt'));
    expect(outcome.result).toMatchObject({
      state: 'recovery_required', scope: 'invocation', cause: 'product_network_error', send_count: 1,
    });
    expect(fixture.observationReads()).toBeGreaterThanOrEqual(4);
    expect(fixture.alertReads()).toBe(3);
    expect(fixture.page.close).not.toHaveBeenCalled();
  });

  it('resets a local streak on an incomplete transcript read (#2641 AC3)', async () => {
    const fixture = freshLocalPostSendFixture({
      alerts: ['Network error\nRetry', 'Network error\nRetry', 'Network error\nRetry'],
      incompletePoll: 2,
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-LOCAL-2641'));
    const outcome = await runNewChatTurn(fixture.page, join(stateDir, '2641-incomplete.txt'));
    expect(outcome.result).toMatchObject({
      state: 'recovery_required', scope: 'invocation', cause: 'product_network_error', send_count: 1,
    });
    expect(fixture.observationReads()).toBeGreaterThanOrEqual(4);
    expect(fixture.alertReads()).toBe(3);
    expect(fixture.page.close).not.toHaveBeenCalled();
  });

  it.each(['visible', 'unknown'] as const)(
    'never treats a %s current Stop observation with zero message nodes as locally idle (#2641 AC3)',
    async (stop) => {
      const fixture = freshLocalPostSendFixture({ alerts: ['Network error\nRetry'], stop });
      mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-LOCAL-2641'));
      const start = mocks.nowMs;
      const outcome = await runNewChatTurn(fixture.page, join(stateDir, '2641-stop-' + stop + '.txt'));
      expect(outcome.result).toMatchObject({
        state: 'observation_uncertain', scope: 'invocation', cause: 'fresh_conversation_owner_unproven',
        send_count: 1,
      });
      expect(outcome.result).not.toHaveProperty('conversation_id');
      expect(fixture.getSends()).toBe(1);
      expect(fixture.alertReads()).toBe(0);
      expect(mocks.nowMs - start).toBeLessThan(90_000);
      expect(fixture.page.close).not.toHaveBeenCalled();
    },
  );

  it.each(['durable route', 'visible Stop', 'rendered own marker'] as const)(
    'rejects stale local alert idle evidence when %s appears during the second alert read (#2641 review)',
    async (drift) => {
      let fixture: ReturnType<typeof freshLocalPostSendFixture>;
      fixture = freshLocalPostSendFixture({
        alerts: ['Network error\nRetry', 'Network error\nRetry'],
        afterAlertRead: (readNumber) => {
          if (readNumber !== 2) return;
          if (drift === 'durable route') fixture.setPostSendUrl(SHARED_CONV);
          else if (drift === 'visible Stop') fixture.setStop('visible');
          else {
            const ownMarker = currentOwnedPromptMarker();
            expect(ownMarker).toMatch(/^OPKTURNV1[0-9a-f]{32}$/u);
            fixture.setRenderedMessages([{ role: 'user', text: `${ownMarker}\n\nPROMPT-LOCAL-2641` }]);
          }
        },
      });
      mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-LOCAL-2641'));
      const outcome = await runNewChatTurn(fixture.page, join(stateDir, '2641-alert-drift-' + randomUUID() + '.txt'));
      // This read raced with Page promotion, generation or carrier rendering.
      // It cannot be the second trustworthy idle alert for the local turn.
      expect(outcome.result).not.toMatchObject({ state: 'recovery_required', cause: 'product_network_error' });
      expect(outcome.result).toMatchObject({ scope: 'invocation', send_count: 1 });
      expect(fixture.alertReads()).toBe(2);
      expect(fixture.getSends()).toBe(1);
      expect(fixture.page.goto).toHaveBeenCalledTimes(fixture.gotoAtSend());
      expect(fixture.retry).not.toHaveBeenCalled();
      expect(fixture.stopClick).not.toHaveBeenCalled();
      if (drift === 'visible Stop') expect(fixture.page.close).not.toHaveBeenCalled();
    },
  );

  it('resets the local alert streak when its exact chat ID changes during the second read (#2641 review)', async () => {
    let fixture: ReturnType<typeof freshLocalPostSendFixture>;
    fixture = freshLocalPostSendFixture({
      alerts: Array(4).fill('Network error\nRetry'),
      afterAlertRead: (readNumber) => {
        if (readNumber === 2) {
          fixture.setPostSendUrl(LOCAL_ID_CONVERSATION_URL.replace(
            '11111111-1111-4111-8111-111111111111',
            '44444444-4444-4444-8444-444444444444',
          ));
        }
      },
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-LOCAL-2641'));
    const outcome = await runNewChatTurn(fixture.page, join(stateDir, '2641-id-drift-' + randomUUID() + '.txt'));
    expect(outcome.result).toMatchObject({
      state: 'recovery_required', scope: 'invocation', cause: 'product_network_error',
      send_count: 1,
    });
    // Read #2 was invalidated by route drift. Only two further intact
    // observations on the new route can complete the streak.
    expect(fixture.alertReads()).toBe(4);
    expect(fixture.getSends()).toBe(1);
    expect(fixture.page.goto).toHaveBeenCalledTimes(fixture.gotoAtSend());
    expect(fixture.page.close).not.toHaveBeenCalled();
    expect(fixture.stopClick).not.toHaveBeenCalled();
    expect(fixture.retry).not.toHaveBeenCalled();
  });

  it.each([
    { terminal: 'recovery_required', route: SHARED_CONV, label: 'durable route', retain: true },
    { terminal: 'observation_uncertain', route: PROJECT_URL, label: 'project root', retain: true },
    { terminal: 'recovery_required', route: null, label: 'unreadable URL', retain: true },
    { terminal: 'driver_error', route: PROJECT_URL, label: 'unrelated result', retain: false },
  ] as const)(
    'keeps prior local Page retention authority through finalizer $label (#2641 review)',
    async ({ terminal, route, retain }) => {
      const fixture = makeLoserPage('PROMPT-LOCAL-2641', 'NEVER-REPLY');
      fixture.page.url.mockReturnValue(LOCAL_ID_CONVERSATION_URL);
      const invocationId = randomUUID();
      // Simulate the exact seam after runTurnCore has positively authorized
      // a counted local terminal, but before runStateLightTurn finalizes it.
      const outcome = await runStateLightTurnWithStdoutCapture(
        (args) => runStateLightTurn(args, {
          runTurn: async () => {
            expect(fixture.page.url()).toBe(LOCAL_ID_CONVERSATION_URL);
            if (route === null) {
              fixture.page.url.mockImplementation(() => { throw new Error('URL unreadable after local terminal'); });
            } else {
              fixture.page.url.mockReturnValue(route);
            }
            return {
              page: fixture.page,
              browser: { isConnected: vi.fn(() => true) },
              cleanupAction: 'preserve' as const,
              ...(retain ? { retainOwnedFreshLocalPage: true } : {}),
              ownedFreshProjectUrl: PROJECT_URL,
              result: {
                schema: 'turn-result/v1' as const,
                state: terminal,
                scope: 'invocation' as const,
                cause: terminal === 'recovery_required' ? 'product_network_error'
                  : terminal === 'observation_uncertain' ? 'fresh_conversation_owner_unproven'
                    : 'unrelated_error',
                invocation_id: invocationId,
                configured_profile_key: 'collision-profile',
                send_count: 1,
                poll_count: 2,
                goto_count: 1,
                new_chat_click_count: 0,
                navigation_count: 1,
                incidents: [],
              },
            };
          },
        }), [
          ...STATE_LIGHT_TURN_BASE_ARGV,
          '--invocation-id', invocationId,
          '--output', join(stateDir, '2641-finalizer-' + randomUUID() + '.txt'),
          '--new-chat',
          '--project-url', PROJECT_URL,
          '--timeout-ms', '90000',
        ],
      );
      expect(outcome.result).toMatchObject({
        state: terminal, scope: 'invocation', send_count: 1,
        cleanup: 'skipped',
      });
      expect(outcome.result).not.toHaveProperty('conversation_id');
      // No CDP target provenance exists in this injected finalizer outcome.
      expect(fixture.page.close).not.toHaveBeenCalled();
      expect(fixture.page.goto).not.toHaveBeenCalled();
    },
  );

  it('returns silent counted local Send at the existing unbound cutoff and retains the Page (#2641 AC4/8)', async () => {
    const fixture = freshLocalPostSendFixture();
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-LOCAL-2641'));
    const start = mocks.nowMs;
    const outcome = await runNewChatTurn(fixture.page, join(stateDir, '2641-silent-local.txt'));
    expect(outcome.result).toMatchObject({
      state: 'observation_uncertain', scope: 'invocation',
      cause: 'fresh_conversation_owner_unproven', send_count: 1, cleanup: 'unconfirmed',
    });
    expect(outcome.result).not.toHaveProperty('conversation_id');
    expect(outcome.result.next_action).toContain('POSSIBLY_DELIVERED');
    expect(outcome.result.next_action).toContain('GitHub effects first');
    expect(outcome.result.next_action).toContain('new-invocation-ID manual send');
    expect(outcome.result.next_action).toContain('possibly duplicated');
    expect(mocks.nowMs - start).toBeLessThan(90_000);
    expect(fixture.getSends()).toBe(1);
    expect(fixture.page.goto).toHaveBeenCalledTimes(fixture.gotoAtSend());
    expect(fixture.page.close).not.toHaveBeenCalled();
    expect(fixture.retry).not.toHaveBeenCalled();
    expect(fixture.stopClick).not.toHaveBeenCalled();
  });

  it('keeps a local-chatgpt fresh URL unbound even when its owned reply looks complete', async () => {
    const prompt = 'SYNTHETIC-LOCAL-ID-STILL-PENDING';
    const reply = 'COMPLETE-BUT-LOCAL-ID-ONLY';
    const output = join(stateDir, 'local-id-unbound.txt');
    const invocationId = randomUUID();
    const turn = makeLoserPage(prompt, reply);
    turn.page.url.mockImplementation(() => turn.getSends() > 0 ? LOCAL_ID_CONVERSATION_URL : PROJECT_URL);
    expect(conversationUuidFromUrl(LOCAL_ID_CONVERSATION_URL)).toBeUndefined();
    expect(isSupportedChatGptConversationUrl(LOCAL_ID_CONVERSATION_URL)).toBe(false);
    expect(readProjectConversationUrl(turn.page, PROJECT_URL)).toBeUndefined();
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const launcherStartMs = mocks.nowMs;

    const outcome = await runNewChatTurn(turn.page, output, '1800000', invocationId);

    expect(outcome.result).toMatchObject({
      state: 'ok', cause: 'completed_page_only', send_count: 1,
    });
    expect(outcome.result).not.toHaveProperty('conversation_id');
    expect(mocks.nowMs - launcherStartMs).toBeLessThan(1_800_000);
    expect(turn.getSends()).toBe(1);
    expect(readStateLightTurnObservation('collision-profile', invocationId)).toMatchObject({
      phase: 'harvested',
      conversation_url: null,
      send_count: 1,
    });
    expect(readFileSync(output, 'utf8')).toBe(reply);
  });

  it('binds and harvests once after a local-chatgpt fresh URL becomes a canonical owned project URL', async () => {
    const prompt = 'SYNTHETIC-LOCAL-TO-CANONICAL';
    const reply = 'COMPLETE-OWNED-AFTER-CANONICAL';
    const output = join(stateDir, 'local-to-canonical-reply.txt');
    const invocationId = randomUUID();
    const turn = makeLoserPage(prompt, reply);
    let localObserved = false;
    let canonicalObserved = false;
    turn.page.url.mockImplementation(() => {
      if (turn.getSends() === 0) return PROJECT_URL;
      if (turn.getObservationReads() < 4) {
        localObserved = true;
        return LOCAL_ID_CONVERSATION_URL;
      }
      canonicalObserved = true;
      return SHARED_CONV;
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));

    const outcome = await runNewChatTurn(turn.page, output, '90000', invocationId);

    expect(localObserved).toBe(true);
    expect(canonicalObserved).toBe(true);
    expect(outcome).toMatchObject({
      code: 0,
      result: { state: 'ok', send_count: 1, conversation_id: SHARED_CONV },
    });
    expect(turn.getSends()).toBe(1);
    expect(readStateLightTurnObservation('collision-profile', invocationId)).toMatchObject({
      phase: 'harvested',
      conversation_url: SHARED_CONV,
      send_count: 1,
    });
    expect(readFileSync(output, 'utf8')).toBe(reply);
  });

  // #2533: source-level negative controls. The historical live DOM predicate
  // remains unknown; these do not claim to reproduce the production incident.
  it('bounds a sent-but-unowned same-project URL before the normal launcher ceiling without granting recovery', async () => {
    const prompt = 'SYNTHETIC-UNBOUND-CANDIDATE';
    const output = join(stateDir, 'unowned-candidate-must-not-publish.txt');
    const invocationId = randomUUID();
    const { page, state } = unrenderedOwnedMessagePage(
      prompt, 'VISIBLE-BUT-UNATTRIBUTABLE', false, false, false,
      ['VISIBLE-BUT-UNATTRIBUTABLE'], [], { neverMarkerProof: true },
    );
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const launcherStartMs = mocks.nowMs;
    const outcome = await runNewChatTurn(page, output, '1800000', invocationId);
    expect(outcome.result).toMatchObject({
      state: 'observation_uncertain',
      cause: 'fresh_conversation_owner_unproven',
      send_count: 1,
    });
    expect(outcome.result).not.toHaveProperty('conversation_id');
    expect(mocks.nowMs - launcherStartMs).toBeLessThan(3_600_000);
    expect(state.sent).toBe(true);
    expect(readStateLightTurnObservation('collision-profile', invocationId)).toMatchObject({
      phase: 'sent_unbound', conversation_url: null, send_count: 1,
    });
    expect(existsSync(output)).toBe(false);
  });

  it.each([
    ['foreign project', OTHER_PROJECT_CONVERSATION_URL],
    ['project root', PROJECT_URL],
  ])('does not promote a sent, unowned %s page URL into a launcher locator', async (_kind, observedUrl) => {
    const prompt = 'SYNTHETIC-NO-MARKER';
    const output = join(stateDir, 'unowned-foreign-or-root.txt');
    const { page, state } = unrenderedOwnedMessagePage(
      prompt, 'SYNTHETIC-UNATTRIBUTABLE-REPLY', false, false, false,
      ['SYNTHETIC-UNATTRIBUTABLE-REPLY'], [], { neverMarkerProof: true },
    );
    page.url.mockImplementation(() => state.sent ? observedUrl : PROJECT_URL);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output);
    expect(outcome.result.send_count).toBe(1);
    expect(outcome.result.state).not.toBe('ok');
    expect(outcome.result).not.toHaveProperty('conversation_id');
    expect(existsSync(output)).toBe(false);
  });

  it('refuses a duplicate fresh owned-marker census rather than claiming its candidate URL', async () => {
    const prompt = 'SYNTHETIC-DUPLICATE-OWNED-MARKER';
    const output = join(stateDir, 'duplicate-owned-marker-unbound.txt');
    const turn = makeLoserPage(prompt, 'DUPLICATE-UNATTRIBUTABLE-REPLY');
    const originalLocator = turn.page.locator.getMockImplementation()!;
    const duplicateOwnedUsers: StateLightTestMessage[] = [
      { role: 'user', text: `${TEST_OWNED_MARKER}\n\n${prompt}` },
      { role: 'user', text: `${TEST_OWNED_MARKER}\n\n${prompt}` },
    ];
    turn.page.locator.mockImplementation((selector: string) => {
      if (selector === USER_MESSAGE_SELECTOR && turn.getSends() > 0) {
        return collectionLocator(duplicateOwnedUsers);
      }
      if (selector === MESSAGE_NODE_SELECTOR && turn.getSends() > 0) {
        return collectionLocator([
          ...duplicateOwnedUsers,
          { role: 'assistant', text: 'DUPLICATE-UNATTRIBUTABLE-REPLY', finalActionInTurnContainer: true },
        ]);
      }
      return originalLocator(selector);
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const invocationId = randomUUID();
    const outcome = await runNewChatTurn(turn.page, output, '90000', invocationId);
    expect(outcome.result.send_count).toBe(1);
    expect(outcome.result.state).not.toBe('ok');
    expect(outcome.result).not.toHaveProperty('conversation_id');
    expect(turn.getSends()).toBe(1);
    expect(readStateLightTurnObservation('collision-profile', invocationId)).toMatchObject({
      phase: 'sent_unbound', conversation_url: null,
    });
    expect(existsSync(output)).toBe(false);
  });

  it('never publishes a newly discovered fresh assistant-only reply without a proven marker', async () => {
    const prompt = 'PROMPT-FRESH-UNRENDERED';
    const reply = 'FRESH-UNRENDERED-OK';
    const output = join(stateDir, 'fresh-unrendered-owned-message.txt');
    const { page, state } = unrenderedOwnedMessagePage(prompt, reply, false, false, false, [reply], [], { neverMarkerProof: true });
    const invocationId = randomUUID();

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output, '90000', invocationId);

    expect(outcome.code).not.toBe(0);
    expect(outcome.result).toMatchObject({ send_count: 1 });
    expect(outcome.result.state).not.toBe('ok');
    expect(readStateLightTurnObservation('collision-profile', invocationId)).toMatchObject({
      phase: 'sent_unbound',
      conversation_url: null,
      send_count: 1,
    });
    expect(state.reloads).toBe(0);
    expect(existsSync(output)).toBe(false);
  });


  it.each([
    { mode: 'marker-visible', options: { includeOwnedUser: true } },
    { mode: 'keyed-markerless', options: { includeOwnedUser: true, keyedOwnedMessages: true, markerlessOwnedUserFromRead: 4 } },
    { mode: 'fresh-markerless', options: {} },
  ])('publishes the complete formatted primary through $mode without normalization', async ({ mode, options }) => {
    const prompt = 'PROMPT-2590-' + mode;
    const reply = [
      'Leading  prose',
      '',
      'def main():',
      '    if ready:',
      '        if nested:',
      '\t\t\treturn "kept"',
      '        return "eight"',
      '',
      'Trailing  prose',
      'EXECUTION_STATUS: complete',
    ].join('\n');
    const output = join(stateDir, 'formatted-2590-' + mode + '.txt');
    const { page, state } = unrenderedOwnedMessagePage(prompt, reply, false, false, false, [reply], [], options);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output);
    const expectedBytes = Buffer.from(reply, 'utf8');
    expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({
      state: 'ok', cause: 'completed_page_only', send_count: 1,
      output: {
        byte_length: expectedBytes.byteLength,
        sha256: createHash('sha256').update(expectedBytes).digest('hex'),
      },
    });
    expect(readFileSync(output)).toEqual(expectedBytes);
    expect(state.reads).toBeGreaterThanOrEqual(5);
  });

  const parentPrefix2590 = 'def verify():\n    if serial_digest.digest() != pooled_digest.digest():';
  const fullCode2590 = parentPrefix2590 + '\n        raise ValueError("digest mismatch")\n    return True';
  const threeVisibleLines2590 = parentPrefix2590 + '\n        raise ValueError("digest mismatch")';

  it.each([
    { caseName: 'complete-visible-child', parentPrefix: parentPrefix2590, visible: fullCode2590, domTextContent: fullCode2590, expectedCode: fullCode2590 },
    { caseName: 'single-line-parent-prefix', parentPrefix: 'def verify():', visible: fullCode2590, domTextContent: fullCode2590, expectedCode: fullCode2590 },
    {
      // A hidden <span style="display:none"> contributes only to textContent.
      caseName: 'hidden-descendant-after-visible-child',
      parentPrefix: parentPrefix2590, visible: fullCode2590, domTextContent: fullCode2590 + 'HIDDEN-DESCENDANT', expectedCode: fullCode2590,
    },
    {
      caseName: 'child-visible-prefix-longer-than-parent',
      parentPrefix: parentPrefix2590, visible: threeVisibleLines2590, domTextContent: fullCode2590, expectedCode: threeVisibleLines2590,
    },
    {
      caseName: 'textContent-only-hidden-suffix',
      parentPrefix: parentPrefix2590, visible: parentPrefix2590, domTextContent: parentPrefix2590 + '\n        HIDDEN-DESCENDANT', expectedCode: parentPrefix2590,
    },
  ])('publishes only atomic visible code and following footer ($caseName)', async ({ caseName, parentPrefix, visible, domTextContent, expectedCode }) => {
    // AC3 fixture, not AC1 live completeness: two tabs, zero assistant code blocks.
    const prompt = 'PROMPT-2590-' + caseName;
    const footer = '\n\nFollowing  prose\nEXECUTION_STATUS: complete';
    const outer = 'Before\n\n' + parentPrefix + footer;
    const expected = 'Before\n\n```\n' + expectedCode + (expectedCode.endsWith('\n') ? '' : '\n') + '```' + footer;
    const output = join(stateDir, 'long-code-2590-' + caseName + '.txt');
    const { page, state } = unrenderedOwnedMessagePage(
      prompt, outer, false, false, false, [outer], [],
      { includeOwnedUser: true, assistantCode: { visible, domTextContent } },
    );
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output);
    const expectedBytes = Buffer.from(expected, 'utf8');
    expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({
      state: 'ok', cause: 'completed_page_only', send_count: 1,
      output: {
        byte_length: expectedBytes.byteLength,
        sha256: createHash('sha256').update(expectedBytes).digest('hex'),
      },
    });
    expect(readFileSync(output)).toEqual(expectedBytes);
    expect(readFileSync(output, 'utf8')).not.toContain('HIDDEN-DESCENDANT');
    expect(state.reads).toBeGreaterThanOrEqual(5);
  });

  it('Issue #2660 B8 publishes exact two fenced diffs with text before, between, after', async () => {
    const diffOne = 'diff --git a/alpha b/alpha\n--- a/alpha\n+++ b/alpha\n@@ -1 +1 @@\n old\n-foo\n+bar\n';
    const diffTwo = 'diff --git a/beta b/beta\n--- a/beta\n+++ b/beta\n@@ -2 +2 @@\n  nested  spaces\n\t+tab\n\n```';
    const expected = [
      'Before',
      '```diff\n' + diffOne + '```',
      'Between diff blocks',
      '````diff\n' + diffTwo + '\n````',
      'After diff blocks\nEXECUTION_STATUS: complete',
    ].join('\n\n');
    const outer = 'MISLEADING OUTER FIRST DIFF LINE; Copy control; NOT COMPLETE';
    const output = join(stateDir, 'issue-2660-two-diff-primary.txt');
    const prompt = 'ISSUE-2660-TWO-DIFF-PRIMARY';
    const { page, state } = unrenderedOwnedMessagePage(
      prompt, outer, false, false, false, [outer], [],
      {
        includeOwnedUser: true,
        assistantCode: {
          visible: diffOne,
          domTextContent: diffOne + 'HIDDEN',
          firstLanguage: 'diff',
          secondVisible: diffTwo,
          secondLanguage: 'diff',
        },
      },
    );
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output);
    const bytes = Buffer.from(expected, 'utf8');
    expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({
      state: 'ok', cause: 'completed_page_only', send_count: 1,
      output: {
        byte_length: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    });
    expect(readFileSync(output)).toEqual(bytes);
    expect(state.reads).toBeGreaterThanOrEqual(5);
  });


  it('Issue #2660 never loses FAIL prose before a mixed wrapper becomes a supported block', async () => {
    const prompt = 'ISSUE-2660-MIXED-PROSE-NEGATIVE';
    const code = 'diff --git a/a b/a\n';
    const outer = 'MISLEADING MIXED WRAPPER';
    const output = join(stateDir, 'issue-2660-mixed-prose-must-not-publish.txt');
    const { page, state } = unrenderedOwnedMessagePage(
      prompt, outer, false, false, false, [outer], [],
      { includeOwnedUser: true, assistantCode: {
        visible: code, domTextContent: code, interleavedProse: 'FAIL',
        // The owned Page's observation timeout is soft. A permanently
        // unsupported reply must not be awaited as a terminal test case.
        standaloneProseFromRead: 12,
      } },
    );
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output);
    const expected = [
      'Before', '```\n' + code + '```', 'FAIL',
      'Following  prose\nEXECUTION_STATUS: complete',
    ].join('\n\n');
    expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({
      state: 'ok', cause: 'completed_page_only', send_count: 1,
    });
    expect(state.reads).toBeGreaterThanOrEqual(12);
    expect(readFileSync(output, 'utf8')).toBe(expected);
  });

  it('rejects a changed middle indentation on the fresh precommit read', async () => {
    const prompt = 'PROMPT-2590-INDENT-DRIFT';
    const reply = 'Start\n\n    if ready:\n        return "eight"\n\nEXECUTION_STATUS: complete';
    const drift = reply.replace('        return', '       return');
    const output = join(stateDir, 'indent-drift-2590.txt');
    const { page, state } = unrenderedOwnedMessagePage(
      prompt, reply, false, false, false, [reply, reply, drift, reply, reply, reply],
      [],
      { includeOwnedUser: true },
    );
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output);
    expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({
      state: 'ok', cause: 'completed_page_only', send_count: 1,
    });
    expect(readFileSync(output, 'utf8')).toBe(reply);
    expect(state.reads).toBeGreaterThanOrEqual(8);
  });

  it('publishes the full final owned reply once through the atomic evaluateAll observation', async () => {
    const prompt = 'PROMPT-LONG-FINAL';
    const reply = 'R'.repeat(8_785);
    const output = join(stateDir, 'full-final-reply.txt');
    const { page, state } = unrenderedOwnedMessagePage(prompt, reply, false);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output);
    const published = readFileSync(output, 'utf8');
    const digest = createHash('sha256').update(published, 'utf8').digest('hex');
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      code: 0,
      result: { state: 'ok', cause: 'completed_page_only', send_count: 1, output: { byte_length: 8_785, sha256: digest } },
    });
    expect(published).toBe(reply);
    expect(state.reloads).toBe(0);
  });

  it('rejects a repeated early prefix when the same owned final answer later grows', async () => {
    const prompt = 'PROMPT-GROWING-FINAL';
    const prefix = 'P'.repeat(2_101);
    const finalReply = 'F'.repeat(8_785);
    const output = join(stateDir, 'growing-final-reply.txt');
    const { page, state } = unrenderedOwnedMessagePage(
      prompt, finalReply, false, false, false,
      [prefix, prefix, finalReply, finalReply, finalReply],
      [false, false, true, true, false, false, false],
    );
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output);
    const published = readFileSync(output, 'utf8');
    expect(outcome.result).toMatchObject({ state: 'ok', cause: 'completed_page_only', send_count: 1 });
    expect(published).toBe(finalReply);
    expect(published).not.toBe(prefix);
    expect(state.reloads).toBe(0);
  });

  it('discards a completion-ready poll when the selected assistant loses its own finality evidence', async () => {
    const prompt = 'PROMPT-INTERRUPTED-STABILITY';
    const reply = 'SHORT-BUT-COMPLETE-LOOKING';
    const output = join(stateDir, 'interrupted-stability-must-not-publish.txt');
    const { page, state } = unrenderedOwnedMessagePage(
      prompt,
      reply,
      false,
      false,
      false,
      [reply],
      [],
      { incompleteReads: [5], nonFinalReads: [4], nonFinalFromRead: 6, includeOwnedUser: true },
    );
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));

    const outcome = await runNewChatTurn(page, output, '90000');

    expect(outcome.result.state).not.toBe('ok');
    expect(outcome.result.send_count).toBe(1);
    expect(existsSync(output)).toBe(false);
  });

  it('keeps the incumbent keyed markerless owned-window publication path', async () => {
    const prompt = 'PROMPT-KEYED-MARKERLESS';
    const reply = 'KEYED-MARKERLESS-FINAL';
    const output = join(stateDir, 'keyed-markerless-final.txt');
    const { page } = unrenderedOwnedMessagePage(
      prompt,
      reply,
      false,
      false,
      false,
      [reply],
      [],
      { includeOwnedUser: true, keyedOwnedMessages: true, markerlessOwnedUserFromRead: 4 },
    );
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));

    const outcome = await runNewChatTurn(page, output);

    expect(outcome.result).toMatchObject({ state: 'ok', cause: 'completed_page_only', send_count: 1 });
    expect(readFileSync(output, 'utf8')).toBe(reply);
  });

  it('retains the ordinary markerless finished-reply reopen after account-error recovery', async () => {
    const prompt = 'PROMPT-MARKERLESS-RECOVERY';
    const reply = 'MARKERLESS-RECOVERY-FINAL';
    const output = join(stateDir, 'markerless-recovery-final.txt');
    const { page, state } = unrenderedOwnedMessagePage(
      prompt, reply, true, false, false, [reply], [],
      { includeOwnedUser: true, markerlessOwnedUserFromRead: 3, userMarkerlessFromRead: 3 },
    );
    const fault = installAccountLoadError(page);
    let statusReads = 0;
    mocks.productStatusText.mockImplementation(async (): Promise<any> => {
      statusReads++;
      if (statusReads === 2) {
        fault.showError();
        const heading = "We couldn't load your account";
        return {
          text: heading, composer: false,
          parts: [{ selector: uiAdapter.ACCOUNT_LOAD_ERROR_HEADING_SELECTOR, text: heading }],
        };
      }
      return { text: '', composer: true };
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));

    const outcome = await withActualProductWallClassifier(() => runNewChatTurn(page, output, '90000'));

    expect(outcome.result).toMatchObject({ state: 'ok', cause: 'completed_page_only', send_count: 1 });
    expect(readFileSync(output, 'utf8')).toBe(reply);
    expect(fault.reload).toHaveBeenCalledTimes(1);
    expect(page.goto.mock.calls.some((call: readonly unknown[]) => call[0] === SHARED_CONV)).toBe(true);
    expect(state.reloads).toBeGreaterThan(0);
  });

  it('does not transfer a stable reply proof across assistant carrier-key changes', async () => {
    const prompt = 'PROMPT-ASSISTANT-KEY-DRIFT';
    const reply = 'SAME-KEYED-REPLY-TEXT';
    const output = join(stateDir, 'assistant-key-drift-must-not-publish.txt');
    const changingKeys = [
      'unused-key-00000000',
      'unused-key-00000000',
      'assistant-carrier-11111111',
      'assistant-carrier-11111111',
      'assistant-carrier-22222222',
      'assistant-carrier-33333333',
      'assistant-carrier-44444444',
      'assistant-carrier-55555555',
      'assistant-carrier-66666666',
      'assistant-carrier-77777777',
      'assistant-carrier-88888888',
    ];
    const { page } = unrenderedOwnedMessagePage(
      prompt,
      reply,
      false,
      false,
      false,
      [reply],
      [],
      { includeOwnedUser: true, keyedOwnedMessages: true, assistantCarrierKeysByRead: changingKeys },
    );
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));

    const outcome = await runNewChatTurn(page, output, '90000');

    expect(outcome.result.state).not.toBe('ok');
    expect(outcome.result.send_count).toBe(1);
    expect(existsSync(output)).toBe(false);
  });

  it('returns conversation-scoped stream recovery timeout without reload when the owner is unrendered', async () => {
    const prompt = 'PROMPT-STREAM-RECOVERY';
    const reply = 'NEVER-FINISHED';
    const output = join(stateDir, 'stream-recovery-unrendered.txt');
    const { page, state } = unrenderedOwnedMessagePage(
      prompt,
      reply,
      false,
      false,
      'ChatGPT stream recovery polling timed out\nRetry',
    );

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output);

    expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({
      state: 'recovery_required',
      scope: 'conversation',
      cause: 'stream_recovery_polling_timed_out',
      send_count: 1,
    });
    expect(state.reloads).toBe(0);
  });

  it('returns conversation-scoped message stream error without reload when the owner is unrendered (#2235)', async () => {
    const prompt = 'PROMPT-MESSAGE-STREAM';
    const reply = 'NEVER-FINISHED';
    const output = join(stateDir, 'message-stream-unrendered.txt');
    const { page, state } = unrenderedOwnedMessagePage(prompt, reply, false, false, 'Error in message stream');

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output);

    expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({
      state: 'recovery_required',
      scope: 'conversation',
      cause: 'message_stream_error',
      send_count: 1,
    });
    expect(state.reloads).toBe(0);
  });

  it('returns conversation-scoped message delivery timeout without reload when the owner is unrendered (#2303)', async () => {
    const prompt = 'PROMPT-DELIVERY-TIMEOUT';
    const output = join(stateDir, 'delivery-timeout-unrendered.txt');
    const { page, state } = unrenderedOwnedMessagePage(prompt, 'NEVER-FINISHED', false, false, 'Message delivery timed out. Please try again.');

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output);

    expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({
      state: 'recovery_required',
      scope: 'conversation',
      cause: 'message_delivery_timed_out',
      send_count: 1,
    });
    expect(state.reloads).toBe(0);
  });

  it.each([
    ['Network error\nSomething went wrong while sending.\nRetry', 'product_network_error'],
    ['Resume stream unavailable\nRetry', 'stream_recovery_polling_timed_out'],
  ])('returns conversation-scoped recovery for the %j alert heading when the owner is unrendered (#2307)', async (alert, cause) => {
    const prompt = `PROMPT-HEADING-${cause}`;
    const output = join(stateDir, `heading-${cause}.txt`);
    const { page, state } = unrenderedOwnedMessagePage(prompt, 'NEVER-FINISHED', false, false, alert);

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output);

    expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({
      state: 'recovery_required',
      scope: 'conversation',
      cause,
      send_count: 1,
    });
    expect(state.reloads).toBe(0);
  });

  it('returns product_error_banner with the alert heading for an unknown red banner when the owner is unrendered', async () => {
    const prompt = 'PROMPT-UNKNOWN-BANNER';
    const output = join(stateDir, 'unknown-banner.txt');
    const { page, state } = unrenderedOwnedMessagePage(prompt, 'NEVER-FINISHED', false, false, 'Something went wrong\nTry again later.\nRetry');

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output);

    expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({
      state: 'recovery_required',
      scope: 'conversation',
      cause: 'product_error_banner',
      product_banner_text: 'Something went wrong',
      send_count: 1,
    });
    expect(state.reloads).toBe(0);
  });

  it('reloads the owned conversation once when a finished answer renders without the owned user message (#2197)', async () => {
    const prompt = 'PROMPT-UNRENDERED';
    const reply = 'UNRENDERED-OK';
    const output = join(stateDir, 'unrendered-owned-message.txt');
    const { page, state } = unrenderedOwnedMessagePage(prompt, reply, true, true);

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output);

    // Without the first-token original user marker, a completed assistant
    // alone is not this invocation's success authority. No URL-only reload
    // or post-Send action may invent a reply binding.
    expect(outcome.code).not.toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'observation_uncertain', cause: 'post_send_absolute_deadline_elapsed',
      send_count: 1,
    });
    expect(state.reloads).toBe(0);
    expect(existsSync(output)).toBe(false);
  });

  it('reloads at most once and never resends when the owned user message stays unrendered (#2197)', async () => {
    const prompt = 'PROMPT-STILL-UNRENDERED';
    const reply = 'NEVER-HARVESTED';
    const output = join(stateDir, 'still-unrendered-owned-message.txt');
    const { page, state } = unrenderedOwnedMessagePage(prompt, reply, false, true);

    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(page, output, '90000');

    expect(outcome.result.state).not.toBe('ok');
    expect(outcome.result.send_count).toBe(1);
    // Same pinned Page and a 200/URL alone cannot repair a missing marker.
    expect(state.reloads).toBe(0);
    expect(existsSync(output)).toBe(false);
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
        if (selector === USER_MESSAGE_SELECTOR) {
          // Independent user-carrier census: a foreign surface cannot authenticate
          // our marker even when a URL was observed first.
          return collectionLocator(sent && surface === 'owned'
            ? [{ role: 'user', text: `${TEST_OWNED_MARKER}\n\n${prompt}` }]
            : sent && surface === 'foreign' ? foreignMessages.filter((message) => message.role === 'user') : []);
        }
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
    const outcome = await runNewChatTurn(page, output, '90000', invocationId);

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

  it('accepts probe primary committed during an in-flight post-Send transcript read', async () => {
    const prompt = 'POST-SEND-PROBE-RACE';
    const invocationId = randomUUID();
    const output = join(stateDir, 'external-harvest-mid-read.txt');
    const externalReply = 'PROBE PUBLISHED EXACT REPLY';
    const turn = makeLoserPage(prompt, 'LOCAL-UNTRUSTED', undefined, true);
    const originalLocator = turn.page.locator.getMockImplementation()!;
    let injected = false;
    turn.page.locator.mockImplementation((selector: string) => {
      const locator = originalLocator(selector);
      if (selector !== MESSAGE_NODE_SELECTOR || typeof locator.evaluateAll !== 'function') return locator;
      const observe = locator.evaluateAll.bind(locator);
      return {
        ...locator,
        evaluateAll: async (...args: any[]) => {
          if (!injected && turn.getSends() === 1) {
            const record = readStateLightTurnObservation('collision-profile', invocationId);
            if (record.phase === 'sent_unbound' || record.phase === 'sent_unharvested') {
              injected = true;
              const publication = await finalizeStateLightPrimaryPublication({
                profileKey: 'collision-profile',
                invocationId,
                target: output,
                bytes: Buffer.from(externalReply, 'utf8'),
                publish: () => publishStateLightReply(output, invocationId, externalReply),
              });
              expect(publication.state).toBe('committed_ok');
              expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('harvested');
            }
          }
          return observe(...args);
        },
      };
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const outcome = await runNewChatTurn(turn.page, output, '90000', invocationId);
    expect(injected).toBe(true);
    expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({
      state: 'ok', cause: 'completed_page_probe_primary', send_count: 1,
    });
    expect(readFileSync(output, 'utf8')).toBe(externalReply);
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('harvested');
    expect(turn.getSends()).toBe(1);
  });

  it('surfaces committed post-send observation retirement cleanup without resend', async () => {
    const prompt = 'PROMPT-CLEANUP-POST-SEND';
    const invocationId = randomUUID();
    const output = join(stateDir, 'cleanup-post-send.txt');
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED', () => {
      mocks.failNextObservationMutationRmdir = true;
    });

    const outcome = await runNewChatTurn(turn.page, output, '90000', invocationId);

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

  it.each((['ready', 'readiness-recovery'] as const).flatMap((branch) =>
    (['many-lines', 'single-100KB-line'] as const).flatMap((shape) =>
      (['complete', 'marker-separator', 'joined-words', 'indentation', 'changed-content'] as const)
        .map((content) => ({ branch, shape, content })),
    ),
  ))(
    'verifies slow-filled $shape $content text in the $branch branch (#2669)', async ({ branch, shape, content }) => {
      const prompt = shape === 'single-100KB-line'
        ? '  Synthetic task instruction 0'.padEnd(100 * 1024, 'x')
        : Array.from({ length: 80 }, (_, index) => `  Synthetic task instruction ${index}`).join('\n');
      if (shape === 'single-100KB-line') {
        expect(Buffer.byteLength(prompt)).toBe(100 * 1024);
        expect(prompt).not.toContain('\n');
      }
      const text = wrapOwnedPromptPayload(TEST_OWNED_MARKER, prompt);
      const budget = deriveComposerInsertionBudgetMs(text);
      let value = '';
      let reads = 0;
      const composer = {
        count: vi.fn(async () => 1),
        evaluate: vi.fn(async (read: (element: any) => unknown) => {
          if (String(read).includes('textContent')) return read({ textContent: value, innerText: value });
          const ready = branch === 'ready' || ++reads > 1;
          return { visible: ready, enabled: ready, contentEditable: ready };
        }),
        click: vi.fn(async () => undefined),
        fill: vi.fn(async (input: string, { timeout }: { timeout: number }) => {
          const fillCostMs = budget + 1_000;
          mocks.nowMs += Math.min(fillCostMs, timeout);
          if (timeout < fillCostMs) throw new Error('TimeoutError: fill timed out before full insertion');
          value = content === 'marker-separator' ? input.replace(/\n\n\s*/u, '')
            : content === 'joined-words' ? input.replace('Synthetic task', 'Synthetictask')
              : content === 'indentation' ? input.replace(/  Synthetic/u, 'Synthetic')
                : content === 'changed-content' ? input.replace('instruction', 'different') : input;
        }),
        innerText: vi.fn(async () => value),
      };
      const page = { locator: (selector: string) => selector === COMPOSER_SELECTOR ? composer : scalarLocator() };
      const cause = await __testComposerMutation.mutateComposerOrCause(page, text, mocks.nowMs + 60_000);
      expect(cause).toBe(['marker-separator', 'changed-content'].includes(content)
        ? 'composer_payload_mismatch' : null);
      expect(composer.innerText).toHaveBeenCalledTimes(1);
      if (content === 'complete') expect(value).toBe(text);
      else expect(value).not.toBe(text);
      expect(composer.fill).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves cancellation between readiness and mutation (#2669)', async () => {
    const composer = {
      count: async () => 1,
      evaluate: async () => ({ visible: true, enabled: true, contentEditable: true }),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
    };
    const beforeAction = vi.fn(() => { throw new Error('account_cooldown_active'); });
    await expect(__testComposerMutation.mutateComposerOrCause(
      { locator: () => composer }, 'cancelled 100KB prompt'.padEnd(100 * 1024, 'x'),
      mocks.nowMs + 60_000, undefined, beforeAction,
    )).rejects.toThrow('account_cooldown_active');
    expect(composer.click).not.toHaveBeenCalled();
    expect(composer.fill).not.toHaveBeenCalled();
  });

  it('reports privacy-safe diagnostics from each composer mutation budget exit', async () => {
    const prompt = 'PROMPT-2405-SENTINEL';
    const markedPrompt = wrapOwnedPromptPayload(TEST_OWNED_MARKER, prompt);
    const insertionBudgetMs = deriveComposerInsertionBudgetMs(markedPrompt);
    const deadlineMs = 15_000;
    type BranchScenario = {
      branch: 'readiness_before_click' | 'budget_before_click' | 'after_click'
        | 'budget_before_fill' | 'readiness_before_fill' | 'budget_before_fill2';
      ready: boolean[];
      expireAfterEvaluate?: number;
      expireAfterClick?: boolean;
      expireOnNextClockRead?: boolean;
    };
    const scenarios: BranchScenario[] = [
      // The composer remains present but unready through the new bounded
      // click/fill attempt; a recovered composer is tested separately.
      { branch: 'readiness_before_click', ready: [true, false, false] },
      { branch: 'budget_before_click', ready: [true, true], expireAfterEvaluate: 2 },
      { branch: 'after_click', ready: [true, true], expireAfterClick: true },
      { branch: 'budget_before_fill', ready: [true, true], expireAfterClick: true, expireOnNextClockRead: true },
      { branch: 'readiness_before_fill', ready: [true, true, false] },
      { branch: 'budget_before_fill2', ready: [true, true, true], expireAfterEvaluate: 3 },
    ];
    const priorHome = process.env.HOME;
    process.env.HOME = stateDir;
    try {
      for (const scenario of scenarios) {
        mocks.nowMs = 10_000;
        mocks.appendFileSync.mockClear();
        let evaluateCount = 0;
        let expireCountdown = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => {
          if (expireCountdown > 0 && --expireCountdown === 0) mocks.nowMs = deadlineMs;
          return mocks.nowMs;
        });
        const { page, composer, getSends } = makeLoserPage(prompt, 'unused');
        composer.evaluate = vi.fn(async () => {
          evaluateCount++;
          if (scenario.expireAfterEvaluate === evaluateCount) expireCountdown = 3;
          const ready = scenario.ready[evaluateCount - 1] ?? true;
          return { visible: ready, enabled: ready, contentEditable: ready };
        });
        composer.click = vi.fn(async () => {
          if (scenario.expireAfterClick) {
            expireCountdown = scenario.expireOnNextClockRead ? 2 : 0;
            if (!scenario.expireOnNextClockRead) mocks.nowMs = deadlineMs;
          }
        });
        const insertionContext: {
          insertionDeadlineMs?: number;
          diagnostic?: import('./contracts.ts').ComposerMutationDiagnosticV1;
        } = {};
        // The production path first performs a successful composer readiness
        // check before invoking the mutation helper. Keep that preflight so
        // its deliberate second/final readiness failure remains reachable.
        expect(await __testComposerMutation.readComposerReadiness(page, deadlineMs)).toBe(true);
        const cause = await __testComposerMutation.mutateComposerOrCause(
          page, markedPrompt, deadlineMs, insertionContext,
        );
        expect(composer.evaluate).toHaveBeenCalled();
        expect(evaluateCount).toBe(scenario.ready.length);
        expect(composer.click).toHaveBeenCalledTimes(scenario.branch === 'budget_before_click' ? 0 : 1);
        expect(composer.fill).toHaveBeenCalledTimes(scenario.branch === 'readiness_before_click' ? 1 : 0);
        expect(cause).toBe('composer_mutation_budget_exhausted');
        expect(getSends()).toBe(0);
        const expectedElapsed = scenario.branch === 'readiness_before_click'
          || scenario.branch === 'readiness_before_fill' ? 0 : 5_000;
        const diagnostic = {
          branch: scenario.branch,
          insertionBudgetMs,
          textLength: markedPrompt.length,
          elapsedMs: expectedElapsed,
          remainingInvocationMs: expectedElapsed === 0 ? 5_000 : 0,
        };
        expect(insertionContext.diagnostic).toEqual(diagnostic);
        expect(JSON.stringify(insertionContext.diagnostic)).not.toContain(prompt);
      }
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
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
    const project = `https://chatgpt.com/g/g-p-11111111111111111111111111111111-test-project/c/${uuid}`;
    const bare = `https://chatgpt.com/c/${uuid}`;
    expect(ownedConversationIdentityMatches(project, bare)).toBe(true);
    expect(ownedConversationIdentityMatches(bare, project)).toBe(true);
  });

  it('retains legacy-host existing-conversation UUID receipts without allowing a legacy-host fresh claim', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    const legacy = `https://chat.openai.com/c/${uuid}`;
    expect(conversationUuidFromUrl(legacy)).toBe(uuid);
    expect(isSupportedChatGptConversationUrl(legacy)).toBe(true);
    expect(ownedConversationIdentityMatches(legacy, `https://chatgpt.com/c/${uuid}`)).toBe(true);
    expect(tryClaimStateLightFreshConversation('collision-profile', legacy, 'legacy-claim')).toBe('contended');
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
    expect(isBlankProjectSurfaceUrl(PROJECT_CONVERSATION_ROOT, canonical)).toBe(true);
    expect(isBlankProjectSurfaceUrl(PROJECT_CONVERSATION_ROOT + '/draft', canonical)).toBe(true);
    expect(isBlankProjectSurfaceUrl(PROJECT_CONVERSATION_ROOT + '/other-route', canonical)).toBe(false);
    expect(isBlankProjectSurfaceUrl(canonical.replace('chatgpt.com', 'chatgpt.com:8443'), canonical)).toBe(false);
  });

  it('limits commit navigation to three pre-send sites; post-send still waits for DCL', () => {
    expect(STATE_LIGHT_NAVIGATION_TIMEOUT_MS).toBe(120_000);
    const sites = [
      ['state-light-session.ts', 0],
      ['state-light-fresh-conversation.ts', 1],
      ['state-light-turn-base.ts', 3],
    ] as const;
    for (const [file, expectedPostSendDcl] of sites) {
      const source = readFileSync(
        join(process.cwd(), 'scripts', 'chatgpt-browser-turn', file),
        'utf8',
      );
      expect(source.match(/waitUntil: 'commit'/gu), file).toHaveLength(1);
      expect(source.match(/waitUntil: 'domcontentloaded'/gu) ?? [], file).toHaveLength(expectedPostSendDcl);
    }
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

    await openBlankProjectChatSurface(page, PROJECT_URL, navigation);

    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(STATE_LIGHT_NAVIGATION_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(page.goto).toHaveBeenCalledWith(projectConversationPrefix(PROJECT_URL), {
      waitUntil: 'commit',
      timeout: STATE_LIGHT_NAVIGATION_TIMEOUT_MS,
    });
    expect(navigation.snapshotGoto()).toBe(1);
  });

  it('prepares a project conversation without clicking the global New chat control that opens the root', async () => {
    const navigation = new StateLightNavigationCounter();
    let url = ISSUE_CONVERSATION_URL;
    const click = vi.fn(async () => { url = 'https://chatgpt.com/'; });
    const page = {
      goto: vi.fn(async (target: string) => { url = target; }),
      url: vi.fn(() => url),
      locator: vi.fn((selector: string) => selector === '[data-testid="create-new-chat-button"]'
        ? scalarLocator({ count: vi.fn(async () => 1), click })
        : scalarLocator({ count: vi.fn(async () => 0) })),
    };

    const prepared = await prepareStateLightFreshConversation(page, {
      cdp: 'http://127.0.0.1:9222', profile: '/tmp/profile',
      newChat: true, projectUrl: ISSUE_PROJECT_URL, timeoutMs: 5_000,
    }, 'global-new-chat-root', 'prepare-invocation', navigation);

    expect(prepared).toEqual({ state: 'ready' });
    expect(url).toBe(projectConversationPrefix(ISSUE_PROJECT_URL));
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
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

  it('preserves an unreadable canonical claim after a project navigation redirects back to a conversation', async () => {
    const profileKey = 'redirected-canonical-claim';
    const { writeFileSync } = await import('node:fs');
    const { sha256 } = await import('./storage-common.ts');
    const claimDir = join(stateDir, profileKey, 'state-light-fresh-claims');
    mkdirSync(claimDir, { recursive: true });
    const claimPath = join(claimDir, `${sha256(SHARED_CANONICAL_CONV)}.json`);
    writeFileSync(claimPath, '{partially-written-wx-claim');

    let currentUrl = SHARED_CONV;
    const page = {
      goto: vi.fn(async () => { currentUrl = SHARED_CONV; }),
      url: vi.fn(() => currentUrl),
      locator: vi.fn(() => scalarLocator({ count: vi.fn(async () => 0) })),
    };
    const result = await prepareStateLightFreshConversation(page, {
      cdp: 'http://127.0.0.1:9222', profile: '/tmp/profile',
      newChat: true, projectUrl: PROJECT_URL, timeoutMs: 5_000,
    }, profileKey, 'other-invocation');

    expect(result).toEqual({
      state: 'ui_contract_mismatch', cause: 'fresh_conversation_surface_unavailable',
    });
    expect(page.goto).toHaveBeenCalled();
    expect(readFileSync(claimPath, 'utf8')).toBe('{partially-written-wx-claim');
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CANONICAL_CONV, 'other-invocation')).toBe('contended');
  });

  it('never treats an unrelated nested project route as a ready blank composer', async () => {
    const invalidRoute = PROJECT_CONVERSATION_ROOT + '/other-route';
    const page = {
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => invalidRoute),
      locator: vi.fn(() => scalarLocator({ count: vi.fn(async () => 0) })),
    };
    const result = await prepareStateLightFreshConversation(page, {
      cdp: 'http://127.0.0.1:9222', profile: '/tmp/profile',
      newChat: true, projectUrl: PROJECT_URL, timeoutMs: 5_000,
    }, 'nested-route', 'other-invocation');
    expect(result).toEqual({
      state: 'ui_contract_mismatch', cause: 'fresh_conversation_surface_unavailable',
    });
    expect(page.goto).toHaveBeenCalled();
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
    await openBlankProjectChatSurface(page, PROJECT_URL, navigation);
    url = SHARED_CONV;
    await expect(openBlankProjectChatSurface(page, PROJECT_URL, navigation)).rejects.toThrow(
      'state_light_navigation_budget_exhausted',
    );
  });
  it('replays journal symptom send_observation_deferred/fresh_conversation_url_not_observed', async () => {
    const prompt = 'PROMPT-JOURNAL-DEFER';
    const reply = 'JOURNAL-OK';
    let sent = false;
    let composerText = '';
    let url = PROJECT_URL;
    let observationIndex = 0;
    const snapshotFrames = readyTurnObservationFrames(prompt, reply).map((messages, index) => ({
      messages,
      generating: index < 2,
    }));

    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async (value: string) => { composerText = value; }),
      innerText: vi.fn(async () => (sent ? '' : composerText)),
      textContent: vi.fn(async () => (sent ? '' : composerText)),
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
    const output = join(stateDir, 'journal-defer-replay.txt');
    const outcome = await runNewChatTurn(page, output);

    // A deferred UUID/URL cannot veto a uniquely marker-proven successor
    // on the original pinned Page. Still publish only its full stable reply.
    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.result).not.toHaveProperty('conversation_id');
    expect(readFileSync(output, 'utf8')).toBe(reply);
    expect(page.goto).toHaveBeenCalledWith(projectConversationPrefix(PROJECT_URL), {
      waitUntil: 'commit',
      timeout: expect.any(Number),
    });
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
    await navigateToProjectConversationIfNeeded(page, conversation, navigation);
    expect(page.goto).toHaveBeenCalledWith(conversation, {
      waitUntil: 'domcontentloaded',
      timeout: STATE_LIGHT_NAVIGATION_TIMEOUT_MS,
    });
    expect(url).toBe(conversation);
  });

  it('reads a same-project /c/<uuid> URL when the configured project URL ends in /project', () => {
    expect(readProjectConversationUrl({ url: () => ISSUE_CONVERSATION_URL }, ISSUE_PROJECT_URL))
      .toBe(ISSUE_CONVERSATION_URL);
    expect(readProjectConversationUrl({ url: () => OTHER_PROJECT_CONVERSATION_URL }, ISSUE_PROJECT_URL))
      .toBeUndefined();
    expect(readProjectConversationUrl({ url: () => OTHER_ORIGIN_CONVERSATION_URL }, ISSUE_PROJECT_URL))
      .toBeUndefined();
    expect(readProjectConversationUrl({ url: () => ISSUE_PROJECT_URL }, ISSUE_PROJECT_URL))
      .toBeUndefined();
  });

  it('does not report fresh_conversation_landing_mismatch at the deadline when the same-project conversation is open', async () => {
    const prompt = 'PROMPT-LANDED-FRESH';
    let sent = false;
    let composerText = '';
    let conversationAppearsAt = Number.POSITIVE_INFINITY;
    const staleAssistant: StateLightTestSnapshot = {
      messages: [{ role: 'assistant', text: 'foreign', finalAction: true, finalActionInTurnContainer: true }],
      generating: false,
    };
    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async (value: string) => { composerText = value; }),
      innerText: vi.fn(async () => sent ? '' : composerText),
      press: vi.fn(async () => {
        sent = true;
        conversationAppearsAt = mocks.nowMs + 3_000;
      }),
    });
    const sendButton = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => {
        sent = true;
        conversationAppearsAt = mocks.nowMs + 3_000;
      }),
    });
    const page: any = {
      __fakeBrowserGptPage: true,
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => sent && mocks.nowMs >= conversationAppearsAt ? ISSUE_CONVERSATION_URL : ISSUE_PROJECT_URL),
      isClosed: vi.fn(() => false),
      waitForTimeout: vi.fn(async (ms: number) => { mocks.nowMs += ms; }),
      close: vi.fn(async () => undefined),
      getByText: vi.fn(() => scalarLocator()),
      getByRole: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return sendButton;
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
    const outcome = await runNewChatTurn(
      page,
      '/tmp/fresh-landing-same-project.txt',
      '90000',
      randomUUID(),
      ISSUE_PROJECT_URL,
    );

    expect(outcome.result.send_count).toBe(1);
    expect(outcome.result.cause).not.toBe('fresh_conversation_landing_mismatch');
    expect(outcome.result.incidents).not.toContain('conversation_landing_mismatch');
  });

  it('returns fresh_conversation_owner_unproven at the original cutoff when url and owned prompt never materialize', async () => {
    const prompt = 'PROMPT-STUCK-FRESH';
    let sent = false;
    let composerText = '';
    let url = PROJECT_URL;
    const staleAssistant: StateLightTestSnapshot = {
      messages: [{ role: 'assistant', text: 'foreign', finalAction: true, finalActionInTurnContainer: true }],
      generating: false,
    };
    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async (value: string) => { composerText = value; }),
      innerText: vi.fn(async () => sent ? '' : composerText),
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
    const outcome = await runNewChatTurn(page, '/tmp/fresh-landing-mismatch.txt', '90000');

    expect(outcome.result).toMatchObject({
      state: 'observation_uncertain',
      cause: 'fresh_conversation_owner_unproven',
      send_count: 1,
      send_attempted: true,
    });
    expect(outcome.result.incidents).toContain('post_send_observation_error');
    expect(outcome.result.poll_count).toBeGreaterThan(0);
  });

  function installAccountLoadError(page: any, opts: {
    persistent?: boolean; errorUrl?: string; afterReloadUrl?: string; throwReload?: boolean;
  } = {}) {
    const originalLocator = page.locator.bind(page);
    const originalUrl = page.url.bind(page);
    let showing = false;
    let redirectedUrl: string | undefined;
    page.url = vi.fn(() => showing
      ? (opts.errorUrl ?? 'https://chatgpt.com/account-error')
      : (redirectedUrl ?? originalUrl()));
    page.locator = vi.fn((selector: string) => {
      if (!showing) return originalLocator(selector);
      if (selector === uiAdapter.ACCOUNT_LOAD_ERROR_HEADING_SELECTOR) return scalarLocator({
        count: vi.fn(async () => 1),
        innerText: vi.fn(async () => "We couldn't load your account"),
      });
      if ([COMPOSER_SELECTOR, MESSAGE_NODE_SELECTOR, USER_MESSAGE_SELECTOR].includes(selector)) {
        return scalarLocator({ count: vi.fn(async () => 0) });
      }
      return originalLocator(selector);
    });
    const reload = vi.fn(async () => {
      if (opts.throwReload) throw new Error('synthetic account reload rejected');
      if (!opts.persistent) {
        showing = false;
        redirectedUrl = opts.afterReloadUrl;
      }
    });
    page.reload = reload;
    return {
      showError: () => { showing = true; },
      reload,
      visible: () => showing,
    };
  }

  async function withActualProductWallClassifier<T>(operation: () => Promise<T>): Promise<T> {
    const actual = await vi.importActual<typeof import('./ui-adapter.ts')>('./ui-adapter.ts');
    const classifier = vi.mocked(uiAdapter.classifyProductWall);
    const previousImplementation = classifier.getMockImplementation();
    classifier.mockImplementation(actual.classifyProductWall);
    try {
      return await operation();
    } finally {
      classifier.mockImplementation(previousImplementation ?? (() => ({
        wall_kind: 'none', matched_text: 'none', matched_selector: 'none',
      })));
    }
  }

  it('reloads a created fresh account-error route once before owner assertion and dispatch', async () => {
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT'));
    const fresh = makeLoserPage('PROMPT', 'RECOVERED-OK');
    const fault = installAccountLoadError(fresh.page);
    fault.showError();
    const result = await runNewChatTurn(fresh.page, join(stateDir, 'account-open-ok.txt'));
    expect(result.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(fresh.getSends()).toBe(1);
    expect(fault.reload).toHaveBeenCalledTimes(1);
    expect(fault.reload).toHaveBeenCalledWith({
      waitUntil: 'domcontentloaded', timeout: expect.any(Number),
    });
    expect(fresh.page.goto).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(stateDir, 'account-open-ok.txt'), 'utf8')).toBe('RECOVERED-OK');
  });

  it.each(['persistent', 'failed'] as const)('fails closed on a %s first account-error reload', async (kind) => {
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT'));
    const fresh = makeLoserPage('PROMPT', 'NEVER-SENT');
    const fault = installAccountLoadError(fresh.page, {
      persistent: kind === 'persistent', throwReload: kind === 'failed',
    });
    fault.showError();
    const result = await runNewChatTurn(fresh.page, join(stateDir, 'account-' + kind + '.txt'));
    expect(result.result).toMatchObject({
      state: 'recovery_required', scope: 'invocation', cause: 'account_load_error', send_count: 0,
    });
    expect(fresh.getSends()).toBe(0);
    expect(fault.reload).toHaveBeenCalledTimes(1);
    expect(result.result).not.toHaveProperty('conversation_id');
  });

  it('does not spend a second account reload or Send on a second error after initial recovery', async () => {
    let triggerAfterSend = () => {};
    const fresh = makeLoserPage('PROMPT', 'MUST-NOT-PUBLISH', () => triggerAfterSend());
    const fault = installAccountLoadError(fresh.page);
    triggerAfterSend = fault.showError;
    fault.showError();
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT'));
    const result = await runNewChatTurn(fresh.page, join(stateDir, 'account-two-phase.txt'));
    expect(result.result).toMatchObject({
      state: 'recovery_required', scope: 'invocation', cause: 'account_load_error',
      send_count: 1, send_attempted: true,
    });
    expect(fault.reload).toHaveBeenCalledTimes(1);
    expect(fresh.getSends()).toBe(1);
    expect(fresh.page.goto).toHaveBeenCalledTimes(1);
    expect(result.result).not.toHaveProperty('conversation_id');
  });


  it('recovers an account error that appears during fresh composer readiness', async () => {
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT'));
    const fresh = makeLoserPage('PROMPT', 'LATE-COMPOSER-OK');
    const fault = installAccountLoadError(fresh.page);
    let statusReads = 0;
    mocks.productStatusText.mockImplementation(async (): Promise<any> => {
      statusReads++;
      if (statusReads === 1) {
        fault.showError();
        const heading = "We couldn't load your account";
        return {
          text: heading, composer: false,
          parts: [{ selector: uiAdapter.ACCOUNT_LOAD_ERROR_HEADING_SELECTOR, text: heading }],
        };
      }
      return { text: '', composer: true };
    });

    const result = await withActualProductWallClassifier(() =>
      runNewChatTurn(fresh.page, join(stateDir, 'account-late-composer-fresh.txt')));

    expect(result.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(fault.reload).toHaveBeenCalledTimes(1);
    expect(fresh.getSends()).toBe(1);
  });

  it('recovers an account error during selected existing-chat composer readiness', async () => {
    const existing = makeLoserPage('PROMPT', 'LATE-EXISTING-COMPOSER-OK', undefined, true);
    const originalUrl = existing.page.url;
    existing.page.url = vi.fn(() => originalUrl() === PROJECT_URL ? SHARED_CONV : originalUrl());
    const fault = installAccountLoadError(existing.page);
    const harness = enqueueBrowserForTurn(mocks, existing.page);
    Object.assign(harness.context, { pages: vi.fn(() => [existing.page]) });
    mocks.productStatusText.mockImplementationOnce(async (): Promise<any> => {
      fault.showError();
      const heading = "We couldn't load your account";
      return {
        text: heading, composer: false,
        parts: [{ selector: uiAdapter.ACCOUNT_LOAD_ERROR_HEADING_SELECTOR, text: heading }],
      };
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT'));

    const result = await withActualProductWallClassifier(() =>
      runStateLightTurnWithStdoutCapture(runStateLightTurn, [
        ...STATE_LIGHT_TURN_BASE_ARGV, '--invocation-id', randomUUID(),
        '--output', join(stateDir, 'account-late-composer-existing.txt'), '--chat-url', SHARED_CONV,
        '--timeout-ms', '90000', '--poll-ms', '1',
      ]));

    expect(result.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(fault.reload).toHaveBeenCalledTimes(1);
    expect(existing.getSends()).toBe(1);
    expect(existing.page.close).not.toHaveBeenCalled();
  });

  it('preserves possibly-delivered state after a recovered zero-witness fresh dispatch stays unbound', async () => {
    const fresh = makeLoserPage('PROMPT', 'NEVER-PUBLISHED');
    const fault = installAccountLoadError(fresh.page);
    fresh.sendButton.click.mockImplementation(async () => {
      fault.showError();
      throw new Error('synthetic Send action failed after callback');
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT'));

    const result = await runNewChatTurn(fresh.page, join(stateDir, 'account-zero-recovered.txt'));

    expect(result.result).toMatchObject({
      state: 'observation_uncertain', cause: 'fresh_conversation_owner_unproven',
      send_count: 0, send_attempted: true,
    });
    expect(fault.reload).toHaveBeenCalledTimes(1);
    expect(fresh.sendButton.click).toHaveBeenCalledTimes(1);
    expect(deriveDelivery({ ...result.result, resolved_send_count: result.result.send_count } as any, false))
      .toBe('POSSIBLY_DELIVERED');
  });

  it('rejects a foreign conversation reached only after a counted fresh-turn error reload', async () => {
    const fresh = makeLoserPage('PROMPT', 'NEVER-PUBLISHED');
    const fault = installAccountLoadError(fresh.page, { afterReloadUrl: OTHER_PROJECT_CONVERSATION_URL });
    let statusReads = 0;
    mocks.productStatusText.mockImplementation(async (): Promise<any> => {
      statusReads++;
      if (statusReads === 2) {
        fault.showError();
        const heading = "We couldn't load your account";
        return {
          text: heading, composer: false,
          parts: [{ selector: uiAdapter.ACCOUNT_LOAD_ERROR_HEADING_SELECTOR, text: heading }],
        };
      }
      return { text: '', composer: true };
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT'));

    const result = await runNewChatTurn(fresh.page, join(stateDir, 'account-post-reload-foreign.txt'));

    expect(result.result).toMatchObject({
      state: 'ui_contract_mismatch', cause: 'account_error_page_ownership_unproven', send_count: 1,
    });
    expect(fault.reload).toHaveBeenCalledTimes(1);
    expect(fresh.getSends()).toBe(1);
    expect(fresh.page.goto).toHaveBeenCalledTimes(1);
    expect(fresh.page.url()).toBe(OTHER_PROJECT_CONVERSATION_URL);
    expect(fresh.page.close).not.toHaveBeenCalled();
  });
  it('reloads a counted fresh Send at URL landing without another Send', async () => {
    let triggerAfterSend = () => {};
    const fresh = makeLoserPage('PROMPT', 'LANDING-OK', () => triggerAfterSend());
    const fault = installAccountLoadError(fresh.page);
    triggerAfterSend = fault.showError;
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT'));
    const result = await runNewChatTurn(fresh.page, join(stateDir, 'account-landing.txt'));
    expect(result.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(fault.reload).toHaveBeenCalledTimes(1);
    expect(fresh.getSends()).toBe(1);
    expect(readFileSync(join(stateDir, 'account-landing.txt'), 'utf8')).toBe('LANDING-OK');
  });

  it('detects an attempted fresh Send with zero numeric witness and never retries', async () => {
    const fresh = makeLoserPage('PROMPT', 'NEVER-SENT');
    const fault = installAccountLoadError(fresh.page, { persistent: true });
    fresh.sendButton.click.mockImplementation(async () => {
      fault.showError();
      throw new Error('synthetic Send action failed after callback');
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT'));
    const result = await runNewChatTurn(fresh.page, join(stateDir, 'account-zero-fresh.txt'));
    expect(result.result).toMatchObject({
      state: 'recovery_required', scope: 'invocation', cause: 'account_load_error',
      send_count: 0, send_attempted: true,
    });
    expect(fresh.sendButton.click).toHaveBeenCalledTimes(1);
    expect(fault.reload).toHaveBeenCalledTimes(1);
    expect(result.result).not.toHaveProperty('conversation_id');
    expect(deriveDelivery({ ...result.result, resolved_send_count: result.result.send_count } as any, false)).toBe('POSSIBLY_DELIVERED');
  });

  it('reloads a previously exact-selected existing chat on an error-route but never closes it', async () => {
    const existing = makeLoserPage('PROMPT', 'NEVER-SENT', undefined, true);
    const baseUrl = existing.page.url;
    existing.page.url = vi.fn(() => baseUrl() === PROJECT_URL ? SHARED_CONV : baseUrl());
    const fault = installAccountLoadError(existing.page, { persistent: true });
    existing.sendButton.click.mockImplementation(async () => {
      fault.showError();
      throw new Error('synthetic existing Send action failed');
    });
    const harness = enqueueBrowserForTurn(mocks, existing.page);
    Object.assign(harness.context, { pages: vi.fn(() => [existing.page]) });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT'));
    const result = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV, '--invocation-id', randomUUID(),
      '--output', join(stateDir, 'account-existing-zero.txt'), '--chat-url', SHARED_CONV,
      '--timeout-ms', '90000', '--poll-ms', '1',
    ]);
    expect(result.result).toMatchObject({
      state: 'recovery_required', scope: 'invocation', cause: 'account_load_error',
      send_count: 0, send_attempted: true,
    });
    expect(fault.reload).toHaveBeenCalledTimes(1);
    expect(existing.sendButton.click).toHaveBeenCalledTimes(1);
    expect(existing.page.close).not.toHaveBeenCalled();
    expect(harness.context.newPage).not.toHaveBeenCalled();
  });

  it('does not reload a selected existing chat after its account-error URL becomes foreign', async () => {
    const existing = makeLoserPage('PROMPT', 'NEVER-SENT');
    const baseUrl = existing.page.url;
    existing.page.url = vi.fn(() => baseUrl() === PROJECT_URL ? SHARED_CONV : baseUrl());
    const fault = installAccountLoadError(existing.page, { errorUrl: OTHER_PROJECT_CONVERSATION_URL });
    const harness = enqueueBrowserForTurn(mocks, existing.page);
    Object.assign(harness.context, { pages: vi.fn(() => [existing.page]) });
    mocks.productStatusText.mockImplementationOnce(async (): Promise<any> => {
      fault.showError();
      const heading = "We couldn't load your account";
      return {
        text: heading, composer: false,
        parts: [{ selector: uiAdapter.ACCOUNT_LOAD_ERROR_HEADING_SELECTOR, text: heading }],
      };
    });
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT'));

    const result = await withActualProductWallClassifier(() =>
      runStateLightTurnWithStdoutCapture(runStateLightTurn, [
        ...STATE_LIGHT_TURN_BASE_ARGV, '--invocation-id', randomUUID(),
        '--output', join(stateDir, 'account-existing-foreign.txt'), '--chat-url', SHARED_CONV,
        '--timeout-ms', '90000', '--poll-ms', '1',
      ]));

    expect(result.result).toMatchObject({
      state: 'ui_contract_mismatch', cause: 'account_error_page_ownership_unproven', send_count: 0,
    });
    expect(fault.reload).not.toHaveBeenCalled();
    expect(existing.getSends()).toBe(0);
    expect(existing.page.close).not.toHaveBeenCalled();
    expect(harness.context.newPage).not.toHaveBeenCalled();
  });

  it('never reloads a positively foreign account-error destination', async () => {
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT'));
    const fresh = makeLoserPage('PROMPT', 'NEVER-SENT');
    const fault = installAccountLoadError(fresh.page, { errorUrl: OTHER_PROJECT_CONVERSATION_URL });
    fault.showError();
    const result = await runNewChatTurn(fresh.page, join(stateDir, 'account-foreign.txt'));
    expect(result.result).toMatchObject({
      state: 'ui_contract_mismatch', cause: 'account_error_page_ownership_unproven',
      send_count: 0,
    });
    expect(fault.reload).not.toHaveBeenCalled();
    expect(fresh.getSends()).toBe(0);
    expect(fresh.page.close).not.toHaveBeenCalled();
  });

  it('keeps account diagnostics transient without persisting or remapping login', () => {
    const key = 'account-advisory-transient';
    recordStateLightAdvisoryWall(key, 'account_load_error', 'account_load_error', 'invocation');
    expect(readStateLightAdvisoryWall(key)).toBeNull();
    for (const kind of ['quota', 'rate_limit', 'challenge', 'login'] as const) {
      recordStateLightAdvisoryWall(key, kind, kind + '_detected', 'invocation');
      expect(readStateLightAdvisoryWall(key)).toMatchObject({ state: kind });
    }
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

  it('does not dispatch when a short timeout cannot fit two full Send windows', async () => {
    const prompt = 'PROMPT-THRESHOLD';
    const reply = 'THRESHOLD-OK';
    let sent = false;
    let composerText = '';
    let url = PROJECT_URL;
    let observationIndex = 0;
    const snapshotFrames = readyTurnObservationFrames(prompt, reply).map((messages, index) => ({
      messages,
      generating: index < 2,
    }));

    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async (value: string) => { composerText = value; }),
      innerText: vi.fn(async () => (sent ? '' : composerText)),
      textContent: vi.fn(async () => (sent ? '' : composerText)),
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
    expect(outcome.code).not.toBe(0);
    expect(mocks.nowMs).toBeGreaterThanOrEqual(startedAt);
    expect(outcome.result).toMatchObject({
      send_count: 0, state: 'driver_error',
      cause: 'state_light_new_chat_send_budget_unavailable',
    });
    // A short accepted timeout cannot buy an incomplete 60s Send reserve.
    expect(sendButton.click).not.toHaveBeenCalled();
  });

  it('keeps the live prepared holder through 300s, reports its actual phase, and releases only as its owner (#2487)', async () => {
    clearSendSlotDisableEnv();
    const profileKey = 'collision-profile';
    const holder = 'holder-2487';
    admitStateLightTurnObservation({ profileKey, invocationId: holder, marker: TEST_OWNED_MARKER });
    const bound = await acquireStateLightNewChatSendSlot(profileKey, holder, 90_000);
    expect(bound).toBe(mocks.nowMs + STATE_LIGHT_OWNER_PRE_DISPATCH_MS);
    mocks.nowMs += STATE_LIGHT_OWNER_PRE_DISPATCH_MS + 1;
    // Neither a prepared/none observation nor elapsed cooperative owner time
    // grants a foreign contender the physical slot before the original TTL.
    const first = acquireStateLightNewChatSendSlot(profileKey, 'waiter-a-2487', 50);
    const second = acquireStateLightNewChatSendSlot(profileKey, 'waiter-b-2487', 50);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    mocks.nowMs += 60;
    for (const pending of [first, second]) {
      await expect(pending).rejects.toMatchObject({
        message: 'state_light_new_chat_send_slot_timeout',
        send_slot_holder_invocation_id: holder,
        send_slot_holder_phase: 'prepared',
      });
    }
    expect(verifyStateLightSendSlotOwnerFence(profileKey, holder)).toBe('valid');
    releaseStateLightNewChatSendSlot(profileKey, holder);
    await acquireStateLightNewChatSendSlot(profileKey, 'successor-2487', 50);
    expect(verifyStateLightSendSlotOwnerFence(profileKey, 'successor-2487')).toBe('valid');
    releaseStateLightNewChatSendSlot(profileKey, 'successor-2487');
  });

  it('stops a slow original owner at the invocation deadline without dispatch (#2497)', async () => {
    clearSendSlotDisableEnv();
    const prompt = 'PROMPT-OWNER-LATE';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'DO-NOT-SEND');
    let expired = false;
    turn.composer.evaluate.mockImplementation(async () => {
      if (!expired) {
        expired = true;
        mocks.nowMs += 400_001;
      }
      return { visible: true, enabled: true, contentEditable: true };
    });
    const outcome = await runNewChatTurn(turn.page, '/tmp/2487-late-owner.txt', '400000');
    expect(outcome.result).toMatchObject({
      state: 'driver_error', send_count: 0,
      cause: 'state_light_new_chat_owner_pre_dispatch_deadline_exhausted',
    });
    expect(turn.getSends()).toBe(0);
    // The original owner returns through its fresh-send lock finalizer.
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
    const claimPath = join(claimDir, `${sha256(SHARED_CANONICAL_CONV)}.json`);
    writeFileSync(claimPath, '{not-json');
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'successor-claim', 5_000)).toBe('contended');
    writeFileSync(claimPath, '{}\n');
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'successor-claim-schema-invalid', 5_000)).toBe('contended');
    rmSync(claimPath);
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'successor-claim', 5_000)).toBe('claimed');
    releaseStateLightFreshConversationClaim(profileKey, SHARED_CONV, 'successor-claim', 5_000);
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
      (await import('./storage-common.ts')).sha256(SHARED_CANONICAL_CONV) + '.json',
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
    const claimPath = join(stateDir, profileKey, 'state-light-fresh-claims', `${sha256(SHARED_CANONICAL_CONV)}.json`);
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

  function runProductionNewChat(
    outputPath: string, timeoutMs: string, pollMs = '1', invocationId = randomUUID(),
  ) {
    return runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--invocation-id', invocationId,
      '--output', outputPath,
      '--new-chat',
      '--project-url', PROJECT_URL,
      '--timeout-ms', timeoutMs,
      '--poll-ms', pollMs,
    ]);
  }

  it('takes a concurrently harvested probe primary instead of reversing phase after recovery census (#2678 R2)', async () => {
    const prompt = 'RECOVERY-PROBE-COMMIT-RACE';
    const reply = 'EXTERNAL-COMMITTED-RECOVERY-REPLY';
    const invocationId = randomUUID();
    const output = join(integrationStateDir, 'recovery-probe-committed.txt');
    let lost = false;
    let injected = false;
    const original = makeLoserPage(prompt, 'UNTRUSTED-ORIGINAL', () => { lost = true; }, true);
    proveCreatedPageRemainsVisibleToCdp(original.page);
    // Admit a lost Page only after the physical Send was recorded. This
    // specifically exercises a probe commit during recovery, not zero-witness
    // dispatching recovery while the initial Page is still sending.
    let admittedLoss = false;
    original.page.isClosed.mockImplementation(() => {
      if (admittedLoss) return true;
      if (!lost) return false;
      try {
        admittedLoss = ['sent_unbound', 'sent_unharvested', 'harvested']
          .includes(readStateLightTurnObservation('collision-profile', invocationId).phase);
      } catch { /* Observation is not committed yet. */ }
      return admittedLoss;
    });
    const originalLocator = original.page.locator.getMockImplementation()!;
    original.page.locator.mockImplementation((selector: string) =>
      lost && selector === USER_MESSAGE_SELECTOR
        ? collectionLocator([]) : originalLocator(selector));
    const recoveredClose = vi.fn(async () => undefined);
    const recovered: any = {
      __fakeBrowserGptPage: true,
      url: () => SHARED_CONV,
      isClosed: () => false,
      close: recoveredClose,
      locator: (selector: string) => {
        if (selector === USER_MESSAGE_SELECTOR) {
          return {
            count: async () => 1,
            nth: () => ({
              innerText: async () => {
                if (!injected) {
                  injected = true;
                  const before = readStateLightTurnObservation('collision-profile', invocationId);
                  expect(['sent_unbound', 'sent_unharvested']).toContain(before.phase);
                  const publication = await finalizeStateLightPrimaryPublication({
                    profileKey: 'collision-profile', invocationId, target: output,
                    bytes: Buffer.from(reply, 'utf8'),
                    publish: () => publishStateLightReply(output, invocationId, reply),
                  });
                  expect(publication.state).toBe('committed_ok');
                }
                return `${TEST_OWNED_MARKER}\n\n${prompt}`;
              },
            }),
          };
        }
        return scalarLocator();
      },
    };
    const browser = browserWithPages(original.page, [recovered], () => true);
    mocks.browserQueue.push(browser);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const result = await runProductionNewChat(output, '90000', '1000', invocationId);
    expect(injected).toBe(true);
    expect(result.result, JSON.stringify(result.result)).toMatchObject({
      state: 'ok', cause: 'completed_page_probe_primary', send_count: 1,
      cleanup: 'unconfirmed',
    });
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('harvested');
    expect(readFileSync(output, 'utf8')).toBe(reply);
    expect(original.getSends()).toBe(1);
    expect(original.page.close).not.toHaveBeenCalled();
    expect(recoveredClose).not.toHaveBeenCalled();
  });

  it('reconnects after post-send browser loss, claims the exact recovered conversation, and never resends or mutates a foreign page', async () => {
    const prompt = 'PROMPT-RECOVER';
    const reply = 'RECOVERED FINAL';
    const output = join(integrationStateDir, 'recovered.txt');
    let sends = 0;
    let lost = false;
    let recoveredClockAdvanced = false;
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
      url: vi.fn(() => {
        if (lost && !recoveredClockAdvanced) {
          // The invocation's 50-ms pre-send deadline has expired, while
          // post-send recovery still has its own 2x observation window.
          recoveredClockAdvanced = true;
          mocks.nowMs += 60;
        }
        return SHARED_CONV;
      }),
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

    const outcome = await runProductionNewChat(output, '90000');

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
    expect(recoveredClockAdvanced).toBe(true);
    expect(mocks.nowMs).toBeGreaterThanOrEqual(10_060);
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
    // URL/visible Stop is not an original-tab and active-generation witness.
    // Explicit cancellation must be a no-effect refusal even on this singleton.
    expect(await stopOwnedGeneration(stopProbePage, EXPLICIT_CANCELLATION_AUTHORITY))
      .toBe('not_attempted_identity_unproven');
    expect(stopProbeClick).not.toHaveBeenCalled();
    expect(stopProbePage.locator).not.toHaveBeenCalled();

    mocks.browserQueue.push(browserWithPages(ownedPage, [ownedPage, foreignPage], () => true));
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));

    const outcome = await runProductionNewChat(output, '90000');

    expect(outcome.result).toMatchObject({
      state: 'observation_uncertain', cause: 'post_send_absolute_deadline_elapsed',
      send_count: 1, cleanup: 'unconfirmed',
    });
    expect(outcome.result.incidents).toContain('post_send_observation_error');
    expect(outcome.result.incidents).toContain('owned_tab_cleanup_unconfirmed');
    expect(ownedStop, JSON.stringify(outcome)).not.toHaveBeenCalled();
    // Same-last-marker Stop does not prove who owns the current generation.
    expect(sends).toBe(1);
    expect(foreignStop).not.toHaveBeenCalled();
    expect(ownedClose).not.toHaveBeenCalled();
    expect(foreignClose).not.toHaveBeenCalled();
  });

  it('publishes a committed owned reply before closing only its original tab (#2494 AC1)', async () => {
    const prompt = 'COMMITTED-2494';
    const reply = 'COMMITTED FINAL';
    const output = join(integrationStateDir, 'committed-2494.txt');
    const turn = makeLoserPage(prompt, reply);
    let closed = false;
    let publicationAtClose: string | undefined;
    turn.page.isClosed.mockImplementation(() => closed);
    turn.page.close.mockImplementation(async () => {
      publicationAtClose = existsSync(output) ? readFileSync(output, 'utf8') : undefined;
      closed = true;
    });
    proveCreatedPageCanClose(turn.page);
    const browser = browserWithPages(turn.page, [turn.page], () => true);
    mocks.browserQueue.push(browser);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const terminal = await runProductionNewChat(output, '90000');
    expect(terminal.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(terminal.code).toBe(0);
    expect(publicationAtClose).toBe(reply);
    expect(turn.getSends()).toBe(1);
    expect(turn.page.close).toHaveBeenCalledTimes(1);
  });

  it('terminalizes a definitely lost owned tab without a reply inside the child-only bound (#2494 AC2)', async () => {
    const prompt = 'LOST-NO-REPLY-2494';
    const output = join(integrationStateDir, 'lost-2494.txt');
    let lost = false;
    let lostAt: number | undefined;
    const turn = makeLoserPage(prompt, 'NEVER PUBLISHED');
    // The Send is already positively witnessed on the exact page before the
    // post-send observation loses the tab; do not fabricate a send count.
    mocks.productStatusText.mockImplementation(async () => {
      if (turn.getSends() > 0) {
        lost = true;
        lostAt ??= mocks.nowMs;
      }
      return { text: '', composer: true };
    });
    turn.page.isClosed.mockImplementation(() => lost);
    turn.page.waitForTimeout.mockImplementation(async (ms: number) => {
      mocks.nowMs += Math.max(ms, 5_000);
    });
    const foreignClose = vi.fn(async () => undefined);
    const foreignStop = vi.fn(async () => undefined);
    const foreignPage = {
      url: vi.fn(() => LOSER_CONV),
      isClosed: vi.fn(() => false),
      close: foreignClose,
      locator: vi.fn(() => scalarLocator({ click: foreignStop })),
    };
    const browser = browserWithPages(turn.page, [foreignPage], () => true);
    const context = browser.contexts()[0]!;
    context.newPage.mockResolvedValueOnce(turn.page).mockRejectedValueOnce(new Error('successor unavailable'));
    mocks.browserQueue.push(browser);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const terminal = await runProductionNewChat(output, '90000');
    expect(lostAt).toBeDefined();
    expect(mocks.nowMs - lostAt!).toBeLessThan(60_000);
    expect(terminal.result.state).not.toBe('ok');
    expect(terminal.result.send_count).toBe(1);
    expect(terminal.code).not.toBe(0);
    expect(existsSync(output)).toBe(false);
    expect(turn.getSends()).toBe(1);
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(foreignClose).not.toHaveBeenCalled();
    expect(foreignStop).not.toHaveBeenCalled();
  });

  it.each([true, false])('handles Target crashed during a pending owned post-send read, closed=%s (#2494 AC3)', async (closeDuringRead) => {
    const prompt = 'IN-FLIGHT-2494';
    const output = join(integrationStateDir, 'in-flight-' + String(closeDuringRead) + '.txt');
    let lost = false;
    let lostAt: number | undefined;
    const turn = makeLoserPage(prompt, 'NEVER PUBLISHED');
    proveCreatedPageRemainsVisibleToCdp(turn.page);
    turn.page.isClosed.mockImplementation(() => lost);
    turn.page.waitForTimeout.mockImplementation(async (ms: number) => {
      mocks.nowMs += Math.max(ms, 5_000);
    });
    // This rejection is emitted by readPostSendObservation's product-status
    // read, after the same page has been sent. The paired error bytes are equal.
    mocks.productStatusText.mockImplementation(async () => {
      if (turn.getSends() === 0) return { text: '', composer: true };
      await Promise.resolve();
      if (closeDuringRead) {
        lost = true;
        lostAt = mocks.nowMs;
      }
      throw new Error('Target crashed');
    });
    const foreignClose = vi.fn(async () => undefined);
    const foreignPage = {
      url: vi.fn(() => LOSER_CONV),
      isClosed: vi.fn(() => false),
      close: foreignClose,
      locator: vi.fn(() => scalarLocator()),
    };
    const browser = browserWithPages(turn.page, [foreignPage], () => true);
    const context = browser.contexts()[0]!;
    context.newPage.mockResolvedValueOnce(turn.page).mockRejectedValueOnce(new Error('successor unavailable'));
    mocks.browserQueue.push(browser);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const terminal = await runProductionNewChat(output, '90000');
    expect(turn.getSends()).toBe(1);
    expect(terminal.result.send_count).toBe(1);
    expect(terminal.result.state).not.toBe('ok');
    if (closeDuringRead) {
      expect(lostAt).toBeDefined();
      expect(mocks.nowMs - lostAt!).toBeLessThan(60_000);
      expect(terminal.result.cause).not.toBe('post_send_target_crashed');
    } else {
      expect(lostAt).toBeUndefined();
      expect(terminal.result).toMatchObject({ state: 'driver_error', cause: 'post_send_target_crashed' });
    }
    // A crash is not a current-generation/physical-CDP close witness. Even a
    // reachable fake Page must not be closed from the old handle alone.
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(terminal.result.cleanup).toBe('unconfirmed');
    expect(foreignClose).not.toHaveBeenCalled();
  });

  it('reserves poll detection, recovery and slow CDP cleanup inside the loss-to-result clock (#2494 F1)', async () => {
    const prompt = 'LOST-DURING-POLL-2494';
    const turn = makeLoserPage(prompt, 'UNPUBLISHED');
    const originalLocator = turn.page.locator.getMockImplementation()!;
    const waitingMessages: StateLightTestMessage[] = [
      { role: 'user', text: TEST_OWNED_MARKER + '\n\n' + prompt },
      { role: 'assistant', text: 'working', inProgress: true },
    ];
    turn.page.locator.mockImplementation((selector: string) =>
      selector === MESSAGE_NODE_SELECTOR && turn.getSends() > 0
        ? collectionLocator(waitingMessages, true)
        : originalLocator(selector));
    let lost = false;
    let lostAt: number | undefined;
    turn.page.isClosed.mockImplementation(() => lost);
    turn.page.waitForTimeout.mockImplementation(async (ms: number) => {
      if (!lost && turn.getSends() === 1 && ms === POST_SEND_OBSERVATION_POLL_MS) {
        lostAt = mocks.nowMs + 1; // Closure one millisecond into a 15s ordinary poll.
        lost = true;
      }
      mocks.nowMs += ms;
    });
    const unreachableOwnedReply = {
      url: vi.fn(() => SHARED_CONV),
      isClosed: vi.fn(() => false),
      locator: vi.fn(() => collectionLocator([])),
    };
    const foreignClose = vi.fn(async () => undefined);
    const foreignPage = {
      url: vi.fn(() => LOSER_CONV),
      isClosed: vi.fn(() => false),
      close: foreignClose,
      locator: vi.fn(() => collectionLocator([])),
    };
    mocks.browserQueue.push(browserWithPages(turn.page, [unreachableOwnedReply, foreignPage], () => true));
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const release = mocks.releaseBrowser.getMockImplementation();
    mocks.releaseBrowser.mockImplementation(async () => { mocks.nowMs += 15_000; });
    try {
      const result = await runProductionNewChat(join(integrationStateDir, 'loss-poll-2494.txt'), '90000', '1000');
      expect(lostAt).toBeDefined();
      expect(result.code).not.toBe(0);
      expect(result.result.send_count).toBe(1);
      expect(result.result.state).not.toBe('ok');
      // Entire production post-send loop with fixture-controlled polling,
      // confirmed loss, bounded recovery and 15s cleanup. With 30s recovery,
      // the old budget costs 15s + 30s + 15s and overruns the child bound.
      expect(mocks.nowMs - lostAt!).toBeLessThan(60_000);
      // Include the actual process termination and flushed terminal in the same
      // loss-clock oracle; the subprocess consumes the outcome produced by the
      // real mocked browser loop rather than an independently invented status.
      const entryUrl = pathToFileURL(join(import.meta.dirname, 'state-light-entry.ts')).href;
      const turnUrl = pathToFileURL(join(import.meta.dirname, 'state-light-turn.ts')).href;
      const childScript = [
        'import { runStateLightExecutable } from ' + JSON.stringify(entryUrl) + ';',
        'import { runStateLightTurn } from ' + JSON.stringify(turnUrl) + ';',
        'const result = ' + JSON.stringify(result.result) + ';',
        'setInterval(() => {}, 60_000);',
        "await runStateLightExecutable(['turn', '--profile', 'synthetic'], {",
        '  runTurn: (args, opts) => runStateLightTurn(args, { ...opts, runTurn: async () => ({ result }) }),',
        '});',
      ].join('\n');
      const childStarted = process.hrtime.bigint();
      const child = runProcessSync({
        command: process.execPath,
        args: ['--experimental-strip-types', '--input-type=module', '--eval', childScript],
        cwd: join(import.meta.dirname, '../..'),
        timeoutMs: 8_000,
        env: {
          ...process.env,
          CHATGPT_BROWSER_TURN_STATE_DIR: join(integrationStateDir, 'child-state'),
          ORCA_TERMINAL_HANDLE: '',
          NODE_OPTIONS: '',
        },
        inheritParentEnv: false,
      });
      const childMs = Number((process.hrtime.bigint() - childStarted) / 1_000_000n);
      expect(child.outcome, child.stderr).toBe('exit'); // test-side kill never passes
      expect(child.exitCode, child.stderr).toBe(result.code);
      expect(child.stdout.endsWith('\n')).toBe(true);
      const lines = child.stdout.trimEnd().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        schema: 'turn-result/v1', state: result.result.state, send_count: 1,
      });
      expect(mocks.nowMs - lostAt! + childMs).toBeLessThan(60_000);
      expect(turn.getSends()).toBe(1);
      expect(turn.page.close).not.toHaveBeenCalled();
      expect(foreignClose).not.toHaveBeenCalled();
    } finally {
      mocks.releaseBrowser.mockImplementation(release ?? (async () => undefined));
    }
  });

  it.each(['secondary', 'final'] as const)(
    'recovers only confirmed owned-tab loss at the %s post-send read boundary (#2494 F2)',
    async (boundary) => {
      for (const closed of [true, false]) {
        const prompt = 'LATE-CRASH-2494-' + boundary + '-' + String(closed);
        const reply = 'RECOVERED OWNED ANSWER';
        const turn = makeLoserPage(prompt, reply);
        const output = join(integrationStateDir, boundary + '-' + String(closed) + '.txt');
        let lost = false;
        let injected = 0;
        const originalLocator = turn.page.locator.getMockImplementation()!;
        turn.page.isClosed.mockImplementation(() => lost);
        turn.page.locator.mockImplementation((selector: string) => {
          const stopAfterFirstObservation = boundary === 'secondary'
            && selector === RENDERED_STOP_BUTTON_SELECTOR && turn.getObservationReads() >= 2;
          const finalConfirmation = boundary === 'final'
            && selector === MESSAGE_NODE_SELECTOR && turn.getObservationReads() >= 5;
          if (!injected && turn.getSends() > 0 && (stopAfterFirstObservation || finalConfirmation)) {
            return scalarLocator({
              count: vi.fn(async () => {
                injected += 1;
                lost = closed;
                throw new Error('Target crashed');
              }),
            });
          }
          return originalLocator(selector);
        });
        const recoveredMessages: StateLightTestMessage[] = [
          { role: 'user', text: TEST_OWNED_MARKER + '\n\n' + prompt },
          { role: 'assistant', text: reply, finalAction: true, finalActionInTurnContainer: true },
        ];
        const recoveredPage = {
          __fakeBrowserGptPage: true,
          url: vi.fn(() => SHARED_CONV),
          isClosed: vi.fn(() => false),
          close: vi.fn(async () => undefined),
          waitForTimeout: vi.fn(async (ms: number) => { mocks.nowMs += ms; }),
          getByText: vi.fn(() => scalarLocator()),
          getByRole: vi.fn(() => scalarLocator()),
          locator: vi.fn((selector: string) => {
            if (selector === MESSAGE_NODE_SELECTOR) return collectionLocator(recoveredMessages, false);
            if (selector === USER_MESSAGE_SELECTOR) return collectionLocator(recoveredMessages.slice(0, 1), false);
            if (selector === ASSISTANT_MESSAGE_SELECTOR) return collectionLocator(recoveredMessages.slice(1), false);
            if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
              return messageLocator(recoveredMessages[1]!, false);
            }
            return scalarLocator();
          }),
        };
        const foreignClose = vi.fn(async () => undefined);
        const foreignStop = vi.fn(async () => undefined);
        const foreignPage = {
          url: vi.fn(() => LOSER_CONV),
          isClosed: vi.fn(() => false),
          close: foreignClose,
          locator: vi.fn(() => scalarLocator({ click: foreignStop })),
        };
        const browser = browserWithPages(turn.page, [foreignPage, recoveredPage], () => true);
        mocks.browserQueue.push(browser);
        mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
        const result = await runProductionNewChat(output, '90000');
        expect(injected).toBe(1);
        expect(turn.getSends()).toBe(1);
        expect(result.result.send_count).toBe(1);
        if (closed) {
          expect(result, JSON.stringify(result)).toMatchObject({
            code: 0, result: { state: 'ok', cause: 'completed_page_only', conversation_id: SHARED_CONV },
          });
          expect(readFileSync(output, 'utf8')).toBe(reply);
        } else {
          expect(result.result).toMatchObject({
            state: 'driver_error', cause: 'helper_error_after_send_page_retained',
          });
          expect(existsSync(output)).toBe(false);
        }
        // A reconnected recovery handle is not an authenticated close handle.
        expect(turn.page.close).not.toHaveBeenCalled();
        expect(foreignClose).not.toHaveBeenCalled();
        expect(foreignStop).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['surface_unknown', 'message_nodes_missing', 'target_not_found'])(
    'does not treat %s on an open connected page as definite owned-tab loss (#2494 AC3)', async (diagnostic) => {
      const page = {
        isClosed: vi.fn(() => false),
        locator: vi.fn(() => scalarLocator({ count: vi.fn(async () => { throw new Error(diagnostic); }) })),
      };
      const browser = { isConnected: vi.fn(() => true) };
      expect(__testBrowserOrPageDefinitelyLost(page, browser)).toBe(false);
      expect(await probePageLiveness(page, browser)).toBe('unknown');
    },
  );

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

  function livenessArgv(outputPath: string, timeoutMs = '90000') {
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

  it('keeps healthy heartbeats flowing while a stalled profile verification is terminated by its invocation budget', async () => {
    const prompt = 'PROMPT-LIVENESS-PROFILE-STALL';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const profileEntered = Promise.withResolvers<void>();
    const pendingVerification = new Promise<any>(() => {});
    let observedBudgetMs = 0;
    mocks.verifyProfile.mockImplementationOnce((...args: any[]) => {
      const operationBudget = args[1] as { clampOperationWaitMs?: () => number } | undefined;
      observedBudgetMs = operationBudget?.clampOperationWaitMs?.() ?? 0;
      profileEntered.resolve();
      return pendingVerification;
    });

    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      // The containing beforeEach mocks Date.now; let this test's timer clock own it.
      vi.spyOn(Date, 'now').mockRestore();
      const startedAt = mocks.nowMs;
      vi.useFakeTimers({
        now: startedAt,
        toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      });
      const turn = runStateLightTurn(
        livenessArgv(join(livenessStateDir, 'profile-stall.txt'), '45'),
        { entryLivenessHeartbeat: true },
      );
      let turnSettled = false;
      void turn.then(
        () => { turnSettled = true; },
        () => { turnSettled = true; },
      );
      await profileEntered.promise;
      expect(mocks.verifyProfile).toHaveBeenCalledTimes(1);
      expect(mocks.verifyProfile.mock.results[0]?.value).toBe(pendingVerification);

      await vi.advanceTimersByTimeAsync(15);
      mocks.nowMs = Date.now();
      expect(mocks.nowMs - startedAt).toBe(15);
      const preExpiryRecords = parseRecords(writes);
      const preExpiryHeartbeats = preExpiryRecords.filter((record) => record.schema === 'observation-heartbeat/v1');
      expect(preExpiryHeartbeats.length).toBeGreaterThan(2);
      expect(preExpiryHeartbeats.some((record) => record.phase === 'admitted_pre_send')).toBe(true);
      expect(preExpiryRecords.some((record) => record.schema === 'turn-result/v1')).toBe(false);
      expect(turnSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(30);
      mocks.nowMs = Date.now();
      expect(mocks.nowMs - startedAt).toBe(45);
      const code = await turn;
      expect(code).not.toBe(0);
      expect(observedBudgetMs).toBeGreaterThan(0);
      expect(observedBudgetMs).toBeLessThanOrEqual(45);
      const records = parseRecords(writes);
      const heartbeats = records.filter((record) => record.schema === 'observation-heartbeat/v1');
      expect(heartbeats.length).toBeGreaterThan(2);
      expect(heartbeats.some((record) => record.phase === 'admitted_pre_send')).toBe(true);
      expect(records.at(-1)).toMatchObject({
        schema: 'turn-result/v1',
        state: 'driver_error',
        cause: 'browser_operation_timeout:profile_verification',
        send_count: 0,
      });
    } finally {
      vi.useRealTimers();
      stdout.mockRestore();
      vi.restoreAllMocks();
    }
  });

  it('refuses an unresolved fresh Send actionability count with live heartbeats and zero clicks', async () => {
    const prompt = 'PROMPT-LIVENESS-LOCATOR-STALL';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const fake = makeLoserPage(prompt, 'UNREACHABLE');
    fake.sendButton.count.mockImplementationOnce(() => new Promise<number>(() => {}));
    enqueueBrowserForTurn(mocks, fake.page);

    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const code = await runStateLightTurn(
        livenessArgv(join(livenessStateDir, 'locator-stall.txt'), '90000'),
        { entryLivenessHeartbeat: true },
      );
      expect(code).not.toBe(0);
      expect(fake.sendButton.click).not.toHaveBeenCalled();
      const records = parseRecords(writes);
      const heartbeats = records.filter((record) => record.schema === 'observation-heartbeat/v1');
      expect(heartbeats.length).toBeGreaterThan(2);
      expect(records.at(-1)).toMatchObject({
        schema: 'turn-result/v1',
        state: 'ui_contract_mismatch',
        cause: 'fresh_send_actionability_unknown_or_busy',
        send_count: 0,
      });
    } finally {
      stdout.mockRestore();
    }
  });

  it('emits healthy heartbeats while profile verification exceeds the recurring idle window', async () => {
    const prompt = 'PROMPT-LIVENESS-PROFILE';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const profileEntered = Promise.withResolvers<void>();
    const releaseProfile = Promise.withResolvers<{ state: 'verified' }>();
    mocks.verifyProfile.mockImplementationOnce(() => {
      profileEntered.resolve();
      return releaseProfile.promise;
    });
    const fake = makeLoserPage(prompt, 'PROFILE-FINAL');
    enqueueBrowserForTurn(mocks, fake.page);

    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      // Drive the 5 ms heartbeat interval through 45 ms of pending profile
      // verification; real CI scheduling must not decide how many ticks run.
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      });
      const turn = runStateLightTurn(
        livenessArgv(join(livenessStateDir, 'profile.txt')),
        { entryLivenessHeartbeat: true },
      );
      await profileEntered.promise;
      await vi.advanceTimersByTimeAsync(45);
      const pendingRecords = parseRecords(writes);
      const pendingHeartbeats = pendingRecords.filter(
        (record) => record.schema === 'observation-heartbeat/v1',
      );
      expect(pendingHeartbeats.filter((record) => record.phase === 'admitted_pre_send').length)
        .toBeGreaterThan(2);
      expect(pendingRecords.some((record) => record.schema === 'turn-result/v1')).toBe(false);

      // Let the rest of the owned Send and terminal publication use real timers.
      vi.useRealTimers();
      releaseProfile.resolve({ state: 'verified' });
      const code = await turn;
      expect(code).toBe(0);
      const records = parseRecords(writes);
      const heartbeats = records.filter((record) => record.schema === 'observation-heartbeat/v1');
      expect(heartbeats.length).toBeGreaterThan(2);
      expect(records.at(-1)).toMatchObject({
        schema: 'turn-result/v1',
        state: 'ok',
        send_count: 1,
      });
    } finally {
      vi.useRealTimers();
      releaseProfile.resolve({ state: 'verified' });
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
        livenessArgv(join(livenessStateDir, 'recovery-page.txt'), '90000'),
        {
          entryLivenessHeartbeat: true,
          recoveryHooks: {
            faultActuator: () => {
              lost = true;
              // Reach the post-send deadline with only a bounded recovery
              // newPage budget; the full 60s pre-send reserve was already met.
              mocks.nowMs += (2 * 90_000) - 2_000;
            },
          },
        },
      );
      expect(code).not.toBe(0);
      const records = parseRecords(writes);
      const heartbeats = records.filter((record) => record.schema === 'observation-heartbeat/v1');
      // r06's original absolute bound shortens this synthetic recovery window.
      expect(heartbeats.length).toBeGreaterThanOrEqual(3);
      expect(heartbeats.some((record) => record.phase === 'post_send_observation')).toBe(true);
      // Current identity admission refuses a zero-match recovery census
      // before allocating any successor. The pending fixture creation is
      // deliberately never invoked; unrelated target(s) remain untouched.
      expect(records.at(-1)).toMatchObject({
        schema: 'turn-result/v1',
        state: 'ui_contract_mismatch',
        cause: 'owned_conversation_recovery_zero_match',
        send_count: 1,
      });
      expect(sends).toBe(1);
      expect(context.newPage).toHaveBeenCalledTimes(1);
      expect(initialClose).not.toHaveBeenCalled();
      expect(foreignPage.close).not.toHaveBeenCalled();

      resolveLateSuccessor(lateSuccessor);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(lateSuccessor.close).not.toHaveBeenCalled();
      expect(lateSuccessor.goto).not.toHaveBeenCalled();
      expect(foreignPage.close).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });
});


describe('Issue #1990 late-banner execute-Issue recovery', () => {
  let integrationStateDir: string;
  const timeoutText = 'Message delivery timed out. Please try again.';

  beforeEach(() => {
    integrationStateDir = mkdtempSync(join(tmpdir(), 'slt-1990-'));
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = integrationStateDir;
    disableSendSlotForTest();
    mocks.browserQueue.length = 0;
    mocks.cleanupOutcome = 'confirmed';
    mocks.verifyProfile.mockReset();
    mocks.verifyProfile.mockResolvedValue({ state: 'verified' });
    mocks.nowMs = 10_000;
    mocks.readStableInput.mockReset();
    vi.spyOn(Date, 'now').mockImplementation(() => mocks.nowMs);
  });

  afterEach(() => {
    delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
    clearSendSlotDisableEnv();
    rmSync(integrationStateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function runExistingChat(page: any, outputPath: string, timeoutMs = '5000') {
    enqueueBrowserForTurn(mocks, page);
    return runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--invocation-id', randomUUID(),
      '--output', outputPath,
      '--chat-url', SHARED_CONV,
      '--timeout-ms', timeoutMs,
      '--poll-ms', '1',
    ]);
  }

  function recoveryPage(sequence: ReadonlyArray<'generating' | 'banner'>, bannerText = timeoutText) {
    let sent = false;
    let filled = '';
    let observationIndex = 0;
    let phase: 'generating' | 'banner' = sequence[0] ?? 'generating';
    const retryClicks = vi.fn(async () => undefined);
    const sendClicks = vi.fn(async () => { sent = true; });
    const close = vi.fn(async () => undefined);

    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async (value: string) => { filled = value; }),
      innerText: vi.fn(async () => filled),
      textContent: vi.fn(async () => filled),
      press: sendClicks,
    });
    const sendButton = scalarLocator({
      count: vi.fn(async () => 1),
      click: sendClicks,
    });
    const historicalUser = {
      getAttribute: (name: string) => name === MESSAGE_AUTHOR_ROLE_ATTR ? 'user-message' : null,
      getBoundingClientRect: () => ({ height: 1 }),
      innerText: 'historical user',
      closest: (selector: string) => selector.includes('data-turn-key')
        ? { getAttribute: () => 'conversation-turn-history' } : null,
      querySelectorAll: () => [],
      querySelector: (selector: string) => selector === `[${MESSAGE_AUTHOR_ROLE_ATTR}]`
        ? { getAttribute: () => 'user-message' } : null,
    };

    function currentPhase(): 'generating' | 'banner' {
      if (!sent) return 'generating';
      return sequence[Math.min(observationIndex, sequence.length - 1)] ?? 'generating';
    }

    function messageElements() {
      phase = currentPhase();
      const user = {
        getAttribute: (name: string) => (name === MESSAGE_AUTHOR_ROLE_ATTR ? 'user-message' : null),
        getBoundingClientRect: () => ({ height: 1 }),
        innerText: filled || `${TEST_OWNED_MARKER}\n\nPROMPT`,
        closest: (selector: string) => (
          selector.includes('data-turn-key')
            ? { getAttribute: () => 'conversation-turn-1' }
            : null
        ),
        querySelectorAll: () => [],
        querySelector: (selector: string) => (
          selector === `[${MESSAGE_AUTHOR_ROLE_ATTR}]` ? { getAttribute: () => 'user-message' } : null
        ),
      };
      const assistantInner = phase === 'banner' ? `${bannerText}\n\nRetry` : 'working';
      const assistant = {
        getAttribute: (name: string) => (name === MESSAGE_AUTHOR_ROLE_ATTR ? 'assistant-message' : null),
        getBoundingClientRect: () => ({ height: 1 }),
        innerText: assistantInner,
        closest: (selector: string) => (
          selector.includes('data-turn-key')
            ? { getAttribute: () => 'conversation-turn-2' }
            : null
        ),
        querySelectorAll: (selector: string) => (
          selector === 'p' && phase === 'banner' ? [{ innerText: bannerText }] : []
        ),
        querySelector: (selector: string) => (
          selector === `[${MESSAGE_AUTHOR_ROLE_ATTR}]`
            ? { getAttribute: () => 'assistant-message' }
            : selector.includes('regenerate-thread-error') && phase === 'banner'
              ? { innerText: 'Retry' }
              : null
        ),
      };
      return { user, assistant, phase };
    }

    const page: any = {
      __fakeBrowserGptPage: true,
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => SHARED_CONV),
      isClosed: vi.fn(() => false),
      waitForTimeout: vi.fn(async (ms: number) => { mocks.nowMs += ms; }),
      close,
      getByText: vi.fn(() => scalarLocator()),
      getByRole: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return sendButton;
        if (selector.includes('regenerate-thread-error') || selector.includes('data-testid*="error"')) {
          return scalarLocator({
            count: vi.fn(async () => (sent && currentPhase() === 'banner' ? 1 : 0)),
            nth: vi.fn(() => scalarLocator({
              innerText: vi.fn(async () => 'Retry'),
              click: retryClicks,
            })),
            click: retryClicks,
          });
        }
        if (selector.includes('role="alert"')) {
          return scalarLocator({
            count: vi.fn(async () => 1),
            nth: vi.fn(() => scalarLocator({ innerText: vi.fn(async () => '') })),
          });
        }
        if (selector === MESSAGE_NODE_SELECTOR) {
          if (!sent) {
            return Object.assign(collectionLocator([{ role: 'user', text: 'historical user' }]), {
              evaluateAll: vi.fn(async () => ({
                rows: [{
                  role: 'user', text: 'historical user', key: 'historical-user-1990', domIndex: 0,
                  complete: true, completionReady: false, continuationVisible: false,
                }],
                pageTurnEvidence: {
                  generationInProgress: false, observedAssistantNodes: 0,
                  continueGeneratingVisible: false,
                },
              })),
            });
          }
          const snapshot = messageElements();
          const pollIndex = observationIndex;
          observationIndex += 1;
          const messages = [
            { role: 'user' as const, text: 'historical user' },
            { role: 'user' as const, text: filled },
            {
              role: 'assistant' as const,
              text: snapshot.phase === 'banner' ? `${timeoutText}\n\nRetry` : 'working',
            },
          ];
          const loc = collectionLocator(messages, snapshot.phase === 'generating');
          loc.evaluateAll = vi.fn(async (
            callback: (elements: Element[], args: unknown) => unknown,
            args: unknown,
          ) => {
            const prior = (globalThis as { document?: unknown }).document;
            const generating = snapshot.phase === 'generating';
            (globalThis as { document?: unknown }).document = {
              querySelectorAll: (sel: string) => {
                if (sel.includes('data-turn-key')) {
                  return [
                    { getAttribute: () => 'conversation-turn-history' },
                    { getAttribute: () => 'conversation-turn-1' },
                    { getAttribute: () => 'conversation-turn-2' },
                  ];
                }
                if (sel.includes('assistant')) return [snapshot.assistant];
                return [];
              },
              querySelector: (sel: string) => {
                if (sel.includes('stop-button') || sel.includes('aria-busy') || sel.includes('streaming')) {
                  return generating ? {} : null;
                }
                return null;
              },
            };
            try {
              return callback([historicalUser, snapshot.user, snapshot.assistant] as unknown as Element[], args);
            } finally {
              if (prior === undefined) delete (globalThis as { document?: unknown }).document;
              else (globalThis as { document?: unknown }).document = prior;
            }
          });
          void pollIndex;
          return loc;
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          if (!sent) return collectionLocator([]);
          const snapshot = messageElements();
          return collectionLocator([{
            role: 'assistant',
            text: snapshot.phase === 'banner' ? `${timeoutText}\n\nRetry` : 'working',
          }], snapshot.phase === 'generating');
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH) {
          return scalarLocator({ count: vi.fn(async () => 0) });
        }
        if (matchesStopButtonSelector(selector) || selector.includes(STOP_BUTTON_TESTID)) {
          return scalarLocator({
            count: vi.fn(async () => (sent && currentPhase() === 'generating' ? 1 : 0)),
          });
        }
        return scalarLocator();
      }),
    };
    return { page, retryClicks, sendClicks, close, getSends: () => (sent ? 1 : 0) };
  }

  it('emits recovery_required on the first poll where the successor-turn banner is visible', async () => {
    const actual = await vi.importActual<typeof import('./ui-adapter.ts')>('./ui-adapter.ts');
    vi.mocked(uiAdapter.productStatusText).mockImplementation(actual.productStatusText);
    vi.mocked(uiAdapter.classifyProductWall).mockImplementation(actual.classifyProductWall);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-1990'));
    const fake = recoveryPage(['generating', 'banner']);
    const outcome = await runExistingChat(fake.page, join(integrationStateDir, 'late-banner.txt'));
    expect(outcome.result).toMatchObject({
      schema: 'turn-result/v1',
      state: 'recovery_required',
      scope: 'conversation',
      cause: 'message_delivery_timed_out',
      send_count: 1,
    });
    expect(fake.getSends()).toBe(1);
    expect(fake.retryClicks).not.toHaveBeenCalled();
    // An unpinned Page handle alone is not close authority.
    expect(fake.close).not.toHaveBeenCalled();
    expect(outcome.result.cleanup).not.toBe('confirmed');
  });

  it('continues in an already-open tab of the conversation instead of reloading it', async () => {
    const actual = await vi.importActual<typeof import('./ui-adapter.ts')>('./ui-adapter.ts');
    vi.mocked(uiAdapter.productStatusText).mockImplementation(actual.productStatusText);
    vi.mocked(uiAdapter.classifyProductWall).mockImplementation(actual.classifyProductWall);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-OPEN-TAB'));
    const fake = recoveryPage(['generating', 'banner']);
    const harness = enqueueBrowserForTurn(mocks, fake.page);
    Object.assign(harness.context, { pages: vi.fn(() => [fake.page]) });
    const outcome = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--invocation-id', randomUUID(),
      '--output', join(integrationStateDir, 'open-tab.txt'),
      '--chat-url', SHARED_CONV,
      '--timeout-ms', '5000',
      '--poll-ms', '1',
    ]);
    expect(harness.context.newPage).not.toHaveBeenCalled();
    expect(fake.page.goto).not.toHaveBeenCalled();
    expect(fake.close).not.toHaveBeenCalled();
    expect(outcome.result).toMatchObject({ goto_count: 0, send_count: 1 });
  });

  it('projects exact message stream errors through the existing conversation recovery result', async () => {
    const actual = await vi.importActual<typeof import('./ui-adapter.ts')>('./ui-adapter.ts');
    vi.mocked(uiAdapter.productStatusText).mockImplementation(actual.productStatusText);
    vi.mocked(uiAdapter.classifyProductWall).mockImplementation(actual.classifyProductWall);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-STREAM-ERROR'));
    const fake = recoveryPage(['generating', 'generating', 'generating', 'generating', 'generating', 'generating', 'banner'], 'Error in message stream');
    const outcome = await runExistingChat(fake.page, join(integrationStateDir, 'stream-error.txt'));
    expect(outcome.result).toMatchObject({
      schema: 'turn-result/v1',
      state: 'recovery_required',
      scope: 'conversation',
      cause: 'message_stream_error',
      send_count: 1,
    });
    expect(fake.getSends()).toBe(1);
    expect(fake.retryClicks).not.toHaveBeenCalled();
    // An unpinned Page handle alone is not close authority.
    expect(fake.close).not.toHaveBeenCalled();
    expect(outcome.result.cleanup).not.toBe('confirmed');
  });

  it('does not end a turn on a recovery banner before its generation was ever observed', async () => {
    const actual = await vi.importActual<typeof import('./ui-adapter.ts')>('./ui-adapter.ts');
    vi.mocked(uiAdapter.productStatusText).mockImplementation(actual.productStatusText);
    vi.mocked(uiAdapter.classifyProductWall).mockImplementation(actual.classifyProductWall);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-STALE-BANNER'));
    const fake = recoveryPage(['banner', 'banner', 'banner'], 'Error in message stream');
    const outcome = await runExistingChat(fake.page, join(integrationStateDir, 'stale-banner.txt'));
    expect(outcome.result.state).not.toBe('recovery_required');
    expect(fake.getSends()).toBe(1);
    expect(fake.retryClicks).not.toHaveBeenCalled();
  });

  it('ends a turn on a recovery banner once the Stop grace after the send runs out', async () => {
    const actual = await vi.importActual<typeof import('./ui-adapter.ts')>('./ui-adapter.ts');
    vi.mocked(uiAdapter.productStatusText).mockImplementation(actual.productStatusText);
    vi.mocked(uiAdapter.classifyProductWall).mockImplementation(actual.classifyProductWall);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-GRACE-BANNER'));
    const fake = recoveryPage(['banner', 'banner', 'banner'], 'Error in message stream');
    const outcome = await runExistingChat(fake.page, join(integrationStateDir, 'grace-banner.txt'), '600000');
    expect(outcome.result).toMatchObject({
      state: 'recovery_required',
      scope: 'conversation',
      cause: 'message_stream_error',
      send_count: 1,
    });
    expect(fake.retryClicks).not.toHaveBeenCalled();
  });

  it('keeps polling with no wall while generation stays active and the banner is absent', async () => {
    const actual = await vi.importActual<typeof import('./ui-adapter.ts')>('./ui-adapter.ts');
    vi.mocked(uiAdapter.productStatusText).mockImplementation(actual.productStatusText);
    vi.mocked(uiAdapter.classifyProductWall).mockImplementation(actual.classifyProductWall);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-1990-WAIT'));
    const fake = recoveryPage(['generating', 'generating', 'generating']);
    const outcome = await runExistingChat(fake.page, join(integrationStateDir, 'still-generating.txt'), '50');
    expect(outcome.result.state).not.toBe('recovery_required');
    expect(outcome.result.cause).not.toBe('message_delivery_timed_out');
    expect(fake.getSends()).toBe(1);
    expect(fake.retryClicks).not.toHaveBeenCalled();
  });
});