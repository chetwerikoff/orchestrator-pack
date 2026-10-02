import {
  ASSISTANT_MESSAGE_STYLE,
  ASSISTANT_TURN_ACTION_SELECTOR,
  CONNECTION_RECOVERY_STATUS_SELECTOR,
  CONVERSATION_TURN_SECTION_SELECTOR,
  STOP_BUTTON_SELECTOR,
} from '../chatgpt-browser-turn/product-page-selectors.ts';

export type ChatAttentionKind = 'error_banner' | 'stalled';

export const STALLED_CHAT_TEXT = 'GPT stopped without a final reply';
export const EMPTY_REPLY_CHAT_TEXT = 'GPT finished with an empty reply';

export interface ChatErrorBanner {
  readonly kind: ChatAttentionKind;
  readonly url: string;
  readonly text: string;
  readonly retry: boolean;
  readonly issue?: number;
  // PR-review chats must be asked for the verdict, never for task work.
  readonly review?: boolean;
  readonly pull?: number;
}

export const REVIEW_PROMPT_HEADING = '# Browser GPT pack PR review';

export interface ProjectChat {
  readonly targetId: string;
  readonly url: string;
  readonly issue?: number;
  readonly pull?: number;
  readonly review?: boolean;
  readonly generating: boolean;
  readonly banners: readonly ChatErrorBanner[];
}

export const DEFAULT_CHAT_CDP_URL = 'http://127.0.0.1:9222';

export interface ChatBannerScope {
  // Project URL from the target card, e.g. https://chatgpt.com/g/g-p-<id>-<slug>/project.
  readonly projectUrl: string;
  // owner/name; only Issue links of this repository identify an owner.
  readonly repository: string;
}

export function projectConversationPrefix(projectUrl: string): string {
  return `${projectUrl.split(/[?#]/)[0]!.replace(/\/+$/, '').replace(/\/project$/, '')}/c/`;
}
const TARGET_LIST_TIMEOUT_MS = 3_000;
const TARGET_EVAL_TIMEOUT_MS = 3_000;

// Read-only: the expression never clicks, types, or presses Retry.
// A chat needs attention when generation is not running and either a red
// product-error alert is shown or the last turn lacks the finished-reply actions.
const redBannerExpression = (repository: string): string => `(() => {
  const visible = (e) => e.getClientRects().length > 0;
  const rendered = (element) => element.getBoundingClientRect().height > 0;
  const generating = [...document.querySelectorAll(${JSON.stringify(STOP_BUTTON_SELECTOR)})].some(rendered);
  const first = document.querySelector('[data-markdown-text-style="user-message"],[data-chatgpt-search-unit-key$=":user"]');
  const issuePrefix = ${JSON.stringify(`github.com/${repository.toLowerCase()}/issues/`)};
  const firstText = ((first && first.innerText) || '').toLowerCase();
  const at = firstText.indexOf(issuePrefix);
  const digits = at < 0 ? '' : (firstText.slice(at + issuePrefix.length).match(/^\\d+/) || [''])[0];
  const issue = digits ? Number(digits) : undefined;
  const pullPrefix = ${JSON.stringify(`github.com/${repository.toLowerCase()}/pull/`)};
  const pullAt = firstText.indexOf(pullPrefix);
  const pullDigits = pullAt < 0 ? '' : (firstText.slice(pullAt + pullPrefix.length).match(/^\\d+/) || [''])[0];
  const pull = pullDigits ? Number(pullDigits) : undefined;
  const review = firstText.includes(${JSON.stringify(REVIEW_PROMPT_HEADING.toLowerCase())});
  const chat = (rows) => ({ issue, pull, review, generating, rows });
  const recovery = [...document.querySelectorAll(${JSON.stringify(CONNECTION_RECOVERY_STATUS_SELECTOR)})].find(rendered);
  if (recovery) {
    return { issue, pull, review, generating: false, rows: [{ kind: 'error_banner', text: (recovery.innerText || '').trim().slice(0, 160), retry: false }] };
  }
  if (generating) return chat([]);
  const red = (c) => {
    let m = c.match(/oklab\\(\\s*[\\d.]+%?\\s+([-\\d.]+)\\s+([-\\d.]+)/);
    if (m) return Number(m[1]) > 0.1;
    m = c.match(/oklch\\(\\s*[\\d.]+%?\\s+([\\d.]+)\\s+([\\d.]+)/);
    if (m) { const h = Number(m[2]); return Number(m[1]) > 0.1 && (h < 60 || h > 330); }
    m = c.match(/rgba?\\(\\s*(\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)/);
    return !!m && m[1] - m[2] > 60 && m[1] - m[3] > 60;
  };
  const alerts = [...document.querySelectorAll('main [role="alert"]')]
    .filter((e) => visible(e) && red(getComputedStyle(e).borderTopColor))
    .map((e) => ({
      kind: 'error_banner',
      text: (e.innerText || '').split('\\n')[0].trim().slice(0, 160),
      retry: [...e.querySelectorAll('button')].some((b) => /^retry$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim())),
    }));
  if (alerts.length > 0) return chat(alerts);
  const lastTurn = [...document.querySelectorAll(${JSON.stringify(CONVERSATION_TURN_SECTION_SELECTOR)})].filter(rendered).at(-1);
  if (!lastTurn) return chat([]);
  if (!lastTurn.querySelector(${JSON.stringify(ASSISTANT_TURN_ACTION_SELECTOR)})) {
    return chat([{ kind: 'stalled', text: ${JSON.stringify(STALLED_CHAT_TEXT)}, retry: false }]);
  }
  const reply = [...lastTurn.querySelectorAll(${JSON.stringify(`[data-markdown-text-style="${ASSISTANT_MESSAGE_STYLE}"]`)})].at(-1);
  if (reply && (reply.innerText || '').trim()) return chat([]);
  return chat([{ kind: 'stalled', text: ${JSON.stringify(EMPTY_REPLY_CHAT_TEXT)}, retry: false }]);
})()`;

