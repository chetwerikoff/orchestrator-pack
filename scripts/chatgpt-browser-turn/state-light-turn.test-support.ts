import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  browserQueue: [] as any[],
  cleanupOutcome: 'confirmed' as 'confirmed' | 'unconfirmed',
  journalThrows: false,
  nowMs: 10_000,
  outputConflict: false,
  verifyProfile: vi.fn(async (): Promise<ProfileVerification> => ({
    state: 'verified',
    cause: 'verified',
    evidence: 'test',
  })),
  legacyPublishReply: vi.fn(() => {
    throw new Error('legacy publication state unavailable');
  }),
  appendFileSync: vi.fn((_path: string, _data: string, _encoding: string) => {
    if (mocks.journalThrows) throw new Error('journal unavailable');
  }),
  openSync: vi.fn(() => 42),
  writeFileSync: vi.fn((_fd: number, _reply: string, _encoding: string) => undefined),
  fsyncSync: vi.fn((_fd: number) => undefined),
  closeSync: vi.fn((_fd: number) => undefined),
  linkSync: vi.fn((_from: string, _to: string) => {
    if (mocks.outputConflict) {
      throw Object.assign(new Error('output exists'), { code: 'EEXIST' });
    }
  }),
  unlinkSync: vi.fn((_path: string) => undefined),
  releaseBrowser: vi.fn(async () => undefined),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    appendFileSync: mocks.appendFileSync,
    openSync: mocks.openSync,
    writeFileSync: mocks.writeFileSync,
    fsyncSync: mocks.fsyncSync,
    closeSync: mocks.closeSync,
    linkSync: mocks.linkSync,
    unlinkSync: mocks.unlinkSync,
  };
});

vi.mock('./browser-session.ts', () => ({
  ...createBrowserSessionModuleMock(mocks),
  abandonLatePageHandle: vi.fn(async (page: { close: () => Promise<void> }) => {
    if (mocks.cleanupOutcome === 'confirmed') await page.close();
    return mocks.cleanupOutcome;
  }),
}));
vi.mock('./coordination.ts', () => createCoordinationModuleMock());

vi.mock('./input.ts', () => ({
  readStableInput: vi.fn(() => ({
    text: 'PROMPT',
    bytes: new Uint8Array([80, 82, 79, 77, 80, 84]),
    byteLength: 6,
    dev: 1n,
    ino: 1n,
  })),
}));

// A failure in the retired publication-state store must be irrelevant to the
// canonical state-light path. If that path imports/calls publishReply again,
// lifecycle success tests below fail immediately.
vi.mock('./publication.ts', () => ({ publishReply: mocks.legacyPublishReply }));
vi.mock('./storage-common.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage-common.ts')>();
  return {
    ...actual,
    configuredProfileKey: vi.fn(() => 'profile-key'),
  };
});
vi.mock('./ui-adapter.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui-adapter.ts')>();
  const { buildUiAdapterTestMock } = await import('./state-light-turn.test-fixtures.ts');
  return buildUiAdapterTestMock(actual, mocks, {
    classifyProductWall: (text: string) => {
      if (/quota/i.test(text)) return { state: 'quota', cause: 'quota_detected' };
      if (/challenge/i.test(text)) return { state: 'challenge', cause: 'challenge_detected' };
      if (/rate.?limit|temporarily limited/i.test(text)) return { state: 'rate_limit', cause: 'rate_limit_detected' };
      if (/login/i.test(text)) return { state: 'login', cause: 'login_detected' };
      return {};
    },
    normalizeConversationUrl: (value: string) => value,
    productStatusText: async (page: any) => String(page.__productStatusText?.() ?? ''),
  });
});

import {
  browserFor,
  collectionLocator,
  createBrowserSessionModuleMock,
  createCoordinationModuleMock,
  enqueueBrowserForTurn,
  messageLocator,
  runStateLightTurnWithStdoutCapture,
  scalarLocator,
  STATE_LIGHT_TURN_BASE_ARGV,
  type StateLightTestMessage,
  type StateLightTestSnapshot,
} from './state-light-turn.test-fixtures.ts';
import {
  ASSISTANT_TURN_ANCESTOR_XPATH,
  COMPOSER_SELECTOR,
  CONTINUE_GENERATING_BUTTON_NAME,
  MESSAGE_NODE_SELECTOR,
  ASSISTANT_MESSAGE_SELECTOR,
  SEND_BUTTON_SELECTOR,
  matchesStopButtonSelector,
} from './product-page-selectors.ts';
import { POST_SEND_OBSERVATION_POLL_MS, runStateLightTurn } from './state-light-turn.ts';
import { normalizeConversationUrl, type ProfileVerification } from './ui-adapter.ts';

import journalSymptoms from './fixtures/browser-turn-recurrence-journal-symptoms.json' with { type: 'json' };
import { BROWSER_TURN_RECURRENCE_REPLAY_KINDS } from './fixtures/browser-turn-recurrence-replay-kinds.ts';

const BASELINE: StateLightTestMessage[] = [
  { role: 'user', text: 'OLD' },
  { role: 'assistant', text: 'OLD ANSWER', finalAction: true },
];

function collectionLocatorWithReadFailures(
  messages: StateLightTestMessage[],
  generating: boolean,
  pollIndex: number,
  failMessageReadAt?: (messageIndex: number, pollIndex: number) => boolean,
) {
  return scalarLocator({
    count: vi.fn(async () => messages.length),
    nth: vi.fn((index: number) => {
      const locator = messageLocator(messages[index]!, generating && index === messages.length - 1);
      if (!failMessageReadAt?.(index, pollIndex)) return locator;
      return scalarLocator({
        count: vi.fn(async () => 1),
        getAttribute: vi.fn(async () => { throw new Error(`locator.getAttribute: Timeout 5000ms exceeded at node ${index}`); }),
        innerText: vi.fn(async () => { throw new Error(`locator.innerText: Timeout 5000ms exceeded at node ${index}`); }),
        textContent: vi.fn(async () => { throw new Error(`locator.textContent: Timeout 5000ms exceeded at node ${index}`); }),
        locator: locator.locator,
      });
    }),
  });
}

function makePage(
  snapshots: StateLightTestSnapshot[],
  options: {
    throwAfterSend?: boolean;
    transientStatusErrors?: number;
    transientReadErrors?: number | 'always';
    failMessageReadAt?: (messageIndex: number, pollIndex: number) => boolean;
    blockProductStatus?: boolean;
    sendButton?: boolean;
    wallText?: string;
    wallAfterPoll?: number;
    preSendMessages?: StateLightTestMessage[];
    pageUrl?: string;
    pageUrlAfterSend?: string;
  } = {},
) {
  let sent = false;
  let filled = '';
  let observationIndex = 0;
  let activeSnapshot: StateLightTestSnapshot = { messages: BASELINE, generating: false };
  let continuationDismissed = false;
  let closed = false;
  let transientStatusErrors = options.transientStatusErrors ?? 0;
  const metrics = { sends: 0, closes: 0, polls: 0, waitedMs: 0, continuationClicks: 0 };

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
    __productStatusText: () => {
      if (sent && options.blockProductStatus) {
        throw new Error('locator.innerText: Timeout 5000ms exceeded waiting for locator([role=alert]).nth(1)');
      }
      if (sent && transientStatusErrors > 0) {
        transientStatusErrors--;
        throw new Error('transient product status read');
      }
      if (!sent || !options.wallText) return '';
      const threshold = options.wallAfterPoll ?? 1;
      return metrics.polls >= threshold ? options.wallText : '';
    },
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => {
      const value = (sent && options.pageUrlAfterSend) ? options.pageUrlAfterSend : (options.pageUrl ?? 'https://chatgpt.com/c/existing');
      return value;
    }),
    isClosed: vi.fn(() => closed),
    waitForTimeout: vi.fn(async (ms: number) => {
      metrics.waitedMs += ms;
      mocks.nowMs += ms;
    }),
    close: vi.fn(async () => {
      closed = true;
      metrics.closes++;
    }),
    getByRole: vi.fn((role: string, options?: { name?: RegExp | string }) => {
      if (role !== 'button') return scalarLocator();
      const name = options?.name;
      const label = 'Continue generating';
      const matches = name instanceof RegExp
        ? CONTINUE_GENERATING_BUTTON_NAME.test(label)
        : typeof name === 'string' && CONTINUE_GENERATING_BUTTON_NAME.test(name);
      const visible = Boolean(activeSnapshot.continuation) && !continuationDismissed && matches;
      return scalarLocator({
        count: vi.fn(async () => visible ? 1 : 0),
        click: vi.fn(async () => {
          continuationDismissed = true;
          metrics.continuationClicks += 1;
        }),
      });
    }),
    getByText: vi.fn((pattern: RegExp | string) => {
      const text = 'Continue generating';
      const matches = typeof pattern === 'string' ? CONTINUE_GENERATING_BUTTON_NAME.test(text) : pattern.test(text);
      const visible = Boolean(activeSnapshot.continuation) && !continuationDismissed && matches;
      return scalarLocator({
        count: vi.fn(async () => visible ? 1 : 0),
        click: vi.fn(async () => { continuationDismissed = true; }),
      });
    }),
    locator: vi.fn((selector: string) => {
      if (selector === COMPOSER_SELECTOR) return composer;
      if (selector === SEND_BUTTON_SELECTOR) return sendButton;
      if (selector === MESSAGE_NODE_SELECTOR) {
        if (sent && options.transientReadErrors === 'always') {
          throw new Error('transient page read');
        }
        if (sent && typeof options.transientReadErrors === 'number' && options.transientReadErrors > 0) {
          options.transientReadErrors -= 1;
          throw new Error('transient page read');
        }
        if (sent && options.throwAfterSend) {
          closed = true;
          throw new Error('simulated page loss');
        }
        if (!sent) {
          activeSnapshot = { messages: options.preSendMessages ?? BASELINE, generating: false };
          return collectionLocator(activeSnapshot.messages);
        }
        activeSnapshot = snapshots[Math.min(observationIndex, Math.max(0, snapshots.length - 1))]
          ?? { messages: [...BASELINE, { role: 'user', text: filled }], generating: true };
        continuationDismissed = false;
        const pollIndex = observationIndex;
        observationIndex++;
        metrics.polls++;
        return collectionLocatorWithReadFailures(
          activeSnapshot.messages,
          activeSnapshot.generating,
          pollIndex,
          options.failMessageReadAt,
        );
      }
      if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
        const assistants = activeSnapshot.messages.filter((message) => message.role === 'assistant');
        const last = assistants.at(-1);
        if (!last?.finalActionInTurnContainer) return scalarLocator({ count: vi.fn(async () => 0) });
        return messageLocator(last, activeSnapshot.generating);
      }
      if (selector === ASSISTANT_MESSAGE_SELECTOR) {
        const assistants = activeSnapshot.messages.filter((message) => message.role === 'assistant');
        return collectionLocator(assistants, activeSnapshot.generating);
      }
      if (matchesStopButtonSelector(selector)) return scalarLocator();
      return scalarLocator();
    }),
  };

  return { page, metrics };
}

