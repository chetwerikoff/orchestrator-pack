#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

export const DEFAULT_CDP = 'http://127.0.0.1:9237';
export const STOP_BUTTON_SELECTOR = '[data-testid="stop-button"], button[aria-label*="Stop"]';
export const CONVERSATION_TURN_SECTION_SELECTOR = 'div[data-turn-key]';
export const CONVERSATION_TURN_ID_PREFIX = 'conversation-turn-';
export const MESSAGE_STREAM_ERROR_TEXT = 'Error in message stream';
export const POLL_INTERVAL_MS = 100;
export const POLL_TIMEOUT_MS = 120_000;
const CDP_TIMEOUT_MS = 10_000;

function cdpBase(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid_cdp_url');
  url.hash = '';
  url.search = '';
  url.pathname = '';
  return url.toString().replace(/\/$/u, '');
}

async function listTargets(cdp) {
  const response = await fetch(`${cdpBase(cdp)}/json/list`, {
    signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`cdp_list_http_${response.status}`);
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error('cdp_list_not_array');
  return targets;
}

async function openTarget(target) {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) throw new Error('websocket_unavailable');
  const socket = new WebSocketCtor(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  let resolveOpen;
  let rejectOpen;
  const opened = new Promise((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  socket.addEventListener('open', () => resolveOpen(), { once: true });
  socket.addEventListener('error', () => rejectOpen(new Error('cdp_websocket_error')), { once: true });
  socket.addEventListener('close', () => {
    closed = true;
    for (const entry of pending.values()) entry.reject(new Error('cdp_websocket_closed'));
    pending.clear();
  }, { once: true });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message ?? 'cdp_command_error'));
    else if (message.result?.exceptionDetails) entry.reject(new Error(message.result.exceptionDetails.text ?? 'cdp_expression_exception'));
    else entry.resolve(message.result?.result?.value);
  });
  let openTimer;
  try {
    await Promise.race([
      opened,
      new Promise((_, reject) => { openTimer = setTimeout(() => reject(new Error('cdp_connect_timeout')), CDP_TIMEOUT_MS); }),
    ]);
  } catch (error) {
    try { socket.close(); } catch { /* best effort */ }
    throw error;
  } finally {
    clearTimeout(openTimer);
  }

  return {
    evaluate(expression) {
      if (closed) return Promise.reject(new Error('cdp_websocket_closed'));
      const id = ++nextId;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      }));
      let timer;
      return Promise.race([
        result,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            if (pending.delete(id)) reject(new Error('cdp_command_timeout'));
          }, CDP_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
    },
    close() {
      try { socket.close(); } catch { /* best effort */ }
    },
  };
}

export function buildInjectionExpression() {
  return `(() => {
    const STOP_SELECTOR = ${JSON.stringify(STOP_BUTTON_SELECTOR)};
    const TURN_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SECTION_SELECTOR)};
    const TURN_PREFIX = ${JSON.stringify(CONVERSATION_TURN_ID_PREFIX)};
    const ERROR_TEXT = ${JSON.stringify(MESSAGE_STREAM_ERROR_TEXT)};
    const stop = document.querySelector(STOP_SELECTOR);
    if (!stop || !stop.isConnected || stop.disabled) return { status: 'waiting_for_stop' };

    const turns = Array.from(document.querySelectorAll(TURN_SELECTOR));
    const candidates = turns.filter((turn) => {
      const key = turn.getAttribute('data-turn-key') || turn.getAttribute('data-testid') || '';
      return key.startsWith(TURN_PREFIX)
        && Array.from(turn.querySelectorAll('[data-markdown-text-style="assistant-message"]')).length > 0;
    });
    const turn = candidates.at(-1);
    if (!turn) return { status: 'waiting_for_assistant_turn' };
    const turnKey = turn.getAttribute('data-turn-key') || turn.getAttribute('data-testid');
    if (!turnKey || !turnKey.startsWith(TURN_PREFIX)) return { status: 'turn_identity_invalid' };

    // Stop and fixture insertion are one synchronous page action. The enclosing
    // turn and all user-owned markers remain untouched.
    stop.click();
    const assistantSelector = '[data-chatgpt-selection-message-id]:has([data-markdown-text-style="assistant-message"])';
    for (const existing of Array.from(turn.querySelectorAll(assistantSelector))) existing.remove();

    const assistant = document.createElement('div');
    assistant.setAttribute('data-chatgpt-selection-message-id', 'smoke-message-stream-error');
    const markdown = document.createElement('span');
    markdown.setAttribute('data-markdown-text-style', 'assistant-message');
    const banner = document.createElement('p');
    banner.textContent = ERROR_TEXT;
    const retry = document.createElement('button');
    retry.setAttribute('data-testid', 'regenerate-thread-error-button');
    retry.textContent = 'Retry';
    assistant.append(markdown, banner, retry);
    turn.appendChild(assistant);

    return {
      status: 'injected',
      turn_key: turnKey,
      stop_clicked: true,
      retry_clicked: false,
      preserved_turn_node: turn.getAttribute('data-turn-key') === turnKey
        || turn.getAttribute('data-testid') === turnKey,
    };
  })()`;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function injectMessageStreamError({
  cdp = DEFAULT_CDP,
  intervalMs = POLL_INTERVAL_MS,
  timeoutMs = POLL_TIMEOUT_MS,
  list = listTargets,
  connect = openTarget,
  wait = sleep,
} = {}) {
  const baseline = await list(cdp);
  const existingIds = new Set(baseline.flatMap((target) => typeof target.id === 'string' ? [target.id] : []));
  const deadline = Date.now() + timeoutMs;
  let lastWaitingStatus = 'waiting_for_new_page';

  while (Date.now() < deadline) {
    const targets = await list(cdp);
    for (const target of targets) {
      if (target.type !== 'page' || typeof target.id !== 'string' || existingIds.has(target.id)
        || typeof target.url !== 'string' || !/^https?:\/\/(?:[^/]+\.)?chatgpt\.com\//u.test(target.url)
        || typeof target.webSocketDebuggerUrl !== 'string') continue;
      let channel;
      try {
        channel = await connect(target);
        const result = await channel.evaluate(buildInjectionExpression());
        if (result?.status === 'injected') {
          return {
            status: 'injected',
            target_id: target.id,
            conversation_url: target.url,
            turn_key: result.turn_key,
            stop_clicked: result.stop_clicked,
            retry_clicked: result.retry_clicked,
            preserved_turn_node: result.preserved_turn_node,
          };
        }
        lastWaitingStatus = result?.status ?? 'page_result_unavailable';
      } finally {
        channel?.close();
      }
    }
    await wait(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`injection_timeout:${lastWaitingStatus}`);
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--') || args.has(key)) {
      throw new Error('invalid_arguments');
    }
    args.set(key, value);
  }
  for (const key of args.keys()) if (key !== '--cdp') throw new Error(`unknown_option:${key}`);
  const cdp = args.get('--cdp') ?? DEFAULT_CDP;
  cdpBase(cdp);
  return { cdp };
}

async function main(argv) {
  const result = await injectMessageStreamError(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
