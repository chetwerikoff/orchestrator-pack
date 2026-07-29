import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runProcessSync } from '../kernel/subprocess.ts';
import {
  LIVE_TERMINAL_FRAME_CONTRACT,
} from '../chatgpt-browser-turn/fixtures/live-terminal-frame-contract.ts';
import { fakeTurnPage } from '../chatgpt-browser-turn/fixtures/fake-turn-page.ts';
import { liveTurnStreamSequence } from '../chatgpt-browser-turn/fixtures/live-turn-stream-contract.ts';
import {
  createTerminalWitnessState,
  ingestServicePayload,
  resolveWholeTurnTerminal,
} from '../chatgpt-browser-turn/terminal-witness.ts';
import { performance } from 'node:perf_hooks';
import { destinationIdentity, reserveDestination } from '../chatgpt-browser-turn/coordination.ts';
import { turnExitCode } from '../chatgpt-browser-turn/contracts.ts';
import { readStableInput } from '../chatgpt-browser-turn/input.ts';
import { configuredProfileKey } from '../chatgpt-browser-turn/storage-common.ts';
import { __testTiming, sendTurn, type BrowserConfig } from '../chatgpt-browser-turn/ui-adapter.ts';

const baseConfig = (): BrowserConfig => ({
  cdp: 'http://127.0.0.1:9222',
  profile: 'automation',
  chatUrl: 'https://chatgpt.com/c/example',
  newChat: false,
  timeoutMs: 5_000,
});


function streamItemEnvelope(encodedItem: string, turnId = '858e210d-d54e-44c9-a51b-4e4e13e8dadc'): Record<string, unknown> {
  return {
    type: 'message',
    topic_id: `conversation-turn-${turnId}`,
    payload: {
      type: 'conversation-turn-stream',
      payload: {
        type: 'stream-item',
        conversation_id: '6a65acd9-4d44-83ec-bcb9-5787832fac24',
        turn_id: turnId,
        encoded_item: encodedItem,
      },
    },
  };
}

