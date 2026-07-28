import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeTurnPage } from '../chatgpt-browser-turn/fixtures/fake-turn-page.ts';
import { __testTiming, sendTurn, type BrowserConfig } from '../chatgpt-browser-turn/ui-adapter.ts';

const issue1025Cdp = 'http://127.0.0.1:9222';
const issue1025RepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const issue1025CompleteObservation = {
  httpContextCoverage: 'complete' as const,
  websocketTargetsCoverage: 'complete' as const,
};

const issue1025BaseConfig = (overrides: Partial<BrowserConfig> = {}): BrowserConfig => ({
  cdp: issue1025Cdp,
  profile: 'automation',
  chatUrl: 'https://chatgpt.com/c/example',
  newChat: false,
  timeoutMs: 60_000,
  ...overrides,
});

function issue1025ZeroActivityFixture(overrides: Parameters<typeof fakeTurnPage>[0] = {}) {
  return fakeTurnPage({
    dispatchCandidateIds: [],
    serviceObserveDispatch: false,
    serviceFrames: [],
    assistants: [],
    dispatchObservation: issue1025CompleteObservation,
    ...overrides,
  });
}

async function issue1025ExhaustSubmittedTurnWindow(
  fixture: ReturnType<typeof fakeTurnPage>,
  config: BrowserConfig = issue1025BaseConfig(),
) {
  fixture.page.waitForTimeout = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  const turn = sendTurn(fixture.page, 'payload', config);
  await vi.advanceTimersByTimeAsync(31_000);
  return turn;
}

