      }),
    };
    const browser = { isConnected: () => true, close: vi.fn(async () => undefined) };
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runStateLightTurn(['--profile', 'fixture'], {
        runTurn: async () => ({ page, browser, result: nonOkResult() }),
      });
    } finally {
      write.mockRestore();
    }
    expect(stopClick).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('Stops the explicit proven target once and never closes it on non-ok', async () => {
    const stopClick = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const control = {
      click: stopClick,
      waitFor: vi.fn(async () => undefined),
    };
    const page = {
      isClosed: () => false,
      close,
      locator: () => ({
        count: vi.fn(async () => 1),
        first: () => control,
      }),
    };
    const browser = { isConnected: () => true, close: vi.fn(async () => undefined) };
    const result = await __testFinalizeTurn({
      page,
      stopAuthorityPage: page,
      browser,
      result: nonOkResult(),
    });
    expect(stopClick).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(result.cleanup).toBe('skipped');
    expect(result.incidents).toContain('owned_generation_stop_confirmed');
  });

  it('forfeiture suppresses even an otherwise explicit Stop target', async () => {
    const stopClick = vi.fn(async () => undefined);
    const page = {
      isClosed: () => false,
      close: vi.fn(async () => undefined),
      locator: () => ({
        count: vi.fn(async () => 1),
        first: () => ({ click: stopClick, waitFor: vi.fn(async () => undefined) }),
      }),
    };
    const result = await __testFinalizeTurn({
      page,
      stopAuthorityPage: page,
      ownershipForfeited: true,
      browser: { isConnected: () => true, close: vi.fn(async () => undefined) },
      result: nonOkResult(),
    });
    expect(stopClick).not.toHaveBeenCalled();
    expect(result.incidents).toContain('owned_generation_stop_unavailable');
  });
});
''')

# Extend launcher tests.
launcher_test = 'scripts/flow-manager-long-running-child.test.ts'
replace_once(launcher_test, "import type { TurnResultV1 } from './chatgpt-browser-turn/contracts.ts';", "import type { TurnResultV1 } from './chatgpt-browser-turn/contracts.ts';\nimport { buildBrowserTurnCancellationReceipt } from './chatgpt-browser-turn/state-light-cancellation.ts';\nimport { configuredProfileKey } from './chatgpt-browser-turn/storage-common.ts';")
with Path(launcher_test).open('a') as f:
    f.write(r'''

describe('Issue #1283 long-running child EOF cancellation', () => {
  it('attempts proven Stop before process termination and records an honest terminal result', async () => {
    const root = tempDir('opk-1283-eof-');
    const paths = launchPaths(root, 'receipt-stop');
    const cdp = 'http://127.0.0.1:9222';
    const profile = join(root, 'profile');
    const invocation = 'invocation-1283-eof';
    const marker = `OPKTURNV1${'34'.repeat(16)}`;
    const conversationUrl = 'https://chatgpt.com/c/33333333-3333-4333-8333-333333333333';
    const receipt = buildBrowserTurnCancellationReceipt({
      invocationId: invocation,
      profileKey: configuredProfileKey(profile, cdp),
      conversationUrl,
      marker,
      sendCount: 1,
    });
    expect(receipt).not.toBeNull();
    const fixture = nodeFixture(`
      process.stdout.write(JSON.stringify(${JSON.stringify(receipt)}) + '\\n');
      setInterval(() => {}, 1000);
    `);
    const owned = { url: () => conversationUrl, close: vi.fn() };
    const sibling = {
      url: () => 'https://chatgpt.com/c/44444444-4444-4444-8444-444444444444',
      close: vi.fn(),
    };
    const stop = vi.fn(async (page: unknown) => {
      expect(page).toBe(owned);
      return 'confirmed' as const;
    });
    process.env.OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS = '200';
    const code = await runLaunch({
      runIdentity: 'run-1283',
      attemptIdentity: 'attempt-1283',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: [
        ...fixture.args,
        '--cdp', cdp,
        '--profile', profile,
        '--invocation-id', invocation,
      ],
      cancellationDependencies: {
        connect: vi.fn(async () => ({})),
        releaseBrowser: vi.fn(async () => undefined),
        enumeratePages: vi.fn(async () => [sibling, owned]),
        readUserMessages: vi.fn(async (page) => ({
          messages: page === owned
            ? [{ role: 'user' as const, text: `${marker}\n\nprompt` }]
            : [{ role: 'user' as const, text: 'foreign' }],
          incomplete: false,
        })),
        stop,
      },
    });
    expect(code).toBe(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(owned.close).not.toHaveBeenCalled();
    expect(sibling.close).not.toHaveBeenCalled();
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope).toMatchObject({
      incident: 'child_stdout_eof_timeout',
      delivery: 'POSSIBLY_DELIVERED',
      turn_result_state: 'no_reply',
      turn_result_cause: 'child_stdout_eof_timeout_generation_stopped',
      send_count: 1,
      recovery_available: true,
      conversation_locator: conversationUrl,
    });
    expect(envelope?.diagnostics).toMatchObject({
      cancellation: {
        stop_outcome: 'confirmed',
        identity_proven: true,
      },
    });
  });
});
''')

# Update recovery tests to assert Stop authority lifecycle.
review_tests = 'scripts/toolchain/chatgpt-browser-turn.review-fixes.test.ts'
replace_once(review_tests, "      cleanupAuthorityPage: lostPage,\n    };\n\n    const result = await runPostSendRecovery({", "      cleanupAuthorityPage: lostPage,\n      stopAuthorityPage: lostPage,\n    };\n\n    const result = await runPostSendRecovery({")
# There are multiple identical snippets; only first was replacement. Add generic assertions near successor test.
replace_once(review_tests, "    expect(state.successorCreated).toBe(true);\n  });", "    expect(state.successorCreated).toBe(true);\n    expect(state.stopAuthorityPage).toBe(successor);\n    expect(result).toMatchObject({ stopAuthorityPage: successor });\n  });")
replace_once(review_tests, "      cleanupAuthorityPage: lostSuccessor,\n    };", "      cleanupAuthorityPage: lostSuccessor,\n      stopAuthorityPage: lostSuccessor,\n    };")
replace_once(review_tests, "    expect(state.cleanupAuthorityPage).toBeUndefined();\n    expect(state.successorPage).toBeUndefined();", "    expect(state.cleanupAuthorityPage).toBeUndefined();\n    expect(state.stopAuthorityPage).toBeUndefined();\n    expect(state.successorPage).toBeUndefined();")
# Add user-only census + failure provenance tests.
with Path(review_tests).open('a') as f:
    f.write(r'''

