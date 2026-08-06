from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one anchor, found {count}: {old[:100]!r}')
    file.write_text(text.replace(old, new, 1))


flow_test = 'scripts/flow-manager-long-running-child.test.ts'
replace_once(
    flow_test,
    "import { afterEach, describe, expect, it } from 'vitest';",
    "import { afterEach, describe, expect, it, vi } from 'vitest';",
)

tab_test = 'scripts/chatgpt-browser-turn/tab-lifecycle.test.ts'
replace_once(
    tab_test,
    "} from './state-light-cancellation.ts';\n",
    "} from './state-light-cancellation.ts';\nimport {\n  runPostSendRecovery,\n  type PostSendRecoveryState,\n} from './state-light-turn-recovery.ts';\n",
)
replace_once(
    tab_test,
    "const reachableOwners = new Set(['runStateLightEntry', 'runStateLightTurn', 'runStateLightSession', 'runCli']);",
    "const reachableOwners = new Set([\n      'runStateLightEntry',\n      'runStateLightTurn',\n      'runStateLightSession',\n      'runCli',\n      'cancelOwnedGenerationFromReceipt',\n    ]);",
)
replace_once(
    tab_test,
    "      'contexts:browser-contexts:(activeBrowser as any):recoverCurrentObservation',\n",
    "      'contexts:browser-contexts:(activeBrowser as any):recoverCurrentObservation',\n      'contexts:browser-contexts:browser:defaultEnumeratePages',\n",
)
replace_once(
    tab_test,
    "      'pages:context-pages:context:attachGateBWebSocketObservers',\n",
    "      'pages:context-pages:context:attachGateBWebSocketObservers',\n      'pages:context-pages:contexts[0]:defaultEnumeratePages',\n",
)

