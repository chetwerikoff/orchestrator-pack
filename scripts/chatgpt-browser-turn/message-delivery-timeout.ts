import {
  classifyProductMessage,
  type ProductStatusSurfaceLike,
} from './product-page-selectors.ts';
import { ownedPromptMarkerMatches } from './owned-prompt-marker.ts';
import {
  recoveryMarkerCardinality,
  type RecoveryAuthoritativeMessage,
} from './state-light-turn-recovery.ts';

export interface OwnedMessageDeliveryTimeoutEvidence {
  readonly surface: ProductStatusSurfaceLike;
  readonly marker: string;
  readonly transcriptComplete: boolean;
  readonly generationInProgress: boolean | 'unknown';
  readonly messages: readonly RecoveryAuthoritativeMessage[];
}

export type OwnedMessageDeliveryTimeoutClassification =
  | { readonly state: 'message_delivery_timed_out'; readonly cause: 'message_delivery_timed_out' }
  | { readonly state?: undefined; readonly cause?: undefined };

/**
 * Canonical ownership predicate for the ChatGPT product-level message-delivery
 * timeout. Both the live state-light turn and the execution-only checkpoint
 * use this exact predicate; callers must still perform their own bounded stable
 * re-observation before treating a positive result as terminal authority.
 */
export function classifyOwnedMessageDeliveryTimeout(
  evidence: OwnedMessageDeliveryTimeoutEvidence,
): OwnedMessageDeliveryTimeoutClassification {
  if (classifyProductMessage(evidence.surface).state !== 'message_delivery_timed_out') return {};
  if (!evidence.transcriptComplete || evidence.generationInProgress !== false) return {};

  const cardinality = recoveryMarkerCardinality(evidence.messages, evidence.marker);
  if (
    cardinality.matchingUserCarrierCount !== 1
    || cardinality.exactMarkerTokenCount !== 1
  ) {
    return {};
  }

  const ownedIndexes = evidence.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => (
      message.role === 'user'
      && ownedPromptMarkerMatches(message.text, evidence.marker)
    ));
  if (ownedIndexes.length !== 1) return {};

  const suffix = evidence.messages.slice(ownedIndexes[0]!.index + 1);
  // A later user carrier means the owned prompt is no longer the current
  // relevant turn. Any assistant carrier means there is reply evidence to
  // recover/settle instead of authorizing timeout recovery.
  if (suffix.some((message) => message.role === 'user')) return {};
  if (suffix.some((message) => message.role === 'assistant')) return {};

  return { state: 'message_delivery_timed_out', cause: 'message_delivery_timed_out' };
}
