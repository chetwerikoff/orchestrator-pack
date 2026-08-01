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
  type TurnResultV1,
  type TurnState,
} from './contracts.ts';
import { readStableInput } from './input.ts';
import {
  acquireStateLightNewChatSendSlot,
  conversationUuidFromUrl,
  ownedConversationIdentityMatches,
  prepareStateLightFreshConversation,
  projectConversationPrefix,
  readStateLightAdvisoryWall,
  recordStateLightAdvisoryWall,
  releaseStateLightFreshConversationClaim,
  releaseStateLightNewChatSendSlot,
  StateLightNavigationCounter,
  STATE_LIGHT_FRESH_RECOVERY_ATTEMPTS,
  tryClaimStateLightFreshConversation,
  navigateToProjectConversationIfNeeded,
  readProjectConversationUrl,
  waitForConversationUrlAfterSend,
} from './state-light-fresh-conversation.ts';
import { configuredProfileKey } from './storage-common.ts';
import {
  ASSISTANT_TURN_ACTION_SELECTOR,
  ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
  classifyProductWall,
  COMPOSER_SELECTOR,
  CONVERSATION_TURN_SECTION_SELECTOR,
  loadChromium,
  MESSAGE_AUTHOR_ROLE_ATTR,
  MESSAGE_IDENTITY_ATTR,
  MESSAGE_NODE_SELECTOR,
  messageIdentitySelector,
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
const MAX_LOCAL_READ_WAIT_MS = 5_000;
/** Per-node transcript reads use shorter budgets so one hung node cannot block the poll. */
const MESSAGE_NODE_READ_TIMEOUT_MS = 800;
const MESSAGE_NODE_READ_RETRY_TIMEOUT_MS = 400;
const MESSAGE_NODE_READ_ATTEMPTS = 2;
const OWNED_TAIL_CONFIRM_DELAY_MS = 100;
const OWNED_TAIL_SNAPSHOT_BUDGET_MS = MAX_LOCAL_READ_WAIT_MS;
const OWNED_IDENTITY_STABLE_READS = 2;
const OWNED_IDENTITY_MISSING_READS = 2;
const OWNED_IDENTITY_UNRESOLVED_READS = 2;
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
  readonly identity?: string;
  readonly domIndex?: number;
}

export interface PageNodeObservation {
  readonly domIndex: number;
  readonly role?: 'user' | 'assistant';
  readonly identity?: string;
  readonly text: string;
  readonly roleReadFailed: boolean;
  readonly identityReadFailed: boolean;
  readonly textReadFailed: boolean;
  /** Pinned current-observation element; never reconstructed from a later DOM index. */
  readonly elementHandle?: any;
}

export interface OwnedTailWitness {
  readonly role: 'user' | 'assistant';
  readonly identity?: string;
}

export type OwnedTailBoundary =
  | {
      readonly kind: 'anchor';
      readonly anchorIdentity: string;
      readonly suffix: readonly OwnedTailWitness[];
    }
  | { readonly kind: 'fresh' }
  | { readonly kind: 'text_fallback'; readonly cause: string };

type OwnedMessageObservationMode = 'admission' | 'bound' | 'text_fallback';

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

interface ExactOwnedIdentityResolution {
  readonly state: 'ok' | 'missing' | 'unresolved' | 'changed';
}

export interface PageObservationResult {
  readonly messages: PageMessage[];
  readonly nodes: PageNodeObservation[];
  /** Total rendered node count, including nodes outside a bounded tail read. */
  readonly nodeCount?: number;
  /** Exact global anchor resolution captured inside a bounded pre-send tail read. */
  readonly tailAnchorExactResolution?: ExactOwnedIdentityResolution;
  /** True only when assistant nodes carry pinned handles from this observation. */
  readonly elementHandlesCaptured?: boolean;
  readonly nodeListReadFailed: boolean;
  readonly ownedWindowCompletionReady: boolean;
  readonly transcriptIncomplete: boolean;
}

interface BrowserIncident {
  readonly eventClass: string;
  readonly symptom: string;
  readonly action?: string;
  readonly uncertaintyDiagnostics?: ObservationUncertaintyDiagnostics;
}

interface CompactTurnResult extends TurnResultV1 {
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
}

