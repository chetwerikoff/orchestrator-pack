// Issue #1937 keeps the existing UI adapter implementation isolated below and
// adds one narrow execute-Issue recovery classifier at the public adapter edge.
// All ordinary Browser-GPT behavior continues to delegate to the existing
// implementation; this file owns only the two exact product-error literals and
// their bounded owned-turn confirmation.
export * from './ui-adapter-base.ts';

import * as base from './ui-adapter-base.ts';
import {
  ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
  CONVERSATION_TURN_SECTION_SELECTOR,
  MESSAGE_AUTHOR_ROLE_ATTR,
  MESSAGE_NODE_SELECTOR,
  PRODUCT_STATUS_PROBE_SELECTORS,
  STOP_BUTTON_SELECTOR,
  stripUiCollapseAffixes,
} from './product-page-selectors.ts';
import {
  currentOwnedPromptMarker,
  ownedPromptMarkerMatches,
} from './owned-prompt-marker.ts';
import { recoveryMarkerCardinality } from './state-light-turn-recovery.ts';

export type ExecutionRecoveryProductCause =
  | 'message_delivery_timed_out'
  | 'product_network_error';

export interface ExecutionRecoveryMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly turnKey?: string;
}

export interface ExecutionRecoveryProductErrorEvidence {
  readonly surface: base.ProductStatusSurface;
  readonly marker: string;
  readonly transcriptComplete: boolean;
  readonly generationInProgress: boolean | 'unknown';
  readonly messages: readonly ExecutionRecoveryMessage[];
  readonly surfaceTurnKey?: string;
}

export interface ProductStatusSurface extends base.ProductStatusSurface {
  /** Internal proof consumed only by the state-light wall projection. */
  readonly execution_recovery_cause_stable?: ExecutionRecoveryProductCause;
}

export type ProductWallClassification =
  | ReturnType<typeof base.classifyProductWall>
  | { state: 'recovery_required'; cause: ExecutionRecoveryProductCause };

type OperationWaitSource = number | (() => number);

const DEFAULT_CONFIRM_BUDGET_MS = 5_000;
const EXECUTION_RECOVERY_CONFIRM_DELAY_MS = 100;
const EXECUTION_RECOVERY_EVIDENCE_READ_CAP_MS = 300;
const OWNED_TURN_GENERATION_SELECTOR = [
  STOP_BUTTON_SELECTOR,
  ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
].join(', ');
const PRODUCT_STATUS_SELECTOR = PRODUCT_STATUS_PROBE_SELECTORS.join(', ');

interface OwnedTurnSnapshot {
  readonly complete: boolean;
  readonly generationInProgress: boolean | 'unknown';
  readonly rows: readonly ExecutionRecoveryMessage[];
  readonly productSurfaces: readonly { text: string; turnKey?: string }[];
}

function normalizeExecutionRecoveryProductText(value: string): string {
  return stripUiCollapseAffixes(value)
    .replace(/\p{White_Space}+/gu, ' ')
    .trim()
    .toLowerCase();
}

function executionRecoveryCauseFromText(value: string): ExecutionRecoveryProductCause | undefined {
  const text = normalizeExecutionRecoveryProductText(value);
  if (/(?:^|\s)message delivery timed out\.\s*please try again\.?(?:\s|$)/u.test(text)) {
    return 'message_delivery_timed_out';
  }
  if (/(?:^|\s)a network error occurred\.\s*please check your connection and try again\.\s*if this issue persists please contact us through our help center at help\.openai\.com\.?(?:\s|$)/u.test(text)) {
    return 'product_network_error';
  }
  return undefined;
}

/**
 * Sole matcher/owned-turn classifier for the two execute-Issue product errors.
 * Product text alone is never recovery authority: the exact owned prompt must
 * be the current turn, the banner must be inside that same conversation-turn
 * container, no assistant carrier may have appeared for the owned turn, and
 * generation must be positively stopped.
 */
