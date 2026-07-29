import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  browserQueue: [] as any[],
  cleanupOutcome: 'confirmed' as 'confirmed' | 'unconfirmed',
  journalThrows: false,
  verifyProfile: vi.fn(async () => ({ state: 'verified' })),
  publishReply: vi.fn(() => ({
    schema: 'publication-status/v1',
    state: 'committed_ok',
    configured_profile_key: 'profile-key',
    invocation_id: 'invocation',
    output_path: '/tmp/reply.txt',
    output_bytes: 5,
    output_sha256: 'sha256-reply',
  })),
  releaseBrowser: vi.fn(async () => undefined),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(() => {
      if (mocks.journalThrows) throw new Error('journal unavailable');
    }),
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
  readStableInput: vi.fn(() => ({
    text: 'PROMPT',
    bytes: new Uint8Array([80, 82, 79, 77, 80, 84]),
    byteLength: 6,
    dev: 1n,
    ino: 1n,
  })),
}));

vi.mock('./publication.ts', () => ({ publishReply: mocks.publishReply }));
vi.mock('./storage-common.ts', () => ({ configuredProfileKey: vi.fn(() => 'profile-key') }));
vi.mock('./ui-adapter.ts', () => ({
  classifyProductWall: vi.fn(() => ({})),
  loadChromium: vi.fn(() => ({
    connectOverCDP: vi.fn(async () => {
      const browser = mocks.browserQueue.shift();
      if (!browser) throw new Error('no fake browser queued');
      return browser;
    }),
  })),
  normalizeConversationUrl: vi.fn((value: string) => value),
  productStatusText: vi.fn(async () => ''),
  verifyProfile: mocks.verifyProfile,
}));

import { runStateLightTurn } from './state-light-turn.ts';

type Message = { role: 'user' | 'assistant'; text: string };
type Snapshot = { messages: Message[]; generating: boolean };

const BASELINE: Message[] = [
  { role: 'user', text: 'OLD' },
  { role: 'assistant', text: 'OLD ANSWER' },
];

function scalarLocator(overrides: Record<string, unknown> = {}) {
  const locator: Record<string, any> = {
    count: vi.fn(async () => 0),
    first: vi.fn(() => locator),
    nth: vi.fn(() => locator),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    innerText: vi.fn(async () => ''),
    textContent: vi.fn(async () => ''),
    getAttribute: vi.fn(async () => null),
    ...overrides,
  };
  return locator;
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
    innerText: vi.fn(async () => message.text),
    textContent: vi.fn(async () => message.text),
  });
}

function collectionLocator(messages: Message[], generating = false) {
  const locator = scalarLocator({
    count: vi.fn(async () => messages.length),
    nth: vi.fn((index: number) => messageLocator(messages[index]!, generating && index === messages.length - 1)),
  });
  return locator;
}

function makePage(
  snapshots: Snapshot[],
  options: { throwAfterSend?: boolean; sendButton?: boolean } = {},
) {
  let sent = false;
  let filled = '';
  let observationIndex = 0;
  let activeSnapshot: Snapshot = { messages: BASELINE, generating: false };
  const metrics = { sends: 0, closes: 0, polls: 0 };

  const composer = scalarLocator({
    count: vi.fn(async () => 1),
    fill: vi.fn(async (value: string) => { filled = value; }),
    press: vi.fn(async (key: string) => {
      if (key !== 'Enter') throw new Error(`unexpected key: ${key}`);
      sent = true;
      metrics.sends++;
    }),
  });
  const sendButton = scalarLocator({
    count: vi.fn(async () => options.sendButton === false ? 0 : 1),
    click: vi.fn(async () => {
      sent = true;
      metrics.sends++;
    }),
  });

  const page: any = {
    __fakeBrowserGptPage: true,
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => 'https://chatgpt.com/c/fake-owned-turn'),
    waitForTimeout: vi.fn(async () => undefined),
    close: vi.fn(async () => { metrics.closes++; }),
    getByText: vi.fn(() => scalarLocator()),
    locator: vi.fn((selector: string) => {
      if (selector === '#prompt-textarea') return composer;
      if (selector === '[data-testid="send-button"]') return sendButton;
      if (selector === '[data-message-author-role]') {
        if (sent && options.throwAfterSend) throw new Error('simulated page loss');
        if (!sent) {
          activeSnapshot = { messages: BASELINE, generating: false };
          return collectionLocator(activeSnapshot.messages);
        }
        activeSnapshot = snapshots[Math.min(observationIndex, Math.max(0, snapshots.length - 1))]
          ?? { messages: [...BASELINE, { role: 'user', text: filled }], generating: true };
        observationIndex++;
        metrics.polls++;
        return collectionLocator(activeSnapshot.messages);
      }
      if (selector === '[data-message-author-role="assistant"]') {
        const assistants = activeSnapshot.messages.filter((message) => message.role === 'assistant');
        return collectionLocator(assistants, activeSnapshot.generating);
      }
      if (selector.includes('stop-button')) return scalarLocator();
      return scalarLocator();
    }),
  };

  return { page, metrics };
}

function browserFor(page: any) {
  const context = { newPage: vi.fn(async () => page) };
  return {
    browser: {
      contexts: vi.fn(() => [context]),
      close: vi.fn(async () => undefined),
    },
    context,
  };
}

