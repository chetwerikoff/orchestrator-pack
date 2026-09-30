export interface ChatErrorBanner {
  readonly url: string;
  readonly text: string;
  readonly retry: boolean;
  readonly issue?: number;
}

export const DEFAULT_CHAT_CDP_URL = 'http://127.0.0.1:9222';

const CONVERSATION_URL_RE = /^https:\/\/chatgpt\.com\/(?:.*\/)?c\/[0-9a-f-]{8,}/i;
const TARGET_LIST_TIMEOUT_MS = 3_000;
const TARGET_EVAL_TIMEOUT_MS = 3_000;

// Read-only: the expression never clicks, types, or presses Retry.
const RED_BANNER_EXPRESSION = `(() => {
  if (document.querySelector('[data-testid="stop-button"]')) return [];
  const first = document.querySelector('[data-markdown-text-style="user-message"],[data-chatgpt-search-unit-key$=":user"]');
  const issueMatch = ((first && first.innerText) || '').match(/github\\.com\\/[^\\s/]+\\/[^\\s/]+\\/issues\\/(\\d+)/);
  const issue = issueMatch ? Number(issueMatch[1]) : undefined;
  const red = (c) => {
    let m = c.match(/oklab\\(\\s*[\\d.]+%?\\s+([-\\d.]+)\\s+([-\\d.]+)/);
    if (m) return Number(m[1]) > 0.1;
    m = c.match(/oklch\\(\\s*[\\d.]+%?\\s+([\\d.]+)\\s+([\\d.]+)/);
    if (m) { const h = Number(m[2]); return Number(m[1]) > 0.1 && (h < 60 || h > 330); }
    m = c.match(/rgba?\\(\\s*(\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)/);
    return !!m && m[1] - m[2] > 60 && m[1] - m[3] > 60;
  };
  return [...document.querySelectorAll('main [role="alert"]')]
    .filter((e) => e.getClientRects().length > 0 && red(getComputedStyle(e).borderTopColor))
    .map((e) => ({
      text: (e.innerText || '').split('\\n')[0].trim().slice(0, 160),
      retry: [...e.querySelectorAll('button')].some((b) => /^retry$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim())),
      issue,
    }));
})()`;

interface CdpTarget {
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
}

type BannerRow = { text: string; retry: boolean; issue?: number };

function evaluateTarget(wsUrl: string): Promise<BannerRow[]> {
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
      params: { expression: RED_BANNER_EXPRESSION, returnByValue: true },
    }));
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown } } };
        if (data.id !== 1) return;
        const value = data.result?.result?.value;
        finish(Array.isArray(value) ? value.filter((row) => row && typeof row.text === 'string') : []);
      } catch {
        finish([]);
      }
    };
    socket.onerror = () => finish([]);
    socket.onclose = () => finish([]);
  });
}

export async function readChatErrorBanners(cdpUrl: string): Promise<ChatErrorBanner[]> {
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
    && CONVERSATION_URL_RE.test(target.url)
    && typeof target.webSocketDebuggerUrl === 'string');
  const banners: ChatErrorBanner[] = [];
  for (const target of conversations) {
    for (const row of await evaluateTarget(target.webSocketDebuggerUrl!)) {
      banners.push({
        url: target.url!.split(/[?#]/)[0]!,
        text: row.text,
        retry: Boolean(row.retry),
        ...(Number.isSafeInteger(row.issue) && row.issue! > 0 ? { issue: row.issue } : {}),
      });
    }
  }
  return banners;
}
