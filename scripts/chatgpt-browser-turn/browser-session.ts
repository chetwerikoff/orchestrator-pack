export interface TurnPageHandle {
  readonly page: unknown;
  readonly owned: boolean;
  readonly provisionalId?: string;
}

export const RESOURCE_CLEANUP_BOUND_MS = 5_000;

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

export async function releaseCdpBrowser(
  browser: unknown | null | undefined,
  cleanupBudgetMs = RESOURCE_CLEANUP_BOUND_MS,
): Promise<void> {
  if (!browser) return;
  await boundedResourceCleanup(
    () => (browser as { close: () => Promise<void> }).close(),
    cleanupBudgetMs,
  );
}
