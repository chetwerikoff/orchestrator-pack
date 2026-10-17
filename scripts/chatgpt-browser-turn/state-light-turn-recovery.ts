import { createHash } from 'node:crypto';

export interface RecoveryAuthoritativeMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface RecoveryMarkerCardinality {
  readonly matchingUserCarrierCount: number;
  readonly exactMarkerTokenCount: number;
}

export interface RecoveryPageSnapshot {
  readonly page: unknown;
  readonly normalizedUrl: string;
  readonly matchingUserCarrierCount: number;
  readonly exactMarkerTokenCount: number;
  readonly eligible: boolean;
  readonly incomplete: boolean;
}

export type RecoveryIncompleteReason = 'read_incomplete' | 'read_threw' | 'page_url_unreadable' | 'enumeration_failed';

export interface RecoveryIncompleteDiagnostic {
  readonly conversationUrlSha256: string;
  readonly reason: RecoveryIncompleteReason;
}

export interface RecoveryCensus {
  readonly complete: boolean;
  readonly monotonicAmbiguity: boolean;
  readonly ownedIdentityMismatch?: boolean;
  readonly pages: readonly RecoveryPageSnapshot[];
  readonly incompleteReason?: RecoveryIncompleteReason;
}

export interface PostSendRecoveryState {
  lossEpoch: number;
  successorCreated: boolean;
  immutableConversationUrl?: string;
  /** Exact invocation-created page that may be closed after committed publication. */
  cleanupAuthorityPage?: unknown;
  /** Exact invocation-created page that may receive a one-shot Stop action. */
  stopAuthorityPage?: unknown;
  successorPage?: unknown;
}

export type RecoveryTerminalState =
  | 'ui_contract_mismatch'
  | 'observation_uncertain'
  | 'driver_error'
  | 'no_reply';

export interface RecoveryObserverEvent {
  readonly event:
    | 'loss_epoch'
    | 'reconnect_attempt'
    | 'reconnect_succeeded'
    | 'census'
    | 'successor_created'
    | 'recovered'
    | 'terminal';
  readonly lossEpoch: number;
  readonly cause?: string;
  readonly eligiblePageCount?: number;
  readonly supportedPageCount?: number;
  readonly censusComplete?: boolean;
  readonly conversationUrlSha256?: string;
}

export interface PostSendRecoveryAdapter {
  readonly enumeratePages: (browser: unknown) => Promise<readonly unknown[]>;
  /** CDP metadata-only count of relevant targets filtered out of own-target Playwright. */
  readonly uninspectedPotentialPages?: (browser: unknown, immutableConversationUrl?: string) => Promise<number>;
  readonly pageUrl: (page: unknown) => string;
  readonly normalizeConversationUrl: (value: string) => string;
  readonly isSupportedConversationUrl: (value: string) => boolean;
  readonly readAuthoritativeMessages: (page: unknown) => Promise<{
    readonly messages: readonly RecoveryAuthoritativeMessage[];
    readonly incomplete: boolean;
  }>;
  readonly browserDefinitelyDisconnected: (browser: unknown) => boolean;
  readonly pageDefinitelyLost: (page: unknown) => boolean;
  readonly reconnect: () => Promise<unknown>;
  readonly createSuccessor: (browser: unknown, immutableConversationUrl: string) => Promise<unknown>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
  /** Existing shared cooldown or an independently witnessed held-page 429.
   * This only protects a new recovery fetch/navigation; read-only harvest can win. */
  readonly accountActionBlocker?: () => string | undefined;
}

export interface PostSendRecoveryInput {
  readonly browser: unknown;
  readonly currentPage?: unknown;
  readonly marker: string;
  readonly hardDeadlineMs: number;
  readonly pollMs: number;
  readonly state: PostSendRecoveryState;
  readonly adapter: PostSendRecoveryAdapter;
  readonly observer?: (event: RecoveryObserverEvent) => void;
}

export interface PostSendRecoverySuccess {
  readonly kind: 'recovered';
  readonly browser: unknown;
  readonly page: unknown;
  readonly conversationUrl: string;
  readonly cleanupOwned: boolean;
  readonly stopAuthorityPage?: unknown;
  readonly lossEpoch: number;
}