describe('Issue #1283 recovery authority regressions', () => {
  const marker = `OPKTURNV1${'56'.repeat(16)}`;
  const knownUrl = 'https://chatgpt.com/c/55555555-5555-4555-8555-555555555555';

  it('carries a still-held successor Stop target on terminal recovery failure', async () => {
    const successor = {};
    const state: PostSendRecoveryState = {
      lossEpoch: 1,
      successorCreated: true,
      immutableConversationUrl: knownUrl,
      successorPage: successor,
      cleanupAuthorityPage: successor,
      stopAuthorityPage: successor,
    };
    const result = await runPostSendRecovery({
      browser: {},
      currentPage: undefined,
      marker,
      hardDeadlineMs: 0,
      pollMs: 1,
      state,
      adapter: {
        enumeratePages: vi.fn(async () => [successor]),
        pageUrl: () => knownUrl,
        normalizeConversationUrl: (value) => value,
        isSupportedConversationUrl: () => true,
        readAuthoritativeMessages: vi.fn(async () => ({ messages: [], incomplete: true })),
        browserDefinitelyDisconnected: () => false,
        pageDefinitelyLost: () => false,
        reconnect: vi.fn(async () => ({})),
        createSuccessor: vi.fn(async () => successor),
        sleep: vi.fn(async () => undefined),
        now: () => 1,
      },
    });
    expect(result).toMatchObject({
      kind: 'failure',
      cause: 'owned_conversation_recovery_census_failed',
      stopAuthorityPage: successor,
    });
  });
});
''')

# Update scope declaration for the reviewer-mandated surfaces.
decl = Path('docs/declarations/1283.pr-scope.json')
body = json.loads(decl.read_text())
for path in [
    'scripts/chatgpt-browser-turn/state-light-cancellation.ts',
    'scripts/chatgpt-browser-turn/state-light-cancellation.test.ts',
    'scripts/flow-manager-long-running-child.ts',
    'scripts/flow-manager-long-running-child.test.ts',
]:
    if path not in body['declared_paths']:
        body['declared_paths'].append(path)
for root in [
    'scripts/flow-manager-long-running-child.ts',
    'scripts/flow-manager-long-running-child.test.ts',
]:
    if root not in body['allowed_roots']:
        body['allowed_roots'].append(root)
body['declared_paths'] = sorted(body['declared_paths'])
body['allowed_roots'] = sorted(body['allowed_roots'])
decl.write_text(json.dumps(body, indent=2) + '\n')
