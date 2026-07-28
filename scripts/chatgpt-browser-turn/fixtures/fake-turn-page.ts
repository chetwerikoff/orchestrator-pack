import type { SemanticNode } from '../semantic.ts';
import type { DispatchObservationTestControls } from '../dispatch-observation.ts';

export interface FakeAssistantSpec {
  readonly id: string;
  readonly parent?: string;
  readonly text?: string;
  readonly textSequence?: readonly string[];
  readonly semanticNodes?: readonly SemanticNode[];
  readonly appearOnSend?: boolean;
  readonly streaming?: boolean;
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
  readonly postDispatchDelayedRequests?: readonly { readonly url: string; readonly method?: string; readonly postData?: string }[];
  readonly postClickRequests?: readonly { readonly turnExchangeId?: string; readonly userId?: string }[];
  readonly postClickServiceFrames?: readonly Record<string, unknown>[];
  readonly postClickRawSseBodies?: readonly string[];
  readonly turnExchangeId?: string;
  readonly dispatchObservation?: DispatchObservationTestControls;
  readonly postArmContextRequests?: readonly { readonly url: string }[];
  readonly postArmWebSocketSent?: readonly { readonly target?: string }[];
  readonly preDispatchUserDomIds?: readonly string[];
  readonly postArmUserDomIds?: readonly string[];
  readonly newChatUrlAfterArm?: string;
  readonly serviceWorkerHttpAfterArm?: readonly { readonly url: string }[];
  readonly hideSendButton?: boolean;
  readonly composerPressDelayMs?: number;
  readonly requestObserverCoverage?: 'complete' | 'incomplete';
  readonly foreignDomUserIdsOnPoll?: readonly string[];
  readonly pageLevelStopButton?: boolean;
  readonly lateTerminalFramesOnPoll?: { readonly poll: number; readonly frames: readonly Record<string, unknown>[] };
}


function makeDispatchRequest(url: string, postData?: string, method = 'POST'): { url: () => string; method: () => string; postData: () => string | null } {
  return {
    url: () => url,
    method: () => method,
    postData: () => postData ?? null,
  };
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
  streaming = false,
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
      if (name === 'data-is-streaming') return streaming ? 'true' : 'false';
      if (name === 'aria-busy') return streaming ? 'true' : 'false';
      return null;
    },
    locator: () => ({ count: async () => 0, first: () => ({ getAttribute: async () => null }) }),
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

