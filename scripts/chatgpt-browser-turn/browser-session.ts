export interface TurnPageHandle {
  readonly page: unknown;
  readonly owned: boolean;
  readonly provisionalId?: string;
}

export async function closeOwnedTurnPage(
  opened: TurnPageHandle | undefined,
  options: { readonly retainPage: boolean },
): Promise<void> {
  if (!opened?.owned || options.retainPage) return;
  try {
    await (opened.page as { close: () => Promise<void> }).close();
  } catch {
    // Release failures must not alter the already-determined terminal result.
  }
}

export async function releaseCdpBrowser(browser: unknown | null | undefined): Promise<void> {
  if (!browser) return;
  try {
    await (browser as { close: () => Promise<void> }).close();
  } catch {
    // Release failures must not alter the already-determined terminal result.
  }
}


export const CDP_CONNECT_TIMEOUT_MS = 120_000;

export async function connectCdpBrowser(
  chromium: { connectOverCDP: (endpoint: string, options?: { timeout?: number }) => Promise<unknown> },
  cdp: string,
): Promise<unknown> {
  return chromium.connectOverCDP(cdp, { timeout: CDP_CONNECT_TIMEOUT_MS });
}

export async function trimExcessCdpPageTargets(
  cdp: string,
  options: { readonly urlIncludes?: string; readonly keep?: number } = {},
): Promise<number> {
  const endpoint = new URL(cdp);
  endpoint.hash = '';
  endpoint.search = '';
  const base = endpoint.toString().replace(/\/$/, '');
  const list = await fetch(`${base}/json/list`).then((response) => response.json()) as Array<{
    readonly id?: string;
    readonly type?: string;
    readonly url?: string;
  }>;
  const keep = options.keep ?? 3;
  const needle = options.urlIncludes ?? 'chatgpt.com';
  const pages = list.filter((target) => target.type === 'page' && (target.url ?? '').includes(needle));
  let closed = 0;
  for (const target of pages.slice(keep)) {
    if (!target.id) continue;
    await fetch(`${base}/json/close/${target.id}`).catch(() => {});
    closed++;
  }
  return closed;
}

