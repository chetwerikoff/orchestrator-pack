// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { runProcessSync } from '../kernel/subprocess.ts';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  browserQueue: [] as any[],
  cleanupOutcome: 'confirmed' as const,
  releaseBrowser: vi.fn(async () => undefined),
  verifyProfile: vi.fn(async () => ({ state: 'verified' })),
}));
// Unit fixtures exercise Send/recovery through a single invocation-visible
// target. Protocol-level Chrome filtering is tested in own-target-attach.test.ts.
vi.mock('./own-target-attach.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./own-target-attach.ts')>();
  return {
    ...actual,
    attachOwnTarget: vi.fn(actual.__testAttachOwnTargetFixture),
    countUninspectedRecoveryTargets: vi.fn(async () => 0),
  };
});

vi.mock('./browser-session.ts', () => ({
  ...createBrowserSessionModuleMock(mocks),
  // This suite previously never exercised affirmative created-Page closure;
  // model the incumbent bounded close as well as the browser session helpers.
  abandonLatePageHandle: vi.fn(async (page: { close: () => Promise<void> }) => {
    if (mocks.cleanupOutcome !== 'confirmed') return 'unconfirmed';
    await page.close();
    return 'confirmed';
  }),
}));
vi.mock('./coordination.ts', () => createCoordinationModuleMock());
vi.mock('./input.ts', () => ({ readStableInput: vi.fn(() => stableTurnInput('PROMPT')) }));
vi.mock('./ui-adapter.ts', async (original) => buildUiAdapterTestMock(
  await original<typeof import('./ui-adapter.ts')>(), mocks,
));

import { buildUiAdapterTestMock, collectionLocator, createBrowserSessionModuleMock, createCoordinationModuleMock, enqueueBrowserForTurn, runStateLightTurnWithStdoutCapture, scalarLocator, stableTurnInput } from './state-light-turn.test-fixtures.ts';
import { messageLocator, proseMirrorEditorSurface, readyTurnObservationFrames } from './state-light-turn.test-fixtures.ts';
import {
  COMPOSER_SELECTOR, SEND_BUTTON_SELECTOR, MESSAGE_NODE_SELECTOR,
  MESSAGE_AUTHOR_ROLE_ATTR, USER_MESSAGE_STYLE, RENDERED_CONVERSATION_TURN_SECTION_SELECTOR,
  USER_MESSAGE_SELECTOR, ASSISTANT_MESSAGE_SELECTOR, ASSISTANT_TURN_ANCESTOR_XPATH,
  RENDERED_STOP_BUTTON_SELECTOR,
} from './product-page-selectors.ts';
import { publishWitnessedStateLight429, readStateLightAccountCooldown, __testComposerMutation, __testSendDelivery, atomicSnapshotSignature, classifyPageObservation, keyedHarvestCandidate, readPageObservation, revalidateKeyedHarvest, runStateLightTurn, type AtomicTranscriptSnapshot } from './state-light-turn-base.ts';
import { readStateLightTurnObservation } from './state-light-turn-observation.ts';
import { CONVERSATION_LOAD_ERROR_HEADING_SELECTOR, heldPage429Diagnostic, observeHeldPageConversation429 } from './ui-adapter-base.ts';
import { runPostSendRecovery, takeRecoveryCensus, type PostSendRecoveryAdapter, type PostSendRecoveryState } from './state-light-turn-recovery.ts';
import * as recoveryModule from './state-light-turn-recovery.ts';
import { configuredProfileKey, profileDirs } from './storage-common.ts';
import { deriveDelivery, readTerminalEnvelope, runLaunch } from '../flow-manager-long-running-child.ts';
import { authoritativePreSend } from '../pack-review-no-review-reconcile.ts';

const MARKER = `OPKTURNV1${'ab'.repeat(16)}`;
const MARKED_PROMPT = `${MARKER}\n\nPROMPT`;


function recoveryFixture(options: {
  readonly originalIncomplete?: boolean;
  readonly successorIncomplete?: boolean;
  readonly includeOriginalMarker?: boolean;
  readonly successorMarker?: boolean;
  readonly foreign?: boolean;
} = {}) {
  const url = 'https://chatgpt.com/c/25962596-2596-4596-8596-259625962596';
  const original = { name: 'owned-original' };
  const foreign = { name: 'foreign' };
  const successor = { name: 'owned-successor' };
  const pages: unknown[] = [original, ...(options.foreign ? [foreign] : [])];
  let now = 100;
  const reads = new Map<unknown, number>();
  const createSuccessor = vi.fn(async () => { pages.push(successor); return successor; });
  const adapter: PostSendRecoveryAdapter = {
    enumeratePages: async () => pages,
    pageUrl: (page) => page === foreign ? 'https://chatgpt.com/c/other' : url,
    normalizeConversationUrl: (value) => value.endsWith('/') ? value.slice(0, -1) : value,
    isSupportedConversationUrl: (value) => value.startsWith('https://chatgpt.com/c/'),
    readAuthoritativeMessages: async (page) => {
      reads.set(page, (reads.get(page) ?? 0) + 1);
      if (page === foreign) return { messages: [], incomplete: true };
      if (page === original) return {
        messages: options.includeOriginalMarker ? [{ role: 'user' as const, text: MARKER }] : [],
        incomplete: options.originalIncomplete ?? false,
      };
      return {
        messages: options.successorMarker ? [{ role: 'user' as const, text: MARKER }] : [],
        incomplete: options.successorIncomplete ?? false,
      };
    },
    browserDefinitelyDisconnected: () => false,
    pageDefinitelyLost: () => false,
    reconnect: async () => ({}),
    createSuccessor,
    sleep: async (milliseconds) => { now += milliseconds; },
    now: () => now,
  };
  const state: PostSendRecoveryState = {
    lossEpoch: 0, successorCreated: false, immutableConversationUrl: url,
  };
  return { url, original, foreign, successor, pages, reads, createSuccessor, adapter, state, setNow: (value: number) => { now = value; } };
}

describe('Issue #2596 known-conversation post-send recovery', () => {
  it('ignores foreign unreadable conversations and recovers the owned marker', async () => {
    const fixture = recoveryFixture({ foreign: true, includeOriginalMarker: true });
    const result = await runPostSendRecovery({
      browser: {}, currentPage: fixture.original, marker: MARKER, hardDeadlineMs: 500, pollMs: 1,
      state: fixture.state, adapter: fixture.adapter,
    });
    expect(result).toMatchObject({ kind: 'recovered', page: fixture.original, conversationUrl: fixture.url });
    expect(fixture.reads.get(fixture.foreign)).toBeUndefined();
    expect(fixture.createSuccessor).not.toHaveBeenCalled();
  });

  it('uses one complete successor as the authoritative same-conversation view', async () => {
    const fixture = recoveryFixture({
      originalIncomplete: true, includeOriginalMarker: true, successorMarker: true, foreign: true,
    });
    const result = await runPostSendRecovery({
      browser: {}, currentPage: fixture.original, marker: MARKER, hardDeadlineMs: 500, pollMs: 1,
      state: fixture.state, adapter: fixture.adapter,
    });
    expect(result).toMatchObject({ kind: 'recovered', page: fixture.successor, cleanupOwned: true });
    expect(fixture.createSuccessor).toHaveBeenCalledTimes(1);
    expect(fixture.createSuccessor).toHaveBeenCalledWith(expect.anything(), fixture.url);
    expect(fixture.reads.get(fixture.foreign)).toBeUndefined();
  });

  it.each(['transient-original', 'hydrating-successor'] as const)('keeps polling marker-unproven successor observations (%s)', async (scenario) => {
    const fixture = recoveryFixture({ originalIncomplete: true, includeOriginalMarker: true });
    const scripted = new Map<unknown, number>();
    const adapter = { ...fixture.adapter, readAuthoritativeMessages: vi.fn(async (page: unknown) => {
      const count = (scripted.get(page) ?? 0) + 1;
      scripted.set(page, count);
      if (page === fixture.original) return { messages: [{ role: 'user' as const, text: MARKER }], incomplete: true };
      if (scenario === 'hydrating-successor' && count === 1) return { messages: [], incomplete: false };
      return { messages: [{ role: 'user' as const, text: MARKER }], incomplete: false };
    }) };
    const result = await runPostSendRecovery({
      browser: {}, marker: MARKER, hardDeadlineMs: 500, pollMs: 1, state: fixture.state, adapter,
    });
    expect(result).toMatchObject({ kind: 'recovered', page: fixture.successor, cleanupOwned: true });
    expect(adapter.readAuthoritativeMessages).toHaveBeenCalledTimes(scenario === 'hydrating-successor' ? 3 : 2);
    expect(fixture.createSuccessor).toHaveBeenCalledTimes(1);
  });

  it('reserves deadline observation time for the successor and identifies its exact URL failures', async () => {
    const fixture = recoveryFixture({ originalIncomplete: true });
    let clock = 0;
    const adapter = { ...fixture.adapter,
      now: () => clock,
      readAuthoritativeMessages: vi.fn(async (page: unknown) => {
        clock += page === fixture.original ? 5_000 : 900;
        return page === fixture.original
          ? { messages: [{ role: 'user' as const, text: MARKER }], incomplete: true }
          : { messages: [{ role: 'user' as const, text: MARKER }], incomplete: false };
      }),
      createSuccessor: vi.fn(async () => { clock += 100; fixture.pages.push(fixture.successor); return fixture.successor; }),
    };
    const result = await runPostSendRecovery({
      browser: {}, marker: MARKER, hardDeadlineMs: 6_000, pollMs: 1, state: fixture.state, adapter,
    });
    expect(result).toMatchObject({ kind: 'recovered', page: fixture.successor });
    expect(clock).toBe(6_000);
    expect(adapter.readAuthoritativeMessages).toHaveBeenCalledTimes(2);
  });

  it.each(['wrong-url', 'unreadable-url'] as const)('classifies the exact owned successor %s without reading it', async (mode) => {
    const fixture = recoveryFixture({ originalIncomplete: true });
    const adapter = { ...fixture.adapter,
      pageUrl: (page: unknown) => {
        if (page === fixture.successor && mode === 'wrong-url') return 'https://chatgpt.com/c/foreign';
        if (page === fixture.successor && mode === 'unreadable-url') throw new Error('private');
        return fixture.adapter.pageUrl(page);
      },
    };
    const result = await runPostSendRecovery({
      browser: {}, marker: MARKER, hardDeadlineMs: 500, pollMs: 1, state: fixture.state, adapter,
    });
    expect(result).toMatchObject({ kind: 'failure', cause: mode === 'wrong-url'
      ? 'owned_conversation_identity_mismatch' : 'owned_conversation_recovery_census_failed' });
    if (mode === 'unreadable-url') expect(result).toMatchObject({ diagnostic: { reason: 'page_url_unreadable' } });
    expect(fixture.reads.get(fixture.successor)).toBeUndefined();
  });

  it('fails closed with a bounded URL-hash diagnostic when successor observations stay incomplete', async () => {
    const fixture = recoveryFixture({ originalIncomplete: true, successorIncomplete: true });
    fixture.setNow(498);
    const result = await runPostSendRecovery({
      browser: {}, currentPage: fixture.original, marker: MARKER, hardDeadlineMs: 500, pollMs: 1,
      state: fixture.state, adapter: fixture.adapter,
    });
    expect(result).toMatchObject({
      kind: 'failure', cause: 'owned_conversation_recovery_census_failed',
      diagnostic: {
        conversationUrlSha256: createHash('sha256').update(fixture.url).digest('hex'),
        reason: 'read_incomplete',
      },
    });
    expect(JSON.stringify(result)).not.toContain(fixture.url);
    expect(fixture.createSuccessor).toHaveBeenCalledTimes(1);
  });

  it.each(['incomplete', 'threw', 'unreadable-url'] as const)('never reads a foreign %s page', async (mode) => {
    const fixture = recoveryFixture({ foreign: true, includeOriginalMarker: true });
    const read = vi.fn(fixture.adapter.readAuthoritativeMessages);
    const adapter = { ...fixture.adapter, readAuthoritativeMessages: read,
      pageUrl: (page: unknown) => {
        if (page === fixture.foreign && mode === 'unreadable-url') throw new Error('unreadable');
        return fixture.adapter.pageUrl(page);
      },
    };
    read.mockImplementation(async (page) => {
      if (page === fixture.foreign && mode === 'threw') throw new Error('foreign read must not occur');
      return await fixture.adapter.readAuthoritativeMessages(page);
    });
    const result = await runPostSendRecovery({
      browser: {}, marker: MARKER, hardDeadlineMs: 500, pollMs: 1, state: fixture.state, adapter,
    });
    expect(result).toMatchObject({ kind: 'recovered', page: fixture.original, cleanupOwned: false });
    expect(read.mock.calls.map(([page]) => page)).toEqual([fixture.original]);
  });

  it('recovers an absent original through the same URL before the existing deadline', async () => {
    const fixture = recoveryFixture({ successorMarker: true });
    fixture.pages.splice(0);
    fixture.setNow(499);
    const result = await runPostSendRecovery({
      browser: {}, marker: MARKER, hardDeadlineMs: 500, pollMs: 1, state: fixture.state, adapter: fixture.adapter,
    });
    expect(result).toMatchObject({ kind: 'recovered', page: fixture.successor, stopAuthorityPage: fixture.successor });
    expect(fixture.state.cleanupAuthorityPage).toBe(fixture.successor);
    expect(fixture.createSuccessor).toHaveBeenCalledTimes(1);
    expect(fixture.reads.get(fixture.successor)).toBe(1);
  });

  it.each(['original', 'successor'] as const)('rejects duplicate tokens in an incomplete %s snapshot', async (duplicatePage) => {
    const fixture = recoveryFixture({ originalIncomplete: true, successorIncomplete: true, successorMarker: true });
    const adapter = { ...fixture.adapter, readAuthoritativeMessages: async (page: unknown) => {
      if (page === fixture[duplicatePage]) return {
        messages: [{ role: 'user' as const, text: MARKER + MARKER }], incomplete: true,
      };
      return await fixture.adapter.readAuthoritativeMessages(page);
    } };
    const result = await runPostSendRecovery({
      browser: {}, marker: MARKER, hardDeadlineMs: 500, pollMs: 1, state: fixture.state, adapter,
    });
    expect(result).toMatchObject({ kind: 'failure', cause: 'owned_prompt_marker_ambiguous', action: 'retain_owned_page_no_resend' });
    expect(fixture.createSuccessor).toHaveBeenCalledTimes(duplicatePage === 'original' ? 0 : 1);
  });

  it.each([true, false])('rejects conflicting complete owned observations (second marker: %s)', async (secondMarker) => {
    const fixture = recoveryFixture({ includeOriginalMarker: true, successorMarker: secondMarker });
    fixture.pages.push(fixture.successor);
    const result = await runPostSendRecovery({
      browser: {}, marker: MARKER, hardDeadlineMs: 500, pollMs: 1, state: fixture.state, adapter: fixture.adapter,
    });
    expect(result).toMatchObject({ kind: 'failure', cause: 'owned_prompt_marker_ambiguous', action: 'retain_owned_page_no_resend' });
    expect(fixture.createSuccessor).not.toHaveBeenCalled();
  });

  it('preserves the unbound and local-fetch-failure whole-census behavior', async () => {
    const fixture = recoveryFixture({ includeOriginalMarker: true, foreign: true });
    fixture.state.immutableConversationUrl = undefined;
    const census = await takeRecoveryCensus({}, MARKER, fixture.adapter);
    expect(census.complete).toBe(false);
    expect(fixture.reads.get(fixture.foreign)).toBe(1);
    const result = await runPostSendRecovery({
      browser: {}, marker: MARKER, hardDeadlineMs: 500, pollMs: 100, state: fixture.state, adapter: fixture.adapter,
    });
    expect(result).toMatchObject({ kind: 'failure', cause: 'owned_conversation_recovery_census_failed', action: 'retain_owned_page_no_resend' });
    expect(result).not.toHaveProperty('diagnostic');
    expect(fixture.createSuccessor).not.toHaveBeenCalled();
  });

  it.each(['read_threw', 'enumeration_failed'] as const)('reports a normalized target hash for %s', async (reason) => {
    const fixture = recoveryFixture();
    fixture.state.immutableConversationUrl = fixture.url + '/';
    fixture.setNow(500);
    const adapter = { ...fixture.adapter,
      ...(reason === 'read_threw'
        ? { readAuthoritativeMessages: async () => { throw new Error('private page content'); } }
        : { enumeratePages: async () => { throw new Error('private URL'); } }),
    };
    const result = await runPostSendRecovery({
      browser: {}, marker: MARKER, hardDeadlineMs: 500, pollMs: 1, state: fixture.state, adapter,
    });
    expect(result).toMatchObject({ kind: 'failure', cause: 'owned_conversation_recovery_census_failed',
      diagnostic: { conversationUrlSha256: createHash('sha256').update(fixture.url).digest('hex'), reason },
    });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain(fixture.url);
    expect(fixture.createSuccessor).not.toHaveBeenCalled();
  });

  it('never creates a successor at the deadline or resends an unresolved successor', async () => {
    const fixture = recoveryFixture({ originalIncomplete: true });
    fixture.setNow(500);
    const expired = await runPostSendRecovery({
      browser: {}, marker: MARKER, hardDeadlineMs: 500, pollMs: 1, state: fixture.state, adapter: fixture.adapter,
    });
    expect(expired).toMatchObject({ kind: 'failure', cause: 'owned_conversation_recovery_census_failed' });
    expect(fixture.createSuccessor).not.toHaveBeenCalled();
    const live = recoveryFixture({ originalIncomplete: true });
    const unresolved = await runPostSendRecovery({
      browser: {}, marker: MARKER, hardDeadlineMs: 500, pollMs: 100, state: live.state, adapter: live.adapter,
    });
    expect(unresolved).toMatchObject({ kind: 'failure', action: 'retain_owned_page_no_resend' });
    expect(live.createSuccessor).toHaveBeenCalledTimes(1);
    expect(deriveDelivery({
      state: 'observation_uncertain', resolved_send_count: 1, send_attempted: true,
      cause: unresolved.kind === 'failure' ? unresolved.cause : '',
    } as NonNullable<Parameters<typeof deriveDelivery>[0]>, false)).toBe('POSSIBLY_DELIVERED');
  });
});