describe('issue 1025 Half A proven non-delivery', () => {
  afterEach(() => {
    __testTiming.now = undefined;
    vi.useRealTimers();
  });

  it('AC1 returns send_failed dispatch_request_not_issued after full window with complete boundary and zero activity', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture();
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);

    expect(result).toEqual({
      state: 'send_failed',
      cause: 'dispatch_request_not_issued',
      possibleDelivery: false,
    });
  });

  it('AC1 new-chat URL transition without recognized submission remains proven non-delivery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      newChatUrlAfterArm: 'https://chatgpt.com/c/new-conversation',
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture, {
      cdp: issue1025Cdp,
      profile: 'automation',
      newChat: true,
      projectUrl: 'https://chatgpt.com/',
      timeoutMs: 60_000,
    });

    expect(result.state).toBe('send_failed');
    expect(result.cause).toBe('dispatch_request_not_issued');
    expect(result.possibleDelivery).toBe(false);
  });

  it('AC2 allows proven non-delivery when post-arm context HTTP is not a recognized submission', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      postArmContextRequests: [{ url: 'https://example.com/any-path' }],
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);

    expect(result).toEqual({
      state: 'send_failed',
      cause: 'dispatch_request_not_issued',
      possibleDelivery: false,
    });
  });

  it('AC2 allows proven non-delivery when service-worker-owned HTTP is not a recognized submission', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      serviceWorkerHttpAfterArm: [{ url: 'https://chatgpt.com/sw-owned-request' }],
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('dispatch_request_not_issued');
    expect(result.possibleDelivery).toBe(false);
  });

  it('AC2 allows proven non-delivery when outbound WebSocket frames are not recognized submissions', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      postArmWebSocketSent: [{}],
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('dispatch_request_not_issued');
    expect(result.possibleDelivery).toBe(false);
  });

  it('AC2 DOM-only user nodes without recognized submission remain proven non-delivery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      postArmUserDomIds: ['user-new-dom-12345678'],
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('dispatch_request_not_issued');
    expect(result.possibleDelivery).toBe(false);
  });

  it('AC2 unreadable DOM service ids without recognized submission remain proven non-delivery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      preDispatchUserDomIds: ['short'],
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);

    expect(result.state).toBe('send_failed');
    expect(result.cause).toBe('dispatch_request_not_issued');
    expect(result.possibleDelivery).toBe(false);
  });


  it('AC2 fails closed when request-observer coverage is not proven even if WebSocket witnessInstall completes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      requestObserverCoverage: 'incomplete',
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);

    expect(result.state).toBe('recovery_required');
    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC3 unknown HTTP context coverage performs zero send before dispatch boundary', async () => {
    const fixture = issue1025ZeroActivityFixture({
      dispatchObservation: {
        ...issue1025CompleteObservation,
        httpContextCoverage: 'unknown',
      },
    });
    await expect(sendTurn(fixture.page, 'payload', issue1025BaseConfig())).rejects.toThrow('dispatch_observation_establishment_failed');
    expect(fixture.getSendClicks()).toBe(0);
  });

  it('AC3 incomplete websocket target coverage performs zero send before dispatch boundary', async () => {
    const fixture = issue1025ZeroActivityFixture({
      dispatchObservation: {
        ...issue1025CompleteObservation,
        websocketTargetsCoverage: 'incomplete',
      },
    });
    await expect(sendTurn(fixture.page, 'payload', issue1025BaseConfig())).rejects.toThrow('dispatch_observation_establishment_failed');
    expect(fixture.getSendClicks()).toBe(0);
  });

  it('AC2 forbids proven non-delivery before submitted-turn window exhaustion', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture();
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const turn = sendTurn(fixture.page, 'payload', issue1025BaseConfig());
    await vi.advanceTimersByTimeAsync(5_000);
    const early = await Promise.race([
      turn.then((value) => ({ done: true as const, value })),
      Promise.resolve({ done: false as const }),
    ]);
    expect(early.done).toBe(false);
    await vi.advanceTimersByTimeAsync(26_000);
    const result = await turn;
    expect(result.cause).toBe('dispatch_request_not_issued');
  });

  it('AC3 recognized submission request issuance blocks proven non-delivery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = fakeTurnPage({
      dispatchCandidateIds: ['user-owned-12345678'],
      serviceObserveDispatch: false,
      serviceFrames: [],
      assistants: [],
      dispatchObservation: issue1025CompleteObservation,
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);
    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC4 post-boundary coverage loss remains possible-delivery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      dispatchObservation: {
        ...issue1025CompleteObservation,
        coverageLossAfterArm: true,
      },
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);
    expect(result.state).toBe('recovery_required');
    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC3 pre-dispatch observer establishment failure performs zero send', async () => {
    const fixture = issue1025ZeroActivityFixture({
      dispatchObservation: { establishmentFails: true },
    });
    await expect(sendTurn(fixture.page, 'payload', issue1025BaseConfig())).rejects.toThrow('dispatch_observation_establishment_failed');
    expect(fixture.getSendClicks()).toBe(0);
  });

});



