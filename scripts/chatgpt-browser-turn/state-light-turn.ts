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
  observeDirectPublicationPayloadTree,
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
  admitStateLightTurnObservation,
  bindPrimaryPublication,
  primaryBindingMatches,
  readStateLightTurnObservation,
  transitionStateLightTurnObservation,
} from './state-light-turn-observation.ts';
import {
  ASSISTANT_TURN_ACTION_SELECTOR,
  ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
  classifyProductWall,
  COMPOSER_SELECTOR,
  CONVERSATION_TURN_SECTION_SELECTOR,
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
import {
  recoveryMarkerCardinality,
  runPostSendRecovery,
  type PostSendRecoveryFailure,
  type PostSendRecoveryState,
  type RecoveryObserverEvent,
} from './state-light-turn-recovery.ts';
import {
  buildBrowserTurnCancellationReceipt,
  isSupportedChatGptConversationUrl,
  readRecoveryAuthoritativeUserMessages,
  stopOwnedGeneration,
  type StopOwnedGenerationOutcome,
} from './state-light-cancellation.ts';

export { stopOwnedGeneration };
export type { StopOwnedGenerationOutcome };

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
/** Exact generation selector already owned by browser-gpt-page-probe; do not widen it here. */
const BROWSER_GPT_PAGE_TURN_GENERATION_SELECTOR = '[data-testid="stop-button"], button[aria-label*="Stop"], [aria-busy="true"], [data-is-streaming="true"], [data-testid*="tool"][data-state="running"], [data-testid*="tool"][data-state="loading"]';
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

export interface ParsedTurnArgs {
  readonly options: Map<string, string | true>;
}

interface PageMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  /** Canonical observable carrier key; never synthesized from position or text. */
  readonly key?: string;
  readonly fingerprint?: string;
}

export interface AtomicTranscriptCarrier extends PageMessage {
  readonly domIndex: number;
  readonly fingerprint: string;
}

export interface AtomicTranscriptSnapshot {
  readonly complete: boolean;
  readonly carriers: readonly AtomicTranscriptCarrier[];
}

export interface BrowserGptPageTurnEvidence {
  readonly generationInProgress: boolean | 'unknown';
  readonly observedAssistantNodes: number;
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
  readonly snapshot?: AtomicTranscriptSnapshot;
  readonly pageTurnEvidence?: BrowserGptPageTurnEvidence;
}

export type BrowserGptPageTurnStatus = 'dead' | 'long_running' | 'completed' | 'unknown';

/**
 * Issue #1386's amended discriminator consumes the producer's tri-state
 * generation observation plus an assistant count scoped by the consumer to
 * the current owned user carrier. Unknown generation evidence never authorizes
 * a dead-turn conclusion.
 */
export function classifyBrowserGptPageTurnStatus(
  generationInProgress: boolean | 'unknown',
  observedAssistantNodes: number,
): BrowserGptPageTurnStatus {
  if (generationInProgress === true) return 'long_running';
  if (generationInProgress !== false) return 'unknown';
  if (observedAssistantNodes === 0) return 'dead';
  if (Number.isSafeInteger(observedAssistantNodes) && observedAssistantNodes > 0) return 'completed';
  return 'unknown';
}

export type PageLiveness = 'live' | 'lost' | 'unknown';

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

export interface TurnRunOutcome {
  readonly result: Omit<CompactTurnResult, 'cleanup'>;
  readonly page?: any;
  readonly browser?: any;
  /** Process-local publication fact; not part of turn-result/v1. */
  readonly publicationState?: StateLightPublicationResult['state'];
  readonly cleanupAction?: PageCleanupAction;
  /** Exact owned page observation; never cancellation authority by itself. */
  readonly stopAuthorityPage?: any;
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

interface StateLightPublicationHooks {
  readonly beforeFinalLink?: () => void;
  readonly afterFinalLink?: () => void;
}

export type PageCleanupAction = 'close' | 'preserve' | 'skip';

const cleanupAuthorityUnprovenPages = new WeakSet<object>();

export interface StateLightRecoveryHooks {
  readonly observer?: (event: RecoveryObserverEvent) => void;
  readonly faultActuator?: (input: {
    readonly page: unknown;
    readonly browser: unknown;
    readonly sendCount: number;
    readonly conversationUrlSha256: string;
    readonly markerSha256: string;
    readonly matchingUserCarrierCount: number;
    readonly exactMarkerTokenCount: number;
  }) => Promise<void> | void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export function decidePageCleanupAction(input: {
  readonly sendCount: number;
  readonly publicationState?: StateLightPublicationResult['state'];
  readonly pagePresent: boolean;
  readonly pageLost: boolean;
}): PageCleanupAction {
  if (!input.pagePresent || input.pageLost) return 'skip';
  if (input.sendCount >= 1 && input.publicationState !== 'committed_ok') return 'preserve';
  return 'close';
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

function transcriptFingerprint(role: PageMessage['role'], text: string): string {
  return createHash('sha256').update(`${role}\u0000${normalizeVisibleText(text)}`, 'utf8').digest('hex');
}

function validCarrierKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8;
}

async function boundedBrowserRead<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutCause: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutCause)), timeoutMs);
    });
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function atomicSnapshotSignature(snapshot: AtomicTranscriptSnapshot): string {
  return snapshot.carriers
    .map((carrier) => `${carrier.role}\u0000${carrier.fingerprint}\u0000${carrier.key ?? ''}`)
    .join('\u0001');
}