function readySnapshots(reply = 'FINAL'): StateLightTestSnapshot[] {
  return [
    {
      messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'working' }],
      generating: true,
    },
    {
      messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: reply, finalAction: true }],
      generating: false,
    },
    {
      messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: reply, finalAction: true }],
      generating: false,
    },
  ];
}

const DISPATCH_OBSERVATION_MS = 30_000;

function delayedReadySnapshots(waitingPolls: number, reply = 'FINAL'): StateLightTestSnapshot[] {
  const waiting: StateLightTestSnapshot = {
    messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'working' }],
    generating: true,
  };
  const ready: StateLightTestSnapshot = {
    messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: reply, finalAction: true }],
    generating: false,
  };
  return [...Array.from({ length: waitingPolls }, () => waiting), ready, ready];
}

async function runAndCapture(
  page: any,
  options: { timeoutMs?: string; pollMs?: string } = {},
) {
  const { context } = enqueueBrowserForTurn(mocks, page);
  const captured = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
    ...STATE_LIGHT_TURN_BASE_ARGV,
    '--output', '/tmp/reply.txt',
    '--chat-url', 'https://chatgpt.com/c/existing',
    '--timeout-ms', options.timeoutMs ?? '1000',
    '--poll-ms', options.pollMs ?? '1',
  ]);
  return { ...captured, context };
}

beforeEach(() => {
  vi.mocked(normalizeConversationUrl).mockImplementation((value: string) => value);
  mocks.browserQueue.length = 0;
  mocks.cleanupOutcome = 'confirmed';
  mocks.journalThrows = false;
  mocks.nowMs = 10_000;
  mocks.outputConflict = false;
  vi.spyOn(Date, 'now').mockImplementation(() => mocks.nowMs);
  mocks.verifyProfile.mockReset().mockResolvedValue({
    state: 'verified',
    cause: 'verified',
    evidence: 'test',
  });
  mocks.legacyPublishReply.mockClear();
  mocks.appendFileSync.mockClear();
  mocks.openSync.mockClear();
  mocks.writeFileSync.mockClear();
  mocks.fsyncSync.mockClear();
  mocks.closeSync.mockClear();
  mocks.linkSync.mockClear();
  mocks.unlinkSync.mockClear();
  mocks.releaseBrowser.mockClear();
});

afterEach(() => {
  delete process.env.OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS;
  delete process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS;
  delete process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS;
  vi.restoreAllMocks();
});