describe('Issue #2596 production recovery caller boundaries', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'recovery-caller-'));
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', root);
    vi.stubEnv('ORCA_TERMINAL_HANDLE', undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); mocks.browserQueue.length = 0;
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['local-empty', 'local-incomplete', 'known-successor'] as const)(
    'production caller preserves Send, locator and cleanup boundaries: %s', async (mode) => {
      const project = 'https://chatgpt.com/g/g-p-11111111111111111111111111111111-test/project';
      const url = 'https://chatgpt.com/g/g-p-11111111111111111111111111111111-test/c/11111111-1111-4111-8111-111111111111';
      const localUrl = 'https://chatgpt.com/c/local-chatgpt%3A11111111-1111-4111-8111-111111111111';
      const known = mode === 'known-successor';
      let clock = 10_000;
      let sent = false;
      let draft = '';
      const send = vi.fn(async () => { sent = true; });
      const retry = vi.fn(async () => undefined);
      const finalMessages = readyTurnObservationFrames('PROMPT', 'RECOVERED-REPLY').at(-1)!;
      const composer = scalarLocator({ count: async () => 1, fill: async (value: string) => { draft = value; },
        innerText: async () => sent ? '' : draft, textContent: async () => sent ? '' : draft, press: send });
      const makePage = (kind: 'original' | 'foreign' | 'successor'): any => ({
        __fakeBrowserGptPage: true,
        url: vi.fn(() => kind === 'foreign' ? 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222'
          : kind === 'successor' || known ? url : sent ? localUrl : project),
        isClosed: vi.fn(() => kind === 'original' && known && sent),
        goto: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
        waitForTimeout: vi.fn(async (ms: number) => { clock += ms; }),
        getByText: vi.fn((text: string) => scalarLocator({ count: async () => sent && text === 'Failed to fetch' ? 1 : 0 })),
        getByRole: vi.fn(() => scalarLocator({ count: async () => sent ? 1 : 0, click: retry })),
        locator: vi.fn((selector: string) => {
          if (kind === 'foreign') return scalarLocator({ count: async () => { throw new Error('foreign unreadable'); } });
          if (selector === COMPOSER_SELECTOR) return composer;
          if (selector === SEND_BUTTON_SELECTOR) return scalarLocator({ count: async () => 1, click: kind === 'original' ? send : retry });
          if (kind === 'original' && known && sent && selector === USER_MESSAGE_SELECTOR)
            return scalarLocator({ count: async () => { throw new Error('owned read lost'); } });
          const messages = kind === 'successor' ? finalMessages
            : sent ? known ? finalMessages.slice(0, 1) : [] : known ? [{ role: 'user' as const, text: 'history' }] : [];
          if (selector === MESSAGE_NODE_SELECTOR) {
            if (known && kind === 'original' && !sent) {
              return Object.assign(collectionLocator(messages), {
                evaluateAll: vi.fn(async () => ({
                  rows: [{
                    role: 'user', text: 'history', key: 'historical-user-2596', domIndex: 0,
                    complete: true, completionReady: false, continuationVisible: false,
                  }],
                  pageTurnEvidence: {
                    generationInProgress: false, observedAssistantNodes: 0,
                    continueGeneratingVisible: false,
                  },
                })),
              });
            }
            return collectionLocator(messages);
          }
          if (selector === USER_MESSAGE_SELECTOR) return collectionLocator(messages.filter((message) => message.role === 'user'));
          if (selector === ASSISTANT_MESSAGE_SELECTOR) return collectionLocator(messages.filter((message) => message.role === 'assistant'));
          if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section'))
            return kind === 'successor' ? messageLocator(finalMessages.at(-1)!) : scalarLocator();
          return scalarLocator();
        }),
      });
      const original = makePage('original');
      const foreign = makePage('foreign');
      const successor = makePage('successor');
      const harness = enqueueBrowserForTurn(mocks, original);
      const pages = [original, ...(mode === 'local-empty' ? [] : [foreign])];
      Object.assign(harness.context, { pages: vi.fn(() => pages) });
      harness.context.newPage.mockImplementation(async () => { pages.push(successor); return successor; });
      if (!known) harness.context.newPage.mockImplementation(async () => original);
      const actualRecover = recoveryModule.runPostSendRecovery;
      const selection = vi.spyOn(recoveryModule, 'runPostSendRecovery').mockImplementation(async (input) => {
        expect(await input.adapter.enumeratePages(input.browser)).toEqual([original]);
        return await actualRecover(input);
      });
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const invocationId = randomUUID();
      const output = join(root, invocationId + '.txt');
      const { result } = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
        '--profile', join(root, 'profile'), '--cdp', 'http://127.0.0.1:9222', '--input', join(root, 'input'),
        '--output', output, '--invocation-id', invocationId, '--timeout-ms', '90000', '--poll-ms', '1',
        ...(known ? ['--chat-url', url] : ['--new-chat', '--project-url', project]),
      ]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(retry).not.toHaveBeenCalled();
      expect(original.close).not.toHaveBeenCalled();
      expect(foreign.close).not.toHaveBeenCalled();
      expect(foreign.goto).not.toHaveBeenCalled();
      if (known) {
        expect(selection).toHaveBeenCalledTimes(1);
        expect(foreign.locator).not.toHaveBeenCalled();
        expect(result).toMatchObject({ state: 'ok', conversation_id: url, send_count: 1 });
        // The read-only successor provided the original reply, but it is
        // not the invocation's CDP-pinned, originally created close target.
        expect(successor.close).not.toHaveBeenCalled();
        expect(readFileSync(output, 'utf8')).toBe('RECOVERED-REPLY');
      } else {
        expect(selection).not.toHaveBeenCalled();
        expect(result).toMatchObject({ state: 'observation_uncertain', send_count: 1, send_attempted: true,
          cause: mode === 'local-empty' ? 'fresh_send_fetch_failed' : 'owned_conversation_recovery_census_failed' });
        expect(result.conversation_id).toBeUndefined();
        expect(readStateLightTurnObservation(configuredProfileKey(join(root, 'profile'), 'http://127.0.0.1:9222'), invocationId).conversation_url).toBeNull();
        expect(successor.close).not.toHaveBeenCalled();
        expect(existsSync(output)).toBe(false);
        if (mode === 'local-incomplete') expect(foreign.locator).toHaveBeenCalled();
      }
    },
  );
});
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

