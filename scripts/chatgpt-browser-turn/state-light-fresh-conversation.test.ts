import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
  TEST_OWNED_MARKER,
  type StateLightTestMessage,
  type CapturedStateLightTurnResult,
  type StateLightTestSnapshot,
} from './state-light-turn.test-fixtures.ts';
import { classifyPageObservation, classifySendLandingEvidence, readPageObservation, runStateLightTurn } from './state-light-turn.ts';
import { admitStateLightTurnObservation, readStateLightTurnObservation } from './state-light-turn-observation.ts';
import { deriveDelivery } from '../flow-manager-long-running-child.ts';
import { __testBrowserOrPageDefinitelyLost, __testComposerMutation, __testSendDelivery, deriveComposerInsertionBudgetMs, probePageLiveness } from './state-light-turn-base.ts';
import { wrapOwnedPromptPayload } from './owned-prompt-marker.ts';
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
  matchesNewChatControlSelector,
  matchesStopButtonSelector,
  MESSAGE_NODE_SELECTOR,
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

function makeLoserPage(prompt: string, reply: string, onSend?: () => void) {
  let sends = 0;
  let sent = false;
  let composerText = '';
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
    fill: vi.fn(async (value: string) => { composerText = value; }),
    innerText: vi.fn(async () => (sent ? '' : composerText)),
    textContent: vi.fn(async () => (sent ? '' : composerText)),
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
          ? [{ role: 'user', text: `${TEST_OWNED_MARKER}\n\n${prompt}` }]
          : []);
      }
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

  return { page, composer, sendButton, getSends: () => sends };
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

  it('clears a foreign stale composer draft before typing only this invocation marker (#2487)', async () => {
    const prompt = 'PROMPT-FRESH-DRAFT';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'DRAFT-CLEAR-OK');
    await turn.composer.fill('SYNTHETIC-FOREIGN-DRAFT');
    turn.composer.fill.mockClear();
    const result = await runNewChatTurn(turn.page, '/tmp/fresh-draft-2487.txt');
    expect(result.result).toMatchObject({ state: 'ok', send_count: 1, stale_composer_cleared: true });
    expect(turn.getSends()).toBe(1);
    expect(turn.composer.fill.mock.calls.map((args: unknown[]) => args[0])).toEqual([
      '', expect.stringContaining(prompt),
    ]);
  });

  it.each(['\n', ' \t\n'])('sends from an empty ProseMirror composer reading %j (#2492)', async (emptyText) => {
    const prompt = 'PROMPT-NEWLINE-COMPOSER';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'NEWLINE-OK');
    turn.composer.innerText.mockResolvedValueOnce(emptyText);
    const outcome = await runNewChatTurn(turn.page, join(stateDir, 'newline-composer.txt'));
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(turn.getSends()).toBe(1);
    expect(turn.composer.fill.mock.calls.map((args: unknown[]) => args[0])).toEqual([
      expect.stringContaining(prompt),
    ]);
  });

  it('clears abc to a newline-reading empty composer and sends (#2492)', async () => {
    const prompt = 'PROMPT-ABC-COMPOSER';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'CLEARED-OK');
    await turn.composer.fill('abc');
    turn.composer.fill.mockClear();
    const read = turn.composer.innerText.getMockImplementation()!;
    turn.composer.innerText.mockImplementation(async () => (await read()) || '\n');
    const outcome = await runNewChatTurn(turn.page, join(stateDir, 'abc-composer.txt'));
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1, stale_composer_cleared: true });
    expect(turn.getSends()).toBe(1);
    expect(turn.composer.fill.mock.calls.map((args: unknown[]) => args[0])).toEqual([
      '', expect.stringContaining(prompt),
    ]);
  });

  it.each(['', '\n'])('sends a rendered five-newline separator and three-newline suffix for prompt suffix %j (#2492)', async (suffix) => {
    const prompt = `Reply with the single word OK.${suffix}`;
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'OK');
    const read = turn.composer.innerText.getMockImplementation()!;
    turn.composer.innerText.mockImplementation(async () => {
      const text = await read();
      return text ? text.replace(/\n\n/u, '\n\n\n\n\n').trimEnd() + '\n\n\n' : '\n';
    });
    const outcome = await runNewChatTurn(turn.page, join(stateDir, 'rendered-paragraphs.txt'));
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(turn.getSends()).toBe(1);
  });

  it('blocks before clearing or typing if existing fresh composer content cannot be read (#2487)', async () => {
    const prompt = 'PROMPT-UNREADABLE-STALE-DRAFT';
    const invocationId = randomUUID();
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    turn.composer.innerText.mockRejectedValueOnce(new Error('synthetic unreadable composer'));

    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, 'unreadable-stale-draft-2487.txt'), '90000', invocationId,
    );
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch', cause: 'fresh_composer_draft_unreadable', send_count: 0,
    });
    expect(turn.composer.fill).not.toHaveBeenCalled();
    expect(turn.sendButton.click).not.toHaveBeenCalled();
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('not_sent');
  });

  it('blocks before typing when a stale composer draft cannot be safely cleared (#2487)', async () => {
    const prompt = 'PROMPT-UNCLEARABLE-STALE-DRAFT';
    const invocationId = randomUUID();
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    await turn.composer.fill('SYNTHETIC-EXISTING-DRAFT');
    turn.composer.fill.mockClear();
    turn.composer.fill.mockRejectedValueOnce(new Error('synthetic composer clear failure'));

    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, 'unclearable-stale-draft-2487.txt'), '90000', invocationId,
    );
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch', cause: 'fresh_composer_draft_unreadable', send_count: 0,
    });
    expect(turn.composer.fill.mock.calls.map((args: unknown[]) => args[0])).toEqual(['']);
    expect(turn.sendButton.click).not.toHaveBeenCalled();
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('not_sent');
  });

  it('never clears a stale draft after its selected tab is repurposed during the read (#2487)', async () => {
    const prompt = 'PROMPT-STALE-TAB-REPURPOSED';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    await turn.composer.fill('SYNTHETIC-STALE-DRAFT');
    turn.composer.fill.mockClear();
    const originalUrl = turn.page.url.getMockImplementation()!;
    const read = turn.composer.innerText.getMockImplementation()!;
    let repurposed = false;
    turn.page.url.mockImplementation(() => repurposed ? OTHER_PROJECT_CONVERSATION_URL : originalUrl());
    turn.composer.innerText.mockImplementationOnce(async () => {
      const text = await read();
      repurposed = true;
      return text;
    });
    const outcome = await runNewChatTurn(turn.page, join(stateDir, 'repurposed-stale-tab.txt'));
    expect(outcome.result).toMatchObject({ send_count: 0, cause: 'fresh_conversation_surface_unavailable' });
    expect(turn.composer.fill).not.toHaveBeenCalled();
    expect(turn.sendButton.click).not.toHaveBeenCalled();
    expect(turn.page.close).not.toHaveBeenCalled();
  });

  it('clears a fresh draft without a double read or Stop re-check (#2492)', async () => {
    const composer = {
      innerText: vi.fn().mockResolvedValueOnce('abc').mockResolvedValueOnce('\n'),
      fill: vi.fn(async () => undefined),
    };
    const page = { locator: vi.fn(() => composer) };
    expect(await __testSendDelivery.prepareFreshComposerDraft(page, mocks.nowMs + 8_000)).toBe('cleared');
    expect(page.locator).toHaveBeenCalledTimes(1);
    expect(page.locator).toHaveBeenCalledWith(COMPOSER_SELECTOR);
    expect(composer.innerText).toHaveBeenCalledTimes(2);
    expect(composer.fill).toHaveBeenCalledWith('', { timeout: 5_000 });
  });
  it('closes a proven owned, never-clicked draft only after 60s of disabled Send (#2487)', async () => {
    const prompt = 'PROMPT-FRESH-NEVER-ENABLED';
    const invocationId = randomUUID();
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'DO-NOT-SEND');
    turn.sendButton.isEnabled.mockResolvedValue(false);
    const outcome = await runNewChatTurn(turn.page, '/tmp/never-enabled-2487.txt', '90000', invocationId);
    expect(outcome.result).toMatchObject({
      state: 'send_failed', cause: 'fresh_send_button_never_enabled', send_count: 0,
    });
    expect(turn.getSends()).toBe(0);
    expect(turn.sendButton.click).not.toHaveBeenCalled();
    expect(turn.composer.fill).toHaveBeenLastCalledWith('', expect.objectContaining({ timeout: expect.any(Number) }));
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
      state: 'ui_contract_mismatch', cause: 'ui_contract_mismatch:fresh_owned_payload_changed_before_click', send_count: 0,
    });
    expect(turn.getSends()).toBe(0);
    expect(turn.sendButton.click).not.toHaveBeenCalled();
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(turn.composer.fill).toHaveBeenLastCalledWith('SYNTHETIC-FOREIGN-COMPOSER-EDIT');
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
    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, 'slow-stop-reserve.txt'), '90000', invocationId,
    );
    expect(lateProbeInjected).toBe(true);
    expect(outcome.result).toMatchObject({
      state: 'driver_error', cause: 'state_light_new_chat_send_budget_unavailable', send_count: 0,
    });
    expect(turn.sendButton.click).not.toHaveBeenCalled();
    expect(turn.page.close).toHaveBeenCalledTimes(1);
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('not_sent');
  });

  it('closes its already-empty created tab when the budget aborts before any fill (#2487)', async () => {
    const prompt = 'PROMPT-PRE-FILL-BUDGET-FAILURE';
    const invocationId = randomUUID();
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, 'empty-pre-fill.txt'), '61000', invocationId,
    );
    expect(outcome.result).toMatchObject({
      state: 'driver_error', cause: 'state_light_new_chat_send_budget_unavailable', send_count: 0,
    });
    expect(turn.composer.fill).not.toHaveBeenCalled();
    expect(turn.sendButton.click).not.toHaveBeenCalled();
    expect(turn.page.close).toHaveBeenCalledTimes(1);
    expect(outcome.result.incidents).not.toContain('owned_composer_cleanup_unavailable');
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('not_sent');
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
    expect(turn.composer.fill).not.toHaveBeenLastCalledWith('', expect.anything());
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

  it('never retries or clears an ambiguous first click (#2487)', async () => {
    const prompt = 'PROMPT-RETRY-UNPROVEN';
    const invocationId = randomUUID();
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'DO-NOT-SEND');
    turn.sendButton.click.mockRejectedValue(Object.assign(new Error('locator.click: Timeout 5000ms exceeded'), {
      name: 'TimeoutError',
    }));
    const outcome = await runNewChatTurn(turn.page, '/tmp/retry-unproven-2487.txt', '90000', invocationId);
    expect(outcome.result).toMatchObject({ state: 'send_failed', send_count: 0, send_attempted: true });
    expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
    expect(turn.composer.fill).not.toHaveBeenLastCalledWith('');
    expect(turn.page.close).not.toHaveBeenCalled();
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
    expect(outcome.result).toMatchObject({ send_count: 0, send_attempted: true, state: 'send_failed' });
    expectPossibleEffect(outcome.result);
    expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
    expect(turn.getSends()).toBe(0);
    expect(turn.composer.fill).not.toHaveBeenLastCalledWith('', expect.anything());
    expect(turn.page.close).not.toHaveBeenCalled();
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
      expect(outcome.result).toMatchObject({ send_count: 0, send_attempted: true, state: 'send_failed' });
      expectPossibleEffect(outcome.result);
      expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
      expect(turn.getSends()).toBe(0);
      expect(turn.page.close).not.toHaveBeenCalled();
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
    expect(outcome.result).toMatchObject({
      send_count: 0, send_attempted: true, cause: 'fresh_conversation_surface_unavailable',
    });
    expectPossibleEffect(outcome.result);
    expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('dispatching');
  });

  it('forbids retry when original slot owner identity is replaced (#2487)', async () => {
    clearSendSlotDisableEnv();
    const invocationId = randomUUID();
    const prompt = 'PROMPT-2487-OWNER-IDENTITY';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'UNREACHED');
    const { writeFileSync } = await import('node:fs');
    turn.sendButton.click.mockImplementationOnce(async () => {
      const now = mocks.nowMs;
      writeFileSync(join(stateDir, 'collision-profile', 'locks', 'state-light-new-chat-send.slot'),
        JSON.stringify({
          schema: 'state-light-new-chat-send-slot/v1', version: 1,
          invocation_id: 'foreign-owner-2487', pid: process.pid,
          acquired_at: new Date(now).toISOString(),
          expires_at: new Date(now + STATE_LIGHT_SEND_SLOT_TTL_MS).toISOString(),
        }) + '\n');
      throw timeoutError();
    });

    const outcome = await runNewChatTurn(
      turn.page, join(stateDir, invocationId + '-owner-identity.txt'), '90000', invocationId,
    );
    expect(outcome.result).toMatchObject({
      send_count: 0, send_attempted: true, cause: 'state_light_new_chat_send_slot_owner_lost',
    });
    expectPossibleEffect(outcome.result);
    expect(turn.sendButton.click).toHaveBeenCalledTimes(1);
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(readStateLightTurnObservation('collision-profile', invocationId).phase).toBe('dispatching');
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
    expect(outcome.result).toMatchObject({ send_count: 0, send_attempted: true, state: 'send_failed' });
    expectPossibleEffect(outcome.result);
    expect(turn.sendButton.click).toHaveBeenCalledTimes(2);
    expect(turn.getSends()).toBe(0);
    expect(turn.page.close).not.toHaveBeenCalled();
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
    const owned = makeLoserPage('PROMPT-LATE-EXISTING', 'LATE-EXISTING-OK');
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
    const solo = makeLoserPage('PROMPT-REDIRECT', 'SHOULD-NOT-SEND');
    const initialUrl = solo.page.url.getMockImplementation()!;
    let redirected = false;
    solo.page.url.mockImplementation(() => redirected ? LOSER_CONV : initialUrl());
    solo.composer.fill.mockImplementation(async () => { redirected = true; });
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
    const solo = makeLoserPage('PROMPT-ALERT-REDIRECT', 'SHOULD-NOT-SEND');
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

  it('bounds an unresolved new-chat control count and starts no click or retry', async () => {
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
    expect(prepared).toMatchObject({ state: 'ui_contract_mismatch', cause: 'fresh_conversation_surface_unavailable' });
    expect(count).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
    expect(locator).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenCalledTimes(1);
    expect(navigation.snapshotNewChatClick()).toBe(0);
    expect(mocks.productStatusText).not.toHaveBeenCalled();
  });

  it('keeps a failed no-commit navigation at zero send', async () => {
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput('PROMPT-NOCOMMIT'));
    const solo = makeLoserPage('PROMPT-NOCOMMIT', 'SHOULD-NOT-SEND');
    solo.page.goto.mockRejectedValueOnce(new Error('page.goto: Timeout while waiting for commit'));
    const outcome = await runNewChatTurn(solo.page, '/tmp/no-commit.txt');
    expect(outcome.result.send_count).toBe(0);
    expect(outcome.result.state).not.toBe('ok');
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

    expect(outcome.code).not.toBe(0);
    expect(outcome.result).toMatchObject({ send_count: 1 });
    expect(outcome.result.state).not.toBe('send_failed');
    expect(outcome.result.state).not.toBe('ok');
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
    observationOverrides: { incompleteReads?: readonly number[]; nonFinalReads?: readonly number[]; nonFinalFromRead?: number; includeOwnedUser?: boolean; keyedOwnedMessages?: boolean; markerlessOwnedUserFromRead?: number; assistantCarrierKeysByRead?: readonly string[]; neverMarkerProof?: boolean } = {},
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
            ? [{ role: 'user', text: `${TEST_OWNED_MARKER}\n\n${prompt}` }]
            : []);
        }
        if (matchesNewChatControlSelector(selector)) return scalarLocator({ count: vi.fn(async () => 0) });
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
              querySelectorAll: () => [],
              closest: () => ({
                querySelector: (query: string) => {
                  if (query.includes('continue-generating') || query.includes('continue_generating')) return continuationVisible ? {} : null;
                  if (query === uiAdapter.ASSISTANT_TURN_ACTION_SELECTOR) return message.finalActionInTurnContainer ? {} : null;
                  if (query === uiAdapter.ASSISTANT_TURN_IN_PROGRESS_SELECTOR) return generating ? {} : null;
                  return null;
                },
              }),
            }));
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

    expect(outcome, JSON.stringify(outcome)).toMatchObject({ code: 0 });
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(state.reloads).toBe(1);
    expect(readFileSync(output, 'utf8')).toBe(reply);
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
    expect(state.reloads).toBe(1);
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
      ['state-light-turn-base.ts', 2],
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

    // A deferred URL that never materializes into a canonical project /c/UUID
    // cannot become an owned fresh conversation, even if a reply looks ready.
    expect(outcome.code).not.toBe(0);
    expect(outcome.result).toMatchObject({ send_count: 1 });
    expect(outcome.result.state).not.toBe('ok');
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

  it('returns fresh_conversation_landing_mismatch when url and owned prompt never materialize', async () => {
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
    const outcome = await runNewChatTurn(page, '/tmp/fresh-landing-mismatch.txt', '90000');

    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'fresh_conversation_landing_mismatch',
      send_count: 1,
    });
    expect(outcome.result.incidents).toContain('conversation_landing_mismatch');
    // Longer accepted timeout leaves a larger legitimate post-send observation budget.
    expect(outcome.result.poll_count).toBeLessThan(100);
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

  it('stops a slow but progressing original owner after its own deadline without dispatch (#2487)', async () => {
    clearSendSlotDisableEnv();
    const prompt = 'PROMPT-OWNER-LATE';
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));
    const turn = makeLoserPage(prompt, 'DO-NOT-SEND');
    let expired = false;
    turn.composer.evaluate.mockImplementation(async () => {
      if (!expired) {
        expired = true;
        mocks.nowMs += STATE_LIGHT_OWNER_PRE_DISPATCH_MS + 1;
      }
      return { visible: true, enabled: true, contentEditable: true };
    });
    const outcome = await runNewChatTurn(turn.page, '/tmp/2487-late-owner.txt', '400000');
    expect(outcome.result).toMatchObject({
      state: 'driver_error', send_count: 0,
      cause: 'state_light_new_chat_owner_pre_dispatch_deadline_exhausted',
    });
    expect(turn.getSends()).toBe(0);
    // The original owner, not the waiter, returns through its slot finalizer.
    await acquireStateLightNewChatSendSlot('collision-profile', 'later-admitted-2487', 100);
    releaseStateLightNewChatSendSlot('collision-profile', 'later-admitted-2487');
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
      state: 'no_reply',
      cause: 'observation_exhausted_no_resend',
      send_count: 1,
      cleanup: 'skipped',
    });
    expect(outcome.result.incidents).toContain('observation_exhausted');
    expect(ownedStop, JSON.stringify(outcome)).not.toHaveBeenCalled();
    expect(outcome.result.incidents).toEqual([
      'send_observation_deferred',
      'observation_exhausted',
      'owned_generation_stop_not_attempted_authority_absent',
    ]);
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
    expect(turn.page.close).not.toHaveBeenCalled();
    expect(foreignClose).not.toHaveBeenCalled();
  });

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
    let observedBudgetMs = 0;
    mocks.verifyProfile.mockImplementationOnce((...args: any[]) => {
      const operationBudget = args[1] as { clampOperationWaitMs?: () => number } | undefined;
      observedBudgetMs = operationBudget?.clampOperationWaitMs?.() ?? 0;
      return new Promise<any>(() => {});
    });

    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const code = await runStateLightTurn(
        livenessArgv(join(livenessStateDir, 'profile-stall.txt'), '45'),
        { entryLivenessHeartbeat: true },
      );
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
      stdout.mockRestore();
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
        if (matchesNewChatControlSelector(selector)) return scalarLocator({ count: vi.fn(async () => 0) });
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
            return Object.assign(collectionLocator([]), {
              evaluateAll: async (callback: (elements: Element[], args: unknown) => unknown, args: unknown) => (
                callback([], args)
              ),
            });
          }
          const snapshot = messageElements();
          const pollIndex = observationIndex;
          observationIndex += 1;
          const messages = [
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
              return callback([snapshot.user, snapshot.assistant] as unknown as Element[], args);
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
    expect(fake.close).not.toHaveBeenCalled();
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