integration_tests = r'''


describe('Issue #1283 production runStateLightTurn recovery integration', () => {
  const marker = `OPKTURNV1${'78'.repeat(16)}`;
  const ownedUrl = 'https://chatgpt.com/c/77777777-7777-4777-8777-777777777777';
  const foreignUrl = 'https://chatgpt.com/c/88888888-8888-4888-8888-888888888888';

  function trackedPage(url: string, stopVisible = false) {
    let visible = stopVisible;
    const stopClick = vi.fn(async () => { visible = false; });
    const close = vi.fn(async () => undefined);
    const page = {
      url: () => url,
      isClosed: () => false,
      close,
      locator: () => ({
        count: vi.fn(async () => visible ? 1 : 0),
        first: () => ({
          click: stopClick,
          waitFor: vi.fn(async () => undefined),
        }),
      }),
    };
    return { page, stopClick, close };
  }

  async function runEntry(runTurn: () => Promise<any>) {
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const code = await runStateLightTurn(['--profile', 'fixture'], { runTurn });
      const result = writes
        .flatMap((chunk) => chunk.split(/\r?\n/))
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((row) => row.schema === 'turn-result/v1');
      expect(result).toBeDefined();
      return { code, result };
    } finally {
      stdout.mockRestore();
    }
  }

  it('recovers an exact owned page after page loss without resend, foreign Stop, or close', async () => {
    const lost = { url: () => ownedUrl, isClosed: () => true };
    const recovered = trackedPage(ownedUrl);
    const foreign = trackedPage(foreignUrl, true);
    const browser = { isConnected: () => true, close: vi.fn(async () => undefined) };
    let sends = 0;
    const state: PostSendRecoveryState = {
      lossEpoch: 0,
      successorCreated: false,
      immutableConversationUrl: ownedUrl,
      cleanupAuthorityPage: lost,
      stopAuthorityPage: lost,
    };

    const outcome = await runEntry(async () => {
      sends += 1;
      const recovery = await runPostSendRecovery({
        browser,
        currentPage: lost,
        marker,
        hardDeadlineMs: 100,
        pollMs: 1,
        state,
        adapter: {
          enumeratePages: vi.fn(async () => [foreign.page, recovered.page]),
          pageUrl: (page) => String((page as any).url()),
          normalizeConversationUrl: (value) => value,
          isSupportedConversationUrl: () => true,
          readAuthoritativeMessages: vi.fn(async (page) => ({
            messages: page === recovered.page
              ? [{ role: 'user' as const, text: `${marker}\n\nprompt` }]
              : [{ role: 'user' as const, text: 'foreign prompt' }],
            incomplete: false,
          })),
          browserDefinitelyDisconnected: () => false,
          pageDefinitelyLost: (page) => page === lost,
          reconnect: vi.fn(async () => { throw new Error('unexpected reconnect'); }),
          createSuccessor: vi.fn(async () => { throw new Error('unexpected successor'); }),
          sleep: vi.fn(async () => undefined),
          now: () => 1,
        },
      });
      expect(recovery).toMatchObject({
        kind: 'recovered',
        page: recovered.page,
        conversationUrl: ownedUrl,
        cleanupOwned: false,
      });
      if (recovery.kind !== 'recovered') throw new Error(recovery.cause);
      return {
        page: recovery.page,
        browser: recovery.browser,
        cleanupAction: 'preserve' as const,
        result: makeTurnResult({
          state: 'ok',
          scope: 'none',
          cause: 'completed_page_only',
          send_count: sends,
        }),
      };
    });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(sends).toBe(1);
    expect(recovered.stopClick).not.toHaveBeenCalled();
    expect(recovered.close).not.toHaveBeenCalled();
    expect(foreign.stopClick).not.toHaveBeenCalled();
    expect(foreign.close).not.toHaveBeenCalled();
  });

  it('reconnects after browser loss and binds only the exact owned conversation without resend', async () => {
    const lost = { url: () => ownedUrl, isClosed: () => true };
    const recovered = trackedPage(ownedUrl);
    const foreign = trackedPage(foreignUrl, true);
    const deadBrowser = { isConnected: () => false, close: vi.fn(async () => undefined) };
    const liveBrowser = { isConnected: () => true, close: vi.fn(async () => undefined) };
    const reconnect = vi.fn(async () => liveBrowser);
    let sends = 0;
    const state: PostSendRecoveryState = {
      lossEpoch: 0,
      successorCreated: false,
      immutableConversationUrl: ownedUrl,
      cleanupAuthorityPage: lost,
      stopAuthorityPage: lost,
    };

    const outcome = await runEntry(async () => {
      sends += 1;
      const recovery = await runPostSendRecovery({
        browser: deadBrowser,
        currentPage: lost,
        marker,
        hardDeadlineMs: 100,
        pollMs: 1,
        state,
        adapter: {
          enumeratePages: vi.fn(async (browser) => {
            expect(browser).toBe(liveBrowser);
            return [foreign.page, recovered.page];
          }),
          pageUrl: (page) => String((page as any).url()),
          normalizeConversationUrl: (value) => value,
          isSupportedConversationUrl: () => true,
          readAuthoritativeMessages: vi.fn(async (page) => ({
            messages: page === recovered.page
              ? [{ role: 'user' as const, text: `${marker}\n\nprompt` }]
              : [{ role: 'user' as const, text: 'foreign prompt' }],
            incomplete: false,
          })),
          browserDefinitelyDisconnected: (browser) => browser === deadBrowser,
          pageDefinitelyLost: (page) => page === lost,
          reconnect,
          createSuccessor: vi.fn(async () => { throw new Error('unexpected successor'); }),
          sleep: vi.fn(async () => undefined),
          now: () => 1,
        },
      });
      expect(recovery).toMatchObject({
        kind: 'recovered',
        browser: liveBrowser,
        page: recovered.page,
        conversationUrl: ownedUrl,
      });
      if (recovery.kind !== 'recovered') throw new Error(recovery.cause);
      return {
        page: recovery.page,
        browser: recovery.browser,
        cleanupAction: 'preserve' as const,
        result: makeTurnResult({
          state: 'ok',
          scope: 'none',
          cause: 'completed_page_only',
          send_count: sends,
        }),
      };
    });

    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(sends).toBe(1);
    expect(recovered.stopClick).not.toHaveBeenCalled();
    expect(recovered.close).not.toHaveBeenCalled();
    expect(foreign.stopClick).not.toHaveBeenCalled();
    expect(foreign.close).not.toHaveBeenCalled();
  });

  it('emits truthful exhaustion, Stops the exact successor once, and preserves every tab', async () => {
    const owned = trackedPage(ownedUrl, true);
    const foreign = trackedPage(foreignUrl, true);
    const browser = { isConnected: () => true, close: vi.fn(async () => undefined) };
    let sends = 0;
    const state: PostSendRecoveryState = {
      lossEpoch: 1,
      successorCreated: true,
      immutableConversationUrl: ownedUrl,
      cleanupAuthorityPage: owned.page,
      stopAuthorityPage: owned.page,
      successorPage: owned.page,
    };

    const outcome = await runEntry(async () => {
      sends += 1;
      const recovery = await runPostSendRecovery({
        browser,
        marker,
        hardDeadlineMs: 0,
        pollMs: 1,
        state,
        adapter: {
          enumeratePages: vi.fn(async () => [foreign.page]),
          pageUrl: (page) => String((page as any).url()),
          normalizeConversationUrl: (value) => value,
          isSupportedConversationUrl: () => true,
          readAuthoritativeMessages: vi.fn(async () => ({
            messages: [{ role: 'user' as const, text: 'foreign prompt' }],
            incomplete: false,
          })),
          browserDefinitelyDisconnected: () => false,
          pageDefinitelyLost: () => false,
          reconnect: vi.fn(async () => { throw new Error('unexpected reconnect'); }),
          createSuccessor: vi.fn(async () => { throw new Error('unexpected successor'); }),
          sleep: vi.fn(async () => undefined),
          now: () => 1,
        },
      });
      expect(recovery).toMatchObject({
        kind: 'failure',
        state: 'no_reply',
        cause: 'observation_exhausted_no_resend',
        stopAuthorityPage: owned.page,
      });
      if (recovery.kind !== 'failure') throw new Error('expected exhaustion');
      return {
        page: recovery.stopAuthorityPage,
        stopAuthorityPage: recovery.stopAuthorityPage,
        browser: recovery.browser,
        cleanupAction: 'preserve' as const,
        result: makeTurnResult({
          state: recovery.state,
          scope: 'invocation',
          cause: recovery.cause,
          send_count: sends,
        }),
      };
    });

    expect(outcome.code).not.toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'no_reply',
      cause: 'observation_exhausted_no_resend',
      send_count: 1,
      cleanup: 'skipped',
    });
    expect(outcome.result.incidents).toContain('owned_generation_stop_confirmed');
    expect(sends).toBe(1);
    expect(owned.stopClick).toHaveBeenCalledTimes(1);
    expect(owned.close).not.toHaveBeenCalled();
    expect(foreign.stopClick).not.toHaveBeenCalled();
    expect(foreign.close).not.toHaveBeenCalled();
  });
});
'''

file = Path(tab_test)
text = file.read_text()
if "describe('Issue #1283 production runStateLightTurn recovery integration'" in text:
    raise SystemExit('production integration tests already present')
file.write_text(text + integration_tests)