describe('Issue #2541 attempted Send stays possibly delivered under local-ID fetch loss', () => {
  it.each(['fresh_send_fetch_failed', 'owned_conversation_recovery_census_failed', 'owned_prompt_marker_ambiguous'])(
    'never projects a witnessed Send as not-sent after %s', (cause) => {
      const result = {
        state: 'observation_uncertain',
        cause,
        resolved_send_count: 1,
        send_attempted: true,
        conversation_id: undefined,
        witness: undefined,
      } as unknown as NonNullable<Parameters<typeof deriveDelivery>[0]>;
      expect(deriveDelivery(result, false)).toBe('POSSIBLY_DELIVERED');
    },
  );
});

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
    ['empty-baseline', 0],
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
    const chatUrl = 'https://chatgpt.com/c/24952495-2495-4495-8495-249524952495';
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
      // Readiness remains the incumbent presence-only probe; once the first
      // action was attempted the retry reader sees a coherent unique editor.
      evaluate: async (
        callback: (element: unknown, arg?: unknown) => unknown,
        arg?: unknown,
        options?: { timeout?: number },
      ) => {
        if (options?.timeout !== undefined || firstAction.mock.calls.length === 0) return true;
        const element: any = {
          isConnected: true, isContentEditable: true,
          classList: { contains: () => false }, getAttribute: () => null,
          getClientRects: () => [{}],
          getBoundingClientRect: () => ({ width: 280, height: 30 }),
          get textContent() { return composerText; },
          get innerText() { return composerText; },
        };
        element.ownerDocument = {
          querySelectorAll: (selector: string) => selector === COMPOSER_SELECTOR ? [element] : [],
          defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
        };
        return callback(element, arg);
      },
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
      if (scenario === 'empty-baseline') {
        expect(result).toMatchObject({
          state: 'ui_contract_mismatch',
          cause: 'owned_conversation_render_mismatch',
          send_count: 0,
        });
        expect(result.send_attempted).not.toBe(true);
      } else {
        expect(result.send_attempted).toBe(true);
      }
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
    ['empty-history', 0, 0],
    ['unknown-generation', 0, 0],
    ['active-generation', 0, 0],
    ['assistant-only-history', 0, 0],
    ['blank-user-history', 0, 0],
  ] as const)('Issue #2495 composer: %s navigates %i times and sends %i times', async (
    scenario, expectedNavigations, expectedSends,
  ) => {
    const invocationId = randomUUID();
    const profile = join(root, 'profile');
    const cdp = 'http://127.0.0.1:9222';
    const chatUrl = 'https://chatgpt.com/c/24952495-2495-4495-8495-249524952495';
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
      evaluateAll: vi.fn(async () => {
        const empty = scenario === 'empty-history';
        const assistantOnly = scenario === 'assistant-only-history';
        return {
          rows: empty ? [] : [{
            role: assistantOnly ? 'assistant' : 'user',
            text: scenario === 'blank-user-history' ? '' : 'historical user',
            key: 'historical-user-key-2495', domIndex: 0,
            complete: true, completionReady: false, continuationVisible: false,
          }],
          ...(empty ? {} : { pageTurnEvidence: {
            generationInProgress: scenario === 'unknown-generation'
              ? 'unknown' : scenario === 'active-generation',
            observedAssistantNodes: assistantOnly ? 1 : 0,
            continueGeneratingVisible: false,
          } }),
        };
      }),
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
      if (scenario === 'empty-history' || scenario === 'unknown-generation') {
        const census = await readPageObservation(page, undefined, undefined, true, now + 5_000);
        expect(census.snapshot?.complete).toBe(true);
        if (scenario === 'empty-history') {
          expect(census.snapshot?.carriers).toHaveLength(0);
          expect(census.pageTurnEvidence).toBeUndefined();
        } else {
          expect(census.pageTurnEvidence?.generationInProgress).toBe('unknown');
        }
      }
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
      const chatUrl = 'https://chatgpt.com/c/25412541-2541-4541-8541-254125412541';
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
          if (selector === MESSAGE_NODE_SELECTOR) {
            if (scenario !== 'pre_dispatch') {
              return Object.assign(collectionLocator(users), {
                evaluateAll: vi.fn(async () => ({
                  rows: users.map((message, domIndex) => ({
                    role: message.role, text: message.text, key: `historical-user-2541-${domIndex}`,
                    domIndex, complete: true, completionReady: false, continuationVisible: false,
                  })),
                  pageTurnEvidence: {
                    generationInProgress: false, observedAssistantNodes: 0,
                    continueGeneratingVisible: false,
                  },
                })),
              });
            }
            return collectionLocator(users);
          }
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
        // This fixture selects a pre-existing exact-chat Page; a numeric
        // Send witness authenticates delivery, not destructive ownership.
        // Neither the witnessed nor attempted/unproven path may close it.
        expect(page.close).not.toHaveBeenCalled();
        expect(result.cleanup).not.toBe('confirmed');
        if (!witnessed) {
          expect(result.send_attempted).toBe(true);
          expect(observation.send_count).toBeUndefined();
          expect(observation.send_witness).toBe('none');
        }
      }
      if (scenario === 'throw_no_witness') {
        // The click/Enter exception is a diagnostic, not proof that no Send happened.
        // The original-deadline outcome remains possibly delivered after no witness.
        expect(result).toMatchObject({
          state: 'observation_uncertain', cause: 'post_send_absolute_deadline_elapsed',
          send_attempted: true, send_count: 0,
        });
        expect(result.incidents).toContain('send_transport_error');
        expect(result.incidents).not.toContain('helper_failure_before_send');
      }

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
      if (witnessed) {
        // The exception does not undo the unique original-Page user marker.
        // Landed proves observed user-message delivery, NOT a completed reply.
        expect(result.owned_marker_confirmed === true || result.send_witness === 'owned_marker').toBe(true);
      }
      expect(readTerminalEnvelope(envelopePath)).toMatchObject({
        delivery: preDispatch ? 'not-sent' : witnessed ? 'landed' : 'POSSIBLY_DELIVERED',
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


describe('Issue #2536: unique current reply and strict keyed cardinality', () => {
  type Row = { role: 'user' | 'assistant'; text: string; key: string };
  const history: Row[] = Array.from({ length: 8 }, (_, i): Row[] => [
    { role: 'user', text: `history user ${i}`, key: `data-message-id:history-user-${i}-2536` },
    { role: 'assistant', text: `history reply ${i}`, key: `data-message-id:history-assistant-${i}-2536` },
  ]).flat();
  const ownKey = 'data-message-id:owned-user-u-2536';
  const assistantX = { role: 'assistant' as const, text: 'finished reply X', key: 'data-message-id:assistant-x-2536' };
  const assistantY = { role: 'assistant' as const, text: 'finished reply Y', key: 'data-message-id:assistant-y-2536' };
  const snapshot = (rows: Row[]): AtomicTranscriptSnapshot => ({
    complete: true,
    carriers: rows.map(({ role, text, key }, domIndex) => ({
      role, text, key, domIndex, completionReady: role === 'assistant',
      fingerprint: createHash('sha256').update(`${role}\u0000${text}`).digest('hex'),
    })),
  });

  it('keeps a single exact-marker finished reply deliverable after user carrier A-to-B churn', () => {
    const original = [...history, { role: 'user' as const, text: MARKED_PROMPT, key: 'data-message-id:owner-a-2536' }, assistantX];
    const rekeyed = [...history, { role: 'user' as const, text: MARKED_PROMPT, key: 'data-message-id:owner-b-2536' }, assistantX];
    expect(classifyPageObservation(original, history.length, MARKER, false))
      .toEqual({ state: 'ready', reply: assistantX.text });
    expect(classifyPageObservation(rekeyed, history.length, MARKER, false))
      .toEqual({ state: 'ready', reply: assistantX.text });
    expect(classifyPageObservation([...history, { role: 'user', text: MARKED_PROMPT, key: ownKey }, { ...assistantX, text: 'SHORT' }], history.length, MARKER, false))
      .toEqual({ state: 'ready', reply: 'SHORT' });
  });

  it('does not select the last of two concurrently finished visible assistants', () => {
    const rows = [...history, { role: 'user' as const, text: MARKED_PROMPT, key: ownKey }, assistantX, assistantY];
    expect(classifyPageObservation(rows, history.length, MARKER, false).state).not.toBe('ready');
    expect(classifyPageObservation(rows, history.length, MARKER, true).state).not.toBe('ready');
    expect(classifyPageObservation([...rows, { role: 'user', text: 'foreign turn', key: 'data-message-id:foreign-2536' }], history.length, MARKER, false).state).not.toBe('ready');
  });

  it('refuses complete-markerless keyed X/Y even when the last carrier would revalidate', async () => {
    const baseline = snapshot(history);
    const markerless: Row[] = [...history, { role: 'user', text: 'same owned carrier without rendered marker', key: ownKey }, assistantX, assistantY];
    const complete = snapshot(markerless);
    expect(keyedHarvestCandidate(complete, baseline, ownKey).state).not.toBe('ready');

    const page = { locator: () => ({
      evaluateAll: async (callback: (elements: any[], args: any) => unknown, args: any) => callback(markerless.map((row) => ({
        getBoundingClientRect: () => ({ height: 20 }),
        getAttribute: (attr: string) => attr === 'data-message-id' ? row.key.slice('data-message-id:'.length) : null,
        querySelectorAll: () => [],
        querySelector: (selector: string) => selector === `[${MESSAGE_AUTHOR_ROLE_ATTR}]`
          ? { getAttribute: () => row.role === 'user' ? 'user-message' : 'assistant-message' }
          : null,
        closest: () => ({ querySelector: (selector: string) => selector === args.inProgressSelector ? null : {} }),
        innerText: row.text,
      })), args),
    }) };
    expect(await revalidateKeyedHarvest(page, baseline, ownKey, {
      reply: assistantY.text, assistantKey: assistantY.key, snapshotSignature: atomicSnapshotSignature(complete),
    })).toEqual({ state: 'continuity-unproven' });

    const single = keyedHarvestCandidate(snapshot(markerless.slice(0, -1)), baseline, ownKey);
    expect(single).toEqual({ state: 'ready', reply: assistantX.text, assistantKey: assistantX.key });
    expect(keyedHarvestCandidate({ complete: false, carriers: complete.carriers }, baseline, ownKey).state)
      .toBe('continuity-unproven');
    expect(keyedHarvestCandidate(complete, { complete: false, carriers: baseline.carriers }, ownKey).state)
      .toBe('continuity-unproven');
  });
});


describe('Issue #2536 ordinary end-to-end: one owned Send in a long reused conversation', () => {
  it.each([false, true])('delivers current A-to-B reply without X/Y ambiguity (competing: %s)', async (competing) => {
    const root = mkdtempSync(join(tmpdir(), 'opk-2536-ordinary-'));
    const invocation = randomUUID();
    const target = 'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111';
    const profile = join(root, 'profile');
    const output = join(root, 'reply.txt');
    let now = 20_000;
    let composerText = '';
    let deliveredText = '';
    let sends = 0;
    let postSendReads = 0;
    const rows = Array.from({ length: 8 }, (_, i): Array<{ role: 'user' | 'assistant'; text: string; key: string }> => [
      { role: 'user', text: `older user ${i}`, key: `data-message-id:older-user-${i}-2536` },
      { role: 'assistant', text: `older assistant ${i}`, key: `data-message-id:older-assistant-${i}-2536` },
    ]).flat();
    type Row = typeof rows[number];
    let currentRows: Row[] = rows;
    const composer = scalarLocator({
      count: async () => 1,
      fill: async (text: string) => { composerText = text; },
      innerText: async () => composerText,
    });
    const send = vi.fn(async () => {
      sends += 1;
      deliveredText = composerText;
      composerText = '';
    });
    const sendButton = scalarLocator({ count: async () => 1, click: send });
    const messageNodes = {
      count: async () => currentRows.length,
      nth: (index: number) => collectionLocator(currentRows).nth(index),
      evaluateAll: async () => {
        if (sends) postSendReads++;
        const reply = postSendReads <= 1 ? 'LONG with superseded text' : 'SHORT';
        const userKey = postSendReads <= 1
          ? 'data-message-id:current-user-a-2536' : 'data-message-id:current-user-b-2536';
        currentRows = sends
          ? [
            ...rows,
            { role: 'user', text: deliveredText, key: userKey },
            { role: 'assistant', text: reply, key: 'data-message-id:current-assistant-x-2536' },
            ...(competing ? [{ role: 'assistant' as const, text: 'OTHER', key: 'data-message-id:current-assistant-y-2536' }] : []),
          ]
          : rows;
        return {
          rows: currentRows.map((row, domIndex) => ({
            ...row, domIndex, complete: true, completionReady: true, continuationVisible: false,
          })),
          pageTurnEvidence: {
            generationInProgress: false,
            observedAssistantNodes: currentRows.filter((row) => row.role === 'assistant').length,
            continueGeneratingVisible: false,
          },
        };
      },
    };
    const page = {
      __fakeBrowserGptPage: true,
      url: () => target,
      isClosed: () => false,
      goto: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      waitForTimeout: async (ms: number) => { now += ms; },
      getByRole: () => scalarLocator(),
      getByText: () => scalarLocator(),
      locator: (selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return sendButton;
        if (selector === MESSAGE_NODE_SELECTOR) return messageNodes;
        return scalarLocator();
      },
    };
    const browserFixture = enqueueBrowserForTurn(mocks, page);
    Object.assign(browserFixture.context, { pages: () => [page] });
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', root);
    try {
      const { result } = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
        '--profile', profile, '--cdp', 'http://127.0.0.1:9222',
        '--input', join(root, 'synthetic-prompt.txt'),
        '--output', output, '--chat-url', target,
        '--invocation-id', invocation, '--timeout-ms', '180000',
      ]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(sends).toBe(1);
      expect(result.send_count, JSON.stringify(result)).toBe(1);
      expect(postSendReads).toBeGreaterThanOrEqual(3);
      if (competing) {
        expect(result.state).not.toBe('ok');
        expect(existsSync(output)).toBe(false);
        expect(page.close).not.toHaveBeenCalled();
      } else {
        expect(result.state, JSON.stringify(result)).toBe('ok');
        expect(readFileSync(output, 'utf8')).toBe('SHORT');
        expect(result.output).toMatchObject({ byte_length: 5 });
      }
    } finally {
      clock.mockRestore();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      mocks.browserQueue.length = 0;
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('Issue #2636: delayed Send delivery on the original exact owned conversation', () => {
  it.each(['D29', 'D44', 'D45'])('preserves the captured %s unproved-attempt envelope without inventing a 429', () => {
    const captured = {
      state: 'send_failed', cause: 'send_delivery_unproven',
      resolved_send_count: 0, send_count: 0, send_attempted: true,
    } as unknown as NonNullable<Parameters<typeof deriveDelivery>[0]>;
    const observation = { phase: 'dispatching', send_witness: 'none', conversation_url: null };
    expect(observation).toMatchObject({ phase: 'dispatching', send_witness: 'none', conversation_url: null });
    expect(deriveDelivery(captured, false)).toBe('POSSIBLY_DELIVERED');
  });

  it.each(['late-marker', 'own-post', 'no-evidence', 'lost-successor', 'lost-near-deadline'] as const)(
    'keeps one attempted Send after a stale five-second DOM and composer window (%s)',
    async (scenario) => {
      const root = mkdtempSync(join(tmpdir(), 'opk-2636-send-delivery-'));
      const invocationId = randomUUID();
      const profile = join(root, 'profile');
      const target = 'https://chatgpt.com/c/26362636-2636-4636-8636-263626362636';
      const output = join(root, 'reply.txt');
      const reply = 'D46 OWNED FINISHED ANSWER';
      let clock = 30_000;
      let sendAt = -1;
      const invocationCutoffMs = clock + 180_000;
      const lossAtMs = invocationCutoffMs - 100;
      let lostNearDeadline = false;
      const advanceClock = (ms: number) => {
        if (scenario === 'lost-near-deadline' && sendAt >= 0 && !lostNearDeadline
          && clock < lossAtMs && clock + ms >= lossAtMs) {
          clock = lossAtMs;
          lostNearDeadline = true;
        } else {
          clock += ms;
        }
      };
      let composerText = '';
      const prior = [
        { role: 'user' as const, text: 'previous prompt', key: 'data-message-id:d46-prior-user' },
        { role: 'assistant' as const, text: 'previous reply', key: 'data-message-id:d46-prior-reply' },
      ];
      const ownRows = () => sendAt >= 0 && clock - sendAt >= 36_000
        && scenario !== 'no-evidence' && scenario !== 'lost-successor'
        && scenario !== 'lost-near-deadline'
        ? [
          ...prior,
          { role: 'user' as const, text: composerText, key: 'data-message-id:d46-current-user' },
          { role: 'assistant' as const, text: reply, key: 'data-message-id:d46-current-assistant' },
        ]
        : prior;
      const events = new EventEmitter();
      let neutralGetEventsEmitted = false;
      const emitNeutralGets = () => {
        if (neutralGetEventsEmitted || events.listenerCount('response') === 0 || sendAt >= 0) return;
        neutralGetEventsEmitted = true;
        const endpoints = [
          ['https://chatgpt.com/backend-api/conversations?offset=0&limit=20', 429],
          ['https://chatgpt.com/backend-api/conversations/26362636-2636-4636-8636-263626362636?num_turns=20', 200],
        ] as const;
        for (const [url, status] of endpoints) {
          const request = { method: () => 'GET', url: () => url };
          events.emit('request', request);
          events.emit('response', { request: () => request, status: () => status });
        }
      };
      const composer = scalarLocator({
        count: vi.fn(async () => 1),
        fill: vi.fn(async (text: string) => { composerText = text; }),
        innerText: vi.fn(async () => composerText), // deliberately NOT cleared on Send
        textContent: vi.fn(async () => composerText),
      });
      const click = vi.fn(async () => {
        sendAt = clock;
        if (scenario === 'own-post') {
          const request = {
            method: () => 'POST',
            url: () => 'https://chatgpt.com/backend-api/f/conversation',
            postData: () => JSON.stringify({ messages: [
              { author: { role: 'user' }, content: { content_type: 'text', parts: [composerText] } },
            ] }),
          };
          events.emit('request', request);
          events.emit('request', request); // repeated observation cannot add a second Send
          events.emit('response', { request: () => request, status: () => 200 });
        }
      });
      const nodes = {
        count: vi.fn(async () => ownRows().length),
        nth: (index: number) => collectionLocator(ownRows()).nth(index),
        evaluateAll: vi.fn(async () => {
          const rows = ownRows();
          return {
            rows: rows.map((row, domIndex) => ({
              ...row, domIndex, complete: true, completionReady: true, continuationVisible: false,
            })),
            pageTurnEvidence: {
              generationInProgress: false,
              observedAssistantNodes: rows.filter((row) => row.role === 'assistant').length,
              continueGeneratingVisible: false,
            },
          };
        }),
      };
      const successorRows = () => scenario === 'lost-near-deadline' ? prior : [
        ...prior,
        { role: 'user' as const, text: composerText, key: 'data-message-id:d46-successor-user' },
        { role: 'assistant' as const, text: reply, key: 'data-message-id:d46-successor-assistant' },
      ];
      const successorNodes = {
        count: vi.fn(async () => successorRows().length),
        nth: (index: number) => collectionLocator(successorRows()).nth(index),
        evaluateAll: vi.fn(async () => {
          const rows = successorRows();
          return {
            rows: rows.map((row, domIndex) => ({
              ...row, domIndex, complete: true, completionReady: true, continuationVisible: false,
            })),
            pageTurnEvidence: {
              generationInProgress: false, observedAssistantNodes: 1, continueGeneratingVisible: false,
            },
          };
        }),
      };
      // Both losses occur after the original unproven five-second proof probe.
      const lostOriginal = () => sendAt >= 0 && (
        (scenario === 'lost-successor' && clock - sendAt >= 9_000)
        || (scenario === 'lost-near-deadline' && lostNearDeadline)
      );
      const successor = Object.assign(new EventEmitter(), {
        __fakeBrowserGptPage: true,
        url: () => target,
        isClosed: () => false,
        goto: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        waitForTimeout: vi.fn(async (ms: number) => { advanceClock(ms); }),
        getByRole: () => scalarLocator(),
        getByText: () => scalarLocator(),
        locator: (selector: string) => {
          if (selector === COMPOSER_SELECTOR) return composer;
          if (selector === MESSAGE_NODE_SELECTOR) return successorNodes;
          if (selector === USER_MESSAGE_SELECTOR) return collectionLocator(
            successorRows().filter((row) => row.role === 'user'));
          if (selector === ASSISTANT_MESSAGE_SELECTOR) return collectionLocator(
            successorRows().filter((row) => row.role === 'assistant'));
          return scalarLocator();
        },
      });
      const page = Object.assign(events, {
        __fakeBrowserGptPage: true,
        url: () => target,
        isClosed: () => lostOriginal(),
        goto: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        waitForTimeout: vi.fn(async (ms: number) => { advanceClock(ms); }),
        getByRole: () => scalarLocator(),
        getByText: () => scalarLocator(),
        locator: (selector: string) => {
          emitNeutralGets(); // Sidebar GET 429 + owned exact GET 200 are not Send evidence.
          if (selector === COMPOSER_SELECTOR) return composer;
          if (selector === SEND_BUTTON_SELECTOR) return scalarLocator({ count: async () => 1, click });
          if (selector === MESSAGE_NODE_SELECTOR) return nodes;
          if (selector === USER_MESSAGE_SELECTOR) return collectionLocator(
            ownRows().filter((row) => row.role === 'user'));
          return scalarLocator();
        },
      });
      const browserFixture = enqueueBrowserForTurn(mocks, page);
      Object.assign(browserFixture.context, { pages: () => lostOriginal() ? [successor] : [page] });
      const recoveryCall = scenario === 'lost-successor' || scenario === 'lost-near-deadline'
        ? vi.spyOn(recoveryModule, 'runPostSendRecovery') : undefined;
      const date = vi.spyOn(Date, 'now').mockImplementation(() => clock);
      vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', root);
      try {
        const { result } = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
          '--profile', profile, '--cdp', 'http://127.0.0.1:9222',
          '--input', join(root, 'synthetic-prompt.txt'),
          '--output', output, '--chat-url', target,
          '--invocation-id', invocationId, '--timeout-ms', '180000',
        ]);
        expect(click).toHaveBeenCalledTimes(1);
        expect(neutralGetEventsEmitted).toBe(true);
        expect(readStateLightAccountCooldown(configuredProfileKey(profile, 'http://127.0.0.1:9222'), clock).active)
          .toBe(false);
        expect(sendAt).toBeGreaterThan(0);
        const observation = readStateLightTurnObservation(configuredProfileKey(profile, 'http://127.0.0.1:9222'), invocationId);
        if (scenario === 'no-evidence' || scenario === 'lost-near-deadline') {
          expect(result).toMatchObject({
            state: 'observation_uncertain', send_count: 0,
            send_attempted: true,
            cause: scenario === 'lost-near-deadline'
              ? 'owned_conversation_recovery_census_failed' : 'post_send_absolute_deadline_elapsed',
          });
          // This is an existing, explicitly selected exact chat. Its URL may
          // remain recorded without constituting a Send or reply witness.
          expect(observation).toMatchObject({
            phase: 'dispatching', send_witness: 'none', conversation_url: target,
          });
          expect(observation.send_count).toBeUndefined();
          if (scenario === 'lost-near-deadline') {
            expect(lostNearDeadline).toBe(true);
            expect(recoveryCall).toHaveBeenCalledTimes(1);
            expect(recoveryCall?.mock.calls[0]?.[0]?.hardDeadlineMs).toBe(invocationCutoffMs);
            expect(clock).toBeGreaterThanOrEqual(lossAtMs);
            expect(clock).toBeLessThanOrEqual(invocationCutoffMs);
          } else {
            expect(clock).toBeGreaterThanOrEqual(invocationCutoffMs);
          }
          expect(deriveDelivery({ ...result, resolved_send_count: result.send_count } as any, false))
            .toBe('POSSIBLY_DELIVERED');
          expect(existsSync(output)).toBe(false);
        } else {
          expect(clock - sendAt).toBeGreaterThanOrEqual(scenario === 'lost-successor' ? 9_000 : 36_000);
          if (scenario === 'lost-successor') {
            expect(recoveryCall).toHaveBeenCalledTimes(1);
            expect(successorNodes.evaluateAll).toHaveBeenCalled();
            expect(observation.send_witness).toBe('owned_marker');
          }
          expect(result.state, JSON.stringify(result)).toBe('ok');
          expect(result.send_count).toBe(1);
          expect(observation).toMatchObject({ phase: 'harvested', conversation_url: target, send_count: 1 });
          expect(readFileSync(output, 'utf8')).toBe(reply);
        }
      } finally {
        date.mockRestore();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        mocks.browserQueue.length = 0;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('Issue #2560: 60-second owned existing-chat composer recovery', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'existing-composer-2560-'));
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', root);
    mocks.verifyProfile.mockResolvedValue({ state: 'verified' });
  });
  afterEach(() => {
    mocks.browserQueue.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  type Scenario =
    | 'restored' | 'restored-long' | 'delayed-stop' | 'ready' | 'late-hydration'
    | 'finished-setup' | 'composer-still-absent' | 'redirect' | 'network' | 'navigation-throw'
    | 'lost-page' | 'late-redirect' | 'late-close' | 'expired-goto' | 'expired-readiness'
    | 'post-empty' | 'post-userless'
    | 'post-incomplete' | 'post-unreadable' | 'post-unknown'
    | 'post-delayed-452' | 'post-generation-late' | 'post-fetch-429'
    | 'post-active' | 'post-stop' | 'initial-active'
    | 'initial-unknown' | 'initial-empty' | 'initial-incomplete'
    | 'initial-stop' | 'initial-wrong-url' | 'short-budget'
    | 'slow-fill' | 'partial-fill' | 'expired-fill' | 'failed-fill'
    | 'joined-marker-fill' | 'joined-marker-before-send'
    | 'changed-marker-fill' | 'changed-marker-before-send' | 'rendered-blank-lines';

  async function fullTurn(scenario: Scenario, prompt = 'PROMPT') {
    const { readStableInput } = await import('./input.ts');
    vi.mocked(readStableInput).mockReturnValueOnce(stableTurnInput(prompt));
    const chatUrl = 'https://chatgpt.com/c/25602560-2560-4560-8560-256025602560';
    const invocationId = randomUUID();
    const profile = join(root, 'profile');
    const cdp = 'http://127.0.0.1:9222';
    let now = 100_000;
    const startedAt = now;
    let lastGotoAt: number | undefined;
    let sentAt: number | undefined;
    let sentText = '';
    let composerText = '';
    let url = chatUrl;
    let closed = false;
    let stop = false;
    let reopened = false;
    let resumedStopObserved = false;
    let afterReopenReads = 0;
    let readsAtSend: number | undefined;
    const events = new EventEmitter();
    let postReopenComposerProbes = 0;
    let composerTextReads = 0;
    // The held 429 counts once ChatGPT shows its full-page load failure (#2723).
    let loadFailed = false;
    const usableComposer = () => !loadFailed && (['ready', 'slow-fill', 'partial-fill', 'expired-fill', 'failed-fill',
      'changed-marker-fill', 'changed-marker-before-send', 'rendered-blank-lines',
      'joined-marker-fill', 'joined-marker-before-send'].includes(scenario)
      || (scenario === 'late-hydration' && now - startedAt >= 20_000)
      || (reopened && !['composer-still-absent', 'late-redirect', 'late-close'].includes(scenario)));
    const fill = vi.fn(async (value: string, { timeout }: { timeout: number }) => {
      if (scenario === 'failed-fill') throw new Error('fill failed');
      const costMs = ['slow-fill', 'partial-fill', 'changed-marker-fill', 'changed-marker-before-send']
        .includes(scenario) ? 6_000 : 0;
      if (timeout < costMs) {
        now += timeout;
        throw new Error('TimeoutError: fill timed out before full insertion');
      }
      composerText = scenario === 'partial-fill' ? value.slice(0, -1)
        : scenario === 'joined-marker-fill' ? value.replace(/\n\n\s*/u, '')
          : scenario === 'changed-marker-fill' ? value.replace('OPKTURNV1', 'OTHER-TURN') : value;
      now += costMs;
      if (scenario === 'expired-fill') now = startedAt + 60_000;
    });
    const composer = scalarLocator({
      count: vi.fn(async () => {
        if (reopened) postReopenComposerProbes++;
        return usableComposer() ? 1 : 0;
      }),
      click: vi.fn(async () => {
        if (!usableComposer()) throw new Error('no composer in the rendered page');
      }),
      fill,
      innerText: vi.fn(async () => {
        if (++composerTextReads > 1 && scenario === 'changed-marker-before-send') {
          composerText = composerText.replace('OPKTURNV1', 'OTHER-TURN');
        }
        if (composerTextReads > 1 && scenario === 'joined-marker-before-send') {
          composerText = composerText.replace(/\n\n\s*/u, '');
        }
        return scenario === 'rendered-blank-lines' && composerText
          ? proseMirrorEditorSurface(composerText + '\n').innerText : composerText;
      }),
    });
    const send = vi.fn(async () => {
      sentAt = now;
      readsAtSend = afterReopenReads;
      sentText = composerText;
      composerText = ''; // Synthetic owned composer-cleared delivery witness.
    });
    const goto = vi.fn(async (target: string, options: { waitUntil: string }) => {
      expect(options.waitUntil).toBe('commit');
      reopened = true;
      lastGotoAt = now;
      if (scenario === 'post-delayed-452') {
        // The recorded chat's fetch was HTTP 200 with 452 messages; rendering
        // latency below is synthetic because no captured page timing exists.
        const request = { method: () => 'GET',
          url: () => 'https://chatgpt.com/backend-api/conversations/25602560-2560-4560-8560-256025602560?num_turns=452' };
        events.emit('request', request);
        events.emit('response', { request: () => request, status: () => 200 });
      }
      if (scenario === 'redirect') url = 'https://chatgpt.com/c/foreign';
      else if (scenario === 'network') throw new Error('net::ERR_NETWORK_CHANGED');
      else if (scenario === 'navigation-throw') throw new Error('unexpected navigation failure');
      else if (scenario === 'lost-page') closed = true;
      else if (scenario === 'expired-goto') now += 40_000;
      else if (scenario === 'expired-readiness') now = startedAt + 60_000 - 30_000 - 3_000;
      else url = target;
    });
    const rows = () => {
      const ownedReply = sentAt === undefined ? [] : [
        { role: 'user' as const, text: sentText, key: 'data-message-id:turn-user-2639',
          domIndex: 452, complete: true, completionReady: false, continuationVisible: false },
        { role: 'assistant' as const, text: 'FINAL', key: 'data-message-id:turn-answer-2639',
          domIndex: 453, complete: true, completionReady: true, continuationVisible: false },
      ];
      if (reopened && scenario === 'post-fetch-429') return [];
      if (reopened && scenario === 'post-delayed-452') {
        if (afterReopenReads <= 3 && sentAt === undefined) return [];
        const history = Array.from({ length: 452 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
          text: 'historical message ' + index,
          key: 'data-message-id:history-2639-' + index,
          domIndex: index, complete: true, completionReady: index === 451, continuationVisible: false,
        }));
        return [...history, ...ownedReply];
      }
      const isInitial = !reopened;
      const empty = (isInitial && scenario === 'initial-empty')
        || (!isInitial && scenario === 'post-empty');
      const userless = !isInitial && scenario === 'post-userless';
      const incomplete = (isInitial && scenario === 'initial-incomplete')
        || (!isInitial && (scenario === 'post-incomplete' || scenario === 'post-unreadable'));
      if (empty) return [];
      return [{
        role: userless ? 'assistant' : 'user',
        text: 'historical user',
        key: 'data-message-id:history-user-2560',
        domIndex: 0,
        complete: !incomplete,
        completionReady: false,
        continuationVisible: false,
      }, ...(scenario === 'finished-setup' ? [{
        role: 'assistant', text: 'finished historical assistant',
        key: 'data-message-id:history-assistant-2560',
        domIndex: 1, complete: true, completionReady: true,
        continuationVisible: false,
      }] : []), ...(reopened && scenario === 'post-generation-late' ? ownedReply : [])];
    };
    const nodes = {
      ...collectionLocator([{ role: 'user', text: 'historical user' }]),
      count: vi.fn(async () => loadFailed ? 0 : 1),
      evaluateAll: vi.fn(async () => {
        if (reopened) afterReopenReads++;
        if (reopened && scenario === 'post-fetch-429' && afterReopenReads === 2) {
          const request = { method: () => 'GET',
            url: () => 'https://chatgpt.com/backend-api/conversations/25602560-2560-4560-8560-256025602560?num_turns=20' };
          events.emit('request', request);
          events.emit('response', { request: () => request, status: () => 429 });
          loadFailed = true;
        }
        const generationInProgress: boolean | 'unknown' =
          (!reopened && scenario === 'initial-unknown')
          || (reopened && scenario === 'post-unknown')
          || (reopened && scenario === 'post-delayed-452' && afterReopenReads <= 5)
          || (reopened && scenario === 'post-generation-late' && afterReopenReads <= 3)
            ? 'unknown'
            : (!reopened && scenario === 'initial-active')
              || (reopened && scenario === 'post-active')
              || stop;
        const currentRows = rows();
        return {
          rows: currentRows,
          ...(currentRows.length > 0 ? {
            pageTurnEvidence: {
              generationInProgress,
              observedAssistantNodes: currentRows.filter((row) => row.role === 'assistant').length,
              continueGeneratingVisible: false,
            },
          } : {}),
        };
      }),
    };
    const stopLocator = scalarLocator({
      count: vi.fn(async () => {
        if (reopened && scenario === 'delayed-stop' && stop) resumedStopObserved = true;
        return stop ? 1 : 0;
      }),
      isVisible: vi.fn(async () => stop),
    });
    const page = Object.assign(events, {
      __fakeBrowserGptPage: true,
      url: () => url,
      isClosed: () => closed,
      goto,
      close: vi.fn(async () => undefined),
      waitForTimeout: vi.fn(async (ms: number) => {
        now += ms;
        if (!reopened && scenario === 'initial-stop' && now - startedAt >= 10_000) stop = true;
        if (!reopened && scenario === 'initial-wrong-url' && now - startedAt >= 10_000) {
          url = 'https://chatgpt.com/c/foreign';
        }
        if (scenario === 'delayed-stop' && lastGotoAt !== undefined
          && now - lastGotoAt >= 12_000) stop = true;
        if (scenario === 'post-stop' && reopened) stop = true;
        if (reopened && lastGotoAt !== undefined && now - lastGotoAt >= 500) {
          if (scenario === 'late-redirect') url = 'https://chatgpt.com/c/foreign';
          if (scenario === 'late-close') closed = true;
        }
      }),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return scalarLocator({ count: async () => 1, click: send });
        if (selector === MESSAGE_NODE_SELECTOR) return nodes;
        if (selector === CONVERSATION_LOAD_ERROR_HEADING_SELECTOR && loadFailed) return scalarLocator({
          count: async () => 1, innerText: async () => 'Could not load this ChatGPT conversation',
        });
        if (selector === RENDERED_CONVERSATION_TURN_SECTION_SELECTOR) return scalarLocator({
          last: () => scalarLocator({ turnActionButtons: scenario === 'finished-setup' }),
        });
        if (selector.includes('stop-button') || selector.includes('Stop')) return stopLocator;
        return scalarLocator();
      }),
    });
    const browserFixture = enqueueBrowserForTurn(mocks, page);
    Object.assign(browserFixture.context, { pages: () => [page] });
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    if (scenario === 'finished-setup') {
      mocks.verifyProfile.mockImplementationOnce(async () => {
        now += 2_500; // Setup consumes more than the former 2s eligibility margin.
        return { state: 'verified' };
      });
    }
    try {
      const { result } = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
        '--profile', profile, '--cdp', cdp,
        '--input', join(root, 'synthetic-prompt.txt'),
        '--output', join(root, invocationId + '.txt'),
        '--chat-url', chatUrl, '--invocation-id', invocationId,
        '--timeout-ms', scenario === 'short-budget' ? '10000'
          : ['restored-long', 'post-delayed-452', 'post-generation-late'].includes(scenario) ? '90000' : '60000',
      ]);
      return {
        result, send, fill, goto, startedAt, lastGotoAt, sentAt, sentText,
        finalUrl: url, afterReopenReads, readsAtSend, elapsedMs: now - startedAt,
        resumedStopObserved, postReopenComposerProbes,
        observer: readStateLightTurnObservation(configuredProfileKey(profile, cdp), invocationId),
      };
    } finally {
      clock.mockRestore();
    }
  }

  it.each(['short', 'single-100KB-line'] as const)(
    'dispatches exactly once after a verified slow %s fill (#2669)', async (shape) => {
      const prompt = shape === 'short' ? 'PROMPT'
        : '  Synthetic task instruction 0'.padEnd(100 * 1024, 'x');
      const run = await fullTurn('slow-fill', prompt);
      expect(run.fill).toHaveBeenCalledTimes(1);
      expect(run.send).toHaveBeenCalledTimes(1);
      expect(run.sentAt! - run.startedAt).toBeGreaterThanOrEqual(6_000);
      expect(run.sentAt! - run.startedAt).toBeLessThan(60_000);
      expect(run.sentText).toMatch(/^OPKTURNV1[0-9a-f]{32}\n\n/u);
      expect(run.sentText.slice(run.sentText.indexOf('\n\n') + 2)).toBe(prompt);
      expect(run.result.send_count).toBe(1);
      expect(run.goto).not.toHaveBeenCalled();
    },
  );

  it('sends a normalized blank-paragraph draft once on an existing owned chat (#2671)', async () => {
    const run = await fullTurn('rendered-blank-lines', 'First instruction.\n\nSecond instruction.\n\nReply with both checks.');
    expect(run.result.send_count).toBe(1);
    expect(run.send).toHaveBeenCalledTimes(1);
    expect(run.fill).toHaveBeenCalledTimes(1);
  });

  it.each((['partial-fill', 'expired-fill', 'failed-fill',
    'changed-marker-fill', 'changed-marker-before-send',
    'joined-marker-fill', 'joined-marker-before-send'] as const).flatMap((scenario) =>
      (['short', 'single-100KB-line'] as const).map((shape) => ({ scenario, shape })),
    ))(
    'never dispatches $shape $scenario despite a present composer (#2669)', async ({ scenario, shape }) => {
      const prompt = shape === 'short' ? 'PROMPT'
        : '  Synthetic task instruction 0'.padEnd(100 * 1024, 'x');
      const run = await fullTurn(scenario, prompt);
      expect(run.fill).toHaveBeenCalledTimes(1);
      expect(run.send).not.toHaveBeenCalled();
      expect(run.result.send_count).toBe(0);
      expect(run.result.send_attempted).not.toBe(true);
      expect(run.result.cause).toBe(['expired-fill', 'failed-fill'].includes(scenario)
        ? 'composer_mutation_budget_exhausted' : 'composer_payload_mismatch');
    },
  );

  it('reopens exactly once and sends once when the entire real 30s watch fits the invocation budget', async () => {
    const run = await fullTurn('restored-long');
    expect(run.goto).toHaveBeenCalledTimes(1);
    expect(run.goto).toHaveBeenCalledWith(
      'https://chatgpt.com/c/25602560-2560-4560-8560-256025602560',
      expect.objectContaining({ waitUntil: 'commit' }),
    );
    expect(run.afterReopenReads).toBeGreaterThanOrEqual(2);
    expect(run.sentAt, JSON.stringify({
      result: run.result, fillCount: run.fill.mock.calls.length,
      sentAt: run.sentAt, lastGotoAt: run.lastGotoAt,
    })).toBeDefined();
    expect(run.lastGotoAt).toBeDefined();
    expect(run.sentAt! - run.lastGotoAt!).toBeGreaterThanOrEqual(30_000);
    expect(run.sentAt! - run.startedAt).toBeLessThan(90_000);
    expect(run.sentText).toMatch(/^OPKTURNV1[0-9a-f]{32}\n\nPROMPT$/u);
    expect(run.send).toHaveBeenCalledTimes(1);
    expect(run.fill).toHaveBeenCalledTimes(1);
    expect(run.result.send_count).toBe(1);
    expect(run.result.send_attempted).toBe(true);
    expect(run.observer.phase).toBe('sent_unharvested');
    expect(run.finalUrl).toBe('https://chatgpt.com/c/25602560-2560-4560-8560-256025602560');
  });

  it('waits for modeled late DOM render of the recorded 452-message chat, then sends exactly once (#2639)', async () => {
    // No captured browser page/timing is available. The first three reopened
    // observations are userless; the next two have users but unknown generation.
    // The old single-snapshot guard would fail this test before the Send.
    const run = await fullTurn('post-delayed-452');
    expect(run.goto).toHaveBeenCalledTimes(1);
    expect(run.readsAtSend).toBeGreaterThanOrEqual(6);
    expect(run.send).toHaveBeenCalledTimes(1);
    expect(run.result.send_count).toBe(1);
    expect(run.result.cause).not.toBe('owned_conversation_render_mismatch');
  });

  it('waits for a visible user carrier with unknown then idle generation before sending (#2639)', async () => {
    const run = await fullTurn('post-generation-late');
    expect(run.readsAtSend).toBeGreaterThanOrEqual(4);
    expect(run.send).toHaveBeenCalledTimes(1);
    expect(run.result.send_count).toBe(1);
  });

  it('exhausts the existing invocation deadline for a never-rendered user carrier without sending (#2639)', async () => {
    const run = await fullTurn('post-empty');
    expect(run.afterReopenReads).toBeGreaterThan(1);
    expect(run.elapsedMs).toBeGreaterThanOrEqual(60_000);
    expect(run.result).toMatchObject({
      state: 'ui_contract_mismatch', cause: 'owned_conversation_render_mismatch', send_count: 0,
    });
    expect(run.send).not.toHaveBeenCalled();
    expect(run.fill).not.toHaveBeenCalled();
  });

  it('preserves exact same-page conversation fetch HTTP 429 during the render wait (#2639)', async () => {
    const run = await fullTurn('post-fetch-429');
    expect(run.afterReopenReads).toBeGreaterThanOrEqual(2);
    expect(run.result).toMatchObject({
      state: 'rate_limit', cause: 'conversation_fetch_http_429', send_count: 0,
      product_wall_diagnostic: { wall_kind: 'conversation_fetch_http_429', http_status: 429,
        status_source: 'owned_page_response' },
    });
    expect(run.fill).not.toHaveBeenCalled();
    expect(run.send).not.toHaveBeenCalled();
  });

  it('reopens after >2s setup when a positively finished historical turn permits early resume exit', async () => {
    const run = await fullTurn('finished-setup');
    expect(run.goto).toHaveBeenCalledTimes(1);
    expect(run.lastGotoAt! - run.startedAt).toBeGreaterThanOrEqual(22_500);
    expect(run.sentAt! - run.startedAt).toBeLessThan(60_000);
    expect(run.sentAt! - run.lastGotoAt!).toBeLessThan(30_000);
    expect(run.fill).toHaveBeenCalledTimes(1);
    expect(run.send).toHaveBeenCalledTimes(1);
    expect(run.result).toMatchObject({ send_count: 1, send_attempted: true });
  });

  it('keeps the 60s deadline when the unshortened helper cannot fit its real resume watch plus Send', async () => {
    const run = await fullTurn('restored');
    expect(run.goto).toHaveBeenCalledTimes(1);
    expect(run.afterReopenReads).toBeGreaterThan(0);
    expect(run.result).toMatchObject({
      state: 'driver_error', cause: 'composer_mutation_budget_exhausted', send_count: 0,
    });
    expect(run.result.send_attempted).not.toBe(true);
    expect(run.send).not.toHaveBeenCalled();
    expect(run.fill).not.toHaveBeenCalled();
  });

  it('does not bypass the resume watch when Stop appears after an initially idle post-goto snapshot', async () => {
    const run = await fullTurn('delayed-stop');
    expect(run.goto).toHaveBeenCalledTimes(1);
    expect(run.afterReopenReads).toBeGreaterThan(0);
    expect(run.resumedStopObserved).toBe(true);
    expect(run.result).toMatchObject({
      state: 'conversation_busy', cause: 'another_turn_active', send_count: 0,
    });
    expect(run.result.send_attempted).not.toBe(true);
    expect(run.fill).not.toHaveBeenCalled();
    expect(run.send).not.toHaveBeenCalled();
    expect(run.lastGotoAt! - run.startedAt).toBeLessThan(30_000);
  });

  it.each([
    ['composer-still-absent', 'send_failed', 'composer_unavailable'],
    ['redirect', 'ui_contract_mismatch', 'owned_conversation_identity_mismatch'],
    ['network', 'ui_contract_mismatch', 'network_changed'],
    ['navigation-throw', 'driver_error', 'unexpected navigation failure'],
    ['lost-page', 'driver_error', 'Target closed'],
    ['late-redirect', 'ui_contract_mismatch', 'owned_conversation_identity_mismatch'],
    ['late-close', 'driver_error', 'Target closed'],
    ['expired-goto', 'driver_error', 'composer_mutation_budget_exhausted'],
    ['expired-readiness', 'driver_error', 'composer_mutation_budget_exhausted'],
    ['post-empty', 'ui_contract_mismatch', 'owned_conversation_render_mismatch'],
    ['post-userless', 'ui_contract_mismatch', 'owned_conversation_render_mismatch'],
    ['post-incomplete', 'ui_contract_mismatch', 'owned_conversation_render_mismatch'],
    ['post-unreadable', 'ui_contract_mismatch', 'owned_conversation_render_mismatch'],
    ['post-unknown', 'ui_contract_mismatch', 'owned_conversation_render_mismatch'],
    ['post-active', 'conversation_busy', 'another_turn_active'],
    ['post-stop', 'conversation_busy', 'another_turn_active'],
  ] as const)('%s keeps distinct existing failure authority after a single reopen', async (scenario, state, cause) => {
    const run = await fullTurn(scenario);
    expect(run.goto).toHaveBeenCalledTimes(1);
    expect(run.result).toMatchObject({ state, cause, send_count: 0 });
    if (scenario === 'expired-readiness') {
      // No time remains for even one post-goto composer DOM probe.
      expect(run.postReopenComposerProbes).toBe(0);
    }
    expect(run.result.send_attempted).not.toBe(true);
    expect(run.fill).not.toHaveBeenCalled();
    expect(run.send).not.toHaveBeenCalled();
  });

  it.each([
    ['ready', 0],
    ['late-hydration', 0],
    ['initial-active', 0],
    ['initial-unknown', 0],
    ['initial-empty', 0],
    ['initial-incomplete', 0],
    ['initial-stop', 0],
    ['initial-wrong-url', 0],
    ['short-budget', 0],
  ] as const)('%s cannot cause an unnecessary or unauthorized reopen', async (scenario, gotoCount) => {
    const run = await fullTurn(scenario);
    expect(run.goto).toHaveBeenCalledTimes(gotoCount);
    if (scenario !== 'ready' && scenario !== 'late-hydration') {
      expect(run.fill).not.toHaveBeenCalled();
      expect(run.send).not.toHaveBeenCalled();
      expect(run.result.send_count).toBe(0);
    }
  });
});


describe('conversation fetch HTTP 429 — shared bounded cross-process cooldown (#2617/#2678)', () => {
  let root: string;
  let profileKey: string;
  let now: number;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opk-2617-account-cooldown-'));
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', root);
    profileKey = configuredProfileKey(join(root, 'configured-profile'), 'http://127.0.0.1:9222');
    now = Date.now();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const filename = 'state-light-account-cooldown.v1.json';
  const pathFor = (key: string) => join(profileDirs(key).locks, filename);
  const readFromOtherNodeProcess = (key: string, at: number) => {
    const moduleUrl = new URL('./state-light-turn-base.ts', import.meta.url).href;
    const program = `import { readStateLightAccountCooldown } from ${JSON.stringify(moduleUrl)};
process.stdout.write(JSON.stringify(readStateLightAccountCooldown(${JSON.stringify(key)}, ${at})));`;
    const child = runProcessSync({
      command: process.execPath,
      args: ['--experimental-strip-types', '--input-type=module', '--eval', program],
      env: { CHATGPT_BROWSER_TURN_STATE_DIR: root },
      inheritParentEnv: true,
      encoding: 'utf8',
      timeoutMs: 15_000,
    });
    expect(child.ok, child.stderr || child.error).toBe(true);
    return JSON.parse(child.stdout);
  };

  it('starts at 60 seconds, preserves one profile record and shares it across Node processes', () => {
    const first = publishWitnessedStateLight429(profileKey, now);
    expect(first).toEqual({ active: true, until: now + 60_000 });
    expect(JSON.parse(readFileSync(pathFor(profileKey), 'utf8'))).toEqual({
      cooldown_until_ms: now + 60_000,
      last_witness_at_ms: now,
      backoff_step: 1,
    });
    expect(readStateLightAccountCooldown(profileKey, now + 59_999)).toMatchObject({
      active: true, until: now + 60_000,
    });
    expect(readFromOtherNodeProcess(profileKey, now + 1)).toMatchObject({
      active: true, until: now + 60_000,
    });
    expect(readStateLightAccountCooldown(profileKey, now + 60_000).active).toBe(false);
  });

  it('never shortens an active legacy deadline on a separately witnessed 429', () => {
    writeFileSync(pathFor(profileKey), JSON.stringify({ cooldown_until_ms: now + 300_000 }));
    expect(readStateLightAccountCooldown(profileKey, now)).toMatchObject({
      active: true, until: now + 300_000,
    });
    expect(publishWitnessedStateLight429(profileKey, now)).toMatchObject({
      until: now + 300_000,
    });
    expect(readFromOtherNodeProcess(profileKey, now + 1_000)).toMatchObject({
      active: true, until: now + 300_000,
    });
    expect(JSON.parse(readFileSync(pathFor(profileKey), 'utf8'))).toMatchObject({
      cooldown_until_ms: now + 300_000, last_witness_at_ms: now, backoff_step: 1,
    });
  });

  it('steps through only new 429 witnesses and resets after 30 minutes without a witness', () => {
    const ticks = [0, 60_001, 180_002, 420_003] as const;
    const ends = [60_000, 180_001, 420_002, 720_003] as const;
    for (let i = 0; i < ticks.length; i++) {
      expect(publishWitnessedStateLight429(profileKey, ticks[i]!))
        .toMatchObject({ active: true, until: ends[i]! });
      expect(readStateLightAccountCooldown(profileKey, ticks[i]!)).toMatchObject({
        active: true, until: ends[i]!, backoffStep: i + 1,
      });
    }
    expect(readStateLightAccountCooldown(profileKey, 720_003)).toMatchObject({
      active: false, diagnostic: 'account_cooldown_expired', backoffStep: 4,
    });
    expect(publishWitnessedStateLight429(profileKey, 720_004)).toMatchObject({
      until: 1_020_004,
    });
    expect(publishWitnessedStateLight429(profileKey, 720_004 + 1_800_001)).toMatchObject({
      until: 720_004 + 1_800_001 + 60_000,
    });
  });

  it('rejects a +24-hour future deadline and replaces it with a new 60-second witness', () => {
    const path = pathFor(profileKey);
    writeFileSync(path, JSON.stringify({ cooldown_until_ms: now + 86_400_000 }));
    expect(readStateLightAccountCooldown(profileKey, now)).toMatchObject({
      active: false, diagnostic: 'account_cooldown_far_future',
    });
    expect(publishWitnessedStateLight429(profileKey, now)).toEqual({
      active: true, until: now + 60_000,
    });
    expect(readFromOtherNodeProcess(profileKey, now + 100)).toMatchObject({
      active: true, until: now + 60_000,
    });
  });

  it.each([
    [null, 'account_cooldown_wrong_shape'],
    [{ cooldown_until_ms: 'tomorrow' }, 'account_cooldown_invalid_deadline'],
    [{ cooldown_until_ms: 0 }, 'account_cooldown_expired'],
    [{ cooldown_until_ms: 50, wrong: true }, 'account_cooldown_wrong_shape'],
  ] as const)('fails open invalid single-record data %j: %s', (record, diagnostic) => {
    const path = pathFor(profileKey);
    writeFileSync(path, JSON.stringify(record));
    expect(readStateLightAccountCooldown(profileKey, now)).toMatchObject({
      active: false, diagnostic,
    });
  });

  it('fails open malformed JSON and a contended writer integrity guard', () => {
    const path = pathFor(profileKey);
    writeFileSync(path, '{invalid');
    expect(readStateLightAccountCooldown(profileKey, now)).toMatchObject({
      active: false, diagnostic: 'account_cooldown_malformed',
    });
    const guard = join(profileDirs(profileKey).locks, 'state-light-account-cooldown.v1.guard');
    writeFileSync(guard, 'occupied');
    expect(publishWitnessedStateLight429(profileKey, now)).toMatchObject({
      active: false, diagnostic: 'account_cooldown_write_unavailable',
    });
    expect(readFileSync(path, 'utf8')).toBe('{invalid');
  });

  it('keeps exact configured profile keys separate despite a shared root', () => {
    const other = configuredProfileKey(join(root, 'other-profile'), 'http://127.0.0.1:9222');
    publishWitnessedStateLight429(profileKey, now);
    expect(readStateLightAccountCooldown(other, now).active).toBe(false);
    expect(readFromOtherNodeProcess(other, now).active).toBe(false);
  });
});


describe('conversation fetch HTTP 429 — physical Send and recovery gates (#2617)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opk-2617-send-'));
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', root);
    mocks.verifyProfile.mockResolvedValue({ state: 'verified' });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mocks.browserQueue.length = 0;
    rmSync(root, { recursive: true, force: true });
  });

  it('blocks physical Send and composer fill on a witnessed pre-insertion conversation fetch HTTP 429', async () => {
    const url = 'https://chatgpt.com/c/26172617-2617-4617-8617-261726172617';
    const request = { method: () => 'GET',
      url: () => 'https://chatgpt.com/backend-api/conversations/26172617-2617-4617-8617-261726172617' };
    const events = new EventEmitter();
    const fill = vi.fn(async () => undefined);
    const click = vi.fn(async () => undefined);
    const composer = scalarLocator({
      count: async () => 1,
      evaluate: async () => ({ visible: true, enabled: true, contentEditable: true }),
      fill, innerText: async () => '',
    });
    let injected = false;
    const page = Object.assign(events, {
      __fakeBrowserGptPage: true,
      url: () => url, isClosed: () => false,
      goto: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      waitForTimeout: vi.fn(async () => undefined),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) {
          if (!injected && events.listenerCount('response') > 0) {
            injected = true;
            events.emit('request', request);
            events.emit('response', { request: () => request, status: () => 429 });
          }
          return composer;
        }
        if (selector === SEND_BUTTON_SELECTOR) return scalarLocator({ count: async () => 1, click });
        return scalarLocator();
      }),
    });
    const context = enqueueBrowserForTurn(mocks, page).context;
    Object.assign(context, { pages: () => [page] });
    const profile = join(root, 'profile');
    const invocationId = randomUUID();
    const { result } = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      '--profile', profile, '--cdp', 'http://127.0.0.1:9222',
      '--input', join(root, 'input'), '--output', join(root, 'output'),
      '--chat-url', url, '--invocation-id', invocationId, '--timeout-ms', '60000',
    ]);
    expect(injected).toBe(true);
    expect(fill).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      state: 'rate_limit', cause: 'conversation_fetch_http_429',
      send_count: 0,
      product_wall_diagnostic: {
        wall_kind: 'conversation_fetch_http_429',
        http_status: 429,
        status_source: 'owned_page_response',
        matched_text: 'none', matched_selector: 'none',
      },
    });
    expect(result.send_attempted).not.toBe(true);
    expect(readStateLightAccountCooldown(configuredProfileKey(profile, 'http://127.0.0.1:9222')).active).toBe(true);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('stops successor navigation when an owned conversation fetch HTTP 429 arises during census', async () => {
    const fixture = recoveryFixture({ originalIncomplete: true });
    let observed429 = false;
    const adapter = {
      ...fixture.adapter,
      readAuthoritativeMessages: vi.fn(async () => {
        observed429 = true;
        return { messages: [], incomplete: true };
      }),
      accountActionBlocker: vi.fn(() => observed429 ? 'conversation_fetch_http_429' : undefined),
    };
    const result = await runPostSendRecovery({
      browser: {}, currentPage: fixture.original, marker: MARKER,
      hardDeadlineMs: 500, pollMs: 1, state: fixture.state, adapter,
    });
    expect(result).toMatchObject({
      kind: 'failure', state: 'observation_uncertain',
      cause: 'conversation_fetch_http_429', action: 'retain_owned_page_no_resend',
    });
    expect(fixture.createSuccessor).not.toHaveBeenCalled();
  });

  it('lets positive exact owned marker recovery complete even when a 429 cooldown is already active', async () => {
    const fixture = recoveryFixture({ includeOriginalMarker: true });
    const adapter = { ...fixture.adapter, accountActionBlocker: () => 'account_cooldown_active' };
    const result = await runPostSendRecovery({
      browser: {}, currentPage: fixture.original, marker: MARKER,
      hardDeadlineMs: 500, pollMs: 1, state: fixture.state, adapter,
    });
    expect(result).toMatchObject({ kind: 'recovered', page: fixture.original, conversationUrl: fixture.url });
    expect(fixture.createSuccessor).not.toHaveBeenCalled();
  });
});


