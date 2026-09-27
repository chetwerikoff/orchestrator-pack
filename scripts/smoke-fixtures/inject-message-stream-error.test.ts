import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import {
  ASSISTANT_MESSAGE_SELECTOR,
  ASSISTANT_MESSAGE_STYLE,
  CONVERSATION_TURN_SECTION_SELECTOR,
  MESSAGE_NODE_SELECTOR,
  PRODUCT_STATUS_PROBE_SELECTORS,
  REGENERATE_THREAD_ERROR_BUTTON_SELECTOR,
  STOP_BUTTON_SELECTOR as PRODUCT_STOP_BUTTON_SELECTOR,
} from '../chatgpt-browser-turn/product-page-selectors.ts';
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
    const all = this.roots.flatMap((root) => [root, ...root.querySelectorAll('*')]);
    if (selector === CONVERSATION_TURN_SECTION_SELECTOR) {
      return all.filter((node) => node.tagName === 'DIV' && node.attrs['data-turn-key'] !== undefined);
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

function makeFixturePage() {
  const marker = `OPKTURNV1${'ab'.repeat(16)}`;
  const ownedTurn = new FixtureElement('div', { 'data-turn-key': `${CONVERSATION_TURN_ID_PREFIX}owned` });
  const ownedUser = new FixtureElement('div', {
    'data-chatgpt-search-unit-key': `${CONVERSATION_TURN_ID_PREFIX}owned:0:user`,
    'data-chatgpt-search-message-ids': 'smoke-owned-user',
  }, `${marker}\n\nTASK`);
  ownedTurn.appendChild(ownedUser);
  const assistantTurn = new FixtureElement('div', { 'data-turn-key': `${CONVERSATION_TURN_ID_PREFIX}assistant` });
  const oldAssistant = new FixtureElement('div', { 'data-chatgpt-selection-message-id': 'pending-assistant' });
  oldAssistant.appendChild(new FixtureElement('span', { 'data-markdown-text-style': ASSISTANT_MESSAGE_STYLE }, 'partial'));
  assistantTurn.appendChild(oldAssistant);
  const stop = new FixtureElement('button', { 'data-testid': 'stop-button' }, 'Stop');
  const document = new FixtureDocument([ownedTurn, assistantTurn], stop);
  return { document, ownedTurn, ownedUser, assistantTurn, stop, marker };
}

async function probePage(document: FixtureDocument) {
  const target = {
    id: 'new-conversation',
    type: 'page',
    url: 'https://chatgpt.com/c/smoke-fixture',
    webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/new-conversation',
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

test('CDP injection stops a new running turn and the production page probe classifies its fixture', async () => {
  assert.equal(STOP_BUTTON_SELECTOR, PRODUCT_STOP_BUTTON_SELECTOR);
  const { document, ownedTurn, ownedUser, assistantTurn, stop, marker } = makeFixturePage();
  const target = {
    id: 'new-conversation',
    type: 'page',
    url: 'https://chatgpt.com/c/smoke-fixture',
    webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/new-conversation',
  };
  let listCalls = 0;
  const injected = await injectMessageStreamError({
    cdp: 'http://127.0.0.1:9237',
    timeoutMs: 1_000,
    list: async () => {
      listCalls += 1;
      return listCalls === 1 ? [{ ...target, id: 'pre-existing' }] : [{ ...target, id: 'pre-existing' }, target];
    },
    connect: async () => ({
      evaluate: async (expression: string) => await runInNewContext(expression, { document }),
      close: () => undefined,
    }),
    wait: async () => undefined,
  });
  assert.deepEqual(injected, {
    status: 'injected',
    target_id: 'new-conversation',
    conversation_url: target.url,
    turn_key: `${CONVERSATION_TURN_ID_PREFIX}assistant`,
    stop_clicked: true,
    retry_clicked: false,
    preserved_turn_node: true,
  });
  assert.ok(listCalls >= 2);
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

test('injection refuses when the Stop control or existing assistant turn is absent', async () => {
  const { document, assistantTurn, stop } = makeFixturePage();
  document.stopActive = false;
  const waitingForStop = await runInNewContext(buildInjectionExpression(), { document });
  assert.equal(waitingForStop.status, 'waiting_for_stop');
  assert.equal(document.retryClicks, 0);

  document.stopActive = true;
  assistantTurn.children.splice(0);
  const waitingForTurn = await runInNewContext(buildInjectionExpression(), { document });
  assert.equal(waitingForTurn.status, 'waiting_for_assistant_turn');
  assert.equal(document.retryClicks, 0);
  assert.equal(stop.connected, true);
});