interface CdpTarget {
  readonly id?: string;
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
}

type BannerRow = { kind: ChatAttentionKind; text: string; retry: boolean };
type ChatRow = { issue?: number; pull?: number; review?: boolean; generating?: boolean; rows?: unknown };

function evaluateTarget(wsUrl: string, expression: string): Promise<ChatRow | undefined> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let socket: WebSocket;
    const finish = (value: ChatRow | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolvePromise(value);
    };
    const timer = setTimeout(() => finish(undefined), TARGET_EVAL_TIMEOUT_MS);
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      finish(undefined);
      return;
    }
    socket.onopen = () => socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true },
    }));
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown } } };
        if (data.id !== 1) return;
        const value = data.result?.result?.value;
        finish(value && typeof value === 'object' ? value as ChatRow : undefined);
      } catch {
        finish(undefined);
      }
    };
    socket.onerror = () => finish(undefined);
    socket.onclose = () => finish(undefined);
  });
}

export async function readProjectChats(cdpUrl: string, scope: ChatBannerScope): Promise<ProjectChat[]> {
  const prefix = projectConversationPrefix(scope.projectUrl);
  const expression = redBannerExpression(scope.repository);
  let targets: CdpTarget[];
  try {
    const response = await fetch(`${cdpUrl.replace(/\/+$/, '')}/json/list`, {
      signal: AbortSignal.timeout(TARGET_LIST_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    targets = await response.json() as CdpTarget[];
  } catch {
    return [];
  }
  const conversations = targets.filter((target) => target.type === 'page'
    && typeof target.id === 'string'
    && typeof target.url === 'string'
    && target.url.startsWith(prefix)
    && typeof target.webSocketDebuggerUrl === 'string');
  const chats: ProjectChat[] = [];
  for (const target of conversations) {
    const observed = await evaluateTarget(target.webSocketDebuggerUrl!, expression);
    if (!observed) continue;
    const url = target.url!.split(/[?#]/)[0]!;
    const task = {
      ...(Number.isSafeInteger(observed.issue) && observed.issue! > 0 ? { issue: observed.issue } : {}),
      ...(Number.isSafeInteger(observed.pull) && observed.pull! > 0 ? { pull: observed.pull } : {}),
      ...(observed.review === true ? { review: true } : {}),
    };
    const rows = Array.isArray(observed.rows) ? observed.rows as BannerRow[] : [];
    chats.push({
      targetId: target.id!,
      url,
      ...task,
      generating: observed.generating === true,
      banners: rows
        .filter((row) => row && typeof row.text === 'string' && (row.kind === 'error_banner' || row.kind === 'stalled'))
        .map((row) => ({ kind: row.kind, url, text: row.text, retry: Boolean(row.retry), ...task })),
    });
  }
  return chats;
}

// Conversation ids start with their creation time in hex seconds; a chat that
// is still local (`local-chatgpt:`) has not been saved yet and is the newest.
export function conversationCreatedAt(url: string): number {
  const id = url.split('/c/')[1] ?? '';
  if (id.startsWith('local-chatgpt:')) return Number.POSITIVE_INFINITY;
  const seconds = Number.parseInt(id.slice(0, 8), 16);
  return Number.isFinite(seconds) ? seconds : 0;
}

export async function closeChatTarget(cdpUrl: string, targetId: string): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl.replace(/\/+$/, '')}/json/close/${encodeURIComponent(targetId)}`, {
      signal: AbortSignal.timeout(TARGET_LIST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