export function snapshotOwnedCarrier(
  snapshot: AtomicTranscriptSnapshot,
  marker: string,
): AtomicTranscriptCarrier | undefined {
  if (!snapshot.complete) return undefined;
  const matches = snapshot.carriers.filter((carrier) => (
    carrier.role === 'user' && ownedPromptMatches(carrier.text, marker)
  ));
  if (matches.length !== 1) return undefined;
  const owned = matches[0];
  if (!owned?.key) return undefined;
  const keyMatches = snapshot.carriers.filter((carrier) => carrier.key === owned.key);
  if (keyMatches.length !== 1 || keyMatches[0] !== owned || keyMatches[0].role !== 'user') return undefined;
  return owned;
}

/** Count assistants only in the current owned turn, never in page history. */
export function countAssistantNodesAfterOwnedCarrier(
  snapshot: AtomicTranscriptSnapshot,
  ownedUserKey: string,
): number | undefined {
  if (!snapshot.complete || !validCarrierKey(ownedUserKey)) return undefined;
  const ownedMatches = snapshot.carriers
    .map((carrier, index) => ({ carrier, index }))
    .filter(({ carrier }) => carrier.role === 'user' && carrier.key === ownedUserKey);
  if (ownedMatches.length !== 1) return undefined;
  const afterOwned = snapshot.carriers.slice(ownedMatches[0]!.index + 1);
  const nextUserOffset = afterOwned.findIndex((carrier) => carrier.role === 'user');
  const ownedTurn = nextUserOffset >= 0 ? afterOwned.slice(0, nextUserOffset) : afterOwned;
  return ownedTurn.filter((carrier) => carrier.role === 'assistant').length;
}

export function keyedHarvestCandidate(
  snapshot: AtomicTranscriptSnapshot,
  baseline: AtomicTranscriptSnapshot | undefined,
  ownedUserKey: string,
): { state: 'ready'; reply: string; assistantKey: string } | { state: 'waiting' | 'uncertain'; cause?: string } {
  const currentAssistantCount = countAssistantNodesAfterOwnedCarrier(snapshot, ownedUserKey);
  if (currentAssistantCount === undefined) return { state: 'uncertain', cause: 'owned_carrier_unproven' };
  if (currentAssistantCount === 0) return { state: 'waiting' };
  const ownedUserIndex = snapshot.carriers.findIndex(
    (carrier) => carrier.role === 'user' && carrier.key === ownedUserKey,
  );
  const afterOwned = snapshot.carriers.slice(ownedUserIndex + 1);
  const nextUserOffset = afterOwned.findIndex((carrier) => carrier.role === 'user');
  const ownedTurn = nextUserOffset >= 0 ? afterOwned.slice(0, nextUserOffset) : afterOwned;
  const assistants = ownedTurn.filter((carrier) => carrier.role === 'assistant');
  const candidate = assistants.at(-1);
  if (!candidate?.key) return { state: 'uncertain', cause: 'assistant_carrier_unproven' };
  if (baseline?.complete) {
    const baselineKeys = new Set(baseline.carriers.map((carrier) => carrier.key).filter(Boolean));
    if (baselineKeys.has(candidate.key)) return { state: 'uncertain', cause: 'assistant_not_new' };
  }
  const reply = normalizeVisibleText(candidate.text);
  return reply ? { state: 'ready', reply, assistantKey: candidate.key } : { state: 'waiting' };
}

function boundedDiagnosticHead(value: string): string {
  return collapseUnicodeWhitespace(value).slice(0, DIAGNOSTIC_HEAD_CHARS);
}

export function ownedPromptMatches(messageText: string, expectedMarker: string): boolean {
  return ownedPromptMarkerMatches(messageText, expectedMarker);
}

function hasOwnedUserMessage(messages: readonly PageMessage[], marker: string): boolean {
  return messages.some((message) => message.role === 'user' && ownedPromptMatches(message.text, marker));
}

export function buildObservationHeartbeat(input: {
  pollCount: number;
  observationState: string;
  stableReads: number;
  completionReady: boolean;
  lastReply: string;
}): ObservationHeartbeat {
  const digest = input.lastReply
    ? createHash('sha256').update(input.lastReply, 'utf8').digest('hex').slice(0, 16)
    : '';
  return {
    schema: 'observation-heartbeat/v1',
    poll_count: input.pollCount,
    observation_state: input.observationState,
    stable_reads: input.stableReads,
    completion_ready: input.completionReady,
    last_reply_length: input.lastReply.length,
    last_reply_sha256_head: digest,
  };
}

export function replyStabilityFingerprint(reply: string): string {
  return createHash('sha256').update(reply, 'utf8').digest('hex');
}