export interface PostSendRecoveryFailure {
  readonly kind: 'failure';
  readonly browser: unknown;
  readonly state: RecoveryTerminalState;
  readonly cause: string;
  readonly eventClass:
    | 'post_send_observation_error'
    | 'conversation_identity_mismatch'
    | 'helper_failure_after_send'
    | 'observation_exhausted';
  readonly action: 'retain_owned_page_no_resend';
  readonly diagnostic?: RecoveryIncompleteDiagnostic;
  /** Present only for an exact invocation-created page whose handle is still held. */
  readonly stopAuthorityPage?: unknown;
}

export type PostSendRecoveryResult = PostSendRecoverySuccess | PostSendRecoveryFailure;

export function countExactMarkerOccurrences(value: string, marker: string): number {
  if (!marker) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= value.length - marker.length) {
    const found = value.indexOf(marker, offset);
    if (found < 0) break;
    count += 1;
    offset = found + marker.length;
  }
  return count;
}

export function recoveryMarkerCardinality(
  messages: readonly RecoveryAuthoritativeMessage[],
  marker: string,
): RecoveryMarkerCardinality {
  let matchingUserCarrierCount = 0;
  let exactMarkerTokenCount = 0;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const occurrences = countExactMarkerOccurrences(message.text, marker);
    if (occurrences > 0) matchingUserCarrierCount += 1;
    exactMarkerTokenCount += occurrences;
  }
  return { matchingUserCarrierCount, exactMarkerTokenCount };
}

function conversationUrlSha256(value: string | undefined): string | undefined {
  return value ? createHash('sha256').update(value, 'utf8').digest('hex') : undefined;
}

export async function takeRecoveryCensus(
  browser: unknown,
  marker: string,
  adapter: PostSendRecoveryAdapter,
  immutableConversationUrl?: string,
  exactOwnedPage?: unknown,
 ): Promise<RecoveryCensus> {
  const snapshots: RecoveryPageSnapshot[] = [];
  let complete = true;
  let incompleteReason: RecoveryIncompleteReason | undefined;
  let ownedIdentityMismatch = false;
  let pages: readonly unknown[];
  try {
    pages = exactOwnedPage ? [exactOwnedPage] : await adapter.enumeratePages(browser);
  } catch {
    return { complete: false, monotonicAmbiguity: false, pages: [], incompleteReason: 'enumeration_failed' };
  }

  for (const page of pages) {
    let normalizedUrl: string;
    try {
      normalizedUrl = adapter.normalizeConversationUrl(adapter.pageUrl(page));
    } catch {
      if (page === exactOwnedPage || !immutableConversationUrl) {
        complete = false;
        incompleteReason ??= 'page_url_unreadable';
      }
      continue;
    }
    if (page === exactOwnedPage && immutableConversationUrl && normalizedUrl !== immutableConversationUrl) {
      ownedIdentityMismatch = true;
      continue;
    }
    if (immutableConversationUrl && normalizedUrl !== immutableConversationUrl) continue;
    if (!adapter.isSupportedConversationUrl(normalizedUrl)) continue;
    try {
      const observed = await adapter.readAuthoritativeMessages(page);
      if (observed.incomplete) {
        complete = false;
        incompleteReason ??= 'read_incomplete';
      }
      const cardinality = recoveryMarkerCardinality(observed.messages, marker);
      snapshots.push({
        page,
        normalizedUrl,
        ...cardinality,
        eligible: cardinality.matchingUserCarrierCount === 1
          && cardinality.exactMarkerTokenCount === 1,
        incomplete: observed.incomplete,
      });
    } catch {
      complete = false;
      incompleteReason ??= 'read_threw';
    }
  }

  // A filtered BrowserContext is not a complete Chrome target census.
  // Account for hidden same-chat or unbound-fresh candidates using only
  // browser-level target metadata; never initialize their Page sessions.
  if (adapter.uninspectedPotentialPages) {
    try {
      const hidden = await adapter.uninspectedPotentialPages(browser, immutableConversationUrl);
      if (!Number.isSafeInteger(hidden) || hidden < 0 || hidden > 0) {
        complete = false;
        incompleteReason ??= 'enumeration_failed';
      }
    } catch {
      complete = false;
      incompleteReason ??= 'enumeration_failed';
    }
  }
  const monotonicAmbiguity = snapshots.some((page) => (
    page.matchingUserCarrierCount > 1 || page.exactMarkerTokenCount > 1
  )) || snapshots.filter((page) => page.eligible).length > 1;
  return { complete, monotonicAmbiguity, ownedIdentityMismatch, pages: snapshots, ...(incompleteReason ? { incompleteReason } : {}) };
}

