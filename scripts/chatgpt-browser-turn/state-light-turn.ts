import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  boundedResourceCleanup,
  releaseCdpBrowser,
  RESOURCE_CLEANUP_BOUND_MS,
  type ResourceCleanupOutcome,
} from './browser-session.ts';
import { destinationIdentity } from './coordination.ts';
import {
  turnExitCode,
  type FailureScope,
  type PreSendComposerFailureCause,
  type TurnResultV1,
  type TurnState,
} from './contracts.ts';
import {
  createDirectPublicationObservationState,
  directPublicationReceipt,
  observeDirectPublicationPayload,
  reviewerSourceMetadata,
  settleDirectPublication,
  validateDirectPublicationInputs,
  type DirectPublicationConfig,
  type DirectPublicationObservationState,
} from './terminal-witness.ts';
import { readStableInput } from './input.ts';
import {
  generateOwnedPromptMarker,
  ownedPromptMarkerMatches,
  wrapOwnedPromptPayload,
} from './owned-prompt-marker.ts';
import {
  acquireStateLightNewChatSendSlot,
  conversationUuidFromUrl,
  ownedConversationIdentityMatches,
  prepareStateLightFreshConversation,
  projectConversationPrefix,
  recordStateLightAdvisoryWall,
  releaseStateLightFreshConversationClaim,
  releaseStateLightNewChatSendSlot,
  StateLightNavigationCounter,
  STATE_LIGHT_FRESH_RECOVERY_ATTEMPTS,
  STATE_LIGHT_MAX_TIMEOUT_MS,
  tryClaimStateLightFreshConversation,
  navigateToProjectConversationIfNeeded,
  readProjectConversationUrl,
  verifyStateLightFreshClaimOwnerFence,
  verifyStateLightSendSlotOwnerFence,
  waitForConversationUrlAfterSend,
} from './state-light-fresh-conversation.ts';
import { configuredProfileKey } from './storage-common.ts';
import {
  classifyProductWall,
  COMPOSER_SELECTOR,
  loadChromium,
  MESSAGE_AUTHOR_ROLE_ATTR,
  MESSAGE_NODE_SELECTOR,
  normalizeConversationUrl,
  productStatusText,
  locateContinueGeneratingControl,
  readAssistantNodeCompletionReady,
  readAssistantTurnCompletionReady,
  SEND_BUTTON_SELECTOR,
  stripUiCollapseAffixes,
  verifyProfile,
  type BrowserConfig,
} from './ui-adapter.ts';

const DEFAULT_TIMEOUT_MS = 1_800_000;
/** Local CDP DOM reads after dispatch; not send/navigation pacing. */
export const POST_SEND_OBSERVATION_POLL_MS = 15_000;
const DEFAULT_POLL_MS = POST_SEND_OBSERVATION_POLL_MS;
const INITIAL_POLL_MS = 500;
const DISPATCH_OBSERVATION_MS = 30_000;
const FRESH_CONVERSATION_LANDING_MS = DISPATCH_OBSERVATION_MS;
const STABILITY_READ_DELAY_MS = 1_000;
const COMPLETION_CONFIRM_POLL_MS = 1_000;
const DIAGNOSTIC_HEAD_CHARS = 300;
export const MAX_LOCAL_READ_WAIT_MS = 5_000;
export const COMPOSER_READINESS_WAIT_MS = 12_000;
/** Minimum insertion allowance for a one-line payload. */
export const COMPOSER_INSERTION_WAIT_MS = 3_000;
/** Conservative 2.18x margin over the measured ProseMirror cost of roughly 55 ms per line. */
export const COMPOSER_INSERTION_MS_PER_LINE = 120;

export function deriveComposerInsertionBudgetMs(text: string): number {
  const structuralLineCount = text.split(/\r\n|\r|\n/).length;
  return Math.max(COMPOSER_INSERTION_WAIT_MS, structuralLineCount * COMPOSER_INSERTION_MS_PER_LINE);
}

const BLOCKING_PAGE_OVERLAY_SELECTOR = '[role="dialog"][aria-modal="true"], [data-testid*="modal-overlay"]';
/** Per-node transcript reads use shorter budgets so one hung node cannot block the poll. */
const MESSAGE_NODE_READ_TIMEOUT_MS = 800;
const MESSAGE_NODE_READ_RETRY_TIMEOUT_MS = 400;
const MESSAGE_NODE_READ_ATTEMPTS = 2;
/** Post-send wall probes must not block transcript reads or the confirm loop. */
const POST_SEND_PRODUCT_WALL_PROBE_MS = 800;
export const OBSERVATION_HEARTBEAT_MS = 30_000;
const OBSERVATION_HEARTBEAT_POLL_INTERVAL = 2;
export const BROWSER_TURN_RECURRENCE_PATH = join(
  homedir(),
  '.local',
  'state',
  'create-issue-draft',
  'browser-turn-recurrence.jsonl',
);

interface ParsedTurnArgs {
  readonly options: Map<string, string | true>;
}

interface PageMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface PageObservationDecision {
  readonly state: 'waiting' | 'ready' | 'uncertain';
  readonly reply?: string;
  readonly cause?: string;
  readonly observedUserHeads?: readonly string[];
}

interface ObservationUncertaintyDiagnostics {
  readonly cause: string;
  readonly send_count: number;
  readonly owned_prompt_seen: boolean;
  readonly observed_user_heads?: readonly string[];
}

export interface ObservationExhaustedDiagnostics {
  readonly observation_state: string;
  readonly stable_reads: number;
  readonly last_assistant_head: string;
  readonly poll_count: number;
  readonly soft_deadline_elapsed: boolean;
}

export interface ObservationHeartbeat {
  readonly schema: 'observation-heartbeat/v1';
  readonly poll_count: number;
  readonly observation_state: string;
  readonly stable_reads: number;
  readonly completion_ready: boolean;
  readonly last_reply_length: number;
  readonly last_reply_sha256_head: string;
}

export interface PageObservationResult {
  readonly messages: PageMessage[];
  readonly ownedWindowCompletionReady: boolean;
  readonly transcriptIncomplete: boolean;
}

interface BrowserIncident {
  readonly eventClass: string;
  readonly symptom: string;
  readonly action?: string;
  readonly uncertaintyDiagnostics?: ObservationUncertaintyDiagnostics;
}

export interface CompactTurnResult extends TurnResultV1 {
  readonly send_count: number;
  readonly poll_count: number;
  readonly goto_count: number;
  readonly new_chat_click_count: number;
  readonly navigation_count: number;
  readonly cleanup: ResourceCleanupOutcome;
  readonly incidents: readonly string[];
  readonly journal_write_failed?: boolean;
}

interface TurnRunOutcome {
  readonly result: Omit<CompactTurnResult, 'cleanup'>;
  readonly page?: any;
  readonly browser?: any;
  readonly preserveOwnedPage?: boolean;
  readonly ownedConversationUrl?: string;
  readonly profileKey?: string;
  readonly ownershipForfeited?: boolean;
}

export interface StateLightPublicationResult {
  readonly state: 'committed_ok' | 'conflict' | 'error';
  readonly cause?: string;
  readonly output_bytes?: number;
  readonly output_sha256?: string;
}

function parseTurnArgs(argv: readonly string[]): ParsedTurnArgs {
  const options = new Map<string, string | true>();
  let cursor = 0;
  while (cursor < argv.length) {
    const raw = argv[cursor++];
    if (!raw?.startsWith('--') || raw === '--') throw new Error('argument_invalid');
    const key = raw.slice(2);
    if (options.has(key)) throw new Error('argument_duplicate');
    if (key === 'new-chat') {
      options.set(key, true);
      continue;
    }
    const value = argv[cursor++];
    if (!value || value.startsWith('--')) throw new Error('argument_value_missing');
    options.set(key, value);
  }
  return { options };
}

function stringOption(args: ParsedTurnArgs, key: string): string | undefined {
  const value = args.options.get(key);
  return typeof value === 'string' ? value : undefined;
}

function requireOption(args: ParsedTurnArgs, key: string): string {
  const value = stringOption(args, key);
  if (value === undefined || value.length === 0) throw new Error(`argument_required:${key}`);
  return value;
}

function hasFlag(args: ParsedTurnArgs, key: string): boolean {
  return args.options.get(key) === true;
}

function rejectUnknownOptions(args: ParsedTurnArgs, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  const unknown = [...args.options.keys()].find((key) => !accepted.has(key));
  if (unknown) throw new Error(`argument_unknown:${unknown}`);
}

function parseInteger(value: string, minimum = 0): number {
  if (!/^\d+$/.test(value)) throw new Error('argument_integer_invalid');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error('argument_integer_invalid');
  return parsed;
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const UNICODE_WHITESPACE_PATTERN = /\p{White_Space}+/gu;

function collapseUnicodeWhitespace(value: string): string {
  return value.replace(UNICODE_WHITESPACE_PATTERN, ' ').trim();
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\t ]+/g, ' ').trim();
}

function normalizeEchoComparisonText(value: string): string {
  return collapseUnicodeWhitespace(value.replace(/\u200b/g, ''));
}