export function replyStabilityMatches(left: string, right: string): boolean {
  return left.length === right.length && replyStabilityFingerprint(left) === replyStabilityFingerprint(right);
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
  _invocationId: string,
  reply: string,
  hooks: StateLightPublicationHooks = {},
): StateLightPublicationResult {
  const finalPath = resolve(outputPath);
  const parent = dirname(finalPath);
  const tempPath = join(parent, `.${basename(finalPath)}.${randomUUID()}.tmp`);
  let fd = -1;

  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, reply, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;

    hooks.beforeFinalLink?.();
    linkSync(tempPath, finalPath);
    hooks.afterFinalLink?.();

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
      try {
        const existing = readFileSync(finalPath);
        const expected = Buffer.from(reply, 'utf8');
        if (existing.byteLength === expected.byteLength
          && createHash('sha256').update(existing).digest('hex') === createHash('sha256').update(expected).digest('hex')) {
          return {
            state: 'committed_ok',
            output_bytes: existing.byteLength,
            output_sha256: createHash('sha256').update(existing).digest('hex'),
          };
        }
      } catch {
        // Fall through to conflict; equality is convergence, not producer authority.
      }
      return { state: 'conflict', cause: 'output_exists' };
    }
    const detail = errnoCode(error) ?? (error instanceof Error ? error.message : String(error));
    return { state: 'error', cause: `output_write_failed:${detail}` };
  }
}

export const __testPublishStateLightReply = publishStateLightReply;

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
  const cardinality = recoveryMarkerCardinality(messages, expectedMarker);
  if (
    cardinality.matchingUserCarrierCount !== 1
    || cardinality.exactMarkerTokenCount !== 1
  ) {
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
    observeDirectPublicationPayloadTree(state, payload);
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
    const issue = String(env.CREATE_ISSUE_DRAFT_ISSUE ?? '').trim();
    const pr = String(env.PACK_REVIEW_PR_NUMBER ?? '').trim();
    const agent = String(env.OPK_AGENT ?? env.PACK_FLOW_MANAGER ?? process.title ?? 'node').trim();
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
  try {
    return String(await locator.innerText({ timeout: timeoutMs }) ?? '');
  } catch {
    return '';
  }
}

async function readAttributeWithRetries(
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
  strictTranscriptCount = false,
): Promise<PageObservationResult> {
  const nodes = page.locator(MESSAGE_NODE_SELECTOR);
  const incomplete = (): PageObservationResult => ({
    messages: [],
    ownedWindowCompletionReady: false,
    transcriptIncomplete: true,
    snapshot: { complete: false, carriers: [] },
  });

  let carriers: AtomicTranscriptCarrier[] = [];
  let transcriptIncomplete = false;
  let pageTurnEvidence: BrowserGptPageTurnEvidence | undefined;
  const evaluateAll = nodes?.evaluateAll;
  if (typeof evaluateAll === 'function') {
    try {
      const observed = await boundedBrowserRead(
        evaluateAll.call(nodes, (elements: Element[], args: {
          roleAttribute: string;
          generationSelector: string;
        }) => {
          const valid = (value: string | null): value is string => Boolean(value && value.length >= 8);
          const canonicalKey = (element: Element): string | undefined => {
            for (const attribute of ['data-message-id', 'data-turn-id']) {
              const direct = element.getAttribute(attribute);
              if (valid(direct)) return `${attribute}:${direct}`;
              const descendants = Array.from(element.querySelectorAll(`[${attribute}]`));
              const descendant = descendants.find((candidate) => valid(candidate.getAttribute(attribute)));
              const value = descendant?.getAttribute(attribute) ?? null;
              if (valid(value)) return `${attribute}:${value}`;
            }
            return undefined;
          };
          const rows: Array<{ role: string; text: string; key?: string; domIndex: number; complete: boolean }> = [];
          let observedAssistantNodes = 0;
          let observedMessageNodes = 0;
          for (let domIndex = 0; domIndex < elements.length; domIndex++) {
            const element = elements[domIndex]!;
            try {
              const role = element.getAttribute(args.roleAttribute) ?? '';
              if (role === 'user' || role === 'assistant') {
                observedMessageNodes += 1;
                if (role === 'assistant') observedAssistantNodes += 1;
              }
              const text = (element as HTMLElement).innerText;
              rows.push({ role, text, key: canonicalKey(element), domIndex, complete: true });
            } catch {
              rows.push({ role: '', text: '', domIndex, complete: false });
            }
          }
          let generationInProgress: boolean | 'unknown' = 'unknown';
          try {
            generationInProgress = Boolean(document.querySelector(args.generationSelector));
          } catch {
            generationInProgress = 'unknown';
          }
          return {
            rows,
            pageTurnEvidence: observedMessageNodes > 0
              ? { generationInProgress, observedAssistantNodes }
              : undefined,
          };
        }, {
          roleAttribute: MESSAGE_AUTHOR_ROLE_ATTR,
          generationSelector: BROWSER_GPT_PAGE_TURN_GENERATION_SELECTOR,
        }),
        MAX_LOCAL_READ_WAIT_MS,
        'atomic_transcript_snapshot_timeout',
      ) as {
        rows: Array<{ role: string; text: string; key?: string; domIndex: number; complete: boolean }>;
        pageTurnEvidence?: BrowserGptPageTurnEvidence;
      };
      pageTurnEvidence = observed.pageTurnEvidence;
      for (const row of observed.rows) {
        if (!row.complete || (row.role !== 'user' && row.role !== 'assistant')) {
          if (row.role === 'user' || row.role === 'assistant') transcriptIncomplete = true;
          continue;
        }
        carriers.push({
          role: row.role,
          text: row.text,
          ...(row.key ? { key: row.key } : {}),
          domIndex: row.domIndex,
          fingerprint: transcriptFingerprint(row.role, row.text),
        });
      }
    } catch {
      transcriptIncomplete = true;
    }
  } else {
    let count = 0;
    try {
      count = Number(await nodes.count());
    } catch {
      return incomplete();
    }
    for (let index = 0; index < count; index++) {
      const node = nodes.nth(index);
      const role = await readAttributeWithRetries(node, MESSAGE_AUTHOR_ROLE_ATTR, [800, 400]);
      if (role !== 'user' && role !== 'assistant') continue;
      const textResult = await readMessageNodeText(node);
      if (textResult.readFailed) {
        transcriptIncomplete = true;
        continue;
      }
      const key = await readAttributeWithRetries(node, 'data-message-id', [800, 400]);
      carriers.push({
        role,
        text: textResult.text,
        ...(key && key.length >= 8 ? { key: `data-message-id:${key}` } : {}),
        domIndex: index,
        fingerprint: transcriptFingerprint(role, textResult.text),
      });
    }
  }

  carriers = carriers.sort((left, right) => left.domIndex - right.domIndex);
  const messages: PageMessage[] = carriers.map((carrier) => ({
    role: carrier.role,
    text: carrier.text,
    ...(carrier.key ? { key: carrier.key } : {}),
    fingerprint: carrier.fingerprint,
  }));
  const snapshot: AtomicTranscriptSnapshot = { complete: !transcriptIncomplete, carriers };
  if (strictTranscriptCount && baselineCount !== undefined && messages.length < baselineCount) {
    transcriptIncomplete = true;
  }

  let ownedWindowCompletionReady = false;
  if (expectedMarker && !transcriptIncomplete) {
    const ownedCarrier = snapshotOwnedCarrier(snapshot, expectedMarker);
    if (ownedCarrier?.key) {
      const count = countAssistantNodesAfterOwnedCarrier(snapshot, ownedCarrier.key);
      if (count && count > 0) {
        try {
          ownedWindowCompletionReady = await readAssistantTurnCompletionReady(page);
        } catch {
          ownedWindowCompletionReady = false;
        }
      }
    }
  }
  return {
    messages,
    ownedWindowCompletionReady,
    transcriptIncomplete,
    snapshot: { ...snapshot, complete: !transcriptIncomplete },
    ...(pageTurnEvidence ? { pageTurnEvidence } : {}),
  };
}

