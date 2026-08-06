from pathlib import Path


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    if text.count(old) != 1:
        raise SystemExit(f'{path}: expected one replacement anchor, found {text.count(old)}')
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
    raise SystemExit(f'{support}: expected one Issue #1283 dead-test marker, found {support_text.count(marker)}')
support.write_text(support_text.split(marker, 1)[0].rstrip() + '\n')

observation = Path('scripts/chatgpt-browser-turn/state-light-page-observation.test.ts')
text = observation.read_text()
text = text.replace(
    "import { describe, expect, it, vi } from 'vitest';\n",
    "import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nimport { describe, expect, it, vi } from 'vitest';\n\nconst runStateLightIntegration = vi.hoisted(() => ({\n  browserQueue: [] as any[],\n  connectCalls: 0,\n}));\n\nvi.mock('./ui-adapter.ts', async (importOriginal) => {\n  const actual = await importOriginal<typeof import('./ui-adapter.ts')>();\n  return {\n    ...actual,\n    loadChromium: vi.fn(() => ({\n      connectOverCDP: vi.fn(async () => {\n        runStateLightIntegration.connectCalls += 1;\n        const browser = runStateLightIntegration.browserQueue.shift();\n        if (!browser) throw new Error('no integration browser queued');\n        return browser;\n      }),\n    })),\n    productStatusText: vi.fn(async () => ({ text: '', composer: true })),\n    verifyProfile: vi.fn(async () => ({\n      state: 'verified',\n      cause: 'verified',\n      evidence: 'issue-1283-integration',\n    })),\n  };\n});\n",
    1,
)
text = text.replace(
    "  ASSISTANT_TURN_ANCESTOR_XPATH,\n",
    "  ASSISTANT_MESSAGE_SELECTOR,\n  ASSISTANT_TURN_ANCESTOR_XPATH,\n  COMPOSER_SELECTOR,\n",
    1,
)
text = text.replace(
    "  MESSAGE_NODE_SELECTOR,\n",
    "  MESSAGE_NODE_SELECTOR,\n  SEND_BUTTON_SELECTOR,\n",
    1,
)
text = text.replace(
    "  replyStabilityMatches,\n} from './state-light-turn.ts';",
    "  replyStabilityMatches,\n  runStateLightTurn,\n} from './state-light-turn.ts';",
    1,
)
text = text.replace(
    "  scalarLocator,\n  TEST_OWNED_MARKER,\n",
    "  runStateLightTurnWithStdoutCapture,\n  scalarLocator,\n  STATE_LIGHT_TURN_BASE_ARGV,\n  TEST_OWNED_MARKER,\n",
    1,
)

