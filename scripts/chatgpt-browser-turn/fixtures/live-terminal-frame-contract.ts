/**
 * Sanitized ordered live service-frame sequence captured before #996 fixture derivation.
 * User content and opaque identifiers are redacted; envelope kinds and relationships are preserved.
 */
export const LIVE_TERMINAL_FRAME_CONTRACT = [
  {
    type: 'input_message',
    input_message: { id: 'user-sanitized-12345678' },
  },
  {
    type: 'delta',
    v: {
      message: {
        id: 'asst-preamble-12345678',
        author: { role: 'assistant' },
        parent: 'user-sanitized-12345678',
        end_turn: false,
        metadata: { finish_details: { type: 'stop' } },
        content: { content_type: 'text', parts: ['Thinking...'] },
      },
    },
  },
  {
    type: 'patch',
    v: [
      {
        p: '/message/content/parts/0',
        o: 'append',
        v: ' still thinking',
      },
    ],
  },
  {
    type: 'delta',
    v: {
      message: {
        id: 'tool-handoff-12345678',
        author: { role: 'tool' },
        parent: 'asst-preamble-12345678',
        content: { content_type: 'execution_output', text: '[sanitized tool output]' },
      },
    },
  },
  {
    type: 'delta',
    v: {
      message: {
        id: 'asst-terminal-12345678',
        author: { role: 'assistant' },
        parent: 'tool-handoff-12345678',
        end_turn: true,
        metadata: { finish_details: { type: 'stop' } },
        content: { content_type: 'text', parts: ['Final answer body'] },
      },
    },
  },
  {
    type: 'message_stream_complete',
  },
] as const;

export const DELTA_ONLY_FRAME = {
  type: 'delta',
  v: {
    message: {
      id: 'asst-growing-12345678',
      author: { role: 'assistant' },
      parent: 'user-sanitized-12345678',
      end_turn: false,
      content: { content_type: 'text', parts: ['partial'] },
    },
  },
} as const;

export const PATCH_ONLY_FRAME = {
  type: 'patch',
  v: [{ p: '/message/content/parts/0', o: 'append', v: ' more' }],
} as const;

export const STREAM_COMPLETE_ONLY_FRAME = {
  type: 'message_stream_complete',
} as const;

export function framesToSseBody(frames: readonly Record<string, unknown>[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}`).join('\n');
}
