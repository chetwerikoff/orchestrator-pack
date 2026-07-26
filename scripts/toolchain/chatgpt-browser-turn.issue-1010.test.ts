import { describe, expect, it, vi } from 'vitest';
import {
  LIVE_TERMINAL_FRAME_CONTRACT,
} from '../chatgpt-browser-turn/fixtures/live-terminal-frame-contract.ts';
import { fakeTurnPage } from '../chatgpt-browser-turn/fixtures/fake-turn-page.ts';
import {
  createTerminalWitnessState,
  ingestServicePayload,
  resolveWholeTurnTerminal,
} from '../chatgpt-browser-turn/terminal-witness.ts';
import { sendTurn, type BrowserConfig } from '../chatgpt-browser-turn/ui-adapter.ts';

const baseConfig = (): BrowserConfig => ({
  cdp: 'http://127.0.0.1:9222',
  profile: 'automation',
  chatUrl: 'https://chatgpt.com/c/example',
  newChat: false,
  timeoutMs: 5_000,
});


function streamItemEnvelope(encodedItem: string): Record<string, unknown> {
  return {
    type: 'message',
    payload: {
      type: 'conversation-turn-stream',
      payload: {
        type: 'stream-item',
        encoded_item: encodedItem,
      },
    },
  };
}

function livePatchTerminalFrames(own: string, assistantId: string): Record<string, unknown>[] {
  return [
    streamItemEnvelope(`data: {"type":"input_message","input_message":{"id":"${own}"}}\n\n`),
    streamItemEnvelope(`data: {"type":"message_marker","message_id":"${assistantId}","marker":"user_visible_token","event":"first"}\n\n`),
    streamItemEnvelope([
      'event: delta',
      `data: {"p":"","o":"add","v":{"message":{"id":"${assistantId}","author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]}}}}`,
      '',
    ].join('\n')),
    streamItemEnvelope([
      'event: delta',
      'data: {"p":"/message/content/parts/0","o":"append","v":"Final answer body"}',
      '',
    ].join('\n')),
    streamItemEnvelope([
      'event: delta',
      'data: {"p":"","o":"patch","v":[{"p":"/message/end_turn","o":"replace","v":true},{"p":"/message/metadata","o":"append","v":{"finish_details":{"type":"stop"}}}]}',
      '',
    ].join('\n')),
  ];
}

function terminalFramesForUser(own: string): Record<string, unknown>[] {
  return LIVE_TERMINAL_FRAME_CONTRACT.map((frame) => {
    if (frame.type === 'input_message') {
      return { ...frame, input_message: { id: own } };
    }
    if (frame.type === 'delta' && (frame.v as { message?: { id?: string } }).message?.id === 'asst-preamble-12345678') {
      return {
        ...frame,
        v: {
          message: {
            ...(frame.v as { message: Record<string, unknown> }).message,
            parent: own,
          },
        },
      };
    }
    return frame;
  }) as Record<string, unknown>[];
}