describe('Issue #1752 continuous turn liveness', () => {
  it('keeps heartbeats flowing during bounded newPage wait, closes a late page, and stops after terminal', async () => {
    process.env.OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS = '100';
    process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS = '10';
    process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS = '30';

    let resolveLatePage!: (page: any) => void;
    const pendingPage = new Promise<any>((resolve) => {
      resolveLatePage = resolve;
    });
    const latePage = { close: vi.fn(async () => undefined) };
    const context = { newPage: vi.fn(() => pendingPage) };
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
      const code = await runStateLightTurn([
        ...STATE_LIGHT_TURN_BASE_ARGV,
        '--output', '/tmp/reply.txt',
        '--chat-url', 'https://chatgpt.com/c/existing',
        '--timeout-ms', '40',
        '--poll-ms', '1',
        '--entry-liveness-heartbeat',
      ]);
      expect(code).not.toBe(0);

      const records = writes
        .flatMap((chunk) => chunk.split('\n'))
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const heartbeats = records.filter((record) => record.schema === 'observation-heartbeat/v1');
      expect(heartbeats.length).toBeGreaterThan(1);
      expect(heartbeats.every((record) => record.phase === 'admitted_pre_send')).toBe(true);
      expect(records.at(-1)).toMatchObject({
        schema: 'turn-result/v1',
        state: 'driver_error',
        cause: 'browser_operation_timeout:new_page',
        send_count: 0,
      });

      const writeCountAtTerminal = writes.length;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(writes).toHaveLength(writeCountAtTerminal);

      resolveLatePage(latePage);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(latePage.close).toHaveBeenCalledTimes(1);
    } finally {
      stdout.mockRestore();
    }
  });
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
    expect(mocks.linkSync).toHaveBeenCalledTimes(1);
  });

  it('matches owned prompt when textContent carries sr-only prefix but innerText equals prompt', async () => {
    const prompt = 'Issue #1120 strict-matcher smoke cell OUTPUT CONSTRAINTS Keep answer under 500 words';
    const rendered = prompt;
    const domTextContent = `You said: ${rendered}`;
    const snapshots: StateLightTestSnapshot[] = [
      {
        messages: [
          ...BASELINE,
          { role: 'user', text: rendered, domTextContent },
          { role: 'assistant', text: 'working' },
        ],
        generating: true,
      },
      {
        messages: [
          ...BASELINE,
          { role: 'user', text: rendered, domTextContent },
          { role: 'assistant', text: 'FINAL', finalAction: true },
        ],
        generating: false,
      },
      {
        messages: [
          ...BASELINE,
          { role: 'user', text: rendered, domTextContent },
          { role: 'assistant', text: 'FINAL', finalAction: true },
        ],
        generating: false,
      },
    ];
    const { readStableInput } = await import('./input.ts');
    vi.mocked(readStableInput).mockImplementationOnce(() => ({
      text: prompt,
      bytes: new Uint8Array([1]),
      byteLength: 1,
      dev: 1n,
      ino: 1n,
    }));
    const fake = makePage(snapshots);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'ok',
      cause: 'completed_page_only',
      send_count: 1,
      cleanup: 'confirmed',
    });
    expect(outcome.result.state).not.toBe('observation_uncertain');
  });

  it('uses post-send observation cadence instead of --poll-ms after the dispatch window', async () => {
    const fake = makePage(delayedReadySnapshots(65));
    const outcome = await runAndCapture(fake.page, { timeoutMs: '120000', pollMs: '300000' });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'ok',
      cause: 'completed_page_only',
      send_count: 1,
    });
    const slowPollWaitFloor = 300_000 + DISPATCH_OBSERVATION_MS - 5_000;
    expect(fake.metrics.waitedMs).toBeLessThan(slowPollWaitFloor);
    expect(fake.metrics.waitedMs).toBeGreaterThan(DISPATCH_OBSERVATION_MS);
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
        '--chat-url', 'https://chatgpt.com/c/existing', '--timeout-ms', '120000', '--poll-ms', '1',
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
    const turnResults = writes
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.schema === 'turn-result/v1');
    expect(turnResults).toHaveLength(3);
  });

  it('continues polling a reachable owned page past the soft timeout without resend', async () => {
    const fake = makePage(readySnapshots());
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5', pollMs: '5' });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'ok',
      cause: 'completed_page_only',
      send_count: 1,
      cleanup: 'confirmed',
    });
    expect(outcome.result.incidents).not.toContain('turn_timeout');
    expect(fake.metrics.waitedMs).toBeGreaterThanOrEqual(5);
    expect(fake.metrics.polls).toBeGreaterThanOrEqual(3);
    expect(fake.metrics.sends).toBe(1);
    expect(fake.metrics.closes).toBe(1);
  });

  it('does not depend on the retired publication state store for a page-complete reply', async () => {
    const fake = makePage(readySnapshots('FINAL'));
    const outcome = await runAndCapture(fake.page);

    expect(outcome.code).toBe(0);
    expect(outcome.result.state).toBe('ok');
    expect(mocks.legacyPublishReply).not.toHaveBeenCalled();
    expect(mocks.linkSync).toHaveBeenCalledTimes(1);
    expect(mocks.writeFileSync.mock.calls[0]?.[1]).toBe('FINAL');
  });

  it('returns a post-send product blocker after observing the owned prompt', async () => {
    const working: StateLightTestSnapshot = {
      messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'working' }],
      generating: true,
    };
    const fake = makePage([working, working], { wallText: 'quota wall', wallAfterPoll: 2 });
    const outcome = await runAndCapture(fake.page);

    expect(outcome.result).toMatchObject({
      state: 'quota',
      scope: 'invocation',
      cause: 'quota_detected',
      send_count: 1,
      cleanup: 'confirmed',
    });
    expect(outcome.result.incidents).toContain('invocation_blocker');
    expect(fake.metrics.polls).toBeGreaterThanOrEqual(2);
    expect(fake.metrics.sends).toBe(1);
    expect(fake.metrics.closes).toBe(1);
    expect(mocks.linkSync).not.toHaveBeenCalled();
  });

  it('does not publish a stable intermediate node while page-level tool activity is still in progress', async () => {
    const progress: StateLightTestMessage = { role: 'assistant', text: 'PROGRESS', inProgress: true };
    const final: StateLightTestMessage = { role: 'assistant', text: 'FINAL', finalAction: true };
    const fake = makePage([
      { messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, progress], generating: false },
      { messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, progress], generating: false },
      { messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, progress, final], generating: false },
      { messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, progress, final], generating: false },
    ]);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000' });

    expect(outcome.code).toBe(0);
    expect(outcome.result.state).toBe('ok');
    expect(fake.metrics.polls).toBeGreaterThanOrEqual(4);
    expect(fake.metrics.sends).toBe(1);
    expect(mocks.linkSync).toHaveBeenCalledTimes(1);
    expect(mocks.writeFileSync.mock.calls[0]?.[1]).toBe('FINAL');
  });

  it('does not terminally degrade when alternating truncated owned renderings share only the same cause', async () => {
    const longPrompt = `${'A'.repeat(120)} ${'detail '.repeat(40)}`;
    const truncA = `${'A'.repeat(20)}`;
    const truncB = `${'A'.repeat(19)}B`;
    const stableEcho = `${'A'.repeat(120)} ${'detail '.repeat(40)}`.trim();
    let sent = false;
    let polls = 0;
    const metrics = { sends: 0, closes: 0, polls: 0, waitedMs: 0 };

    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      fill: vi.fn(async () => undefined),
      press: vi.fn(async () => {
        sent = true;
        metrics.sends++;
      }),
    });
    const sendButton = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => {
        sent = true;
        metrics.sends++;
      }),
    });

    const page: any = {
      __fakeBrowserGptPage: true,
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => 'https://chatgpt.com/c/existing'),
      isClosed: vi.fn(() => false),
      waitForTimeout: vi.fn(async (ms: number) => {
        metrics.waitedMs += ms;
        mocks.nowMs += ms;
      }),
      close: vi.fn(async () => {
        metrics.closes++;
      }),
      getByText: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return sendButton;
        if (selector === MESSAGE_NODE_SELECTOR) {
          if (!sent) return collectionLocator(BASELINE);
          polls++;
          metrics.polls = polls;
          const echo = polls > 4 ? stableEcho : (polls % 2 === 1 ? truncA : truncB);
          return collectionLocator([
            ...BASELINE,
            { role: 'user', text: echo },
            { role: 'assistant', text: 'working' },
          ], polls <= 4);
        }
        if (selector.startsWith('xpath=ancestor-or-self::section')) {
          return scalarLocator({ count: vi.fn(async () => 0) });
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          return collectionLocator([{ role: 'assistant', text: 'working' }], true);
        }
        if (matchesStopButtonSelector(selector)) return scalarLocator();
        return scalarLocator();
      }),
    };

    const { readStableInput } = await import('./input.ts');
    vi.mocked(readStableInput).mockImplementationOnce(() => ({
      text: longPrompt,
      bytes: new Uint8Array([1]),
      byteLength: 1,
      dev: 1n,
      ino: 1n,
    }));
    const outcome = await runAndCapture(page, { timeoutMs: '5', pollMs: '1' });

    expect(outcome.result.send_count).toBe(1);
    expect(outcome.result.state).not.toBe('send_failed');
    expect(outcome.result).toMatchObject({
      state: 'observation_uncertain',
      cause: 'owned_prompt_not_observed',
    });
    expect(metrics.closes).toBe(1);
    expect(metrics.polls).toBeGreaterThanOrEqual(3);
  });

  it('completes a long prompt with different line breaking without false foreign_activity', async () => {
    const longPrompt = `Problem:\nFlow-manager misclassifies long prompts.\n\nGoal:\nVerify echo tolerance.\n${'detail '.repeat(120)}`;
    const renderedEcho = `Problem: Flow-manager misclassifies long prompts. Goal: Verify echo tolerance. ${'detail '.repeat(120)}`.trim();
    const snapshots: StateLightTestSnapshot[] = [
      {
        messages: [...BASELINE, { role: 'user', text: renderedEcho }, { role: 'assistant', text: 'working' }],
        generating: true,
      },
      {
        messages: [...BASELINE, { role: 'user', text: renderedEcho }, { role: 'assistant', text: 'FINAL', finalAction: true }],
        generating: false,
      },
      {
        messages: [...BASELINE, { role: 'user', text: renderedEcho }, { role: 'assistant', text: 'FINAL', finalAction: true }],
        generating: false,
      },
    ];
    const { readStableInput } = await import('./input.ts');
    vi.mocked(readStableInput).mockImplementationOnce(() => ({
      text: longPrompt,
      bytes: new Uint8Array([1]),
      byteLength: 1,
      dev: 1n,
      ino: 1n,
    }));
    const fake = makePage(snapshots);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000' });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.result.state).not.toBe('observation_uncertain');
    expect(mocks.writeFileSync.mock.calls[0]?.[1]).toBe('FINAL');
  });

  it('captures the owned reply window before a later foreign user turn', async () => {
    const interleavedSnapshot: StateLightTestSnapshot = {
      messages: [
        ...BASELINE,
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: 'OWNED ANSWER', finalAction: true },
        { role: 'user', text: 'FOREIGN' },
        { role: 'assistant', text: 'FOREIGN ANSWER', finalAction: true },
      ],
      generating: false,
    };
    const fake = makePage([interleavedSnapshot, interleavedSnapshot, interleavedSnapshot]);
    const outcome = await runAndCapture(fake.page);

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'ok',
      scope: 'none',
      send_count: 1,
      cleanup: 'confirmed',
    });
    expect(mocks.writeFileSync.mock.calls[0]?.[1]).toBe('OWNED ANSWER');
    expect(fake.metrics.sends).toBe(1);
    expect(fake.metrics.closes).toBe(1);
  });


  it('never publishes partial owned reply when a later foreign turn completed', async () => {
    const snapshot: StateLightTestSnapshot = {
      messages: [
        ...BASELINE,
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: 'PARTIAL' },
        { role: 'user', text: 'FOREIGN' },
        { role: 'assistant', text: 'FOREIGN COMPLETE', finalAction: true },
      ],
      generating: false,
    };
    const fake = makePage(Array.from({ length: 30 }, () => snapshot));
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5', pollMs: '1' });

    expect(outcome.result.state).toBe('observation_uncertain');
    expect(outcome.result.state).not.toBe('ok');
    expect(outcome.result.cause).toBe('foreign_user_after_owned_send');
    expect(mocks.linkSync).not.toHaveBeenCalled();
    expect(fake.metrics.closes).toBe(1);
  });

  it('closes the owned tab on observation_uncertain without touching sibling tabs', async () => {
    const foreignSnapshot: StateLightTestSnapshot = {
      messages: [
        ...BASELINE,
        { role: 'user', text: 'PROMPT' },
        { role: 'user', text: 'FOREIGN' },
        { role: 'assistant', text: 'FOREIGN ANSWER', finalAction: true },
      ],
      generating: true,
    };
    const fake = makePage(Array.from({ length: 30 }, () => foreignSnapshot));
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5', pollMs: '1' });

    expect(outcome.result).toMatchObject({
      state: 'observation_uncertain',
      cleanup: 'confirmed',
      send_count: 1,
    });
    expect(fake.metrics.closes).toBe(1);
    expect(outcome.result.conversation_id).toBe('https://chatgpt.com/c/existing');
  });

  it('returns observation_uncertain at the hard deadline for interleaved foreign activity', async () => {
    const foreignSnapshot: StateLightTestSnapshot = {
      messages: [
        ...BASELINE,
        { role: 'user', text: 'PROMPT' },
        { role: 'user', text: 'FOREIGN' },
        { role: 'assistant', text: 'FOREIGN ANSWER', finalAction: true },
      ],
      generating: true,
    };
    const fake = makePage(Array.from({ length: 30 }, () => foreignSnapshot));
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5', pollMs: '1' });

    expect(outcome.result).toMatchObject({
      state: 'observation_uncertain',
      scope: 'invocation',
      cause: 'foreign_user_after_owned_send',
      send_count: 1,
      cleanup: 'confirmed',
      observation_uncertainty_diagnostics: {
        cause: 'foreign_user_after_owned_send',
        send_count: 1,
        owned_prompt_seen: true,
        observed_user_heads: ['FOREIGN'],
      },
    });
    expect(fake.metrics.sends).toBe(1);
    expect(fake.metrics.closes).toBe(1);
    expect(mocks.linkSync).not.toHaveBeenCalled();
    const journal = mocks.appendFileSync.mock.calls.map((call) => String(call[1])).join('\n');
    expect(journal).toContain('interleaved_user_activity');
    expect(journal).toContain('observation_uncertainty');
  });

  it('keeps polling the same owned page after a transient post-send observation error', async () => {
    const fake = makePage(readySnapshots(), { transientReadErrors: 1 });
    const outcome = await runAndCapture(fake.page);

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'ok',
      cause: 'completed_page_only',
      send_count: 1,
      cleanup: 'confirmed',
    });
    expect(outcome.result.incidents).toContain('post_send_observation_error');
    expect(fake.metrics.sends).toBe(1);
    expect(fake.metrics.closes).toBe(1);
    expect(mocks.linkSync).toHaveBeenCalledTimes(1);
    const journal = mocks.appendFileSync.mock.calls.map((call) => String(call[1])).join('\n');
    expect(journal).toContain('continue_polling_owned_page');
    expect(journal).not.toContain('caller_may_open_fresh_chat');
  });

  it('reports page loss after send without sending a replacement request', async () => {
    const fake = makePage([], { throwAfterSend: true });
    const outcome = await runAndCapture(fake.page);

    expect(outcome.result).toMatchObject({
      state: 'driver_error',
      scope: 'invocation',
      cause: 'page_or_browser_lost_after_send',
      send_count: 1,
      cleanup: 'confirmed',
    });
    expect(outcome.result.incidents).toContain('helper_failure_after_send');
    expect(fake.metrics.sends).toBe(1);
    expect(fake.metrics.closes).toBe(1);
  });


  it('returns observation_exhausted_no_resend only after the hard exhaustion deadline while waiting', async () => {
    const waiting: StateLightTestSnapshot = {
      messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'working' }],
      generating: true,
    };
    const fake = makePage(Array.from({ length: 20 }, () => waiting));
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });

    expect(outcome.result).toMatchObject({
      state: 'no_reply',
      scope: 'invocation',
      cause: 'observation_exhausted_no_resend',
      send_count: 1,
    });
    expect(outcome.result.incidents).toContain('observation_exhausted');
    expect(fake.metrics.waitedMs).toBeGreaterThan(20);
    expect(fake.metrics.sends).toBe(1);
    expect(fake.metrics.closes).toBe(0);
    expect(mocks.linkSync).not.toHaveBeenCalled();
  });


  it('detects completion when turn action buttons live in the conversation-turn container', async () => {
    const snapshots: StateLightTestSnapshot[] = [
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'working' }],
        generating: true,
      },
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, {
          role: 'assistant',
          text: 'FINAL',
          finalAction: true,
          finalActionInTurnContainer: true,
        }],
        generating: false,
      },
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, {
          role: 'assistant',
          text: 'FINAL',
          finalAction: true,
          finalActionInTurnContainer: true,
        }],
        generating: false,
      },
    ];
    const fake = makePage(snapshots);
    const outcome = await runAndCapture(fake.page);

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'ok',
      cause: 'completed_page_only',
      send_count: 1,
    });
    expect(mocks.writeFileSync.mock.calls[0]?.[1]).toBe('FINAL');
  });

  it('does not classify a collapsed long prompt echo as foreign activity', async () => {
    const longPrompt = `${'A'.repeat(120)} ${'detail '.repeat(40)}`;
    const renderedEcho = longPrompt;
    const snapshots: StateLightTestSnapshot[] = [
      {
        messages: [...BASELINE, { role: 'user', text: renderedEcho }, { role: 'assistant', text: 'working' }],
        generating: true,
      },
      {
        messages: [...BASELINE, { role: 'user', text: renderedEcho }, { role: 'assistant', text: 'FINAL', finalAction: true }],
        generating: false,
      },
      {
        messages: [...BASELINE, { role: 'user', text: renderedEcho }, { role: 'assistant', text: 'FINAL', finalAction: true }],
        generating: false,
      },
    ];
    const { readStableInput } = await import('./input.ts');
    vi.mocked(readStableInput).mockImplementationOnce(() => ({
      text: longPrompt,
      bytes: new Uint8Array([1]),
      byteLength: 1,
      dev: 1n,
      ino: 1n,
    }));
    const fake = makePage(snapshots);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000' });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'ok',
      send_count: 1,
    });
    expect(outcome.result.state).not.toBe('observation_uncertain');
    expect(mocks.writeFileSync.mock.calls[0]?.[1]).toBe('FINAL');
  });

  it('does not classify a transient duplicate owned user render as foreign activity', async () => {
    const snapshots: StateLightTestSnapshot[] = [
      {
        messages: [
          ...BASELINE,
          { role: 'user', text: 'PROMPT' },
          { role: 'user', text: 'PROMPT' },
          { role: 'assistant', text: 'working' },
        ],
        generating: true,
      },
      {
        messages: [
          ...BASELINE,
          { role: 'user', text: 'PROMPT' },
          { role: 'assistant', text: 'FINAL', finalAction: true },
        ],
        generating: false,
      },
      {
        messages: [
          ...BASELINE,
          { role: 'user', text: 'PROMPT' },
          { role: 'assistant', text: 'FINAL', finalAction: true },
        ],
        generating: false,
      },
    ];
    const fake = makePage(snapshots);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000' });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'ok',
      send_count: 1,
    });
    expect(outcome.result.state).not.toBe('observation_uncertain');
  });

  it('never emits send_failed once send_count is at least one', async () => {
    const waiting: StateLightTestSnapshot = {
      messages: BASELINE,
      generating: false,
    };
    const fake = makePage([waiting, waiting, waiting]);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5', pollMs: '1' });

    expect(outcome.result.send_count).toBeGreaterThanOrEqual(1);
    expect(outcome.result.state).not.toBe('send_failed');
    expect(outcome.result).toMatchObject({
      state: 'observation_uncertain',
      cause: 'owned_prompt_not_observed',
    });
  });


  it('exhausts ready-unstable observation with diagnostics instead of observing forever', async () => {
    const unstableSnapshots: StateLightTestSnapshot[] = Array.from({ length: 40 }, (_, index) => ({
      messages: [
        ...BASELINE,
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: `PARTIAL-${index}`, finalAction: true },
      ],
      generating: false,
    }));
    const fake = makePage(unstableSnapshots);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5', pollMs: '1' });

    expect(outcome.result.send_count).toBe(1);
    expect(outcome.result.state).toBe('no_reply');
    expect(outcome.result.state).not.toBe('send_failed');
    expect(outcome.result).toMatchObject({
      cause: 'observation_exhausted_no_resend',
      observation_exhausted_diagnostics: {
        observation_state: 'ready_unstable',
        stable_reads: 1,
        poll_count: expect.any(Number),
        soft_deadline_elapsed: true,
      },
    });
    expect(outcome.result.observation_exhausted_diagnostics?.last_assistant_head).toContain('PARTIAL');
    expect(fake.metrics.closes).toBe(0);
    expect(mocks.linkSync).not.toHaveBeenCalled();
  });

  it('exhausts oscillating uncertain reads with observation_uncertain at the hard deadline', async () => {
    const foreignA: StateLightTestSnapshot = {
      messages: [
        ...BASELINE,
        { role: 'user', text: 'PROMPT' },
        { role: 'user', text: 'FOREIGN-A' },
        { role: 'assistant', text: 'partial' },
      ],
      generating: true,
    };
    const foreignB: StateLightTestSnapshot = {
      messages: [
        ...BASELINE,
        { role: 'user', text: 'PROMPT' },
        { role: 'user', text: 'FOREIGN-B' },
        { role: 'assistant', text: 'partial' },
      ],
      generating: true,
    };
    const oscillating = Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? foreignA : foreignB));
    const fake = makePage(oscillating);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5', pollMs: '1' });

    expect(outcome.result.send_count).toBe(1);
    expect(outcome.result.state).toBe('observation_uncertain');
    expect(outcome.result.state).not.toBe('send_failed');
    expect(outcome.result).toMatchObject({
      cause: 'foreign_user_after_owned_send',
      observation_uncertainty_diagnostics: {
        cause: 'foreign_user_after_owned_send',
        send_count: 1,
        owned_prompt_seen: true,
      },
    });
    expect(fake.metrics.closes).toBe(1);
  });

  it('emits observation heartbeats during persistent uncertain polling', async () => {
    const foreignA: StateLightTestSnapshot = {
      messages: [
        ...BASELINE,
        { role: 'user', text: 'PROMPT' },
        { role: 'user', text: 'FOREIGN-A' },
        { role: 'assistant', text: 'partial' },
      ],
      generating: true,
    };
    const foreignB: StateLightTestSnapshot = {
      messages: [
        ...BASELINE,
        { role: 'user', text: 'PROMPT' },
        { role: 'user', text: 'FOREIGN-B' },
        { role: 'assistant', text: 'partial' },
      ],
      generating: true,
    };
    const oscillating = Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? foreignA : foreignB));
    const fake = makePage(oscillating);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      enqueueBrowserForTurn(mocks, fake.page);
      const code = await runStateLightTurn([
        ...STATE_LIGHT_TURN_BASE_ARGV,
        '--output', '/tmp/reply.txt',
        '--chat-url', 'https://chatgpt.com/c/existing',
        '--timeout-ms', '5000',
        '--poll-ms', '1',
      ]);
      expect(code).toBe(11);
      const heartbeats = writes
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row) => row.schema === 'observation-heartbeat/v1');
      expect(heartbeats.length).toBeGreaterThanOrEqual(2);
      expect(heartbeats.some((row) => row.observation_state === 'uncertain')).toBe(true);
      expect(heartbeats.every((row) => row.poll_count >= 2)).toBe(true);
    } finally {
      stdout.mockRestore();
    }
  });

  it('stabilizes a long reply when successive reads differ only by render artifacts', async () => {
    const body = `${'detail '.repeat(60)} Section footer with enough words.`;
    const renderA = `Intro paragraph.\n\n${body}`;
    const renderB = `Intro paragraph. ${body} show more`;
    const snapshots: StateLightTestSnapshot[] = [
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'working' }],
        generating: true,
      },
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: renderA, finalAction: true }],
        generating: false,
      },
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: renderB, finalAction: true }],
        generating: false,
      },
    ];
    const fake = makePage(snapshots);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000' });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    const published = String(mocks.writeFileSync.mock.calls[0]?.[1] ?? '');
    expect(published).toContain('Section footer with enough words.');
    expect(published).toContain('Intro paragraph.');
  });



  it('captures the fullest read when completion-ready polls differ by a large collapsed mid-body', async () => {
    const head = `INTRO ${'A'.repeat(180)}`;
    const tail = `${'Z'.repeat(180)} OUTRO`;
    const longRead = `${head}${'M'.repeat(4500)}${tail}`;
    const shortRead = `${head}${'M'.repeat(200)}${tail}`;
    const snapshots: StateLightTestSnapshot[] = [
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'working' }],
        generating: true,
      },
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: longRead, finalAction: true }],
        generating: false,
      },
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: shortRead, finalAction: true }],
        generating: false,
      },
    ];
    const fake = makePage(snapshots);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(String(mocks.writeFileSync.mock.calls[0]?.[1] ?? '')).toBe(longRead);
    expect(String(mocks.writeFileSync.mock.calls[0]?.[1] ?? '').length).toBeGreaterThan(shortRead.length);
  });

  it('captures ok when reply prose contains continue generating but no control exists', async () => {
    const body = 'Design note: never treat message prose mentioning continue generating as a control click target.';
    const snapshots: StateLightTestSnapshot[] = [
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'working' }],
        generating: true,
      },
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: body, finalAction: true }],
        generating: false,
      },
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: body, finalAction: true }],
        generating: false,
      },
    ];
    const fake = makePage(snapshots);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(fake.metrics.continuationClicks).toBe(0);
    expect(mocks.writeFileSync.mock.calls[0]?.[1]).toContain('continue generating');
  });

  it('activates a genuine continue-generating button control when present', async () => {
    const snapshots: StateLightTestSnapshot[] = [
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'PARTIAL' }],
        generating: true,
        continuation: true,
      },
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'PARTIAL' }],
        generating: true,
        continuation: true,
      },
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'FINAL', finalAction: true }],
        generating: false,
      },
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'FINAL', finalAction: true }],
        generating: false,
      },
    ];
    const fake = makePage(snapshots);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(fake.metrics.continuationClicks).toBeGreaterThanOrEqual(1);
    expect(mocks.writeFileSync.mock.calls[0]?.[1]).toBe('FINAL');
  });

  it('does not terminalize waiting at the soft deadline alone', async () => {
    const waiting: StateLightTestSnapshot = {
      messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'working' }],
      generating: true,
    };
    const fake = makePage(Array.from({ length: 30 }, () => waiting));
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });

    expect(outcome.result).toMatchObject({
      state: 'no_reply',
      cause: 'observation_exhausted_no_resend',
      send_count: 1,
    });
    expect(fake.metrics.waitedMs).toBeGreaterThan(20);
    expect(fake.metrics.closes).toBe(0);
  });

  it('exhausts after repeated transient post-send read errors at the hard deadline', async () => {
    const fake = makePage(readySnapshots(), { transientReadErrors: 'always' });
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });

    expect(outcome.result).toMatchObject({
      state: 'no_reply',
      cause: 'observation_exhausted_no_resend',
      send_count: 1,
    });
    expect(outcome.result.incidents).toContain('post_send_observation_error');
    expect(outcome.result.incidents).toContain('observation_exhausted');
    expect(outcome.result.poll_count).toBeGreaterThanOrEqual(2);
    expect(fake.metrics.closes).toBe(0);
    expect(mocks.linkSync).not.toHaveBeenCalled();
  });

  it('chat-url continuation finds owned prompt inside a late baseline capture', async () => {
    const continuationPre: StateLightTestMessage[] = [
      { role: 'user', text: 'USER-ONE' },
      { role: 'assistant', text: 'ANSWER-ONE', finalAction: true },
      { role: 'user', text: 'USER-TWO' },
      { role: 'assistant', text: 'ANSWER-TWO', finalAction: true },
      { role: 'user', text: 'PROMPT' },
    ];
    const ready: StateLightTestSnapshot = {
      messages: [...continuationPre, { role: 'assistant', text: 'FINAL', finalAction: true }],
      generating: false,
    };
    const fake = makePage([
      { messages: [...continuationPre, { role: 'assistant', text: 'working' }], generating: true },
      ready,
      ready,
    ], { preSendMessages: continuationPre });
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'ok',
      cause: 'completed_page_only',
      send_count: 1,
      cleanup: 'confirmed',
    });
    expect(outcome.result.state).not.toBe('observation_uncertain');
    expect((outcome.result.incidents ?? []).filter((entry) => entry === 'send_observation_deferred')).toHaveLength(0);
  });

  it('chat-url defers owned_user_message_not_observed after send without send_failed', async () => {
    const delayedUser: StateLightTestSnapshot = {
      messages: [...BASELINE],
      generating: false,
    };
    const ready: StateLightTestSnapshot = {
      messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'FINAL', finalAction: true }],
      generating: false,
    };
    const fake = makePage([
      ...Array.from({ length: 8 }, () => delayedUser),
      ready,
      ready,
    ]);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.result.state).not.toBe('send_failed');
    expect(outcome.result.incidents).toContain('send_observation_deferred');
    expect((outcome.result.incidents ?? []).filter((entry) => entry === 'send_observation_deferred')).toHaveLength(1);
    const deferredJournalRows = mocks.appendFileSync.mock.calls.filter((call) => String(call[1]).includes('send_observation_deferred'));
    expect(deferredJournalRows).toHaveLength(1);
    expect(fake.metrics.polls).toBeGreaterThan(3);
  });


  it('finds owned prompt in a long transcript when mid-list node reads intermittently throw', async () => {
    const history: StateLightTestMessage[] = [
      { role: 'user', text: 'USER-ONE' },
      { role: 'assistant', text: 'ANSWER-ONE', finalAction: true },
      { role: 'user', text: 'USER-TWO' },
      { role: 'assistant', text: 'ANSWER-TWO', finalAction: true },
      { role: 'user', text: 'USER-THREE' },
      { role: 'assistant', text: 'ANSWER-THREE', finalAction: true },
      { role: 'user', text: 'PROMPT' },
    ];
    const ready: StateLightTestSnapshot = {
      messages: [...history, { role: 'assistant', text: 'FINAL', finalAction: true, finalActionInTurnContainer: true }],
      generating: false,
    };
    const fake = makePage([ready, ready, ready], {
      preSendMessages: history,
      failMessageReadAt: (index, poll) => index === 2 && poll % 2 === 0,
    });
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.result.incidents).not.toContain('send_observation_deferred');
    expect(mocks.writeFileSync.mock.calls[0]?.[1]).toBe('FINAL');
  });

  it('captures a static complete reply when confirm reads intermittently throw on the assistant node', async () => {
    const reply = `STATIC ${'X'.repeat(8000)} END`;
    const snapshots: StateLightTestSnapshot[] = [
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: reply, finalAction: true, finalActionInTurnContainer: true }],
        generating: false,
      },
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: reply, finalAction: true, finalActionInTurnContainer: true }],
        generating: false,
      },
      {
        messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: reply, finalAction: true, finalActionInTurnContainer: true }],
        generating: false,
      },
    ];
    const assistantIndex = 3;
    const fake = makePage(snapshots, {
      failMessageReadAt: (index, poll) => index === assistantIndex && poll % 2 === 1,
    });
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(String(mocks.writeFileSync.mock.calls[0]?.[1] ?? '')).toBe(reply);
  });

  it('emits observation heartbeats during post-send polling', async () => {
    const fake = makePage(delayedReadySnapshots(4));
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      enqueueBrowserForTurn(mocks, fake.page);
      const code = await runStateLightTurn([
        ...STATE_LIGHT_TURN_BASE_ARGV,
        '--output', '/tmp/reply.txt',
        '--chat-url', 'https://chatgpt.com/c/existing',
        '--timeout-ms', '5000',
        '--poll-ms', '1',
      ]);
      expect(code).toBe(0);
      const heartbeats = writes
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row) => row.schema === 'observation-heartbeat/v1');
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);
      expect(heartbeats[0]).toMatchObject({
        schema: 'observation-heartbeat/v1',
        poll_count: expect.any(Number),
        observation_state: expect.any(String),
        stable_reads: expect.any(Number),
        completion_ready: expect.any(Boolean),
        last_reply_length: expect.any(Number),
        last_reply_sha256_head: expect.any(String),
      });
    } finally {
      stdout.mockRestore();
    }
  });

  it('does not report owned_prompt_not_observed when product-status probes throw after send', async () => {
    const fake = makePage(readySnapshots(), { blockProductStatus: true });
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(outcome.result.incidents).not.toContain('send_observation_deferred');
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


describe('browser-turn recurrence journal fixture coverage', () => {
  it('maps every recorded journal symptom to a deterministic replay kind', () => {
    for (const entry of journalSymptoms) {
      expect(BROWSER_TURN_RECURRENCE_REPLAY_KINDS[entry.id as keyof typeof BROWSER_TURN_RECURRENCE_REPLAY_KINDS]).toBeTruthy();
    }
    expect(Object.keys(BROWSER_TURN_RECURRENCE_REPLAY_KINDS)).toHaveLength(journalSymptoms.length);
  });

  it('replays interleaved-user journal symptoms without resend licensing', async () => {
    const foreignSnapshot: StateLightTestSnapshot = {
      messages: [
        ...BASELINE,
        { role: 'user', text: 'PROMPT' },
        { role: 'user', text: 'FOREIGN' },
        { role: 'assistant', text: 'FOREIGN ANSWER', finalAction: true },
      ],
      generating: true,
    };
    const fake = makePage(Array.from({ length: 30 }, () => foreignSnapshot));
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5', pollMs: '1' });
    expect(outcome.result.state).toBe('observation_uncertain');
    expect(outcome.result.send_count).toBe(1);
    expect(outcome.result.state).not.toBe('send_failed');
  });

  it('replays observation_exhausted journal symptoms at the hard deadline', async () => {
    const waiting: StateLightTestSnapshot = {
      messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'working' }],
      generating: true,
    };
    const fake = makePage(Array.from({ length: 20 }, () => waiting));
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });
    expect(outcome.result).toMatchObject({
      state: 'no_reply',
      cause: 'observation_exhausted_no_resend',
      send_count: 1,
    });
    expect(outcome.result.incidents).toContain('observation_exhausted');
  });

  it('replays helper_failure_after_send journal symptoms', async () => {
    const fake = makePage([], { throwAfterSend: true });
    const outcome = await runAndCapture(fake.page);
    expect(outcome.result).toMatchObject({
      state: 'driver_error',
      cause: 'page_or_browser_lost_after_send',
      send_count: 1,
    });
    expect(outcome.result.incidents).toContain('helper_failure_after_send');
  });

  it('replays post-send read-error journal symptoms through hard exhaustion', async () => {
    const fake = makePage(readySnapshots(), { transientReadErrors: 'always' });
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });
    expect(outcome.result.incidents).toContain('post_send_observation_error');
    expect(outcome.result).toMatchObject({
      state: 'no_reply',
      cause: 'observation_exhausted_no_resend',
    });
  });

  it('replays send_observation_deferred chat-url symptoms without send_failed', async () => {
    const delayedUser: StateLightTestSnapshot = {
      messages: [...BASELINE],
      generating: false,
    };
    const ready: StateLightTestSnapshot = {
      messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'FINAL', finalAction: true }],
      generating: false,
    };
    const fake = makePage([
      ...Array.from({ length: 8 }, () => delayedUser),
      ready,
      ready,
    ]);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });
    expect(outcome.result.state).toBe('ok');
    expect(outcome.result.incidents).toContain('send_observation_deferred');
    expect(outcome.result.state).not.toBe('send_failed');
  });

  it('replays send_count guard symptoms by never emitting send_failed after send', async () => {
    const waiting: StateLightTestSnapshot = { messages: BASELINE, generating: false };
    const fake = makePage(Array.from({ length: 20 }, () => waiting));
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });
    expect(outcome.result.send_count).toBeGreaterThanOrEqual(1);
    expect(outcome.result.state).not.toBe('send_failed');
  });

  it('replays chrome_not_running invocation_blocker symptoms', async () => {
    mocks.verifyProfile.mockResolvedValueOnce({
      state: 'unavailable',
      cause: 'chrome_not_running',
      evidence: 'cdp_unreachable',
    });
    const fake = makePage(readySnapshots());
    const outcome = await runAndCapture(fake.page);
    expect(outcome.result).toMatchObject({
      state: 'chrome_not_running',
      cause: 'chrome_not_running',
      send_count: 0,
    });
    expect(outcome.result.incidents).toContain('invocation_blocker');
  });

  it('replays profile_mismatch invocation_blocker symptoms', async () => {
    mocks.verifyProfile.mockResolvedValueOnce({
      state: 'mismatch',
      cause: 'profile_mismatch',
      evidence: 'profile mismatch',
    });
    const fake = makePage(readySnapshots());
    const outcome = await runAndCapture(fake.page);
    expect(outcome.result).toMatchObject({
      state: 'profile_mismatch',
      cause: 'profile_mismatch',
      send_count: 0,
    });
    expect(outcome.result.incidents).toContain('invocation_blocker');
  });

  it('replays composer_unavailable invocation_blocker symptoms', async () => {
    const fake = makePage(readySnapshots());
    const composer = scalarLocator({ count: vi.fn(async () => 0) });
    const originalLocator = fake.page.locator;
    fake.page.locator = vi.fn((selector: string) => {
      if (selector === COMPOSER_SELECTOR) return composer;
      return originalLocator(selector);
    });
    const outcome = await runAndCapture(fake.page, { timeoutMs: '10', pollMs: '1' });
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'composer_unavailable',
      send_count: 0,
    });
    expect(outcome.result.incidents).toContain('invocation_blocker');
  });

  it('replays conversation_redirect helper_failure_before_send symptoms', async () => {
    const page: any = {
      __fakeBrowserGptPage: true,
      goto: vi.fn(async () => {
        throw new Error('ui_contract_mismatch:conversation_redirect');
      }),
      url: vi.fn(() => 'https://chatgpt.com/c/existing'),
      isClosed: vi.fn(() => false),
      waitForTimeout: vi.fn(async (ms: number) => { mocks.nowMs += ms; }),
      close: vi.fn(async () => undefined),
      getByRole: vi.fn(() => scalarLocator()),
      getByText: vi.fn(() => scalarLocator()),
      locator: vi.fn(() => scalarLocator({ count: vi.fn(async () => 0) })),
    };
    enqueueBrowserForTurn(mocks, page);
    const outcome = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--output', '/tmp/reply.txt',
      '--chat-url', 'https://chatgpt.com/c/existing',
      '--timeout-ms', '1000',
      '--poll-ms', '1',
    ]);
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'ui_contract_mismatch:conversation_redirect',
      send_count: 0,
    });
    expect(outcome.result.incidents).toContain('helper_failure_before_send');
  });

  it('fails chat-url continuation before send when landed conversation uuid mismatches target', async () => {
    const target = 'https://chatgpt.com/g/g-p-test-project/c/6a6c32b2-51a0-83ec-9fe6-521e171ba785';
    const landed = 'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111';
    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      fill: vi.fn(async () => undefined),
      press: vi.fn(async () => undefined),
    });
    const page: any = {
      __fakeBrowserGptPage: true,
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => landed),
      isClosed: vi.fn(() => false),
      waitForTimeout: vi.fn(async (ms: number) => { mocks.nowMs += ms; }),
      close: vi.fn(async () => undefined),
      getByRole: vi.fn(() => scalarLocator()),
      getByText: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return scalarLocator({ count: vi.fn(async () => 0) });
        if (selector === MESSAGE_NODE_SELECTOR) return collectionLocator(BASELINE);
        return scalarLocator();
      }),
    };
    enqueueBrowserForTurn(mocks, page);
    const outcome = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--output', '/tmp/reply.txt',
      '--chat-url', target,
      '--timeout-ms', '1000',
      '--poll-ms', '1',
    ]);
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'ui_contract_mismatch:conversation_redirect',
      send_count: 0,
    });
    expect(outcome.result.incidents).toContain('helper_failure_before_send');
    expect(composer.press).not.toHaveBeenCalled();
  });

  it('fails chat-url observation when page conversation uuid drifts away from target', async () => {
    const target = 'https://chatgpt.com/c/6a6c32b2-51a0-83ec-9fe6-521e171ba785';
    const drifted = 'https://chatgpt.com/c/22222222-2222-2222-2222-222222222222';
    let sent = false;
    const staleWrongRender: StateLightTestSnapshot = {
      messages: [...BASELINE, { role: 'assistant', text: 'foreign answer', finalAction: true, finalActionInTurnContainer: true }],
      generating: false,
    };
    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      fill: vi.fn(async () => undefined),
      press: vi.fn(async () => { sent = true; }),
    });
    const page: any = {
      __fakeBrowserGptPage: true,
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => (sent ? drifted : target)),
      isClosed: vi.fn(() => false),
      waitForTimeout: vi.fn(async (ms: number) => { mocks.nowMs += ms; }),
      close: vi.fn(async () => undefined),
      getByRole: vi.fn(() => scalarLocator()),
      getByText: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return scalarLocator({ count: vi.fn(async () => 0) });
        if (selector === MESSAGE_NODE_SELECTOR) {
          if (!sent) return collectionLocator(BASELINE);
          return collectionLocatorWithReadFailures(staleWrongRender.messages, staleWrongRender.generating, 0);
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          return messageLocator(staleWrongRender.messages.at(-1)!, false);
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          return collectionLocator(staleWrongRender.messages.filter((message) => message.role === 'assistant'));
        }
        return scalarLocator();
      }),
    };
    enqueueBrowserForTurn(mocks, page);
    const outcome = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--output', '/tmp/reply.txt',
      '--chat-url', target,
      '--timeout-ms', '3000',
      '--poll-ms', '1',
    ]);
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'owned_conversation_identity_mismatch',
      send_count: 1,
    });
    expect(outcome.result.incidents).toContain('conversation_identity_mismatch');
    expect(outcome.result.state).not.toBe('no_reply');
  });

  it('fails chat-url observation when completion is ready but owned prompt never appears on the page', async () => {
    const target = 'https://chatgpt.com/g/g-p-test-project/c/6a6c32b2-51a0-83ec-9fe6-521e171ba785';
    const staleWrongRender: StateLightTestSnapshot = {
      messages: [...BASELINE, { role: 'assistant', text: 'foreign answer', finalAction: true, finalActionInTurnContainer: true }],
      generating: false,
    };
    const fake = makePage(Array.from({ length: 30 }, () => staleWrongRender), {
      pageUrl: target,
    });
    enqueueBrowserForTurn(mocks, fake.page);
    const outcome = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--output', '/tmp/reply.txt',
      '--chat-url', target,
      '--timeout-ms', '3000',
      '--poll-ms', '1',
    ]);
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'owned_conversation_render_mismatch',
      send_count: 1,
    });
    expect(outcome.result.incidents).toContain('conversation_render_mismatch');
    expect(outcome.result.state).not.toBe('no_reply');
    expect(fake.metrics.polls).toBeLessThan(20);
    expect(outcome.result.cleanup).toBe('confirmed');
    expect(mocks.releaseBrowser).toHaveBeenCalled();
    expect(fake.metrics.closes).toBe(1);
  });

  it('replays rate_limit invocation_blocker symptoms', async () => {
    const working: StateLightTestSnapshot = {
      messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'working' }],
      generating: true,
    };
    const fake = makePage(Array.from({ length: 6 }, () => working), {
      wallText: 'temporarily limited',
      wallAfterPoll: 1,
    });
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5000', pollMs: '1' });
    expect(outcome.result).toMatchObject({
      state: 'rate_limit',
      cause: 'rate_limit_detected',
      send_count: 1,
    });
    expect(outcome.result.incidents).toContain('invocation_blocker');
  });

  it('replays helper_failure_before_send argument symptoms', async () => {
    const captured = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      '--profile', '/tmp/profile',
      '--cdp', 'http://127.0.0.1:9222',
      '--input', '/tmp/prompt.txt',
      '--output', '/tmp/reply.txt',
      '--chat-url', 'https://chatgpt.com/c/existing',
      '--timeout-ms', 'not-a-number',
    ]);
    expect(captured.result.state).toBe('driver_error');
    expect(captured.result.incidents).toContain('helper_failure_before_send');
  });

  it('replays helper_failure_before_send argument_mode_invalid symptoms', async () => {
    const captured = await runStateLightTurnWithStdoutCapture(runStateLightTurn, [
      '--profile', '/tmp/profile',
      '--cdp', 'http://127.0.0.1:9222',
      '--input', '/tmp/prompt.txt',
      '--output', '/tmp/reply.txt',
      '--new-chat',
      '--chat-url', 'https://chatgpt.com/c/existing',
      '--project-url', 'https://chatgpt.com/g/project',
      '--timeout-ms', '1000',
    ]);
    expect(captured.result.state).toBe('driver_error');
    expect(captured.result.cause).toBe('argument_mode_invalid');
    expect(captured.result.incidents).toContain('helper_failure_before_send');
  });

  it('replays legacy admission journal symptoms as state-light absence', async () => {
    const fake = makePage(readySnapshots());
    const outcome = await runAndCapture(fake.page);
    const journal = mocks.appendFileSync.mock.calls.map((call) => String(call[1])).join('\n');
    expect(outcome.result.state).toBe('ok');
    expect(journal).not.toContain('possible_delivery');
    expect(journal).not.toContain('profile_busy');
    expect(journal).not.toMatch(/conversation_busy|claim|slot_busy/);
  });

  it('links send_observation_deferred fresh URL journal symptoms to the fresh-conversation fixture replay', () => {
    const freshUrlEntries = journalSymptoms.filter((entry) =>
      BROWSER_TURN_RECURRENCE_REPLAY_KINDS[entry.id as keyof typeof BROWSER_TURN_RECURRENCE_REPLAY_KINDS]
        === 'state_light_send_observation_deferred_fresh_url',
    );
    expect(freshUrlEntries.map((entry) => entry.observed_symptom)).toEqual(
      expect.arrayContaining(['fresh_conversation_url_not_observed']),
    );
    expect(freshUrlEntries.length).toBeGreaterThanOrEqual(2);
  });

  it('records legacy harness-only journal symptoms outside the state-light turn surface', () => {
    const legacyKinds = new Set(
      journalSymptoms
        .filter((entry) => ['legacy_harness_note', 'legacy_admission_absence'].includes(
          BROWSER_TURN_RECURRENCE_REPLAY_KINDS[entry.id as keyof typeof BROWSER_TURN_RECURRENCE_REPLAY_KINDS],
        ))
        .map((entry) => entry.id),
    );
    expect(legacyKinds.size).toBeGreaterThan(0);
  });
});

