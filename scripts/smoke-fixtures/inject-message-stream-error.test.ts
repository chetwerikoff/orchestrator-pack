// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import {
  ASSISTANT_MESSAGE_SELECTOR,
  ASSISTANT_MESSAGE_STYLE,
  ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
  CONVERSATION_TURN_SECTION_SELECTOR,
  MESSAGE_NODE_SELECTOR,
  PRODUCT_STATUS_PROBE_SELECTORS,
  REGENERATE_THREAD_ERROR_BUTTON_SELECTOR,
  SEND_BUTTON_SELECTOR,
  STOP_BUTTON_SELECTOR as PRODUCT_STOP_BUTTON_SELECTOR,
  USER_MESSAGE_SELECTOR,
} from '../chatgpt-browser-turn/product-page-selectors.ts';
import { fakeTurnPage } from '../chatgpt-browser-turn/fixtures/fake-turn-page.ts';
import {
  projectExecutionRecoveryInspect,
  runProbe,
  type ProbeDependencies,
} from '../browser-gpt-page-probe.ts';
import { classifyProductWall } from '../chatgpt-browser-turn/ui-adapter.ts';
import {
  buildInjectionExpression,
  CONVERSATION_TURN_ID_PREFIX,
  injectMessageStreamError,
  MESSAGE_STREAM_ERROR_TEXT,
  STOP_BUTTON_SELECTOR,
} from './inject-message-stream-error.mjs';

class FixtureElement {
  readonly attrs: Record<string, string>;
  readonly tagName: string;
  readonly children: FixtureElement[] = [];
  parent: FixtureElement | null = null;
  text = '';
  connected = true;

  constructor(tagName: string, attrs: Record<string, string> = {}, text = '') {
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...attrs };
    this.text = text;
  }

  get isConnected(): boolean { return this.connected; }
  get disabled(): boolean { return false; }
  get innerText(): string { return this.text || this.children.map((child) => child.innerText).filter(Boolean).join('\n'); }
  get textContent(): string { return this.text || this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; }

  appendChild(child: FixtureElement): FixtureElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...children: FixtureElement[]): void {
    for (const child of children) this.appendChild(child);
  }

  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  getBoundingClientRect(): { height: number } { return { height: 1 }; }

  remove(): void {
    this.connected = false;
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
  }

  click(): void {
    if (this.attrs['data-testid'] === 'stop-button') this.ownerDocument!.stopActive = false;
    else if (this.attrs['data-testid'] === 'regenerate-thread-error-button') {
      this.ownerDocument!.retryClicks += 1;
    }
  }

  ownerDocument?: FixtureDocument;

  closest(selector: string): FixtureElement | null {
    if (selector !== CONVERSATION_TURN_SECTION_SELECTOR) return null;
    for (let node: FixtureElement | null = this; node; node = node.parent) {
      if (node.tagName === 'DIV' && node.attrs['data-turn-key'] !== undefined) return node;
    }
    return null;
  }

  querySelector(selector: string): FixtureElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FixtureElement[] {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
    if (selector === '*') return descendants;
    if (selector === 'p') return descendants.filter((node) => node.tagName === 'P');
    if (selector === REGENERATE_THREAD_ERROR_BUTTON_SELECTOR) {
      return descendants.filter((node) => node.attrs['data-testid'] === 'regenerate-thread-error-button');
    }
    if (selector === ASSISTANT_TURN_IN_PROGRESS_SELECTOR) {
      return descendants.filter((node) => node.attrs['aria-busy'] === 'true'
        || node.attrs['data-is-streaming'] === 'true'
        || (node.attrs['data-testid']?.startsWith('tool') && node.attrs['data-state'] === 'running')
        || (node.attrs['data-testid']?.startsWith('tool') && node.attrs['data-state'] === 'loading'));
    }
    if (selector === '[data-markdown-text-style]') {
      return descendants.filter((node) => node.attrs['data-markdown-text-style'] !== undefined);
    }
    if (selector === '[data-markdown-text-style="assistant-message"]') {
      return descendants.filter((node) => node.attrs['data-markdown-text-style'] === ASSISTANT_MESSAGE_STYLE);
    }
    if (selector === ASSISTANT_MESSAGE_SELECTOR
      || selector === '[data-chatgpt-selection-message-id]:has([data-markdown-text-style="assistant-message"])') {
      return descendants.filter((node) => node.attrs['data-chatgpt-selection-message-id'] !== undefined
        && node.querySelectorAll('[data-markdown-text-style="assistant-message"]').length > 0);
    }
    if (selector.includes('copy-turn-action-button') || selector.includes('.sr-only') || selector.includes('[role="alert"]')) return [];
    return [];
  }
}

