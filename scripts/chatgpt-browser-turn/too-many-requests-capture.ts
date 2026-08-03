import {
  captureTooManyRequestsSource,
  type TooManyRequestsSourceV2,
} from './too-many-requests-source.ts';

interface VisibleDialog {
  readonly locator: any;
  readonly ordinal: number;
}

async function visibleDialogs(locator: any): Promise<VisibleDialog[]> {
  const count = await locator.count();
  const visible: VisibleDialog[] = [];
  for (let index = 0; index < count; index++) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible()) visible.push({ locator: candidate, ordinal: index });
  }
  return visible;
}

function captureAmbiguous(): Error {
  return new Error('capture_ambiguous_visible_match');
}

export async function captureTooManyRequestsSourceWithWait(
  page: any,
  timeoutMs: number,
  options: { observedAt?: string; sourceLocalOccurrence?: string } = {},
): Promise<TooManyRequestsSourceV2> {
  const dialogs = page.locator('[role="dialog"][aria-modal="true"]');
  let visible = await visibleDialogs(dialogs);

  if (visible.length === 0) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('modal_timeout');
    try {
      await dialogs.waitFor({ state: 'visible', timeout: timeoutMs });
    } catch {
      // The authoritative outcome comes from the bounded post-wait public-surface reread below.
    }
    visible = await visibleDialogs(dialogs);
  }

  if (visible.length === 0) throw new Error('modal_timeout');
  if (visible.length !== 1 || visible[0]?.ordinal !== 0) throw captureAmbiguous();

  try {
    return await captureTooManyRequestsSource(page, options);
  } catch {
    throw captureAmbiguous();
  }
}