describe('Issue #1386 dead-turn transport evidence', () => {
  type GenerationEvidence = boolean | 'unknown';
  type EvidenceFrame = {
    readonly generationInProgress: GenerationEvidence;
    readonly assistant?: StateLightTestMessage;
  };

  function atomicCollection(messages: StateLightTestMessage[], generationInProgress: GenerationEvidence) {
    const legacy = collectionLocator(messages, generationInProgress === true);
    const elements = messages.map((message, index) => ({
      getAttribute: (name: string) => {
        if (name === 'data-message-author-role') return message.role;
        if (name === 'data-message-id') return `${message.role}-${index}-12345678`;
        return null;
      },
      querySelectorAll: () => [],
      innerText: message.text,
    }));
    return scalarLocator({
      count: legacy.count,
      nth: legacy.nth,
      evaluateAll: vi.fn(async (
        callback: (items: Element[], args: unknown) => unknown,
        args: unknown,
      ) => {
        const priorDocument = (globalThis as { document?: unknown }).document;
        (globalThis as { document?: unknown }).document = {
          querySelector: vi.fn(() => {
            if (generationInProgress === 'unknown') throw new Error('generation read failed');
            return generationInProgress ? {} : null;
          }),
        };
        try {
          return callback(elements as unknown as Element[], args);
        } finally {
          if (priorDocument === undefined) delete (globalThis as { document?: unknown }).document;
          else (globalThis as { document?: unknown }).document = priorDocument;
        }
      }),
    });
  }

  function makeEvidencePage(
    frames: readonly EvidenceFrame[],
    preSendMessages: readonly StateLightTestMessage[] = [],
  ) {
    let sent = false;
    let filled = '';
    let frameIndex = 0;
    let activeMessages = [...preSendMessages];
    let activeGeneration: GenerationEvidence = false;
    let closed = false;
    const metrics = {
      sends: 0,
      closes: 0,
      polls: 0,
      waitedMs: 0,
      continuationClicks: 0,
    };

    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      fill: vi.fn(async (value: string) => { filled = value; }),
      press: vi.fn(async (key: string) => {
        if (key !== 'Enter') throw new Error(`unexpected key: ${key}`);
        sent = true;
        metrics.sends += 1;
      }),
    });
    const sendButton = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => {
        sent = true;
        metrics.sends += 1;
      }),
    });

    const page: any = {
      __fakeBrowserGptPage: true,
      __productStatusText: () => '',
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => 'https://chatgpt.com/c/existing'),
      isClosed: vi.fn(() => closed),
      waitForTimeout: vi.fn(async (ms: number) => {
        metrics.waitedMs += ms;
        mocks.nowMs += ms;
      }),
      close: vi.fn(async () => {
        closed = true;
        metrics.closes += 1;
      }),
      getByRole: vi.fn(() => scalarLocator({
        count: vi.fn(async () => 0),
        click: vi.fn(async () => { metrics.continuationClicks += 1; }),
      })),
      getByText: vi.fn(() => scalarLocator({
        count: vi.fn(async () => 0),
        click: vi.fn(async () => { metrics.continuationClicks += 1; }),
      })),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return sendButton;
        if (selector === MESSAGE_NODE_SELECTOR) {
          if (!sent) {
            activeMessages = [...preSendMessages];
            activeGeneration = false;
            return atomicCollection(activeMessages, activeGeneration);
          }
          const frame = frames[Math.min(frameIndex, Math.max(0, frames.length - 1))]
            ?? { generationInProgress: false };
          frameIndex += 1;
          metrics.polls += 1;
          activeGeneration = frame.generationInProgress;
          activeMessages = [
            ...preSendMessages,
            { role: 'user', text: filled },
            ...(frame.assistant ? [frame.assistant] : []),
          ];
          return atomicCollection(activeMessages, activeGeneration);
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          const last = activeMessages.filter((message) => message.role === 'assistant').at(-1);
          if (!last?.finalActionInTurnContainer) return scalarLocator({ count: vi.fn(async () => 0) });
          return messageLocator(last, activeGeneration === true);
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          return collectionLocator(
            activeMessages.filter((message) => message.role === 'assistant'),
            activeGeneration === true,
          );
        }
        if (matchesStopButtonSelector(selector)) return scalarLocator();
        return scalarLocator();
      }),
    };

    return { page, metrics };
  }

  it('returns dead_turn_page_evidence after two eligible dead observations with one send and no extra actuation', async () => {
    const fake = makeEvidencePage([
      { generationInProgress: false },
      { generationInProgress: false },
      { generationInProgress: false },
    ]);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '1', pollMs: '1' });

    expect(outcome.result).toMatchObject({
      state: 'no_reply',
      scope: 'conversation',
      cause: 'dead_turn_page_evidence',
      send_count: 1,
      goto_count: 1,
      navigation_count: 1,
      cleanup: 'skipped',
    });
    expect(outcome.result.poll_count).toBeGreaterThanOrEqual(3);
    expect(fake.metrics.sends).toBe(1);
    expect(fake.metrics.continuationClicks).toBe(0);
    expect(fake.metrics.closes).toBe(0);
    expect(fake.page.goto).toHaveBeenCalledTimes(1);
    expect(outcome.context.newPage).toHaveBeenCalledTimes(1);
    expect(mocks.linkSync).not.toHaveBeenCalled();
  });

  it('subtracts historical assistant nodes before classifying the current owned turn dead', async () => {
    const fake = makeEvidencePage([
      { generationInProgress: false },
      { generationInProgress: false },
      { generationInProgress: false },
    ], BASELINE);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '1', pollMs: '1' });

    expect(outcome.result).toMatchObject({
      state: 'no_reply',
      scope: 'conversation',
      cause: 'dead_turn_page_evidence',
      send_count: 1,
      cleanup: 'skipped',
    });
    expect(fake.metrics.sends).toBe(1);
    expect(fake.metrics.closes).toBe(0);
    expect(mocks.linkSync).not.toHaveBeenCalled();
  });

  it('does not classify active generation as dead at the transport boundary', async () => {
    const active = { generationInProgress: true } as const;
    const complete = {
      generationInProgress: false,
      assistant: { role: 'assistant', text: 'FINAL', finalAction: true } as StateLightTestMessage,
    } as const;
    const fake = makeEvidencePage([active, active, active, active, active, complete, complete]);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '2000', pollMs: '1' });

    expect(outcome.result).toMatchObject({ state: 'ok', cause: 'completed_page_only', send_count: 1 });
    expect(outcome.result.cause).not.toBe('dead_turn_page_evidence');
    expect(fake.metrics.sends).toBe(1);
  });

  it('keeps unknown generation evidence fail-closed until a real completion arrives', async () => {
    const unknown = { generationInProgress: 'unknown' } as const;
    const complete = {
      generationInProgress: false,
      assistant: { role: 'assistant', text: 'FINAL', finalAction: true } as StateLightTestMessage,
    } as const;
    const fake = makeEvidencePage([unknown, unknown, unknown, unknown, unknown, complete, complete]);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '2000', pollMs: '1' });

    expect(outcome.result).toMatchObject({ state: 'ok', cause: 'completed_page_only', send_count: 1 });
    expect(outcome.result.cause).not.toBe('dead_turn_page_evidence');
    expect(fake.metrics.sends).toBe(1);
  });

  it('keeps a current assistant delta completed when historical assistants are present', async () => {
    const complete = {
      generationInProgress: false,
      assistant: { role: 'assistant', text: 'FINAL', finalAction: true } as StateLightTestMessage,
    } as const;
    const fake = makeEvidencePage([complete, complete], BASELINE);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '2000', pollMs: '1' });

    expect(outcome.result).toMatchObject({ state: 'ok', cause: 'completed_page_only', send_count: 1 });
    expect(outcome.result.cause).not.toBe('dead_turn_page_evidence');
    expect(fake.metrics.sends).toBe(1);
  });
});