class FixtureDocument {
  readonly title = 'Synthetic smoke fixture';
  readonly readyState = 'complete' as const;
  readonly roots: FixtureElement[];
  stopActive = true;
  retryClicks = 0;
  readonly stop: FixtureElement;

  constructor(roots: FixtureElement[], stop: FixtureElement) {
    this.roots = roots;
    this.stop = stop;
    for (const root of roots) this.attach(root);
    this.attach(stop);
  }

  attach(node: FixtureElement): void {
    node.ownerDocument = this;
    for (const child of node.children) this.attach(child);
  }

  createElement(tagName: string): FixtureElement {
    const element = new FixtureElement(tagName);
    element.ownerDocument = this;
    return element;
  }

  querySelector(selector: string): FixtureElement | null {
    return selector.includes('stop-button') || selector.includes('aria-label*="Stop"')
      ? this.stopActive ? this.stop : null
      : null;
  }

  querySelectorAll(selector: string): FixtureElement[] {
    if (selector.includes('stop-button')) return this.stopActive ? [this.stop] : [];
    const all = this.roots.flatMap((root) => [root, ...root.querySelectorAll('*')]);
    if (selector === CONVERSATION_TURN_SECTION_SELECTOR) {
      return all.filter((node) => node.tagName === 'DIV' && node.attrs['data-turn-key'] !== undefined);
    }
    if (selector === USER_MESSAGE_SELECTOR) {
      return all.filter((node) => node.attrs['data-chatgpt-search-unit-key']?.endsWith(':user')
        || node.attrs['data-markdown-text-style'] === 'user-message');
    }
    if (selector === MESSAGE_NODE_SELECTOR) {
      return all.filter((node) => node.attrs['data-chatgpt-search-unit-key']?.endsWith(':user')
        || (node.attrs['data-chatgpt-selection-message-id'] !== undefined
          && node.querySelectorAll('[data-markdown-text-style="assistant-message"]').length > 0));
    }
    if (selector === ASSISTANT_MESSAGE_SELECTOR) {
      return all.filter((node) => node.attrs['data-chatgpt-selection-message-id'] !== undefined
        && node.querySelectorAll('[data-markdown-text-style="assistant-message"]').length > 0);
    }
    if (selector === PRODUCT_STATUS_PROBE_SELECTORS.join(', ')) return [];
    if (selector.includes('data-testid*="error"') || selector.includes('role="alert"')) return [];
    return [];
  }
}

function makeFixturePage(inProgress = 'true') {
  const marker = `OPKTURNV1${'ab'.repeat(16)}`;
  const ownedTurn = new FixtureElement('div', { 'data-turn-key': `${CONVERSATION_TURN_ID_PREFIX}owned` });
  const ownedUser = new FixtureElement('div', {
    'data-chatgpt-search-unit-key': `${CONVERSATION_TURN_ID_PREFIX}owned:0:user`,
    'data-chatgpt-search-message-ids': 'smoke-owned-user',
  }, `${marker}\n\nTASK`);
  ownedTurn.appendChild(ownedUser);
  const assistantTurn = new FixtureElement('div', { 'data-turn-key': `${CONVERSATION_TURN_ID_PREFIX}assistant` });
  assistantTurn.appendChild(new FixtureElement('div', { 'aria-busy': inProgress }));
  const stop = new FixtureElement('button', { 'data-testid': 'stop-button' }, 'Stop');
  const document = new FixtureDocument([ownedTurn, assistantTurn], stop);
  return { document, ownedTurn, ownedUser, assistantTurn, stop, marker };
}

async function probePage(document: FixtureDocument) {
  const target = {
    id: 'existing-project-tab',
    type: 'page',
    url: 'https://chatgpt.com/g/g-p-6a1920e1c1608191bef6089396d947b4-orchestrator-pack/project',
    webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/existing-project-tab',
  };
  const dependencies: ProbeDependencies = {
    listTargets: async () => [target],
    evaluate: async (_compatibleTarget, expression) => await runInNewContext(expression, {
      document,
      location: { href: target.url },
      crypto: webcrypto,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      Array,
      Map,
      Math,
      JSON,
      atob,
    }),
    publish: async () => undefined,
  };
  return await runProbe({ operation: 'inspect', cdp: 'http://127.0.0.1:9237', targetId: target.id }, dependencies);
}

function expectInjectionTimeout(targetStatuses: readonly { target_id: string; status: string }[]) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, targetStatuses.length
      ? `injection_timeout:${JSON.stringify(targetStatuses)}`
      : 'injection_timeout:waiting_for_conversation');
    return true;
  };
}

