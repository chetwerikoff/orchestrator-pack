import { readFileSync } from 'node:fs';
import { releaseCdpBrowser } from './browser-session.ts';
import { readStateLightTurnObservation } from './state-light-turn-observation.ts';
import { isOwnedPromptMarker } from './owned-prompt-marker.ts';
import { conversationUuidFromUrl } from './state-light-fresh-conversation.ts';
import { USER_MESSAGE_SELECTOR } from './product-page-selectors.ts';
import { loadChromium, normalizeConversationUrl } from './ui-adapter.ts';
import {
  recoveryMarkerCardinality,
  type RecoveryAuthoritativeMessage,
} from './state-light-turn-recovery.ts';

export const BROWSER_TURN_CANCELLATION_RECEIPT_SCHEMA =
  'browser-turn-cancellation-receipt/v1' as const;
// Support/test callers may consume this only after independently proving abandonment;
// production observation-loss paths intentionally have no authority producer.
export const EXPLICIT_CANCELLATION_AUTHORITY = 'independently_explicit' as const;

const CHATGPT_CONVERSATION_ORIGINS = new Set([
  'https://chatgpt.com',
  'https://chat.openai.com',
]);
const USER_MESSAGE_READ_WAIT_MS = 800;

export type ExplicitCancellationAuthority = typeof EXPLICIT_CANCELLATION_AUTHORITY;

export type StopOwnedGenerationOutcome =
  | 'not_attempted_authority_absent'
  | 'not_attempted_identity_unproven'
  | 'not_attempted_control_absent_or_ambiguous'
  | 'confirmed'
  | 'unconfirmed'
  | 'unavailable';

export type BrowserTurnCancellationDisposition = StopOwnedGenerationOutcome;

export interface BrowserTurnCancellationReceipt {
  readonly schema: typeof BROWSER_TURN_CANCELLATION_RECEIPT_SCHEMA;
  readonly invocation_id: string;
  readonly configured_profile_key: string;
  readonly conversation_url: string;
  readonly marker: string;
  readonly send_count: 1;
}

export interface BrowserTurnCancellationAttempt {
  readonly state: 'no_reply' | 'driver_error';
  readonly cause: string;
  readonly sendCount?: 1;
  readonly stopOutcome: BrowserTurnCancellationDisposition;
  readonly identityProven: boolean;
  readonly conversationUrl?: string;
}

export interface BrowserTurnCancellationDependencies {
  readonly connect?: (cdp: string) => Promise<any>;
  readonly releaseBrowser?: (browser: any) => Promise<void>;
  readonly enumeratePages?: (browser: any) => Promise<readonly any[]>;
  readonly readUserMessages?: (page: any) => Promise<{
    readonly messages: readonly RecoveryAuthoritativeMessage[];
    readonly incomplete: boolean;
  }>;
  readonly stop?: (page: any) => Promise<StopOwnedGenerationOutcome>;
}

export function isSupportedChatGptConversationUrl(value: string): boolean {
  try {
    const normalized = normalizeConversationUrl(value);
    const parsed = new URL(normalized);
    return CHATGPT_CONVERSATION_ORIGINS.has(parsed.origin)
      && conversationUuidFromUrl(normalized) !== undefined;
  } catch {
    return false;
  }
}

export function buildBrowserTurnCancellationReceipt(input: {
  readonly invocationId: string;
  readonly profileKey: string;
  readonly conversationUrl: string;
  readonly marker: string;
  readonly sendCount: number;
}): BrowserTurnCancellationReceipt | null {
  if (input.sendCount !== 1) return null;
  if (!input.invocationId.trim() || !input.profileKey.trim()) return null;
  if (!isOwnedPromptMarker(input.marker)) return null;
  if (!isSupportedChatGptConversationUrl(input.conversationUrl)) return null;
  return {
    schema: BROWSER_TURN_CANCELLATION_RECEIPT_SCHEMA,
    invocation_id: input.invocationId,
    configured_profile_key: input.profileKey,
    conversation_url: normalizeConversationUrl(input.conversationUrl),
    marker: input.marker,
    send_count: 1,
  };
}

export function parseBrowserTurnCancellationReceipt(
  value: unknown,
): BrowserTurnCancellationReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (body.schema !== BROWSER_TURN_CANCELLATION_RECEIPT_SCHEMA) return null;
  if (typeof body.invocation_id !== 'string') return null;
  if (typeof body.configured_profile_key !== 'string') return null;
  if (typeof body.conversation_url !== 'string') return null;
  if (typeof body.marker !== 'string') return null;
  if (body.send_count !== 1) return null;
  return buildBrowserTurnCancellationReceipt({
    invocationId: body.invocation_id,
    profileKey: body.configured_profile_key,
    conversationUrl: body.conversation_url,
    marker: body.marker,
    sendCount: body.send_count,
  });
}

