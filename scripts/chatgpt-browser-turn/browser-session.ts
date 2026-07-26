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