test('attaches to an existing project tab and injects into the active assistant turn before markdown appears', async () => {
  assert.equal(STOP_BUTTON_SELECTOR, PRODUCT_STOP_BUTTON_SELECTOR);
  const fake = fakeTurnPage({
    dispatchCandidateIds: ['smoke-owned-user'],
    assistants: [{ id: 'streaming-assistant', parent: 'smoke-owned-user', text: '', streaming: true }],
  });
  await fake.page.locator(SEND_BUTTON_SELECTOR).click();
  const streamingAssistant = fake.page.locator(ASSISTANT_MESSAGE_SELECTOR).nth(0);
  const inProgress = await streamingAssistant.getAttribute('aria-busy');
  assert.equal(inProgress, 'true');
  const { document, ownedTurn, ownedUser, assistantTurn, stop, marker } = makeFixturePage(inProgress);
  const target = {
    id: 'existing-project-tab',
    type: 'page',
    url: 'https://chatgpt.com/g/g-p-6a1920e1c1608191bef6089396d947b4-orchestrator-pack/c/6ab99792-ff18-83ec-8cb6-49d560ece5d1',
    webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/existing-project-tab',
  };
  const foreignTarget = {
    ...target,
    id: 'foreign-chat',
    url: 'https://chatgpt.com/g/g-p-6a1920e1c1608191bef6089396d947b4-orchestrator-pack/c/foreign',
    webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/foreign-chat',
  };
  let listCalls = 0;
  const connectedTargets: string[] = [];
  const injected = await injectMessageStreamError({
    conversation: '6ab99792-ff18-83ec-8cb6-49d560ece5d1',
    cdp: 'http://127.0.0.1:9237',
    timeoutMs: 1_000,
    list: async () => {
      listCalls += 1;
      return [foreignTarget, target];
    },
    connect: async (connectedTarget) => {
      connectedTargets.push(connectedTarget.id);
      return {
        evaluate: async (expression: string) => await runInNewContext(expression, { document }),
        close: () => undefined,
      };
    },
    wait: async () => undefined,
  });
  assert.deepEqual(injected, {
    status: 'injected',
    target_id: 'existing-project-tab',
    conversation_url: target.url,
    turn_key: `${CONVERSATION_TURN_ID_PREFIX}assistant`,
    stop_clicked: true,
    retry_clicked: false,
    preserved_turn_node: true,
  });
  assert.equal(listCalls, 1);
  assert.deepEqual(connectedTargets, ['existing-project-tab']);
  assert.equal(document.stopActive, false);
  assert.equal(stop.connected, true);
  assert.equal(document.retryClicks, 0);
  assert.equal(assistantTurn.getAttribute('data-turn-key'), `${CONVERSATION_TURN_ID_PREFIX}assistant`);
  assert.equal(ownedTurn.children[0], ownedUser);
  assert.equal(ownedUser.innerText.includes(marker), true);

  const result = await probePage(document);
  assert.equal(result.status, 'ok');
  assert.equal(result.execution_recovery_cause, 'message_stream_error', JSON.stringify(result.execution_recovery_inspect));
  const inspect = result.execution_recovery_inspect as ReturnType<typeof projectExecutionRecoveryInspect>;
  assert.equal(inspect?.cause, 'message_stream_error');
  assert.deepEqual(classifyProductWall({
    text: MESSAGE_STREAM_ERROR_TEXT,
    composer: true,
    execution_recovery_cause_stable: inspect?.cause ?? undefined,
  }), { state: 'recovery_required', cause: 'message_stream_error' });
});

test('injection refuses when the Stop control or assistant turn is absent', async () => {
  const { document, stop } = makeFixturePage();
  document.stopActive = false;
  const waitingForStop = await runInNewContext(buildInjectionExpression(), { document });
  assert.equal(waitingForStop.status, 'waiting_for_stop');
  assert.equal(document.retryClicks, 0);

  document.stopActive = true;
  document.roots.splice(1, 1);
  const waitingForTurn = await runInNewContext(buildInjectionExpression(), { document });
  assert.equal(waitingForTurn.status, 'waiting_for_assistant_turn');
  assert.equal(document.retryClicks, 0);
  assert.equal(stop.connected, true);
});