function readySnapshots(reply = 'FINAL'): Snapshot[] {
  return [
    {
      messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'working' }],
      generating: true,
    },
    {
      messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: reply }],
      generating: false,
    },
    {
      messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: reply }],
      generating: false,
    },
  ];
}

async function runAndCapture(page: any) {
  const { browser, context } = browserFor(page);
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
      '--output', '/tmp/reply.txt',
      '--chat-url', 'https://chatgpt.com/c/existing',
      '--timeout-ms', '1000',
      '--poll-ms', '1',
    ]);
    return {
      code,
      result: JSON.parse(writes.at(-1) ?? '{}'),
      context,
    };
  } finally {
    stdout.mockRestore();
  }
}

beforeEach(() => {
  mocks.browserQueue.length = 0;
  mocks.cleanupOutcome = 'confirmed';
  mocks.journalThrows = false;
  mocks.verifyProfile.mockReset().mockResolvedValue({ state: 'verified' });
  mocks.publishReply.mockReset().mockReturnValue({
    schema: 'publication-status/v1',
    state: 'committed_ok',
    configured_profile_key: 'profile-key',
    invocation_id: 'invocation',
    output_path: '/tmp/reply.txt',
    output_bytes: 5,
    output_sha256: 'sha256-reply',
  });
  mocks.releaseBrowser.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Issue #1120 state-light turn lifecycle', () => {
  it('executes the real turn path with one send and multiple read-only polls', async () => {
    const fake = makePage(readySnapshots());
    const outcome = await runAndCapture(fake.page);

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'ok',
      scope: 'none',
      cause: 'completed_page_only',
      send_count: 1,
      cleanup: 'confirmed',
    });
    expect(outcome.result.poll_count).toBeGreaterThanOrEqual(3);
    expect(fake.metrics.sends).toBe(1);
    expect(fake.metrics.polls).toBeGreaterThanOrEqual(3);
    expect(fake.metrics.closes).toBe(1);
    expect(outcome.context.newPage).toHaveBeenCalledTimes(1);
    expect(mocks.publishReply).toHaveBeenCalledTimes(1);
  });

  it('runs three overlapping invocations on independent owned tabs', async () => {
    const fakes = [makePage(readySnapshots('A')), makePage(readySnapshots('B')), makePage(readySnapshots('C'))];
    const browserTuples = fakes.map(({ page }) => browserFor(page));
    mocks.browserQueue.push(...browserTuples.map(({ browser }) => browser));
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const argv = [
        '--profile', '/tmp/profile', '--cdp', 'http://127.0.0.1:9222',
        '--input', '/tmp/prompt.txt', '--output', '/tmp/reply.txt',
        '--chat-url', 'https://chatgpt.com/c/existing', '--timeout-ms', '1000', '--poll-ms', '1',
      ];
      const codes = await Promise.all(fakes.map(() => runStateLightTurn(argv)));
      expect(codes).toEqual([0, 0, 0]);
    } finally {
      stdout.mockRestore();
    }

    for (let index = 0; index < fakes.length; index++) {
      expect(fakes[index]!.metrics.sends).toBe(1);
      expect(fakes[index]!.metrics.closes).toBe(1);
      expect(browserTuples[index]!.context.newPage).toHaveBeenCalledTimes(1);
    }
    expect(writes).toHaveLength(3);
  });

  it('keeps foreign activity invocation-local and still closes only its owned tab', async () => {
    const fake = makePage([{
      messages: [
        ...BASELINE,
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: 'partial' },
        { role: 'user', text: 'FOREIGN' },
        { role: 'assistant', text: 'FOREIGN ANSWER' },
      ],
      generating: false,
    }]);
    const outcome = await runAndCapture(fake.page);

    expect(outcome.result).toMatchObject({
      state: 'foreign_activity',
      scope: 'invocation',
      send_count: 1,
      cleanup: 'confirmed',
    });
    expect(fake.metrics.sends).toBe(1);
    expect(fake.metrics.closes).toBe(1);
    expect(mocks.publishReply).not.toHaveBeenCalled();
  });

  it('reports page loss after send without sending a replacement request', async () => {
    const fake = makePage([], { throwAfterSend: true });
    const outcome = await runAndCapture(fake.page);

    expect(outcome.result).toMatchObject({
      state: 'driver_error',
      scope: 'invocation',
      cause: 'helper_or_page_error_after_send',
      send_count: 1,
      cleanup: 'confirmed',
    });
    expect(outcome.result.incidents).toContain('helper_failure_after_send');
    expect(fake.metrics.sends).toBe(1);
    expect(fake.metrics.closes).toBe(1);
  });

  it('does not let cleanup or journal failure veto an already captured reply', async () => {
    mocks.cleanupOutcome = 'unconfirmed';
    mocks.journalThrows = true;
    const fake = makePage(readySnapshots());
    const outcome = await runAndCapture(fake.page);

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'ok',
      cause: 'completed_page_only',
      send_count: 1,
      cleanup: 'unconfirmed',
      journal_write_failed: true,
    });
    expect(outcome.result.incidents).toContain('owned_tab_cleanup_failed');
    expect(fake.metrics.sends).toBe(1);
    expect(fake.metrics.closes).toBe(0);
  });
});
