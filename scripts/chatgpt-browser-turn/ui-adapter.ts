// Compatibility facade over the existing UI adapter. Issue #1937 needs one
// bounded, shared product-state confirmation seam without duplicating the
// adapter's existing transport/runtime implementation.
export * from './ui-adapter-base.ts';

import * as base from './ui-adapter-base.ts';
import {
  ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
  classifyProductMessage,
  MESSAGE_AUTHOR_ROLE_ATTR,
  MESSAGE_NODE_SELECTOR,
} from './product-page-selectors.ts';
import {
  currentOwnedPromptMarker,
  ownedPromptMarkerMatches,
} from './owned-prompt-marker.ts';

export interface ProductStatusSurface extends base.ProductStatusSurface {
  /** Internal proof bit consumed only by the shared product-wall classifier. */
  readonly owned_message_delivery_timeout_stable?: true;
}

export type ProductWallClassification =
  | ReturnType<typeof base.classifyProductWall>
  | { state: 'message_delivery_timed_out'; cause: 'message_delivery_timed_out' };

type OperationWaitSource = number | (() => number);

const DEFAULT_CONFIRM_BUDGET_MS = 5_000;
const DELIVERY_TIMEOUT_CONFIRM_DELAY_MS = 100;
const DELIVERY_TIMEOUT_EVIDENCE_READ_CAP_MS = 300;

interface OwnedTurnSnapshot {
  readonly complete: boolean;
  readonly generationInProgress: boolean | 'unknown';
  readonly rows: readonly { role: string; text: string }[];
}

async function boundedRead<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) throw new Error('product_status_confirmation_budget_exhausted');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('product_status_confirmation_timeout')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function delay(page: any, milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  if (typeof page?.waitForTimeout === 'function') {
    await page.waitForTimeout(milliseconds);
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function readOwnedTurnSnapshot(
  page: any,
  remainingMs: () => number,
): Promise<OwnedTurnSnapshot | undefined> {
  try {
    const waitMs = Math.min(
      DELIVERY_TIMEOUT_EVIDENCE_READ_CAP_MS,
      Math.max(0, remainingMs()),
    );
    if (waitMs <= 0) return undefined;
    const nodes = page.locator(MESSAGE_NODE_SELECTOR);
    if (typeof nodes?.evaluateAll !== 'function') return undefined;
    return await boundedRead(
      Promise.resolve(nodes.evaluateAll((elements: Element[], args: {
        roleAttribute: string;
        generationSelector: string;
      }) => {
        const rows: Array<{ role: string; text: string }> = [];
        let complete = true;
        for (const element of elements) {
          try {
            const role = element.getAttribute(args.roleAttribute) ?? '';
            const text = (element as HTMLElement).innerText;
            if (role === 'user' || role === 'assistant') rows.push({ role, text });
            else complete = false;
          } catch {
            complete = false;
          }
        }
        let generationInProgress: boolean | 'unknown' = 'unknown';
        try {
          generationInProgress = Boolean(document.querySelector(args.generationSelector));
        } catch {
          generationInProgress = 'unknown';
        }
        return { complete, generationInProgress, rows };
      }, {
        roleAttribute: MESSAGE_AUTHOR_ROLE_ATTR,
        generationSelector: ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
      })),
      waitMs,
    ) as OwnedTurnSnapshot;
  } catch {
    return undefined;
  }
}

function exactOwnedDeadTurn(snapshot: OwnedTurnSnapshot | undefined, marker: string): boolean {
  if (!snapshot?.complete || snapshot.generationInProgress !== false) return false;
  const ownedIndexes = snapshot.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.role === 'user' && ownedPromptMarkerMatches(row.text, marker));
  if (ownedIndexes.length !== 1) return false;
  const ownedIndex = ownedIndexes[0]!.index;
  const afterOwned = snapshot.rows.slice(ownedIndex + 1);
  if (afterOwned.some((row) => row.role === 'user')) return false;
  if (afterOwned.some((row) => row.role === 'assistant')) return false;
  return true;
}

/**
 * Reuses the canonical product-status surface and adds one bounded second read
 * only for the exact timeout copy on this process's exact owned invocation.
 * No Retry control is clicked and no send path is entered here.
 */
export async function productStatusText(
  page: any,
  waitSource?: OperationWaitSource,
): Promise<ProductStatusSurface> {
  const startedAt = Date.now();
  const fixedDeadline = startedAt + (
    typeof waitSource === 'number' ? waitSource : DEFAULT_CONFIRM_BUDGET_MS
  );
  const remainingMs = (): number => {
    const callerRemaining = typeof waitSource === 'function'
      ? waitSource()
      : fixedDeadline - Date.now();
    return Math.max(0, callerRemaining);
  };
  const remainingSource = (): number => remainingMs();

  const initial = await base.productStatusText(page, remainingSource);
  if (classifyProductMessage(initial).state !== 'message_delivery_timed_out') return initial;

  const marker = currentOwnedPromptMarker();
  if (!marker) return initial;
  const initialSnapshot = await readOwnedTurnSnapshot(page, remainingMs);
  if (!exactOwnedDeadTurn(initialSnapshot, marker)) return initial;

  const beforeDelay = remainingMs();
  if (beforeDelay <= DELIVERY_TIMEOUT_CONFIRM_DELAY_MS) return initial;
  await delay(page, DELIVERY_TIMEOUT_CONFIRM_DELAY_MS);
  if (remainingMs() <= 0) return initial;

  const confirmed = await base.productStatusText(page, remainingSource);
  if (classifyProductMessage(confirmed).state !== 'message_delivery_timed_out') return confirmed;
  const confirmedSnapshot = await readOwnedTurnSnapshot(page, remainingMs);
  if (!exactOwnedDeadTurn(confirmedSnapshot, marker)) return confirmed;

  return { ...confirmed, owned_message_delivery_timeout_stable: true };
}

/** Shared wall classifier consumed by state-light and checkpoint-adjacent callers. */
export function classifyProductWall(surface: ProductStatusSurface): ProductWallClassification {
  if (
    surface.owned_message_delivery_timeout_stable === true
    && classifyProductMessage(surface).state === 'message_delivery_timed_out'
  ) {
    return { state: 'message_delivery_timed_out', cause: 'message_delivery_timed_out' };
  }
  return base.classifyProductWall(surface);
}