test('evaluates only the supplied conversation and ignores other orchestrator-pack tabs', async () => {
  const { document, assistantTurn } = makeFixturePage();
  const foreignConversationPage = makeFixturePage().document;
  const emptyProjectPage = new FixtureDocument([], new FixtureElement('button', { 'data-testid': 'stop-button' }, 'Stop'));
  const projectTarget = {
    id: 'idle-project-tab',
    type: 'page',
    url: 'https://chatgpt.com/g/g-p-6a1920e1c1608191bef6089396d947b4-orchestrator-pack/project',
    webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/idle-project-tab',
  };
  const conversationTarget = {
    id: 'recorded-conversation',
    type: 'page',
    url: 'https://chatgpt.com/g/g-p-6a1920e1c1608191bef6089396d947b4-orchestrator-pack/c/6ab99792-ff18-83ec-8cb6-49d560ece5d1',
    webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/recorded-conversation',
  };
  const foreignTarget = {
    ...conversationTarget,
    id: 'foreign-conversation',
    url: 'https://chatgpt.com/g/g-p-6a1920e1c1608191bef6089396d947b4-orchestrator-pack/c/foreign',
  };
  const connectedTargets: string[] = [];
  const injected = await injectMessageStreamError({
    conversation: '6ab99792-ff18-83ec-8cb6-49d560ece5d1',
    cdp: 'http://127.0.0.1:9237',
    timeoutMs: 1_000,
    list: async () => [foreignTarget, projectTarget, conversationTarget],
    connect: async (target) => {
      connectedTargets.push(target.id);
      const page = target.id === 'recorded-conversation' ? document
        : target.id === 'foreign-conversation' ? foreignConversationPage : emptyProjectPage;
      return {
        evaluate: async (expression: string) => await runInNewContext(expression, { document: page }),
        close: () => undefined,
      };
    },
    wait: async () => undefined,
  });

  assert.equal(injected.target_id, 'recorded-conversation');
  assert.equal(injected.conversation_url, conversationTarget.url);
  assert.deepEqual(connectedTargets, ['recorded-conversation']);
  assert.equal(injected.stop_clicked, true);
  assert.equal(injected.retry_clicked, false);
  assert.equal(document.stopActive, false);
  assert.equal(foreignConversationPage.stopActive, true);
  assert.equal(foreignConversationPage.retryClicks, 0);
  assert.equal(assistantTurn.getAttribute('data-turn-key'), `${CONVERSATION_TURN_ID_PREFIX}assistant`);
});

test('requires a valid conversation id before reading CDP targets', async () => {
  let listCalls = 0;
  await assert.rejects(injectMessageStreamError({
    list: async () => { listCalls += 1; return []; },
  }), /conversation_required/u);
  assert.equal(listCalls, 0);
});

test('ignores the orchestrator-pack project home when a conversation id is required', async () => {
  const emptyProjectPage = new FixtureDocument([], new FixtureElement('button', { 'data-testid': 'stop-button' }, 'Stop'));
  const projectTarget = {
    id: 'idle-project-tab',
    type: 'page',
    url: 'https://chatgpt.com/g/g-p-6a1920e1c1608191bef6089396d947b4-orchestrator-pack/project',
    webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/idle-project-tab',
  };
  await assert.rejects(injectMessageStreamError({
    conversation: '6ab99792-ff18-83ec-8cb6-49d560ece5d1',
    cdp: 'http://127.0.0.1:9237',
    timeoutMs: 1,
    list: async () => [projectTarget],
    connect: async () => ({
      evaluate: async (expression: string) => await runInNewContext(expression, { document: emptyProjectPage }),
      close: () => undefined,
    }),
    wait: async () => undefined,
  }), expectInjectionTimeout([]));
});

test('reports waiting status for only the requested conversation', async () => {
  const { document } = makeFixturePage();
  document.stopActive = false;
  const emptyProjectPage = new FixtureDocument([], new FixtureElement('button', { 'data-testid': 'stop-button' }, 'Stop'));
  const projectTarget = {
    id: 'idle-project-tab',
    type: 'page',
    url: 'https://chatgpt.com/g/g-p-6a1920e1c1608191bef6089396d947b4-orchestrator-pack/project',
    webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/idle-project-tab',
  };
  const conversationTarget = {
    id: 'recorded-conversation',
    type: 'page',
    url: 'https://chatgpt.com/g/g-p-6a1920e1c1608191bef6089396d947b4-orchestrator-pack/c/6ab99792-ff18-83ec-8cb6-49d560ece5d1',
    webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/recorded-conversation',
  };
  await assert.rejects(injectMessageStreamError({
    conversation: '6ab99792-ff18-83ec-8cb6-49d560ece5d1',
    cdp: 'http://127.0.0.1:9237',
    timeoutMs: 1,
    list: async () => [projectTarget, conversationTarget],
    connect: async (target) => {
      const page = target.id === 'recorded-conversation' ? document : emptyProjectPage;
      return {
        evaluate: async (expression: string) => await runInNewContext(expression, { document: page }),
        close: () => undefined,
      };
    },
    wait: async () => undefined,
  }), expectInjectionTimeout([
    { target_id: 'recorded-conversation', status: 'waiting_for_stop' },
  ]));
});
