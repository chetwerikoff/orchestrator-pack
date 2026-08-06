    });
    await abortManagedProcess(controller, runPromise);
    return 1;
"""
new_missing = """    const spawnFailed = completion.result?.outcome === 'spawn-failure';
    if (!completion.completed) {
      const cancellation = await runChildEofCancellation(config, capture);
      await publishEnvelope(config, {
        schema: TERMINAL_SCHEMA,
        run_identity: config.runIdentity,
        attempt_identity: config.attemptIdentity,
        completion_mode: COMPLETION_MODE,
        handoff_receipt_path: config.handoffReceiptPath,
        launcher_started_at: launcherStartedAt,
        handoff_committed_at: receipt.handoff_committed_at,
        terminal_at: nowIso(),
        lifecycle_outcome: 'incident',
        incident: 'child_stdout_eof_timeout',
        delivery: 'POSSIBLY_DELIVERED',
        child_exit_code: childExitCode,
        turn_result_state: cancellation.state,
        turn_result_cause: cancellation.cause,
        ...(cancellation.sendCount ? { send_count: cancellation.sendCount } : {}),
        recovery_available: Boolean(cancellation.conversationUrl),
        ...(cancellation.conversationUrl
          ? { conversation_locator: cancellation.conversationUrl }
          : {}),
        diagnostics: cancellationDiagnostics(cancellation, lastHeartbeatDiagnostics),
      });
      await abortManagedProcess(controller, runPromise);
      return 1;
    }
    const incident = spawnFailed ? 'child_start_failed' : 'child_terminal_result_missing';
    await publishEnvelope(config, {
      schema: TERMINAL_SCHEMA,
      run_identity: config.runIdentity,
      attempt_identity: config.attemptIdentity,
      completion_mode: COMPLETION_MODE,
      handoff_receipt_path: config.handoffReceiptPath,
      launcher_started_at: launcherStartedAt,
      handoff_committed_at: receipt.handoff_committed_at,
      terminal_at: nowIso(),
      lifecycle_outcome: 'incident',
      incident,
      delivery: deliveryWithoutTurnResult(spawnFailed),
      child_exit_code: childExitCode,
      recovery_available: Boolean(config.conversationLocator),
      ...(config.conversationLocator ? { conversation_locator: config.conversationLocator } : {}),
    });
    await abortManagedProcess(controller, runPromise);
    return 1;
"""
replace_once(flow, old_missing, new_missing)
old_bottom = """  await publishEnvelope(config, {
    schema: TERMINAL_SCHEMA,
    run_identity: config.runIdentity,
    attempt_identity: config.attemptIdentity,
    completion_mode: COMPLETION_MODE,
    handoff_receipt_path: config.handoffReceiptPath,
    launcher_started_at: launcherStartedAt,
    handoff_committed_at: receipt.handoff_committed_at,
    terminal_at: nowIso(),
    lifecycle_outcome: 'incident',
    incident: 'child_stdout_eof_timeout',
    delivery: deliveryWithoutTurnResult(false),
    child_exit_code: childExitCode,
    recovery_available: Boolean(config.conversationLocator),
    ...(config.conversationLocator ? { conversation_locator: config.conversationLocator } : {}),
  });
  await abortManagedProcess(controller, runPromise);
  return 1;
"""
new_bottom = """  const cancellation = await runChildEofCancellation(config, capture);
  await publishEnvelope(config, {
    schema: TERMINAL_SCHEMA,
    run_identity: config.runIdentity,
    attempt_identity: config.attemptIdentity,
    completion_mode: COMPLETION_MODE,
    handoff_receipt_path: config.handoffReceiptPath,
    launcher_started_at: launcherStartedAt,
    handoff_committed_at: receipt.handoff_committed_at,
    terminal_at: nowIso(),
    lifecycle_outcome: 'incident',
    incident: 'child_stdout_eof_timeout',
    delivery: 'POSSIBLY_DELIVERED',
    child_exit_code: childExitCode,
    turn_result_state: cancellation.state,
    turn_result_cause: cancellation.cause,
    ...(cancellation.sendCount ? { send_count: cancellation.sendCount } : {}),
    recovery_available: Boolean(cancellation.conversationUrl),
    ...(cancellation.conversationUrl
      ? { conversation_locator: cancellation.conversationUrl }
      : {}),
    diagnostics: cancellationDiagnostics(cancellation, lastHeartbeatDiagnostics),
  });
  await abortManagedProcess(controller, runPromise);
  return 1;