function normalizeMarkdownEchoText(value: string): string {
  return collapseUnicodeWhitespace(
    value
      .replace(/\u200b/g, '')
      .replace(/`+/g, '')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1'),
  );
}

function boundedDiagnosticHead(value: string, maxChars = DIAGNOSTIC_HEAD_CHARS): string {
  const normalized = normalizeEchoComparisonText(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

export function ownedPromptMatches(visibleText: string, expectedMarker: string): boolean {
  return ownedPromptMarkerMatches(visibleText, expectedMarker);
}

const REPLY_STABILITY_HEAD_CHARS = DIAGNOSTIC_HEAD_CHARS;
const REPLY_STABILITY_TAIL_CHARS = DIAGNOSTIC_HEAD_CHARS;

function normalizeReplyForStability(text: string): string {
  return stripUiCollapseAffixes(normalizeEchoComparisonText(text));
}


export function hasOwnedUserMessage(messages: readonly PageMessage[], expectedMarker: string): boolean {
  return messages.some((message) => message.role === 'user' && ownedPromptMatches(message.text, expectedMarker));
}

export function replyStabilityFingerprint(text: string): string {
  const normalized = normalizeReplyForStability(text);
  if (!normalized) return '';
  const head = normalized.slice(0, REPLY_STABILITY_HEAD_CHARS);
  const tail = normalized.length > REPLY_STABILITY_HEAD_CHARS
    ? normalized.slice(-REPLY_STABILITY_TAIL_CHARS)
    : normalized;
  return `${head}\u0000${tail}`;
}

export function replyStabilityMatches(currentReply: string, previousReply: string): boolean {
  if (!previousReply) return false;
  const current = replyStabilityFingerprint(currentReply);
  const previous = replyStabilityFingerprint(previousReply);
  return current.length > 0 && current === previous;
}

function lastAssistantVisibleText(
  messages: readonly PageMessage[],
  baselineCount: number,
): string {
  const novel = messages.slice(Math.max(0, baselineCount));
  const assistants = novel.filter((message) => message.role === 'assistant');
  return normalizeVisibleText(assistants.at(-1)?.text ?? '');
}

function classifyObservationLoopState(
  decision: PageObservationDecision,
  stableReads: number,
): string {
  if (decision.state === 'uncertain') return 'uncertain';
  if (decision.state === 'ready') return stableReads >= 2 ? 'ready_stable' : 'ready_unstable';
  return decision.state;
}

export function buildObservationExhaustedDiagnostics(
  decision: PageObservationDecision,
  stableReads: number,
  pollCount: number,
  messages: readonly PageMessage[],
  baselineCount: number,
  softDeadlineElapsed: boolean,
): ObservationExhaustedDiagnostics {
  return {
    observation_state: classifyObservationLoopState(decision, stableReads),
    stable_reads: stableReads,
    last_assistant_head: boundedDiagnosticHead(lastAssistantVisibleText(messages, baselineCount)),
    poll_count: pollCount,
    soft_deadline_elapsed: softDeadlineElapsed,
  };
}

function replyContentHashHead(text: string): string {
  if (!text) return '';
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

export function buildObservationHeartbeat(
  decision: PageObservationDecision,
  stableReads: number,
  pollCount: number,
  completionReadySeen: boolean,
  lastReply: string,
): ObservationHeartbeat {
  return {
    schema: 'observation-heartbeat/v1',
    poll_count: pollCount,
    observation_state: classifyObservationLoopState(decision, stableReads),
    stable_reads: stableReads,
    completion_ready: completionReadySeen,
    last_reply_length: lastReply.length,
    last_reply_sha256_head: replyContentHashHead(lastReply),
  };
}

function maybeEmitObservationHeartbeat(
  lastHeartbeatAt: number,
  pollCount: number,
  decision: PageObservationDecision,
  stableReads: number,
  completionReadySeen: boolean,
  lastReply: string,
): number {
  const now = Date.now();
  const dueByPoll = pollCount > 0 && pollCount % OBSERVATION_HEARTBEAT_POLL_INTERVAL === 0;
  const dueByTime = now - lastHeartbeatAt >= OBSERVATION_HEARTBEAT_MS;
  if (!dueByPoll && !dueByTime) return lastHeartbeatAt;
  emit(buildObservationHeartbeat(
    decision,
    stableReads,
    pollCount,
    completionReadySeen,
    lastReply,
  ));
  return now;
}


function maybeReturnObservationUncertain(
  now: number,
  hardExhaustionDeadline: number,
  sendCount: number,
  uncertainCause: string,
  ownedPromptEverSeen: boolean,
  observedUserHeads: readonly string[] | undefined,
  page: any,
  browser: any,
  invocationId: string,
  profileKey: string,
  sendCountForDiagnostics: number,
  pollCount: number,
  navigation: StateLightNavigationCounter,
  incidents: BrowserIncident[],
  journalWriteFailed: boolean,
  incident: (eventClass: string, symptom: string, action?: string) => void,
): TurnRunOutcome | null {
  if (sendCount < 1 || now < hardExhaustionDeadline) return null;
  if (ownedPromptEverSeen && uncertainCause.length === 0) return null;
  const diagnostics: ObservationUncertaintyDiagnostics = {
    cause: uncertainCause || 'owned_prompt_not_observed',
    send_count: sendCountForDiagnostics,
    owned_prompt_seen: ownedPromptEverSeen,
    ...(observedUserHeads && observedUserHeads.length > 0 ? { observed_user_heads: observedUserHeads } : {}),
  };
  const symptom = diagnostics.cause;
  const ok = recordIncident(
    incidents,
    {
      eventClass: 'interleaved_user_activity',
      symptom,
      action: 'return_local_degraded',
      uncertaintyDiagnostics: diagnostics,
    },
    invocationId,
    navigation.snapshot(),
  );
  if (!ok) journalWriteFailed = true;
  return {
    page,
    browser,
    result: compactResult(
      'observation_uncertain',
      'invocation',
      symptom,
      invocationId,
      profileKey,
      sendCount,
      pollCount,
      navigation,
      incidents,
      {
        ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}),
        observation_uncertainty_diagnostics: diagnostics,
      },
      journalWriteFailed,
    ),
  };
}

function maybeReturnObservationExhausted(
  now: number,
  softDeadline: number,
  hardExhaustionDeadline: number,
  sendCount: number,
  decision: PageObservationDecision,
  stableReads: number,
  pollCount: number,
  messages: readonly PageMessage[],
  baselineCount: number,
  page: any,
  browser: any,
  invocationId: string,
  profileKey: string,
  navigation: StateLightNavigationCounter,
  incidents: BrowserIncident[],
  journalWriteFailed: boolean,
  incident: (eventClass: string, symptom: string, action?: string) => void,
  expectedMarker: string,
  ownedPromptEverSeen: boolean,
): TurnRunOutcome | null {
  if (sendCount < 1) return null;
  const softDeadlineElapsed = now >= softDeadline;
  const diagnostics = buildObservationExhaustedDiagnostics(
    decision,
    stableReads,
    pollCount,
    messages,
    baselineCount,
    softDeadlineElapsed,
  );
  if (now >= hardExhaustionDeadline) {
    const markerCurrentlyVisible = expectedMarker.length > 0
      && messages.some((message) => message.role === 'user' && ownedPromptMatches(message.text, expectedMarker));
    if (expectedMarker && !markerCurrentlyVisible) {
      const cause = ownedPromptEverSeen
        ? 'owned_prompt_marker_disappeared'
        : 'owned_prompt_marker_unresolved';
      incident('post_send_observation_error', cause, 'return_local_degraded');
      return {
        page,
        browser,
        result: compactResult(
          'ui_contract_mismatch',
          'invocation',
          cause,
          invocationId,
          profileKey,
          sendCount,
          pollCount,
          navigation,
          incidents,
          {},
          journalWriteFailed,
        ),
      };
    }
    incident('observation_exhausted', 'observation_exhausted_no_resend', 'retain_owned_page_no_resend');
    return {
      page,
      browser,
      preserveOwnedPage: true,
      result: compactResult(
        'no_reply',
        'invocation',
        'observation_exhausted_no_resend',
        invocationId,
        profileKey,
        sendCount,
        pollCount,
        navigation,
        incidents,
        {
          ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}),
          observation_exhausted_diagnostics: diagnostics,
        },
        journalWriteFailed,
      ),
    };
  }
  return null;
}


function returnOwnerFenceLostAfterSend(
  page: any,
  browser: any,
  invocationId: string,
  profileKey: string,
  sendCount: number,
  pollCount: number,
  navigation: StateLightNavigationCounter,
  incidents: BrowserIncident[],
  journalWriteFailed: boolean,
  incident: (eventClass: string, symptom: string, action?: string) => void,
): TurnRunOutcome {
  incident('ownership_fence_lost', 'state_light_owner_fence_lost_after_send', 'retain_owned_page_no_resend');
  return {
    page,
    browser,
    preserveOwnedPage: true,
    ownershipForfeited: true,
    result: compactResult(
      'driver_error',
      'invocation',
      'state_light_owner_fence_lost_after_send',
      invocationId,
      profileKey,
      sendCount,
      pollCount,
      navigation,
      incidents,
      { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
      journalWriteFailed,
    ),
  };
}

function freshClaimOwnerFenceValid(
  profileKey: string,
  conversationUrl: string | undefined,
  invocationId: string,
  acceptedTimeoutMs: number,
): boolean {
  if (!conversationUrl) return true;
  return verifyStateLightFreshClaimOwnerFence(
    profileKey,
    conversationUrl,
    invocationId,
    acceptedTimeoutMs,
  ) === 'valid';
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code ?? '') || undefined
    : undefined;
}

function bestEffortUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // A temp cleanup miss is not completion authority once the final path is safe.
  }
}

export function publishStateLightReply(
  outputPath: string,
  invocationId: string,
  reply: string,
): StateLightPublicationResult {
  const finalPath = resolve(outputPath);
  const parent = dirname(finalPath);
  const tempPath = join(parent, `.${basename(finalPath)}.${invocationId}.${randomUUID()}.tmp`);
  let fd = -1;

  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, reply, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;

    // Atomic hard-link creation is the no-clobber commit boundary: it fails when
    // the caller-selected final path already exists and needs no legacy durable
    // publication record, witness, or recovery state.
    linkSync(tempPath, finalPath);

    const outputBytes = Buffer.byteLength(reply, 'utf8');
    const outputSha256 = createHash('sha256').update(reply, 'utf8').digest('hex');
    bestEffortUnlink(tempPath);
    return {
      state: 'committed_ok',
      output_bytes: outputBytes,
      output_sha256: outputSha256,
    };
  } catch (error) {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    bestEffortUnlink(tempPath);
    if (errnoCode(error) === 'EEXIST') {
      return { state: 'conflict', cause: 'output_exists' };
    }
    const detail = errnoCode(error) ?? (error instanceof Error ? error.message : String(error));
    return { state: 'error', cause: `output_write_failed:${detail}` };
  }
}

export function resolveOwnedReplyWindow(
  messages: readonly PageMessage[],
  baselineCount: number,
  expectedMarker: string,
): {
  readonly replyWindow: readonly PageMessage[];
  readonly uncertainCause?: string;
  readonly observedUserHeads?: readonly string[];
  readonly lastOwnedAssistantMessageIndex: number | null;
} {
  void baselineCount;
  const users = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'user');

  if (users.length === 0) {
    return { replyWindow: [], lastOwnedAssistantMessageIndex: null };
  }

  const ownedUsers = users.filter(({ message }) => ownedPromptMatches(message.text, expectedMarker));
  if (ownedUsers.length === 0) {
    return { replyWindow: [], lastOwnedAssistantMessageIndex: null };
  }
  if (ownedUsers.length > 1) {
    return { replyWindow: [], uncertainCause: 'owned_prompt_marker_ambiguous', lastOwnedAssistantMessageIndex: null };
  }

  const lastOwned = ownedUsers[0]!;
  const afterOwned = messages.slice(lastOwned.index + 1);

  let replyWindow = afterOwned;
  let uncertainCause: string | undefined;
  let observedUserHeads: string[] | undefined;

  const firstForeignUser = afterOwned.find(
    (message) => message.role === 'user' && !ownedPromptMatches(message.text, expectedMarker),
  );
  if (firstForeignUser) {
    const foreignIndex = afterOwned.indexOf(firstForeignUser);
    replyWindow = afterOwned.slice(0, foreignIndex);
    uncertainCause = 'foreign_user_after_owned_send';
    observedUserHeads = [boundedDiagnosticHead(firstForeignUser.text)];
  }

  let lastOwnedAssistantMessageIndex: number | null = null;
  for (let index = replyWindow.length - 1; index >= 0; index--) {
    if (replyWindow[index]!.role === 'assistant') {
      lastOwnedAssistantMessageIndex = lastOwned.index + 1 + index;
      break;
    }
  }

  return {
    replyWindow,
    ...(uncertainCause ? { uncertainCause } : {}),
    ...(observedUserHeads ? { observedUserHeads } : {}),
    lastOwnedAssistantMessageIndex,
  };
}

export function classifyPageObservation(
  messages: readonly PageMessage[],
  baselineCount: number,
  expectedMarker: string,
  inProgress: boolean,
): PageObservationDecision {
  const users = messages.filter((message) => message.role === 'user');
  if (users.length === 0) return { state: 'waiting' };
  if (!hasOwnedUserMessage(messages, expectedMarker)) return { state: 'waiting' };

  const { replyWindow, uncertainCause, observedUserHeads } = resolveOwnedReplyWindow(
    messages,
    baselineCount,
    expectedMarker,
  );
  const assistants = replyWindow.filter((message) => message.role === 'assistant');

  if (uncertainCause) {
    if (inProgress || assistants.length === 0) {
      return {
        state: 'uncertain',
        cause: uncertainCause,
        ...(observedUserHeads ? { observedUserHeads } : {}),
      };
    }
    const finalReply = normalizeVisibleText(assistants.at(-1)?.text ?? '');
    if (finalReply) return { state: 'ready', reply: finalReply };
    return {
      state: 'uncertain',
      cause: uncertainCause,
      ...(observedUserHeads ? { observedUserHeads } : {}),
    };
  }

  if (!inProgress && assistants.length > 0) {
    const finalReply = normalizeVisibleText(assistants.at(-1)?.text ?? '');
    if (finalReply) return { state: 'ready', reply: finalReply };
  }

  return { state: 'waiting' };
}

function browserConfig(args: ParsedTurnArgs): BrowserConfig & { pollMs: number } {
  const cdp = requireOption(args, 'cdp');
  const profile = requireOption(args, 'profile');
  const newChat = hasFlag(args, 'new-chat');
  const chatUrl = stringOption(args, 'chat-url');
  const projectUrl = stringOption(args, 'project-url');
  if (newChat === Boolean(chatUrl)) throw new Error('argument_mode_invalid');
  if (newChat && !projectUrl) throw new Error('argument_required:project-url');
  const timeoutMs = stringOption(args, 'timeout-ms')
    ? parseInteger(requireOption(args, 'timeout-ms'), 1)
    : DEFAULT_TIMEOUT_MS;
  const pollMs = stringOption(args, 'poll-ms')
    ? parseInteger(requireOption(args, 'poll-ms'), 1)
    : DEFAULT_POLL_MS;
  return {
    cdp,
    profile,
    newChat,
    timeoutMs,
    pollMs,
    ...(chatUrl ? { chatUrl } : {}),
    ...(projectUrl ? { projectUrl } : {}),
  };
}

function directPublicationConfig(
  args: ParsedTurnArgs,
  invocationId: string,
  prompt: string,
): DirectPublicationConfig | undefined {
  const sourceOutput = stringOption(args, 'reviewer-source-output');
  const directKeys = ['invocation-id', 'reviewer-source', 'repository', 'issue-number', 'source-revision'];
  const hasDirectOptions = directKeys.some((key) => args.options.has(key));
  if (!sourceOutput) {
    if (hasDirectOptions) throw new Error('input_invalid:direct_publication_requires_source_output');
    return undefined;
  }
  const repositoryFullName = requireOption(args, 'repository');
  const issueNumber = parseInteger(requireOption(args, 'issue-number'), 1);
  const sourceRevision = requireOption(args, 'source-revision');
  const reviewerSource = requireOption(args, 'reviewer-source');
  const validation = validateDirectPublicationInputs({
    invocationId,
    prompt,
    reviewerSource,
    repositoryFullName,
    issueNumber,
    sourceRevision,
  });
  if (validation) throw new Error(`input_invalid:${validation}`);
  return {
    target: { repositoryFullName, issueNumber, sourceRevision, invocationId },
    reviewerSource,
    reviewerSourceOutput: sourceOutput,
  };
}

function installDirectPublicationObserver(
  page: any,
  state: DirectPublicationObservationState,
): void {
  const consume = (payload: string): void => {
    if (!payload) return;
    try {
      observeDirectPublicationPayload(state, JSON.parse(payload) as unknown);
    } catch {
      observeDirectPublicationPayload(state, payload);
    }
  };
  page.on?.('response', async (response: any) => {
    try {
      void response.url?.();
      consume(await response.text());
    } catch {
      // Opaque or unavailable response bodies remain possible delivery.
    }
  });
  page.on?.('websocket', (socket: any) => {
    socket.on?.('framereceived', (frame: { payload?: string }) => consume(frame.payload ?? ''));
  });
}

export function compactResult(
  state: TurnState,
  scope: FailureScope,
  cause: string,
  invocationId: string,
  profileKey: string,
  sendCount: number,
  pollCount: number,
  navigation: StateLightNavigationCounter,
  incidents: readonly BrowserIncident[],
  extra: Partial<TurnResultV1> = {},
  journalWriteFailed = false,
): Omit<CompactTurnResult, 'cleanup'> {
  return {
    schema: 'turn-result/v1',
    state,
    scope,
    cause,
    invocation_id: invocationId,
    configured_profile_key: profileKey,
    send_count: sendCount,
    poll_count: pollCount,
    goto_count: navigation.snapshotGoto(),
    new_chat_click_count: navigation.snapshotNewChatClick(),
    navigation_count: navigation.snapshot(),
    incidents: incidents.map((incident) => incident.eventClass),
    ...(journalWriteFailed ? { journal_write_failed: true } : {}),
    ...extra,
  };
}

export function compactInputInvalidRefusal(
  cause: string,
  invocationId: string,
  profileKey: string,
): CompactTurnResult {
  const navigation = new StateLightNavigationCounter();
  const incidents: BrowserIncident[] = [{
    eventClass: 'input_invalid',
    symptom: cause.startsWith('input_invalid:') ? cause.slice('input_invalid:'.length) : cause,
    action: 'return_local_error',
  }];
  const journalWriteFailed = !appendIncident(incidents[0]!, invocationId);
  return {
    ...compactResult(
      'input_invalid',
      'invocation',
      cause,
      invocationId,
      profileKey,
      0,
      0,
      navigation,
      incidents,
      {},
      journalWriteFailed,
    ),
    cleanup: 'skipped',
  };
}

function appendIncident(
  incident: BrowserIncident,
  invocationId: string,
  env: NodeJS.ProcessEnv = process.env,
  navigationCount?: number,
): boolean {
  try {
    mkdirSync(dirname(BROWSER_TURN_RECURRENCE_PATH), { recursive: true });
    const issue = String(env.CREATE_ISSUE_DRAFT_ISSUE ?? env.AO_ISSUE_NUMBER ?? '').trim();
    const pr = String(env.PACK_REVIEW_PR_NUMBER ?? env.AO_PR_NUMBER ?? '').trim();
    const agent = String(env.AO_AGENT ?? env.PACK_FLOW_MANAGER ?? process.title ?? 'node').trim();
    appendFileSync(BROWSER_TURN_RECURRENCE_PATH, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...(issue ? { issue } : {}),
      ...(pr ? { pr } : {}),
      surface: 'browser-gpt-helper',
      event_class: incident.eventClass,
      observed_symptom: incident.symptom,
      ...(incident.action ? { action: incident.action } : {}),
      ...(incident.uncertaintyDiagnostics ? {
        observation_uncertainty: incident.uncertaintyDiagnostics,
      } : {}),
      invocation: invocationId,
      agent_runtime: agent,
    })}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function recordIncident(
  incidents: BrowserIncident[],
  incident: BrowserIncident,
  invocationId: string,
  navigationCount?: number,
): boolean {
  incidents.push(incident);
  return appendIncident(incident, invocationId, process.env, navigationCount);
}

async function sleep(page: any, ms: number): Promise<void> {
  if (ms <= 0) return;
  if ((page as { __fakeBrowserGptPage?: boolean }).__fakeBrowserGptPage && typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(ms);
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function locatorCount(locator: any): Promise<number> {
  try {
    return Number(await locator.count());
  } catch {
    return 0;
  }
}

async function locatorText(locator: any, timeoutMs = MAX_LOCAL_READ_WAIT_MS): Promise<string> {
  // innerText is the complete rendered message boundary; textContent is not an
  // ownership input because it can include screen-reader-only prefixes.
  try {
    return String(await locator.innerText({ timeout: timeoutMs }) ?? '');
  } catch {
    return '';
  }
}

async function readLocatorAttribute(
  locator: any,
  attribute: string,
  timeouts: readonly number[],
): Promise<string | null> {
  for (const timeoutMs of timeouts) {
    try {
      return String(await locator.getAttribute(attribute, { timeout: timeoutMs }) ?? '');
    } catch {
      // Retry with the next shorter budget.
    }
  }
  return null;
}

async function readMessageNodeText(locator: any): Promise<{ text: string; readFailed: boolean }> {
  const timeouts = [
    MESSAGE_NODE_READ_TIMEOUT_MS,
    MESSAGE_NODE_READ_RETRY_TIMEOUT_MS,
  ].slice(0, MESSAGE_NODE_READ_ATTEMPTS);
  for (const timeoutMs of timeouts) {
    const text = await locatorText(locator, timeoutMs);
    if (text) return { text, readFailed: false };
  }
  return { text: '', readFailed: true };
}

async function readPageMessages(page: any): Promise<PageMessage[]> {
  return (await readPageObservation(page)).messages;
}

export async function readPageObservation(
  page: any,
  expectedMarker?: string,
  baselineCount?: number,
): Promise<PageObservationResult> {
  const nodes = page.locator(MESSAGE_NODE_SELECTOR);
  const count = await locatorCount(nodes);
  const messages: PageMessage[] = [];
  const domIndices: number[] = [];
  let transcriptIncomplete = false;
  const roleTimeouts = [
    MESSAGE_NODE_READ_TIMEOUT_MS,
    MESSAGE_NODE_READ_RETRY_TIMEOUT_MS,
  ].slice(0, MESSAGE_NODE_READ_ATTEMPTS);
  for (let index = 0; index < count; index++) {
    const node = nodes.nth(index);
    const role = await readLocatorAttribute(node, MESSAGE_AUTHOR_ROLE_ATTR, roleTimeouts);
    if (role === null) {
      transcriptIncomplete = true;
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue;
    const { text, readFailed } = await readMessageNodeText(node);
    if (readFailed) transcriptIncomplete = true;
    messages.push({ role: role as 'user' | 'assistant', text });
    domIndices.push(index);
  }

  let ownedWindowCompletionReady = false;
  if (expectedMarker !== undefined && baselineCount !== undefined) {
    const { lastOwnedAssistantMessageIndex } = resolveOwnedReplyWindow(messages, baselineCount, expectedMarker);
    const ownedAssistantDomIndex = lastOwnedAssistantMessageIndex === null
      ? null
      : domIndices[lastOwnedAssistantMessageIndex] ?? null;
    if (ownedAssistantDomIndex !== null) {
      ownedWindowCompletionReady = await readAssistantNodeCompletionReady(
        nodes.nth(ownedAssistantDomIndex),
        MESSAGE_NODE_READ_TIMEOUT_MS,
      );
    } else {
      ownedWindowCompletionReady = await readAssistantTurnCompletionReady(page, MESSAGE_NODE_READ_TIMEOUT_MS);
    }
  }

  return { messages, ownedWindowCompletionReady, transcriptIncomplete };
}

export type SendLandingEvidence = 'landed' | 'not_landed' | 'ambiguous';

export async function classifySendLandingEvidence(
  page: any,
  promptText: string,
  conversationUrl?: string,
): Promise<SendLandingEvidence> {
  const normalizedPrompt = normalizeVisibleText(promptText);
  if (conversationUrl && conversationUuidFromUrl(conversationUrl)) return 'landed';
  const pageUrl = pageConversationUrl(page);
  if (pageUrl && conversationUuidFromUrl(pageUrl)) return 'landed';
  const messages = await readPageMessages(page);
  if (messages.some((message) => message.role === 'user' && normalizeVisibleText(message.text) === normalizedPrompt)) {
    return 'landed';
  }
  const composer = page.locator(COMPOSER_SELECTOR);
  if (await locatorCount(composer) > 0) {
    const composerText = normalizeVisibleText(await locatorText(composer));
    if (composerText === normalizedPrompt) return 'not_landed';
  }
  return 'ambiguous';
}

function recordProductWallAdvisory(
  profileKey: string,
  wallState: TurnState,
  cause: string,
  invocationId: string,
): void {
  if (wallState === 'rate_limit' || wallState === 'quota' || wallState === 'challenge' || wallState === 'login') {
    recordStateLightAdvisoryWall(profileKey, wallState, cause, invocationId);
  }
}

async function readPostSendObservation(
  page: any,
  expectedMarker: string,
  baselineCount: number,
): Promise<{
  readonly messages: PageMessage[];
  readonly wall: ReturnType<typeof classifyProductWall>;
  readonly ownedWindowCompletionReady: boolean;
  readonly transcriptIncomplete: boolean;
}> {
  const { messages, ownedWindowCompletionReady, transcriptIncomplete } = await readPageObservation(
    page,
    expectedMarker,
    baselineCount,
  );
  let wall: ReturnType<typeof classifyProductWall> = {};
  try {
    wall = classifyProductWall(await productStatusText(page, POST_SEND_PRODUCT_WALL_PROBE_MS));
  } catch {
    // Product-status probes must not block or invalidate transcript reads.
  }
  return { messages, wall, ownedWindowCompletionReady, transcriptIncomplete };
}

async function maybeContinueGeneration(page: any): Promise<boolean> {
  try {
    const continuation = locateContinueGeneratingControl(page);
    if (await locatorCount(continuation) === 0) return false;
    await continuation.first().click({ timeout: MAX_LOCAL_READ_WAIT_MS });
    return true;
  } catch {
    return false;
  }
}

async function readComposerReadiness(page: any, deadline: number): Promise<boolean> {
  try {
    const composer = page.locator(COMPOSER_SELECTOR);
    let remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    if (await locatorCount(composer) <= 0 || Date.now() >= deadline) return false;

    remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    const readiness = typeof composer.evaluate === 'function'
      ? await composer.evaluate(
        (element: any) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            visible: style.display !== 'none'
              && style.visibility !== 'hidden'
              && rect.width > 0
              && rect.height > 0,
            enabled: !element.matches(':disabled')
              && element.getAttribute('aria-disabled') !== 'true',
            contentEditable: Boolean(
              element.isContentEditable || element.contentEditable === 'true',
            ),
          };
        },
        undefined,
        { timeout: remainingMs },
      )
      : undefined;
    if (Date.now() >= deadline) return false;

    // Legacy page fixtures expose presence only. Real DOM-backed locators return
    // the object above; test fixtures with deterministic controls do the same.
    if (!readiness || typeof readiness !== 'object') return Date.now() < deadline;
    const observed = readiness as { visible?: unknown; enabled?: unknown; contentEditable?: unknown };
    return Boolean(
      observed.visible
      && observed.enabled
      && observed.contentEditable
      && Date.now() < deadline,
    );
  } catch {
    return false;
  }
}

async function waitForComposer(
  page: any,
  invocationDeadlineMs: number,
): Promise<{ state: 'ready' } | { state: TurnState; cause: string }> {
  const readinessStart = Date.now();
  const readinessDeadline = Math.min(readinessStart + COMPOSER_READINESS_WAIT_MS, invocationDeadlineMs);
  while (true) {
    let remainingMs = readinessDeadline - Date.now();
    if (remainingMs <= 0) break;
    const wall = classifyProductWall(
      await productStatusText(page, Math.min(MAX_LOCAL_READ_WAIT_MS, remainingMs)),
    );
    if (Date.now() >= readinessDeadline) break;
    if (wall.state) return { state: wall.state, cause: wall.cause ?? `${wall.state}_detected` };
    if (await readComposerReadiness(page, readinessDeadline)) return { state: 'ready' };
    remainingMs = readinessDeadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(page, Math.min(INITIAL_POLL_MS, remainingMs));
  }
  return { state: 'ui_contract_mismatch', cause: 'composer_unavailable' };
}

function isPlaywrightTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError' || /timeout/i.test(error.message);
}

async function hasBlockingPageOverlay(page: any): Promise<boolean> {
  const overlay = page.locator(BLOCKING_PAGE_OVERLAY_SELECTOR);
  if (await locatorCount(overlay) === 0) return false;
  const wall = classifyProductWall(
    await productStatusText(page, Math.min(MAX_LOCAL_READ_WAIT_MS, POST_SEND_PRODUCT_WALL_PROBE_MS)),
  );
  return !wall.state;
}

function remainingComposerMutationMs(
  insertionDeadlineMs: number,
  invocationDeadlineMs: number,
): number {
  const now = Date.now();
  return Math.min(insertionDeadlineMs - now, invocationDeadlineMs - now);
}

async function mutateComposerOrCause(
  page: any,
  text: string,
  invocationDeadlineMs: number,
  insertionContext?: { insertionDeadlineMs?: number },
): Promise<PreSendComposerFailureCause | null> {
  const composer = page.locator(COMPOSER_SELECTOR);
  const insertionStart = Date.now();
  const insertionDeadlineMs = Math.min(insertionStart + deriveComposerInsertionBudgetMs(text), invocationDeadlineMs);
  if (insertionContext) insertionContext.insertionDeadlineMs = insertionDeadlineMs;
  if (!(await readComposerReadiness(page, insertionDeadlineMs))) {
    return 'composer_mutation_budget_exhausted';
  }

  try {
    let actionBudgetMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
    if (actionBudgetMs <= 0) return 'composer_mutation_budget_exhausted';
    await composer.click({ timeout: actionBudgetMs });
    if (Date.now() >= insertionDeadlineMs) return 'composer_mutation_budget_exhausted';

    actionBudgetMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
    if (actionBudgetMs <= 0) return 'composer_mutation_budget_exhausted';
    if (!(await readComposerReadiness(page, insertionDeadlineMs))) {
      return 'composer_mutation_budget_exhausted';
    }
    actionBudgetMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
    if (actionBudgetMs <= 0) return 'composer_mutation_budget_exhausted';
    await composer.fill(text, { timeout: actionBudgetMs });
    if (Date.now() >= insertionDeadlineMs) return 'composer_mutation_budget_exhausted';
    return null;
  } catch (error) {
    if (isPlaywrightTimeoutError(error) && await hasBlockingPageOverlay(page)) {
      return 'blocking_page_overlay';
    }
    return 'composer_mutation_budget_exhausted';
  }
}

async function createDedicatedTurnPage(browser: any): Promise<any> {
  const contexts = browser.contexts();
  if (contexts.length !== 1) throw new Error('ui_contract_mismatch:context_count');
  return contexts[0].newPage();
}

async function navigateOwnedTurnPage(
  page: any,
  config: BrowserConfig,
  navigation: StateLightNavigationCounter,
): Promise<void> {
  const target = config.newChat
    ? projectConversationPrefix(config.projectUrl ?? '')
    : normalizeConversationUrl(config.chatUrl ?? '');
  if (!target) throw new Error('ui_contract_mismatch:target_required');
  navigation.recordGoto();
  await page.goto(target, {
    waitUntil: 'domcontentloaded',
    timeout: Math.min(MAX_LOCAL_READ_WAIT_MS * 6, config.timeoutMs),
  });
  if (!config.newChat && !ownedConversationIdentityMatches(page.url(), target)) {
    throw new Error('ui_contract_mismatch:conversation_redirect');
  }
}

export type OwnedConversationIdentity = {
  matched: boolean;
  targetUuid?: string;
  pageUuid?: string;
  pageUrl?: string;
};

export function readOwnedConversationIdentity(page: any, targetChatUrl: string): OwnedConversationIdentity {
  const targetUuid = conversationUuidFromUrl(targetChatUrl);
  let pageUrl: string | undefined;
  try {
    pageUrl = normalizeConversationUrl(String(page.url()));
  } catch {
    return { matched: false, targetUuid, pageUuid: undefined, pageUrl };
  }
  const pageUuid = conversationUuidFromUrl(pageUrl);
  return {
    matched: ownedConversationIdentityMatches(pageUrl, targetChatUrl),
    targetUuid,
    pageUuid,
    pageUrl,
  };
}

function returnOwnedConversationIdentityMismatch(
  identity: OwnedConversationIdentity,
  page: any,
  browser: any,
  invocationId: string,
  profileKey: string,
  sendCount: number,
  pollCount: number,
  navigation: StateLightNavigationCounter,
  incidents: BrowserIncident[],
  journalWriteFailed: boolean,
  incident: (eventClass: string, symptom: string, action?: string) => void,
  afterSend: boolean,
): TurnRunOutcome {
  incident(
    'conversation_identity_mismatch',
    'owned_conversation_identity_mismatch',
    afterSend ? 'retain_owned_page_no_resend' : 'return_local_error',
  );
  return {
    page,
    browser,
    result: compactResult(
      'ui_contract_mismatch',
      'invocation',
      'owned_conversation_identity_mismatch',
      invocationId,
      profileKey,
      sendCount,
      pollCount,
      navigation,
      incidents,
      {
        ...(identity.pageUrl ? { conversation_id: identity.pageUrl } : {}),
      },
      journalWriteFailed,
    ),
  };
}

function hasPostSendTranscript(messages: readonly PageMessage[], baselineCount: number): boolean {
  return messages.length > baselineCount;
}

function returnOwnedConversationRenderMismatch(
  page: any,
  browser: any,
  invocationId: string,
  profileKey: string,
  sendCount: number,
  pollCount: number,
  navigation: StateLightNavigationCounter,
  incidents: BrowserIncident[],
  journalWriteFailed: boolean,
  incident: (eventClass: string, symptom: string, action?: string) => void,
): TurnRunOutcome {
  incident(
    'conversation_render_mismatch',
    'owned_conversation_render_mismatch',
    'retain_owned_page_no_resend',
  );
  return {
    page,
    browser,
    result: compactResult(
      'ui_contract_mismatch',
      'invocation',
      'owned_conversation_render_mismatch',
      invocationId,
      profileKey,
      sendCount,
      pollCount,
      navigation,
      incidents,
      {
        ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}),
      },
      journalWriteFailed,
    ),
  };
}

function returnFreshConversationLandingMismatch(
  page: any,
  browser: any,
  invocationId: string,
  profileKey: string,
  sendCount: number,
  pollCount: number,
  navigation: StateLightNavigationCounter,
  incidents: BrowserIncident[],
  journalWriteFailed: boolean,
  incident: (eventClass: string, symptom: string, action?: string) => void,
): TurnRunOutcome {
  incident(
    'conversation_landing_mismatch',
    'fresh_conversation_landing_mismatch',
    'retain_owned_page_no_resend',
  );
  return {
    page,
    browser,
    result: compactResult(
      'ui_contract_mismatch',
      'invocation',
      'fresh_conversation_landing_mismatch',
      invocationId,
      profileKey,
      sendCount,
      pollCount,
      navigation,
      incidents,
      {
        ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}),
      },
      journalWriteFailed,
    ),
  };
}

function pageConversationUrl(page: any): string | undefined {
  try {
    const url = normalizeConversationUrl(String(page.url()));
    return url.includes('/c/') ? url : undefined;
  } catch {
    return undefined;
  }
}

function browserOrPageDefinitelyLost(page: any, browser: any): boolean {
  if (!page) return true;
  try {
    if (typeof page.isClosed === 'function' && page.isClosed() === true) return true;
  } catch {
    // Probe failure is not proof of loss.
  }
  try {
    if (browser && typeof browser.isConnected === 'function' && browser.isConnected() === false) return true;
  } catch {
    // Probe failure is not proof of loss.
  }
  return false;
}

async function runTurn(args: ParsedTurnArgs): Promise<TurnRunOutcome> {
  rejectUnknownOptions(args, [
    'profile',
    'cdp',
    'input',
    'output',
    'chat-url',
    'new-chat',
    'project-url',
    'timeout-ms',
    'poll-ms',
    'invocation-id',
    'reviewer-source-output',
    'reviewer-source',
    'repository',
    'issue-number',
    'source-revision',
  ]);
  const invocationId = stringOption(args, 'invocation-id') ?? randomUUID();
  let profileKey = 'profile-unresolved';
  let browser: any;
  let page: any;
  let sendCount = 0;
  let pollCount = 0;
  const navigation = new StateLightNavigationCounter();
  let journalWriteFailed = false;
  const incidents: BrowserIncident[] = [];
  let afterSend = false;
  let ownershipForfeited = false;

  const incident = (eventClass: string, symptom: string, action?: string): void => {
    const ok = recordIncident(
      incidents,
      { eventClass, symptom, ...(action ? { action } : {}) },
      invocationId,
      navigation.snapshot(),
    );
    if (!ok) journalWriteFailed = true;
  };

  try {
    const baseConfig = browserConfig(args);
    if (baseConfig.timeoutMs > STATE_LIGHT_MAX_TIMEOUT_MS) {
      incident('input_invalid', 'timeout_ms_exceeds_maximum', 'return_local_error');
      return {
        result: compactResult(
          'input_invalid',
          'invocation',
          'timeout_ms_exceeds_maximum',
          invocationId,
          configuredProfileKey(baseConfig.profile, baseConfig.cdp),
          0,
          pollCount,
          navigation,
          incidents,
          {},
          journalWriteFailed,
        ),
      };
    }
    profileKey = configuredProfileKey(baseConfig.profile, baseConfig.cdp);
    const snapshot = readStableInput(requireOption(args, 'input'));
    const direct = directPublicationConfig(args, invocationId, snapshot.text);
    const destination = destinationIdentity(requireOption(args, 'output'));
    const reviewerSourceDestination = direct ? destinationIdentity(direct.reviewerSourceOutput) : undefined;
    if (direct && reviewerSourceDestination?.finalPath === destination.finalPath) {
      throw new Error('input_invalid:direct_publication_artifact_alias');
    }
    const config = direct ? { ...baseConfig, directPublication: direct } : baseConfig;

    const profile = await verifyProfile(config);
    if (profile.state !== 'verified') {
      const state: TurnState = profile.state === 'unavailable' ? 'chrome_not_running' : 'profile_mismatch';
      incident('invocation_blocker', profile.cause, 'return_local_error');
      return {
        result: compactResult(
          state,
          'invocation',
          profile.cause,
          invocationId,
          profileKey,
          sendCount,
          pollCount, navigation, incidents,
          {},
          journalWriteFailed,
        ),
      };
    }

    const invocationDeadlineMs = Date.now() + config.timeoutMs;

    const chromium = loadChromium();
    browser = await chromium.connectOverCDP(config.cdp, { timeout: Math.min(30_000, config.timeoutMs) });
    page = await createDedicatedTurnPage(browser);
    await navigateOwnedTurnPage(page, config, navigation);
    const directObservation = createDirectPublicationObservationState();
    if (config.directPublication) installDirectPublicationObserver(page, directObservation);

    let baselineCount = 0;
    let ownedConversationUrl: string | undefined;


    const returnComposerMutationFailure = (
      cause: PreSendComposerFailureCause,
    ): TurnRunOutcome => {
      incident('invocation_blocker', cause, 'return_local_error');
      return {
        page,
        browser,
        result: compactResult(
          'driver_error',
          'invocation',
          cause,
          invocationId,
          profileKey,
          sendCount,
          pollCount, navigation, incidents,
          {},
          journalWriteFailed,
        ),
      };
    };

    const marker = generateOwnedPromptMarker();
    const markedPayload = wrapOwnedPromptPayload(marker, snapshot.text);

    const sendOwnedPrompt = async (): Promise<TurnRunOutcome | null> => {
      const insertionContext: { insertionDeadlineMs?: number } = {};
      const mutationFailure = await mutateComposerOrCause(
        page,
        markedPayload,

        invocationDeadlineMs,
        insertionContext,
      );
      if (mutationFailure) return returnComposerMutationFailure(mutationFailure);
      const insertionDeadlineMs = insertionContext.insertionDeadlineMs ?? invocationDeadlineMs;
      let remainingMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
      if (remainingMs <= 0) return returnComposerMutationFailure("composer_mutation_budget_exhausted");
      if (!(await readComposerReadiness(page, insertionDeadlineMs))) {
        return returnComposerMutationFailure("composer_mutation_budget_exhausted");
      }
      remainingMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
      if (remainingMs <= 0) return returnComposerMutationFailure("composer_mutation_budget_exhausted");
      const composer = page.locator(COMPOSER_SELECTOR);
      const sendButton = page.locator(SEND_BUTTON_SELECTOR);
      const hasSendButton = await locatorCount(sendButton) > 0;
      remainingMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
      if (remainingMs <= 0) return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      if (!(await readComposerReadiness(page, insertionDeadlineMs))) {
        return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      }
      remainingMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
      if (remainingMs <= 0) return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      if (hasSendButton) {
        await sendButton.click({ timeout: MAX_LOCAL_READ_WAIT_MS });
      } else {
        await composer.press('Enter', { timeout: MAX_LOCAL_READ_WAIT_MS });
      }
      sendCount += 1;
      afterSend = true;
      return null;
    };

    if (config.newChat) {
      await acquireStateLightNewChatSendSlot(profileKey, invocationId, config.timeoutMs);
      try {
        const returnFreshPrepareFailure = (
          prepared: Awaited<ReturnType<typeof prepareStateLightFreshConversation>>,
        ): TurnRunOutcome | null => {
          if (prepared.state === 'ready') return null;
          if (prepared.state === 'wall') {
            recordProductWallAdvisory(profileKey, prepared.wallState, prepared.cause, invocationId);
            incident('invocation_blocker', prepared.cause, 'return_local_error');
            return {
              page,
              browser,
              result: compactResult(
                prepared.wallState,
                'invocation',
                prepared.cause,
                invocationId,
                profileKey,
                sendCount,
                pollCount, navigation, incidents,
                {},
                journalWriteFailed,
              ),
            };
          }
          incident('invocation_blocker', prepared.cause, 'return_local_error');
          return {
            page,
            browser,
            result: compactResult(
              'ui_contract_mismatch',
              'invocation',
              prepared.cause,
              invocationId,
              profileKey,
              sendCount,
              pollCount, navigation, incidents,
              {},
              journalWriteFailed,
            ),
          };
        };

        const returnComposerBlocker = (
          composerState: { state: 'ready' } | { state: TurnState; cause: string },
        ): TurnRunOutcome | null => {
          if (composerState.state === 'ready') return null;
          recordProductWallAdvisory(profileKey, composerState.state, composerState.cause, invocationId);
          incident('invocation_blocker', composerState.cause, 'return_local_error');
          return {
            page,
            browser,
            result: compactResult(
              composerState.state,
              'invocation',
              composerState.cause,
              invocationId,
              profileKey,
              sendCount,
              pollCount, navigation, incidents,
              {},
              journalWriteFailed,
            ),
          };
        };

        const initialPrepare = await prepareStateLightFreshConversation(
          page,
          config,
          profileKey,
          invocationId,
          navigation,
        );
        const initialPrepareFailure = returnFreshPrepareFailure(initialPrepare);
        if (initialPrepareFailure) return initialPrepareFailure;

        let composerState = await waitForComposer(page, invocationDeadlineMs);
        const initialComposerFailure = returnComposerBlocker(composerState);
        if (initialComposerFailure) return initialComposerFailure;

        let claimed = false;
        let sendAuthorized = true;
        let lastAttemptConversationUrl: string | undefined;
        for (let recovery = 0; recovery < STATE_LIGHT_FRESH_RECOVERY_ATTEMPTS && !claimed; recovery++) {
          if (recovery > 0) {
            const landingEvidence = await classifySendLandingEvidence(
              page,
              markedPayload,
              lastAttemptConversationUrl,
            );
            if (landingEvidence === 'landed') {
              incident('fresh_conversation_collision', 'send_landed_no_resend', 'return_local_error');
              return {
                page,
                browser,
                result: compactResult(
                  'driver_error',
                  'invocation',
                  'fresh_conversation_collision_send_landed',
                  invocationId,
                  profileKey,
                  sendCount,
                  pollCount, navigation, incidents,
                  { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
                  journalWriteFailed,
                ),
              };
            }
            if (landingEvidence === 'ambiguous') {
              incident('send_observation_error', 'fresh_conversation_send_state_ambiguous', 'return_local_error');
              return {
                page,
                browser,
                result: compactResult(
                  'driver_error',
                  'invocation',
                  'fresh_conversation_send_state_ambiguous',
                  invocationId,
                  profileKey,
                  sendCount,
                  pollCount, navigation, incidents,
                  { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
                  journalWriteFailed,
                ),
              };
            }
            incident('fresh_conversation_collision', 'shared_fresh_conversation_surface', 'recover_on_isolated_surface');
            const prepared = await prepareStateLightFreshConversation(
              page,
              config,
              profileKey,
              invocationId,
              navigation,
            );
            const preparedFailure = returnFreshPrepareFailure(prepared);
            if (preparedFailure) return preparedFailure;
            composerState = await waitForComposer(page, invocationDeadlineMs);
            const composerFailure = returnComposerBlocker(composerState);
            if (composerFailure) return composerFailure;
            sendAuthorized = true;
          }

          if (sendAuthorized) {
            if (verifyStateLightSendSlotOwnerFence(profileKey, invocationId) !== 'valid') {
              sendAuthorized = false;
              if (sendCount >= 1) {
                ownershipForfeited = true;
                return returnOwnerFenceLostAfterSend(
                  page,
                  browser,
                  invocationId,
                  profileKey,
                  sendCount,
                  pollCount,
                  navigation,
                  incidents,
                  journalWriteFailed,
                  incident,
                );
              }
              continue;
            }
            baselineCount = (await readPageMessages(page)).length;
            const sendFailure = await sendOwnedPrompt();
            if (sendFailure) return sendFailure;
            sendAuthorized = false;
          }

          const urlDeadline = Date.now() + Math.min(30_000, config.timeoutMs);
          const conversationUrl = await waitForConversationUrlAfterSend(
            page,
            config.projectUrl!,
            urlDeadline,
            sleep,
            INITIAL_POLL_MS,
          );
          if (!conversationUrl) {
            if (sendCount >= 1) {
              incident(
                'send_observation_deferred',
                'fresh_conversation_url_not_observed',
                'continue_observing_after_send',
              );
              lastAttemptConversationUrl = pageConversationUrl(page) ?? lastAttemptConversationUrl;
              claimed = true;
              break;
            }
            incident('send_observation_error', 'fresh_conversation_url_not_observed', 'return_local_error');
            return {
              page,
              browser,
              result: compactResult(
                'send_failed',
                'invocation',
                'fresh_conversation_url_not_observed',
                invocationId,
                profileKey,
                sendCount,
                pollCount, navigation, incidents,
                { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
                journalWriteFailed,
              ),
            };
          }
          lastAttemptConversationUrl = conversationUrl;

          if (verifyStateLightSendSlotOwnerFence(profileKey, invocationId) !== 'valid') {
            if (sendCount >= 1) {
              ownershipForfeited = true;
              return returnOwnerFenceLostAfterSend(
                page,
                browser,
                invocationId,
                profileKey,
                sendCount,
                pollCount,
                navigation,
                incidents,
                journalWriteFailed,
                incident,
              );
            }
            continue;
          }
          const claim = tryClaimStateLightFreshConversation(
            profileKey,
            conversationUrl,
            invocationId,
            config.timeoutMs,
          );
          if (claim === 'contended') {
            const landingEvidence = await classifySendLandingEvidence(
              page,
              markedPayload,
              conversationUrl,
            );
            if (landingEvidence === 'landed') {
              incident('fresh_conversation_collision', 'send_landed_no_resend', 'return_local_error');
              return {
                page,
                browser,
                result: compactResult(
                  'driver_error',
                  'invocation',
                  'fresh_conversation_collision_send_landed',
                  invocationId,
                  profileKey,
                  sendCount,
                  pollCount, navigation, incidents,
                  { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
                  journalWriteFailed,
                ),
              };
            }
            if (landingEvidence === 'ambiguous') {
              incident('send_observation_error', 'fresh_conversation_send_state_ambiguous', 'return_local_error');
              return {
                page,
                browser,
                result: compactResult(
                  'driver_error',
                  'invocation',
                  'fresh_conversation_send_state_ambiguous',
                  invocationId,
                  profileKey,
                  sendCount,
                  pollCount, navigation, incidents,
                  { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
                  journalWriteFailed,
                ),
              };
            }
            continue;
          }
          if (claim === 'claimed' || claim === 'owned') {
            claimed = true;
            ownedConversationUrl = conversationUrl;
            break;
          }
        }

        if (!claimed) {
          const landingEvidence = await classifySendLandingEvidence(
            page,
            markedPayload,
            lastAttemptConversationUrl,
          );
          if (landingEvidence === 'landed') {
            incident('fresh_conversation_collision', 'send_landed_no_resend', 'return_local_error');
            return {
              page,
              browser,
              result: compactResult(
                'driver_error',
                'invocation',
                'fresh_conversation_collision_send_landed',
                invocationId,
                profileKey,
                sendCount,
                pollCount, navigation, incidents,
                { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
                journalWriteFailed,
              ),
            };
          }
          incident('fresh_conversation_recovery_exhausted', 'shared_fresh_conversation_surface', 'return_local_error');
          return {
            page,
            browser,
            result: compactResult(
              'driver_error',
              'invocation',
              'fresh_conversation_recovery_exhausted',
              invocationId,
              profileKey,
              sendCount,
              pollCount, navigation, incidents,
              { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
              journalWriteFailed,
            ),
          };
        }
      } finally {
        if (!ownershipForfeited) {
          releaseStateLightNewChatSendSlot(profileKey, invocationId);
        }
      }
    } else {
      const chatUrlTarget = normalizeConversationUrl(config.chatUrl ?? '');
      const preSendIdentity = readOwnedConversationIdentity(page, chatUrlTarget);
      if (!preSendIdentity.matched) {
        return returnOwnedConversationIdentityMismatch(
          preSendIdentity,
          page,
          browser,
          invocationId,
          profileKey,
          sendCount,
          pollCount,
          navigation,
          incidents,
          journalWriteFailed,
          incident,
          false,
        );
      }

      const composerState = await waitForComposer(page, invocationDeadlineMs);
      if (composerState.state !== 'ready') {
        recordProductWallAdvisory(profileKey, composerState.state, composerState.cause, invocationId);
        incident('invocation_blocker', composerState.cause, 'return_local_error');
        return {
          page,
          browser,
          result: compactResult(
            composerState.state,
            'invocation',
            composerState.cause,
            invocationId,
            profileKey,
            sendCount,
            pollCount, navigation, incidents,
            {},
            journalWriteFailed,
          ),
        };
      }

      baselineCount = (await readPageMessages(page)).length;
      const sendFailure = await sendOwnedPrompt();
      if (sendFailure) return sendFailure;
    }

    const targetChatUrl = config.newChat
      ? undefined
      : normalizeConversationUrl(config.chatUrl ?? '');
    if (targetChatUrl) {
      const landingIdentity = readOwnedConversationIdentity(page, targetChatUrl);
      if (!landingIdentity.matched) {
        return returnOwnedConversationIdentityMismatch(
          landingIdentity,
          page,
          browser,
          invocationId,
          profileKey,
          sendCount,
          pollCount,
          navigation,
          incidents,
          journalWriteFailed,
          incident,
          sendCount >= 1,
        );
      }
    }

    if (config.newChat && ownedConversationUrl) {
      await navigateToProjectConversationIfNeeded(
        page,
        ownedConversationUrl,
        navigation,
        Math.min(MAX_LOCAL_READ_WAIT_MS * 6, config.timeoutMs),
      );
    }

    const startedAt = Date.now();
    const softDeadline = startedAt + config.timeoutMs;
    // `2 × timeout-ms` is a post-send decision threshold, not a hard observation ceiling.
    const hardExhaustionDeadline = startedAt + (config.timeoutMs * 2);
    const dispatchDeadline = startedAt + Math.min(DISPATCH_OBSERVATION_MS, config.timeoutMs);
    const freshConversationLandingDeadline = startedAt + Math.min(
      FRESH_CONVERSATION_LANDING_MS,
      config.timeoutMs,
    );
    let lastReadyReply = '';
    let bestReadyReply = '';
    let stableReads = 0;
    let uncertainCause = '';
    let observedUserHeads: string[] | undefined;
    let ownedPromptEverSeen = false;
    let completionReadySeen = false;
    let sendObservationDeferredLogged = false;
    let lastHeartbeatAt = startedAt;
    const emitHeartbeatForPoll = (decision: PageObservationDecision): void => {
      lastHeartbeatAt = maybeEmitObservationHeartbeat(
        lastHeartbeatAt,
        pollCount,
        decision,
        stableReads,
        completionReadySeen,
        decision.state === 'ready' && decision.reply ? decision.reply : (bestReadyReply || lastReadyReply),
      );
    };

    // `timeout-ms` is a soft post-send observation threshold. Once a prompt has
    // landed and this invocation still owns a reachable page, #1120 requires us
    // to keep that page rather than manufacture lost-chat/resend eligibility.
    while (true) {
      pollCount++;
      if (config.newChat && sendCount >= 1) {
        const observedConversationUrl = readProjectConversationUrl(page, config.projectUrl ?? '');
        if (observedConversationUrl) {
          if (!ownedConversationUrl) ownedConversationUrl = observedConversationUrl;
          await navigateToProjectConversationIfNeeded(
            page,
            observedConversationUrl,
            navigation,
            Math.min(MAX_LOCAL_READ_WAIT_MS * 6, config.timeoutMs),
          );
        } else if (ownedConversationUrl) {
          await navigateToProjectConversationIfNeeded(
            page,
            ownedConversationUrl,
            navigation,
            Math.min(MAX_LOCAL_READ_WAIT_MS * 6, config.timeoutMs),
          );
        }
      }
      if (targetChatUrl) {
        const identity = readOwnedConversationIdentity(page, targetChatUrl);
        if (!identity.matched) {
          return returnOwnedConversationIdentityMismatch(
            identity,
            page,
            browser,
            invocationId,
            profileKey,
            sendCount,
            pollCount,
            navigation,
            incidents,
            journalWriteFailed,
            incident,
            true,
          );
        }
      }
      let observation: Awaited<ReturnType<typeof readPostSendObservation>>;
      try {
        observation = await readPostSendObservation(page, marker, baselineCount);
      } catch (error) {
        if (browserOrPageDefinitelyLost(page, browser)) throw error;
        const symptom = error instanceof Error ? error.message : String(error);
        incident('post_send_observation_error', symptom, 'continue_polling_owned_page');
        if (!(completionReadySeen && bestReadyReply.length > 0)) {
          stableReads = 0;
          lastReadyReply = '';
          bestReadyReply = '';
        }
        const readErrorExhausted = maybeReturnObservationExhausted(
          Date.now(),
          softDeadline,
          hardExhaustionDeadline,
          sendCount,
          { state: 'waiting' },
          stableReads,
          pollCount,
          [],
          baselineCount,
          page,
          browser,
          invocationId,
          profileKey,
          navigation,
          incidents,
          journalWriteFailed,
          incident,
          marker,
          ownedPromptEverSeen,
        );
        if (readErrorExhausted) return readErrorExhausted;
        emitHeartbeatForPoll({ state: 'waiting' });
        await sleep(page, INITIAL_POLL_MS);
        continue;
      }

      const { messages, wall, ownedWindowCompletionReady, transcriptIncomplete } = observation;
      if (
        config.newChat
        && ownedConversationUrl
        && !ownershipForfeited
        && !freshClaimOwnerFenceValid(profileKey, ownedConversationUrl, invocationId, config.timeoutMs)
      ) {
        ownershipForfeited = true;
        return returnOwnerFenceLostAfterSend(
          page,
          browser,
          invocationId,
          profileKey,
          sendCount,
          pollCount,
          navigation,
          incidents,
          journalWriteFailed,
          incident,
        );
      }
      if (ownedWindowCompletionReady) completionReadySeen = true;
      if (wall.state) {
        const cause = wall.cause ?? `${wall.state}_detected`;
        recordProductWallAdvisory(profileKey, wall.state, cause, invocationId);
        incident('invocation_blocker', cause, 'return_local_error');
        return {
          page,
          browser,
          result: compactResult(
            wall.state,
            'invocation',
            cause,
            invocationId,
            profileKey,
            sendCount,
            pollCount, navigation, incidents,
            { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
            journalWriteFailed,
          ),
        };
      }

      if (transcriptIncomplete) {
        incident('post_send_observation_error', 'transcript_read_incomplete', 'continue_polling_owned_page');
        const incompleteExhausted = maybeReturnObservationExhausted(
          Date.now(),
          softDeadline,
          hardExhaustionDeadline,
          sendCount,
          { state: 'waiting' },
          stableReads,
          pollCount,
          messages,
          baselineCount,
          page,
          browser,
          invocationId,
          profileKey,
          navigation,
          incidents,
          journalWriteFailed,
          incident,
          marker,
          ownedPromptEverSeen,
        );
        if (incompleteExhausted) return incompleteExhausted;
        emitHeartbeatForPoll({ state: 'waiting' });
        await sleep(page, completionReadySeen ? COMPLETION_CONFIRM_POLL_MS : INITIAL_POLL_MS);
        continue;
      }

      const inProgress = !ownedWindowCompletionReady && !completionReadySeen;
      const decision = classifyPageObservation(messages, baselineCount, marker, inProgress);

      if (hasOwnedUserMessage(messages, marker)) {
        ownedPromptEverSeen = true;
      }

      if (decision.state === 'uncertain' && decision.cause === 'owned_prompt_marker_ambiguous') {
        incident('post_send_observation_error', 'owned_prompt_marker_ambiguous', 'return_local_degraded');
        return { page, browser, result: compactResult('ui_contract_mismatch', 'invocation', 'owned_prompt_marker_ambiguous', invocationId, profileKey, sendCount, pollCount, navigation, incidents, {}, journalWriteFailed) };
      }

      if (decision.state === 'uncertain') {
        uncertainCause = decision.cause ?? 'interleaved_user_activity';
        observedUserHeads = decision.observedUserHeads
          ? [...decision.observedUserHeads]
          : observedUserHeads;
        stableReads = 0;
        lastReadyReply = '';
        bestReadyReply = '';
        const uncertainExhausted = maybeReturnObservationUncertain(
          Date.now(),
          hardExhaustionDeadline,
          sendCount,
          uncertainCause,
          ownedPromptEverSeen,
          observedUserHeads,
          page,
          browser,
          invocationId,
          profileKey,
          sendCount,
          pollCount,
          navigation,
          incidents,
          journalWriteFailed,
          incident,
        );
        if (uncertainExhausted) return uncertainExhausted;
        const uncertainWaitingExhausted = maybeReturnObservationExhausted(
          Date.now(),
          softDeadline,
          hardExhaustionDeadline,
          sendCount,
          decision,
          stableReads,
          pollCount,
          messages,
          baselineCount,
          page,
          browser,
          invocationId,
          profileKey,
          navigation,
          incidents,
          journalWriteFailed,
          incident,
          marker,
          ownedPromptEverSeen,
        );
        if (uncertainWaitingExhausted) return uncertainWaitingExhausted;
        emitHeartbeatForPoll(decision);
        await sleep(page, INITIAL_POLL_MS);
        continue;
      }

      uncertainCause = '';
      observedUserHeads = undefined;

      if (decision.state === 'ready' && decision.reply) {
        if (decision.reply.length > bestReadyReply.length) bestReadyReply = decision.reply;
        if (replyStabilityMatches(decision.reply, lastReadyReply)) stableReads++;
        else {
          lastReadyReply = decision.reply;
          stableReads = 1;
        }
        if (stableReads >= 2) {
          if (
            config.newChat
            && ownedConversationUrl
            && !freshClaimOwnerFenceValid(profileKey, ownedConversationUrl, invocationId, config.timeoutMs)
          ) {
            ownershipForfeited = true;
            return returnOwnerFenceLostAfterSend(
              page,
              browser,
              invocationId,
              profileKey,
              sendCount,
              pollCount,
              navigation,
              incidents,
              journalWriteFailed,
              incident,
            );
          }
          const captureReply = bestReadyReply.length >= decision.reply.length ? bestReadyReply : decision.reply;
          const directSettlement = config.directPublication
            ? settleDirectPublication(
              directObservation,
              { ...config.directPublication.target, userMessageId: undefined },
              captureReply,
            )
            : undefined;
          let managerReply = captureReply;
          let reviewerSource = null as ReturnType<typeof reviewerSourceMetadata>;
          if (config.directPublication) {
            if (!directSettlement || directSettlement.state === 'possible-delivery') {
              incident('direct_publication_possible_delivery', directSettlement?.cause ?? 'direct_publication_observation_missing', 'retain_owned_page_no_resend');
              return {
                page,
                browser,
                preserveOwnedPage: true,
                result: compactResult('recovery_required', 'conversation', directSettlement?.cause ?? 'direct_publication_observation_missing', invocationId, profileKey, sendCount, pollCount, navigation, incidents, {}, journalWriteFailed),
              };
            }
            reviewerSource = reviewerSourceMetadata(directSettlement, config.directPublication.target);
            if (!reviewerSource) {
              incident('direct_publication_source_invalid', 'direct_publication_source_revision_or_binding_invalid', 'retain_owned_page_no_resend');
              return {
                page,
                browser,
                preserveOwnedPage: true,
                result: compactResult('recovery_required', 'conversation', 'direct_publication_source_invalid', invocationId, profileKey, sendCount, pollCount, navigation, incidents, {}, journalWriteFailed),
              };
            }
            managerReply = directSettlement.state === 'success'
              ? directPublicationReceipt(directSettlement, config.directPublication.target) ?? ''
              : captureReply;
            if (!managerReply) {
              incident('direct_publication_receipt_invalid', 'direct_publication_receipt_invalid', 'retain_owned_page_no_resend');
              return {
                page,
                browser,
                preserveOwnedPage: true,
                result: compactResult('recovery_required', 'conversation', 'direct_publication_receipt_invalid', invocationId, profileKey, sendCount, pollCount, navigation, incidents, {}, journalWriteFailed),
              };
            }
            const sourcePublication = publishStateLightReply(
              config.directPublication.reviewerSourceOutput,
              invocationId,
              directSettlement.sourceBytes ?? captureReply,
            );
            if (sourcePublication.state !== 'committed_ok') {
              incident('reviewer_source_publication_error', sourcePublication.cause ?? sourcePublication.state, 'retain_owned_page_no_resend');
              return {
                page,
                browser,
                preserveOwnedPage: true,
                result: compactResult('recovery_required', 'conversation', sourcePublication.cause ?? sourcePublication.state, invocationId, profileKey, sendCount, pollCount, navigation, incidents, {}, journalWriteFailed),
              };
            }
          }
          const publication = publishStateLightReply(
            destination.finalPath,
            invocationId,
            managerReply,
          );
          if (publication.state !== 'committed_ok') {
            incident('output_publication_error', publication.cause ?? publication.state, 'return_local_error');
            const publicationState: TurnState = publication.state === 'conflict' ? 'output_conflict' : 'driver_error';
            return {
              page,
              browser,
              result: compactResult(
                publicationState,
                'invocation',
                publication.cause ?? publication.state,
                invocationId,
                profileKey,
                sendCount,
                pollCount, navigation, incidents,
                { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
                journalWriteFailed,
              ),
            };
          }
          return {
            page,
            browser,
            ...(ownedConversationUrl ? { profileKey, ownedConversationUrl } : {}),
            ...(ownershipForfeited ? { ownershipForfeited: true } : {}),
            result: compactResult(
              'ok',
              'none',
              'completed_page_only',
              invocationId,
              profileKey,
              sendCount,
              pollCount, navigation, incidents,
              {
                ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}),
                output: {
                  byte_length: publication.output_bytes!,
                  sha256: publication.output_sha256!,
                },
                ...(reviewerSource ? { reviewer_source: reviewerSource } : {}),
              },
              journalWriteFailed,
            ),
          };
        }
        const readyExhausted = maybeReturnObservationExhausted(
          Date.now(),
          softDeadline,
          hardExhaustionDeadline,
          sendCount,
          decision,
          stableReads,
          pollCount,
          messages,
          baselineCount,
          page,
          browser,
          invocationId,
          profileKey,
          navigation,
          incidents,
          journalWriteFailed,
          incident,
          marker,
          ownedPromptEverSeen,
        );
        if (readyExhausted) return readyExhausted;
        emitHeartbeatForPoll(decision);
        await sleep(page, STABILITY_READ_DELAY_MS);
        continue;
      }

      if (!(completionReadySeen && bestReadyReply.length > 0)) {
        stableReads = 0;
        lastReadyReply = '';
        bestReadyReply = '';
      }
      if (
        !ownershipForfeited
        && (!config.newChat
          || !ownedConversationUrl
          || freshClaimOwnerFenceValid(profileKey, ownedConversationUrl, invocationId, config.timeoutMs))
        && await maybeContinueGeneration(page)
      ) {
        emitHeartbeatForPoll(decision);
        await sleep(page, INITIAL_POLL_MS);
        continue;
      }

      if (
        config.newChat
        && sendCount >= 1
        && Date.now() >= freshConversationLandingDeadline
        && !readProjectConversationUrl(page, config.projectUrl ?? '')
        && !ownedPromptEverSeen
      ) {
        return returnFreshConversationLandingMismatch(
          page,
          browser,
          invocationId,
          profileKey,
          sendCount,
          pollCount,
          navigation,
          incidents,
          journalWriteFailed,
          incident,
        );
      }

      if (Date.now() >= dispatchDeadline) {
        if (!hasOwnedUserMessage(messages, marker)) {
          if (sendCount >= 1) {
            if (!sendObservationDeferredLogged) {
              incident(
                'send_observation_deferred',
                'owned_user_message_not_observed',
                'continue_observing_after_send',
              );
              sendObservationDeferredLogged = true;
            }
          } else {
            incident('send_observation_error', 'owned_user_message_not_observed', 'return_local_error');
            return {
              page,
              browser,
              result: compactResult(
                'send_failed',
                'invocation',
                'owned_user_message_not_observed',
                invocationId,
                profileKey,
                sendCount,
                pollCount, navigation, incidents,
                { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
                journalWriteFailed,
              ),
            };
          }
        }
      }

      const ownedPromptUncertainty = maybeReturnObservationUncertain(
        Date.now(),
        hardExhaustionDeadline,
        sendCount,
        uncertainCause,
        ownedPromptEverSeen,
        observedUserHeads,
        page,
        browser,
        invocationId,
        profileKey,
        sendCount,
        pollCount,
        navigation,
        incidents,
        journalWriteFailed,
        incident,
      );
      if (ownedPromptUncertainty) return ownedPromptUncertainty;

      const waitingExhausted = maybeReturnObservationExhausted(
        Date.now(),
        softDeadline,
        hardExhaustionDeadline,
        sendCount,
        decision,
        stableReads,
        pollCount,
        messages,
        baselineCount,
        page,
        browser,
        invocationId,
        profileKey,
        navigation,
        incidents,
        journalWriteFailed,
        incident,
        marker,
        ownedPromptEverSeen,
      );
      if (waitingExhausted) return waitingExhausted;

      emitHeartbeatForPoll(decision);

      const elapsed = Date.now() - startedAt;
      const delay = completionReadySeen
        ? COMPLETION_CONFIRM_POLL_MS
        : elapsed < DISPATCH_OBSERVATION_MS
          ? INITIAL_POLL_MS
          : POST_SEND_OBSERVATION_POLL_MS;
      const beforeSoftDeadline = Date.now() < softDeadline;
      await sleep(page, beforeSoftDeadline
        ? Math.min(delay, Math.max(1, softDeadline - Date.now()))
        : delay);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isInput = message.startsWith('input_invalid:');
    const isOutput = message.startsWith('output_conflict:');
    const isUi = message.startsWith('ui_contract_mismatch:');
    const state: TurnState = isInput
      ? 'input_invalid'
      : isOutput
        ? 'output_conflict'
        : isUi
          ? 'ui_contract_mismatch'
          : 'driver_error';
    const lostAfterSend = afterSend && browserOrPageDefinitelyLost(page, browser);
    const cause = afterSend
      ? lostAfterSend
        ? 'page_or_browser_lost_after_send'
        : 'helper_error_after_send_page_retained'
      : message;
    if (!isInput && !isOutput) {
      incident(
        afterSend ? 'helper_failure_after_send' : 'helper_failure_before_send',
        cause,
        afterSend
          ? lostAfterSend
            ? 'caller_may_open_fresh_chat'
            : 'retain_owned_page_no_resend'
          : 'return_local_error',
      );
    }
    return {
      ...(page ? { page } : {}),
      ...(browser ? { browser } : {}),
      ...(afterSend && !lostAfterSend ? { preserveOwnedPage: true } : {}),
      result: compactResult(
        state,
        'invocation',
        cause,
        invocationId,
        profileKey,
        sendCount,
        pollCount, navigation, incidents,
        { ...(page && pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
        journalWriteFailed,
      ),
    };
  }
}

async function finalizeTurn(outcome: TurnRunOutcome): Promise<CompactTurnResult> {
  if (outcome.profileKey && outcome.ownedConversationUrl && !outcome.ownershipForfeited) {
    releaseStateLightFreshConversationClaim(
      outcome.profileKey,
      outcome.ownedConversationUrl,
      outcome.result.invocation_id,
    );
  }
  let cleanup: ResourceCleanupOutcome = 'skipped';
  let journalWriteFailed = outcome.result.journal_write_failed === true;
  const incidents = [...outcome.result.incidents];
  if (outcome.page && !outcome.preserveOwnedPage) {
    cleanup = await boundedResourceCleanup(
      () => outcome.page.close(),
      RESOURCE_CLEANUP_BOUND_MS,
    );
    if (cleanup !== 'confirmed') {
      incidents.push('owned_tab_cleanup_failed');
      const cleanupIncident: BrowserIncident = {
        eventClass: 'owned_tab_cleanup_failed',
        symptom: 'owned_tab_close_unconfirmed',
        action: 'leave_sibling_tabs_untouched',
      };
      if (!appendIncident(cleanupIncident, outcome.result.invocation_id)) journalWriteFailed = true;
    }
  }
  await releaseCdpBrowser(outcome.browser);
  return {
    ...outcome.result,
    cleanup,
    incidents,
    ...(journalWriteFailed ? { journal_write_failed: true } : {}),
  };
}

export const __testComposerMutation = {
  remainingComposerMutationMs,
  readComposerReadiness,
  mutateComposerOrCause,
  hasBlockingPageOverlay,
  waitForComposer,
};

export async function runStateLightTurn(argv: readonly string[]): Promise<number> {
  let args: ParsedTurnArgs;
  try {
    args = parseTurnArgs(argv);
  } catch {
    emit({
      schema: 'turn-result/v1',
      state: 'driver_error',
      scope: 'invocation',
      cause: 'argument_invalid',
      invocation_id: randomUUID(),
      configured_profile_key: 'profile-unresolved',
      send_count: 0,
      poll_count: 0,
      goto_count: 0,
      new_chat_click_count: 0,
      navigation_count: 0,
      cleanup: 'skipped',
      incidents: [],
    });
    return 22;
  }

  const result = await finalizeTurn(await runTurn(args));
  emit(result);
  return turnExitCode(result.state);
}
