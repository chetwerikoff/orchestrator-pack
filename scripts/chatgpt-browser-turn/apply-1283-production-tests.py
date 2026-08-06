from pathlib import Path


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one replacement anchor, found {count}: {old[:80]!r}')
    path.write_text(text.replace(old, new, 1))


flow_test = Path('scripts/flow-manager-long-running-child.test.ts')
replace_once(
    flow_test,
    "import { afterEach, describe, expect, it } from 'vitest';",
    "import { afterEach, describe, expect, it, vi } from 'vitest';",
)

tab_test = Path('scripts/chatgpt-browser-turn/tab-lifecycle.test.ts')
replace_once(
    tab_test,
    "const reachableOwners = new Set(['runStateLightEntry', 'runStateLightTurn', 'runStateLightSession', 'runCli']);",
    "const reachableOwners = new Set(['runStateLightEntry', 'runStateLightTurn', 'runStateLightSession', 'runCli', 'defaultEnumeratePages']);",
)
replace_once(
    tab_test,
    "      'contexts:browser-contexts:(activeBrowser as any):recoverCurrentObservation',\n",
    "      'contexts:browser-contexts:(activeBrowser as any):recoverCurrentObservation',\n      'contexts:browser-contexts:browser:defaultEnumeratePages',\n",
)
replace_once(
    tab_test,
    "      'pages:context-pages:(contexts[0] as { pages: () => unknown[] }):probeProfileReady',\n",
    "      'pages:context-pages:(contexts[0] as { pages: () => unknown[] }):probeProfileReady',\n      'pages:context-pages:contexts[0]:defaultEnumeratePages',\n",
)

support = Path('scripts/chatgpt-browser-turn/state-light-turn.test-support.ts')
support_text = support.read_text()
support_text = support_text.replace(
    "import { __testBrowserOrPageDefinitelyLost, __testFinalizeTurn, POST_SEND_OBSERVATION_POLL_MS, readPageObservation, runStateLightTurn } from './state-light-turn.ts';",
    "import { POST_SEND_OBSERVATION_POLL_MS, runStateLightTurn } from './state-light-turn.ts';",
    1,
)
marker = "\n\ndescribe('Issue #1283 owned-generation abandonment seam'"
if support_text.count(marker) != 1:
    raise SystemExit(f'{support}: expected one Issue #1283 seam marker, found {support_text.count(marker)}')
support.write_text(support_text.split(marker, 1)[0].rstrip() + '\n')

fresh_test = Path('scripts/chatgpt-browser-turn/state-light-fresh-conversation.test.ts')
text = fresh_test.read_text()
if "describe('Issue #1283 production runStateLightTurn recovery integration'" in text:
    raise SystemExit(f'{fresh_test}: integration suite already present')

integration = r'''


describe('Issue #1283 production runStateLightTurn recovery integration', () => {
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
    const output = join(stateDir, 'recovered.txt');
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
      press: vi.fn(async () => { sends += 1; lost = true; }),
    });
    const sendButton = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => { sends += 1; lost = true; }),
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

    const recoveredMessages = readyTurnObservationFrames(prompt, reply).at(-1)!;
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
        if (selector === MESSAGE_NODE_SELECTOR) return collectionLocator(recoveredMessages, false);
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          return collectionLocator(
            recoveredMessages.filter((message: StateLightTestMessage) => message.role === 'assistant'),
            false,
          );
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          const last = recoveredMessages.at(-1)!;
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
        if (selector.includes(STOP_BUTTON_TESTID)) {
          return scalarLocator({ count: vi.fn(async () => 1), click: foreignStop });
        }
        return scalarLocator();
      }),
      getByRole: vi.fn(() => scalarLocator()),
      getByText: vi.fn(() => scalarLocator()),
    };

    const initialBrowser = browserWithPages(initialPage, [initialPage], () => !lost);
    const recoveredBrowser = browserWithPages(recoveredPage, [foreignPage, recoveredPage], () => true);
    mocks.browserQueue.push(initialBrowser, recoveredBrowser);
    mocks.readStableInput.mockImplementationOnce(() => stableTurnInput(prompt));

    const outcome = await runProductionNewChat(output, '50');

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'ok',
      cause: 'completed_page_only',
      send_count: 1,
      conversation_id: SHARED_CONV,
    });
    expect(outcome.result.incidents).toContain('post_send_recovery_succeeded');
    expect(readFileSync(output, 'utf8')).toBe(reply);
    expect(sends).toBe(1);
    expect(mocks.browserQueue).toHaveLength(0);
    expect(initialClose).not.toHaveBeenCalled();
    expect(foreignStop).not.toHaveBeenCalled();
    expect(foreignClose).not.toHaveBeenCalled();
  });

  it('terminates observation exhaustion truthfully after one send, Stops only the proven owned page, and preserves every tab', async () => {
    const prompt = 'PROMPT-EXHAUST';
    const output = join(stateDir, 'exhausted.txt');
    let sends = 0;
    let sent = false;
    let url = PROJECT_URL;
    let composerText = '';
    const ownedStop = vi.fn(async () => undefined);
    const ownedClose = vi.fn(async () => undefined);
    const foreignStop = vi.fn(async () => undefined);
    const foreignClose = vi.fn(async () => undefined);
    const waitingMessages = readyTurnObservationFrames(prompt, 'UNUSED')[0]!;

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
          ? collectionLocator(waitingMessages, true)
          : collectionLocator([]);
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          return sent
            ? collectionLocator(
              waitingMessages.filter((message: StateLightTestMessage) => message.role === 'assistant'),
              true,
            )
            : collectionLocator([]);
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          const last = waitingMessages.at(-1)!;
          return sent ? messageLocator(last, true) : scalarLocator({ count: vi.fn(async () => 0) });
        }
        if (selector.includes(STOP_BUTTON_TESTID)) {
          return scalarLocator({ count: vi.fn(async () => sent ? 1 : 0), click: ownedStop });
        }
        return scalarLocator();
      }),
    };

    const foreignPage: any = {
      __fakeBrowserGptPage: true,
      url: vi.fn(() => LOSER_CONV),
      isClosed: vi.fn(() => false),
      close: foreignClose,
      locator: vi.fn((selector: string) => selector.includes(STOP_BUTTON_TESTID)
        ? scalarLocator({ count: vi.fn(async () => 1), click: foreignStop })
        : scalarLocator()),
      getByRole: vi.fn(() => scalarLocator()),
      getByText: vi.fn(() => scalarLocator()),
    };

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
    expect(outcome.result.incidents).toContain('owned_generation_stop_completed');
    expect(sends).toBe(1);
    expect(ownedStop).toHaveBeenCalledTimes(1);
    expect(foreignStop).not.toHaveBeenCalled();
    expect(ownedClose).not.toHaveBeenCalled();
    expect(foreignClose).not.toHaveBeenCalled();
  });
});
'''

fresh_test.write_text(text.rstrip() + integration + '\n')