export function fakeTurnPage(options: FakeTurnPageOptions = {}): { page: any; getSendClicks: () => number; getEnterPresses: () => number } {
  const handlers = new Map<string, Array<(event: any) => unknown>>();
  const contextRequestHandlers: Array<(request: { url: () => string }) => unknown> = [];
  const wsHandlers: Array<(event: { response?: { payloadData?: string } }) => unknown> = [];
  const wsSentHandlers: Array<() => unknown> = [];
  const frameListeners: Array<(frame: { payload: string }) => unknown> = [];
  const messages: any[] = [];
  let sendClicks = 0;
  let sent = false;
  let pageUrl = 'https://chatgpt.com/c/example';
  const observeComplete = Boolean(options.dispatchObservation);
  const dispatchIds = [...(options.dispatchCandidateIds ?? ['user-owned-12345678'])];
  for (const id of options.preDispatchUserDomIds ?? []) messages.push(messageLocator('user', id));
  const composerPresent = options.composer !== false;


  const emitContextRequest = async (url: string): Promise<void> => {
    const request = { url: () => url };
    for (const handler of contextRequestHandlers) await handler(request);
    await emit('request', request);
  };

  const emitWebSocketSent = async (): Promise<void> => {
    for (const handler of wsSentHandlers) await handler();
  };

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

  let enterPresses = 0;
  const runDispatch = async () => {
    sendClicks++;
    sent = true;
      for (const req of options.preClickRequests ?? []) {
        await emit('request', makeDispatchRequest('https://chatgpt.com/backend-api/f/conversation', JSON.stringify({
          ...(req.turnExchangeId ? { metadata: { turn_exchange_id: req.turnExchangeId } } : {}),
          messages: [{
            ...(req.userId ? { id: req.userId } : {}),
            author: { role: 'user' },
            content: { content_type: 'text', parts: [''] },
          }],
        })));
      }
      for (const id of options.historicalResponseUserIds ?? []) {
        await emit('response', {
          url: () => 'https://chatgpt.com/backend-api/conversation/history',
          text: async () => JSON.stringify({ message: { id, author: { role: 'user' } } }),
        });
      }
      for (const id of dispatchIds) {
        await emit('request', makeDispatchRequest('https://chatgpt.com/backend-api/f/conversation', JSON.stringify({
          messages: [{
            id,
            author: { role: 'user' },
            ...(options.turnExchangeId ? { metadata: { turn_exchange_id: options.turnExchangeId } } : {}),
          }],
        })));
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
          messages.push(messageLocator('assistant', spec.id, spec.parent, spec.text ?? '', spec.textSequence, spec.semanticNodes, spec.streaming));
        }
      }
      const frames = options.serviceFrames
        ?? (options.assistantParent
          ? defaultTerminalFrames(dispatchIds[0] ?? 'user-owned-12345678', 'assistant-owned-12345678', options.assistantParent)
          : []);
      if (options.preDispatchServiceFrames?.length) await emitServiceFrames(options.preDispatchServiceFrames);
      if (frames.length > 0) await emitServiceFrames(frames);
      await emitPostArmObservationTraffic();
      for (const body of options.postClickRawSseBodies ?? []) {
        await emit('response', {
          url: () => 'https://chatgpt.com/backend-api/conversation',
          text: async () => body,
        });
      }
    };

  const send = {
    ...emptyLocator(),
    count: async () => options.hideSendButton ? 0 : 1,
    click: runDispatch,
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
  let waitForTimeoutPolls = 0;
  let postClickFrameIndex = 0;
  const emitPostArmObservationTraffic = async (): Promise<void> => {
    if (!observeComplete) return;
    for (const req of options.serviceWorkerHttpAfterArm ?? []) {
      await emitContextRequest(req.url);
    }
    for (const req of options.postArmContextRequests ?? []) {
      await emitContextRequest(req.url);
    }
    for (let index = 0; index < (options.postArmWebSocketSent ?? []).length; index++) {
      await emitWebSocketSent();
    }
    for (const id of options.postArmUserDomIds ?? []) {
      messages.push(messageLocator('user', id));
    }
    if (options.newChatUrlAfterArm) {
      pageUrl = options.newChatUrlAfterArm;
    }
  };

  const emitPostClickForeign = async (): Promise<void> => {
    if (!sent) return;
    if (postClickServiceEmitted) return;
    postClickServiceEmitted = true;
    for (const req of options.postDispatchDelayedRequests ?? []) {
      await emit('request', makeDispatchRequest(req.url, req.postData, req.method ?? 'GET'));
    }
    for (const req of options.postClickRequests ?? []) {
      await emit('request', makeDispatchRequest('https://chatgpt.com/backend-api/f/conversation', JSON.stringify({
        ...(req.turnExchangeId ? { metadata: { turn_exchange_id: req.turnExchangeId } } : {}),
        messages: [{
          ...(req.userId ? { id: req.userId } : {}),
          author: { role: 'user' },
          content: { content_type: 'text', parts: [''] },
        }],
      })));
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
      ...(observeComplete ? {
        on: (event: string, handler: (...args: any[]) => unknown) => {
          if (event === 'request') contextRequestHandlers.push(handler as (request: { url: () => string }) => unknown);
          if (event === 'page' || event === 'serviceworker') handler({});
        },
      } : {}),
      newCDPSession: async () => {
        const attachedHandlers: Array<(value: any) => unknown> = [];
        const detachedHandlers: Array<(value: any) => unknown> = [];
        const session = {
          send: async (method: string, params?: { sessionId?: string; message?: string; targetId?: string; expression?: string; returnByValue?: boolean }, sessionId?: string) => {
            if (!observeComplete) return {};
            const flatSessionId = sessionId ?? params?.sessionId;
            if (flatSessionId && method === 'Runtime.evaluate') {
              return { result: { value: 2 } };
            }
            if (flatSessionId && method === 'Network.enable') return {};
            if (flatSessionId && method === 'Runtime.runIfWaitingForDebugger') return {};
            if (method === 'Target.getTargets') {
              return {
                targetInfos: [
                  { targetId: 'fixture-page-target', type: 'page' },
                  { targetId: 'fixture-worker-target', type: 'service_worker' },
                ],
              };
            }
            if (method === 'Target.attachToTarget') {
              const sessionId = `fixture-${params?.targetId ?? 'target'}-session`;
              for (const handler of attachedHandlers) {
                await handler({ sessionId, waitingForDebugger: true });
              }
              return { sessionId };
            }
            if (method === 'Target.sendMessageToTarget') return {};
            if (method === 'Target.setAutoAttach' || method === 'Target.setDiscoverTargets' || method === 'Network.enable') return {};
            return {};
          },
          on: (event: string, handler: (value: { response?: { payloadData?: string }; sessionId?: string; waitingForDebugger?: boolean }) => unknown) => {
            if (event === 'Network.webSocketFrameReceived') wsHandlers.push(handler);
            if (observeComplete && event === 'Network.webSocketFrameSent') wsSentHandlers.push(() => handler({}));
            if (observeComplete && event === 'Target.attachedToTarget') attachedHandlers.push(handler);
            if (observeComplete && event === 'Target.detachedFromTarget') detachedHandlers.push(handler);
          },
        };
        return session;
      },
    }),
    on: (event: string, handler: (value: any) => unknown) => {
      if (event === 'websocket') {
        handler({
          on: (frameEvent: string, frameHandler: (frame: { payload: string }) => unknown) => {
            if (frameEvent === 'framereceived') frameListeners.push(frameHandler);
            if (observeComplete && frameEvent === 'framesent') wsSentHandlers.push(() => frameHandler({ payload: '' }));
          },
        });
        return;
      }
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    url: () => pageUrl,
    locator: (selector: string) => {
      if (selector === '#prompt-textarea') {
        return {
          ...emptyLocator(),
          count: async () => composerPresent ? 1 : 0,
          click: async () => {},
          fill: async () => {},
          press: async (key: string, pressOptions?: { timeout?: number }) => {
            if (key !== 'Enter') return;
            enterPresses++;
            const timeoutMs = pressOptions?.timeout ?? 30_000;
            const delayMs = options.composerPressDelayMs ?? 0;
            if (delayMs > 0) {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                  reject(Object.assign(new Error('Timeout exceeded'), { name: 'TimeoutError' }));
                }, timeoutMs);
                setTimeout(() => {
                  clearTimeout(timer);
                  resolve();
                }, delayMs);
              });
            }
            await runDispatch();
          },
        };
      }
      if (selector === '[data-testid="send-button"]') return send;
      if (selector === '[data-testid="stop-button"]') {
        if (!options.pageLevelStopButton) return emptyLocator();
        return { ...emptyLocator(), count: async () => 1, first: () => ({ ...emptyLocator(), count: async () => 1 }) };
      }
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
      waitForTimeoutPolls++;
      if (options.lateTerminalFramesOnPoll?.poll === waitForTimeoutPolls) {
        await emitServiceFrames(options.lateTerminalFramesOnPoll.frames);
      }
      for (const message of messages) message.advanceText?.();
      if (options.continueGenerating?.growthSequence?.length) applyContinueGrowth();
      await maybeEmitContinuationTerminal();
      await emitPostClickForeign();
      for (const id of options.foreignDomUserIdsOnPoll ?? []) {
        if (!messages.some((message) => message.__id === id)) messages.push(messageLocator('user', id));
      }
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
      messages.push(messageLocator('assistant', spec.id, spec.parent, spec.text ?? '', spec.textSequence, spec.semanticNodes, spec.streaming));
    },
    emitServiceFrames,
  };

  (page as { __fakeTurnPage?: boolean }).__fakeTurnPage = true;
  if (options.requestObserverCoverage) {
    (page as { __requestObserverTestControls?: { coverage?: 'complete' | 'incomplete' } }).__requestObserverTestControls = {
      coverage: options.requestObserverCoverage,
    };
  }

    if (options.dispatchObservation) {
    (page as { __dispatchObservation?: DispatchObservationTestControls }).__dispatchObservation = options.dispatchObservation;
  }
  return { page, getSendClicks: () => sendClicks, getEnterPresses: () => enterPresses };
}

export { emptyLocator, messageLocator };