"""
replace_once(flow, old_bottom, new_bottom)

# Focused cancellation tests.
Path('scripts/chatgpt-browser-turn/state-light-cancellation.test.ts').write_text(r'''import { describe, expect, it, vi } from 'vitest';
import {
  buildBrowserTurnCancellationReceipt,
  cancelOwnedGenerationFromReceipt,
  isSupportedChatGptConversationUrl,
  stopOwnedGeneration,
} from './state-light-cancellation.ts';

const marker = `OPKTURNV1${'12'.repeat(16)}`;
const ownedUrl = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
const foreignUrl = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';

describe('Issue #1283 receipt-bound cancellation', () => {
  it('accepts only closed ChatGPT conversation origins and UUID paths', () => {
    expect(isSupportedChatGptConversationUrl(ownedUrl)).toBe(true);
    expect(isSupportedChatGptConversationUrl(ownedUrl + '?model=auto#x')).toBe(true);
    expect(isSupportedChatGptConversationUrl('https://evil.example/c/11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(isSupportedChatGptConversationUrl('https://chatgpt.com/not-c/11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(isSupportedChatGptConversationUrl('https://chatgpt.com/c/not-a-uuid')).toBe(false);
  });

  it('treats missing Stop control as unconfirmed rather than completed', async () => {
    const page = {
      isClosed: () => false,
      locator: () => ({ count: vi.fn(async () => 0) }),
    };
    await expect(stopOwnedGeneration(page)).resolves.toBe('unconfirmed');
  });

  it('stops exactly the one page proven by exact URL and exact marker, without close', async () => {
    const owned = { url: () => ownedUrl, close: vi.fn() };
    const foreign = { url: () => foreignUrl, close: vi.fn() };
    const stop = vi.fn(async (page: unknown) => {
      expect(page).toBe(owned);
      return 'confirmed' as const;
    });
    const receipt = buildBrowserTurnCancellationReceipt({
      invocationId: 'inv-1283',
      profileKey: 'profile-1283',
      conversationUrl: ownedUrl,
      marker,
      sendCount: 1,
    });
    expect(receipt).not.toBeNull();
    const result = await cancelOwnedGenerationFromReceipt(receipt!, 'http://127.0.0.1:9222', {
      connect: vi.fn(async () => ({})),
      releaseBrowser: vi.fn(async () => undefined),
      enumeratePages: vi.fn(async () => [foreign, owned]),
      readUserMessages: vi.fn(async (page) => ({
        messages: page === owned
          ? [{ role: 'user' as const, text: `${marker}\n\nprompt` }]
          : [{ role: 'user' as const, text: 'foreign prompt' }],
        incomplete: false,
      })),
      stop,
    });
    expect(result).toMatchObject({
      state: 'no_reply',
      cause: 'child_stdout_eof_timeout_generation_stopped',
      sendCount: 1,
      stopOutcome: 'confirmed',
      identityProven: true,
      conversationUrl: ownedUrl,
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(owned.close).not.toHaveBeenCalled();
    expect(foreign.close).not.toHaveBeenCalled();
  });

  it('fails closed without Stop when marker proof is absent or ambiguous', async () => {
    const page = { url: () => ownedUrl, close: vi.fn() };
    const stop = vi.fn(async () => 'confirmed' as const);
    const receipt = buildBrowserTurnCancellationReceipt({
      invocationId: 'inv-1283',
      profileKey: 'profile-1283',
      conversationUrl: ownedUrl,
      marker,
      sendCount: 1,
    })!;
    const absent = await cancelOwnedGenerationFromReceipt(receipt, 'cdp', {
      connect: vi.fn(async () => ({})),
      releaseBrowser: vi.fn(async () => undefined),
      enumeratePages: vi.fn(async () => [page]),
      readUserMessages: vi.fn(async () => ({ messages: [], incomplete: false })),
      stop,
    });
    expect(absent.identityProven).toBe(false);
    expect(stop).not.toHaveBeenCalled();

    const ambiguous = await cancelOwnedGenerationFromReceipt(receipt, 'cdp', {
      connect: vi.fn(async () => ({})),
      releaseBrowser: vi.fn(async () => undefined),
      enumeratePages: vi.fn(async () => [page]),
      readUserMessages: vi.fn(async () => ({
        messages: [{ role: 'user' as const, text: `${marker} ${marker}` }],
        incomplete: false,
      })),
      stop,
    });
    expect(ambiguous.cause).toContain('identity_ambiguous');
    expect(stop).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
  });
});
''')

# Append production finalizer/entrypoint safety tests to tab lifecycle.
tab = 'scripts/chatgpt-browser-turn/tab-lifecycle.test.ts'
with Path(tab).open('a') as f:
    f.write(r'''

describe('Issue #1283 explicit Stop authority', () => {
  function nonOkResult() {
    return makeTurnResult({
      state: 'no_reply',
      scope: 'invocation',
      cause: 'observation_exhausted_no_resend',
      send_count: 1,
    });
  }

  it('does not Stop or close an unproven reachable page through runStateLightTurn', async () => {
    const stopClick = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const page = {
      isClosed: () => false,
      close,
      locator: () => ({
        count: vi.fn(async () => 1),
        first: () => ({ click: stopClick, waitFor: vi.fn(async () => undefined) }),
