import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lastDispatchObservationDiagnostic,
} from '../chatgpt-browser-turn/dispatch-observation.ts';
import { fakeTurnPage } from '../chatgpt-browser-turn/fixtures/fake-turn-page.ts';
import { __testTiming, sendTurn, type BrowserConfig } from '../chatgpt-browser-turn/ui-adapter.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cdp = 'http://127.0.0.1:9222';

const completeObservation = {
  httpContextCoverage: 'complete' as const,
  websocketTargetsCoverage: 'complete' as const,
};

const baseConfig = (overrides: Partial<BrowserConfig> = {}): BrowserConfig => ({
  cdp,
  profile: 'automation',
  chatUrl: 'https://chatgpt.com/c/example',
  newChat: false,
  timeoutMs: 60_000,
  ...overrides,
});

function zeroActivityFixture(overrides: Parameters<typeof fakeTurnPage>[0] = {}) {
  return fakeTurnPage({
    dispatchCandidateIds: [],
    serviceObserveDispatch: false,
    serviceFrames: [],
    assistants: [],
    dispatchObservation: completeObservation,
    ...overrides,
  });
}

async function exhaustSubmittedTurnWindow(
  fixture: ReturnType<typeof fakeTurnPage>,
  config: BrowserConfig = baseConfig(),
) {
  fixture.page.waitForTimeout = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  const turn = sendTurn(fixture.page, 'payload', config);
  await vi.advanceTimersByTimeAsync(31_000);
  return turn;
}

function parseDiagnosticOperation(operation: string | undefined): DispatchObservationDiagnostic {
  expect(operation).toBeTruthy();
  return JSON.parse(operation!) as DispatchObservationDiagnostic;
}

describe('issue 1024 Half A proven non-delivery', () => {
  afterEach(() => {
    __testTiming.now = undefined;
    vi.useRealTimers();
  });

  it('AC1 returns send_failed dispatch_request_not_observed after full window with complete boundary and zero activity', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = zeroActivityFixture();
    const result = await exhaustSubmittedTurnWindow(fixture);

    expect(result).toEqual({
      state: 'send_failed',
      cause: 'dispatch_request_not_observed',
      possibleDelivery: false,
    });
    expect(lastDispatchObservationDiagnostic?.submitted_turn_window_exhausted).toBe(true);
    expect(lastDispatchObservationDiagnostic?.post_arm_http_request_count).toBe(0);
    expect(lastDispatchObservationDiagnostic?.post_arm_websocket_frame_sent_count).toBe(0);
    expect(lastDispatchObservationDiagnostic?.user_node_delta).toBe(0);
    expect(lastDispatchObservationDiagnostic?.new_chat_url_changed).toBe('na');
  });

  it('AC1 new-chat unchanged URL is required for proven non-delivery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = zeroActivityFixture({
      newChatUrlAfterArm: 'https://chatgpt.com/c/new-conversation',
    });
    const result = await exhaustSubmittedTurnWindow(fixture, {
      cdp,
      profile: 'automation',
      newChat: true,
      projectUrl: 'https://chatgpt.com/',
      timeoutMs: 60_000,
    });

    expect(result.state).toBe('recovery_required');
    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC2 blocks proven non-delivery for post-arm context HTTP regardless of origin', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = zeroActivityFixture({
      postArmContextRequests: [{ url: 'https://example.com/any-path' }],
    });
    const result = await exhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC2 blocks proven non-delivery for service-worker-owned HTTP on the context boundary', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = zeroActivityFixture({
      serviceWorkerHttpAfterArm: [{ url: 'https://chatgpt.com/sw-owned-request' }],
    });
    const result = await exhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC2 blocks proven non-delivery for outbound WebSocket frame on covered target', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = zeroActivityFixture({
      postArmWebSocketSent: [{}],
    });
    const result = await exhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC2 blocks proven non-delivery for new user DOM node beyond baseline', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = zeroActivityFixture({
      postArmUserDomIds: ['user-new-dom-12345678'],
    });
    const result = await exhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC2 blocks proven non-delivery when HTTP context coverage is unknown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = zeroActivityFixture({
      dispatchObservation: {
        ...completeObservation,
        httpContextCoverage: 'unknown',
      },
    });
    const result = await exhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC2 blocks proven non-delivery when websocket target coverage is incomplete', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = zeroActivityFixture({
      dispatchObservation: {
        ...completeObservation,
        websocketTargetsCoverage: 'incomplete',
      },
    });
    const result = await exhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC2 forbids proven non-delivery before submitted-turn window exhaustion', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = zeroActivityFixture();
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const turn = sendTurn(fixture.page, 'payload', baseConfig());
    await vi.advanceTimersByTimeAsync(5_000);
    const early = await Promise.race([
      turn.then((value) => ({ done: true as const, value })),
      Promise.resolve({ done: false as const }),
    ]);
    expect(early.done).toBe(false);
    await vi.advanceTimersByTimeAsync(26_000);
    const result = await turn;
    expect(result.cause).toBe('dispatch_request_not_observed');
  });

  it('AC2 late-window outbound HTTP still blocks proven non-delivery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = zeroActivityFixture({
      postArmContextRequests: [{ url: 'https://chatgpt.com/backend-api/f/conversation' }],
    });
    const result = await exhaustSubmittedTurnWindow(fixture);
    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC3 pre-dispatch observer establishment failure performs zero send', async () => {
    const fixture = zeroActivityFixture({
      dispatchObservation: { establishmentFails: true },
    });
    await expect(sendTurn(fixture.page, 'payload', baseConfig())).rejects.toThrow('dispatch_observation_establishment_failed');
    expect(fixture.getSendClicks()).toBe(0);
  });

  it('AC10 records body-free dispatch observation diagnostic fields', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = zeroActivityFixture();
    await exhaustSubmittedTurnWindow(fixture);
    const diagnostic = lastDispatchObservationDiagnostic;
    expect(diagnostic?.http_context_armed).toBe(true);
    expect(diagnostic?.websocket_targets_armed).toBe(true);
    expect(diagnostic?.coverage_summary).toContain('http-context:complete');
    expect(diagnostic?.coverage_summary).toContain('websocket-targets:complete');
    expect(JSON.stringify(diagnostic)).not.toMatch(/payload|reply|prompt/i);
  });

});

describe('issue 1024 gate-B characterization notes', () => {
  it('documents live boundary probes required on supported Chromium/Playwright runtime', () => {
    const notes = readFileSync(
      join(repoRoot, 'scripts/chatgpt-browser-turn/README.md'),
      'utf8',
    );
    expect(notes).toContain('service-worker-owned HTTP');
    expect(notes).toContain('worker/secondary-target outbound WebSocket');
    expect(notes).toContain('dispatch_request_not_observed');
  });
});
