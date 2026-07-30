import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  browserQueue: [] as any[],
  cleanupOutcome: 'confirmed' as 'confirmed' | 'unconfirmed',
  journalThrows: false,
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
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    appendFileSync: mocks.appendFileSync,
    linkSync: mocks.linkSync,
  };
});

vi.mock('./browser-session.ts', () => ({
  RESOURCE_CLEANUP_BOUND_MS: 5_000,
  boundedResourceCleanup: vi.fn(async (cleanup: () => Promise<void>) => {
    if (mocks.cleanupOutcome === 'confirmed') await cleanup();
    return mocks.cleanupOutcome;
  }),
  releaseCdpBrowser: mocks.releaseBrowser,
}));

vi.mock('./coordination.ts', () => ({
  destinationIdentity: vi.fn((path: string) => ({
    identity: `identity:${path}`,
    finalPath: path,
  })),
}));

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
  return {
    ...actual,
    classifyProductWall: vi.fn(() => ({})),
    loadChromium: vi.fn(() => ({
      connectOverCDP: vi.fn(async () => {
        const browser = mocks.browserQueue.shift();
        if (!browser) throw new Error('no fake browser queued');
        return browser;
      }),
    })),
    normalizeConversationUrl: actual.normalizeConversationUrl,
    productStatusText: vi.fn(async () => ''),
    verifyProfile: mocks.verifyProfile,
  };
});

import { scalarLocator } from './state-light-turn.test-fixtures.ts';
import { classifyPageObservation, runStateLightTurn } from './state-light-turn.ts';
import {
  releaseStateLightFreshConversationClaim,
  tryClaimStateLightFreshConversation,
} from './state-light-fresh-conversation.ts';

const PROJECT_URL = 'https://chatgpt.com/g/g-p-test/project';
const SHARED_CONV = `${PROJECT_URL}/c/11111111-1111-4111-8111-111111111111`;
const LOSER_CONV = `${PROJECT_URL}/c/22222222-2222-4222-8222-222222222222`;

type Message = {
  role: 'user' | 'assistant';
  text: string;
  finalAction?: boolean;
  finalActionInTurnContainer?: boolean;
};

function readySnapshots(prompt: string, reply: string): Message[][] {
  const working = [
    { role: 'user' as const, text: prompt },
    { role: 'assistant' as const, text: 'working' },
  ];
  const final = [
    { role: 'user' as const, text: prompt },
    {
      role: 'assistant' as const,
      text: reply,
      finalAction: true,
      finalActionInTurnContainer: true,
    },
  ];
  return [working, working, final, final];
}

function messageLocator(message: Message, generating = false) {
  return scalarLocator({
    count: vi.fn(async () => 1),
    getAttribute: vi.fn(async (name: string) => {
      if (name === 'data-message-author-role') return message.role;
      if (name === 'data-is-streaming') return generating ? 'true' : null;
      if (name === 'aria-busy') return null;
      return null;
    }),
    locator: vi.fn((selector: string) => {
      if (selector.startsWith('xpath=') || selector.includes('conversation-turn-')) {
        if (!message.finalActionInTurnContainer) return scalarLocator({ count: vi.fn(async () => 0) });
        return scalarLocator({ turnActionButtons: true, count: vi.fn(async () => 1) });
      }
      if (message.role !== 'assistant') return scalarLocator();
      if (message.finalAction && !message.finalActionInTurnContainer && selector.includes('copy-turn-action-button')) {
        return scalarLocator({ count: vi.fn(async () => 1) });
      }
      if (message.inProgress && (
        selector.includes('[aria-busy="true"]')
        || selector.includes('[data-is-streaming="true"]')
        || selector.includes('[data-testid*="tool"]')
      )) {
        return scalarLocator({ count: vi.fn(async () => 1) });
      }
      return scalarLocator();
    }),
    innerText: vi.fn(async () => message.text),
    textContent: vi.fn(async () => message.text),
  });
}

function collectionLocator(messages: Message[], generating = false) {
  return scalarLocator({
    count: vi.fn(async () => messages.length),
    nth: vi.fn((index: number) => messageLocator(messages[index]!, generating && index === messages.length - 1)),
  });
}