export async function readRecoveryAuthoritativeUserMessages(
  page: any,
): Promise<{
  readonly messages: readonly RecoveryAuthoritativeMessage[];
  readonly incomplete: boolean;
}> {
  let users: any;
  let count: number;
  try {
    users = page.locator(USER_MESSAGE_SELECTOR);
    count = Number(await users.count());
    if (!Number.isSafeInteger(count) || count < 0) {
      return { messages: [], incomplete: true };
    }
  } catch {
    return { messages: [], incomplete: true };
  }

  const messages: RecoveryAuthoritativeMessage[] = [];
  let incomplete = false;
  for (let index = 0; index < count; index += 1) {
    try {
      const text = String(await users.nth(index).innerText({
        timeout: USER_MESSAGE_READ_WAIT_MS,
      }) ?? '');
      messages.push({ role: 'user', text });
    } catch {
      incomplete = true;
    }
  }
  return { messages, incomplete };
}

/**
 * r06: A user-supplied explicit request and a Stop button do not authenticate
 * either the invocation's original tab or its *current* assistant generation.
 * There is no independent producer for those two witnesses in the allowed
 * scope. Preserve the no-effect behavior even for a single matching URL.
 */
export async function stopOwnedGeneration(
  page: any,
  authority?: ExplicitCancellationAuthority,
): Promise<StopOwnedGenerationOutcome> {
  if (authority !== EXPLICIT_CANCELLATION_AUTHORITY) return 'not_attempted_authority_absent';
  if (!page) return 'unavailable';
  try {
    if (typeof page.isClosed === 'function' && page.isClosed() === true) return 'unavailable';
  } catch {
    return 'unavailable';
  }
  return 'not_attempted_identity_unproven';
}

async function defaultEnumeratePages(browser: any): Promise<readonly any[]> {
  const contexts = browser.contexts();
  if (!Array.isArray(contexts) || contexts.length !== 1) {
    throw new Error('cancellation_context_count_unproven');
  }
  const pages = contexts[0].pages();
  if (!Array.isArray(pages)) throw new Error('cancellation_page_enumeration_failed');
  return pages;
}

function unavailable(
  cause: string,
  receipt?: BrowserTurnCancellationReceipt,
): BrowserTurnCancellationAttempt {
  return {
    state: 'driver_error',
    cause,
    ...(receipt ? { sendCount: 1 as const, conversationUrl: receipt.conversation_url } : {}),
    stopOutcome: 'unavailable',
    identityProven: false,
  };
}

export function authorityAbsent(
  receipt: BrowserTurnCancellationReceipt,
): BrowserTurnCancellationAttempt {
  return {
    state: 'driver_error',
    cause: 'child_stdout_eof_timeout_cancellation_authority_absent',
    sendCount: 1,
    stopOutcome: 'not_attempted_authority_absent',
    identityProven: false,
    conversationUrl: receipt.conversation_url,
  };
}

function identityUnproven(
  cause: string,
  receipt: BrowserTurnCancellationReceipt,
): BrowserTurnCancellationAttempt {
  return {
    state: 'driver_error',
    cause,
    sendCount: 1,
    stopOutcome: 'not_attempted_identity_unproven',
    identityProven: false,
    conversationUrl: receipt.conversation_url,
  };
}

