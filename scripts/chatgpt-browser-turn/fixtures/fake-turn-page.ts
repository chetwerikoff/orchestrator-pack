import type { SemanticNode } from '../semantic.ts';

export interface FakeAssistantSpec {
  readonly id: string;
  readonly parent?: string;
  readonly text?: string;
  readonly textSequence?: readonly string[];
  readonly semanticNodes?: readonly SemanticNode[];
  readonly appearOnSend?: boolean;
}

export interface ContinueGeneratingSpec {
  readonly hideAfterClick?: boolean;
  readonly growthSequence?: readonly string[];
  readonly terminalFramesAfterClick?: readonly Record<string, unknown>[];
  readonly postClickFrames?: readonly (readonly Record<string, unknown>[])[];
}

export interface FakeTurnPageOptions {
  readonly dispatchCandidateIds?: readonly string[];
  readonly historicalResponseUserIds?: readonly string[];
  readonly foreignDomUserIds?: readonly string[];
  readonly assistantParent?: string;
  readonly assistantText?: string;
  readonly assistants?: readonly FakeAssistantSpec[];
  readonly serviceFrames?: readonly Record<string, unknown>[];
  readonly continueGenerating?: ContinueGeneratingSpec;
  readonly bodyText?: string;
  readonly alertText?: string;
  readonly alertAfterSend?: string;
  readonly composer?: boolean;
  readonly serviceObserveDispatch?: boolean;
  readonly preDispatchServiceFrames?: readonly Record<string, unknown>[];
  readonly preClickRequests?: readonly { readonly turnExchangeId?: string; readonly userId?: string }[];
  readonly postClickRequests?: readonly { readonly turnExchangeId?: string; readonly userId?: string }[];
  readonly postClickServiceFrames?: readonly Record<string, unknown>[];
  readonly postClickRawSseBodies?: readonly string[];
  readonly turnExchangeId?: string;
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
  semanticNodes?: readonly SemanticNode[],
): any {
  let sequenceIndex = 0;
  const currentText = () => {
    if (textSequence?.length) return textSequence[Math.min(sequenceIndex, textSequence.length - 1)] ?? '';
    return renderedText;
  };
  let renderedText = text;
  return {
    __role: role,
    __id: id,
    __applyText: (value: string) => { renderedText = value; },
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
    evaluate: async () => semanticNodes?.length ? [...semanticNodes] : semanticNodesForText(currentText()),
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
  const frameListeners: Array<(frame: { payload: string }) => unknown> = [];
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
      const payload = JSON.stringify(frame);
      for (const handler of wsHandlers) {
        await handler({ response: { payloadData: payload } });
      }
      for (const handler of frameListeners) {
        await handler({ payload });
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
      for (const req of options.preClickRequests ?? []) {
        await emit('request', {
          url: () => 'https://chatgpt.com/backend-api/f/conversation',
          postData: () => JSON.stringify({
            ...(req.turnExchangeId ? { metadata: { turn_exchange_id: req.turnExchangeId } } : {}),
            messages: [{
              ...(req.userId ? { id: req.userId } : {}),
              author: { role: 'user' },
              content: { content_type: 'text', parts: [''] },
            }],
          }),
        });
      }
      for (const id of options.historicalResponseUserIds ?? []) {
        await emit('response', {
          url: () => 'https://chatgpt.com/backend-api/conversation/history',
          text: async () => JSON.stringify({ message: { id, author: { role: 'user' } } }),
        });
      }
      for (const id of dispatchIds) {
        await emit('request', {
          url: () => 'https://chatgpt.com/backend-api/f/conversation',
          postData: () => JSON.stringify({
            messages: [{
              id,
              author: { role: 'user' },
              ...(options.turnExchangeId ? { metadata: { turn_exchange_id: options.turnExchangeId } } : {}),
            }],
          }),
        });
      }
      if (!dispatchIds.length && options.turnExchangeId) {
        await emit('request', {
          url: () => 'https://chatgpt.com/backend-api/conversation',
          postData: () => JSON.stringify({
            metadata: { turn_exchange_id: options.turnExchangeId },
            messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: [''] } }],
          }),
        });
      }
      if (options.serviceObserveDispatch !== false) {
        for (const id of dispatchIds) messages.push(messageLocator('user', id));
      }
      for (const id of options.foreignDomUserIds ?? []) messages.push(messageLocator('user', id));
      for (const spec of assistantSpecs) {
        if (spec.appearOnSend !== false) {
          messages.push(messageLocator('assistant', spec.id, spec.parent, spec.text ?? '', spec.textSequence, spec.semanticNodes));
        }
      }
      const frames = options.serviceFrames
        ?? (options.assistantParent
          ? defaultTerminalFrames(dispatchIds[0] ?? 'user-owned-12345678', 'assistant-owned-12345678', options.assistantParent)
          : []);
      if (options.preDispatchServiceFrames?.length) await emitServiceFrames(options.preDispatchServiceFrames);
      if (frames.length > 0) await emitServiceFrames(frames);
      for (const body of options.postClickRawSseBodies ?? []) {
        await emit('response', {
          url: () => 'https://chatgpt.com/backend-api/conversation',
          text: async () => body,
        });
      }
    },
  };

  const selectMessages = (role: 'user' | 'assistant') => {
    const selected = messages.filter((message) => message.__role === role);
    return { count: async () => selected.length, nth: (index: number) => selected[index] ?? emptyLocator() };
  };

  let continueVisible = Boolean(options.continueGenerating);
  let continueGrowthIndex = 0;
  let continueClicked = false;
  let pendingTerminalFrames: readonly Record<string, unknown>[] | undefined;
  let postClickServiceEmitted = false;
  let postClickFrameIndex = 0;
  const emitPostClickForeign = async (): Promise<void> => {
    if (postClickServiceEmitted) return;
    postClickServiceEmitted = true;
    for (const req of options.postClickRequests ?? []) {
      await emit('request', {
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        postData: () => JSON.stringify({
          ...(req.turnExchangeId ? { metadata: { turn_exchange_id: req.turnExchangeId } } : {}),
          messages: [{
            ...(req.userId ? { id: req.userId } : {}),
            author: { role: 'user' },
            content: { content_type: 'text', parts: [''] },
          }],
        }),
      });
    }
    if (options.postClickServiceFrames?.length) {
      await emitServiceFrames(options.postClickServiceFrames);
    }
    for (const body of options.postClickRawSseBodies ?? []) {
      await emit('response', {
        url: () => 'https://chatgpt.com/backend-api/conversation',
        text: async () => body,
      });
    }
  };
  const applyContinueGrowth = () => {
    const growth = options.continueGenerating?.growthSequence ?? [];
    if (!growth.length) return;
    const assistant = messages.find((message) => message.__role === 'assistant');
    if (!assistant) return;
    const next = growth[Math.min(continueGrowthIndex, growth.length - 1)] ?? '';
    assistant.__applyText?.(next);
    if (continueGrowthIndex < growth.length - 1) continueGrowthIndex++;
  };
  const maybeEmitContinuationTerminal = async () => {
    if (!continueClicked) return;
    const postClick = options.continueGenerating?.postClickFrames ?? [];
    if (postClickFrameIndex < postClick.length) {
      await emitServiceFrames(postClick[postClickFrameIndex] ?? []);
      postClickFrameIndex++;
      return;
    }
    if (!pendingTerminalFrames?.length) return;
    const growth = options.continueGenerating?.growthSequence ?? [];
    if (growth.length > 0 && continueGrowthIndex < growth.length - 1) return;
    await emitServiceFrames(pendingTerminalFrames);
    pendingTerminalFrames = undefined;
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
      if (event === 'websocket') {
        handler({
          on: (frameEvent: string, frameHandler: (frame: { payload: string }) => unknown) => {
            if (frameEvent === 'framereceived') frameListeners.push(frameHandler);
          },
        });
        return;
      }
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    url: () => 'https://chatgpt.com/c/example',
    locator: (selector: string) => {
      if (selector === '#prompt-textarea') return { ...emptyLocator(), count: async () => composerPresent ? 1 : 0, click: async () => {}, fill: async () => {} };
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
      if (options.continueGenerating?.growthSequence?.length) applyContinueGrowth();
      await maybeEmitContinuationTerminal();
      await emitPostClickForeign();
    },
    getByText: (pattern: string | RegExp) => {
      const label = typeof pattern === 'string' ? pattern : pattern.source;
      if (!/continue generating/i.test(label) || !continueVisible) return emptyLocator();
      return {
        count: async () => 1,
        first: () => ({
          click: async () => {
            continueClicked = true;
            if (options.continueGenerating?.hideAfterClick !== false) continueVisible = false;
            pendingTerminalFrames = options.continueGenerating?.terminalFramesAfterClick;
          },
        }),
      };
    },
    addAssistant: (spec: FakeAssistantSpec) => {
      messages.push(messageLocator('assistant', spec.id, spec.parent, spec.text ?? '', spec.textSequence, spec.semanticNodes));
    },
    emitServiceFrames,
  };

  (page as { __fakeTurnPage?: boolean }).__fakeTurnPage = true;
  return { page, getSendClicks: () => sendClicks };
}

export { emptyLocator, messageLocator };
