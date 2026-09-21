// Issue #1937 keeps the existing UI adapter implementation isolated below and
// adds one narrow execute-Issue recovery classifier at the public adapter edge.
// All ordinary Browser-GPT behavior continues to delegate to the existing
// implementation; this file owns only the two exact product-error literals and
// their bounded owned-turn confirmation.
export * from './ui-adapter-base.ts';

import * as base from './ui-adapter-base.ts';
import {
  ASSISTANT_MESSAGE_SELECTOR,
  ASSISTANT_TURN_ACTION_SELECTOR,
  ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
  CONVERSATION_TURN_SECTION_SELECTOR,
  MESSAGE_AUTHOR_ROLE_ATTR,
  MESSAGE_NODE_SELECTOR,
  REGENERATE_THREAD_ERROR_BUTTON_SELECTOR,
  STOP_BUTTON_SELECTOR,
  UI_COLLAPSE_AFFIX_RE,
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

export type ExecutionRecoveryReasonCode =
  | 'no_owned_prompt'
  | 'generation_active'
  | 'literal_not_found'
  | 'retry_control_missing'
  | 'later_user_turn'
  | 'extra_assistant_carrier'
  | 'turn_not_successor'
  | 'mixed_carrier'
  | 'ambiguous_marker'
  | 'transcript_incomplete';

export interface ExecutionRecoveryBannerCandidate {
  readonly turnKey?: string;
  readonly paragraphTexts: readonly string[];
  readonly retryControlPresent: boolean;
  readonly hasNonBannerContent?: boolean;
}

export interface ExecutionRecoveryProductErrorEvidence {
  readonly marker: string;
  readonly transcriptComplete: boolean;
  readonly generationInProgress: boolean | 'unknown';
  readonly messages: readonly ExecutionRecoveryMessage[];
  readonly conversationTurnKeys: readonly string[];
  readonly bannerCandidates: readonly ExecutionRecoveryBannerCandidate[];
}

export interface ExecutionRecoveryClassification {
  readonly cause?: ExecutionRecoveryProductCause;
  readonly reason?: ExecutionRecoveryReasonCode;
  readonly owned_user_turn_key?: string;
  readonly candidate_assistant_turn_key?: string;
  readonly retry_control_present: boolean;
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
const MESSAGE_DELIVERY_TIMED_OUT_TEXT = 'Message delivery timed out. Please try again.';
const PRODUCT_NETWORK_ERROR_TEXT = 'A network error occurred. Please check your connection and try again. If this issue persists please contact us through our help center at help.openai.com.';
const OWNED_TURN_GENERATION_SELECTOR = [
  STOP_BUTTON_SELECTOR,
  ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
].join(', ');

// The execute-Issue recovery projection is intentionally narrower than the
// shared product-status helper. Other state-light consumers (notably session
// mode used by create/review flows) import this adapter too, but Issue #1937
// must not grant those workflows new recovery authority. Ordinary turn mode
// enters this process-local scope for the duration of runStateLightTurn.
let executionRecoveryProductWallScopeDepth = 0;

export function enterExecutionRecoveryProductWallScope(): () => void {
  executionRecoveryProductWallScopeDepth += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    executionRecoveryProductWallScopeDepth = Math.max(0, executionRecoveryProductWallScopeDepth - 1);
  };
}

interface OwnedTurnSnapshot {
  readonly complete: boolean;
  readonly generationInProgress: boolean | 'unknown';
  readonly rows: readonly ExecutionRecoveryMessage[];
  readonly conversationTurnKeys: readonly string[];
  readonly bannerCandidates: readonly ExecutionRecoveryBannerCandidate[];
}

function normalizeExecutionRecoveryProductText(value: string): string {
  return value
    .replace(/\p{White_Space}+/gu, ' ')
    // The network-error copy ends with a rendered help-center link followed by
    // punctuation. DOM extraction may expose one separator between the anchor
    // text and that punctuation; normalize only this known link-rendering seam.
    .replace(/help\.openai\.com \.$/u, 'help.openai.com.')
    .trim();
}

function stripExecutionRecoveryCollapseLabels(value: string): string {
  let result = value;
  for (let pass = 0; pass < 3; pass++) {
    const next = result.replace(UI_COLLAPSE_AFFIX_RE, '').trim();
    if (next === result) break;
    result = next;
  }
  return result;
}

function matchesExecutionRecoveryProductText(value: string, exact: string): boolean {
  const normalized = normalizeExecutionRecoveryProductText(value);
  if (normalized === exact) return true;

  const withoutCollapseLabel = stripExecutionRecoveryCollapseLabels(normalized);
  if (withoutCollapseLabel !== normalized && withoutCollapseLabel === exact) return true;

  // Existing collapse rendering can append an ellipsis to an otherwise exact
  // sentence. Preserve the canonical terminal period as part of the authority:
  // a near-match missing that punctuation must still fail closed.
  return withoutCollapseLabel === `${exact}…`
    || withoutCollapseLabel === `${exact}...`;
}

function executionRecoveryCauseFromText(value: string): ExecutionRecoveryProductCause | undefined {
  if (matchesExecutionRecoveryProductText(value, MESSAGE_DELIVERY_TIMED_OUT_TEXT)) {
    return 'message_delivery_timed_out';
  }
  if (matchesExecutionRecoveryProductText(value, PRODUCT_NETWORK_ERROR_TEXT)) {
    return 'product_network_error';
  }
  return undefined;
}

function uniqueTurnKeysInOrder(messages: readonly ExecutionRecoveryMessage[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (!message.turnKey || seen.has(message.turnKey)) continue;
    seen.add(message.turnKey);
    keys.push(message.turnKey);
  }
  return keys;
}

function successorTurnKey(turnKeys: readonly string[], ownedTurnKey: string): string | undefined {
  const index = turnKeys.indexOf(ownedTurnKey);
  if (index < 0 || index + 1 >= turnKeys.length) return undefined;
  return turnKeys[index + 1];
}

function paragraphCause(text: string): ExecutionRecoveryProductCause | undefined {
  return executionRecoveryCauseFromText(text);
}

function candidateHasNonBannerParagraph(candidate: ExecutionRecoveryBannerCandidate): boolean {
  return candidate.paragraphTexts.some((text) => !paragraphCause(text) && normalizeExecutionRecoveryProductText(text).length > 0);
}

function candidateHasNonBannerContent(candidate: ExecutionRecoveryBannerCandidate): boolean {
  return candidate.hasNonBannerContent === true || candidateHasNonBannerParagraph(candidate);
}

function emptyClassification(
  reason: ExecutionRecoveryReasonCode,
  extra: Omit<ExecutionRecoveryClassification, 'reason' | 'retry_control_present'> & {
    readonly retry_control_present?: boolean;
  } = {},
): ExecutionRecoveryClassification {
  return {
    reason,
    retry_control_present: extra.retry_control_present === true,
    ...(extra.owned_user_turn_key ? { owned_user_turn_key: extra.owned_user_turn_key } : {}),
    ...(extra.candidate_assistant_turn_key
      ? { candidate_assistant_turn_key: extra.candidate_assistant_turn_key }
      : {}),
  };
}

/**
 * Sole matcher/owned-turn classifier for the two execute-Issue product errors.
 * Product text alone is never recovery authority: the exact owned prompt must
 * be unique, the banner must be a bounded descendant of the assistant carrier
 * in the structural successor conversation-turn, that same carrier must hold
 * regenerate-thread-error-button, generation must be positively stopped, and
 * no later user turn or extra assistant carrier may be present.
 */
export function classifyExecutionRecoveryProductError(
  evidence: ExecutionRecoveryProductErrorEvidence,
): ExecutionRecoveryClassification {
  const turnKeys = evidence.conversationTurnKeys.length > 0
    ? evidence.conversationTurnKeys
    : uniqueTurnKeysInOrder(evidence.messages);
  const retryPresentAnywhere = evidence.bannerCandidates.some((candidate) => candidate.retryControlPresent);

  if (!evidence.transcriptComplete) {
    return emptyClassification('transcript_incomplete', { retry_control_present: retryPresentAnywhere });
  }
  if (evidence.generationInProgress !== false) {
    return emptyClassification('generation_active', { retry_control_present: retryPresentAnywhere });
  }

  const cardinality = recoveryMarkerCardinality(evidence.messages, evidence.marker);
  if (cardinality.matchingUserCarrierCount === 0 || cardinality.exactMarkerTokenCount === 0) {
    return emptyClassification('no_owned_prompt', { retry_control_present: retryPresentAnywhere });
  }
  if (
    cardinality.matchingUserCarrierCount !== 1
    || cardinality.exactMarkerTokenCount !== 1
  ) {
    return emptyClassification('ambiguous_marker', { retry_control_present: retryPresentAnywhere });
  }

  const owned = evidence.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => (
      message.role === 'user'
      && ownedPromptMarkerMatches(message.text, evidence.marker)
    ));
  if (owned.length !== 1) {
    return emptyClassification('no_owned_prompt', { retry_control_present: retryPresentAnywhere });
  }

  const ownedMessage = owned[0]!;
  const ownedTurnKey = ownedMessage.message.turnKey;
  const suffix = evidence.messages.slice(ownedMessage.index + 1);
  if (suffix.some((message) => message.role === 'user')) {
    return emptyClassification('later_user_turn', {
      retry_control_present: retryPresentAnywhere,
      ...(ownedTurnKey ? { owned_user_turn_key: ownedTurnKey } : {}),
    });
  }

  const assistants = suffix.filter((message) => message.role === 'assistant');
  if (assistants.length > 1) {
    return emptyClassification('extra_assistant_carrier', {
      retry_control_present: retryPresentAnywhere,
      ...(ownedTurnKey ? { owned_user_turn_key: ownedTurnKey } : {}),
    });
  }
  if (assistants.length !== 1 || !ownedTurnKey) {
    return emptyClassification('literal_not_found', {
      retry_control_present: retryPresentAnywhere,
      ...(ownedTurnKey ? { owned_user_turn_key: ownedTurnKey } : {}),
    });
  }

  const assistantTurnKey = assistants[0]!.turnKey;
  const successor = successorTurnKey(turnKeys, ownedTurnKey);
  if (!assistantTurnKey || !successor || assistantTurnKey !== successor) {
    return emptyClassification('turn_not_successor', {
      retry_control_present: retryPresentAnywhere,
      owned_user_turn_key: ownedTurnKey,
      ...(assistantTurnKey ? { candidate_assistant_turn_key: assistantTurnKey } : {}),
    });
  }

  const holder = evidence.bannerCandidates.filter((candidate) => candidate.turnKey === assistantTurnKey);
  const retryInHolder = holder.some((candidate) => candidate.retryControlPresent);
  const classifiedFromHolder = holder.flatMap((candidate) => (
    candidate.paragraphTexts
      .map((text) => paragraphCause(text))
      .filter((cause): cause is ExecutionRecoveryProductCause => Boolean(cause))
  ));
  const uniqueCauses = [...new Set(classifiedFromHolder)];

  if (uniqueCauses.length !== 1) {
    return emptyClassification('literal_not_found', {
      retry_control_present: retryInHolder,
      owned_user_turn_key: ownedTurnKey,
      candidate_assistant_turn_key: assistantTurnKey,
    });
  }
  if (holder.some(candidateHasNonBannerContent)) {
    return emptyClassification('mixed_carrier', {
      retry_control_present: retryInHolder,
      owned_user_turn_key: ownedTurnKey,
      candidate_assistant_turn_key: assistantTurnKey,
    });
  }
  if (!retryInHolder) {
    return emptyClassification('retry_control_missing', {
      retry_control_present: false,
      owned_user_turn_key: ownedTurnKey,
      candidate_assistant_turn_key: assistantTurnKey,
    });
  }

  return {
    cause: uniqueCauses[0],
    owned_user_turn_key: ownedTurnKey,
    candidate_assistant_turn_key: assistantTurnKey,
    retry_control_present: true,
  };
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
        assistantSelector: string;
        retrySelector: string;
        chromeSelector: string;
        timeoutText: string;
        networkText: string;
      }) => {
        const normalize = (value: string): string => value.replace(/\s+/g, ' ').replace(/help\.openai\.com \.$/u, 'help.openai.com.').trim();
        const collapseRe = /(?:\s*(?:show more|read more|see more|view more|continue reading)\s*)+$/iu;
        const isReservedBanner = (value: string): boolean => {
          const normalized = normalize(value);
          if (normalized === args.timeoutText || normalized === args.networkText) return true;
          const stripped = normalized.replace(collapseRe, '').trim();
          return stripped === args.timeoutText
            || stripped === args.networkText
            || stripped === `${args.timeoutText}…`
            || stripped === `${args.timeoutText}...`
            || stripped === `${args.networkText}…`
            || stripped === `${args.networkText}...`;
        };
        const hasNonBannerVisibleText = (assistant: Element): boolean => {
          let remaining = normalize((assistant as HTMLElement).innerText || '');
          for (const paragraph of Array.from(assistant.querySelectorAll('p'))) {
            const text = (paragraph as HTMLElement).innerText || '';
            if (text && isReservedBanner(text)) remaining = remaining.replace(normalize(text), '');
          }
          try {
            const retry = assistant.querySelector(args.retrySelector);
            if (retry) remaining = remaining.replace(normalize((retry as HTMLElement).innerText || ''), '');
          } catch {
            /* retry absence is classified separately */
          }
          try {
            for (const chrome of Array.from(assistant.querySelectorAll(`${args.chromeSelector}, .sr-only, [role="alert"]`))) {
              remaining = remaining.replace(normalize((chrome as HTMLElement).innerText || ''), '');
            }
          } catch {
            /* chrome absence is not mixed-carrier evidence */
          }
          return remaining.replace(/\s+/g, ' ').trim().length > 0;
        };
        const rows: Array<{ role: 'user' | 'assistant'; text: string; turnKey?: string }> = [];
        const conversationTurnKeys: string[] = [];
        const bannerCandidates: Array<{
          turnKey?: string;
          paragraphTexts: string[];
          retryControlPresent: boolean;
          hasNonBannerContent: boolean;
        }> = [];
        let complete = true;
        try {
          for (const section of Array.from(document.querySelectorAll(args.turnSelector))) {
            const turnKey = section.getAttribute('data-testid');
            if (turnKey) conversationTurnKeys.push(turnKey);
          }
        } catch {
          complete = false;
        }
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
          for (const assistant of Array.from(document.querySelectorAll(args.assistantSelector))) {
            const turnKey = assistant.closest(args.turnSelector)?.getAttribute('data-testid') ?? undefined;
            const paragraphTexts: string[] = [];
            for (const paragraph of Array.from(assistant.querySelectorAll('p'))) {
              const text = (paragraph as HTMLElement).innerText;
              if (typeof text === 'string' && text) paragraphTexts.push(text);
            }
            let retryControlPresent = false;
            try {
              retryControlPresent = Boolean(assistant.querySelector(args.retrySelector));
            } catch {
              complete = false;
            }
            let hasNonBannerContent = false;
            try {
              hasNonBannerContent = hasNonBannerVisibleText(assistant);
            } catch {
              complete = false;
            }
            bannerCandidates.push({
              paragraphTexts,
              retryControlPresent,
              hasNonBannerContent,
              ...(turnKey ? { turnKey } : {}),
            });
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
        return { complete, generationInProgress, rows, conversationTurnKeys, bannerCandidates };
      }, {
        roleAttribute: MESSAGE_AUTHOR_ROLE_ATTR,
        generationSelector: OWNED_TURN_GENERATION_SELECTOR,
        turnSelector: CONVERSATION_TURN_SECTION_SELECTOR,
        assistantSelector: ASSISTANT_MESSAGE_SELECTOR,
        retrySelector: REGENERATE_THREAD_ERROR_BUTTON_SELECTOR,
        chromeSelector: ASSISTANT_TURN_ACTION_SELECTOR,
        timeoutText: MESSAGE_DELIVERY_TIMED_OUT_TEXT,
        networkText: PRODUCT_NETWORK_ERROR_TEXT,
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
  return classifyExecutionRecoveryProductError({
    marker,
    transcriptComplete: snapshot.complete,
    generationInProgress: snapshot.generationInProgress,
    messages: snapshot.rows,
    conversationTurnKeys: snapshot.conversationTurnKeys,
    bannerCandidates: snapshot.bannerCandidates,
  }).cause;
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
  if (executionRecoveryProductWallScopeDepth <= 0) return initial;
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