describe('conversation fetch HTTP 429 — fresh preparation and same-Page ownership (#2617 review)', () => {
  let root: string;
  const cdp = 'http://127.0.0.1:9222';
  const projectRoot = 'https://chatgpt.com/g/g-p-26172617261726172617261726172617-test';
  const projectUrl = projectRoot + '/project';
  const conversationUuid = '26172617-2617-4617-8617-261726172617';
  const conversationUrl = projectRoot + '/c/' + conversationUuid;
  // A query-less GET is the owned load fetch; query polls need the load heading (#2723).
  const exactRequestUrl = 'https://chatgpt.com/backend-api/conversations/' + conversationUuid;
  const listRequestUrl = 'https://chatgpt.com/backend-api/conversations?limit=20';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opk-2617-fresh-review-'));
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', root);
    mocks.verifyProfile.mockResolvedValue({ state: 'verified' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    mocks.browserQueue.length = 0;
    rmSync(root, { recursive: true, force: true });
  });

  function freshPage(
    profile: string,
    invocationId: string,
    options: { redirectOnOpen?: boolean; account429OnOpen?: boolean; exact429AfterOwnedSend?: boolean;
      send429?: 'own' | 'slash' | 'markerless' | 'mismatch' | 'plain' | 'duplicate' | 'unreadable' | 'pre-dispatch'; uncertainSend?: boolean;
      existing?: boolean; listFirst?: boolean } = {},
  ) {
    let currentUrl = options.existing ? conversationUrl : 'about:blank';
    let draft = '';
    let sentText = '';
    let sent = false;
    let opened = false;
    let exact429Emitted = false;
    let initialFetchEmitted = false;
    let activeMessages = readyTurnObservationFrames('PROMPT', 'REPLY')[0]!;
    let observationIndex = 0;
    const frames = readyTurnObservationFrames('PROMPT', 'REPLY');
    const history = [{ role: 'user' as const, text: 'Prior user' },
      { role: 'assistant' as const, text: 'Prior reply', finalActionInTurnContainer: true }];
    const events = new EventEmitter();
    const emit429 = (requestUrl: string): void => {
      const request = { method: () => 'GET', url: () => requestUrl };
      events.emit('request', request);
      events.emit('response', { request: () => request, status: () => 429 });
    };
    const emitSend429 = (payload: string): void => {
      const text = options.send429 === 'markerless' ? 'PROMPT'
        : options.send429 === 'mismatch' ? MARKED_PROMPT : payload;
      const request = { method: () => 'POST',
        url: () => 'https://chatgpt.com/backend-api/' + (options.send429 === 'plain' ? 'conversation' : 'f/conversation')
          + (options.send429 === 'slash' ? '/' : ''),
        postData: () => options.send429 === 'unreadable' ? '{not-json' : JSON.stringify({
          messages: [{ author: { role: 'user' }, content: { content_type: 'text',
            parts: options.send429 === 'duplicate' ? [text, text] : [text] } }],
        }),
      };
      events.emit('request', request);
      events.emit('response', { request: () => request, status: () => 429 });
    };
    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      evaluate: vi.fn(async () => ({ visible: true, enabled: true, contentEditable: true })),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async (value: string) => {
        draft = value;
        if (options.send429 === 'pre-dispatch') emitSend429(value);
      }),
      innerText: vi.fn(async () => sent ? '' : draft),
      textContent: vi.fn(async () => sent ? '' : draft),
    });
    const send = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => {
        if (options.send429 && options.send429 !== 'pre-dispatch') emitSend429(draft);
        if (options.uncertainSend) throw new Error('Connection interrupted');
        sent = true;
        sentText = draft;
        draft = '';
        currentUrl = conversationUrl;
      }),
    });
    const page = Object.assign(events, {
      __fakeBrowserGptPage: true,
      url: vi.fn(() => currentUrl),
      isClosed: vi.fn(() => false),
      goto: vi.fn(async (target: string) => {
        currentUrl = !opened && options.redirectOnOpen ? conversationUrl : target;
        if (!opened && options.account429OnOpen) emit429(listRequestUrl);
        opened = true;
      }),
      waitForTimeout: vi.fn(async (milliseconds: number) => { clock.now += milliseconds; }),
      close: vi.fn(async () => undefined),
      getByText: vi.fn(() => scalarLocator()),
      getByRole: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (options.existing && !initialFetchEmitted && events.listenerCount('response') > 0) {
          initialFetchEmitted = true;
          if (options.listFirst) emit429(listRequestUrl);
          const request = { method: () => 'GET', url: () => exactRequestUrl };
          events.emit('request', request);
          events.emit('response', { request: () => request, status: () => 200 });
          if (!options.listFirst) emit429(listRequestUrl);
        }
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return send;
        if (selector === RENDERED_CONVERSATION_TURN_SECTION_SELECTOR) return scalarLocator({
          last: () => scalarLocator({ turnActionButtons: options.existing && !sent }),
        });
        if (selector === USER_MESSAGE_SELECTOR) return collectionLocator(
          [...(options.existing ? [history[0]!] : []), ...(sent ? [{ role: 'user' as const, text: sentText }] : [])],
        );
        if (selector === MESSAGE_NODE_SELECTOR) {
          // Ownership becomes positive only after the fresh Send's claimed URL
          // has been persisted. Emit a *new* GET on the same Page after that.
          if (options.exact429AfterOwnedSend && sent && !exact429Emitted
            && readStateLightTurnObservation(configuredProfileKey(profile, cdp), invocationId).phase === 'sent_unharvested') {
            exact429Emitted = true;
            emit429(exactRequestUrl);
          }
          if (!sent) {
            activeMessages = options.existing ? history : [];
            const nodes = collectionLocator(activeMessages);
            if (options.existing) Object.assign(nodes, { evaluateAll: async () => ({
              rows: activeMessages.map((message, domIndex) => ({ ...message, domIndex,
                key: `data-message-id:history-${domIndex}`, complete: true,
                completionReady: message.role === 'assistant', continuationVisible: false })),
              pageTurnEvidence: { generationInProgress: false, observedAssistantNodes: 1, continueGeneratingVisible: false },
            }) });
            return nodes;
          }
          activeMessages = [...(options.existing ? history : []), ...frames[Math.min(observationIndex++, frames.length - 1)]!];
          const nodes = collectionLocator(activeMessages, observationIndex < 3);
          if (options.existing) Object.assign(nodes, { evaluateAll: async () => ({
            rows: activeMessages.map((message, domIndex) => ({ ...message, domIndex,
              key: `data-message-id:history-${domIndex}`, complete: true,
              completionReady: Boolean(message.finalActionInTurnContainer), continuationVisible: false })),
            pageTurnEvidence: { generationInProgress: observationIndex < 3, observedAssistantNodes: 2, continueGeneratingVisible: false },
          }) });
          return nodes;
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          const last = activeMessages.at(-1);
          return last?.finalActionInTurnContainer ? messageLocator(last) : scalarLocator();
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) return collectionLocator(
          activeMessages.filter((message) => message.role === 'assistant'), sent && observationIndex < 3,
        );
        return scalarLocator();
      }),
    });
    return { page, composer, send, getExact429Emitted: () => exact429Emitted };
  }

  const clock = { now: 100_000 };
  async function runFresh(profile: string, invocationId: string, page: any, existing = false) {
    enqueueBrowserForTurn(mocks, page);
    return runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      '--profile', profile, '--cdp', cdp, '--input', join(root, 'input'),
      '--output', join(root, 'output'), ...(existing ? ['--chat-url', conversationUrl] : ['--new-chat', '--project-url', projectUrl]),
      '--invocation-id', invocationId, '--timeout-ms', '90000', '--poll-ms', '1',
    ]);
  }

  it('refuses two distinct active-cooldown invocations before any CDP target or Page allocation', async () => {
    clock.now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const profile = join(root, 'profile');
    const key = configuredProfileKey(profile, cdp);
    const path = join(profileDirs(key).locks, 'state-light-account-cooldown.v1.json');
    publishWitnessedStateLight429(key, clock.now);
    const exactExpiry = JSON.parse(readFileSync(path, 'utf8')).cooldown_until_ms as number;
    expect(exactExpiry).toBe(160_000);

    const ownAttach = await import('./own-target-attach.ts');
    const ui = await import('./ui-adapter.ts');
    const targetTransport = await import('./own-target-cdp-proxy.ts');
    const attach = vi.mocked(ownAttach.attachOwnTarget);
    const loadChrome = vi.mocked(ui.loadChromium);
    const allocate = vi.spyOn(targetTransport, 'createOwnCdpTarget');
    attach.mockClear();
    loadChrome.mockClear();
    // No preallocated fixture Page is enqueued for either invocation:
    // any CDP transport attempt would be an unexpected missing fixture.
    expect(mocks.browserQueue).toHaveLength(0);
    for (const [index, invocationId] of [randomUUID(), randomUUID()].entries()) {
      clock.now += index + 1;
      const { result } = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
        '--profile', profile, '--cdp', cdp, '--input', join(root, 'input'),
        '--output', join(root, 'refusal-' + index), '--new-chat', '--project-url', projectUrl,
        '--invocation-id', invocationId, '--timeout-ms', '90000',
      ]);
      expect(result).toMatchObject({
        state: 'rate_limit', cause: 'account_cooldown_active', send_count: 0,
      });
      expect(result.send_attempted).not.toBe(true);
      expect(JSON.parse(readFileSync(path, 'utf8')).cooldown_until_ms).toBe(exactExpiry);
    }
    expect(attach).not.toHaveBeenCalled();
    expect(loadChrome).not.toHaveBeenCalled();
    expect(allocate).not.toHaveBeenCalled();
    expect(mocks.browserQueue).toHaveLength(0);
    expect(JSON.parse(readFileSync(path, 'utf8')).cooldown_until_ms).toBe(exactExpiry);
  });

  it('honors a valid earlier shared cooldown before a second fresh navigation', async () => {
    clock.now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const profile = join(root, 'profile');
    const invocationId = randomUUID();
    const fixture = freshPage(profile, invocationId, { redirectOnOpen: true });
    publishWitnessedStateLight429(configuredProfileKey(profile, cdp), clock.now);
    const { result } = await runFresh(profile, invocationId, fixture.page);
    expect(fixture.page.goto).not.toHaveBeenCalled();
    expect(fixture.send.click).not.toHaveBeenCalled();
    expect(result).toMatchObject({ state: 'rate_limit', cause: 'account_cooldown_active', send_count: 0 });
  });

  it('allows a usable blank fresh surface despite its sidebar-list 429', async () => {
    clock.now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const profile = join(root, 'profile');
    const invocationId = randomUUID();
    const fixture = freshPage(profile, invocationId, { account429OnOpen: true });
    const { result } = await runFresh(profile, invocationId, fixture.page);
    expect(fixture.send.click).toHaveBeenCalledTimes(1);
    expect(result.send_count).toBe(1);
    expect(result.product_wall_diagnostic?.http_status).toBeUndefined();
    expect(readStateLightAccountCooldown(configuredProfileKey(profile, cdp), clock.now).active).toBe(false);
  });

  it('retains an independent unavailable blank-surface failure alongside sidebar 429', async () => {
    clock.now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const profile = join(root, 'profile');
    const invocationId = randomUUID();
    const fixture = freshPage(profile, invocationId, { account429OnOpen: true });
    fixture.page.goto.mockImplementation(async () => {
      const request = { method: () => 'GET', url: () => listRequestUrl };
      fixture.page.emit('request', request);
      fixture.page.emit('response', { request: () => request, status: () => 429 });
      throw new Error('navigation failed');
    });
    const { result } = await runFresh(profile, invocationId, fixture.page);
    expect(fixture.send.click).not.toHaveBeenCalled();
    expect(result.cause).toBe('navigation failed');
    expect(result.product_wall_diagnostic?.http_status).toBeUndefined();
    expect(readStateLightAccountCooldown(configuredProfileKey(profile, cdp), clock.now).active).toBe(false);
  });

  it('retains a local blank-surface redirect failure alongside sidebar 429', async () => {
    clock.now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const profile = join(root, 'profile');
    const invocationId = randomUUID();
    const fixture = freshPage(profile, invocationId, { redirectOnOpen: true, account429OnOpen: true });
    const { result } = await runFresh(profile, invocationId, fixture.page);
    expect(fixture.send.click).not.toHaveBeenCalled();
    expect(result).toMatchObject({ state: 'ui_contract_mismatch', cause: 'fresh_conversation_surface_unavailable', send_count: 0 });
    expect(readStateLightAccountCooldown(configuredProfileKey(profile, cdp), clock.now).active).toBe(false);
  });

  it.each([true, false])('allows existing-chat Send with exact GET 200 and list 429 (list first: %s)', async (listFirst) => {
    clock.now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const profile = join(root, 'profile');
    const invocationId = randomUUID();
    const fixture = freshPage(profile, invocationId, { existing: true, listFirst });
    const { result } = await runFresh(profile, invocationId, fixture.page, true);
    expect(fixture.send.click, JSON.stringify(result)).toHaveBeenCalledTimes(1);
    expect(result.send_count).toBe(1);
    expect(result.state, JSON.stringify(result)).toBe('ok');
    const key = configuredProfileKey(profile, cdp);
    expect(readStateLightAccountCooldown(key, clock.now).active).toBe(false);
    expect(existsSync(join(profileDirs(key).locks, 'state-light-account-cooldown.v1.json'))).toBe(false);
  });

  it.each(['own', 'slash', 'markerless', 'mismatch', 'plain', 'duplicate', 'unreadable', 'pre-dispatch'] as const)(
    'binds only the real onDispatch own Send POST 429 (%s), never resending', async (send429) => {
      clock.now = 100_000;
      vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
      const profile = join(root, 'profile');
      const invocationId = randomUUID();
      const fixture = freshPage(profile, invocationId, { send429 });
      const { result } = await runFresh(profile, invocationId, fixture.page);
      expect(fixture.send.click).toHaveBeenCalledTimes(1);
      expect(result.send_count).toBe(1);
      const eligible = send429 === 'own' || send429 === 'slash';
      const key = configuredProfileKey(profile, cdp);
      expect(readStateLightAccountCooldown(key, clock.now).active).toBe(eligible);
      if (eligible) {
        expect(JSON.parse(readFileSync(join(profileDirs(key).locks, 'state-light-account-cooldown.v1.json'), 'utf8')))
          .toEqual({ cooldown_until_ms: 160_000, last_witness_at_ms: 100_000, backoff_step: 1 });
        expect(result.product_wall_diagnostic).toMatchObject({ wall_kind: 'rate_limit', http_status: 429 });
      }
    },
  );

  it.each(['own', 'markerless'] as const)('retains possible delivery after uncertain %s POST 429 without a second Send', async (send429) => {
    clock.now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const profile = join(root, 'profile');
    const invocationId = randomUUID();
    const fixture = freshPage(profile, invocationId, { send429, uncertainSend: true });
    const { result } = await runFresh(profile, invocationId, fixture.page);
    expect(fixture.send.click).toHaveBeenCalledTimes(1);
    const observation = readStateLightTurnObservation(configuredProfileKey(profile, cdp), invocationId);
    if (send429 === 'own') {
      // A witnessed own POST proves one physical Send even when the action throws
      // and no conversation URL/reply is available. HTTP 429 still does not prove delivery.
      expect(result.send_count).toBe(1);
      expect(observation).toMatchObject({
        phase: 'sent_unbound', send_count: 1, send_witness: 'numeric_send_count',
      });
    } else {
      expect(result).toMatchObject({ send_attempted: true, send_count: 0 });
      expect(observation).toMatchObject({ phase: 'dispatching', send_witness: 'none' });
    }
    expect(deriveDelivery({ ...result, resolved_send_count: result.send_count } as any, false))
      .toBe('POSSIBLY_DELIVERED');
    const key = configuredProfileKey(profile, cdp);
    if (send429 === 'own') {
      // The POST 429 is witnessed at the Send boundary, but this deliberately
      // uncertain turn may continue read-only observation past its 60s hold.
      // Expiration must not erase or silently renew the original witness.
      const record = JSON.parse(readFileSync(
        join(profileDirs(key).locks, 'state-light-account-cooldown.v1.json'), 'utf8',
      ));
      expect(record).toEqual({
        cooldown_until_ms: 160_000, last_witness_at_ms: 100_000, backoff_step: 1,
      });
      expect(readStateLightAccountCooldown(key, 100_000).active).toBe(true);
      expect(readStateLightAccountCooldown(key, clock.now).active).toBe(clock.now < 160_000);
    } else {
      expect(readStateLightAccountCooldown(key, clock.now).active).toBe(false);
      expect(existsSync(join(profileDirs(key).locks, 'state-light-account-cooldown.v1.json'))).toBe(false);
    }
  });

  it.each([false, true])('three source pages cannot create/refresh a hold or block a fourth unit (seeded: %s)', async (seeded) => {
    clock.now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const profile = join(root, 'profile');
    const key = configuredProfileKey(profile, cdp);
    const path = join(profileDirs(key).locks, 'state-light-account-cooldown.v1.json');
    if (seeded) publishWitnessedStateLight429(key, clock.now);
    const before = seeded ? readFileSync(path, 'utf8') : undefined;
    clock.now += 1_000;
    for (let source = 0; source < 3; source++) {
      const events = new EventEmitter();
      const witness = observeHeldPageConversation429(events, conversationUrl, () => publishWitnessedStateLight429(key, clock.now));
      const request = { method: () => 'GET', url: () => listRequestUrl };
      events.emit('request', request);
      events.emit('response', { request: () => request, status: () => 429 });
      expect(witness.current()).toBeUndefined();
      expect(readStateLightAccountCooldown(key, clock.now).active).toBe(seeded);
      witness.dispose();
      if (!seeded) {
        const invocationId = randomUUID();
        const fixture = freshPage(profile, invocationId, { account429OnOpen: true });
        const { result } = await runFresh(profile, invocationId, fixture.page);
        expect(result.send_count).toBe(1);
      }
    }
    const moduleUrl = new URL('./state-light-turn-base.ts', import.meta.url).href;
    const child = runProcessSync({
      command: process.execPath, args: ['--experimental-strip-types', '--input-type=module', '--eval',
        `import { readStateLightAccountCooldown } from ${JSON.stringify(moduleUrl)};
process.stdout.write(JSON.stringify(readStateLightAccountCooldown(${JSON.stringify(key)}, ${clock.now})));`],
      env: { CHATGPT_BROWSER_TURN_STATE_DIR: root }, inheritParentEnv: true, encoding: 'utf8', timeoutMs: 15_000,
    });
    expect(child.ok, child.stderr || child.error).toBe(true);
    expect(JSON.parse(child.stdout).active).toBe(seeded);
    if (seeded) {
      expect(readFileSync(path, 'utf8')).toBe(before);
      clock.now = 400_000;
      expect(readStateLightAccountCooldown(key, clock.now).active).toBe(false);
    } else expect(existsSync(path)).toBe(false);
    const invocationId = randomUUID();
    const fourth = freshPage(profile, invocationId, { existing: true });
    const { result } = await runFresh(profile, invocationId, fourth.page, true);
    expect(result.send_count).toBe(1);
  });

  it.each(['ready', 'fallback'] as const)(
    'stops a separately awaited composer fill when click witnesses 429 (%s)', async (branch) => {
      const events = new EventEmitter();
      const request = { method: () => 'GET', url: () => exactRequestUrl };
      const fill = vi.fn(async () => undefined);
      const click = vi.fn(async () => {
        events.emit('request', request);
        events.emit('response', { request: () => request, status: () => 429 });
      });
      const composer = scalarLocator({
        count: vi.fn(async () => 1), click, fill,
        evaluate: vi.fn(async () => ({
          visible: branch === 'ready', enabled: true, contentEditable: true,
        })),
      });
      const page = Object.assign(events, { locator: () => composer });
      const witness = observeHeldPageConversation429(page, conversationUrl);
      try {
        const preflight = () => {
          const wall = heldPage429Diagnostic(page);
          if (wall) throw new Error(wall.wall_kind);
        };
        await expect(__testComposerMutation.mutateComposerOrCause(
          page, 'PROMPT', Date.now() + 30_000, undefined, preflight,
        )).rejects.toThrow('conversation_fetch_http_429');
        expect(click).toHaveBeenCalledTimes(1);
        expect(fill).not.toHaveBeenCalled();
      } finally {
        witness.dispose();
      }
    },
  );

  it('binds a same-Page post-Send exact-chat GET 429 only after owned /c/ identity is proven', async () => {
    clock.now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const profile = join(root, 'profile');
    const invocationId = randomUUID();
    const fixture = freshPage(profile, invocationId, { exact429AfterOwnedSend: true });
    const { result } = await runFresh(profile, invocationId, fixture.page);
    expect(fixture.getExact429Emitted()).toBe(true);
    expect(fixture.send.click).toHaveBeenCalledTimes(1);
    expect(result.send_count).toBe(1);
    expect(result.product_wall_diagnostic).toMatchObject({
      wall_kind: 'conversation_fetch_http_429',
      http_status: 429, status_source: 'owned_page_response',
    });
    expect(readStateLightAccountCooldown(configuredProfileKey(profile, cdp), clock.now).active).toBe(true);
  });
});


