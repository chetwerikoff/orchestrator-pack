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
    const deadline = Date.now() + timeoutMs;
    while (visible.length === 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const waitMs = Math.min(remainingMs, 50);
      if (typeof page.waitForTimeout === 'function') {
        await page.waitForTimeout(waitMs);
      } else {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
      visible = await visibleDialogs(dialogs);
    }
  }

  if (visible.length === 0) throw new Error('modal_timeout');
  if (visible.length !== 1 || visible[0]?.ordinal !== 0) throw captureAmbiguous();

  try {
    return await captureTooManyRequestsSource(page, options);
  } catch {
    throw captureAmbiguous();
  }
}