function failure(
  browser: unknown,
  recoveryState: PostSendRecoveryState,
  state: RecoveryTerminalState,
  cause: string,
  eventClass: PostSendRecoveryFailure['eventClass'],
  observer?: (event: RecoveryObserverEvent) => void,
  incompleteReason?: RecoveryIncompleteReason,
): PostSendRecoveryFailure {
  observer?.({ event: 'terminal', lossEpoch: recoveryState.lossEpoch, cause });
  const diagnostic = recoveryState.immutableConversationUrl && incompleteReason
    ? {
      conversationUrlSha256: conversationUrlSha256(recoveryState.immutableConversationUrl)!,
      reason: incompleteReason,
    }
    : undefined;
  return {
    kind: 'failure',
    browser,
    state,
    cause,
    eventClass,
    action: 'retain_owned_page_no_resend',
    ...(diagnostic ? { diagnostic } : {}),
    ...(recoveryState.stopAuthorityPage
      ? { stopAuthorityPage: recoveryState.stopAuthorityPage }
      : {}),
  };
}

export async function runPostSendRecovery(
  input: PostSendRecoveryInput,
): Promise<PostSendRecoveryResult> {
  const { marker, hardDeadlineMs, adapter, observer, state } = input;
  let browser = input.browser;
  let currentPage = input.currentPage;
  let beginLossEpoch = true;
  let seenMonotonicAmbiguity = false;
  let censusReads = 0;
  if (state.immutableConversationUrl) {
    state.immutableConversationUrl = adapter.normalizeConversationUrl(state.immutableConversationUrl);
  }
  while (true) {
    if (beginLossEpoch) {
      state.lossEpoch += 1;
      observer?.({ event: 'loss_epoch', lossEpoch: state.lossEpoch });
      if (currentPage && state.cleanupAuthorityPage === currentPage) {
        state.cleanupAuthorityPage = undefined;
      }
      if (currentPage && state.stopAuthorityPage === currentPage) {
        state.stopAuthorityPage = undefined;
      }
      if (currentPage && state.successorPage === currentPage) {
        state.successorPage = undefined;
      }
      currentPage = undefined;
      if (state.lossEpoch > 2) {
        return failure(
          browser,
          state,
          'no_reply',
          'observation_exhausted_no_resend',
          'observation_exhausted',
          observer,
        );
      }

      if (adapter.browserDefinitelyDisconnected(browser)) {
        observer?.({ event: 'reconnect_attempt', lossEpoch: state.lossEpoch });
        try {
          browser = await adapter.reconnect();
          observer?.({ event: 'reconnect_succeeded', lossEpoch: state.lossEpoch });
        } catch {
          return failure(
            browser,
            state,
            'driver_error',
            'browser_reconnect_failed_after_send',
            'helper_failure_after_send',
            observer,
          );
        }
      }
      beginLossEpoch = false;
    }

    if (adapter.browserDefinitelyDisconnected(browser)) {
      beginLossEpoch = true;
      continue;
    }
    if (currentPage && adapter.pageDefinitelyLost(currentPage)) {
      beginLossEpoch = true;
      continue;
    }

    if (censusReads > 0) {
      const blocker = adapter.accountActionBlocker?.();
      if (blocker) return failure(browser, state, 'observation_uncertain', blocker,
        'post_send_observation_error', observer);
    }
    censusReads++;
    const census = await takeRecoveryCensus(
      browser, marker, adapter, state.immutableConversationUrl, state.successorPage,
    );
    seenMonotonicAmbiguity ||= census.monotonicAmbiguity;
    if (census.ownedIdentityMismatch) {
      return failure(browser, state, 'ui_contract_mismatch', 'owned_conversation_identity_mismatch',
        'conversation_identity_mismatch', observer, census.incompleteReason);
    }
    const successorSnapshot = state.successorPage
      ? census.pages.find((candidate) => candidate.page === state.successorPage)
      : undefined;
    const eligible = census.pages.filter((page) => page.eligible);
    const authoritativeSuccessor = successorSnapshot && !successorSnapshot.incomplete && successorSnapshot.eligible
      ? successorSnapshot
      : undefined;
    // Duplicate matching carriers on distinct tabs are not unique ownership.
    const conflictingEligibleViews = eligible.length > 1
      || Boolean(state.immutableConversationUrl && eligible.length > 0
        && census.pages.some((candidate) => candidate.page !== state.successorPage
          && !candidate.incomplete && !candidate.eligible));
    observer?.({
      event: 'census',
      lossEpoch: state.lossEpoch,
      eligiblePageCount: eligible.length,
      supportedPageCount: census.pages.length,
      censusComplete: census.complete,
    });

    if (seenMonotonicAmbiguity || conflictingEligibleViews) {
      return failure(
        browser,
        state,
        'observation_uncertain',
        'owned_prompt_marker_ambiguous',
        'post_send_observation_error',
        observer,
        census.incompleteReason,
      );
    }

    // An authoritative successor is still insufficient if a hidden or
    // unreadable same-conversation target could contain an additional marker.
    const accepted = census.complete
      ? (authoritativeSuccessor ?? (eligible.length === 1 ? eligible[0] : undefined))
      : undefined;
    if (accepted) {
      const match = accepted;
      if (state.immutableConversationUrl && match.normalizedUrl !== state.immutableConversationUrl) {
        return failure(
          browser,
          state,
          'ui_contract_mismatch',
          'owned_conversation_identity_mismatch',
          'conversation_identity_mismatch',
          observer,
          census.incompleteReason,
        );
      }
      if (!state.immutableConversationUrl) state.immutableConversationUrl = match.normalizedUrl;
      observer?.({
        event: 'recovered',
        lossEpoch: state.lossEpoch,
        conversationUrlSha256: conversationUrlSha256(state.immutableConversationUrl),
      });
      return {
        kind: 'recovered',
        browser,
        page: match.page,
        conversationUrl: state.immutableConversationUrl,
        cleanupOwned: state.cleanupAuthorityPage === match.page,
        ...(state.stopAuthorityPage ? { stopAuthorityPage: state.stopAuthorityPage } : {}),
        lossEpoch: state.lossEpoch,
      };
    }

    const immutableUrl = state.immutableConversationUrl;
    const deadlineReached = adapter.now() >= hardDeadlineMs;
    if (!census.complete && adapter.browserDefinitelyDisconnected(browser)) {
      beginLossEpoch = true;
      continue;
    }
    if (!census.complete && currentPage && adapter.pageDefinitelyLost(currentPage)) {
      beginLossEpoch = true;
      continue;
    }

    // The existing one-shot successor is a read-only observation of this URL.
    if (immutableUrl && !state.successorCreated && !deadlineReached
      && (!census.complete || census.pages.length === 0)) {
      const blocker = adapter.accountActionBlocker?.();
      if (blocker) return failure(browser, state, 'observation_uncertain', blocker,
        'post_send_observation_error', observer, census.incompleteReason);
      state.successorCreated = true;
      try {
        const successor = await adapter.createSuccessor(browser, immutableUrl);
        state.successorPage = successor;
        state.cleanupAuthorityPage = successor;
        state.stopAuthorityPage = successor;
        currentPage = successor;
        observer?.({
          event: 'successor_created',
          lossEpoch: state.lossEpoch,
          conversationUrlSha256: conversationUrlSha256(immutableUrl),
        });
        continue;
      } catch {
        return failure(
          browser, state, 'driver_error', 'replacement_observation_page_create_failed',
          'helper_failure_after_send', observer, census.incompleteReason,
        );
      }
    }

    if (deadlineReached) {
      if (!census.complete) {
        return failure(
          browser, state, 'driver_error', 'owned_conversation_recovery_census_failed',
          'helper_failure_after_send', observer, census.incompleteReason,
        );
      }
      if (immutableUrl && state.successorCreated) {
        return failure(
          browser, state, 'no_reply', 'observation_exhausted_no_resend',
          'observation_exhausted', observer,
        );
      }
      if (immutableUrl && census.pages.length > 0) {
        return failure(
          browser, state, 'ui_contract_mismatch', 'owned_prompt_marker_unresolved',
          'post_send_observation_error', observer,
        );
      }
      return failure(
        browser, state, 'ui_contract_mismatch', 'owned_conversation_recovery_zero_match',
        'post_send_observation_error', observer,
      );
    }
    await adapter.sleep(Math.max(1, input.pollMs));
  }
}