// Derived generic ProseMirror subtree; no live DOM capture is claimed.
function inertInlineProseMirrorSurface(text: string): any {
  const editor: any = proseMirrorEditorSurface(text);
  const paragraph = editor.childNodes[0];
  const textLeaf = paragraph?.childNodes[0];
  if (textLeaf?.nodeType !== 3) throw new Error('expected_text_leaf');
  paragraph.childNodes.splice(0, 1, {
    nodeType: 1, tagName: 'SPAN', childNodes: [textLeaf],
    getAttribute: (name: string) => name === 'inert' ? '' : null,
    hasAttribute: (name: string) => name === 'inert',
    get textContent() { return textLeaf.nodeValue; },
  });
  editor.getClientRects = () => [{}];
  editor.getBoundingClientRect = () => ({ width: 280, height: 30 });
  return editor;
}

describe('Issue #2651 lossless composer and one-operation owned-draft clearing', () => {
  function editorFixture(initial: string, editable = true) {
    let content = initial;
    const element: any = {
      isConnected: true, isContentEditable: editable,
      classList: { contains: () => false },
      getAttribute: () => null,
      getClientRects: () => [{}],
      getBoundingClientRect: () => ({ width: 280, height: 30 }),
      get textContent() { return content; },
      set textContent(value: string) { content = value; },
      get innerText() { return content; },
    };
    element.ownerDocument = {
      defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
      querySelectorAll: (selector: string) => selector === COMPOSER_SELECTOR ? [element] : [],
    };
    const evaluate = vi.fn(async (callback: (element: unknown, payload?: string) => unknown, payload?: string) =>
      callback(element, payload));
    const page = { locator: () => ({ evaluate }) };
    return { page, evaluate, element, current: () => content, mutate: (value: string) => { content = value; } };
  }

  function visibleProseMirror(text: string) {
    const element: any = proseMirrorEditorSurface(text);
    element.getClientRects = () => [{}];
    element.getBoundingClientRect = () => ({ width: 280, height: 30 });
    return element;
  }

  it('compares every code point and clears only that exact content inside one browser operation', async () => {
    const payload = MARKED_PROMPT + ' \n\n line 2 \t';
    const editor = editorFixture(payload);
    expect(await __testSendDelivery.readLosslessOwnedComposer(
      editor.page.locator(), Date.now() + 2000,
    )).toBe(payload);
    expect(await __testSendDelivery.conditionalClearOwnedComposerDraft(
      editor.page, payload, Date.now() + 2000,
    )).toBe(true);
    expect(editor.current()).toBe('');
    expect(editor.evaluate).toHaveBeenCalledTimes(3);
  });

  it.each(['foreign-draft', 'changed-whitespace', 'non-editable'] as const)(
    'never clears %s when invocation ownership is not exact', async (mode) => {
      const payload = MARKED_PROMPT + '   ';
      const editor = editorFixture(mode === 'foreign-draft' ? 'foreign text'
        : mode === 'changed-whitespace' ? MARKED_PROMPT + '  ' : payload,
      mode !== 'non-editable');
      const before = editor.current();
      expect(await __testSendDelivery.conditionalClearOwnedComposerDraft(
        editor.page, payload, Date.now() + 2000,
      )).toBe(false);
      expect(editor.current()).toBe(before);
    },
  );

  it('requires two agreeing lossless DOM representations, not normalized visual text', async () => {
    const editor = editorFixture(MARKED_PROMPT);
    const inconsistent = { locator: () => ({
      evaluate: async (callback: (element: unknown) => unknown) =>
        callback({ textContent: MARKED_PROMPT, innerText: MARKED_PROMPT.replace('\n\n', '\n') }),
    }) };
    expect(await __testSendDelivery.readLosslessOwnedComposer(
      inconsistent.locator(), Date.now() + 2000,
    )).toBeUndefined();
    editor.mutate(MARKED_PROMPT.replace('\n\n', ' '));
    expect(await __testSendDelivery.readLosslessOwnedComposer(
      editor.page.locator(), Date.now() + 2000,
    )).not.toBe(MARKED_PROMPT);
  });

  // Derived structural replay of the reported empty-p/trailingBreak shape.
  // No authenticated exact-invocation CDP capture is asserted by this fixture.
  it('reconstructs a unique empty ProseMirror p as empty despite innerText newline (#2694)', async () => {
    const element: any = visibleProseMirror('');
    element.childNodes[0].getAttribute = (name: string) => name === 'data-empty-paragraph' ? '' : null;
    element.ownerDocument.querySelectorAll = (selector: string) =>
      selector === COMPOSER_SELECTOR ? [element] : [];
    const composer = { evaluate: async (callback: (element: unknown, arg?: unknown) => unknown, arg?: unknown) =>
      callback(element, arg) };
    expect(element.textContent).toBe('');
    expect(element.innerText).toBe('\n');
    expect(await __testSendDelivery.readLosslessOwnedComposer(composer, Date.now() + 2000)).toBe('');
  });

  it('preserves every interior blank paragraph, space and tab with misleading empty attributes (#2694)', async () => {
    const exact = MARKED_PROMPT + '\n \t\n\nlast';
    const element: any = visibleProseMirror(exact);
    element.childNodes[3].getAttribute = (name: string) => name === 'data-empty-paragraph' ? '' : null;
    element.ownerDocument.querySelectorAll = (selector: string) =>
      selector === COMPOSER_SELECTOR ? [element] : [];
    const composer = { evaluate: async (callback: (element: unknown, arg?: unknown) => unknown, arg?: unknown) =>
      callback(element, arg) };
    expect(await __testSendDelivery.readLosslessOwnedComposer(
      composer, Date.now() + 2000, false, exact.length,
    )).toBe(exact);
    expect(await __testSendDelivery.readLosslessOwnedComposer(
      composer, Date.now() + 2000, false, exact.length - 1,
    )).toBeUndefined();
  });

  it('refuses nested inert ProseMirror bytes for retry, retirement and atomic clear (#2694)', async () => {
    const original = MARKED_PROMPT;
    const editor = inertInlineProseMirrorSurface(original);
    editor.ownerDocument.querySelectorAll = (selector: string) =>
      selector === COMPOSER_SELECTOR ? [editor] : [];
    const composer = {
      count: async () => 1,
      evaluate: async (callback: (element: unknown, argument?: unknown) => unknown, argument?: unknown) =>
        callback(editor, argument),
    };
    const page = { locator: () => composer };
    const deadline = Date.now() + 5_000;
    // Raw DOM textContent joins paragraphs without their structural newlines.
    const beforeDomText = editor.textContent;
    expect(beforeDomText).toBe(original.replace(/\n/gu, ''));
    expect(await __testSendDelivery.readLosslessOwnedComposer(
      composer, deadline, false, original.length,
    )).toBeUndefined();
    expect(await __testSendDelivery.readRetirementComposer(
      page, original, deadline,
    )).toBe('composer_unknown');
    expect(await __testSendDelivery.conditionalClearOwnedComposerDraft(
      page, original, deadline,
    )).toBe(false);
    expect(editor.textContent).toBe(beforeDomText);
  });

  // Captured 2026-10-24T00:56:54Z from the pinned original Page (target
  // 53FA1BE4, LeoPoker conversation 6adc007a, invocation
  // issue402-fix-remaining-20261024-042fb419-ae01-4dfd-93c8-c8a6da734513), 16s
  // after its composer_unknown cleanup refusal. Both editors matched
  // COMPOSER_SELECTOR; the second sat in a Workspace-* subtree under
  // display:none (box 0x0) with this sanitized outerHTML:
  //   <div contenteditable="true" role="textbox" class="ProseMirror">
  //     <p data-empty-paragraph="true" data-placeholder="Ask ChatGPT" class="placeholder">
  //       <br class="ProseMirror-trailingBreak"></p></div>
  it.each([
    { peer: 'captured unrendered empty', rects: 0, child: 'trailing-break', expected: 'empty' },
    { peer: 'unrendered draft', rects: 0, child: 'text', expected: 'composer_unknown' },
    { peer: 'unrendered image', rects: 0, child: 'image', expected: 'composer_unknown' },
    { peer: 'unrendered double break', rects: 0, child: 'double-break', expected: 'composer_unknown' },
    { peer: 'rendered empty', rects: 1, child: 'trailing-break', expected: 'composer_unknown' },
  ] as const)('retirement reads past a $peer peer editor as $expected (#2694 follow-up)', async ({ rects, child, expected }) => {
    const node = (tagName: string, childNodes: any[], attributes: Record<string, string> = {}): any => ({
      nodeType: 1, tagName, childNodes,
      classList: { contains: (name: string) => (attributes.class ?? '').split(' ').includes(name) },
      getAttribute: (name: string) => attributes[name] ?? null,
      get textContent(): string {
        return childNodes.map((item) => item.nodeType === 3 ? item.nodeValue : item.textContent).join('');
      },
    });
    const editorAttributes = { contenteditable: 'true', role: 'textbox', class: 'ProseMirror' };
    const element: any = visibleProseMirror('');
    element.getAttribute = (name: string) => (editorAttributes as Record<string, string>)[name] ?? null;
    const trailingBreak = () => node('BR', [], { class: 'ProseMirror-trailingBreak' });
    const peer = node('DIV', [node('P', child === 'text' ? [{ nodeType: 3, nodeValue: 'hidden draft' }]
      : child === 'image' ? [node('IMG', [], { src: 'data:,' })]
        : child === 'double-break' ? [trailingBreak(), trailingBreak()] : [trailingBreak()],
    { 'data-empty-paragraph': 'true', 'data-placeholder': 'Ask ChatGPT', class: 'placeholder' })], editorAttributes);
    peer.getClientRects = () => Array.from({ length: rects }, () => ({}));
    // The attribute part of COMPOSER_SELECTOR, evaluated per node instead of
    // returning both editors unconditionally.
    const matchesComposer = (candidate: any) => candidate.getAttribute('id') === 'prompt-textarea'
      || (candidate.getAttribute('contenteditable') === 'true' && candidate.getAttribute('role') === 'textbox'
        && !candidate.classList.contains('cm-content'));
    expect(COMPOSER_SELECTOR).toContain('[contenteditable="true"][role="textbox"]');
    const matched = [peer, element].filter(matchesComposer);
    expect(matched).toHaveLength(2);
    element.ownerDocument.querySelectorAll = (selector: string) => selector === COMPOSER_SELECTOR ? matched : [];
    const nth = (index: number) => ({
      evaluate: async (callback: (element: unknown, arg?: unknown) => unknown, arg?: unknown) =>
        callback(matched[index], arg),
    });
    const page = { locator: () => ({ count: async () => matched.length, nth }) };
    expect(await __testSendDelivery.readRetirementComposer(page, undefined, Date.now() + 2000)).toBe(expected);
  });

  it.each(['unknown-child', 'hidden', 'duplicate-editor', 'mixed-root'] as const)(
    'refuses structurally unproven owned ProseMirror subtree: %s (#2694)', async (kind) => {
      const element: any = visibleProseMirror(MARKED_PROMPT);
      if (kind === 'unknown-child') element.childNodes[0].childNodes.push({
        nodeType: 1, tagName: 'SCRIPT', childNodes: [], getAttribute: () => null,
      });
      if (kind === 'hidden') {
        const original = element.childNodes[0].getAttribute;
        element.childNodes[0].getAttribute = (name: string) =>
          name === 'aria-hidden' ? 'true' : original(name);
      }
      if (kind === 'mixed-root') element.childNodes.push({ nodeType: 3, nodeValue: 'foreign' });
      element.ownerDocument.querySelectorAll = (selector: string) =>
        selector === COMPOSER_SELECTOR ? kind === 'duplicate-editor' ? [element, {}] : [element] : [];
      const composer = { evaluate: async (callback: (element: unknown, arg?: unknown) => unknown, arg?: unknown) =>
        callback(element, arg) };
      expect(await __testSendDelivery.readLosslessOwnedComposer(
        composer, Date.now() + 2000, false, MARKED_PROMPT.length + 100,
      )).toBeUndefined();
    },
  );

  it.each(['aria-hidden', 'inert', 'display-none', 'hidden-attribute', 'zero-rect', 'zero-width', 'zero-height'] as const)(
    'refuses exact owned draft under %s ancestor or unusable editor box (#2694)',
    async (kind) => {
      const owned = MARKED_PROMPT;
      const structured = visibleProseMirror(owned);
      const fallback = editorFixture(owned);
      const ancestors = (element: any) => {
        const ancestor: any = {
          parentElement: null,
          getAttribute: (name: string) => kind === 'aria-hidden' && name === 'aria-hidden' ? 'true'
            : kind === 'hidden-attribute' && name === 'hidden' ? '' : null,
          hasAttribute: (name: string) => kind === 'inert' && name === 'inert',
        };
        element.parentElement = ancestor;
        element.getClientRects = () => kind === 'zero-rect' ? [] : [{}];
        element.getBoundingClientRect = () => ({
          width: kind === 'zero-width' ? 0 : 280, height: kind === 'zero-height' ? 0 : 30,
        });
        element.ownerDocument.defaultView.getComputedStyle = (node: any) => ({
          display: node === ancestor && kind === 'display-none' ? 'none' : 'block',
          visibility: 'visible',
        });
      };
      ancestors(structured);
      ancestors(fallback.element);
      structured.ownerDocument.querySelectorAll = (selector: string) =>
        selector === COMPOSER_SELECTOR ? [structured] : [];
      const composer = {
        evaluate: async (cb: (element: unknown, args?: unknown) => unknown, args?: unknown) =>
          cb(structured, args),
      };
      expect(await __testSendDelivery.readLosslessOwnedComposer(
        composer, Date.now() + 2_000, false, owned.length,
      )).toBeUndefined();
      expect(await __testSendDelivery.readLosslessOwnedComposer(
        fallback.page.locator(), Date.now() + 2_000, false, owned.length,
      )).toBeUndefined();
      expect(await __testSendDelivery.conditionalClearOwnedComposerDraft(
        fallback.page, owned, Date.now() + 2_000,
      )).toBe(false);
      expect(fallback.current()).toBe(owned);
    },
  );

  it('never performs a server check without an exact held owned URL and complete baseline', async () => {
    const get = vi.fn();
    const page = {
      url: () => 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000000',
      evaluate: get,
    };
    const result = await __testSendDelivery.observeExistingServerCheckedRecovery({
      page, browser: {}, composer: {},
      targetChatUrl: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
      markedPayload: MARKED_PROMPT, marker: MARKER,
      heldWitness: undefined,
      deadlineMs: Date.now() + 36000,
    });
    expect(result).toBe('unproven');
    expect(get).not.toHaveBeenCalled();
  });
});