integration_tests = r'''


describe('Issue #1283 production runStateLightTurn recovery', () => {
  const conversationUrl = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
  const baseline: StateLightTestMessage[] = [
    { role: 'user', text: 'historical prompt' },
    { role: 'assistant', text: 'historical reply', finalAction: true },
  ];

  function makePage(options: {
    readonly mode: 'browser-loss' | 'recovered-final' | 'waiting' | 'foreign';
    readonly sharedPayload: { value: string };
    readonly metrics: { sends: number; closes: number };
    readonly now: { value: number };
    readonly stopClick?: ReturnType<typeof vi.fn>;
  }) {
    let sent = options.mode !== 'browser-loss';
    let closed = false;
    const composer = scalarLocator({
      count: vi.fn(async () => 1),
      fill: vi.fn(async (value: string) => {
        options.sharedPayload.value = value;
      }),
      press: vi.fn(async () => {
        sent = true;
        options.metrics.sends += 1;
      }),
      isVisible: vi.fn(async () => true),
      isEnabled: vi.fn(async () => true),
      evaluate: vi.fn(async () => true),
    });
    const sendButton = scalarLocator({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => {
        sent = true;
        options.metrics.sends += 1;
      }),
      isVisible: vi.fn(async () => true),
      isEnabled: vi.fn(async () => true),
    });
    const stopControl = scalarLocator({
      count: vi.fn(async () => options.stopClick ? 1 : 0),
      click: options.stopClick ?? vi.fn(async () => undefined),
    });
    const currentMessages = (): StateLightTestMessage[] => {
      if (!sent) return baseline;
      if (options.mode === 'foreign') {
        return [...baseline, { role: 'user', text: 'foreign prompt' }, { role: 'assistant', text: 'foreign answer', finalAction: true }];
      }
      const assistant: StateLightTestMessage = options.mode === 'recovered-final'
        ? { role: 'assistant', text: 'RECOVERED FINAL', finalAction: true, finalActionInTurnContainer: true }
        : { role: 'assistant', text: 'working', inProgress: true };
      return [...baseline, { role: 'user', text: options.sharedPayload.value }, assistant];
    };
    const page: any = {
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => options.mode === 'foreign'
        ? 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222'
        : conversationUrl),
      isClosed: vi.fn(() => closed),
      close: vi.fn(async () => {
        options.metrics.closes += 1;
        closed = true;
      }),
      waitForTimeout: vi.fn(async (milliseconds: number) => {
        options.now.value += Math.max(1, milliseconds);
      }),
      on: vi.fn(),
      context: vi.fn(() => ({ on: vi.fn() })),
      getByRole: vi.fn(() => scalarLocator()),
      getByText: vi.fn(() => scalarLocator()),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === SEND_BUTTON_SELECTOR) return sendButton;
        if (matchesStopButtonSelector(selector)) return stopControl;
        if (selector === MESSAGE_NODE_SELECTOR) {
          if (options.mode === 'browser-loss' && sent) {
            closed = true;
            throw new Error('simulated browser loss after send');
          }
          const messages = currentMessages();
          return collectionLocator(messages, options.mode === 'waiting');
        }
        if (selector === ASSISTANT_MESSAGE_SELECTOR) {
          const assistants = currentMessages().filter((message) => message.role === 'assistant');
          return collectionLocator(assistants, options.mode === 'waiting');
        }
        if (selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.startsWith('xpath=ancestor-or-self::section')) {
          const assistant = currentMessages().filter((message) => message.role === 'assistant').at(-1);
          return assistant ? messageLocator(assistant, options.mode === 'waiting') : scalarLocator();
        }
        return scalarLocator();
      }),
    };
    return { page, closed: () => closed };
  }

  function makeBrowser(page: any, pages: any[], connected: () => boolean) {
    const context = {
      newPage: vi.fn(async () => page),
      pages: vi.fn(() => pages),
    };
    return {
      contexts: vi.fn(() => [context]),
      isConnected: vi.fn(connected),
      close: vi.fn(async () => undefined),
    };
  }

  function argv(root: string, timeoutMs: number) {
    return [
      ...STATE_LIGHT_TURN_BASE_ARGV,
      '--profile', join(root, 'profile'),
      '--input', join(root, 'prompt.txt'),
      '--output', join(root, 'reply.txt'),
      '--chat-url', conversationUrl,
      '--timeout-ms', String(timeoutMs),
      '--poll-ms', '1',
    ];
  }

  it('reconnects after browser loss, resumes the exact owned conversation, and never resends or closes foreign pages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-1283-recovery-'));
    mkdirSync(join(root, 'profile'), { recursive: true });
    writeFileSync(join(root, 'prompt.txt'), 'PROMPT');
    const sharedPayload = { value: '' };
    const now = { value: 10_000 };
    const initialMetrics = { sends: 0, closes: 0 };
    const recoveredMetrics = { sends: 0, closes: 0 };
    const foreignMetrics = { sends: 0, closes: 0 };
    const foreignStop = vi.fn(async () => undefined);
    const initial = makePage({ mode: 'browser-loss', sharedPayload, metrics: initialMetrics, now });
    const recovered = makePage({ mode: 'recovered-final', sharedPayload, metrics: recoveredMetrics, now });
    const foreign = makePage({ mode: 'foreign', sharedPayload, metrics: foreignMetrics, now, stopClick: foreignStop });
    const initialBrowser = makeBrowser(initial.page, [initial.page], () => !initial.closed());
    const recoveredBrowser = makeBrowser(recovered.page, [foreign.page, recovered.page], () => true);
    runStateLightIntegration.browserQueue.splice(0, runStateLightIntegration.browserQueue.length, initialBrowser, recoveredBrowser);
    runStateLightIntegration.connectCalls = 0;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now.value);
    try {
      const outcome = await runStateLightTurnWithStdoutCapture(
        (args) => runStateLightTurn(args),
        argv(root, 50),
      );
      expect(outcome.code).toBe(0);
      expect(outcome.result).toMatchObject({
        state: 'ok',
        cause: 'completed_page_only',
        send_count: 1,
        conversation_id: conversationUrl,
        cleanup: 'skipped',
      });
      expect(readFileSync(join(root, 'reply.txt'), 'utf8')).toBe('RECOVERED FINAL');
      expect(runStateLightIntegration.connectCalls).toBe(2);
      expect(initialMetrics.sends).toBe(1);
      expect(recoveredMetrics.sends).toBe(0);
      expect(foreignMetrics.sends).toBe(0);
      expect(initialMetrics.closes).toBe(0);
      expect(recoveredMetrics.closes).toBe(0);
      expect(foreignMetrics.closes).toBe(0);
      expect(foreignStop).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
      runStateLightIntegration.browserQueue.length = 0;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ends observation exhaustion truthfully with one send and never touches a foreign Stop or tab', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-1283-exhaustion-'));
    mkdirSync(join(root, 'profile'), { recursive: true });
    writeFileSync(join(root, 'prompt.txt'), 'PROMPT');
    const sharedPayload = { value: '' };
    const now = { value: 20_000 };
    const ownedMetrics = { sends: 0, closes: 0 };
    const foreignMetrics = { sends: 0, closes: 0 };
    const foreignStop = vi.fn(async () => undefined);
    const owned = makePage({ mode: 'waiting', sharedPayload, metrics: ownedMetrics, now });
    const foreign = makePage({ mode: 'foreign', sharedPayload, metrics: foreignMetrics, now, stopClick: foreignStop });
    const browser = makeBrowser(owned.page, [owned.page, foreign.page], () => true);
    runStateLightIntegration.browserQueue.splice(0, runStateLightIntegration.browserQueue.length, browser);
    runStateLightIntegration.connectCalls = 0;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now.value);
    try {
      const outcome = await runStateLightTurnWithStdoutCapture(
        (args) => runStateLightTurn(args),
        argv(root, 5),
      );
      expect(outcome.result).toMatchObject({
        state: 'no_reply',
        cause: 'observation_exhausted_no_resend',
        send_count: 1,
        cleanup: 'skipped',
      });
      expect(outcome.result.incidents).toContain('observation_exhausted');
      expect(ownedMetrics.sends).toBe(1);
      expect(foreignMetrics.sends).toBe(0);
      expect(ownedMetrics.closes).toBe(0);
      expect(foreignMetrics.closes).toBe(0);
      expect(foreignStop).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
      runStateLightIntegration.browserQueue.length = 0;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
'''
if "describe('Issue #1283 production runStateLightTurn recovery'" in text:
    raise SystemExit(f'{observation}: integration tests already present')
observation.write_text(text.rstrip() + integration_tests + '\n')
