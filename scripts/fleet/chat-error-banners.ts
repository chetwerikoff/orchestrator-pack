import {
  ASSISTANT_MESSAGE_STYLE,
  ASSISTANT_TURN_ACTION_SELECTOR,
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
  if (document.querySelector(${JSON.stringify(STOP_BUTTON_SELECTOR)})) return [];
  const first = document.querySelector('[data-markdown-text-style="user-message"],[data-chatgpt-search-unit-key$=":user"]');
  const issuePrefix = ${JSON.stringify(`github.com/${repository.toLowerCase()}/issues/`)};
  const firstText = ((first && first.innerText) || '').toLowerCase();
  const at = firstText.indexOf(issuePrefix);
  const digits = at < 0 ? '' : (firstText.slice(at + issuePrefix.length).match(/^\\d+/) || [''])[0];
  const issue = digits ? Number(digits) : undefined;
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
      issue,
    }));
  if (alerts.length > 0) return alerts;
  const lastTurn = [...document.querySelectorAll(${JSON.stringify(CONVERSATION_TURN_SECTION_SELECTOR)})].at(-1);
  if (!lastTurn) return [];
  if (!lastTurn.querySelector(${JSON.stringify(ASSISTANT_TURN_ACTION_SELECTOR)})) {
    return [{ kind: 'stalled', text: ${JSON.stringify(STALLED_CHAT_TEXT)}, retry: false, issue }];
  }
  const reply = [...lastTurn.querySelectorAll(${JSON.stringify(`[data-markdown-text-style="${ASSISTANT_MESSAGE_STYLE}"]`)})].at(-1);
  if (reply && (reply.innerText || '').trim()) return [];
  return [{ kind: 'stalled', text: ${JSON.stringify(EMPTY_REPLY_CHAT_TEXT)}, retry: false, issue }];
})()`;

interface CdpTarget {
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
}

type BannerRow = { kind: ChatAttentionKind; text: string; retry: boolean; issue?: number };

function evaluateTarget(wsUrl: string, expression: string): Promise<BannerRow[]> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let socket: WebSocket;
    const finish = (value: BannerRow[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolvePromise(value);
    };
    const timer = setTimeout(() => finish([]), TARGET_EVAL_TIMEOUT_MS);
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      finish([]);
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
        finish(Array.isArray(value)
          ? value.filter((row) => row && typeof row.text === 'string' && (row.kind === 'error_banner' || row.kind === 'stalled'))
          : []);
      } catch {
        finish([]);
      }
    };
    socket.onerror = () => finish([]);
    socket.onclose = () => finish([]);
  });
}

export async function readChatErrorBanners(cdpUrl: string, scope: ChatBannerScope): Promise<ChatErrorBanner[]> {
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
    && typeof target.url === 'string'
    && target.url.startsWith(prefix)
    && typeof target.webSocketDebuggerUrl === 'string');
  const banners: ChatErrorBanner[] = [];
  for (const target of conversations) {
    for (const row of await evaluateTarget(target.webSocketDebuggerUrl!, expression)) {
      banners.push({
        kind: row.kind,
        url: target.url!.split(/[?#]/)[0]!,
        text: row.text,
        retry: Boolean(row.retry),
        ...(Number.isSafeInteger(row.issue) && row.issue! > 0 ? { issue: row.issue } : {}),
      });
    }
  }
  return banners;
}