async function readPostSendObservation(
  page: any,
  expectedMarker: string,
  baselineCount: number,
): Promise<PageObservationResult & { wall: ReturnType<typeof classifyProductWall>; snapshot: AtomicTranscriptSnapshot }> {
  const {
    messages,
    ownedWindowCompletionReady,
    transcriptIncomplete,
    snapshot,
    pageTurnEvidence,
  } = await readPageObservation(
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
  return {
    messages,
    wall,
    ...(pageTurnEvidence ? { pageTurnEvidence } : {}),
    ownedWindowCompletionReady,
    transcriptIncomplete,
    snapshot: snapshot!,
  };
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
    return { matched: false, targetUuid };
  }
  const pageUuid = conversationUuidFromUrl(pageUrl);
  if (targetUuid && pageUuid) return { matched: targetUuid === pageUuid, targetUuid, pageUuid, pageUrl };
  return { matched: normalizeConversationUrl(pageUrl) === normalizeConversationUrl(targetChatUrl), targetUuid, pageUuid, pageUrl };
}

function pageConversationUrl(page: any): string | undefined {
  try {
    const url = normalizeConversationUrl(String(page.url()));
    return isSupportedChatGptConversationUrl(url) ? url : undefined;
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

async function runTurn(
  args: ParsedTurnArgs,
  recoveryHooks: StateLightRecoveryHooks = {},
): Promise<TurnRunOutcome> {
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
  const invocationId = requireOption(args, 'invocation-id');
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
  let cancellationReceiptEmitted = false;

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

    const marker = generateOwnedPromptMarker();
    admitStateLightTurnObservation({ profileKey, invocationId, marker });
    const admitted = readStateLightTurnObservation(profileKey, invocationId);
    if (admitted.phase !== 'prepared' || admitted.marker !== marker) {
      throw new Error('input_invalid:observation_admission_failed');
    }

    const profile = await verifyProfile(config);
    if (profile.state !== 'verified') {
      const state: TurnState = profile.state === 'unavailable' ? 'chrome_not_running' : 'profile_mismatch';
      incident('invocation_blocker', profile.cause, 'return_local_error');
      transitionStateLightTurnObservation({
        profileKey,
        invocationId,
        phase: 'not_sent',
        reason: profile.cause,
        sendCount: 0,
        sendWitness: 'numeric_send_count',
      });
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
    let baselineSnapshot: AtomicTranscriptSnapshot | undefined;
    let ownedConversationUrl: string | undefined;

    const returnComposerMutationFailure = (
      cause: PreSendComposerFailureCause,
    ): TurnRunOutcome => {
      transitionStateLightTurnObservation({
        profileKey,
        invocationId,
        phase: 'not_sent',
        reason: cause,
        sendCount: 0,
        sendWitness: 'numeric_send_count',
      });
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

    const captureBaseline = async (): Promise<TurnRunOutcome | null> => {
      const baseline = await readPageObservation(page, undefined, undefined, true);
      if (baseline.transcriptIncomplete || !baseline.snapshot?.complete) {
        transitionStateLightTurnObservation({
          profileKey,
          invocationId,
          phase: 'not_sent',
          reason: 'baseline_transcript_incomplete',
          sendCount: 0,
          sendWitness: 'numeric_send_count',
        });
        incident('pre_send_observation_error', 'baseline_transcript_incomplete', 'return_local_error');
        return {
          page,
          browser,
          result: compactResult(
            'ui_contract_mismatch',
            'invocation',
            'baseline_transcript_incomplete',
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
      baselineSnapshot = baseline.snapshot!;
      baselineCount = baseline.messages.length;
      return null;
    };

    const markedPayload = wrapOwnedPromptPayload(marker, snapshot.text);

    const emitCancellationReceipt = (conversationUrl: string): void => {
      if (cancellationReceiptEmitted || sendCount !== 1) return;
      const receipt = buildBrowserTurnCancellationReceipt({
        invocationId,
        profileKey,
        conversationUrl,
        marker,
        sendCount,
      });
      if (!receipt) return;
      emit(receipt);
      cancellationReceiptEmitted = true;
    };

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
      if (remainingMs <= 0) return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      if (!(await readComposerReadiness(page, insertionDeadlineMs))) {
        return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      }
      remainingMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
      if (remainingMs <= 0) return returnComposerMutationFailure('composer_mutation_budget_exhausted');
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

      transitionStateLightTurnObservation({
        profileKey,
        invocationId,
        phase: 'dispatching',
        reason: 'immediately_before_submit',
      });
      if (hasSendButton) {
        await sendButton.click({ timeout: MAX_LOCAL_READ_WAIT_MS });
      } else {
        await composer.press('Enter', { timeout: MAX_LOCAL_READ_WAIT_MS });
      }
      sendCount += 1;
      afterSend = true;
      transitionStateLightTurnObservation({
        profileKey,
        invocationId,
        phase: config.newChat ? 'sent_unbound' : 'sent_unharvested',
        reason: 'numeric_send_count_observed',
        sendCount,
        sendWitness: 'numeric_send_count',
        ...(!config.newChat && config.chatUrl
          ? { conversationUrl: normalizeConversationUrl(config.chatUrl) }
          : {}),
      });
      if (!config.newChat && config.chatUrl) {
        emitCancellationReceipt(normalizeConversationUrl(config.chatUrl));
      }
      return null;
    };

    if (config.newChat) {
      await acquireStateLightNewChatSendSlot(profileKey, invocationId, config.timeoutMs);
      try {
        const returnFreshPrepareFailure = (
          prepared: Awaited<ReturnType<typeof prepareStateLightFreshConversation>>,
        ): TurnRunOutcome | null => {
          if (prepared.state === 'ready') return null;
          transitionStateLightTurnObservation({
            profileKey,
            invocationId,
            phase: 'not_sent',
            reason: prepared.cause,
            sendCount: 0,
            sendWitness: 'numeric_send_count',
          });
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
          transitionStateLightTurnObservation({
            profileKey,
            invocationId,
            phase: 'not_sent',
            reason: composerState.cause,
            sendCount: 0,
            sendWitness: 'numeric_send_count',
          });
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
            const baselineFailure = await captureBaseline();
            if (baselineFailure) return baselineFailure;
            const sendFailure = await sendOwnedPrompt();
            if (sendFailure) return sendFailure;
            sendAuthorized = false;
          }

          const urlDeadline = Date.now() + Math.min(30_000, config.timeoutMs);
          let conversationUrl: string | undefined;
          try {
            conversationUrl = await waitForConversationUrlAfterSend(
              page,
              config.projectUrl!,
              urlDeadline,
              sleep,
              INITIAL_POLL_MS,
            );
          } catch (error) {
            if (!browserOrPageDefinitelyLost(page, browser)) throw error;
            incident(
              'send_observation_deferred',
              'fresh_conversation_page_lost_after_send',
              'recover_same_conversation_no_resend',
            );
            claimed = true;
            break;
          }
          if (!conversationUrl) {
            if (sendCount >= 1) {
              const landingEvidence = await classifySendLandingEvidence(
                page,
                markedPayload,
                lastAttemptConversationUrl,
              );
              if (landingEvidence === 'not_landed' && !pageConversationUrl(page)) {
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
          transitionStateLightTurnObservation({
            profileKey,
            invocationId,
            phase: 'sent_unharvested',
            reason: 'fresh_conversation_url_bound',
            sendCount,
            sendWitness: 'numeric_send_count',
            conversationUrl,
          });

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
          }
          ownedConversationUrl = conversationUrl;
          emitCancellationReceipt(conversationUrl);
          claimed = true;
        }
      } finally {
        releaseStateLightNewChatSendSlot(profileKey, invocationId);
      }
    } else {
      const baselineFailure = await captureBaseline();
      if (baselineFailure) return baselineFailure;
      const sendFailure = await sendOwnedPrompt();
      if (sendFailure) return sendFailure;
      ownedConversationUrl = normalizeConversationUrl(config.chatUrl!);
    }

    const startedAt = Date.now();
    const softDeadline = startedAt + config.timeoutMs;
    const hardExhaustionDeadline = startedAt + (config.timeoutMs * 2);
    const dispatchDeadline = startedAt + DISPATCH_OBSERVATION_MS;
    const freshConversationLandingDeadline = startedAt + FRESH_CONVERSATION_LANDING_MS;
    let stableReads = 0;
    let lastReadyReply = '';
    let bestReadyReply = '';
    let completionReadySeen = false;
    let ownedPromptEverSeen = false;
    let ownedCarrierKey: string | undefined;
    let uncertainCause = 'owned_carrier_unproven';
    let observedUserHeads: string[] = [];
    let sendObservationDeferredLogged = false;
    let lastHeartbeatAt = startedAt;
    let lastHeartbeatPoll = 0;

    const emitHeartbeatForPoll = (decision: PageObservationDecision): void => {
      const now = Date.now();
      if ((now - lastHeartbeatAt) < OBSERVATION_HEARTBEAT_MS
        && (pollCount - lastHeartbeatPoll) < OBSERVATION_HEARTBEAT_POLL_INTERVAL) return;
      const lastReply = decision.state === 'ready' ? decision.reply ?? '' : bestReadyReply;
      emit(buildObservationHeartbeat({
        pollCount,
        observationState: decision.state,
        stableReads,
        completionReady: completionReadySeen,
        lastReply,
      }));
      lastHeartbeatAt = now;
      lastHeartbeatPoll = pollCount;
    };

    const recoveryState: PostSendRecoveryState = {
      immutableConversationUrl: ownedConversationUrl,
      marker,
      sendCount,
      attempts: 0,
    };

    const recoverCurrentObservation = async (): Promise<TurnRunOutcome | null> => {
      const recovered = await runPostSendRecovery({
        state: recoveryState,
        page,
        browser,
        hardDeadlineMs: hardExhaustionDeadline,
        observer: recoveryHooks.observer,
        faultActuator: recoveryHooks.faultActuator,
        dependencies: {
          normalizeConversationUrl,
          listPages: async (activeBrowser) => {
            const contexts = typeof (activeBrowser as any)?.contexts === 'function'
              ? (activeBrowser as any).contexts()
              : [];
            return contexts.flatMap((context: any) => typeof context.pages === 'function' ? context.pages() : []);
          },
          findConversationPage: async (activeBrowser, immutableConversationUrl) => {
            const contexts = typeof (activeBrowser as any)?.contexts === 'function'
              ? (activeBrowser as any).contexts()
              : [];
            const pages = contexts.flatMap((context: any) => typeof context.pages === 'function' ? context.pages() : []);
            const targetUrl = normalizeConversationUrl(immutableConversationUrl);
            return pages.find((candidate: any) => {
              try {
                return normalizeConversationUrl(String(candidate.url())) === targetUrl;
              } catch {
                return false;
              }
            });
          },
          pageUrl: (candidate) => String((candidate as any).url()),
          normalizeConversationUrl,
          isSupportedConversationUrl: isSupportedChatGptConversationUrl,
          readAuthoritativeMessages: readRecoveryAuthoritativeUserMessages,
          browserDefinitelyDisconnected: (candidateBrowser) => {
            try {
              return typeof (candidateBrowser as any)?.isConnected === 'function'
                && (candidateBrowser as any).isConnected() === false;
            } catch {
              return false;
            }
          },
          pageDefinitelyLost: (candidatePage) => {
            try {
              return typeof (candidatePage as any)?.isClosed === 'function'
                && (candidatePage as any).isClosed() === true;
            } catch {
              return false;
            }
          },
          reconnect: async () => {
            const remainingMs = Math.max(1, hardExhaustionDeadline - Date.now());
            return await chromium.connectOverCDP(config.cdp, {
              timeout: Math.min(30_000, remainingMs),
            });
          },
          createSuccessor: async (activeBrowser, immutableConversationUrl) => {
            const successor = await createDedicatedTurnPage(activeBrowser);
            navigation.recordGoto();
            await successor.goto(immutableConversationUrl, {
              waitUntil: 'domcontentloaded',
              timeout: Math.min(
                MAX_LOCAL_READ_WAIT_MS * 6,
                Math.max(1, hardExhaustionDeadline - Date.now()),
              ),
            });
            return successor;
          },
          sleep: recoveryHooks.sleep ?? (async (milliseconds) => {
            await sleep(page, milliseconds);
          }),
          now: () => Date.now(),
        },
      });

      browser = recovered.browser;
      if (recovered.kind === 'failure') return recoveryFailureOutcome(recovered);

      if (config.newChat && !ownedConversationUrl) {
        transitionStateLightTurnObservation({
          profileKey,
          invocationId,
          phase: 'sent_unharvested',
          reason: 'recovery_bound_conversation_url',
          sendWitness: 'owned_marker',
          conversationUrl: recovered.conversationUrl,
        });
        let claim: ReturnType<typeof tryClaimStateLightFreshConversation>;
        try {
          claim = tryClaimStateLightFreshConversation(
            profileKey,
            recovered.conversationUrl,
            invocationId,
            config.timeoutMs,
          );
        } catch {
          claim = 'contended';
        }
        if (claim === 'contended') {
          ownershipForfeited = true;
          incident(
            'ownership_fence_lost',
            'state_light_recovered_conversation_claim_contended',
            'retain_owned_page_no_resend',
          );
          return {
            page: recovered.page,
            browser,
            ownershipForfeited: true,
            cleanupAction: 'preserve',
            result: compactResult(
              'driver_error',
              'invocation',
              'state_light_recovered_conversation_claim_contended',
              invocationId,
              profileKey,
              sendCount,
              pollCount,
              navigation,
              incidents,
              { conversation_id: recovered.conversationUrl },
              journalWriteFailed,
            ),
          };
        }
        ownedConversationUrl = recovered.conversationUrl;
        emitCancellationReceipt(recovered.conversationUrl);
      }

      page = recovered.page;
      if (!recovered.cleanupOwned && page && typeof page === 'object') {
        cleanupAuthorityUnprovenPages.add(page);
      }
      recoveryState.immutableConversationUrl = recovered.conversationUrl;
      if (config.directPublication) installDirectPublicationObserver(page, directObservation);
      baselineSnapshot = undefined;
      baselineCount = 0;
      return null;
    };

    while (true) {
      if (sendCount >= 1 && browserOrPageDefinitelyLost(page, browser)) {
        const terminal = await recoverCurrentObservation();
        if (terminal) return terminal;
        continue;
      }
      pollCount++;
      if (config.newChat && sendCount >= 1) {
        const observedConversationUrl = readProjectConversationUrl(page, config.projectUrl ?? '');
        if (observedConversationUrl) {
          if (!ownedConversationUrl) {
            ownedConversationUrl = observedConversationUrl;
            transitionStateLightTurnObservation({
              profileKey,
              invocationId,
              phase: 'sent_unharvested',
              reason: 'fresh_conversation_url_bound_during_poll',
              sendCount,
              sendWitness: 'numeric_send_count',
              conversationUrl: observedConversationUrl,
            });
          }
          recoveryState.immutableConversationUrl = observedConversationUrl;
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
        if (browserOrPageDefinitelyLost(page, browser)) {
          const terminal = await recoverCurrentObservation();
          if (terminal) return terminal;
          continue;
        }
        const symptom = error instanceof Error ? error.message : String(error);
        incident('post_send_observation_error', symptom, 'continue_polling_owned_page');
        if (!(completionReadySeen && bestReadyReply.length > 0)) {
          stableReads = 0;
          lastReadyReply = '';
          bestReadyReply = '';
        }
        uncertainCause = ownedCarrierKey
          ? 'transcript_continuity_unproven'
          : 'owned_carrier_unproven';
        emitHeartbeatForPoll({ state: 'waiting' });
        await sleep(page, INITIAL_POLL_MS);
        continue;
      }

      const {
        messages,
        wall,
        pageTurnEvidence,
        ownedWindowCompletionReady,
        transcriptIncomplete,
        snapshot: transcriptSnapshot,
      } = observation;
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
        emitHeartbeatForPoll({ state: 'waiting' });
        await sleep(page, INITIAL_POLL_MS);
        continue;
      }

      const carrier = snapshotOwnedCarrier(transcriptSnapshot, marker);
      if (carrier?.key) {
        ownedPromptEverSeen = true;
        ownedCarrierKey = carrier.key;
      }
      observedUserHeads = messages
        .filter((message) => message.role === 'user')
        .map((message) => boundedDiagnosticHead(message.text));

      const generationInProgress = pageTurnEvidence?.generationInProgress ?? 'unknown';
      const assistantsAfterOwned = ownedCarrierKey
        ? countAssistantNodesAfterOwnedCarrier(transcriptSnapshot, ownedCarrierKey)
        : undefined;
      const pageStatus = assistantsAfterOwned === undefined
        ? 'unknown'
        : classifyBrowserGptPageTurnStatus(generationInProgress, assistantsAfterOwned);

      if (pageStatus === 'long_running' || pageStatus === 'unknown') {
        emitHeartbeatForPoll({ state: 'waiting' });
        await sleep(page, INITIAL_POLL_MS);
        continue;
      }

      const decision = classifyPageObservation(
        messages,
        baselineCount,
        marker,
        pageStatus !== 'completed',
      );
      if (decision.state === 'ready' && decision.reply) {
        if (lastReadyReply && replyStabilityMatches(lastReadyReply, decision.reply)) stableReads += 1;
        else stableReads = 1;
        lastReadyReply = decision.reply;
        bestReadyReply = decision.reply;
        if (stableReads >= 2 && completionReadySeen) {
          let managerReply = bestReadyReply;
          let reviewerSource: ReturnType<typeof reviewerSourceMetadata> | undefined;
          if (config.directPublication) {
            const directSettlement = settleDirectPublication(
              directObservation,
              config.directPublication.target,
              bestReadyReply,
            );
            reviewerSource = reviewerSourceMetadata(directSettlement);
            const captureReply = bestReadyReply;
            managerReply = directSettlement.state === 'success'
              ? directPublicationReceipt(directSettlement, config.directPublication.target) ?? ''
              : captureReply;
            if (!managerReply) {
              incident('direct_publication_receipt_invalid', 'direct_publication_receipt_invalid', 'retain_owned_page_no_resend');
              return {
                page,
                browser,
                cleanupAction: 'preserve',
                result: compactResult('recovery_required', 'conversation', 'direct_publication_receipt_invalid', invocationId, profileKey, sendCount, pollCount, navigation, incidents, {}, journalWriteFailed),
              };
            }
          }

          const bound = bindPrimaryPublication({
            profileKey,
            invocationId,
            target: destination.finalPath,
            bytes: managerReply,
          });
          if (!primaryBindingMatches(bound, destination.finalPath, managerReply)) {
            throw new Error('output_conflict:primary_binding_conflict');
          }

          if (config.directPublication) {
            const directSettlement = settleDirectPublication(
              directObservation,
              config.directPublication.target,
              bestReadyReply,
            );
            const sourcePublication = publishStateLightReply(
              config.directPublication.reviewerSourceOutput,
              invocationId,
              directSettlement.sourceBytes ?? bestReadyReply,
            );
            if (sourcePublication.state !== 'committed_ok') {
              incident('reviewer_source_publication_error', sourcePublication.cause ?? sourcePublication.state, 'retain_owned_page_no_resend');
              return {
                page,
                browser,
                publicationState: sourcePublication.state,
                cleanupAction: 'close',
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
              publicationState: publication.state,
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
          transitionStateLightTurnObservation({
            profileKey,
            invocationId,
            phase: 'harvested',
            reason: 'primary_publication_converged',
            sendCount,
            sendWitness: 'numeric_send_count',
            ...(ownedConversationUrl ? { conversationUrl: ownedConversationUrl } : {}),
          });
          return {
            page,
            browser,
            publicationState: publication.state,
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
        emitHeartbeatForPoll(decision);
        await sleep(page, STABILITY_READ_DELAY_MS);
        continue;
      }

      emitHeartbeatForPoll(decision);
      await sleep(page, INITIAL_POLL_MS);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isInput = message.startsWith('input_invalid:') || message.startsWith('argument_');
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
    if (!afterSend && profileKey !== 'profile-unresolved') {
      try {
        transitionStateLightTurnObservation({
          profileKey,
          invocationId,
          phase: 'not_sent',
          reason: cause,
          sendCount: 0,
          sendWitness: 'numeric_send_count',
        });
      } catch {
        // The original failure remains authoritative.
      }
    }
    if (!isInput && !isOutput) {
      incident(
        afterSend ? 'helper_failure_after_send' : 'helper_failure_before_send',
        cause,
        afterSend
          ? lostAfterSend
            ? 'skip_lost_page_no_resend'
            : 'retain_owned_page_no_resend'
          : 'return_local_error',
      );
    }
    return {
      ...(page ? { page } : {}),
      ...(browser ? { browser } : {}),
      ...(lostAfterSend ? { cleanupAction: 'skip' as const } : {}),
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
  let cleanup: ResourceCleanupOutcome = 'skipped';
  let journalWriteFailed = outcome.result.journal_write_failed === true;
  const incidents = [...outcome.result.incidents];
  const pageLost = browserOrPageDefinitelyLost(outcome.page, outcome.browser);

  if (outcome.result.send_count >= 1 && outcome.result.state !== 'ok') {
    const stopIncident: BrowserIncident = {
      eventClass: 'owned_generation_stop_not_attempted_authority_absent',
      symptom: `${outcome.result.state}:${outcome.result.cause}`,
      action: 'preserve_live_generation_no_stop',
    };
    incidents.push(stopIncident.eventClass);
    if (!appendIncident(stopIncident, outcome.result.invocation_id)) journalWriteFailed = true;
  }

  const cleanupAuthorityProven = Boolean(
    outcome.page
    && typeof outcome.page === 'object'
    && !cleanupAuthorityUnprovenPages.has(outcome.page),
  );
  const requestedPageAction = outcome.cleanupAction ?? decidePageCleanupAction({
    sendCount: outcome.result.send_count,
    publicationState: outcome.publicationState,
    pagePresent: cleanupAuthorityProven,
    pageLost,
  });
  const postSettlementCloseEligible = outcome.result.state === 'ok'
    && outcome.publicationState === 'committed_ok'
    && outcome.result.reviewer_source !== undefined;
  const pageAction = postSettlementCloseEligible
    || (outcome.result.send_count >= 1 && outcome.result.state !== 'ok')
    ? 'preserve'
    : requestedPageAction;
  if (pageAction === 'close') {
    cleanup = await boundedResourceCleanup(
      async () => {
        try { await outcome.page?.close?.(); } catch { /* bounded cleanup */ }
      },
      RESOURCE_CLEANUP_BOUND_MS,
    );
  }
  await releaseCdpBrowser(outcome.browser);
  return {
    ...outcome.result,
    incidents,
    ...(journalWriteFailed ? { journal_write_failed: true } : {}),
    cleanup,
  };
}

export async function runStateLightTurnForTest(
  args: ParsedTurnArgs,
  recoveryHooks: StateLightRecoveryHooks = {},
): Promise<TurnRunOutcome> {
  return await runTurn(args, recoveryHooks);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: ParsedTurnArgs;
  try {
    args = parseTurnArgs(argv);
    if (!stringOption(args, 'invocation-id')) {
      const refusal = compactInputInvalidRefusal(
        'argument_required:invocation-id',
        '',
        'profile-unresolved',
      );
      emit(refusal);
      return turnExitCode(refusal.state);
    }
  } catch (error) {
    const refusal = compactInputInvalidRefusal(
      error instanceof Error ? error.message : String(error),
      '',
      'profile-unresolved',
    );
    emit(refusal);
    return turnExitCode(refusal.state);
  }
  const result = await finalizeTurn(await runTurn(args));
  emit(result);
  return turnExitCode(result.state);
}

const invoked = process.argv[1] ? new URL(`file://${resolve(process.argv[1])}`).href : undefined;
if (invoked === import.meta.url) process.exitCode = await main();