function livePatchTerminalFrames(
  own: string,
  assistantId: string,
  turnExchangeId: string,
): Record<string, unknown>[] {
  return [
    streamItemEnvelope(`data: {"type":"input_message","input_message":{"id":"${own}","metadata":{"turn_exchange_id":"${turnExchangeId}"}}}\n\n`),
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
    const turnExchangeId = 'exchange-stream-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [],
      turnExchangeId,
      serviceObserveDispatch: false,
      serviceFrames: livePatchTerminalFrames(own, assistantId, turnExchangeId),
      assistants: [
        { id: assistantId, parent: own, text: 'Final answer body', appearOnSend: true },
      ],
    });

    const result = await sendTurn(fixture.page, 'payload', baseConfig());

    expect(result.state).toBe('ok');
    expect(result.userMessageId).toBe(own);
    expect(result.assistantMessageId).toBe(assistantId);
  });

  it('AC1 proves submission from live wire shape without turn_exchange_id', async () => {
    const own = 'f74acde1-6ff9-4344-9794-339846ab7d57';
    const assistantId = 'asst-live-wire-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      serviceObserveDispatch: false,
      serviceFrames: [
        streamItemEnvelope(`data: {"type":"input_message","input_message":{"id":"${own}","metadata":{"selected_sources":[],"serialization_metadata":{"custom_symbol_offsets":[]}}}}\n\n`),
        streamItemEnvelope(`data: {"type":"message_marker","message_id":"${assistantId}","marker":"user_visible_token","event":"first"}\n\n`),
        streamItemEnvelope([
          'event: delta',
          `data: {"p":"","o":"add","v":{"message":{"id":"${assistantId}","author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]}}}}`,
          '',
        ].join('\n')),
        streamItemEnvelope([
          'event: delta',
          'data: {"p":"/message/content/parts/0","o":"append","v":"OK"}',
          '',
        ].join('\n')),
        streamItemEnvelope([
          'event: delta',
          'data: {"p":"","o":"patch","v":[{"p":"/message/end_turn","o":"replace","v":true},{"p":"/message/metadata","o":"append","v":{"finish_details":{"type":"stop"}}}]}',
          '',
        ].join('\n')),
      ],
      assistants: [
        { id: assistantId, parent: own, text: 'OK', appearOnSend: true },
      ],
    });

    const result = await sendTurn(fixture.page, 'payload', baseConfig());

    expect(result.state).toBe('ok');
    expect(result.userMessageId).toBe(own);
    expect(result.assistantMessageId).toBe(assistantId);
  });

  it('AC2 preserves terminal metadata carried directly on an attributed assistant add', async () => {
    const own = 'user-add-terminal-12345678';
    const assistantId = 'asst-add-terminal-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      serviceObserveDispatch: false,
      serviceFrames: [
        streamItemEnvelope(`data: {"type":"input_message","input_message":{"id":"${own}","metadata":{"selected_sources":[]}}}\n\n`),
        streamItemEnvelope([
          'event: delta',
          `data: {"p":"","o":"add","v":{"message":{"id":"${assistantId}","author":{"role":"assistant"},"parent":"${own}","end_turn":true,"status":"finished_successfully","metadata":{"finish_details":{"type":"stop"}},"content":{"content_type":"text","parts":["OK"]}}}}`,
          '',
        ].join('\n')),
      ],
      assistants: [
        { id: assistantId, parent: own, text: 'OK', appearOnSend: true },
      ],
    });

    const result = await sendTurn(fixture.page, 'payload', baseConfig());

    expect(result.state).toBe('ok');
    expect(result.userMessageId).toBe(own);
    expect(result.assistantMessageId).toBe(assistantId);
  });

  it('AC1 promotes pending input_message after delayed outbound request witness', async () => {
    const own = 'user-delay-req-12345678';
    const assistantId = 'asst-delay-req-12345678';
    const turnId = '858e210d-d54e-44c9-a51b-delayreq01';
    const delayedFrames = liveTurnStreamSequence(own, assistantId, { turnId }, { replyText: 'OK' });
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [],
      serviceObserveDispatch: false,
      serviceFrames: [],
      postClickRequests: [{ userId: own }],
      postClickServiceFrames: delayedFrames,
      assistants: [
        { id: assistantId, parent: own, text: 'OK', appearOnSend: true },
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
    const turnExchangeId = 'exchange-correl-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [provisional],
      turnExchangeId,
      serviceObserveDispatch: false,
      serviceFrames: [
        { type: 'input_message', input_message: { id: service, metadata: { turn_exchange_id: turnExchangeId } } },
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
      __testTiming.now = () => Date.now();
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
      __testTiming.now = undefined;
      vi.useRealTimers();
    }
  });

  it('AC3/AC5 separates result production, caller stdout visibility, and process exit (#1007)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-1010-ac3-'));
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    const marksFile = join(root, 'marks.json');
    writeFileSync(input, 'payload\n');
    const profilePath = join(root, 'profile');
    const fixtureEntry = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'chatgpt-browser-turn-ac3-timing.ts');
    const observed = runProcessSync({
      command: process.execPath,
      args: [
        '--experimental-strip-types',
        fixtureEntry,
        '--profile', profilePath,
        '--cdp', 'http://127.0.0.1:9222',
        '--input', input,
        '--output', output,
        '--chat-url', 'https://chatgpt.com/c/ac3-timing',
      ],
      cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
      inheritParentEnv: true,
      env: {
        CHATGPT_BROWSER_TURN_STATE_DIR: join(root, 'state'),
        CHATGPT_BROWSER_TURN_AC3_MARKS_FILE: marksFile,
      },
    });
    expect(observed.exitCode).toBe(11);
    const stdoutLine = observed.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    const body = JSON.parse(stdoutLine) as { cause: string };
    expect(body.cause).toBe('submitted_turn_id_unproven');
    const marks = JSON.parse(readFileSync(marksFile, 'utf8')) as {
      result_produced_ms: number;
      stdout_written_ms: number;
    };
    expect(marks.stdout_written_ms - marks.result_produced_ms).toBeGreaterThanOrEqual(0);
    expect(marks.stdout_written_ms - marks.result_produced_ms).toBeLessThan(1_500);
  });


  it('AC5 rejects foreign request turn_exchange_id during dispatch click', async () => {
    const turnExchangeId = 'exchange-owned-12345678';
    const foreignExchange = 'exchange-foreign-12345678';
    const foreignUser = 'user-foreign-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [],
      turnExchangeId,
      serviceObserveDispatch: false,
      preClickRequests: [{ turnExchangeId: foreignExchange, userId: foreignUser }],
      preDispatchServiceFrames: [{
        type: 'input_message',
        input_message: { id: foreignUser, metadata: { turn_exchange_id: foreignExchange } },
      }],
      serviceFrames: [],
      assistants: [],
    });

    const result = await sendTurn(fixture.page, 'payload', baseConfig());

    expect(result.state).toBe('foreign_activity');
    expect(result.cause).toBe('submitted_turn_ambiguous');
    expect(result.userMessageId).toBeUndefined();
  });

  it('AC5 rejects foreign service input_message on candidate-free dispatch path', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      __testTiming.now = () => Date.now();
      const turnExchangeId = 'exchange-owned-12345678';
      const foreign = 'user-foreign-12345678';
      const fixture = fakeTurnPage({
        dispatchCandidateIds: [],
        turnExchangeId,
        serviceObserveDispatch: false,
        preDispatchServiceFrames: [{ type: 'input_message', input_message: { id: foreign } }],
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
      expect(result.userMessageId).toBeUndefined();
    } finally {
      __testTiming.now = undefined;
      vi.useRealTimers();
    }
  });

  it('AC5 rejects foreign service input_message while submitted turn stays unproven', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      __testTiming.now = () => Date.now();
      const provisional = 'user-provis-12345678';
      const foreign = 'user-foreign-12345678';
      const fixture = fakeTurnPage({
        dispatchCandidateIds: [provisional],
        serviceObserveDispatch: false,
        preDispatchServiceFrames: [{ type: 'input_message', input_message: { id: foreign } }],
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
      expect(result.userMessageId).toBeUndefined();
    } finally {
      __testTiming.now = undefined;
      vi.useRealTimers();
    }
  });

  it('AC5 rejects foreign service after unobservable own dispatch request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      __testTiming.now = () => Date.now();
      const turnExchangeId = 'exchange-owned-12345678';
      const foreignExchange = 'exchange-foreign-12345678';
      const foreignUser = 'user-foreign-12345678';
      const fixture = fakeTurnPage({
        dispatchCandidateIds: [],
        turnExchangeId,
        serviceObserveDispatch: false,
        serviceFrames: [],
        postClickRequests: [{ turnExchangeId: foreignExchange, userId: foreignUser }],
        postClickServiceFrames: [{
          type: 'input_message',
          input_message: { id: foreignUser, metadata: { turn_exchange_id: foreignExchange } },
        }],
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
      expect(result.userMessageId).toBeUndefined();
    } finally {
      __testTiming.now = undefined;
      vi.useRealTimers();
    }
  });

  it('AC2 ignores foreign streaming patch terminalization on a different turn topic', async () => {
    const own = 'user-owned-12345678';
    const foreignAssistant = 'asst-foreign-12345678';
    const ownTurnId = 'turn-owned-12345678';
    const foreignTurnId = 'turn-foreign-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      serviceObserveDispatch: false,
      serviceFrames: [
        streamItemEnvelope(`data: {"type":"input_message","input_message":{"id":"${own}","metadata":{"selected_sources":[]}}}

`, ownTurnId),
        streamItemEnvelope([
          `data: {"type":"message_marker","message_id":"${foreignAssistant}","marker":"user_visible_token","event":"first"}`,
          'event: delta',
          'data: {"p":"","o":"patch","v":[{"p":"/message/end_turn","o":"replace","v":true},{"p":"/message/metadata","o":"append","v":{"finish_details":{"type":"stop"}}}]}',
          '',
        ].join('\n'), foreignTurnId),
      ],
      assistants: [],
    });

    const result = await sendTurn(fixture.page, 'payload', baseConfig());

    expect(result.state).not.toBe('ok');
    expect(result.assistantMessageId).not.toBe(foreignAssistant);
  });



  it('AC2 accepts raw SSE positional terminal patch after attributed assistant add', async () => {
    const own = 'user-sse-patch-12345678';
    const assistantId = 'asst-sse-patch-12345678';
    const rawSseBody = [
      `data: {"type":"input_message","input_message":{"id":"${own}","metadata":{"selected_sources":[]}}}`,
      '',
      'event: delta',
      `data: {"p":"","o":"add","v":{"message":{"id":"${assistantId}","author":{"role":"assistant"},"parent":"${own}","content":{"content_type":"text","parts":["OK"]}}}}`,
      '',
      'event: delta',
      `data: {"p":"","o":"patch","v":[{"p":"/message/end_turn","o":"replace","v":true},{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/metadata","o":"append","v":{"finish_details":{"type":"stop"}}}]}`,
      '',
    ].join('\n');
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      serviceObserveDispatch: false,
      serviceFrames: [],
      postClickRawSseBodies: [rawSseBody],
      assistants: [
        { id: assistantId, parent: own, text: 'OK', appearOnSend: true },
      ],
    });

    const result = await sendTurn(fixture.page, 'payload', baseConfig());

    expect(result.state).toBe('ok');
    expect(result.userMessageId).toBe(own);
    expect(result.assistantMessageId).toBe(assistantId);
  });

  it('AC2 rejects foreign raw SSE positional patch after owned turn target is established', async () => {
    const own = 'user-sse-foreign-12345678';
    const assistantId = 'asst-sse-foreign-12345678';
    const ownTurnId = 'turn-sse-owned-12345678';
    const foreignPatchOnly = [
      'event: delta',
      `data: {"p":"","o":"patch","v":[{"p":"/message/end_turn","o":"replace","v":true},{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/metadata","o":"append","v":{"finish_details":{"type":"stop"}}}]}`,
      '',
    ].join('\n');
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      serviceObserveDispatch: false,
      serviceFrames: [
        streamItemEnvelope(`data: {"type":"input_message","input_message":{"id":"${own}","metadata":{"selected_sources":[]}}}\n\n`, ownTurnId),
        streamItemEnvelope(`data: {"type":"message_marker","message_id":"${assistantId}","marker":"user_visible_token","event":"first"}\n\n`, ownTurnId),
        streamItemEnvelope([
          'event: delta',
          'data: {"p":"/message/content/parts/0","o":"append","v":"OK"}',
          '',
        ].join('\n'), ownTurnId),
        streamItemEnvelope([
          'event: delta',
          `data: {"p":"","o":"patch","v":[{"p":"/message/end_turn","o":"replace","v":true},{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/metadata","o":"append","v":{"finish_details":{"type":"stop"}}}]}`,
          '',
        ].join('\n'), ownTurnId),
      ],
      postClickRawSseBodies: [foreignPatchOnly],
      assistants: [
        { id: assistantId, parent: own, text: 'OK', appearOnSend: true },
      ],
    });

    const result = await sendTurn(fixture.page, 'payload', baseConfig());

    expect(result.state).toBe('ok');
    expect(result.assistantMessageId).toBe(assistantId);
  });

  it('AC2 rejects foreign positional terminal patch after owned marker and append', async () => {
    const own = 'user-owned-patch-12345678';
    const assistantId = 'asst-owned-patch-12345678';
    const ownTurnId = 'turn-owned-patch-12345678';
    const foreignTurnId = 'turn-foreign-patch-1234567';
    const terminalPatchJson = '[{"p":"/message/end_turn","o":"replace","v":true},{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/metadata","o":"append","v":{"finish_details":{"type":"stop"}}}]';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      serviceObserveDispatch: false,
      serviceFrames: [
        streamItemEnvelope(`data: {"type":"input_message","input_message":{"id":"${own}","metadata":{"selected_sources":[]}}}

`, ownTurnId),
        streamItemEnvelope(`data: {"type":"message_marker","message_id":"${assistantId}","marker":"user_visible_token","event":"first"}

`, ownTurnId),
        streamItemEnvelope([
          'event: delta',
          'data: {"p":"/message/content/parts/0","o":"append","v":"OK"}',
          '',
        ].join('\n'), ownTurnId),
        streamItemEnvelope([
          'event: delta',
          `data: {"p":"","o":"patch","v":${terminalPatchJson}}`,
          '',
        ].join('\n'), foreignTurnId),
        streamItemEnvelope([
          'event: delta',
          `data: {"p":"","o":"patch","v":${terminalPatchJson}}`,
          '',
        ].join('\n'), ownTurnId),
      ],
      assistants: [
        { id: assistantId, parent: own, text: 'OK', appearOnSend: true },
      ],
    });

    const result = await sendTurn(fixture.page, 'payload', baseConfig());

    expect(result.state).toBe('ok');
    expect(result.userMessageId).toBe(own);
    expect(result.assistantMessageId).toBe(assistantId);
  });

  it('AC2 accepts live wire turn stream with add-less answer delta and id-less terminal patch', async () => {
    const own = 'user-livewire-12345678';
    const assistantId = 'asst-livewire-12345678';
    const turnId = '858e210d-d54e-44c9-a51b-4e4e13e8dadc';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      serviceObserveDispatch: false,
      serviceFrames: liveTurnStreamSequence(own, assistantId, { turnId }, { replyText: 'OK' }),
      assistants: [
        { id: assistantId, parent: own, text: 'OK', appearOnSend: true },
      ],
    });

    const result = await sendTurn(fixture.page, 'payload', baseConfig());

    expect(result.state).toBe('ok');
    expect(result.userMessageId).toBe(own);
    expect(result.assistantMessageId).toBe(assistantId);
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

});