describe('issue 1010 submitted-turn proof', () => {
  it('AC1 proves submission from service input_message without DOM user mirror', async () => {
    const own = 'user-service-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      serviceObserveDispatch: false,
      serviceFrames: terminalFramesForUser(own),
      assistants: [
        { id: 'asst-preamble-12345678', parent: own, text: 'Thinking...', appearOnSend: true },
        { id: 'asst-terminal-12345678', parent: 'tool-handoff-12345678', text: 'Final answer body', appearOnSend: true },
      ],
    });

    const result = await sendTurn(fixture.page, 'payload', baseConfig());

    expect(result.state).toBe('ok');
    expect(result.userMessageId).toBe(own);
    expect(result.assistantMessageId).toBe('asst-terminal-12345678');
  });


  it('AC1 proves submission from nested stream-item envelopes without DOM user mirror', async () => {
    const own = 'user-stream-12345678';
    const assistantId = 'asst-stream-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [],
      serviceObserveDispatch: false,
      serviceFrames: livePatchTerminalFrames(own, assistantId),
      assistants: [
        { id: assistantId, parent: own, text: 'Final answer body', appearOnSend: true },
      ],
    });

    const result = await sendTurn(fixture.page, 'payload', baseConfig());

    expect(result.state).toBe('ok');
    expect(result.userMessageId).toBe(own);
    expect(result.assistantMessageId).toBe(assistantId);
  });

  it('AC1 correlates provisional request id with service input_message id', async () => {
    const provisional = 'user-provis-12345678';
    const service = 'user-service-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [provisional],
      serviceObserveDispatch: false,
      serviceFrames: [
        { type: 'input_message', input_message: { id: service } },
        ...terminalFramesForUser(service).slice(1),
      ],
      assistants: [
        { id: 'asst-preamble-12345678', parent: service, text: 'Thinking...', appearOnSend: true },
        { id: 'asst-terminal-12345678', parent: 'tool-handoff-12345678', text: 'Final answer body', appearOnSend: true },
      ],
    });

    const result = await sendTurn(fixture.page, 'payload', baseConfig());

    expect(result.state).toBe('ok');
    expect(result.userMessageId).toBe(service);
  });

  it('AC5 fail-closes unobservable submission within the bounded delivered window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fixture = fakeTurnPage({
        dispatchCandidateIds: [],
        serviceObserveDispatch: false,
        serviceFrames: [],
        assistants: [],
      });
      fixture.page.waitForTimeout = async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms);
      };
      const turn = sendTurn(fixture.page, 'payload', { ...baseConfig(), timeoutMs: 60_000 });
      await vi.advanceTimersByTimeAsync(31_000);
      const result = await turn;

      expect(result.state).toBe('recovery_required');
      expect(result.cause).toBe('submitted_turn_id_unproven');
      expect(result.possibleDelivery).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC3/AC5 separates time-to-result from process-exit dependency (#1007)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let detached = false;
    try {
      const fixture = fakeTurnPage({
        dispatchCandidateIds: [],
        serviceObserveDispatch: false,
        serviceFrames: [],
        assistants: [],
      });
      fixture.page.waitForTimeout = async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms);
      };
      const originalContext = fixture.page.context;
      fixture.page.context = () => ({
        newCDPSession: async () => ({
          send: async () => {},
          on: () => {},
          off: () => {},
          detach: async () => { detached = true; },
        }),
      });

      const turn = sendTurn(fixture.page, 'payload', { ...baseConfig(), timeoutMs: 60_000 });
      await vi.advanceTimersByTimeAsync(31_000);
      const result = await turn;
      fixture.page.context = originalContext;

      expect(result.cause).toBe('submitted_turn_id_unproven');
      expect(detached).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC2 terminal-node binding still selects the terminal assistant', () => {
    const own = 'user-owned-12345678';
    const witness = createTerminalWitnessState();
    for (const frame of terminalFramesForUser(own)) {
      ingestServicePayload(witness, frame);
    }
    expect(resolveWholeTurnTerminal(own, witness)).toEqual({
      state: 'success',
      assistantMessageId: 'asst-terminal-12345678',
    });
  });

  it('AC3 detaches CDP witness before sendTurn resolves so result is not blocked on process exit', async () => {
    let detached = false;
    const fixture = fakeTurnPage({
      dispatchCandidateIds: ['user-owned-12345678'],
      assistantParent: 'user-owned-12345678',
      assistantText: 'reply',
    });
    const originalContext = fixture.page.context;
    fixture.page.context = () => ({
      newCDPSession: async () => ({
        send: async () => {},
        on: () => {},
        off: () => {},
        detach: async () => { detached = true; },
      }),
    });

    const result = await sendTurn(fixture.page, 'payload', baseConfig());
    fixture.page.context = originalContext;

    expect(result.state).toBe('ok');
    expect(detached).toBe(true);
  });
});
