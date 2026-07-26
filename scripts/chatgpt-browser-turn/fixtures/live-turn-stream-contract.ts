export interface LiveTurnStreamIds {
  readonly turnId: string;
  readonly conversationId?: string;
}

export function liveTurnStreamEnvelope(
  encodedItem: string,
  ids: LiveTurnStreamIds,
): Record<string, unknown> {
  return {
    type: 'message',
    topic_id: `conversation-turn-${ids.turnId}`,
    payload: {
      type: 'conversation-turn-stream',
      payload: {
        type: 'stream-item',
        conversation_id: ids.conversationId ?? '6a65acd9-4d44-83ec-bcb9-5787832fac24',
        turn_id: ids.turnId,
        encoded_item: encodedItem,
      },
    },
  };
}

export function liveTurnStreamSequence(
  ownUserId: string,
  answerAssistantId: string,
  ids: LiveTurnStreamIds,
  options: {
    readonly internalAssistantId?: string;
    readonly reasoningId?: string;
    readonly replyText?: string;
  } = {},
): Record<string, unknown>[] {
  const internalId = options.internalAssistantId ?? 'asst-internal-12345678';
  const reasoningId = options.reasoningId ?? 'asst-reason-12345678';
  const replyText = options.replyText ?? 'OK';
  const dataLine = (body: Record<string, unknown>) => `data: ${JSON.stringify(body)}\n\n`;
  const deltaLine = (body: Record<string, unknown>) => ['event: delta', `data: ${JSON.stringify(body)}`, ''].join('\n');

  return [
    liveTurnStreamEnvelope(dataLine({
      type: 'input_message',
      input_message: { id: ownUserId, metadata: { selected_sources: [], serialization_metadata: { custom_symbol_offsets: [] } } },
    }), ids),
    liveTurnStreamEnvelope(deltaLine({
      p: '',
      o: 'add',
      v: {
        message: {
          id: internalId,
          author: { role: 'assistant' },
          content: { content_type: 'model_editable_context', model_set_context: '' },
        },
      },
    }), ids),
    liveTurnStreamEnvelope(dataLine({
      type: 'message_marker',
      message_id: reasoningId,
      marker: 'cot_token',
      event: 'first',
    }), ids),
    liveTurnStreamEnvelope(deltaLine({
      v: {
        message: {
          id: reasoningId,
          author: { role: 'assistant' },
          content: { content_type: 'reasoning_recap', content: '' },
          end_turn: false,
        },
      },
    }), ids),
    liveTurnStreamEnvelope(deltaLine({
      v: {
        message: {
          id: answerAssistantId,
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: [''] },
          status: 'in_progress',
        },
      },
    }), ids),
    liveTurnStreamEnvelope(dataLine({
      type: 'message_marker',
      message_id: answerAssistantId,
      marker: 'user_visible_token',
      event: 'first',
    }), ids),
    liveTurnStreamEnvelope(deltaLine({
      p: '/message/content/parts/0',
      o: 'append',
      v: replyText,
    }), ids),
    liveTurnStreamEnvelope(deltaLine({
      p: '',
      o: 'patch',
      v: [
        { p: '/message/status', o: 'replace', v: 'finished_successfully' },
        { p: '/message/end_turn', o: 'replace', v: true },
        { p: '/message/metadata', o: 'append', v: { finish_details: { type: 'stop' } } },
      ],
    }), ids),
    liveTurnStreamEnvelope(dataLine({
      type: 'message_marker',
      message_id: answerAssistantId,
      marker: 'last_token',
      event: 'last',
    }), ids),
    {
      type: 'message',
      topic_id: `conversation-turn-${ids.turnId}`,
      payload: { type: 'conversation-turn-complete' },
    },
  ];
}