export async function cancelOwnedGenerationFromReceipt(
  rawReceipt: BrowserTurnCancellationReceipt,
  cdp: string,
  authorityOrDependencies?: ExplicitCancellationAuthority | BrowserTurnCancellationDependencies,
  explicitDependencies: BrowserTurnCancellationDependencies = {},
): Promise<BrowserTurnCancellationAttempt> {
  const receipt = parseBrowserTurnCancellationReceipt(rawReceipt);
  if (!receipt) return unavailable('child_stdout_eof_timeout_cancellation_receipt_invalid');
  const authority = authorityOrDependencies === EXPLICIT_CANCELLATION_AUTHORITY
    ? authorityOrDependencies
    : undefined;
  const dependencies = authorityOrDependencies && typeof authorityOrDependencies === 'object'
    ? authorityOrDependencies
    : explicitDependencies;
  if (authority !== EXPLICIT_CANCELLATION_AUTHORITY) return authorityAbsent(receipt);
  if (!cdp.trim()) {
    return identityUnproven('child_stdout_eof_timeout_cdp_unavailable', receipt);
  }

  let browser: any;
  try {
    browser = dependencies.connect
      ? await dependencies.connect(cdp)
      : await loadChromium().connectOverCDP(cdp, { timeout: 30_000 });
  } catch {
    return identityUnproven('child_stdout_eof_timeout_cancellation_reconnect_failed', receipt);
  }

  try {
    const pages = dependencies.enumeratePages
      ? await dependencies.enumeratePages(browser)
      : await defaultEnumeratePages(browser);
    const exactUrlPages: any[] = [];
    for (const page of pages) {
      try {
        const normalized = normalizeConversationUrl(String(page.url()));
        if (normalized === receipt.conversation_url) exactUrlPages.push(page);
      } catch {
        // An unreadable page has no authority for this exact receipt.
      }
    }
    if (exactUrlPages.length !== 1) {
      return identityUnproven(
        exactUrlPages.length > 1
          ? 'child_stdout_eof_timeout_cancellation_identity_ambiguous'
          : 'child_stdout_eof_timeout_owned_conversation_not_found',
        receipt,
      );
    }

    const page = exactUrlPages[0];
    const observed = dependencies.readUserMessages
      ? await dependencies.readUserMessages(page)
      : await readRecoveryAuthoritativeUserMessages(page);
    if (observed.incomplete) {
      return identityUnproven(
        'child_stdout_eof_timeout_cancellation_identity_unreadable',
        receipt,
      );
    }
    const cardinality = recoveryMarkerCardinality(observed.messages, receipt.marker);
    if (
      cardinality.matchingUserCarrierCount !== 1
      || cardinality.exactMarkerTokenCount !== 1
    ) {
      return identityUnproven(
        cardinality.matchingUserCarrierCount > 1
          || cardinality.exactMarkerTokenCount > 1
          ? 'child_stdout_eof_timeout_cancellation_identity_ambiguous'
          : 'child_stdout_eof_timeout_cancellation_identity_unproven',
        receipt,
      );
    }

    // Exact durable invocation, profile and marker must be re-read. This proves
    // historical send identity only. Neither this record nor a matching URL
    // supplies the missing tab+active-generation witnesses.
    let durable;
    try {
      durable = readStateLightTurnObservation(receipt.configured_profile_key, receipt.invocation_id);
    } catch {
      return identityUnproven('cancellation_durable_invocation_unreadable', receipt);
    }
    if (durable.marker !== receipt.marker
      || durable.profile_key !== receipt.configured_profile_key
      || durable.invocation_id !== receipt.invocation_id
      || durable.conversation_url !== receipt.conversation_url
      || (durable.send_count ?? 0) < 1
      || durable.phase === 'not_sent' || durable.phase === 'prepared'
      || durable.phase === 'harvested') {
      return identityUnproven('cancellation_durable_identity_or_phase_mismatch', receipt);
    }
    // No independently established original send-tab target AND no current
    // assistant-generation identity. No selector read/click, even when a Stop
    // button subsequently vanishes through natural completion.
    void page;
    void dependencies.stop;
    return identityUnproven('cancellation_owned_tab_and_generation_unproven', receipt);
  } catch {
    return identityUnproven(
      'child_stdout_eof_timeout_cancellation_handshake_failed',
      receipt,
    );
  } finally {
    try {
      if (dependencies.releaseBrowser) await dependencies.releaseBrowser(browser);
      else await releaseCdpBrowser(browser);
    } catch {
      // Releasing the CDP client is not Stop confirmation and never closes a tab.
    }
  }
}

/**
 * Native explicit cancel command. The receipt is a read-only locator, not
 * cross-process Stop authority: without an independent original tab and active
 * generation witness every valid request returns a non-success no-op.
 */
export async function runStateLightCancellation(
  argv: readonly string[],
  dependencies: BrowserTurnCancellationDependencies = {},
): Promise<number> {
  let receiptPath: string | undefined;
  let cdp = '';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === '--receipt-file' && value) {
      receiptPath = value;
      index += 1;
    } else if (argv[index] === '--cdp' && value) {
      cdp = value;
      index += 1;
    } else {
      process.stdout.write(JSON.stringify({ schema: 'cancel-result/v1', state: 'driver_error', cause: 'cancel_arguments_invalid' }) + '\n');
      return 13;
    }
  }
  if (!receiptPath || !cdp) {
    process.stdout.write(JSON.stringify({ schema: 'cancel-result/v1', state: 'driver_error', cause: 'cancel_arguments_missing' }) + '\n');
    return 13;
  }
  let receipt: BrowserTurnCancellationReceipt | null = null;
  try {
    receipt = parseBrowserTurnCancellationReceipt(JSON.parse(readFileSync(receiptPath, 'utf8')) as unknown);
  } catch {
    // An absent/unreadable receipt has no cancel authority.
  }
  if (!receipt) {
    process.stdout.write(JSON.stringify({ schema: 'cancel-result/v1', state: 'driver_error', cause: 'cancellation_receipt_unreadable' }) + '\n');
    return 13;
  }
  const attempt = await cancelOwnedGenerationFromReceipt(
    receipt, cdp, EXPLICIT_CANCELLATION_AUTHORITY, dependencies,
  );
  process.stdout.write(JSON.stringify({
    schema: 'cancel-result/v1',
    state: attempt.state,
    cause: attempt.cause,
    invocation_id: receipt.invocation_id,
    configured_profile_key: receipt.configured_profile_key,
    send_count: receipt.send_count,
    stop_outcome: attempt.stopOutcome,
  }) + '\n');
  return attempt.stopOutcome === 'confirmed' && attempt.identityProven ? 0 : 13;
}