describe('Issue #2651 integrated held-Page server-checked recovery and delivery promotion', () => {
  const cdp = 'http://127.0.0.1:9222';
  const uuid = '26512651-2651-4651-8651-265126512651';
  const chatUrl = 'https://chatgpt.com/c/' + uuid;
  type Case = 'negative' | 'positive' | 'incomplete' | 'paginated' | 'get429'
    | 'changed-composer' | 'hidden-parent' | 'inert-inline' | 'pre-actionability-budget' | 'late-positive'
    | 'overslept-poll' | 'reused-page' | 'late-assistant' | 'post-guard-whitespace'
    | 'post-guard-space' | 'post-guard-tab' | 'post-guard-blank' | 'post-guard-boundary'
    | 'affirmative-finalized' | 'affirmative-late-stop' | 'affirmative-late-draft';
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opk-2651-connected-'));
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', root);
    mocks.verifyProfile.mockResolvedValue({ state: 'verified' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    mocks.browserQueue.length = 0;
    rmSync(root, { recursive: true, force: true });
  });

  async function connectedTurn(kind: Case, corruption?: {
    content: 'joined-marker' | 'marker-content' | 'middle-content' | 'truncated-tail'
      | 'extra-space' | 'inserted-tab' | 'blank-paragraph' | 'line-boundary';
    when: 'after-click' | 'after-proof-read';
  }) {
    if (corruption) {
      const { readStableInput } = await import('./input.ts');
      vi.mocked(readStableInput).mockReturnValueOnce(stableTurnInput('keep separate words\n  indented line'));
    }
    const profile = join(root, 'profile');
    const invocationId = randomUUID();
    let now = 100_000;
    let draft = '';
    let clickCount = 0;
    let retryTailReads = 0;
    let injectedRetryCorruption = false;
    const corruptDraft = () => {
      draft = corruption?.content === 'joined-marker' ? draft.replace('\n\n', '')
        : corruption?.content === 'marker-content' ? draft.replace('OPKTURNV1', 'OTHER-TURN')
          : corruption?.content === 'middle-content' ? draft.replace('indented', 'different')
            : corruption?.content === 'extra-space' ? draft.replace('separate words', 'separate  words')
              : corruption?.content === 'inserted-tab' ? draft.replace('separate words', 'separate\twords')
                : corruption?.content === 'blank-paragraph' ? draft.replace('\n  indented', '\n\n  indented')
                  : corruption?.content === 'line-boundary' ? draft.replace('words\n', 'words \n')
                    : draft.slice(0, -1);
      injectedRetryCorruption = true;
    };
    let firstClickAt = -1;
    let explicitGetAt = -1;
    let injectedNaturalPositive = false;
    let oversleptPoll = false;
    let sawRecoveryLosslessRead = false;
    let sawTransientGenerationDuringStall = false;
    let appendedLateAssistant = false;
    let injectedWhitespaceMutation = false;
    let observedReusedNegativeGet = false;
    let injectedLateActivity = false;
    let stopVisible = false;
    let closed = false;
    const pageEvents = new EventEmitter();
    const calls: Array<{ url: string; header?: string }> = [];
    const prior = [
      { role: 'user' as const, text: 'historical user question', finalActionInTurnContainer: false },
      { role: 'assistant' as const, text: 'historical answer', finalActionInTurnContainer: true },
    ];
    const historic = Object.assign(collectionLocator(prior), {
      evaluateAll: vi.fn(async () => ({
        rows: prior.map((message, index) => ({
          role: message.role, text: message.text, domIndex: index,
          key: 'data-message-id:2651-historical-' + index, complete: true,
          completionReady: message.role === 'assistant', continuationVisible: false,
        })),
        pageTurnEvidence: {
          generationInProgress: false,
          observedAssistantNodes: prior.filter((item) => item.role === 'assistant').length,
          continueGeneratingVisible: false,
        },
      })),
    });
    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async (value: string) => { draft = value; }),
      innerText: vi.fn(async () => {
        // The final normalized guard runs after the successful GET, after the
        // preceding lossless read. Mutation here must veto a second click.
        if (kind.startsWith('post-guard-') && calls.length === 1
          && clickCount === 1 && !injectedWhitespaceMutation) {
          injectedWhitespaceMutation = true;
          const rewrittenBoundary = kind === 'post-guard-whitespace' ? '\n'
            : kind === 'post-guard-space' ? '\n\n '
              : kind === 'post-guard-tab' ? '\n\n\t'
                : kind === 'post-guard-blank' ? '\n\n\n' : ' \n';
          draft = draft.replace('\n\n', rewrittenBoundary);
        }
        const visible = draft;
        if (corruption?.when === 'after-proof-read' && clickCount === 1
          && now >= firstClickAt + 5_000 && ++retryTailReads === 2 && !injectedRetryCorruption) {
          corruptDraft();
        }
        return visible;
      }),
      textContent: vi.fn(async () => draft),
      evaluate: vi.fn(async (callback: (element: unknown, arg?: unknown) => unknown, args?: unknown, options?: { timeout?: number }) => {
        if (options?.timeout !== undefined) return true; // Older readiness adapter.
        const element: any = {
          get textContent() { return draft; },
          set textContent(value: string) { draft = value; },
          get innerText() { return draft; },
          isConnected: true, isContentEditable: true,
          getAttribute: () => null,
          classList: { contains: () => false },
          getClientRects: () => [{}],
          getBoundingClientRect: () => ({ width: 280, height: 30 }),
          parentElement: clickCount === 1 && kind === 'hidden-parent'
            ? { parentElement: null, getAttribute: (name: string) => name === 'aria-hidden' ? 'true' : null,
              hasAttribute: () => false }
            : null,
        };
        element.ownerDocument = {
          defaultView: {
            location: { get href() { return chatUrl; } },
            getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
          },
          querySelectorAll: (selector: string) => selector === COMPOSER_SELECTOR ? [element] : [],
        };
        // After the first attempted action, an inert inline wrapper must not
        // become exact retry authority despite unchanged marked literal bytes.
        const activeEditor = clickCount === 1 && kind === 'inert-inline'
          ? inertInlineProseMirrorSurface(draft) : element;
        if (activeEditor !== element) {
          activeEditor.ownerDocument = element.ownerDocument;
          activeEditor.ownerDocument.querySelectorAll = (selector: string) =>
            selector === COMPOSER_SELECTOR ? [activeEditor] : [];
        }
        const value = callback(activeEditor, args);
        if (clickCount === 1 && kind === 'overslept-poll'
          && (args === undefined || args === COMPOSER_SELECTOR
            || (typeof args === 'object' && args !== null && 'maxChars' in args))) {
          sawRecoveryLosslessRead = true;
        }
        return value;
      }),
    });
    const history = (text: string) => ({
      // Missing completeness evidence is distinct from an explicitly
      // paginated history; neither permits a marker-negative re-click.
      has_more: kind === 'paginated' ? true : kind === 'incomplete' ? undefined : false,
      current_node: 'user-one',
      mapping: {
        root: { parent: null, message: null },
        'user-one': { parent: 'root', message: {
          author: { role: 'user' }, content: { content_type: 'text', parts: [text] },
        } },
      },
    });
    const emitGet = (url: string, header: string | undefined, text: string, status: number) => {
      const request = {
        method: () => 'GET', url: () => url,
        headers: () => header ? { 'x-opk-recovery-invocation': header } : {},
      };
      pageEvents.emit('request', request);
      pageEvents.emit('response', {
        request: () => request, status: () => status,
        finished: async () => null, json: async () => history(text),
      });
    };
    const sendButton = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => {
        clickCount++;
        if (firstClickAt < 0) firstClickAt = now;
        if (clickCount === 1 && corruption?.when === 'after-click') corruptDraft();
        if (kind === 'reused-page' && !observedReusedNegativeGet) {
          // Even a complete matching-UUID marker-negative GET from passive
          // Page traffic cannot turn a created:false target into retry authority.
          observedReusedNegativeGet = true;
          emitGet('https://chatgpt.com/backend-api/conversations/' + uuid,
            undefined, 'old user text', 200);
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        }
        // A late external Stop or draft after the second disabled-click attempt
        // must retain the possibly-sent original, never certify not_sent.
        if ((kind === 'affirmative-late-stop' || kind === 'affirmative-late-draft')
          && clickCount === 2 && !injectedLateActivity) {
          injectedLateActivity = true;
          if (kind === 'affirmative-late-stop') stopVisible = true;
          else draft = 'FOREIGN SHARED DRAFT AFTER CLEAR';
        }
        if ((kind === 'pre-actionability-budget' && clickCount === 1)
          || kind === 'affirmative-finalized'
          || kind === 'affirmative-late-stop' || kind === 'affirmative-late-draft') {
          const error = Object.assign(new Error([
            'locator.click: Timeout 5000ms exceeded', 'Call log:',
            '  - waiting for element to be visible, enabled and stable',
            '  - element is not enabled',
          ].join('\n')), { name: 'TimeoutError' });
          throw error;
        }
        throw new Error('synthetic ambiguous Send action');
      }),
    });
    const evaluate = vi.fn(async (callback: (details: unknown) => Promise<void>, details?: { uuid?: string; marker?: string }) => {
      if (!details?.uuid) return undefined; // Pre-Send alert marking.
      const priorFetch = globalThis.fetch;
      const fetchOnHeldPage = vi.fn(async (resource: unknown, options?: { headers?: Record<string, string> }) => {
        const url = new URL(String(resource), 'https://chatgpt.com').toString();
        calls.push({ url, header: options?.headers?.['x-opk-recovery-invocation'] });
        explicitGetAt = now;
        emitGet(url, options?.headers?.['x-opk-recovery-invocation'],
          kind === 'positive' ? details.marker! : 'old user text', kind === 'get429' ? 429 : 200);
        return { arrayBuffer: async () => new ArrayBuffer(0) };
      });
      // Execute the real Page-origin callback against an in-memory same-Page
      // transport. The existing held witness receives its request/response events.
      (globalThis as any).fetch = fetchOnHeldPage;
      try { await callback(details); }
      finally { globalThis.fetch = priorFetch; }
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      return undefined;
    });
    const page = Object.assign(pageEvents, {
      __fakeBrowserGptPage: true,
      url: vi.fn(() => chatUrl), isClosed: vi.fn(() => closed),
      goto: vi.fn(async () => undefined), close: vi.fn(async () => { closed = true; }),
      waitForTimeout: vi.fn(async (ms: number) => {
        if (kind === 'overslept-poll' && sawRecoveryLosslessRead && !oversleptPoll) {
          // The event loop misses generation and its completion while asleep.
          // A quiet final DOM/negative GET must not turn this into an idle settle.
          oversleptPoll = true;
          sawTransientGenerationDuringStall = true;
          now += ms + 30_500;
        } else now += ms;
        if (kind === 'late-assistant' && clickCount === 1 && !appendedLateAssistant
          && now >= firstClickAt + 10_000) {
          appendedLateAssistant = true;
          prior.push({ role: 'assistant', text: 'new completed answer during settle', finalActionInTurnContainer: true });
        }
        if (kind === 'changed-composer' && clickCount === 1 && now >= firstClickAt + 10_000) {
          draft += ' ';
        }
        if (kind === 'late-positive' && clickCount === 2 && !injectedNaturalPositive) {
          injectedNaturalPositive = true;
          const marker = /^OPKTURNV1[0-9a-f]{32}/u.exec(draft)?.[0];
          if (marker) emitGet('https://chatgpt.com/backend-api/conversations/' + uuid, undefined, marker, 200);
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        }
      }),
      evaluate, getByText: vi.fn(() => scalarLocator()), getByRole: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return sendButton;
        if (selector === RENDERED_STOP_BUTTON_SELECTOR) return scalarLocator({
          count: vi.fn(async () => stopVisible ? 1 : 0),
          isVisible: vi.fn(async () => stopVisible),
        });
        if (selector === MESSAGE_NODE_SELECTOR) return historic;
        if (selector === USER_MESSAGE_SELECTOR) return collectionLocator([prior[0]!]);
        if (selector === ASSISTANT_MESSAGE_SELECTOR) return collectionLocator([prior[1]!]);
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          return messageLocator(prior[1]!);
        }
        if (selector === RENDERED_CONVERSATION_TURN_SECTION_SELECTOR) return scalarLocator({
          last: () => scalarLocator({ turnActionButtons: true }),
        });
        return scalarLocator();
      }),
    });
    const harness = enqueueBrowserForTurn(mocks, page);
    // Default to an invocation-created target; a URL-matched existing target
    // is a separate created:false negative-control case, not retry authority.
    if (kind === 'reused-page') Object.assign(harness.context, { pages: () => [page] });
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const outcome = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
        '--profile', profile, '--cdp', cdp, '--input', join(root, 'prompt'),
        '--output', join(root, 'reply'), '--chat-url', chatUrl,
        '--invocation-id', invocationId, '--timeout-ms', '120000', '--poll-ms', '1',
      ]);
      return {
        ...outcome, click: sendButton.click, evaluate, calls, firstClickAt,
        explicitGetAt, getClock: () => now, getDraft: () => draft,
        injectedNaturalPositive, oversleptPoll, sawTransientGenerationDuringStall,
        appendedLateAssistant, injectedWhitespaceMutation, injectedLateActivity,
        isStopVisible: () => stopVisible,
        injectedRetryCorruption,
        observedReusedNegativeGet,
        close: page.close,
        observation: readStateLightTurnObservation(configuredProfileKey(profile, cdp), invocationId),
      };
    } finally {
      clock.mockRestore();
    }
  }

  it.each([
    ['negative', 2, 1], ['positive', 1, 1], ['incomplete', 1, 1],
    ['paginated', 1, 1], ['get429', 1, 1], ['changed-composer', 1, 0],
    ['hidden-parent', 1, 0], ['inert-inline', 1, 0],
    ['pre-actionability-budget', 2, 0], ['late-positive', 2, 1],
    ['overslept-poll', 1, 0], ['reused-page', 1, 0],
    ['late-assistant', 1, 0], ['post-guard-whitespace', 1, 1],
    ['post-guard-space', 1, 1], ['post-guard-tab', 1, 1],
    ['post-guard-blank', 1, 1], ['post-guard-boundary', 1, 1],
  ] as const)('guards full held-Page GET and one shared repeat: %s', async (kind, clicks, explicitGets) => {
    const t = await connectedTurn(kind);
    expect(t.click).toHaveBeenCalledTimes(clicks);
    expect(t.calls).toHaveLength(explicitGets);
    if (explicitGets === 1) {
      expect(t.calls[0]).toEqual({
        url: 'https://chatgpt.com/backend-api/conversations/' + uuid,
        header: expect.stringMatching(/^OPKTURNV1[0-9a-f]{32}$/u),
      });
      expect(t.explicitGetAt - t.firstClickAt).toBeGreaterThanOrEqual(30_000);
      expect(t.evaluate).toHaveBeenCalledWith(expect.any(Function), {
        uuid, marker: expect.stringMatching(/^OPKTURNV1[0-9a-f]{32}$/u),
      });
    }
    // Even two ambiguous actions never grant a third Send or terminal not_sent.
    expect(t.click).not.toHaveBeenCalledTimes(3);
    expect(t.observation.phase).not.toBe('not_sent');
    if (kind === 'negative') {
      expect(t.result).toMatchObject({ send_count: 0, send_attempted: true, state: 'observation_uncertain' });
      expect(deriveDelivery({ ...t.result, resolved_send_count: t.result.send_count } as any, false))
        .toBe('POSSIBLY_DELIVERED');
    }
    if (kind === 'positive' || kind === 'late-positive') {
      expect(t.result.send_count).toBe(1);
      expect(t.observation).toMatchObject({ phase: 'sent_unharvested', send_count: 1 });
    }
    if (kind === 'late-positive') expect(t.injectedNaturalPositive).toBe(true);
    if (kind === 'overslept-poll') {
      expect(t.oversleptPoll).toBe(true);
      expect(t.sawTransientGenerationDuringStall).toBe(true);
    }
    if (kind === 'late-assistant') expect(t.appendedLateAssistant).toBe(true);
    if (kind === 'reused-page') expect(t.observedReusedNegativeGet).toBe(true);
    if (kind.startsWith('post-guard-')) expect(t.injectedWhitespaceMutation).toBe(true);
    if (kind === 'inert-inline' || kind === 'reused-page' || kind === 'late-assistant'
      || kind === 'overslept-poll' || kind.startsWith('post-guard-')) {
      expect(t.close).not.toHaveBeenCalled();
      expect(t.observation.phase).not.toBe('not_sent');
    }
  });

  it.each((['joined-marker', 'marker-content', 'middle-content', 'truncated-tail'] as const).flatMap((content) =>
    (['after-click', 'after-proof-read'] as const).map((when) => ({ content, when })),
  ))('vetoes an existing-chat retry with $content corruption $when (#2669)', async (corruption) => {
    const t = await connectedTurn('pre-actionability-budget', corruption);
    expect(t.injectedRetryCorruption).toBe(true);
    expect(t.click).toHaveBeenCalledTimes(1);
    expect(t.result.send_count).toBe(0);
    expect(t.calls).toHaveLength(0);
    expect(t.close).not.toHaveBeenCalled();
  });

  it.each((['extra-space', 'inserted-tab', 'blank-paragraph', 'line-boundary'] as const)
    .map((content) => ({ content, when: 'after-click' as const })))(
    'rejects $content after positive first-click non-dispatch despite intact marker and normalized draft (#2694)',
    async (corruption) => {
      const t = await connectedTurn('pre-actionability-budget', corruption);
      expect(t.injectedRetryCorruption).toBe(true);
      expect(t.click).toHaveBeenCalledTimes(1);
      expect(t.result.send_count).toBe(0);
      expect(t.calls).toHaveLength(0);
      expect(t.close).not.toHaveBeenCalled();
    },
  );

  it('does not treat affirmative disabled-click timeouts as never-attempted not_sent (#2685 r04)', async () => {
    const t = await connectedTurn('affirmative-finalized');
    expect(t.click).toHaveBeenCalledTimes(2);
    expect(t.calls).toHaveLength(0);
    // A timed-out attempted click is not the prepared -> not_sent row, even
    // when Playwright logged only disabled/pre-actionability operations.
    expect(t.close).not.toHaveBeenCalled();
    expect(t.getDraft()).toMatch(/^OPKTURNV1[0-9a-f]{32}\n\n/u);
    expect(t.result).toMatchObject({
      state: 'observation_uncertain', send_count: 0, send_attempted: true,
    });
    expect(t.observation.phase).toBe('dispatching');
  });

  it.each(['affirmative-late-stop', 'affirmative-late-draft'] as const)(
    'preserves a created Page when %s arrives after the second attempted action', async (kind) => {
      const t = await connectedTurn(kind);
      expect(t.injectedLateActivity).toBe(true);
      expect(t.click).toHaveBeenCalledTimes(2);
      expect(t.close).not.toHaveBeenCalled();
      expect(t.observation.phase).not.toBe('not_sent');
      expect(t.result.send_attempted).toBe(true);
      if (kind === 'affirmative-late-stop') expect(t.isStopVisible()).toBe(true);
      else expect(t.getDraft()).toBe('FOREIGN SHARED DRAFT AFTER CLEAR');
    },
  );
});

