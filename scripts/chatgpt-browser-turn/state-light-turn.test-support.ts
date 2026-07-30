import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  browserQueue: [] as any[],
  cleanupOutcome: 'confirmed' as 'confirmed' | 'unconfirmed',
  journalThrows: false,
  nowMs: 10_000,
  outputConflict: false,
  verifyProfile: vi.fn(async () => ({ state: 'verified' })),
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

vi.mock('./browser-session.ts', () => createBrowserSessionModuleMock(mocks));
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
import { runStateLightTurn } from './state-light-turn.ts';

const BASELINE: StateLightTestMessage[] = [
  { role: 'user', text: 'OLD' },
  { role: 'assistant', text: 'OLD ANSWER', finalAction: true },
];

function makePage(
  snapshots: StateLightTestSnapshot[],
  options: {
    throwAfterSend?: boolean;
    transientStatusErrors?: number;
    sendButton?: boolean;
    wallText?: string;
    wallAfterPoll?: number;
  } = {},
) {
  let sent = false;
  let filled = '';
  let observationIndex = 0;
  let activeSnapshot: StateLightTestSnapshot = { messages: BASELINE, generating: false };
  let continuationDismissed = false;
  let closed = false;
  let transientStatusErrors = options.transientStatusErrors ?? 0;
  const metrics = { sends: 0, closes: 0, polls: 0, waitedMs: 0 };

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
      if (sent && transientStatusErrors > 0) {
        transientStatusErrors--;
        throw new Error('transient product status read');
      }
      if (!sent || !options.wallText) return '';
      const threshold = options.wallAfterPoll ?? 1;
      return metrics.polls >= threshold ? options.wallText : '';
    },
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => 'https://chatgpt.com/c/fake-owned-turn'),
    isClosed: vi.fn(() => closed),
    waitForTimeout: vi.fn(async (ms: number) => {
      metrics.waitedMs += ms;
      mocks.nowMs += ms;
    }),
    close: vi.fn(async () => {
      closed = true;
      metrics.closes++;
    }),
    getByText: vi.fn((pattern: RegExp | string) => {
      const text = 'Continue generating';
      const matches = typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
      const visible = Boolean(activeSnapshot.continuation) && !continuationDismissed && matches;
      return scalarLocator({
        count: vi.fn(async () => visible ? 1 : 0),
        click: vi.fn(async () => { continuationDismissed = true; }),
      });
    }),
    locator: vi.fn((selector: string) => {
      if (selector === '#prompt-textarea') return composer;
      if (selector === '[data-testid="send-button"]') return sendButton;
      if (selector === '[data-message-author-role]') {
        if (sent && options.throwAfterSend) {
          closed = true;
          throw new Error('simulated page loss');
        }
        if (!sent) {
          activeSnapshot = { messages: BASELINE, generating: false };
          return collectionLocator(activeSnapshot.messages);
        }
        activeSnapshot = snapshots[Math.min(observationIndex, Math.max(0, snapshots.length - 1))]
          ?? { messages: [...BASELINE, { role: 'user', text: filled }], generating: true };
        continuationDismissed = false;
        observationIndex++;
        metrics.polls++;
        return collectionLocator(activeSnapshot.messages);
      }
      if (selector.startsWith('xpath=ancestor-or-self::section[starts-with(@data-testid, "conversation-turn-")]')) {
        const assistants = activeSnapshot.messages.filter((message) => message.role === 'assistant');
        const last = assistants.at(-1);
        if (!last?.finalActionInTurnContainer) return scalarLocator({ count: vi.fn(async () => 0) });
        return messageLocator(last, activeSnapshot.generating);
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
  mocks.browserQueue.length = 0;
  mocks.cleanupOutcome = 'confirmed';
  mocks.journalThrows = false;
  mocks.nowMs = 10_000;
  mocks.outputConflict = false;
  vi.spyOn(Date, 'now').mockImplementation(() => mocks.nowMs);
  mocks.verifyProfile.mockReset().mockResolvedValue({ state: 'verified' });
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
    expect(mocks.linkSync).toHaveBeenCalledTimes(1);
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
    expect(writes).toHaveLength(3);
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
    const stableEcho = `${'A'.repeat(120)} detail detail detail…`;
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
      url: vi.fn(() => 'https://chatgpt.com/c/fake-owned-turn'),
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
        if (selector === '#prompt-textarea') return composer;
        if (selector === '[data-testid="send-button"]') return sendButton;
        if (selector === '[data-message-author-role]') {
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
        if (selector === '[data-message-author-role="assistant"]') {
          return collectionLocator([{ role: 'assistant', text: 'working' }], true);
        }
        if (selector.includes('stop-button')) return scalarLocator();
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
    expect(outcome.result.state).not.toBe('foreign_activity');
    expect(outcome.result.state).not.toBe('send_failed');
    expect(outcome.result).toMatchObject({
      state: 'no_reply',
      cause: 'observation_exhausted_no_resend',
    });
    expect(metrics.closes).toBe(0);
    expect(metrics.polls).toBeGreaterThanOrEqual(3);
  });

  it('completes a long prompt with different line breaking without false foreign_activity', async () => {
    const longPrompt = `Problem:\nFlow-manager misclassifies long prompts.\n\nGoal:\nVerify echo tolerance.\n${'detail '.repeat(120)}`;
    const collapsedEcho = 'Problem: Flow-manager misclassifies long prompts. Goal: Verify echo tolerance. detail detail…';
    const snapshots: StateLightTestSnapshot[] = [
      {
        messages: [...BASELINE, { role: 'user', text: collapsedEcho }, { role: 'assistant', text: 'working' }],
        generating: true,
      },
      {
        messages: [...BASELINE, { role: 'user', text: collapsedEcho }, { role: 'assistant', text: 'FINAL', finalAction: true }],
        generating: false,
      },
      {
        messages: [...BASELINE, { role: 'user', text: collapsedEcho }, { role: 'assistant', text: 'FINAL', finalAction: true }],
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
    expect(outcome.result.state).not.toBe('foreign_activity');
    expect(mocks.writeFileSync.mock.calls[0]?.[1]).toBe('FINAL');
  });

  it('keeps foreign activity invocation-local and still closes only its owned tab', async () => {
    const foreignSnapshot: StateLightTestSnapshot = {
      messages: [
        ...BASELINE,
        { role: 'user', text: 'PROMPT' },
        { role: 'assistant', text: 'partial' },
        { role: 'user', text: 'FOREIGN' },
        { role: 'assistant', text: 'FOREIGN ANSWER', finalAction: true },
      ],
      generating: false,
    };
    const fake = makePage([foreignSnapshot, foreignSnapshot, foreignSnapshot]);
    const outcome = await runAndCapture(fake.page);

    expect(outcome.result).toMatchObject({
      state: 'foreign_activity',
      scope: 'invocation',
      send_count: 1,
      cleanup: 'confirmed',
      foreign_activity_diagnostics: {
        suspect_visible_head: 'FOREIGN',
        prompt_head: 'PROMPT',
        shared_overlap: expect.any(Number),
      },
    });
    expect(outcome.result.foreign_activity_diagnostics?.shared_overlap).toBeLessThan(24);
    expect(fake.metrics.waitedMs).toBeGreaterThanOrEqual(4000);
    expect(fake.metrics.sends).toBe(1);
    expect(fake.metrics.closes).toBe(1);
    expect(mocks.linkSync).not.toHaveBeenCalled();
    const journal = mocks.appendFileSync.mock.calls.map((call) => String(call[1])).join('\n');
    expect(journal).toContain('suspect_visible_head');
    expect(journal).toContain('shared_overlap');
  });

  it('keeps polling the same owned page after a transient post-send observation error', async () => {
    const fake = makePage(readySnapshots(), { transientStatusErrors: 1 });
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


  it('returns observation_exhausted_no_resend when completion never becomes ready before the soft deadline', async () => {
    const waiting: StateLightTestSnapshot = {
      messages: [...BASELINE, { role: 'user', text: 'PROMPT' }, { role: 'assistant', text: 'working' }],
      generating: true,
    };
    const fake = makePage([waiting, waiting, waiting]);
    const outcome = await runAndCapture(fake.page, { timeoutMs: '5', pollMs: '1' });

    expect(outcome.result).toMatchObject({
      state: 'no_reply',
      scope: 'invocation',
      cause: 'observation_exhausted_no_resend',
      send_count: 1,
    });
    expect(outcome.result.incidents).toContain('observation_exhausted');
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
    const collapsedEcho = `${'A'.repeat(120)} detail detail detail…`;
    const snapshots: StateLightTestSnapshot[] = [
      {
        messages: [...BASELINE, { role: 'user', text: collapsedEcho }, { role: 'assistant', text: 'working' }],
        generating: true,
      },
      {
        messages: [...BASELINE, { role: 'user', text: collapsedEcho }, { role: 'assistant', text: 'FINAL', finalAction: true }],
        generating: false,
      },
      {
        messages: [...BASELINE, { role: 'user', text: collapsedEcho }, { role: 'assistant', text: 'FINAL', finalAction: true }],
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
    expect(outcome.result.state).not.toBe('foreign_activity');
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
    expect(outcome.result.state).not.toBe('foreign_activity');
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
      state: 'no_reply',
      cause: 'observation_exhausted_no_resend',
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
        foreign_stable_reads: 0,
        poll_count: expect.any(Number),
        soft_deadline_elapsed: true,
      },
    });
    expect(outcome.result.observation_exhausted_diagnostics?.last_assistant_head).toContain('PARTIAL');
    expect(fake.metrics.closes).toBe(0);
    expect(mocks.linkSync).not.toHaveBeenCalled();
  });

  it('exhausts oscillating foreign_suspect with diagnostics instead of observing forever', async () => {
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
    expect(outcome.result.state).toBe('no_reply');
    expect(outcome.result.state).not.toBe('foreign_activity');
    expect(outcome.result.state).not.toBe('send_failed');
    expect(outcome.result).toMatchObject({
      cause: 'observation_exhausted_no_resend',
      observation_exhausted_diagnostics: {
        observation_state: 'foreign_suspect',
        foreign_stable_reads: 1,
        soft_deadline_elapsed: true,
      },
    });
    expect(fake.metrics.closes).toBe(0);
  });

  it('stabilizes a long reply when successive reads differ only by render artifacts', async () => {
    const body = `${'detail '.repeat(60)} Section footer with enough words.`;
    const renderA = `Intro paragraph.

${body}`;
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
