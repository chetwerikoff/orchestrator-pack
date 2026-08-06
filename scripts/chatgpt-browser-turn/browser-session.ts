export interface TurnPageHandle {
  readonly page: unknown;
  readonly owned: boolean;
  readonly provisionalId?: string;
}

export const RESOURCE_CLEANUP_BOUND_MS = 5_000;
export const CDP_BROWSER_RELEASE_BOUND_MS = 15_000;
export const BEFORE_CDP_BROWSER_RELEASE = Symbol.for(
  'orchestrator-pack.before-cdp-browser-release',
);

export type ResourceCleanupOutcome = 'confirmed' | 'unconfirmed' | 'skipped';

export async function boundedResourceCleanup(
  cleanup: () => Promise<void>,
  budgetMs = RESOURCE_CLEANUP_BOUND_MS,
): Promise<'confirmed' | 'unconfirmed'> {
  let confirmed = false;
  try {
    await Promise.race([
      cleanup().then(() => { confirmed = true; }),
      new Promise<void>((resolve) => { setTimeout(resolve, budgetMs); }),
    ]);
  } catch {
    // Cleanup failure is failure-to-know; terminal result is already determined.
  }
  return confirmed ? 'confirmed' : 'unconfirmed';
}

export async function abandonLatePageHandle(
  page: unknown,
  cleanupBudgetMs = RESOURCE_CLEANUP_BOUND_MS,
): Promise<'confirmed' | 'unconfirmed'> {
  return await boundedResourceCleanup(
    () => (page as { close: () => Promise<void> }).close(),
    cleanupBudgetMs,
  );
}

export async function closeOwnedTurnPage(
  opened: TurnPageHandle | undefined,
  options: { readonly retainPage: boolean; readonly cleanupBudgetMs?: number },
): Promise<void> {
  if (!opened?.owned || options.retainPage) return;
  await boundedResourceCleanup(
    () => (opened.page as { close: () => Promise<void> }).close(),
    options.cleanupBudgetMs ?? RESOURCE_CLEANUP_BOUND_MS,
  );
}

interface ReleasableCdpBrowser {
  close: () => Promise<void>;
  [BEFORE_CDP_BROWSER_RELEASE]?: () => Promise<void>;
}

export async function releaseCdpBrowser(
  browser: unknown | null | undefined,
  cleanupBudgetMs = CDP_BROWSER_RELEASE_BOUND_MS,
): Promise<void> {
  if (!browser) return;
  const releasable = browser as ReleasableCdpBrowser;
  const startedAt = Date.now();
  const beforeRelease = releasable[BEFORE_CDP_BROWSER_RELEASE];
  if (typeof beforeRelease === 'function') {
    try {
      // The hook is itself bounded by the producer. Await it before starting
      // browser disconnect so terminal capture state is fixed before stdout.
      await beforeRelease.call(releasable);
    } catch {
      // The producer records a bounded capture-failure diagnostic.
    }
  }
  const remainingBudgetMs = Math.max(0, cleanupBudgetMs - (Date.now() - startedAt));
  await boundedResourceCleanup(
    () => (browser as { close: () => Promise<void> }).close(),
    remainingBudgetMs,
  );
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