function makeLoserPage(prompt: string, reply: string) {
  let sends = 0;
  let sent = false;
  let url = PROJECT_URL;
  let observationIndex = 0;
  const snapshotFrames = readySnapshots(prompt, reply).map((messages, index) => ({
    messages,
    generating: index < 2,
  }));
  let activeSnapshot = snapshotFrames[0]!;

  const composer = scalarLocator({
    count: vi.fn(async () => 1),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
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
    locator: vi.fn((selector: string) => {
      if (selector === '#prompt-textarea') return composer;
      if (selector === '[data-testid="send-button"]') return sendButton;
      if (selector.includes('create-new-chat-button') || selector.includes('New chat')) {
        return scalarLocator({ count: vi.fn(async () => 0) });
      }
      if (selector === '[data-message-author-role]') {
        if (!sent) return collectionLocator([]);
        activeSnapshot = snapshotFrames[Math.min(observationIndex, snapshotFrames.length - 1)]!;
        observationIndex++;
        return collectionLocator(activeSnapshot.messages, activeSnapshot.generating);
      }
      if (selector.startsWith('xpath=ancestor-or-self::section')) {
        const last = activeSnapshot.messages.at(-1);
        if (last?.finalActionInTurnContainer) return messageLocator(last);
        return scalarLocator({ count: vi.fn(async () => 0) });
      }
      if (selector === '[data-message-author-role="assistant"]') {
        return collectionLocator(activeSnapshot.messages.filter((message) => message.role === 'assistant'), activeSnapshot.generating);
      }
      if (selector.includes('stop-button')) return scalarLocator();
      return scalarLocator();
    }),
  };

  return { page, getSends: () => sends };
}

function browserFor(page: any) {
  const context = { newPage: vi.fn(async () => page) };
  return {
    browser: {
      contexts: vi.fn(() => [context]),
      isConnected: vi.fn(() => true),
      close: vi.fn(async () => undefined),
    },
    context,
  };
}

function stableInput(prompt: string) {
  return {
    text: prompt,
    bytes: new Uint8Array([...prompt].map((char) => char.charCodeAt(0))),
    byteLength: prompt.length,
    dev: 1n,
    ino: 1n,
  };
}

async function runNewChatTurn(page: any, outputPath: string) {
  const { browser } = browserFor(page);
  mocks.browserQueue.push(browser);
  const writes: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    const code = await runStateLightTurn([
      '--profile', '/tmp/profile',
      '--cdp', 'http://127.0.0.1:9222',
      '--input', '/tmp/prompt.txt',
      '--output', outputPath,
      '--new-chat',
      '--project-url', PROJECT_URL,
      '--timeout-ms', '5000',
      '--poll-ms', '1',
    ]);
    return { code, result: JSON.parse(writes.at(-1) ?? '{}') };
  } finally {
    stdout.mockRestore();
  }
}

describe('state-light fresh conversation collision recovery', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'slt-fresh-'));
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = stateDir;
    process.env.OPK_STATE_LIGHT_DISABLE_NEW_CHAT_SEND_SLOT = '1';
    mocks.browserQueue.length = 0;
    mocks.cleanupOutcome = 'confirmed';
    mocks.nowMs = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => mocks.nowMs);
    mocks.readStableInput.mockReset();
  });

  afterEach(() => {
    delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
    delete process.env.OPK_STATE_LIGHT_DISABLE_NEW_CHAT_SEND_SLOT;
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

  it('recovers the contended invocation onto an isolated surface without sibling refusal', async () => {
    const profileKey = 'collision-profile';
    expect(tryClaimStateLightFreshConversation(profileKey, SHARED_CONV, 'winner-invocation')).toBe('claimed');

    expect(classifyPageObservation(
      [
        { role: 'user', text: 'PROMPT-WINNER' },
        { role: 'assistant', text: 'WINNER-OK' },
      ],
      0,
      'PROMPT-WINNER',
      false,
    )).toMatchObject({ state: 'ready', reply: 'WINNER-OK' });

    mocks.readStableInput.mockImplementationOnce(() => stableInput('PROMPT-LOSER'));
    const loser = makeLoserPage('PROMPT-LOSER', 'LOSER-OK');
    const loserOutcome = await runNewChatTurn(loser.page, '/tmp/loser.txt');

    expect(loserOutcome.code).toBe(0);
    expect(loserOutcome.result).toMatchObject({
      state: 'ok',
      cause: 'completed_page_only',
      send_count: 1,
      conversation_id: LOSER_CONV,
    });
    expect(loserOutcome.result.state).not.toBe('foreign_activity');
    expect(loserOutcome.result.incidents).toContain('fresh_conversation_collision');
    expect(loser.getSends()).toBe(2);

    releaseStateLightFreshConversationClaim(profileKey, SHARED_CONV, 'winner-invocation');
  });

  it('still rejects real foreign human activity after the owned prompt', () => {
    const baseline = [
      { role: 'user' as const, text: 'OLD' },
      { role: 'assistant' as const, text: 'OLD ANSWER' },
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
      state: 'foreign_activity',
    });
  });
});
