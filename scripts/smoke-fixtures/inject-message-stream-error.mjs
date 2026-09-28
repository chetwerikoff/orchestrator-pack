#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  ASSISTANT_MESSAGE_SELECTOR,
  ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
  CONVERSATION_TURN_ID_PREFIX,
  CONVERSATION_TURN_SECTION_SELECTOR,
  REGENERATE_THREAD_ERROR_BUTTON_TESTID,
  STOP_BUTTON_SELECTOR,
  USER_MESSAGE_SELECTOR,
} from '../chatgpt-browser-turn/product-page-selectors.ts';

export const DEFAULT_CDP = 'http://127.0.0.1:9237';
export { CONVERSATION_TURN_ID_PREFIX, STOP_BUTTON_SELECTOR };
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
    const USER_SELECTOR = ${JSON.stringify(USER_MESSAGE_SELECTOR)};
    const IN_PROGRESS_SELECTOR = ${JSON.stringify(ASSISTANT_TURN_IN_PROGRESS_SELECTOR)};
    const TURN_PREFIX = ${JSON.stringify(CONVERSATION_TURN_ID_PREFIX)};
    const ASSISTANT_SELECTOR = ${JSON.stringify(ASSISTANT_MESSAGE_SELECTOR)};
    const ERROR_TEXT = ${JSON.stringify(MESSAGE_STREAM_ERROR_TEXT)};
    const RETRY_TESTID = ${JSON.stringify(REGENERATE_THREAD_ERROR_BUTTON_TESTID)};
    const turns = Array.from(document.querySelectorAll(TURN_SELECTOR));
    const users = Array.from(document.querySelectorAll(USER_SELECTOR));
    const lastUser = users.at(-1);
    const lastUserTurn = lastUser?.closest(TURN_SELECTOR);
    const lastUserIndex = lastUserTurn ? turns.indexOf(lastUserTurn) : -1;
    if (lastUserIndex < 0) return { status: 'waiting_for_user_turn' };

    const candidates = turns.slice(lastUserIndex + 1).filter((turn) => {
      const key = turn.getAttribute('data-turn-key') || '';
      return key.startsWith(TURN_PREFIX);
    });
    const turn = candidates.at(-1);
    if (!turn) return { status: 'waiting_for_assistant_turn' };
    const turnKey = turn.getAttribute('data-turn-key');
    if (!turnKey || !turnKey.startsWith(TURN_PREFIX)) return { status: 'turn_identity_invalid' };

    const stop = document.querySelector(STOP_SELECTOR);
    const stopAvailable = Boolean(stop && stop.isConnected && !stop.disabled);
    const inProgress = Array.from(turn.querySelectorAll(IN_PROGRESS_SELECTOR))
      .some((node) => node.isConnected);
    if (!inProgress && !stopAvailable) return { status: 'waiting_for_assistant_turn' };
    if (!stopAvailable) return { status: 'waiting_for_stop' };

    // Stop and fixture insertion are one synchronous page action. The enclosing
    // turn and all user-owned markers remain untouched.
    stop.click();
    for (const existing of Array.from(turn.querySelectorAll(ASSISTANT_SELECTOR))) existing.remove();

    const assistant = document.createElement('div');
    assistant.setAttribute('data-chatgpt-selection-message-id', 'smoke-message-stream-error');
    const markdown = document.createElement('span');
    markdown.setAttribute('data-markdown-text-style', 'assistant-message');
    const banner = document.createElement('p');
    banner.textContent = ERROR_TEXT;
    const retry = document.createElement('button');
    retry.setAttribute('data-testid', RETRY_TESTID);
    retry.textContent = 'Retry';
    assistant.append(markdown, banner, retry);
    turn.appendChild(assistant);

    return {
      status: 'injected',
      turn_key: turnKey,
      stop_clicked: true,
      retry_clicked: false,
      preserved_turn_node: turn.getAttribute('data-turn-key') === turnKey,
    };
  })()`;
}


function orchestratorPackTargetKind(target) {
  if (typeof target.url !== 'string') return null;
  try {
    const url = new URL(target.url);
    if (url.hostname !== 'chatgpt.com') return null;
    if (/\/g\/g-p-[^/]*orchestrator-pack\/c\/[^/]+(?:\/|$)/u.test(url.pathname)) return 'conversation';
    if (/\/g\/g-p-[^/]*orchestrator-pack\/project(?:\/|$)/u.test(url.pathname)) return 'project';
    return null;
  } catch {
    return null;
  }
}

function isOrchestratorPackProjectTarget(target) {
  return orchestratorPackTargetKind(target) !== null;
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
  const deadline = Date.now() + timeoutMs;
  let lastTargetStatuses = [];

  while (Date.now() < deadline) {
    const targets = await list(cdp);
    const projectTargets = targets
      .filter((target) => target.type === 'page' && typeof target.id === 'string'
        && isOrchestratorPackProjectTarget(target)
        && typeof target.webSocketDebuggerUrl === 'string')
      .sort((left, right) => Number(orchestratorPackTargetKind(right) === 'conversation')
        - Number(orchestratorPackTargetKind(left) === 'conversation'));
    const currentTargetStatuses = [];

    for (const target of projectTargets) {
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
        currentTargetStatuses.push({
          target_id: target.id,
          status: result?.status ?? 'page_result_unavailable',
        });
      } finally {
        channel?.close();
      }
    }
    lastTargetStatuses = currentTargetStatuses;
    await wait(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }

  const waitingDetails = lastTargetStatuses.length > 0
    ? JSON.stringify(lastTargetStatuses)
    : 'waiting_for_project_page';
  throw new Error(`injection_timeout:${waitingDetails}`);
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
