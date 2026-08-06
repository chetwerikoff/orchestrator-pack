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
}

export interface RecoveryCensus {
  readonly complete: boolean;
  readonly monotonicAmbiguity: boolean;
  readonly pages: readonly RecoveryPageSnapshot[];
}

export interface PostSendRecoveryState {
  lossEpoch: number;
  successorCreated: boolean;
  immutableConversationUrl?: string;
  cleanupAuthorityPage?: unknown;
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
): Promise<RecoveryCensus> {
  const snapshots: RecoveryPageSnapshot[] = [];
  let complete = true;
  let pages: readonly unknown[];
  try {
    pages = await adapter.enumeratePages(browser);
  } catch {
    return { complete: false, monotonicAmbiguity: false, pages: [] };
  }

  for (const page of pages) {
    let normalizedUrl: string;
    try {
      normalizedUrl = adapter.normalizeConversationUrl(adapter.pageUrl(page));
    } catch {
      complete = false;
      continue;
    }
    if (!adapter.isSupportedConversationUrl(normalizedUrl)) continue;

    try {
      const observed = await adapter.readAuthoritativeMessages(page);
      if (observed.incomplete) complete = false;
      const cardinality = recoveryMarkerCardinality(observed.messages, marker);
      snapshots.push({
        page,
        normalizedUrl,
        ...cardinality,
        eligible: cardinality.matchingUserCarrierCount === 1
          && cardinality.exactMarkerTokenCount === 1,
      });
    } catch {
      complete = false;
    }
  }

  const eligiblePageCount = snapshots.filter((page) => page.eligible).length;
  const monotonicAmbiguity = snapshots.some((page) => (
    page.matchingUserCarrierCount > 1 || page.exactMarkerTokenCount > 1
  )) || eligiblePageCount > 1;
  return { complete, monotonicAmbiguity, pages: snapshots };
}

function failure(
  browser: unknown,
  lossEpoch: number,
  state: RecoveryTerminalState,
  cause: string,
  eventClass: PostSendRecoveryFailure['eventClass'],
  observer?: (event: RecoveryObserverEvent) => void,
): PostSendRecoveryFailure {
  observer?.({ event: 'terminal', lossEpoch, cause });
  return {
    kind: 'failure',
    browser,
    state,
    cause,
    eventClass,
    action: 'retain_owned_page_no_resend',
  };
}

export async function runPostSendRecovery(
  input: PostSendRecoveryInput,
): Promise<PostSendRecoveryResult> {
  const { marker, hardDeadlineMs, adapter, observer, state } = input;
  let browser = input.browser;
  let currentPage = input.currentPage;
  let beginLossEpoch = true;

  while (true) {
    if (beginLossEpoch) {
      state.lossEpoch += 1;
      observer?.({ event: 'loss_epoch', lossEpoch: state.lossEpoch });
      if (currentPage && state.cleanupAuthorityPage === currentPage) {
        state.cleanupAuthorityPage = undefined;
      }
      if (currentPage && state.successorPage === currentPage) {
        state.successorPage = undefined;
      }
      currentPage = undefined;
      if (state.lossEpoch > 2) {
        return failure(
          browser,
          state.lossEpoch,
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
            state.lossEpoch,
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

    const census = await takeRecoveryCensus(browser, marker, adapter);
    const eligible = census.pages.filter((page) => page.eligible);
    observer?.({
      event: 'census',
      lossEpoch: state.lossEpoch,
      eligiblePageCount: eligible.length,
      supportedPageCount: census.pages.length,
      censusComplete: census.complete,
    });

    if (census.monotonicAmbiguity) {
      return failure(
        browser,
        state.lossEpoch,
        'observation_uncertain',
        'owned_prompt_marker_ambiguous',
        'post_send_observation_error',
        observer,
      );
    }

    if (!census.complete) {
      if (adapter.browserDefinitelyDisconnected(browser)) {
        beginLossEpoch = true;
        continue;
      }
      if (currentPage && adapter.pageDefinitelyLost(currentPage)) {
        beginLossEpoch = true;
        continue;
      }
      if (adapter.now() >= hardDeadlineMs) {
        return failure(
          browser,
          state.lossEpoch,
          'driver_error',
          'owned_conversation_recovery_census_failed',
          'helper_failure_after_send',
          observer,
        );
      }
      await adapter.sleep(Math.max(1, input.pollMs));
      continue;
    }

    if (eligible.length === 1) {
      const match = eligible[0]!;
      if (state.immutableConversationUrl && match.normalizedUrl !== state.immutableConversationUrl) {
        return failure(
          browser,
          state.lossEpoch,
          'ui_contract_mismatch',
          'owned_conversation_identity_mismatch',
          'conversation_identity_mismatch',
          observer,
        );
      }
      if (!state.immutableConversationUrl) {
        state.immutableConversationUrl = match.normalizedUrl;
      }
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
        lossEpoch: state.lossEpoch,
      };
    }

    const immutableUrl = state.immutableConversationUrl;
    if (immutableUrl && state.successorPage) {
      const successorSnapshot = census.pages.find((candidate) => candidate.page === state.successorPage);
      if (successorSnapshot && successorSnapshot.normalizedUrl !== immutableUrl) {
        return failure(
          browser,
          state.lossEpoch,
          'ui_contract_mismatch',
          'owned_conversation_identity_mismatch',
          'conversation_identity_mismatch',
          observer,
        );
      }
    }

    const sameUrlPages = immutableUrl
      ? census.pages.filter((candidate) => candidate.normalizedUrl === immutableUrl)
      : [];
    const deadlineReached = adapter.now() >= hardDeadlineMs;

    if (immutableUrl && sameUrlPages.length > 0) {
      if (deadlineReached) {
        return failure(
          browser,
          state.lossEpoch,
          'ui_contract_mismatch',
          'owned_prompt_marker_unresolved',
          'post_send_observation_error',
          observer,
        );
      }
      await adapter.sleep(Math.max(1, input.pollMs));
      continue;
    }

    if (immutableUrl && !state.successorCreated && !deadlineReached) {
      state.successorCreated = true;
      let successor: unknown;
      try {
        successor = await adapter.createSuccessor(browser, immutableUrl);
      } catch {
        return failure(
          browser,
          state.lossEpoch,
          'driver_error',
          'replacement_observation_page_create_failed',
          'helper_failure_after_send',
          observer,
        );
      }
      state.successorPage = successor;
      state.cleanupAuthorityPage = successor;
      currentPage = successor;
      observer?.({
        event: 'successor_created',
        lossEpoch: state.lossEpoch,
        conversationUrlSha256: conversationUrlSha256(immutableUrl),
      });
      continue;
    }

    if (deadlineReached) {
      if (immutableUrl && state.lossEpoch >= 2 && state.successorCreated) {
        return failure(
          browser,
          state.lossEpoch,
          'no_reply',
          'observation_exhausted_no_resend',
          'observation_exhausted',
          observer,
        );
      }
      return failure(
        browser,
        state.lossEpoch,
        'ui_contract_mismatch',
        'owned_conversation_recovery_zero_match',
        'post_send_observation_error',
        observer,
      );
    }

    await adapter.sleep(Math.max(1, input.pollMs));
  }
}