describe('issue 1025 Half B finished reply without terminal', () => {
  const own = 'user-owned-12345678';
  const assistantId = 'assistant-owned-12345678';

  function finishedReplyFixture(overrides: Parameters<typeof fakeTurnPage>[0] = {}) {
    return fakeTurnPage({
      dispatchCandidateIds: [own],
      serviceFrames: [
        {
          type: 'input_message',
          input_message: {
            id: own,
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['payload'] },
          },
        },
        {
          message: {
            id: assistantId,
            author: { role: 'assistant' },
            parent: own,
            content: { content_type: 'text', parts: ['finished reply text'] },
          },
        },
      ],
      assistants: [{
        id: assistantId,
        parent: own,
        text: 'finished reply text',
        streaming: false,
      }],
      ...overrides,
    });
  }

  it('AC5 exits promptly as recovery_required reply_finished_terminal_unproven without publication', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = finishedReplyFixture();
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const started = Date.now();
    const turn = sendTurn(fixture.page, 'payload', { ...issue1025BaseConfig(), timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await turn;
    expect(result).toMatchObject({
      state: 'recovery_required',
      cause: 'reply_finished_terminal_unproven',
      possibleDelivery: true,
      userMessageId: own,
      assistantMessageId: assistantId,
    });
    expect(result.reply).toBeUndefined();
    expect(Date.now() - started).toBeLessThanOrEqual(30_000);
  });

  it('AC6 stable text with active generation UI does not early-exit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = finishedReplyFixture({
      assistants: [{
        id: assistantId,
        parent: own,
        text: 'finished reply text',
        streaming: true,
      }],
    });
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const turn = sendTurn(fixture.page, 'payload', { ...issue1025BaseConfig(), timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_100);
    const result = await turn;
    expect(result.cause).not.toBe('reply_finished_terminal_unproven');
    expect(result.state).toBe('stream_timeout');
  });

  it('AC7 suppresses finished-reply diagnosis while awaiting fresh terminal after continuation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = finishedReplyFixture({
      continueGenerating: {
        hideAfterClick: true,
        growthSequence: ['finished reply text'],
      },
    });
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const turn = sendTurn(fixture.page, 'payload', { ...issue1025BaseConfig(), timeoutMs: 8_000 });
    await vi.advanceTimersByTimeAsync(8_100);
    const result = await turn;
    expect(result.cause).not.toBe('reply_finished_terminal_unproven');
  });

  it('AC8 foreign user activity wins before finished-reply diagnosis', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = finishedReplyFixture({
      foreignDomUserIds: ['foreign-user-12345678'],
    });
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const turn = sendTurn(fixture.page, 'payload', { ...issue1025BaseConfig(), timeoutMs: 8_000 });
    await vi.advanceTimersByTimeAsync(8_100);
    const result = await turn;
    expect(result.state).toBe('foreign_activity');
    expect(result.cause).not.toBe('reply_finished_terminal_unproven');
  });
});

describe('issue 1025 gate-B characterization notes', () => {
  it('documents live boundary probes required on supported Chromium/Playwright runtime', () => {
    const notes = readFileSync(
      join(issue1025RepoRoot, 'scripts/chatgpt-browser-turn/README.md'),
      'utf8',
    );
    expect(notes).toContain('service-worker-owned HTTP');
    expect(notes).toContain('worker/secondary-target outbound WebSocket');
    expect(notes).toContain('dispatch_request_not_issued');
    expect(notes).toContain('gate-b-characterization');
  });

  it('ships the Gate-B live characterization probe module', async () => {
    const module = await import('../chatgpt-browser-turn/dispatch-observation.ts');
    expect(module.GATE_B_REQUIRED_PROBES).toEqual([
      'service-worker-owned-http-on-configured-context',
      'worker-or-secondary-target-websocket-frame-sent',
    ]);
    const summary = module.summarizeGateBCharacterization([
      {
        probe: 'service-worker-owned-http-on-configured-context',
        observed: true,
        detail: 'context_request_observed',
      },
      {
        probe: 'worker-or-secondary-target-websocket-frame-sent',
        observed: false,
        detail: 'pending_live_run',
      },
    ]);
    expect(summary.complete).toBe(false);
  });

  it('persists and reloads Gate-B characterization records per configured profile', async () => {
    const module = await import('../chatgpt-browser-turn/dispatch-observation.ts');
    const profileKey = 'profile-test-gate-b-record';
    const complete = module.bindGateBCharacterizationRecord(
      module.summarizeGateBCharacterization([
        {
          probe: 'service-worker-owned-http-on-configured-context',
          observed: true,
          detail: 'context_request_observed',
        },
        {
          probe: 'worker-or-secondary-target-websocket-frame-sent',
          observed: true,
          detail: 'websocket_frame_sent_observed',
        },
      ]),
      profileKey,
      issue1025Cdp,
    );
    module.writeGateBCharacterizationRecord(profileKey, complete);
    expect(module.readGateBCharacterizationRecord(profileKey, issue1025Cdp)?.complete).toBe(true);
    expect(module.readGateBCharacterizationRecord(profileKey, 'http://127.0.0.1:9223')).toBeNull();
  });
});