describe('composer selector scope (#2694 follow-up)', () => {
  // Tiny generic matcher for the selector's own grammar: comma groups of
  // `#id` or `[attr="v"]` compounds with `:not(.cls)` / `:not([attr] *)` clauses.
  type FakeEl = { id?: string; attrs: Record<string, string>; parent?: FakeEl };
  const hasAttr = (el: FakeEl, token: string) => {
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/u.exec(token)!;
    return m[1]! in el.attrs && (m[2] === undefined || el.attrs[m[1]!] === m[2]);
  };
  const matches = (el: FakeEl, selector: string): boolean => selector.split(/,\s*/u).some((group) => {
    const nots = [...group.matchAll(/:not\(([^()]*(?:\([^()]*\))?[^()]*)\)/gu)].map((m) => m[1]!);
    const base = group.replace(/:not\(([^()]*(?:\([^()]*\))?[^()]*)\)/gu, '').trim();
    const idMatch = /^#([\w-]+)$/u.exec(base);
    const positive = idMatch ? el.id === idMatch[1] : (base.match(/\[[^\]]+\]/gu) ?? []).every((t) => hasAttr(el, t));
    if (!positive) return false;
    return nots.every((clause) => {
      if (clause.startsWith('.')) return !(el.attrs.class ?? '').split(/\s+/u).includes(clause.slice(1));
      const ancestorToken = clause.replace(/\s*\*$/u, '');
      for (let a = el.parent; a; a = a.parent) if (hasAttr(a, ancestorToken)) return false;
      return true;
    });
  });

  it('matches the real composer but not a CodeMirror code editor inside a message', () => {
    const unit: FakeEl = { attrs: { 'data-chatgpt-search-unit-key': 'fallback-turn-0:2:assistant' } };
    const block: FakeEl = { attrs: { 'data-code-block': 'true' }, parent: unit };
    const cm: FakeEl = {
      attrs: { contenteditable: 'true', role: 'textbox', class: 'cm-content', 'aria-label': 'Edit code' },
      parent: block,
    };
    const composer: FakeEl = {
      attrs: { contenteditable: 'true', role: 'textbox', class: 'ProseMirror', 'aria-label': 'Ask ChatGPT' },
    };
    const promptTextarea: FakeEl = { id: 'prompt-textarea', attrs: {} };
    expect(matches(cm, COMPOSER_SELECTOR)).toBe(false);
    expect(matches({ ...cm, attrs: { ...cm.attrs, class: '' } }, COMPOSER_SELECTOR)).toBe(false);
    expect(matches(composer, COMPOSER_SELECTOR)).toBe(true);
    expect(matches(promptTextarea, COMPOSER_SELECTOR)).toBe(true);
  });
});
