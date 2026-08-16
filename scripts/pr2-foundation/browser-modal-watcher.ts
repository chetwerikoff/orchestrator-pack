/**
 * Pack-owned ChatGPT rate-limit modal watcher.
 *
 * This is an observation/DOM-action helper only. Dismissing a visible modal
 * does not clear a server-side limit and never changes Browser-GPT send_count
 * or retry/harvest decisions.
 */

interface CdpPage {
  readonly id: string;
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
}

interface WebSocketLike {
  addEventListener(
    type: string,
    listener: (event: { readonly data?: unknown }) => void,
    options?: { readonly once?: boolean },
  ): void;
  send(data: string): void;
  close(): void;
}

interface WebSocketConstructorLike {
  new (url: string): WebSocketLike;
}

interface CdpResult {
  readonly id?: number;
  readonly error?: { readonly message?: string };
  readonly result?: {
    readonly exceptionDetails?: { readonly text?: string };
    readonly result?: { readonly value?: unknown };
  };
}

const DEFAULT_CDP = 'http://127.0.0.1:9222';
const PAGE_REFRESH_MS = 700;
const CDP_TIMEOUT_MS = 4_000;
const MAX_MODAL_TEXT_LENGTH = 600;

/**
 * Deliberately scans ordinary divs as well as semantic containers. ChatGPT's
 * rate-limit modal is currently a plain div with no dialog role.
 */
export const MODAL_PROBE_EXPRESSION = `(() => {
  const RE = /too many requests|making requests too quickly|temporarily limited/i;
  const nodes = [...document.querySelectorAll('div,dialog,[role="dialog"]')];
  for (const el of nodes) {
    const text = el.innerText || '';
    if (text.length >= ${MAX_MODAL_TEXT_LENGTH} || !RE.test(text)) continue;
    const button = [...el.querySelectorAll('button')]
      .find((candidate) => /^\\s*(got it|ok)\\s*$/i.test(candidate.innerText || ''));
    if (!button) continue;
    button.click();
    return JSON.stringify({ found: true, clicked: true });
  }
  return '';
})()`;

function cdpBase(raw: string): string {
  return raw.replace(/\/+$/, '');
}

function pageIsChatGpt(page: CdpPage): boolean {
  if (page.type !== 'page' || typeof page.webSocketDebuggerUrl !== 'string') return false;
  try {
    return new URL(page.url ?? '').hostname.endsWith('chatgpt.com');
  } catch {
    return false;
  }
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}

type Connection = {
  readonly pageId: string;
  readonly socket: WebSocketLike;
  nextCommandId: number;
  pending: boolean;
  alive: boolean;
  url: string;
};

export class ModalWatcher {
  private readonly connections = new Map<string, Connection>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private hits = 0;
  private readonly cdp: string;
  private readonly websocket: WebSocketConstructorLike;

  public constructor(
    cdp: string = DEFAULT_CDP,
    websocket?: WebSocketConstructorLike,
  ) {
    this.cdp = cdp;
    this.websocket = websocket ??
      (globalThis as unknown as { WebSocket?: WebSocketConstructorLike }).WebSocket ??
      (() => {
        throw new Error('websocket_unavailable');
      }) as unknown as WebSocketConstructorLike;
  }

  public start(): void {
    if (this.timer) return;
    log('modal_watcher_started', { cdp: this.cdp, refresh_ms: PAGE_REFRESH_MS });
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), PAGE_REFRESH_MS);
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const connection of this.connections.values()) {
      try {
        connection.socket.close();
      } catch {
        // The page may already have disappeared.
      }
    }
    this.connections.clear();
    log('modal_watcher_stopped');
  }

  private async refresh(): Promise<void> {
    if (this.stopping) return;
    try {
      const response = await fetch(`${cdpBase(this.cdp)}/json/list`, {
        signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`cdp_list_http_${response.status}`);
      const value: unknown = await response.json();
      if (!Array.isArray(value)) throw new Error('cdp_list_not_array');
      const pages = value.filter((page): page is CdpPage => pageIsChatGpt(page as CdpPage));
      log('modal_watcher_scan', { pages: pages.length });
      const seen = new Set(pages.map((page) => page.id));
      for (const page of pages) {
        if (!this.connections.has(page.id)) this.attach(page);
        else this.connections.get(page.id)!.url = page.url ?? '';
      }
      for (const [pageId, connection] of this.connections) {
        if (!seen.has(pageId)) {
          try {
            connection.socket.close();
          } catch {
            // The target is already gone.
          }
          this.connections.delete(pageId);
          continue;
        }
        this.probe(connection);
      }
    } catch (error) {
      log('modal_watcher_refresh_failed', { reason: error instanceof Error ? error.message : String(error) });
    }
  }

  private attach(page: CdpPage): void {
    let socket: WebSocketLike;
    try {
      socket = new this.websocket(page.webSocketDebuggerUrl!);
    } catch (error) {
      log('modal_watcher_attach_failed', { page_id: page.id, reason: String(error) });
      return;
    }
    const connection: Connection = {
      pageId: page.id,
      socket,
      nextCommandId: 0,
      pending: false,
      alive: false,
      url: page.url ?? '',
    };
    this.connections.set(page.id, connection);
    socket.addEventListener('open', () => {
      connection.alive = true;
      log('modal_watcher_page_attached', { page_id: page.id, url: connection.url });
    }, { once: true });
    socket.addEventListener('error', () => this.connections.delete(page.id), { once: true });
    socket.addEventListener('close', () => this.connections.delete(page.id), { once: true });
    socket.addEventListener('message', (event) => this.handleMessage(connection, event.data));
  }

  private probe(connection: Connection): void {
    if (!connection.alive || connection.pending) return;
    connection.pending = true;
    const id = ++connection.nextCommandId;
    try {
      connection.socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression: MODAL_PROBE_EXPRESSION, returnByValue: true, userGesture: true },
      }));
    } catch {
      connection.pending = false;
      this.connections.delete(connection.pageId);
    }
    setTimeout(() => {
      if (connection.pending) connection.pending = false;
    }, CDP_TIMEOUT_MS);
  }

  private handleMessage(connection: Connection, raw: unknown): void {
    let message: CdpResult;
    try {
      message = JSON.parse(String(raw)) as CdpResult;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    connection.pending = false;
    const value = message.result?.result?.value;
    if (message.error || message.result?.exceptionDetails || !value) return;
    this.hits += 1;
    log('modal_dismissed', { hit: this.hits, page_id: connection.pageId, result: value, url: connection.url });
  }
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1]?.endsWith('browser-modal-watcher.ts')) {
  const watcher = new ModalWatcher(argumentValue('--cdp') ?? process.env.OPK_BROWSER_CDP ?? DEFAULT_CDP);
  const shutdown = () => void watcher.stop().finally(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  watcher.start();
}
