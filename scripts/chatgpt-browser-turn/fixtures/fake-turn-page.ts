import type { SemanticNode } from '../semantic.ts';

export interface FakeAssistantSpec {
  readonly id: string;
  readonly parent?: string;
  readonly text?: string;
  readonly textSequence?: readonly string[];
  readonly appearOnSend?: boolean;
}

export interface FakeTurnPageOptions {
  readonly dispatchCandidateIds?: readonly string[];
  readonly historicalResponseUserIds?: readonly string[];
  readonly foreignDomUserIds?: readonly string[];
  readonly assistantParent?: string;
  readonly assistantText?: string;
  readonly assistants?: readonly FakeAssistantSpec[];
  readonly serviceFrames?: readonly Record<string, unknown>[];
  readonly bodyText?: string;
  readonly alertText?: string;
  readonly alertAfterSend?: string;
  readonly composer?: boolean;
  readonly serviceObserveDispatch?: boolean;
}

function emptyLocator(): any {
  return {
    count: async () => 0,
    nth: () => emptyLocator(),
    getAttribute: async () => null,
    locator: () => emptyLocator(),
    first: () => emptyLocator(),
    innerText: async () => '',
    click: async () => {},
    evaluate: async () => [],
  };
}

function semanticNodesForText(text: string): SemanticNode[] {
  return text
    ? [{ type: 'paragraph', children: [{ type: 'text', text }] } satisfies SemanticNode]
    : [];
}

function messageLocator(
  role: 'user' | 'assistant',
  id: string,
  parent?: string,
  text = '',
  textSequence?: readonly string[],
): any {
  let sequenceIndex = 0;
  const currentText = () => {
    if (textSequence?.length) return textSequence[Math.min(sequenceIndex, textSequence.length - 1)] ?? '';
    return text;
  };
  return {
    __role: role,
    __id: id,
    advanceText: () => {
      if (textSequence && sequenceIndex < textSequence.length - 1) sequenceIndex++;
    },
    getAttribute: async (name: string) => {
      if (name === 'data-message-author-role') return role;
      if (name === 'data-message-id') return id;
      if (name === 'data-parent-message-id') return parent ?? null;
      return null;
    },
    locator: () => ({ first: () => ({ getAttribute: async () => null }) }),
    first: () => emptyLocator(),
    count: async () => 1,
    innerText: async () => currentText(),
    click: async () => {},
    evaluate: async () => semanticNodesForText(currentText()),
  };
}

function defaultTerminalFrames(userId: string, assistantId: string, parent: string): Record<string, unknown>[] {
  return [{
    type: 'delta',
    v: {
      message: {
        id: assistantId,
        author: { role: 'assistant' },
        parent,
        end_turn: true,
        metadata: { finish_details: { type: 'stop' } },
      },
    },
  }];
}

export function fakeTurnPage(options: FakeTurnPageOptions = {}): { page: any; getSendClicks: () => number } {
  const handlers = new Map<string, Array<(event: any) => unknown>>();
  const wsHandlers: Array<(event: { response?: { payloadData?: string } }) => unknown> = [];
  const messages: any[] = [];
  let sendClicks = 0;
  let sent = false;
  const dispatchIds = [...(options.dispatchCandidateIds ?? ['user-owned-12345678'])];
  const composerPresent = options.composer !== false;

  const emit = async (event: string, payload: any): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) await handler(payload);
  };

  const emitServiceFrames = async (frames: readonly Record<string, unknown>[]): Promise<void> => {
    const body = frames.map((frame) => `data: ${JSON.stringify(frame)}`).join('\n');
    await emit('response', {
      url: () => 'https://chatgpt.com/backend-api/conversation',
      text: async () => body,
    });
    for (const frame of frames) {
      for (const handler of wsHandlers) {
        await handler({ response: { payloadData: JSON.stringify(frame) } });
      }
    }
  };

  const assistantSpecs: FakeAssistantSpec[] = options.assistants
    ? [...options.assistants]
    : options.assistantParent
      ? [{
        id: 'assistant-owned-12345678',
        parent: options.assistantParent,
        text: options.assistantText ?? 'assistant reply',
        appearOnSend: true,
      }]
      : [];

  const send = {
    ...emptyLocator(),
    count: async () => 1,
    click: async () => {
      sendClicks++;
      sent = true;
      for (const id of options.historicalResponseUserIds ?? []) {
        await emit('response', {
          url: () => 'https://chatgpt.com/backend-api/conversation/history',
          text: async () => JSON.stringify({ message: { id, author: { role: 'user' } } }),
        });
      }
      for (const id of dispatchIds) {
        await emit('request', {
          url: () => 'https://chatgpt.com/backend-api/conversation',
          postData: () => JSON.stringify({ messages: [{ id, author: { role: 'user' } }] }),
        });
      }
      if (options.serviceObserveDispatch !== false) {
        for (const id of dispatchIds) messages.push(messageLocator('user', id));
      }
      for (const id of options.foreignDomUserIds ?? []) messages.push(messageLocator('user', id));
      for (const spec of assistantSpecs) {
        if (spec.appearOnSend !== false) {
          messages.push(messageLocator('assistant', spec.id, spec.parent, spec.text ?? '', spec.textSequence));
        }
      }
      const frames = options.serviceFrames
        ?? (options.assistantParent
          ? defaultTerminalFrames(dispatchIds[0] ?? 'user-owned-12345678', 'assistant-owned-12345678', options.assistantParent)
          : []);
      if (frames.length > 0) await emitServiceFrames(frames);
    },
  };

  const selectMessages = (role: 'user' | 'assistant') => {
    const selected = messages.filter((message) => message.__role === role);
    return { count: async () => selected.length, nth: (index: number) => selected[index] ?? emptyLocator() };
  };

  const page = {
    context: () => ({
      newCDPSession: async () => ({
        send: async () => {},
        on: (event: string, handler: (value: { response?: { payloadData?: string } }) => unknown) => {
          if (event === 'Network.webSocketFrameReceived') wsHandlers.push(handler);
        },
      }),
    }),
    on: (event: string, handler: (value: any) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    url: () => 'https://chatgpt.com/c/example',
    locator: (selector: string) => {
      if (selector === '#prompt-textarea') return { ...emptyLocator(), count: async () => composerPresent ? 1 : 0, click: async () => {} };
      if (selector === '[data-testid="send-button"]') return send;
      if (selector === '[data-testid="stop-button"]') return emptyLocator();
      if (selector === '[data-message-author-role]') return { count: async () => messages.length, nth: (index: number) => messages[index] ?? emptyLocator() };
      if (selector === '[data-message-author-role="user"]') return selectMessages('user');
      if (selector === '[data-message-author-role="assistant"]') return selectMessages('assistant');
      if (selector === '[role="alert"]') {
        const text = sent && options.alertAfterSend ? options.alertAfterSend : options.alertText;
        if (!text) return emptyLocator();
        return { count: async () => 1, nth: () => ({ ...emptyLocator(), innerText: async () => text }) };
      }
      if (selector === 'body') return { ...emptyLocator(), innerText: async () => options.bodyText ?? '' };
      return emptyLocator();
    },
    keyboard: { press: async () => {}, insertText: async () => {} },
    waitForTimeout: async () => {
      for (const message of messages) message.advanceText?.();
    },
    getByText: () => emptyLocator(),
    addAssistant: (spec: FakeAssistantSpec) => {
      messages.push(messageLocator('assistant', spec.id, spec.parent, spec.text ?? '', spec.textSequence));
    },
    emitServiceFrames,
  };

  return { page, getSendClicks: () => sendClicks };
}

export { emptyLocator, messageLocator };