interface StateLightPublicationResult {
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

function normalizeOwnedEchoText(value: string): string {
  return normalizeMarkdownEchoText(stripUiCollapseAffixes(value));
}

function boundedDiagnosticHead(value: string, maxChars = DIAGNOSTIC_HEAD_CHARS): string {
  const normalized = normalizeEchoComparisonText(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

export function ownedPromptMatches(visibleText: string, promptText: string): boolean {
  const visible = normalizeOwnedEchoText(visibleText);
  const prompt = normalizeOwnedEchoText(promptText);
  return visible.length > 0 && visible === prompt;
}

const REPLY_STABILITY_HEAD_CHARS = DIAGNOSTIC_HEAD_CHARS;
const REPLY_STABILITY_TAIL_CHARS = DIAGNOSTIC_HEAD_CHARS;

function normalizeReplyForStability(text: string): string {
  return stripUiCollapseAffixes(normalizeEchoComparisonText(text));
}


export function hasOwnedUserMessage(messages: readonly PageMessage[], prompt: string): boolean {
  return messages.some((message) => message.role === 'user' && ownedPromptMatches(message.text, prompt));
}

function strictPostBaselineOwnedUserCount(
  messages: readonly PageMessage[],
  baselineCount: number,
  prompt: string,
): number {
  return messages.filter((message, index) => {
    const domIndex = message.domIndex ?? index;
    return domIndex >= Math.max(0, baselineCount)
      && message.role === 'user'
      && ownedPromptMatches(message.text, prompt);
  }).length;
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
  const assistants = messages.filter((message, index) => {
    const domIndex = message.domIndex ?? index;
    return domIndex >= Math.max(0, baselineCount) && message.role === 'assistant';
  });
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

function publishStateLightReply(
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
  prompt: string,
): {
  readonly replyWindow: readonly PageMessage[];
  readonly uncertainCause?: string;
  readonly observedUserHeads?: readonly string[];
  readonly lastOwnedAssistantMessageIndex: number | null;
} {
  const minimumDomIndex = Math.max(0, baselineCount);
  const users = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => (message.domIndex ?? index) >= minimumDomIndex
      && message.role === 'user');

  if (users.length === 0) {
    return { replyWindow: [], lastOwnedAssistantMessageIndex: null };
  }

  const ownedUsers = users.filter(({ message }) => ownedPromptMatches(message.text, prompt));
  if (ownedUsers.length !== 1) {
    return { replyWindow: [], lastOwnedAssistantMessageIndex: null };
  }

  const lastOwned = ownedUsers[0]!;
  const afterOwned = messages.slice(lastOwned.index + 1);

  let replyWindow = afterOwned;
  let uncertainCause: string | undefined;
  let observedUserHeads: string[] | undefined;

  const firstForeignUser = afterOwned.find(
    (message) => message.role === 'user' && !ownedPromptMatches(message.text, prompt),
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
  prompt: string,
  inProgress: boolean,
): PageObservationDecision {
  const attributableUsers = strictPostBaselineOwnedUserCount(messages, baselineCount, prompt);
  if (attributableUsers !== 1) return { state: 'waiting' };

  const { replyWindow, uncertainCause, observedUserHeads } = resolveOwnedReplyWindow(
    messages,
    baselineCount,
    prompt,
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

function compactResult(
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

async function locatorCountResult(locator: any): Promise<{ count: number; readFailed: boolean }> {
  try {
    return { count: Number(await locator.count()), readFailed: false };
  } catch {
    return { count: 0, readFailed: true };
  }
}

async function locatorCount(locator: any): Promise<number> {
  return (await locatorCountResult(locator)).count;
}

async function locatorText(locator: any, timeoutMs = MAX_LOCAL_READ_WAIT_MS): Promise<string> {
  // Prefer innerText for rendered-text semantics (owned-prompt matching). Playwright
  // innerText is a plain DOM read and does not scroll; scroll hijack was from the
  // continuation click path (fixed separately). textContent includes hidden/sr-only
  // subtree text (e.g. "You said:") that strict ownedPromptMatches must not see.
  try {
    const innerText = normalizeVisibleText(String(await locator.innerText({ timeout: timeoutMs }) ?? ''));
    if (innerText) return innerText;
  } catch {
    // Fall through to textContent for fixtures and nodes that only expose DOM text there.
  }
  try {
    return normalizeVisibleText(String(await locator.textContent({ timeout: timeoutMs })));
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
  prompt?: string,
  baselineCount?: number,
  captureElementHandles = false,
): Promise<PageObservationResult> {
  const nodes = page.locator(MESSAGE_NODE_SELECTOR);
  const countResult = await locatorCountResult(nodes);
  const messages: PageMessage[] = [];
  const nodeObservations: PageNodeObservation[] = [];
  const domIndices: number[] = [];
  let transcriptIncomplete = countResult.readFailed;
  const attributeTimeouts = [
    MESSAGE_NODE_READ_TIMEOUT_MS,
    MESSAGE_NODE_READ_RETRY_TIMEOUT_MS,
  ].slice(0, MESSAGE_NODE_READ_ATTEMPTS);
  for (let index = 0; index < countResult.count; index++) {
    const node = nodes.nth(index);
    const roleValue = await readLocatorAttribute(node, MESSAGE_AUTHOR_ROLE_ATTR, attributeTimeouts);
    const identityValue = await readLocatorAttribute(node, MESSAGE_IDENTITY_ATTR, attributeTimeouts);
    const role = roleValue === 'user' || roleValue === 'assistant' ? roleValue : undefined;
    const { text, readFailed: textReadFailed } = await readMessageNodeText(node);
    const roleReadFailed = roleValue === null;
    const identityReadFailed = identityValue === null;
    const identity = identityReadFailed || identityValue === '' ? undefined : identityValue;
    let elementHandle: any | undefined;
    if (captureElementHandles && role === 'assistant' && typeof node.elementHandle === 'function') {
      try {
        elementHandle = await node.elementHandle({ timeout: MESSAGE_NODE_READ_TIMEOUT_MS });
      } catch {
        elementHandle = undefined;
      }
    }
    if (roleReadFailed || (role !== undefined && textReadFailed)) transcriptIncomplete = true;
    nodeObservations.push({
      domIndex: index,
      ...(role ? { role } : {}),
      ...(identity ? { identity } : {}),
      text,
      roleReadFailed,
      identityReadFailed,
      textReadFailed,
      ...(elementHandle ? { elementHandle } : {}),
    });
    if (!role) continue;
    messages.push({
      role,
      text,
      ...(identity ? { identity } : {}),
      domIndex: index,
    });
    domIndices.push(index);
  }

  let ownedWindowCompletionReady = false;
  if (prompt !== undefined && baselineCount !== undefined) {
    const { lastOwnedAssistantMessageIndex } = resolveOwnedReplyWindow(messages, baselineCount, prompt);
    const ownedAssistantDomIndex = lastOwnedAssistantMessageIndex === null
      ? null
      : domIndices[lastOwnedAssistantMessageIndex] ?? null;
    if (ownedAssistantDomIndex !== null) {
      ownedWindowCompletionReady = await readAssistantNodeCompletionReady(
        nodes.nth(ownedAssistantDomIndex),
        MESSAGE_NODE_READ_TIMEOUT_MS,
      );
    }
  }

  return {
    messages,
    nodes: nodeObservations,
    nodeCount: countResult.count,
    elementHandlesCaptured: captureElementHandles,
    ownedWindowCompletionReady,
    transcriptIncomplete,
    nodeListReadFailed: countResult.readFailed,
  };
}

async function readTailAttribute(
  locator: any,
  attribute: string,
  deadline: number,
): Promise<string | null> {
  const budgets = [
    MESSAGE_NODE_READ_TIMEOUT_MS,
    MESSAGE_NODE_READ_RETRY_TIMEOUT_MS,
  ].slice(0, MESSAGE_NODE_READ_ATTEMPTS);
  for (const budget of budgets) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    try {
      return String(await locator.getAttribute(attribute, {
        timeout: Math.max(1, Math.min(budget, remaining)),
      }) ?? '');
    } catch {
      // Retry only while the single tail-snapshot budget remains.
    }
  }
  return null;
}

/**
 * Read only the minimal pre-send suffix. Continuation reads walk backward
 * and stop at the last user anchor; verified-fresh reads prove zero users.
 */
export async function readTailPageObservation(
  page: any,
  allowFreshSentinel: boolean,
): Promise<PageObservationResult> {
  const nodes = page.locator(MESSAGE_NODE_SELECTOR);
  const countResult = await locatorCountResult(nodes);
  const deadline = Date.now() + OWNED_TAIL_SNAPSHOT_BUDGET_MS;
  const reverseNodes: PageNodeObservation[] = [];
  const reverseMessages: PageMessage[] = [];
  let transcriptIncomplete = countResult.readFailed;

  if (!countResult.readFailed) {
    for (let index = countResult.count - 1; index >= 0; index--) {
      const node = nodes.nth(index);
      const roleValue = await readTailAttribute(node, MESSAGE_AUTHOR_ROLE_ATTR, deadline);
      const identityValue = await readTailAttribute(node, MESSAGE_IDENTITY_ATTR, deadline);
      const role = roleValue === 'user' || roleValue === 'assistant'
        ? roleValue
        : undefined;
      const roleReadFailed = roleValue === null;
      const identityReadFailed = identityValue === null;
      const identity = identityReadFailed || identityValue === ''
        ? undefined
        : identityValue;

      reverseNodes.push({
        domIndex: index,
        ...(role ? { role } : {}),
        ...(identity ? { identity } : {}),
        text: '',
        roleReadFailed,
        identityReadFailed,
        textReadFailed: false,
      });
      if (role) {
        reverseMessages.push({
          role,
          text: '',
          ...(identity ? { identity } : {}),
          domIndex: index,
        });
      }
      if (roleReadFailed || role === undefined) {
        transcriptIncomplete = true;
        break;
      }
      if (!allowFreshSentinel && role === 'user') break;
    }
  }

  const messages = reverseMessages.reverse();
  const observations = reverseNodes.reverse();
  const anchor = allowFreshSentinel
    ? undefined
    : observations.find((node) => node.role === 'user');
  const tailAnchorExactResolution = anchor?.identity
    ? await readExactOwnedIdentity(page, anchor.identity, deadline)
    : undefined;

  return {
    messages,
    nodes: observations,
    nodeCount: countResult.count,
    ...(tailAnchorExactResolution ? { tailAnchorExactResolution } : {}),
    ownedWindowCompletionReady: false,
    transcriptIncomplete,
    nodeListReadFailed: countResult.readFailed,
  };
}


function readableTailWitness(node: PageNodeObservation): OwnedTailWitness | undefined {
  if (!node.role || node.roleReadFailed || node.identityReadFailed) return undefined;
  return {
    role: node.role,
    ...(node.identity ? { identity: node.identity } : {}),
  };
}

function tailWitnessMatches(left: OwnedTailWitness, right: OwnedTailWitness): boolean {
  return left.role === right.role && left.identity === right.identity;
}

function uniqueIdentityNodeIndex(
  nodes: readonly PageNodeObservation[],
  identity: string,
): number | undefined {
  const matches = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.identity === identity);
  if (matches.length !== 1) return undefined;
  return matches[0]!.index;
}

export function establishOwnedTailBoundary(
  first: PageObservationResult,
  second: PageObservationResult,
  allowFreshSentinel: boolean,
): OwnedTailBoundary {
  if (first.nodeListReadFailed || second.nodeListReadFailed) {
    return { kind: 'text_fallback', cause: 'tail_node_list_unreadable' };
  }

  const firstUsers = first.nodes.filter((node) => node.role === 'user');
  const secondUsers = second.nodes.filter((node) => node.role === 'user');
  if (allowFreshSentinel && firstUsers.length === 0 && secondUsers.length === 0) {
    const firstWitnesses = first.nodes.map(readableTailWitness);
    const secondWitnesses = second.nodes.map(readableTailWitness);
    const stableFresh = firstWitnesses.length === secondWitnesses.length
      && firstWitnesses.every((value) => value !== undefined)
      && secondWitnesses.every((value) => value !== undefined)
      && firstWitnesses.every((value, index) => tailWitnessMatches(
        value!,
        secondWitnesses[index]!,
      ));
    return stableFresh
      ? { kind: 'fresh' }
      : { kind: 'text_fallback', cause: 'fresh_tail_unstable' };
  }

  const candidate = secondUsers.at(-1);
  if (!candidate?.identity) {
    return { kind: 'text_fallback', cause: 'stable_tail_anchor_unavailable' };
  }
  if (
    first.tailAnchorExactResolution?.state !== 'ok'
    || second.tailAnchorExactResolution?.state !== 'ok'
  ) {
    return { kind: 'text_fallback', cause: 'stable_tail_anchor_unavailable' };
  }
  const firstIndex = uniqueIdentityNodeIndex(first.nodes, candidate.identity);
  const secondIndex = uniqueIdentityNodeIndex(second.nodes, candidate.identity);
  if (firstIndex === undefined || secondIndex === undefined) {
    return { kind: 'text_fallback', cause: 'stable_tail_anchor_unavailable' };
  }
  const firstAnchor = first.nodes[firstIndex];
  const secondAnchor = second.nodes[secondIndex];
  if (firstAnchor?.role !== 'user' || secondAnchor?.role !== 'user') {
    return { kind: 'text_fallback', cause: 'stable_tail_anchor_unavailable' };
  }
  if (first.nodes.slice(firstIndex + 1).some((node) => node.role === 'user')) {
    return { kind: 'text_fallback', cause: 'stable_tail_anchor_unavailable' };
  }
  if (second.nodes.slice(secondIndex + 1).some((node) => node.role === 'user')) {
    return { kind: 'text_fallback', cause: 'stable_tail_anchor_unavailable' };
  }

  const firstSuffixNodes = first.nodes.slice(firstIndex);
  const secondSuffixNodes = second.nodes.slice(secondIndex);
  if (firstSuffixNodes.length !== secondSuffixNodes.length) {
    return { kind: 'text_fallback', cause: 'stable_tail_suffix_changed' };
  }
  const firstSuffix = firstSuffixNodes.map(readableTailWitness);
  const secondSuffix = secondSuffixNodes.map(readableTailWitness);
  if (firstSuffix.some((value) => value === undefined) || secondSuffix.some((value) => value === undefined)) {
    return { kind: 'text_fallback', cause: 'stable_tail_suffix_unreadable' };
  }
  const stable = firstSuffix.every((value, index) => tailWitnessMatches(
    value!,
    secondSuffix[index]!,
  ));
  if (!stable) return { kind: 'text_fallback', cause: 'stable_tail_suffix_changed' };
  return {
    kind: 'anchor',
    anchorIdentity: candidate.identity,
    suffix: secondSuffix as OwnedTailWitness[],
  };
}

export type PostTailResolution =
  | { readonly state: 'ok'; readonly nodes: readonly PageNodeObservation[] }
  | { readonly state: 'unresolved' }
  | { readonly state: 'boundary_unresolved' }
  | { readonly state: 'changed' };

export function resolvePostTailNodes(
  boundary: OwnedTailBoundary,
  observation: PageObservationResult,
): PostTailResolution {
  if (boundary.kind === 'text_fallback') return { state: 'unresolved' };
  if (observation.nodeListReadFailed) return { state: 'boundary_unresolved' };
  if (boundary.kind === 'fresh') return { state: 'ok', nodes: observation.nodes };

  const matching = observation.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.identity === boundary.anchorIdentity);
  if (matching.length > 1) return { state: 'changed' };
  if (matching.length === 0) {
    return observation.nodes.some((node) => node.identityReadFailed)
      ? { state: 'boundary_unresolved' }
      : { state: 'changed' };
  }
  const { node: anchor, index: anchorIndex } = matching[0]!;
  if (anchor.role !== 'user') return { state: 'changed' };
  const currentSuffix = observation.nodes.slice(
    anchorIndex,
    anchorIndex + boundary.suffix.length,
  );
  if (currentSuffix.length !== boundary.suffix.length) return { state: 'changed' };
  for (let index = 0; index < boundary.suffix.length; index++) {
    const current = currentSuffix[index]!;
    const expected = boundary.suffix[index]!;
    const witness = readableTailWitness(current);
    if (!witness) return { state: 'boundary_unresolved' };
    if (!tailWitnessMatches(witness, expected)) return { state: 'changed' };
  }
  return {
    state: 'ok',
    nodes: observation.nodes.slice(anchorIndex + boundary.suffix.length),
  };
}

export type OwnedIdentityAdmissionDecision =
  | { readonly state: 'waiting' }
  | { readonly state: 'changed' }
  | { readonly state: 'boundary_unresolved' }
  | { readonly state: 'identityless' }
  | { readonly state: 'unresolved'; readonly immediate: boolean }
  | { readonly state: 'candidate'; readonly identity: string };

export function classifyOwnedIdentityAdmission(
  boundary: OwnedTailBoundary,
  observation: PageObservationResult,
): OwnedIdentityAdmissionDecision {
  const postTail = resolvePostTailNodes(boundary, observation);
  if (postTail.state === 'changed') return { state: 'changed' };
  if (postTail.state === 'boundary_unresolved') return { state: 'boundary_unresolved' };
  if (postTail.state === 'unresolved') return { state: 'unresolved', immediate: false };
  if (postTail.nodes.some((node) => node.roleReadFailed || node.role === undefined)) {
    return { state: 'unresolved', immediate: false };
  }
  const users = postTail.nodes.filter((node) => node.role === 'user');
  if (users.length === 0) return { state: 'waiting' };
  if (users.length > 1) return { state: 'unresolved', immediate: true };
  const user = users[0]!;
  const nodesBeforeUser = postTail.nodes.filter((node) => node.domIndex < user.domIndex);
  if (boundary.kind !== 'fresh' && nodesBeforeUser.some((node) => node.role === 'assistant')) {
    return { state: 'changed' };
  }
  if (user.identityReadFailed) return { state: 'unresolved', immediate: false };
  if (!user.identity) return { state: 'identityless' };
  return { state: 'candidate', identity: user.identity };
}

export type BoundOwnedWindowResolution =
  | {
      readonly state: 'ok';
      readonly messages: readonly PageMessage[];
      readonly boundUserDomIndex: number;
      readonly lastAssistantDomIndex: number | null;
      readonly lastAssistantHandle?: any;
    }
  | { readonly state: 'unresolved' }
  | { readonly state: 'changed' };

export function resolveBoundOwnedWindow(
  observation: PageObservationResult,
  identity: string,
): BoundOwnedWindowResolution {
  if (observation.nodeListReadFailed) return { state: 'unresolved' };
  const matches = observation.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.identity === identity);
  if (matches.length > 1) return { state: 'changed' };
  if (matches.length === 0) return { state: 'unresolved' };
  const { node: user, index: userIndex } = matches[0]!;
  if (user.role !== 'user' || user.identityReadFailed) return { state: 'changed' };

  const messages: PageMessage[] = [{
    role: 'user',
    text: user.text,
    identity,
    domIndex: user.domIndex,
  }];
  let lastAssistantDomIndex: number | null = null;
  let lastAssistantHandle: any | undefined;
  for (const node of observation.nodes.slice(userIndex + 1)) {
    if (node.roleReadFailed || node.role === undefined) return { state: 'unresolved' };
    if (node.role === 'user') break;
    if (node.textReadFailed) return { state: 'unresolved' };
    messages.push({
      role: 'assistant',
      text: node.text,
      ...(node.identity ? { identity: node.identity } : {}),
      domIndex: node.domIndex,
    });
    lastAssistantDomIndex = node.domIndex;
    lastAssistantHandle = node.elementHandle;
  }
  if (
    observation.elementHandlesCaptured
    && lastAssistantDomIndex !== null
    && !lastAssistantHandle
  ) {
    return { state: 'unresolved' };
  }
  return {
    state: 'ok',
    messages,
    boundUserDomIndex: user.domIndex,
    lastAssistantDomIndex,
    ...(lastAssistantHandle ? { lastAssistantHandle } : {}),
  };
}

async function readPinnedAssistantCompletionReady(
  elementHandle: any,
  waitMs = MAX_LOCAL_READ_WAIT_MS,
): Promise<boolean> {
  if (!elementHandle) return false;
  // Locator-backed fixture handles use the same canonical turn-scoped probe.
  if (typeof elementHandle.locator === 'function') {
    return readAssistantNodeCompletionReady(elementHandle, waitMs);
  }
  if (typeof elementHandle.evaluate !== 'function') return false;
  try {
    return await Promise.race([
      elementHandle.evaluate(
        (node: Element, selectors: {
          roleAttr: string;
          turn: string;
          inProgress: string;
          actions: string;
        }) => {
          if (node.getAttribute(selectors.roleAttr) !== 'assistant') return false;
          const turn = node.closest(selectors.turn) ?? node;
          if (turn.querySelector(selectors.inProgress)) return false;
          return Boolean(turn.querySelector(selectors.actions));
        },
        {
          roleAttr: MESSAGE_AUTHOR_ROLE_ATTR,
          turn: CONVERSATION_TURN_SECTION_SELECTOR,
          inProgress: ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
          actions: ASSISTANT_TURN_ACTION_SELECTOR,
        },
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), waitMs)),
    ]);
  } catch {
    return false;
  }
}

async function readExactOwnedIdentity(
  page: any,
  identity: string,
  deadline?: number,
): Promise<ExactOwnedIdentityResolution> {
  if (deadline !== undefined && Date.now() >= deadline) return { state: 'unresolved' };
  const locator = page.locator(messageIdentitySelector(identity));
  const count = await locatorCountResult(locator);
  if (count.readFailed) return { state: 'unresolved' };
  if (count.count === 0) return { state: 'missing' };
  if (count.count !== 1) return { state: 'changed' };
  const node = locator.first();
  const timeouts = [MESSAGE_NODE_READ_TIMEOUT_MS, MESSAGE_NODE_READ_RETRY_TIMEOUT_MS]
    .slice(0, MESSAGE_NODE_READ_ATTEMPTS);
  const role = deadline === undefined
    ? await readLocatorAttribute(node, MESSAGE_AUTHOR_ROLE_ATTR, timeouts)
    : await readTailAttribute(node, MESSAGE_AUTHOR_ROLE_ATTR, deadline);
  const observedIdentity = deadline === undefined
    ? await readLocatorAttribute(node, MESSAGE_IDENTITY_ATTR, timeouts)
    : await readTailAttribute(node, MESSAGE_IDENTITY_ATTR, deadline);
  if (role === null || observedIdentity === null) return { state: 'unresolved' };
  if (role !== 'user' || observedIdentity !== identity) return { state: 'changed' };
  return { state: 'ok' };
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
  prompt?: string,
  baselineCount?: number,
  captureElementHandles = false,
): Promise<PageObservationResult & {
  readonly wall: ReturnType<typeof classifyProductWall>;
}> {
  const observation = await readPageObservation(
    page,
    prompt,
    baselineCount,
    captureElementHandles,
  );
  let wall: ReturnType<typeof classifyProductWall> = {};
  try {
    wall = classifyProductWall(await productStatusText(page, POST_SEND_PRODUCT_WALL_PROBE_MS));
  } catch {
    // Product-status probes must not block or invalidate transcript reads.
  }
  return { ...observation, wall };
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

async function waitForComposer(
  page: any,
  deadline: number,
): Promise<{ state: 'ready' } | { state: TurnState; cause: string }> {
  const composer = page.locator(COMPOSER_SELECTOR);
  while (Date.now() < deadline) {
    const wall = classifyProductWall(
      await productStatusText(page, Math.min(MAX_LOCAL_READ_WAIT_MS, Math.max(1, deadline - Date.now()))),
    );
    if (wall.state) return { state: wall.state, cause: wall.cause ?? `${wall.state}_detected` };
    if (await locatorCount(composer) > 0) return { state: 'ready' };
    await sleep(page, Math.min(INITIAL_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return { state: 'ui_contract_mismatch', cause: 'composer_unavailable' };
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

function returnOwnedMessageIdentityMismatch(
  cause: 'owned_message_identity_unresolved' | 'owned_message_identity_changed' | 'owned_message_identity_disappeared',
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
  incident(cause, cause, 'return_local_error');
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
      { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
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
  ]);
  const invocationId = randomUUID();
  let profileKey = 'profile-unresolved';
  let browser: any;
  let page: any;
  let sendCount = 0;
  let pollCount = 0;
  const navigation = new StateLightNavigationCounter();
  let journalWriteFailed = false;
  const incidents: BrowserIncident[] = [];
  let afterSend = false;

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
    const config = browserConfig(args);
    profileKey = configuredProfileKey(config.profile, config.cdp);
    const snapshot = readStableInput(requireOption(args, 'input'));
    const destination = destinationIdentity(requireOption(args, 'output'));

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

    const advisoryWall = readStateLightAdvisoryWall(profileKey);
    if (advisoryWall) {
      incident('invocation_blocker', advisoryWall.cause, 'return_local_error');
      return {
        result: compactResult(
          advisoryWall.state,
          'invocation',
          advisoryWall.cause,
          invocationId,
          profileKey,
          sendCount,
          pollCount, navigation, incidents,
          {},
          journalWriteFailed,
        ),
      };
    }

    const chromium = loadChromium();
    browser = await chromium.connectOverCDP(config.cdp, { timeout: Math.min(30_000, config.timeoutMs) });
    page = await createDedicatedTurnPage(browser);
    await navigateOwnedTurnPage(page, config, navigation);

    const composerDeadline = Date.now() + Math.min(30_000, config.timeoutMs);
    let baselineCount = 0;
    let ownedConversationUrl: string | undefined;
    let ownedTailBoundary: OwnedTailBoundary = {
      kind: 'text_fallback',
      cause: 'tail_snapshot_not_established',
    };
    let observationMode: OwnedMessageObservationMode = 'text_fallback';
    let textFallbackIncidentLogged = false;
    let admissionCandidateIdentity: string | undefined;
    let admissionStableReads = 0;
    let admissionUnresolvedReads = 0;
    let admissionBoundaryUnresolvedReads = 0;
    let admissionExactUnresolvedReads = 0;
    let admissionIdentitylessReads = 0;
    let boundIdentity: string | undefined;
    let boundMissingReads = 0;
    let boundUnresolvedReads = 0;

    const sendOwnedPrompt = async (): Promise<void> => {
      const composer = page.locator(COMPOSER_SELECTOR);
      await composer.click({ timeout: MAX_LOCAL_READ_WAIT_MS });
      await composer.fill(snapshot.text, { timeout: MAX_LOCAL_READ_WAIT_MS });
      const firstTail = await readTailPageObservation(page, config.newChat);
      await sleep(page, OWNED_TAIL_CONFIRM_DELAY_MS);
      const secondTail = await readTailPageObservation(page, config.newChat);
      ownedTailBoundary = establishOwnedTailBoundary(firstTail, secondTail, config.newChat);
      observationMode = ownedTailBoundary.kind === 'text_fallback' ? 'text_fallback' : 'admission';
      baselineCount = secondTail.nodeCount ?? secondTail.messages.length;
      admissionCandidateIdentity = undefined;
      admissionStableReads = 0;
      admissionUnresolvedReads = 0;
      admissionBoundaryUnresolvedReads = 0;
      admissionExactUnresolvedReads = 0;
      admissionIdentitylessReads = 0;
      boundIdentity = undefined;
      boundMissingReads = 0;
      boundUnresolvedReads = 0;
      const sendButton = page.locator(SEND_BUTTON_SELECTOR);
      if (await locatorCount(sendButton) > 0) {
        await sendButton.click({ timeout: MAX_LOCAL_READ_WAIT_MS });
      } else {
        await composer.press('Enter', { timeout: MAX_LOCAL_READ_WAIT_MS });
      }
      sendCount += 1;
      afterSend = true;
      if (observationMode === 'text_fallback' && !textFallbackIncidentLogged) {
        incident(
          'owned_message_identity_text_fallback',
          ownedTailBoundary.kind === 'text_fallback' ? ownedTailBoundary.cause : 'identityless_owned_message',
          'continue_strict_text_matching',
        );
        textFallbackIncidentLogged = true;
      }
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

        let composerState = await waitForComposer(page, composerDeadline);
        const initialComposerFailure = returnComposerBlocker(composerState);
        if (initialComposerFailure) return initialComposerFailure;

        let claimed = false;
        let sendAuthorized = true;
        let lastAttemptConversationUrl: string | undefined;
        for (let recovery = 0; recovery < STATE_LIGHT_FRESH_RECOVERY_ATTEMPTS && !claimed; recovery++) {
          if (recovery > 0) {
            const landingEvidence = await classifySendLandingEvidence(
              page,
              snapshot.text,
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
            composerState = await waitForComposer(page, composerDeadline);
            const composerFailure = returnComposerBlocker(composerState);
            if (composerFailure) return composerFailure;
            sendAuthorized = true;
          }

          if (sendAuthorized) {
            await sendOwnedPrompt();
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

          const claim = tryClaimStateLightFreshConversation(profileKey, conversationUrl, invocationId);
          if (claim === 'contended') {
            const landingEvidence = await classifySendLandingEvidence(
              page,
              snapshot.text,
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
            snapshot.text,
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
        releaseStateLightNewChatSendSlot(profileKey, invocationId);
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

      const composerState = await waitForComposer(page, composerDeadline);
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

      await sendOwnedPrompt();
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

    const waitForIdentityResolution = async (
      diagnosticMessages: readonly PageMessage[],
    ): Promise<TurnRunOutcome | null> => {
      const exhausted = maybeReturnObservationExhausted(
        Date.now(),
        softDeadline,
        hardExhaustionDeadline,
        sendCount,
        { state: 'waiting' },
        stableReads,
        pollCount,
        diagnosticMessages,
        baselineCount,
        page,
        browser,
        invocationId,
        profileKey,
        navigation,
        incidents,
        journalWriteFailed,
        incident,
      );
      if (exhausted) return exhausted;
      emitHeartbeatForPoll({ state: 'waiting' });
      await sleep(page, completionReadySeen ? COMPLETION_CONFIRM_POLL_MS : INITIAL_POLL_MS);
      return null;
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
        observation = await readPostSendObservation(
          page,
          observationMode === 'text_fallback' ? snapshot.text : undefined,
          observationMode === 'text_fallback' ? baselineCount : undefined,
          observationMode === 'bound',
        );
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
        );
        if (readErrorExhausted) return readErrorExhausted;
        emitHeartbeatForPoll({ state: 'waiting' });
        await sleep(page, INITIAL_POLL_MS);
        continue;
      }

      let messages = observation.messages;
      const { wall } = observation;
      // Text-derived/global completion evidence is valid only on the declared
      // strict-text fallback path. During identity admission and after binding,
      // completion authority must come from the exact identity-bounded assistant
      // node so a completed historical turn cannot make a partial owned reply
      // publication-eligible.
      let ownedWindowCompletionReady = observationMode === 'text_fallback'
        ? observation.ownedWindowCompletionReady
        : false;
      let transcriptIncomplete = observation.transcriptIncomplete;
      if (observationMode === 'text_fallback' && ownedWindowCompletionReady) {
        completionReadySeen = true;
      }
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

      if ((observationMode as OwnedMessageObservationMode) === 'admission') {
        const admission = classifyOwnedIdentityAdmission(ownedTailBoundary, observation);
        if (admission.state === 'changed') {
          return returnOwnedMessageIdentityMismatch(
            'owned_message_identity_changed', page, browser, invocationId, profileKey,
            sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
          );
        }
        if (admission.state === 'boundary_unresolved') {
          admissionStableReads = 0;
          admissionUnresolvedReads = 0;
          admissionBoundaryUnresolvedReads += 1;
          if (admissionBoundaryUnresolvedReads >= OWNED_IDENTITY_UNRESOLVED_READS) {
            return returnOwnedMessageIdentityMismatch(
              'owned_message_identity_changed', page, browser, invocationId, profileKey,
              sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
            );
          }
          const exhausted = await waitForIdentityResolution(messages);
          if (exhausted) return exhausted;
          continue;
        }
        admissionBoundaryUnresolvedReads = 0;
        if (admission.state === 'unresolved') {
          admissionStableReads = 0;
          admissionUnresolvedReads += 1;
          const cause = admissionCandidateIdentity
            ? 'owned_message_identity_changed'
            : 'owned_message_identity_unresolved';
          if (admission.immediate || admissionUnresolvedReads >= OWNED_IDENTITY_UNRESOLVED_READS) {
            return returnOwnedMessageIdentityMismatch(
              cause, page, browser, invocationId, profileKey,
              sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
            );
          }
          const exhausted = await waitForIdentityResolution(messages);
          if (exhausted) return exhausted;
          continue;
        }
        admissionUnresolvedReads = 0;
        if (admission.state === 'waiting') {
          admissionStableReads = 0;
          admissionExactUnresolvedReads = 0;
          if (admissionCandidateIdentity) {
            return returnOwnedMessageIdentityMismatch(
              'owned_message_identity_changed', page, browser, invocationId, profileKey,
              sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
            );
          }
          admissionIdentitylessReads = 0;
          if (
            config.newChat
            && sendCount >= 1
            && Date.now() >= freshConversationLandingDeadline
            && !readProjectConversationUrl(page, config.projectUrl ?? '')
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
          if (Date.now() >= dispatchDeadline && !sendObservationDeferredLogged) {
            incident(
              'send_observation_deferred',
              'owned_user_message_not_observed',
              'continue_observing_after_send',
            );
            sendObservationDeferredLogged = true;
          }
          if (Date.now() >= hardExhaustionDeadline) {
            return returnOwnedMessageIdentityMismatch(
              'owned_message_identity_unresolved', page, browser, invocationId, profileKey,
              sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
            );
          }
          const exhausted = await waitForIdentityResolution(messages);
          if (exhausted) return exhausted;
          continue;
        }
        if (admission.state === 'identityless') {
          admissionStableReads = 0;
          admissionExactUnresolvedReads = 0;
          if (admissionCandidateIdentity) {
            return returnOwnedMessageIdentityMismatch(
              'owned_message_identity_changed', page, browser, invocationId, profileKey,
              sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
            );
          }
          admissionIdentitylessReads += 1;
          if (admissionIdentitylessReads < OWNED_IDENTITY_UNRESOLVED_READS) {
            const exhausted = await waitForIdentityResolution(messages);
            if (exhausted) return exhausted;
            continue;
          }
          observationMode = 'text_fallback';
          if (!textFallbackIncidentLogged) {
            incident(
              'owned_message_identity_text_fallback',
              'identityless_owned_message',
              'continue_strict_text_matching',
            );
            textFallbackIncidentLogged = true;
          }
          const exhausted = await waitForIdentityResolution(messages);
          if (exhausted) return exhausted;
          continue;
        }

        admissionIdentitylessReads = 0;
        if (admissionCandidateIdentity && admissionCandidateIdentity !== admission.identity) {
          return returnOwnedMessageIdentityMismatch(
            'owned_message_identity_changed', page, browser, invocationId, profileKey,
            sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
          );
        }
        admissionCandidateIdentity ??= admission.identity;
        const exactCandidate = await readExactOwnedIdentity(page, admission.identity);
        if (exactCandidate.state === 'changed' || exactCandidate.state === 'missing') {
          return returnOwnedMessageIdentityMismatch(
            'owned_message_identity_changed', page, browser, invocationId, profileKey,
            sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
          );
        }
        if (exactCandidate.state === 'unresolved') {
          admissionStableReads = 0;
          admissionExactUnresolvedReads += 1;
          if (admissionExactUnresolvedReads >= OWNED_IDENTITY_UNRESOLVED_READS) {
            return returnOwnedMessageIdentityMismatch(
              'owned_message_identity_changed', page, browser, invocationId, profileKey,
              sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
            );
          }
          const exhausted = await waitForIdentityResolution(messages);
          if (exhausted) return exhausted;
          continue;
        }
        admissionExactUnresolvedReads = 0;
        admissionStableReads += 1;
        if (admissionStableReads < OWNED_IDENTITY_STABLE_READS) {
          const exhausted = await waitForIdentityResolution(messages);
          if (exhausted) return exhausted;
          continue;
        }
        boundIdentity = admission.identity;
        observationMode = 'bound';
        boundMissingReads = 0;
        boundUnresolvedReads = 0;
      }

      const identityOwnedPoll = observationMode === 'bound';
      if (identityOwnedPoll) {
        if (!boundIdentity) {
          return returnOwnedMessageIdentityMismatch(
            'owned_message_identity_changed', page, browser, invocationId, profileKey,
            sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
          );
        }
        const exactBound = await readExactOwnedIdentity(page, boundIdentity);
        if (exactBound.state === 'missing') {
          // DOM indices can shift as historical nodes materialize or virtualize.
          // Zero exact matches are bounded disappearance evidence unless another
          // current-page identity/role/topology contradiction exists.
          boundMissingReads += 1;
          if (boundMissingReads >= OWNED_IDENTITY_MISSING_READS) {
            return returnOwnedMessageIdentityMismatch(
              'owned_message_identity_disappeared', page, browser, invocationId, profileKey,
              sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
            );
          }
          const exhausted = await waitForIdentityResolution(messages);
          if (exhausted) return exhausted;
          continue;
        }
        boundMissingReads = 0;
        if (exactBound.state === 'changed') {
          return returnOwnedMessageIdentityMismatch(
            'owned_message_identity_changed', page, browser, invocationId, profileKey,
            sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
          );
        }
        if (exactBound.state === 'unresolved') {
          boundUnresolvedReads += 1;
          if (boundUnresolvedReads >= OWNED_IDENTITY_UNRESOLVED_READS) {
            return returnOwnedMessageIdentityMismatch(
              'owned_message_identity_changed', page, browser, invocationId, profileKey,
              sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
            );
          }
          const exhausted = await waitForIdentityResolution(messages);
          if (exhausted) return exhausted;
          continue;
        }
        const boundWindow = resolveBoundOwnedWindow(observation, boundIdentity);
        if (boundWindow.state === 'changed') {
          return returnOwnedMessageIdentityMismatch(
            'owned_message_identity_changed', page, browser, invocationId, profileKey,
            sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
          );
        }
        if (boundWindow.state === 'unresolved') {
          boundUnresolvedReads += 1;
          if (boundUnresolvedReads >= OWNED_IDENTITY_UNRESOLVED_READS) {
            return returnOwnedMessageIdentityMismatch(
              'owned_message_identity_changed', page, browser, invocationId, profileKey,
              sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
            );
          }
          const exhausted = await waitForIdentityResolution(messages);
          if (exhausted) return exhausted;
          continue;
        }
        boundUnresolvedReads = 0;
        messages = [...boundWindow.messages];
        transcriptIncomplete = false;
        ownedWindowCompletionReady = boundWindow.lastAssistantHandle
          ? await readPinnedAssistantCompletionReady(
              boundWindow.lastAssistantHandle,
              MESSAGE_NODE_READ_TIMEOUT_MS,
            )
          : false;
        if (ownedWindowCompletionReady) completionReadySeen = true;
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
        );
        if (incompleteExhausted) return incompleteExhausted;
        emitHeartbeatForPoll({ state: 'waiting' });
        await sleep(page, completionReadySeen ? COMPLETION_CONFIRM_POLL_MS : INITIAL_POLL_MS);
        continue;
      }

      let strictOwnedUsers: number | undefined;
      if (observationMode === 'text_fallback') {
        strictOwnedUsers = strictPostBaselineOwnedUserCount(
          messages,
          baselineCount,
          snapshot.text,
        );
        if (strictOwnedUsers > 1) {
          return returnOwnedMessageIdentityMismatch(
            'owned_message_identity_unresolved', page, browser, invocationId, profileKey,
            sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
          );
        }
        if (strictOwnedUsers === 0) {
          stableReads = 0;
          lastReadyReply = '';
          bestReadyReply = '';
          if (Date.now() >= hardExhaustionDeadline) {
            return returnOwnedMessageIdentityMismatch(
              'owned_message_identity_unresolved', page, browser, invocationId, profileKey,
              sendCount, pollCount, navigation, incidents, journalWriteFailed, incident,
            );
          }
          const exhausted = await waitForIdentityResolution(messages);
          if (exhausted) return exhausted;
          continue;
        }
      }

      const inProgress = !ownedWindowCompletionReady && !completionReadySeen;
      let decision: PageObservationDecision;
      if (identityOwnedPoll) {
        const assistants = messages.filter((message) => message.role === 'assistant');
        const reply = normalizeVisibleText(assistants.at(-1)?.text ?? '');
        decision = !inProgress && reply
          ? { state: 'ready', reply }
          : { state: 'waiting' };
      } else {
        decision = classifyPageObservation(messages, baselineCount, snapshot.text, inProgress);
      }

      if (
        identityOwnedPoll
        || (observationMode === 'text_fallback'
          ? strictOwnedUsers === 1
          : hasOwnedUserMessage(messages, snapshot.text))
      ) {
        ownedPromptEverSeen = true;
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
          const captureReply = bestReadyReply.length >= decision.reply.length ? bestReadyReply : decision.reply;
          const publication = publishStateLightReply(
            destination.finalPath,
            invocationId,
            captureReply,
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
      if (await maybeContinueGeneration(page)) {
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
        if (!identityOwnedPoll && !hasOwnedUserMessage(messages, snapshot.text)) {
          if (sendCount >= 1) {
            if (
              (targetChatUrl || config.newChat)
              && completionReadySeen
              && !ownedPromptEverSeen
              && hasPostSendTranscript(messages, baselineCount)
            ) {
              return returnOwnedConversationRenderMismatch(
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
  if (outcome.profileKey && outcome.ownedConversationUrl) {
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