export function classifyExecutionRecoveryProductError(
  evidence: ExecutionRecoveryProductErrorEvidence,
): { cause?: ExecutionRecoveryProductCause } {
  const cause = executionRecoveryCauseFromText(evidence.surface.text);
  if (!cause) return {};
  if (!evidence.transcriptComplete || evidence.generationInProgress !== false) return {};

  const cardinality = recoveryMarkerCardinality(evidence.messages, evidence.marker);
  if (
    cardinality.matchingUserCarrierCount !== 1
    || cardinality.exactMarkerTokenCount !== 1
  ) {
    return {};
  }

  const owned = evidence.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => (
      message.role === 'user'
      && ownedPromptMarkerMatches(message.text, evidence.marker)
    ));
  if (owned.length !== 1) return {};

  const ownedMessage = owned[0]!;
  if (!ownedMessage.message.turnKey
    || !evidence.surfaceTurnKey
    || ownedMessage.message.turnKey !== evidence.surfaceTurnKey) {
    return {};
  }

  const suffix = evidence.messages.slice(ownedMessage.index + 1);
  if (suffix.some((message) => message.role === 'user')) return {};
  // Any assistant carrier is reply evidence to recover/settle rather than
  // authority to abandon the conversation, even when completion is uncertain.
  if (suffix.some((message) => message.role === 'assistant')) return {};

  return { cause };
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
      EXECUTION_RECOVERY_EVIDENCE_READ_CAP_MS,
      Math.max(0, remainingMs()),
    );
    if (waitMs <= 0) return undefined;
    const nodes = page.locator(MESSAGE_NODE_SELECTOR);
    if (typeof nodes?.evaluateAll !== 'function') return undefined;
    return await boundedRead(
      Promise.resolve(nodes.evaluateAll((elements: Element[], args: {
        roleAttribute: string;
        generationSelector: string;
        turnSelector: string;
        productSelector: string;
      }) => {
        const rows: Array<{ role: 'user' | 'assistant'; text: string; turnKey?: string }> = [];
        const productSurfaces: Array<{ text: string; turnKey?: string }> = [];
        let complete = true;
        for (const element of elements) {
          try {
            const role = element.getAttribute(args.roleAttribute) ?? '';
            const text = (element as HTMLElement).innerText;
            if (role === 'user' || role === 'assistant') {
              const turnKey = element.closest(args.turnSelector)?.getAttribute('data-testid') ?? undefined;
              rows.push({ role, text, ...(turnKey ? { turnKey } : {}) });
            } else {
              complete = false;
            }
          } catch {
            complete = false;
          }
        }
        try {
          for (const element of Array.from(document.querySelectorAll(args.productSelector))) {
            const text = (element as HTMLElement).innerText;
            if (!text) continue;
            const turnKey = element.closest(args.turnSelector)?.getAttribute('data-testid') ?? undefined;
            productSurfaces.push({ text, ...(turnKey ? { turnKey } : {}) });
          }
        } catch {
          complete = false;
        }
        let generationInProgress: boolean | 'unknown' = 'unknown';
        try {
          generationInProgress = Boolean(document.querySelector(args.generationSelector));
        } catch {
          generationInProgress = 'unknown';
        }
        return { complete, generationInProgress, rows, productSurfaces };
      }, {
        roleAttribute: MESSAGE_AUTHOR_ROLE_ATTR,
        generationSelector: OWNED_TURN_GENERATION_SELECTOR,
        turnSelector: CONVERSATION_TURN_SECTION_SELECTOR,
        productSelector: PRODUCT_STATUS_SELECTOR,
      })),
      waitMs,
    ) as OwnedTurnSnapshot;
  } catch {
    return undefined;
  }
}

function recoveryCauseFromSnapshot(
  snapshot: OwnedTurnSnapshot | undefined,
  marker: string,
): ExecutionRecoveryProductCause | undefined {
  if (!snapshot) return undefined;
  let cause: ExecutionRecoveryProductCause | undefined;
  for (const productSurface of snapshot.productSurfaces) {
    const classified = classifyExecutionRecoveryProductError({
      surface: { text: productSurface.text, composer: true },
      marker,
      transcriptComplete: snapshot.complete,
      generationInProgress: snapshot.generationInProgress,
      messages: snapshot.rows,
      ...(productSurface.turnKey ? { surfaceTurnKey: productSurface.turnKey } : {}),
    }).cause;
    if (!classified) continue;
    if (cause && cause !== classified) return undefined;
    cause = classified;
  }
  return cause;
}

/**
 * Reuses the canonical product-status surface and adds one bounded second read
 * only as owned-turn confirmation. It never clicks Retry and never enters a
 * send path.
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
  const marker = currentOwnedPromptMarker();
  if (!marker) return initial;

  const firstSnapshot = await readOwnedTurnSnapshot(page, remainingMs);
  const firstCause = recoveryCauseFromSnapshot(firstSnapshot, marker);
  if (!firstCause) return initial;

  const beforeDelay = remainingMs();
  if (beforeDelay <= EXECUTION_RECOVERY_CONFIRM_DELAY_MS) return initial;
  await delay(page, EXECUTION_RECOVERY_CONFIRM_DELAY_MS);
  if (remainingMs() <= 0) return initial;

  const confirmed = await base.productStatusText(page, remainingSource);
  const secondSnapshot = await readOwnedTurnSnapshot(page, remainingMs);
  const secondCause = recoveryCauseFromSnapshot(secondSnapshot, marker);
  if (secondCause !== firstCause) return confirmed;

  return { ...confirmed, execution_recovery_cause_stable: firstCause };
}

/** Shared wall projection consumed by state-light callers. */
export function classifyProductWall(surface: ProductStatusSurface): ProductWallClassification {
  if (surface.execution_recovery_cause_stable) {
    return {
      state: 'recovery_required',
      cause: surface.execution_recovery_cause_stable,
    };
  }
  return base.classifyProductWall(surface);
}
