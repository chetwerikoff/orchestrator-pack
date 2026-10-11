import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  abandonLatePageHandle,
  boundedResourceCleanup,
  createCdpPageTarget,
  releaseCdpBrowser,
  RESOURCE_CLEANUP_BOUND_MS,
  type ResourceCleanupOutcome,
} from './browser-session.ts';
import { acquireDomainLock, destinationIdentity, type DomainLock } from './coordination.ts';
import {
  turnExitCode,
  type ComposerMutationDiagnosticV1,
  type FailureScope,
  type PreSendComposerFailureCause,
  type TurnResultV1,
  type TurnState,
} from './contracts.ts';
import { readStableInput } from './input.ts';
import {
  generateOwnedPromptMarker,
  ownedPromptMarkerMatches,
  wrapOwnedPromptPayload,
} from './owned-prompt-marker.ts';
import {
  conversationUuidFromUrl,
  ownedConversationIdentityMatches,
  prepareStateLightFreshConversation,
  isBlankProjectSurfaceUrl,
  projectConversationPrefix,
  recordStateLightAdvisoryWall,
  releaseStateLightFreshConversationClaim,
  StateLightNavigationCounter,
  STATE_LIGHT_FRESH_RECOVERY_ATTEMPTS,
  STATE_LIGHT_MAX_TIMEOUT_MS,
  StateLightSendSlotTimeoutError,
  STATE_LIGHT_NAVIGATION_TIMEOUT_MS,
  tryClaimStateLightFreshConversation,
  navigateToProjectConversationIfNeeded,
  readProjectConversationUrl,
  verifyStateLightFreshClaimOwnerFence,
  waitForConversationUrlAfterSend,
} from './state-light-fresh-conversation.ts';
import { configuredProfileKey } from './storage-common.ts';
import {
  admitStateLightTurnObservation,
  finalizeStateLightPrimaryPublication,
  readStateLightTurnObservation,
  transitionStateLightTurnObservation,
} from './state-light-turn-observation.ts';
import {
  ASSISTANT_MESSAGE_STYLE,
  ASSISTANT_TURN_ACTION_SELECTOR,
  ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
  classifyProductWall,
  COMPOSER_SELECTOR,
  CONVERSATION_TURN_SECTION_SELECTOR,
  loadChromium,
  markPreSendAlerts,
  MESSAGE_AUTHOR_ROLE_ATTR,
  MESSAGE_UNIT_KEY_ATTR,
  unrenderedOwnerAlertCause,
  alertHeading,
  resolveMessageRoleStyle,
  MESSAGE_NODE_SELECTOR,
  normalizeConversationUrl,
  productStatusText,
  projectConversationUrlMatchesProject,
  CONTINUE_GENERATING_BUTTON_NAME,
  locateContinueGeneratingControl,
  ASSISTANT_TURN_ANCESTOR_XPATH,
  readAssistantNodeCompletionReady,
  readAssistantTurnCompletionReady,
  SEND_BUTTON_SELECTOR,
  RENDERED_CONVERSATION_TURN_SECTION_SELECTOR,
  RENDERED_STOP_BUTTON_SELECTOR,
  CONNECTION_RECOVERY_STATUS_SELECTOR,
  stripUiCollapseAffixes,
  UNMARKED_ALERT_SELECTOR,
  USER_MESSAGE_STYLE,
  verifyProfile,
  BrowserOperationTimeoutError,
  createTurnOperationBudget,
  type BrowserConfig,
  type ProductWallDiagnostic,
  type TurnOperationBudget,
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
import {
  resolveBrowserTurnLivenessTiming,
  startTurnScopedHeartbeatScheduler,
  type BrowserTurnLivenessPhase,
  type ObservationHeartbeatV1,
  type TurnScopedHeartbeatScheduler,
} from './liveness-contract.ts';

export { stopOwnedGeneration };
export type { StopOwnedGenerationOutcome };

const DEFAULT_TIMEOUT_MS = 1_800_000;
/** Local CDP DOM reads after dispatch; not send/navigation pacing. */
export const POST_SEND_OBSERVATION_POLL_MS = 15_000;
const DEFAULT_POLL_MS = POST_SEND_OBSERVATION_POLL_MS;
const INITIAL_POLL_MS = 500;
// Consecutive finished-answer reads without a rendered owned user message
// before the helper reloads its owned conversation once (Issue #2197).
const MARKERLESS_RELOAD_SETTLE_READS = 3;
const DISPATCH_OBSERVATION_MS = 30_000;
const FRESH_CONVERSATION_LANDING_MS = DISPATCH_OBSERVATION_MS;
const STABILITY_READ_DELAY_MS = 1_000;
const COMPLETION_CONFIRM_POLL_MS = 1_000;
const DIAGNOSTIC_HEAD_CHARS = 300;
export const MAX_LOCAL_READ_WAIT_MS = 5_000;
const EXISTING_GENERATION_RESUME_WINDOW_MS = 30_000;
const EXISTING_GENERATION_WAIT_ROUND_MS = 10 * 60_000;
const EXISTING_GENERATION_WAIT_ROUNDS = 2;
const EXISTING_GENERATION_READ_INTERVAL_MS = 1_000;
const EXISTING_GENERATION_IDLE_READS = 2;
/** How long after the send a recovery banner waits for this turn's Stop to appear. */
const RECOVERY_BANNER_STOP_GRACE_MS = 60_000;
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
const CONTINUE_GENERATING_SELECTOR = 'button[aria-label*="Continue generating" i], button[data-testid*="continue-generating"], button[data-testid*="continue_generating"]';
/** Post-send wall probes must not block transcript reads or the confirm loop. */
const POST_SEND_PRODUCT_WALL_PROBE_MS = 2_000;
const BROWSER_TURN_PROJECT_BINDING_SCHEMA = 'orchestrator-pack/project-state-binding/v1';

function browserTurnRecurrencePath(env: Readonly<NodeJS.ProcessEnv> = process.env): string {
  const home = String(env.HOME ?? '').trim() || homedir();
  const root = join(home, '.local', 'state', 'chatgpt-browser-turn');
  const projectId = String(env.OPK_PROJECT_ID ?? '').trim();
  return projectId
    ? join(root, projectId, 'browser-turn-recurrence.jsonl')
    : join(root, 'browser-turn-recurrence.jsonl');
}

function readBrowserTurnProjectIdentity(
  env: Readonly<NodeJS.ProcessEnv>,
  recurrencePath: string,
): { projectId: string; repository: string } | null {
  const projectId = String(env.OPK_PROJECT_ID ?? '').trim();
  if (!projectId) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(projectId)) {
    throw new Error('browser_turn_project_id_invalid');
  }

  const home = String(env.HOME ?? '').trim() || homedir();
  const configHome = String(env.XDG_CONFIG_HOME ?? '').trim() || join(home, '.config');
  const cardPath = join(configHome, 'orchestrator-pack', 'projects', `${projectId}.json`);
  let card: unknown;
  try {
    card = JSON.parse(readFileSync(cardPath, 'utf8')) as unknown;
  } catch {
    throw new Error('browser_turn_project_card_unobservable');
  }
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    throw new Error('browser_turn_project_card_invalid');
  }
  const record = card as Record<string, unknown>;
  const cardProjectId = typeof record.projectId === 'string' ? record.projectId.trim() : '';
  const repository = typeof record.repository === 'string' ? record.repository.trim().toLowerCase() : '';
  if (cardProjectId !== projectId || !/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    throw new Error('browser_turn_project_card_invalid');
  }

  const namespaceRoot = dirname(recurrencePath);
  const bindingPath = join(namespaceRoot, 'project-binding.json');
  const expected = {
    schema: BROWSER_TURN_PROJECT_BINDING_SCHEMA,
    projectId,
    repository,
  };
  const readBinding = (): typeof expected | null => {
    if (!existsSync(bindingPath)) return null;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(bindingPath, 'utf8')) as unknown;
    } catch {
      throw new Error('project_state_binding_unreadable');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('project_state_binding_invalid');
    }
    const binding = value as Record<string, unknown>;
    if (
      binding.schema !== expected.schema
      || binding.projectId !== expected.projectId
      || String(binding.repository ?? '').trim().toLowerCase() !== expected.repository
    ) {
      throw new Error('project_state_binding_mismatch');
    }
    return expected;
  };

  const observed = readBinding();
  if (observed) return observed;
  mkdirSync(namespaceRoot, { recursive: true });
  if (readdirSync(namespaceRoot).some((name) => name !== 'project-binding.json')) {
    throw new Error('project_state_binding_missing_for_nonempty_namespace');
  }

  const temporary = join(namespaceRoot, `.project-binding.json.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(expected, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, bindingPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    unlinkSync(temporary);
  }
  const dirFd = openSync(namespaceRoot, 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  const persisted = readBinding();
  if (!persisted) throw new Error('project_state_binding_missing');
  return persisted;
}

export const BROWSER_TURN_RECURRENCE_PATH = browserTurnRecurrencePath();

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
  readonly completionReady?: boolean;
  readonly continuationVisible?: boolean;
}

export interface AtomicTranscriptSnapshot {
  readonly complete: boolean;
  readonly carriers: readonly AtomicTranscriptCarrier[];
}

export interface BrowserGptPageTurnEvidence {
  readonly generationInProgress: boolean | 'unknown';
  readonly observedAssistantNodes: number;
  readonly continueGeneratingVisible?: boolean;
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

export type ObservationHeartbeat = ObservationHeartbeatV1;

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
  readonly composerMutationDiagnostic?: ComposerMutationDiagnosticV1;
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
  readonly retirement_cleanup_required?: boolean;
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
  /** Private, process-local cleanup value; never emitted as turn-result. */
  readonly ownedTypedPayload?: string;
  /** Exact new-chat project surface of a proven created tab; never emitted. */
  readonly ownedFreshProjectUrl?: string;
}

interface FreshComposerCleanupContext {
  page?: any;
  markedPayload?: string;
  projectUrl?: string;
  sendLock?: DomainLock;
  sendAttempted?: boolean;
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
): { state: 'ready'; reply: string; assistantKey: string } | { state: 'waiting' | 'foreign-user' | 'continuity-unproven' } {
  if (!snapshot.complete || !baseline?.complete) return { state: 'continuity-unproven' };
  const historical = snapshot.carriers.slice(0, baseline.carriers.length);
  if (historical.length !== baseline.carriers.length) return { state: 'continuity-unproven' };
  for (let index = 0; index < baseline.carriers.length; index++) {
    const before = baseline.carriers[index]!;
    const after = historical[index]!;
    if (before.role !== after.role || before.fingerprint !== after.fingerprint) {
      return { state: 'continuity-unproven' };
    }
    if (before.key && before.key !== after.key) return { state: 'continuity-unproven' };
  }
  const ownedIndex = snapshot.carriers.findIndex((carrier) => (
    carrier.role === 'user' && carrier.key === ownedUserKey
  ));
  if (ownedIndex < baseline.carriers.length) return { state: 'continuity-unproven' };
  const suffix = snapshot.carriers.slice(ownedIndex);
  const laterUserOffset = suffix.slice(1).findIndex((carrier) => carrier.role === 'user');
  const ownedWindow = laterUserOffset >= 0
    ? suffix.slice(0, laterUserOffset + 1)
    : suffix;
  if (ownedWindow.some((carrier) => !carrier.key)) return { state: 'continuity-unproven' };
  const keyedCarriers = snapshot.carriers.filter((carrier) => carrier.key);
  const keyedValues = keyedCarriers.map((carrier) => carrier.key!);
  if (new Set(keyedValues).size !== keyedValues.length) return { state: 'continuity-unproven' };
  const assistants = ownedWindow.slice(1).filter((carrier) => carrier.role === 'assistant');
  if (assistants.length === 0) {
    return laterUserOffset >= 0 ? { state: 'foreign-user' } : { state: 'waiting' };
  }
  const assistant = assistants.at(-1)!;
  const reply = normalizeVisibleText(assistant.text);
  if (!assistant.key || !reply) return { state: 'continuity-unproven' };
  return { state: 'ready', reply, assistantKey: assistant.key };
}

export async function revalidateKeyedHarvest(
  page: any,
  baseline: AtomicTranscriptSnapshot | undefined,
  ownedUserKey: string,
  expected: {
    readonly reply: string;
    readonly assistantKey: string;
    readonly snapshotSignature: string;
  },
): Promise<{ state: 'ready'; reply: string } | { state: 'continuity-unproven' }> {
  if (!page || !baseline?.complete) return { state: 'continuity-unproven' };
  try {
    const nodes = page.locator(MESSAGE_NODE_SELECTOR);
    if (typeof nodes?.evaluateAll !== 'function') return { state: 'continuity-unproven' };
    const observed = await boundedBrowserRead(
      nodes.evaluateAll((allElements: Element[], args: {
        roleAttribute: string;
        userMessageStyle: string;
        unitKeyAttribute: string;
        assistantMessageStyle: string;
        assistantKey: string;
        turnSelector: string;
        inProgressSelector: string;
        actionSelector: string;
      }) => {
        const elements = allElements.filter((element) => element.getBoundingClientRect().height > 0);
        const valid = (value: string | null): value is string => Boolean(value && value.length >= 8);
        const canonicalKey = (element: Element): string | undefined => {
          for (const attribute of ['data-chatgpt-selection-message-id', 'data-message-id', 'data-turn-id', 'data-chatgpt-search-message-ids']) {
            const direct = element.getAttribute(attribute);
            if (valid(direct)) return `${attribute}:${direct}`;
            const descendant = Array.from(element.querySelectorAll(`[${attribute}]`))
              .find((candidate) => valid(candidate.getAttribute(attribute)));
            const value = descendant?.getAttribute(attribute) ?? null;
            if (valid(value)) return `${attribute}:${value}`;
          }
          return undefined;
        };
        const rows: Array<{ role: string; text: string; key?: string; domIndex: number; complete: boolean }> = [];
        for (let domIndex = 0; domIndex < elements.length; domIndex++) {
          const element = elements[domIndex]!;
          try {
            const rawStyle = element.querySelector(`[${args.roleAttribute}]`)?.getAttribute(args.roleAttribute);
            const style = rawStyle === args.userMessageStyle || rawStyle === args.assistantMessageStyle
              ? rawStyle
              : (element.getAttribute?.(args.unitKeyAttribute) ?? '').endsWith(':user') ? args.userMessageStyle : undefined;
            const role = style === args.userMessageStyle ? 'user' : style === args.assistantMessageStyle ? 'assistant' : '';
            rows.push({
              role,
              text: (element as HTMLElement).innerText,
              key: canonicalKey(element),
              domIndex,
              complete: true,
            });
          } catch {
            rows.push({ role: '', text: '', domIndex, complete: false });
          }
        }
        const matches = rows.filter((row) => row.key === args.assistantKey);
        if (matches.length !== 1) return { rows, assistantFinal: false };
        const row = matches[0]!;
        const element = elements[row.domIndex]!;
        const turn = element.closest(args.turnSelector) ?? element;
        const assistantFinal = !turn.querySelector(args.inProgressSelector)
          && Boolean(turn.querySelector(args.actionSelector));
        return { rows, assistantFinal };
      }, {
        roleAttribute: MESSAGE_AUTHOR_ROLE_ATTR,
        userMessageStyle: USER_MESSAGE_STYLE,
        unitKeyAttribute: MESSAGE_UNIT_KEY_ATTR,
        assistantMessageStyle: ASSISTANT_MESSAGE_STYLE,
        assistantKey: expected.assistantKey,
        turnSelector: CONVERSATION_TURN_SECTION_SELECTOR,
        inProgressSelector: ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
        actionSelector: ASSISTANT_TURN_ACTION_SELECTOR,
      }),
      MAX_LOCAL_READ_WAIT_MS,
      'keyed_harvest_revalidation_timeout',
    ) as {
      rows: Array<{ role: string; text: string; key?: string; domIndex: number; complete: boolean }>;
      assistantFinal: boolean;
    };
    if (!observed.assistantFinal) return { state: 'continuity-unproven' };
    const carriers: AtomicTranscriptCarrier[] = [];
    for (const row of observed.rows) {
      if (!row.complete || (row.role !== 'user' && row.role !== 'assistant') || typeof row.text !== 'string') {
        return { state: 'continuity-unproven' };
      }
      const role = row.role as PageMessage['role'];
      carriers.push({
        role,
        text: row.text,
        ...(validCarrierKey(row.key) ? { key: row.key } : {}),
        fingerprint: transcriptFingerprint(role, row.text),
        domIndex: row.domIndex,
      });
    }
    const revalidatedSnapshot = { complete: true, carriers } as const;
    const candidate = keyedHarvestCandidate(revalidatedSnapshot, baseline, ownedUserKey);
    if (
      atomicSnapshotSignature(revalidatedSnapshot) !== expected.snapshotSignature
      || candidate.state !== 'ready'
      || candidate.assistantKey !== expected.assistantKey
      || candidate.reply !== expected.reply
    ) {
      return { state: 'continuity-unproven' };
    }
    return { state: 'ready', reply: candidate.reply };
  } catch {
    return { state: 'continuity-unproven' };
  }
}

export async function probePageLiveness(page: any, browser: any): Promise<PageLiveness> {
  if (!page) return 'lost';
  try {
    if (typeof page.isClosed !== 'function') return 'unknown';
    const closed = page.isClosed();
    if (typeof closed !== 'boolean') return 'unknown';
    if (closed) return 'lost';
    if (!browser) return 'lost';
    if (typeof browser.isConnected !== 'function') return 'unknown';
    const connected = browser.isConnected();
    if (typeof connected !== 'boolean') return 'unknown';
    if (!connected) return 'lost';
    const nodes = page.locator(MESSAGE_NODE_SELECTOR);
    const readable = await boundedBrowserRead(
      Promise.resolve(nodes.count()).then((value) => (
        Number.isSafeInteger(Number(value)) && Number(value) >= 0
      )),
      MAX_LOCAL_READ_WAIT_MS,
      'page_liveness_probe_timeout',
    );
    return readable ? 'live' : 'unknown';
  } catch {
    return 'unknown';
  }
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

function normalizeReplyForStability(text: string): string {
  // The stability oracle is the original observed innerText; output normalization
  // remains exclusively in normalizeVisibleText at the incumbent publication seam.
  return text;
}

export function hasOwnedUserMessage(messages: readonly PageMessage[], expectedMarker: string): boolean {
  return messages.some((message) => message.role === 'user' && ownedPromptMatches(message.text, expectedMarker));
}

export function replyStabilityFingerprint(text: string): string {
  return normalizeReplyForStability(text);
}

export function replyStabilityMatches(currentReply: string, previousReply: string): boolean {
  if (!previousReply) return false;
  const current = replyStabilityFingerprint(currentReply);
  const previous = replyStabilityFingerprint(previousReply);
  return current.length > 0 && current === previous;
}

function selectedOwnedReplyText(input: {
  readonly messages: readonly PageMessage[];
  readonly snapshot: AtomicTranscriptSnapshot;
  readonly baselineSnapshot?: AtomicTranscriptSnapshot;
  readonly baselineCount: number;
  readonly marker: string;
  readonly ownedCarrierKey?: string;
}): string {
  if (hasOwnedUserMessage(input.messages, input.marker)) {
    const selected = resolveOwnedReplyWindow(input.messages, input.baselineCount, input.marker);
    return selected.lastOwnedAssistantMessageIndex === null
      ? ''
      : input.messages[selected.lastOwnedAssistantMessageIndex]?.text ?? '';
  }
  if (input.ownedCarrierKey) {
    const candidate = keyedHarvestCandidate(
      input.snapshot,
      input.baselineSnapshot,
      input.ownedCarrierKey,
    );
    if (candidate.state !== 'ready') return '';
    const assistant = input.snapshot.carriers.filter((carrier) => (
      carrier.role === 'assistant' && carrier.key === candidate.assistantKey
    ));
    return assistant.length === 1 ? assistant[0]!.text : '';
  }
  const users = input.messages.filter((message) => message.role === 'user');
  const assistants = input.messages.filter((message) => message.role === 'assistant');
  return users.length === 0 && assistants.length === 1 ? assistants[0]!.text : '';
}

function selectedOwnedReplyIdentity(input: {
  readonly messages: readonly PageMessage[];
  readonly snapshot: AtomicTranscriptSnapshot;
  readonly baselineSnapshot?: AtomicTranscriptSnapshot;
  readonly baselineCount: number;
  readonly marker: string;
  readonly ownedCarrierKey?: string;
}): string {
  if (hasOwnedUserMessage(input.messages, input.marker)) {
    const selected = resolveOwnedReplyWindow(input.messages, input.baselineCount, input.marker);
    const selectedIndex = selected.lastOwnedAssistantMessageIndex;
    if (selectedIndex === null) return '';
    const carrier = input.snapshot.carriers[selectedIndex];
    if (!carrier || carrier.role !== 'assistant') return '';
    if (!carrier.key) return 'unkeyed';
    const occurrences = input.snapshot.carriers.filter((candidate) => candidate.role === 'assistant' && candidate.key === carrier.key).length;
    return occurrences === 1 ? `key:${carrier.key}` : 'ambiguous';
  }
  if (input.ownedCarrierKey) {
    const candidate = keyedHarvestCandidate(input.snapshot, input.baselineSnapshot, input.ownedCarrierKey);
    if (candidate.state !== 'ready') return '';
    const matches = input.snapshot.carriers.filter((carrier) => carrier.role === 'assistant' && carrier.key === candidate.assistantKey);
    return matches.length === 1 ? `key:${candidate.assistantKey}` : 'ambiguous';
  }
  const assistants = input.snapshot.carriers.filter((carrier) => carrier.role === 'assistant');
  return assistants.length === 1 ? (assistants[0]!.key ? `key:${assistants[0]!.key}` : 'unkeyed') : '';
}

function selectedOwnedReplyCarrier(input: {
  readonly messages: readonly PageMessage[];
  readonly snapshot: AtomicTranscriptSnapshot;
  readonly baselineSnapshot?: AtomicTranscriptSnapshot;
  readonly baselineCount: number;
  readonly marker: string;
  readonly ownedCarrierKey?: string;
}): AtomicTranscriptCarrier | undefined {
  if (hasOwnedUserMessage(input.messages, input.marker)) {
    const index = resolveOwnedReplyWindow(input.messages, input.baselineCount, input.marker).lastOwnedAssistantMessageIndex;
    return index === null ? undefined : input.snapshot.carriers[index];
  }
  if (input.ownedCarrierKey) {
    const candidate = keyedHarvestCandidate(input.snapshot, input.baselineSnapshot, input.ownedCarrierKey);
    if (candidate.state !== 'ready') return undefined;
    const matches = input.snapshot.carriers.filter((carrier) => carrier.role === 'assistant' && carrier.key === candidate.assistantKey);
    return matches.length === 1 ? matches[0] : undefined;
  }
  const assistants = input.snapshot.carriers.filter((carrier) => carrier.role === 'assistant');
  return input.messages.every((message) => message.role !== 'user') && assistants.length === 1 ? assistants[0] : undefined;
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
  phase: BrowserTurnLivenessPhase = 'post_send_observation',
): ObservationHeartbeat {
  return {
    schema: 'observation-heartbeat/v1',
    phase,
    poll_count: pollCount,
    observation_state: classifyObservationLoopState(decision, stableReads),
    stable_reads: stableReads,
    completion_ready: completionReadySeen,
    last_reply_length: lastReply.length,
    last_reply_sha256_head: replyContentHashHead(lastReply),
  };
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
  const terminalState: TurnState = symptom === 'foreign_user_after_owned_send'
    || symptom === 'owned_prompt_not_observed'
    ? 'no_reply'
    : 'observation_uncertain';
  const ok = recordIncident(
    incidents,
    {
      eventClass: symptom === 'foreign_user_after_owned_send'
        || symptom === 'owned_prompt_not_observed'
        ? 'observation_exhausted'
        : 'post_send_observation_error',
      symptom,
      action: 'retain_owned_page_no_resend',
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
      terminalState,
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
  ownedCarrierKey?: string,
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
    const postBaselineUsers = messages
      .slice(Math.min(baselineCount, messages.length))
      .filter((message) => message.role === 'user').length;
    if (!markerCurrentlyVisible && !ownedCarrierKey) {
      const cause = ownedPromptEverSeen || postBaselineUsers === 1
        ? 'owned_carrier_unproven'
        : postBaselineUsers > 1
          ? 'owned_reply_boundary_unproven'
          : 'owned_prompt_not_observed';
      const state: TurnState = cause === 'owned_prompt_not_observed'
        ? 'no_reply'
        : 'observation_uncertain';
      incident(
        cause === 'owned_prompt_not_observed' ? 'observation_exhausted' : 'post_send_observation_error',
        cause,
        'retain_owned_page_no_resend',
      );
      return {
        page,
        browser,
        cleanupAction: 'preserve',
        result: compactResult(
          state,
          'invocation',
          cause,
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
    incident('observation_exhausted', 'observation_exhausted_no_resend', 'retain_owned_page_no_resend');
    return {
      page,
      browser,
      cleanupAction: 'preserve',
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
  hooks: StateLightPublicationHooks = {},
): StateLightPublicationResult {
  const finalPath = resolve(outputPath);
  const parent = dirname(finalPath);
  // Invocation ids are exact caller identity data and may contain path-sensitive
  // bytes. Staging uniqueness is intentionally identity-inert.
  void invocationId;
  const tempPath = join(parent, `.${basename(finalPath)}.${randomUUID()}.tmp`);
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
    const recurrencePath = browserTurnRecurrencePath(env);
    const target = readBrowserTurnProjectIdentity(env, recurrencePath);
    if (!target) mkdirSync(dirname(recurrencePath), { recursive: true });
    const pr = String(env.PACK_REVIEW_PR_NUMBER ?? '').trim();
    const agent = String(env.OPK_AGENT ?? env.PACK_FLOW_MANAGER ?? process.title ?? 'node').trim();
    appendFileSync(recurrencePath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...(target ? { projectId: target.projectId, repository: target.repository } : {}),
      ...(pr ? { pr } : {}),
      surface: 'browser-gpt-helper',
      event_class: incident.eventClass,
      observed_symptom: incident.symptom,
      ...(incident.action ? { action: incident.action } : {}),
      ...(incident.composerMutationDiagnostic ? {
        composer_mutation_diagnostic: incident.composerMutationDiagnostic,
      } : {}),
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

export function isPostSendTargetCrash(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Target crashed');
}

/**
 * After a load ChatGPT may take ~20 s or more to resume a still-running reply or to
 * start stream-recovery polling, and then shows Stop until that ends. Watch the
 * resume window; when Stop appears, wait up to two 10-minute rounds for it to go
 * away, and continue as soon as it does instead of finishing the round. The
 * window is skipped when there is nothing to resume: a product-error alert is
 * already shown, or the last turn carries the finished-reply actions.
 */
async function waitForExistingGeneration(
  page: any,
  deadlineMs: number,
): Promise<'idle' | 'settled' | 'busy'> {
  const startedAt = Date.now();
  const resumeWindowMs = await existingTurnHasNothingToResume(page, deadlineMs)
    ? 0
    : EXISTING_GENERATION_RESUME_WINDOW_MS;
  const waitUntil = Math.min(startedAt + EXISTING_GENERATION_WAIT_ROUND_MS * EXISTING_GENERATION_WAIT_ROUNDS, deadlineMs);
  let sawStop = false;
  let idleReads = 0;
  let recoveryStopPressed = false;
  for (let read = 0; ; read += 1) {
    if (read > 0) {
      if (waitUntil - Date.now() <= EXISTING_GENERATION_READ_INTERVAL_MS + MAX_LOCAL_READ_WAIT_MS * 2) {
        return sawStop && idleReads === 0 ? 'busy' : sawStop ? 'settled' : 'idle';
      }
      await sleep(page, EXISTING_GENERATION_READ_INTERVAL_MS);
    }
    if (Date.now() >= deadlineMs) return sawStop && idleReads === 0 ? 'busy' : sawStop ? 'settled' : 'idle';
    if (await locatorCount(page.locator(RENDERED_STOP_BUTTON_SELECTOR), deadlineMs) > 0) {
      sawStop = true;
      idleReads = 0;
      if (!recoveryStopPressed && await locatorCount(page.locator(CONNECTION_RECOVERY_STATUS_SELECTOR), deadlineMs) > 0) {
        recoveryStopPressed = true;
        try {
          await boundedBrowserRead(
            page.locator(RENDERED_STOP_BUTTON_SELECTOR).first().click({ timeout: MAX_LOCAL_READ_WAIT_MS }),
            MAX_LOCAL_READ_WAIT_MS,
            'connection_recovery_stop_timeout',
          );
        } catch {
          // A Stop that does not respond leaves the conversation busy as before.
        }
      }
      continue;
    }
    idleReads += 1;
    if (sawStop && idleReads >= EXISTING_GENERATION_IDLE_READS) return 'settled';
    if (!sawStop && Date.now() - startedAt >= resumeWindowMs) return 'idle';
  }
}

async function existingTurnHasNothingToResume(page: any, deadlineMs: number): Promise<boolean> {
  try {
    if (await locatorCount(page.locator('main [role="alert"]'), deadlineMs) > 0) return true;
    const lastTurn = page.locator(RENDERED_CONVERSATION_TURN_SECTION_SELECTOR).last();
    return await locatorCount(lastTurn.locator(ASSISTANT_TURN_ACTION_SELECTOR), deadlineMs) > 0;
  } catch {
    return false;
  }
}

async function locatorCount(
  locator: any,
  deadlineMs = Date.now() + MAX_LOCAL_READ_WAIT_MS,
): Promise<number> {
  const waitMs = Math.min(MAX_LOCAL_READ_WAIT_MS, deadlineMs - Date.now());
  if (waitMs <= 0) throw new BrowserOperationTimeoutError('locator_count');
  const timeoutCause = 'browser_operation_timeout:locator_count';
  try {
    return Number(await boundedBrowserRead(
      Promise.resolve(locator.count()),
      waitMs,
      timeoutCause,
    ));
  } catch (error) {
    if (isPostSendTargetCrash(error)) throw error;
    if (error instanceof Error && error.message === timeoutCause) throw error;
    return 0;
  }
}

async function locatorText(locator: any, timeoutMs = MAX_LOCAL_READ_WAIT_MS): Promise<string> {
  // innerText is the complete rendered message boundary; textContent is not an
  // ownership input because it can include screen-reader-only prefixes.
  try {
    return String(await locator.innerText({ timeout: timeoutMs }) ?? '');
  } catch (error) {
    if (isPostSendTargetCrash(error)) throw error;
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
    } catch (error) {
      if (isPostSendTargetCrash(error)) throw error;
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

async function readPageMessages(
  page: any,
  deadlineMs = Date.now() + MAX_LOCAL_READ_WAIT_MS,
): Promise<PageMessage[]> {
  return (await readPageObservation(page, undefined, undefined, false, deadlineMs)).messages;
}

export async function readPageObservation(
  page: any,
  expectedMarker?: string,
  baselineCount?: number,
  strictTranscriptCount = false,
  deadlineMs = Date.now() + MAX_LOCAL_READ_WAIT_MS,
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
      // At the hard boundary, consume only an already-settled snapshot. A zero-ms
      // race preserves the deadline while still letting an immediately available
      // DOM snapshot carry the final ownership/completion evidence.
      const snapshotWaitMs = Math.min(
        MAX_LOCAL_READ_WAIT_MS,
        Math.max(0, deadlineMs - Date.now()),
      );
      const observed = await boundedBrowserRead(
        evaluateAll.call(nodes, (allElements: Element[], args: {
          roleAttribute: string;
          userMessageStyle: string;
          unitKeyAttribute: string;
          assistantMessageStyle: string;
          generationSelector: string;
          continuationSelector: string;
          turnSelector: string;
          inProgressSelector: string;
          actionSelector: string;
        }) => {
          const elements = allElements.filter((element) => element.getBoundingClientRect().height > 0);
          const valid = (value: string | null): value is string => Boolean(value && value.length >= 8);
          const canonicalKey = (element: Element): string | undefined => {
            for (const attribute of ['data-chatgpt-selection-message-id', 'data-message-id', 'data-turn-id', 'data-chatgpt-search-message-ids']) {
              const direct = element.getAttribute(attribute);
              if (valid(direct)) return `${attribute}:${direct}`;
              const descendants = Array.from(element.querySelectorAll(`[${attribute}]`));
              const descendant = descendants.find((candidate) => valid(candidate.getAttribute(attribute)));
              const value = descendant?.getAttribute(attribute) ?? null;
              if (valid(value)) return `${attribute}:${value}`;
            }
            return undefined;
          };
          const rows: Array<{ role: string; text: string; key?: string; domIndex: number; complete: boolean; completionReady: boolean; continuationVisible: boolean }> = [];
          let observedAssistantNodes = 0;
          let observedMessageNodes = 0;
          for (let domIndex = 0; domIndex < elements.length; domIndex++) {
            const element = elements[domIndex]!;
            try {
              const rawStyle = element.querySelector(`[${args.roleAttribute}]`)?.getAttribute(args.roleAttribute);
              const style = rawStyle === args.userMessageStyle || rawStyle === args.assistantMessageStyle
                ? rawStyle
                : (element.getAttribute?.(args.unitKeyAttribute) ?? '').endsWith(':user') ? args.userMessageStyle : undefined;
              const role = style === args.userMessageStyle ? 'user' : style === args.assistantMessageStyle ? 'assistant' : '';
              if (role === 'user' || role === 'assistant') {
                observedMessageNodes += 1;
                if (role === 'assistant') observedAssistantNodes += 1;
              }
              const text = (element as HTMLElement).innerText;
              let completionReady = false;
              let continuationVisible = false;
              try {
                const turn = element.closest(args.turnSelector) ?? element;
                const visibleContinueButton = typeof turn.querySelectorAll === 'function'
                  && Array.from(turn.querySelectorAll('button')).some((button) => {
                    const name = (button.getAttribute('aria-label') || button.innerText || button.textContent || '').trim();
                    const style = typeof window === 'undefined'
                      ? { display: 'block', visibility: 'visible' }
                      : window.getComputedStyle(button);
                  const rect = button.getBoundingClientRect();
                  return /continue\s+generating/i.test(name)
                    && rect.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && !button.hasAttribute('disabled')
                    && button.getAttribute('aria-disabled') !== 'true';
                  });
                continuationVisible = Boolean(turn.querySelector(args.continuationSelector)) || visibleContinueButton;
                completionReady = !continuationVisible
                  && !turn.querySelector(args.inProgressSelector)
                  && Boolean(turn.querySelector(args.actionSelector));
              } catch {
                completionReady = false;
              }
              rows.push({ role, text, key: canonicalKey(element), domIndex, complete: true, completionReady, continuationVisible });
            } catch {
              rows.push({ role: '', text: '', domIndex, complete: false, completionReady: false, continuationVisible: false });
            }
          }
          let generationInProgress: boolean | 'unknown' = 'unknown';
          try {
            generationInProgress = Array.from(document.querySelectorAll(args.generationSelector))
              .some((node) => node.getBoundingClientRect().height > 0);
          } catch {
            generationInProgress = 'unknown';
          }
          let continueGeneratingVisible = false;
          try {
            continueGeneratingVisible = Array.from(document.querySelectorAll(args.continuationSelector))
              .some((node) => node.getBoundingClientRect().height > 0);
          } catch {
            generationInProgress = 'unknown';
          }
          return {
            rows,
            pageTurnEvidence: observedMessageNodes > 0
              ? { generationInProgress, observedAssistantNodes, continueGeneratingVisible }
              : undefined,
          };
        }, {
          roleAttribute: MESSAGE_AUTHOR_ROLE_ATTR,
          userMessageStyle: USER_MESSAGE_STYLE,
          unitKeyAttribute: MESSAGE_UNIT_KEY_ATTR,
          assistantMessageStyle: ASSISTANT_MESSAGE_STYLE,
          generationSelector: BROWSER_GPT_PAGE_TURN_GENERATION_SELECTOR,
          continuationSelector: CONTINUE_GENERATING_SELECTOR,
          turnSelector: CONVERSATION_TURN_SECTION_SELECTOR,
          inProgressSelector: ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
          actionSelector: ASSISTANT_TURN_ACTION_SELECTOR,
        }),
        snapshotWaitMs,
        'atomic_transcript_snapshot_timeout',
      ) as {
        rows: Array<{ role: string; text: string; key?: string; domIndex: number; complete: boolean; completionReady: boolean; continuationVisible: boolean }>;
        pageTurnEvidence?: BrowserGptPageTurnEvidence;
      };
      pageTurnEvidence = observed.pageTurnEvidence;
      for (const row of observed.rows) {
        if (!row.complete || (row.role !== 'user' && row.role !== 'assistant') || typeof row.text !== 'string') {
          transcriptIncomplete = true;
          continue;
        }
        const role = row.role as PageMessage['role'];
        const text = row.text;
        carriers.push({
          role,
          text,
          ...(validCarrierKey(row.key) ? { key: row.key } : {}),
          fingerprint: transcriptFingerprint(role, text),
          domIndex: row.domIndex,
          completionReady: row.completionReady,
          continuationVisible: row.continuationVisible,
        });
      }
      if (observed.rows.length !== carriers.length) transcriptIncomplete = true;
    } catch (error) {
      if (isPostSendTargetCrash(error)) throw error;
      if (strictTranscriptCount) return incomplete();
      transcriptIncomplete = true;
    }
  } else {
    // Compatibility for deterministic legacy fixtures. Production Playwright
    // locators always take the single in-page fixed-set branch above.
    let count: number;
    try {
      const countWaitMs = Math.min(
        MAX_LOCAL_READ_WAIT_MS,
        Math.max(0, deadlineMs - Date.now()),
      );
      count = Number(await boundedBrowserRead(
        Promise.resolve(nodes.count()),
        countWaitMs,
        'legacy_transcript_count_timeout',
      ));
      if (!Number.isSafeInteger(count) || count < 0) return incomplete();
    } catch (error) {
      if (isPostSendTargetCrash(error)) throw error;
      return incomplete();
    }
    const roleTimeouts = [MESSAGE_NODE_READ_TIMEOUT_MS, MESSAGE_NODE_READ_RETRY_TIMEOUT_MS]
      .slice(0, MESSAGE_NODE_READ_ATTEMPTS);
    for (let domIndex = 0; domIndex < count; domIndex++) {
      const node = nodes.nth(domIndex);
      let roleStyle = await readLocatorAttribute(node, MESSAGE_AUTHOR_ROLE_ATTR, roleTimeouts);
      if (!roleStyle && typeof node.locator === 'function') {
        roleStyle = await readLocatorAttribute(
          node.locator(`[${MESSAGE_AUTHOR_ROLE_ATTR}]`).first(),
          MESSAGE_AUTHOR_ROLE_ATTR,
          roleTimeouts,
        );
      }
      if (roleStyle !== USER_MESSAGE_STYLE && roleStyle !== ASSISTANT_MESSAGE_STYLE) {
        roleStyle = resolveMessageRoleStyle(
          roleStyle,
          await readLocatorAttribute(node, MESSAGE_UNIT_KEY_ATTR, roleTimeouts),
        ) ?? null;
      }
      const role = roleStyle === USER_MESSAGE_STYLE ? 'user' : roleStyle === ASSISTANT_MESSAGE_STYLE ? 'assistant' : undefined;
      if (role !== 'user' && role !== 'assistant') {
        transcriptIncomplete = true;
        continue;
      }
      const { text, readFailed } = await readMessageNodeText(node);
      if (readFailed) transcriptIncomplete = true;
      // Legacy fixtures without evaluateAll remain role/text-only. Stable keys
      // are never synthesized outside the production atomic callback.
      carriers.push({
        role,
        text,
        fingerprint: transcriptFingerprint(role, text),
        domIndex,
      });
    }
  }

  const messages: PageMessage[] = carriers.map(({ role, text }) => ({ role, text }));
  let ownedWindowCompletionReady = false;
  if (expectedMarker !== undefined && baselineCount !== undefined) {
    const { lastOwnedAssistantMessageIndex } = resolveOwnedReplyWindow(messages, baselineCount, expectedMarker);
    const ownedAssistant = lastOwnedAssistantMessageIndex === null
      ? undefined
      : carriers[lastOwnedAssistantMessageIndex];
    if (ownedAssistant) {
      const atomicCompletion = ownedAssistant.completionReady;
      ownedWindowCompletionReady = atomicCompletion === undefined
        ? await readAssistantNodeCompletionReady(
          nodes.nth(ownedAssistant.domIndex),
          MESSAGE_NODE_READ_TIMEOUT_MS,
        )
        : atomicCompletion;
    } else {
      const assistantCarriers = carriers.filter((carrier) => carrier.role === 'assistant');
      const soleAssistant = assistantCarriers.length === 1 ? assistantCarriers[0] : undefined;
      if (soleAssistant && soleAssistant.completionReady !== undefined) {
        ownedWindowCompletionReady = soleAssistant.completionReady;
      } else {
        // Legacy/recovery observation only; markerless publication still requires
        // the caller's existing independent ownership claim.
        ownedWindowCompletionReady = await readAssistantTurnCompletionReady(page, MESSAGE_NODE_READ_TIMEOUT_MS);
      }
    }
  }
  const complete = !transcriptIncomplete;
  return {
    messages,
    ownedWindowCompletionReady,
    transcriptIncomplete,
    snapshot: { complete, carriers },
    ...(pageTurnEvidence ? { pageTurnEvidence } : {}),
  };
}

export type SendLandingEvidence = 'landed' | 'not_landed' | 'ambiguous';

export async function classifySendLandingEvidence(
  page: any,
  promptText: string,
  conversationUrl?: string,
  deadlineMs = Date.now() + MAX_LOCAL_READ_WAIT_MS,
): Promise<SendLandingEvidence> {
  const normalizedPrompt = normalizeVisibleText(promptText);
  if (conversationUrl && conversationUuidFromUrl(conversationUrl)) return 'landed';
  const pageUrl = pageConversationUrl(page);
  if (pageUrl && conversationUuidFromUrl(pageUrl)) return 'landed';
  const messages = await readPageMessages(page, deadlineMs);
  if (messages.some((message) => message.role === 'user' && renderedPayloadMatches(normalizeVisibleText(message.text), normalizedPrompt))) {
    return 'landed';
  }
  let remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) return 'ambiguous';
  const composer = page.locator(COMPOSER_SELECTOR);
  if (await locatorCount(composer, deadlineMs) > 0) {
    remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) return 'ambiguous';
    const composerText = collapseUnicodeWhitespace(
      await locatorText(composer, Math.min(MAX_LOCAL_READ_WAIT_MS, remainingMs)),
    );
    if (renderedPayloadMatches(composerText, promptText)) return 'not_landed';
  }
  return 'ambiguous';
}

function recordProductWallAdvisory(
  profileKey: string,
  diagnostic: ProductWallDiagnostic,
  invocationId: string,
): void {
  if (diagnostic.wall_kind === 'none') return;
  recordStateLightAdvisoryWall(
    profileKey, diagnostic.wall_kind, `${diagnostic.wall_kind}_detected`,
    invocationId, undefined, undefined, diagnostic,
  );
}

async function readPostSendObservation(
  page: any,
  expectedMarker: string,
  baselineCount: number,
  deadlineMs: number,
  observeProductWall?: (diagnostic: ReturnType<typeof classifyProductWall>) => void,
): Promise<{
  readonly messages: PageMessage[];
  readonly wall: ReturnType<typeof classifyProductWall>;
  readonly pageTurnEvidence?: BrowserGptPageTurnEvidence;
  readonly ownedWindowCompletionReady: boolean;
  readonly transcriptIncomplete: boolean;
  readonly snapshot: AtomicTranscriptSnapshot;
}> {
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
    false,
    deadlineMs,
  );
  let wall: ReturnType<typeof classifyProductWall> = { wall_kind: 'none', matched_text: 'none', matched_selector: 'none' };
  try {
    const wallProbeMs = Math.min(POST_SEND_PRODUCT_WALL_PROBE_MS, deadlineMs - Date.now());
    if (wallProbeMs > 0) {
      wall = classifyProductWall(await productStatusText(page, wallProbeMs));
      observeProductWall?.(wall);
    }
  } catch (error) {
    if (isPostSendTargetCrash(error)) throw error;
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

async function maybeContinueGeneration(page: any, deadlineMs: number, assistantDomIndex: number, allowClick: boolean): Promise<boolean> {
  try {
    const assistant = page.locator(MESSAGE_NODE_SELECTOR).nth(assistantDomIndex);
    const turn = assistant.locator(ASSISTANT_TURN_ANCESTOR_XPATH).first();
    const continuation = locateContinueGeneratingControl(turn);
    if (await locatorCount(continuation, deadlineMs) !== 1 || !allowClick) return false;
    const button = continuation.first();
    if (typeof button.isVisible === 'function' && !await button.isVisible()) return false;
    if (typeof button.isEnabled === 'function' && !await button.isEnabled()) return false;
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) return false;
    await button.click({ timeout: Math.min(MAX_LOCAL_READ_WAIT_MS, remainingMs) });
    return true;
  } catch (error) {
    if (isPostSendTargetCrash(error)) throw error;
    try {
      // Preserve crash classification for adapters that cannot scope this read; never use this page-wide probe to click.
      await locatorCount(page.getByRole('button', { name: CONTINUE_GENERATING_BUTTON_NAME }), deadlineMs);
    } catch (probeError) {
      if (isPostSendTargetCrash(probeError)) throw probeError;
    }
    return false;
  }
}

async function readComposerReadiness(page: any, deadline: number): Promise<boolean> {
  try {
    const composer = page.locator(COMPOSER_SELECTOR);
    let remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    if (await locatorCount(composer, deadline) <= 0 || Date.now() >= deadline) return false;

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
  } catch (error) {
    if (isPostSendTargetCrash(error)) throw error;
    return false;
  }
}

type StateLightSendDeliveryWitness = 'owned_user_node' | 'composer_cleared' | 'owned_stop' | 'unproven';

async function readComposerTextForSendDelivery(
  composer: any,
  deadlineMs: number,
): Promise<string | undefined> {
  const waitMs = Math.min(MAX_LOCAL_READ_WAIT_MS, deadlineMs - Date.now());
  if (waitMs <= 0) return undefined;
  const timeoutCause = 'send_delivery_composer_read_timeout';
  try {
    return collapseUnicodeWhitespace(String(await boundedBrowserRead(
      Promise.resolve(composer.innerText({ timeout: waitMs })),
      waitMs,
      timeoutCause,
    )));
  } catch (error) {
    if (isPostSendTargetCrash(error)) throw error;
    return undefined;
  }
}

async function observeStateLightSendDelivery(
  page: any,
  composer: any,
  marker: string,
  baselineUserNodeCount: number,
  invocationDeadlineMs: number,
  deliveryProofWaitMs = MAX_LOCAL_READ_WAIT_MS,
  browser?: any,
  allowOwnedStopWitness = false,
): Promise<StateLightSendDeliveryWitness> {
  const proofDeadlineMs = Math.min(
    invocationDeadlineMs,
    Date.now() + Math.max(0, deliveryProofWaitMs),
  );
  while (true) {
    if (browserOrPageDefinitelyLost(page, browser)) return 'unproven';
    const attemptDeadlineMs = Math.min(
      invocationDeadlineMs,
      Math.max(Date.now() + 1, proofDeadlineMs),
    );
    if (allowOwnedStopWitness && await readFreshStopVisible(page, attemptDeadlineMs) === true) return 'owned_stop';
    const observation = await readPageObservation(
      page,
      undefined,
      undefined,
      true,
      attemptDeadlineMs,
    );
    if (!observation.transcriptIncomplete && observation.snapshot?.complete) {
      const currentUserMessages = observation.messages.filter((message) => message.role === 'user');
      if (
        currentUserMessages.length > baselineUserNodeCount
        && currentUserMessages.slice(baselineUserNodeCount).some((message) => ownedPromptMatches(message.text, marker))
      ) {
        return 'owned_user_node';
      }
    }
    const composerText = await readComposerTextForSendDelivery(composer, attemptDeadlineMs);
    if (composerText !== undefined && normalizeVisibleText(composerText).length === 0) {
      return 'composer_cleared';
    }
    if (allowOwnedStopWitness && await readFreshStopVisible(
      page, Math.min(invocationDeadlineMs, Math.max(Date.now() + 1, proofDeadlineMs)),
    ) === true) return 'owned_stop';
    const remainingMs = proofDeadlineMs - Date.now();
    if (remainingMs <= 0) return 'unproven';
    await sleep(page, Math.min(INITIAL_POLL_MS, remainingMs));
  }
}

async function dispatchStateLightSendAndObserveDelivery(input: {
  readonly page: any;
  readonly browser?: any;
  readonly composer: any;
  readonly sendButton: any;
  readonly hasSendButton: boolean;
  readonly marker: string;
  readonly baselineUserNodeCount: number;
  readonly sendWaitMs: number;
  readonly invocationDeadlineMs: number;
  readonly deliveryProofWaitMs?: number;
  readonly preSendAlertsAlreadyMarked?: boolean;
  readonly allowOwnedStopWitness?: boolean;
  readonly onDispatch?: () => void;
  readonly onActionError?: (diagnostic: string) => void;
}): Promise<{ sendCount: 0 | 1; witness: StateLightSendDeliveryWitness; actionError?: string; preDispatchTimeoutProven?: boolean }> {
  if (!input.preSendAlertsAlreadyMarked) {
    await markPreSendAlerts(input.page, Math.min(MAX_LOCAL_READ_WAIT_MS, input.sendWaitMs));
  }
  input.onDispatch?.();
  let actionError: string | undefined;
  try {
    if (input.hasSendButton) {
      await input.sendButton.click({ timeout: Math.min(MAX_LOCAL_READ_WAIT_MS, input.sendWaitMs) });
    } else {
      await input.composer.press('Enter', { timeout: Math.min(MAX_LOCAL_READ_WAIT_MS, input.sendWaitMs) });
    }
  } catch (error) {
    // Action completion is not delivery evidence. Observe once, under the
    // existing deadline, even when Playwright throws after dispatch.
    actionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    input.onActionError?.(actionError);
  }

  // A newly appearing Stop on this previously idle, owner-checked page is
  // delivery/ongoing generation even when the transcript is still catching up.
  const observedOwnedStop = input.allowOwnedStopWitness
    && await readFreshStopVisible(input.page, Math.min(input.invocationDeadlineMs, Date.now() + MAX_LOCAL_READ_WAIT_MS)) === true;
  const witness = observedOwnedStop
    ? 'owned_stop' as const
    : await observeStateLightSendDelivery(
      input.page,
      input.composer,
      input.marker,
      input.baselineUserNodeCount,
      input.invocationDeadlineMs,
      input.deliveryProofWaitMs,
      input.browser,
      input.allowOwnedStopWitness === true,
    );
  return {
    sendCount: witness === 'unproven' ? 0 : 1,
    witness,
    ...(actionError ? { actionError, preDispatchTimeoutProven: affirmativePreActionabilityTimeout(actionError) } : {}),
  };
}

const FRESH_SEND_WINDOW_MS = 30_000;
const FRESH_SEND_RESERVE_MS = 2 * FRESH_SEND_WINDOW_MS;
const FRESH_SEND_PREPARE_RESERVE_MS = 3 * MAX_LOCAL_READ_WAIT_MS;

/** A Stop already present before our click is foreign/busy, not this turn's delivery. */
async function readFreshStopVisible(page: any, deadlineMs: number): Promise<boolean | null> {
  try {
    const waitMs = Math.min(MAX_LOCAL_READ_WAIT_MS, deadlineMs - Date.now());
    if (waitMs <= 0) return null;
    const control = page.locator(RENDERED_STOP_BUTTON_SELECTOR);
    const count = await boundedBrowserRead(
      Promise.resolve(control.count()), waitMs, 'fresh_stop_read_timeout',
    );
    if (!Number.isSafeInteger(count) || count < 0) return null;
    if (count === 0) return false;
    if (typeof control.isVisible !== 'function') return null;
    return Boolean(await boundedBrowserRead(
      Promise.resolve(control.isVisible()), waitMs, 'fresh_stop_visibility_timeout',
    ));
  } catch {
    return null;
  }
}

async function waitForFreshSendButton(
  page: any,
  sendButton: any,
  assertOwnerAndPage: () => void,
  startedAt = Date.now(),
): Promise<'enabled' | 'never_enabled' | 'busy'> {
  // Both windows have their full 30s; polls do not sleep to a window boundary
  // when a button becomes enabled.
  for (let windowIndex = 1; windowIndex <= 2; windowIndex++) {
    const windowEnd = startedAt + windowIndex * FRESH_SEND_WINDOW_MS;
    while (Date.now() < windowEnd) {
      assertOwnerAndPage();
      const stop = await readFreshStopVisible(page, windowEnd);
      if (stop !== false) return 'busy';
      const remainingMs = windowEnd - Date.now();
      if (remainingMs <= 0) break;
      try {
        const count = await boundedBrowserRead(
          Promise.resolve(sendButton.count()),
          Math.min(MAX_LOCAL_READ_WAIT_MS, remainingMs),
          'fresh_send_button_count_timeout',
        );
        if (count === 1 && typeof sendButton.isVisible === 'function'
          && typeof sendButton.isEnabled === 'function') {
          const actionable = await boundedBrowserRead(
            Promise.all([sendButton.isVisible(), sendButton.isEnabled()]),
            Math.min(MAX_LOCAL_READ_WAIT_MS, Math.max(1, windowEnd - Date.now())),
            'fresh_send_button_actionability_timeout',
          );
          if (actionable[0] === true && actionable[1] === true) {
            assertOwnerAndPage();
            return 'enabled';
          }
        }
      } catch {
        // An unreadable actionability state is not affirmative permission to click.
        return 'busy';
      }
      const waitMs = Math.min(250, Math.max(0, windowEnd - Date.now()));
      if (waitMs > 0) await sleep(page, waitMs);
    }
  }
  return 'never_enabled';
}

/**
 * Playwright's timeout name alone cannot prove no click. A positive actionability
 * log saying the target was disabled is required; any recorded click action
 * invalidates that proof. Missing/truncated logs fail closed.
 */
function affirmativePreActionabilityTimeout(actionError: string | undefined): boolean {
  if (!actionError || !/^TimeoutError:\s*locator\.click:\s*Timeout\b/iu.test(actionError)
    || !/Call log:/u.test(actionError)) return false;
  const log = actionError.slice(actionError.indexOf('Call log:') + 'Call log:'.length);
  const lines = log.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  // Every recorded step must remain pre-dispatch, and the *last* step must
  // affirmatively be disabled. Unknown/partial action logs cannot permit resend.
  if (lines.length < 2 || !lines.some((line) => /waiting for element to be visible, enabled and stable/iu.test(line))
    || !/^- element is not enabled$/iu.test(lines.at(-1) ?? '')) return false;
  if (/performing click action|click action done|click done|scrolling into view|done scrolling|element is visible, enabled and stable|pointer(?:down|up)|mouse(?:down|up)|waiting for scheduled navigations|dispatch(?:ed|ing)/iu.test(log)) return false;
  return lines.every((line) => /^- (?:waiting for locator\b.*|locator resolved to\b.*|attempting click action|waiting for element to be visible, enabled and stable|element is not enabled|retrying click action(?:, attempt #\d+)?|waiting \d+ms)$/iu.test(line));
}

async function freshRetryDomGuards(input: {
  page: any;
  browser: any;
  composer: any;
  markerPayload: string;
  baselineUserNodeCount: number;
  deadlineMs: number;
}): Promise<boolean> {
  if (browserOrPageDefinitelyLost(input.page, input.browser)) return false;
  try {
    if (await readFreshStopVisible(input.page, input.deadlineMs) !== false) return false;
    const typed = await readComposerTextForSendDelivery(input.composer, input.deadlineMs);
    if (!renderedPayloadMatches(typed, input.markerPayload)) return false;
    const observed = await readPageObservation(
      input.page, undefined, undefined, true, input.deadlineMs,
    );
    return !observed.transcriptIncomplete && observed.snapshot?.complete === true
      && observed.messages.filter((message) => message.role === 'user').length === input.baselineUserNodeCount;
  } catch {
    return false;
  }
}

// A disabled-before-click action log is necessary but not sufficient to retry
// an existing-chat Send: the retained visible history must still be comparable.
// This is an ephemeral DOM continuity check, never backend non-delivery proof.
async function existingRetryDomGuards(input: {
  page: any;
  browser: any;
  composer: any;
  targetChatUrl: string;
  markedPayload: string;
  marker: string;
  baselineSnapshot?: AtomicTranscriptSnapshot;
  deadlineMs: number;
}): Promise<boolean> {
  const baseline = input.baselineSnapshot;
  if (!baseline?.complete || baseline.carriers.length === 0
    || !baseline.carriers.some((carrier) =>
      carrier.role === 'user' && normalizeVisibleText(carrier.text).length > 0)
    || baseline.carriers.some((carrier) =>
      !carrier.fingerprint || normalizeVisibleText(carrier.text).length === 0)) return false;
  const samePage = (): boolean => !browserOrPageDefinitelyLost(input.page, input.browser)
    && normalizeConversationUrl(String(input.page.url())) === input.targetChatUrl
    && readOwnedConversationIdentity(input.page, input.targetChatUrl).matched
    && Date.now() < input.deadlineMs;
  if (!samePage()) return false;
  try {
    if (await readComposerTextForSendDelivery(input.composer, input.deadlineMs)
      !== collapseUnicodeWhitespace(input.markedPayload)) return false;
    if (await readFreshStopVisible(input.page, input.deadlineMs) !== false) return false;
    const observed = await readPageObservation(
      input.page, undefined, undefined, true, input.deadlineMs,
    );
    if (observed.transcriptIncomplete || observed.snapshot?.complete !== true
      || observed.pageTurnEvidence?.generationInProgress !== false
      || observed.pageTurnEvidence?.continueGeneratingVisible === true) return false;
    const current = observed.snapshot.carriers;
    if (current.length < baseline.carriers.length || current.some((carrier) =>
      !carrier.fingerprint || normalizeVisibleText(carrier.text).length === 0
      || carrier.text.includes(input.marker))) return false;
    for (let i = 0; i < baseline.carriers.length; i++) {
      const before = baseline.carriers[i]!;
      const after = current[i]!;
      if (before.role !== after.role || before.fingerprint !== after.fingerprint
        || before.key !== after.key) return false;
    }
    if (current.slice(baseline.carriers.length).some((carrier) => carrier.role === 'user')) return false;
    // The final Stop/liveness/URL check follows the transcript read so a late
    // generation or redirect cannot turn a stale census into a second click.
    return await readFreshStopVisible(input.page, input.deadlineMs) === false && samePage();
  } catch {
    return false;
  }
}

async function waitForComposer(
  page: any,
  invocationDeadlineMs: number,
  useWholePreSendDeadline = false,
  observeProductWall?: (diagnostic: ReturnType<typeof classifyProductWall>) => void,
): Promise<{ state: 'ready' } | { state: TurnState; cause: string }> {
  // Preserve the legacy two-argument helper contract used by in-process tests.
  // Committed pre-send navigations explicitly opt into the whole invocation deadline.
  const readinessDeadline = useWholePreSendDeadline
    ? invocationDeadlineMs
    : Math.min(Date.now() + COMPOSER_READINESS_WAIT_MS, invocationDeadlineMs);
  while (true) {
    let remainingMs = readinessDeadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      const wall = classifyProductWall(
        await productStatusText(page, Math.min(MAX_LOCAL_READ_WAIT_MS, remainingMs)),
      );
      observeProductWall?.(wall);
      if (wall.state === 'recovery_required') return { state: 'recovery_required', cause: wall.cause };
    } catch {
      // Status-probe failures cannot veto the composer; the probe is advisory.
    }
    if (Date.now() >= readinessDeadline) break;
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

async function hasBlockingPageOverlay(page: any, deadlineMs: number): Promise<boolean> {
  return (await locatorCount(page.locator(BLOCKING_PAGE_OVERLAY_SELECTOR), deadlineMs)) > 0;
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
  insertionContext?: {
    insertionDeadlineMs?: number;
    diagnostic?: ComposerMutationDiagnosticV1;
  },
): Promise<PreSendComposerFailureCause | null> {
  const composer = page.locator(COMPOSER_SELECTOR);
  const insertionStart = Date.now();
  const insertionBudgetMs = deriveComposerInsertionBudgetMs(text);
  const insertionDeadlineMs = Math.min(insertionStart + insertionBudgetMs, invocationDeadlineMs);
  if (insertionContext) insertionContext.insertionDeadlineMs = insertionDeadlineMs;
  const exhausted = (branch: ComposerMutationDiagnosticV1['branch']): PreSendComposerFailureCause => {
    if (insertionContext) {
      const now = Date.now();
      insertionContext.diagnostic = {
        branch,
        insertionBudgetMs,
        textLength: text.length,
        elapsedMs: Math.max(0, now - insertionStart),
        remainingInvocationMs: Math.max(0, invocationDeadlineMs - now),
      };
    }
    return 'composer_mutation_budget_exhausted';
  };
  if (!(await readComposerReadiness(page, insertionDeadlineMs))) {
    // A late readiness read must not open another browser operation after
    // the insertion/invocation budget has expired.
    if (remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs) <= 0) {
      return exhausted('readiness_before_click');
    }
    // Distinguish proven absence from a present-but-unready node only when
    // classifying failure, not as a veto on the ordinary click/fill attempt.
    let composerAbsent = false;
    try {
      composerAbsent = await locatorCount(composer, insertionDeadlineMs) === 0;
    } catch {
      return exhausted('readiness_before_click');
    }
    try {
      let actionBudgetMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
      if (actionBudgetMs <= 0) return exhausted('budget_before_click');
      await composer.click({ timeout: actionBudgetMs });
      actionBudgetMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
      if (actionBudgetMs <= 0) return exhausted('budget_before_fill');
      await composer.fill(text, { timeout: actionBudgetMs });
      // If readiness recovered during the attempt, proceed to dispatch.
      if (await readComposerReadiness(page, insertionDeadlineMs)) return null;
    } catch {
      // The mutation was attempted; classify from the pre-attempt presence proof.
    }
    return composerAbsent ? 'composer_unavailable' : exhausted('readiness_before_click');
  }

  try {
    let actionBudgetMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
    if (actionBudgetMs <= 0) return exhausted('budget_before_click');
    await composer.click({ timeout: actionBudgetMs });
    if (Date.now() >= insertionDeadlineMs) return exhausted('after_click');

    actionBudgetMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
    if (actionBudgetMs <= 0) return exhausted('budget_before_fill');
    if (!(await readComposerReadiness(page, insertionDeadlineMs))) {
      return exhausted('readiness_before_fill');
    }
    actionBudgetMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
    if (actionBudgetMs <= 0) return exhausted('budget_before_fill2');
    await composer.fill(text, { timeout: actionBudgetMs });
    if (Date.now() >= insertionDeadlineMs) return 'composer_mutation_budget_exhausted';
    return null;
  } catch (error) {
    if (
      isPlaywrightTimeoutError(error)
      && await hasBlockingPageOverlay(page, invocationDeadlineMs)
    ) {
      return 'blocking_page_overlay';
    }
    return 'composer_mutation_budget_exhausted';
  }
}

async function createDedicatedTurnPage(
  browser: any,
  operationBudget: TurnOperationBudget,
): Promise<any> {
  const contexts = browser.contexts();
  if (contexts.length !== 1) throw new Error('ui_contract_mismatch:context_count');
  const waitMs = operationBudget.clampOperationWaitMs();
  if (waitMs <= 0) throw new BrowserOperationTimeoutError('new_page');
  const pagePromise = contexts[0].newPage();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pagePromise,
      new Promise<any>((_, reject) => {
        timer = setTimeout(() => reject(new BrowserOperationTimeoutError('new_page')), waitMs);
      }),
    ]);
  } catch (error) {
    pagePromise
      .then((latePage: any) => abandonLatePageHandle(latePage, RESOURCE_CLEANUP_BOUND_MS))
      .catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Reloading a conversation whose last reply ended on a recovery banner makes
 * ChatGPT show Stop for ~10 minutes without generating, so an existing-chat
 * turn continues in a tab already open on that conversation.
 */
type ConversationPageLookup = {
  readonly page?: any;
  readonly contextUsable: boolean;
};

async function findOpenConversationPage(
  browser: any,
  config: BrowserConfig,
): Promise<ConversationPageLookup> {
  if (config.newChat || !config.chatUrl) return { contextUsable: false };
  const target = normalizeConversationUrl(config.chatUrl);
  const contexts = browser.contexts();
  const contextUsable = contexts.length === 1 && typeof contexts[0]?.newPage === 'function';
  if (contexts.length !== 1 || typeof contexts[0].pages !== 'function') return { contextUsable };
  const candidates = (contexts[0].pages() as any[]).filter((candidate) => {
    try {
      return !candidate.isClosed?.() && ownedConversationIdentityMatches(String(candidate.url()), target);
    } catch {
      return false;
    }
  });
  const page = candidates.at(-1);
  if (!page) return { contextUsable };
  try {
    if (
      await locatorCount(page.locator(RENDERED_STOP_BUTTON_SELECTOR), Date.now() + MAX_LOCAL_READ_WAIT_MS) > 0
      && await locatorCount(page.locator(CONNECTION_RECOVERY_STATUS_SELECTOR), Date.now() + MAX_LOCAL_READ_WAIT_MS) === 0
    ) {
      return { contextUsable };
    }
  } catch {
    return { contextUsable };
  }
  return { page, contextUsable };
}

async function selectConversationPage(
  browser: any,
  chromium: { connectOverCDP: (endpoint: string, options?: { timeout?: number }) => Promise<any> },
  config: BrowserConfig,
  operationBudget: TurnOperationBudget,
): Promise<{ browser: any; page: any | undefined }> {
  let activeBrowser = browser;
  let lookup = await findOpenConversationPage(activeBrowser, config);
  let page = lookup.page;
  if (page && typeof page === 'object') cleanupAuthorityUnprovenPages.add(page);
  if (page || config.newChat || !config.chatUrl) return { browser: activeBrowser, page };
  if (lookup.contextUsable) return { browser: activeBrowser, page };

  const openWaitMs = operationBudget.clampOperationWaitMs();
  if (openWaitMs <= 0) throw new BrowserOperationTimeoutError('open_conversation_page');
  await createCdpPageTarget(
    config.cdp,
    normalizeConversationUrl(config.chatUrl),
    openWaitMs,
  );

  const releaseWaitMs = operationBudget.clampOperationWaitMs();
  await releaseCdpBrowser(
    activeBrowser,
    Math.max(0, Math.min(RESOURCE_CLEANUP_BOUND_MS, releaseWaitMs)),
  );

  const reconnectWaitMs = operationBudget.clampOperationWaitMs();
  if (reconnectWaitMs <= 0) throw new BrowserOperationTimeoutError('connect_over_cdp');
  activeBrowser = await chromium.connectOverCDP(config.cdp, {
    timeout: Math.min(30_000, reconnectWaitMs),
  });
  lookup = await findOpenConversationPage(activeBrowser, config);
  page = lookup.page;
  if (page && typeof page === 'object') cleanupAuthorityUnprovenPages.add(page);
  return { browser: activeBrowser, page };
}

async function navigateOwnedTurnPage(
  page: any,
  config: BrowserConfig,
  navigation: StateLightNavigationCounter,
  invocationDeadlineMs: number,
): Promise<void> {
  const target = config.newChat
    ? projectConversationPrefix(config.projectUrl ?? '')
    : normalizeConversationUrl(config.chatUrl ?? '');
  if (!target) throw new Error('ui_contract_mismatch:target_required');
  const remainingMs = invocationDeadlineMs - Date.now();
  if (remainingMs <= 0) throw new BrowserOperationTimeoutError('navigation');
  navigation.recordGoto();
  await page.goto(target, {
    waitUntil: 'commit',
    timeout: Math.min(STATE_LIGHT_NAVIGATION_TIMEOUT_MS, remainingMs),
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

function renderedPayloadMatches(actual: string | undefined, expected: string): boolean {
  return actual !== undefined && actual.replace(/\s+/gu, '') === expected.replace(/\s+/gu, '');
}

const FRESH_SEND_SLOT_LIMIT_MS = 61_000;

async function acquireFreshSendLock(profileKey: string, deadlineMs: number): Promise<DomainLock | undefined> {
  const waitDeadlineMs = Math.min(deadlineMs, Date.now() + FRESH_SEND_SLOT_LIMIT_MS);
  while (Date.now() < waitDeadlineMs) {
    const lock = acquireDomainLock(profileKey, 'fresh-send-composer', 0, { maxHoldMs: FRESH_SEND_SLOT_LIMIT_MS });
    if (lock) return lock;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, waitDeadlineMs - Date.now()))));
  }
  if (Date.now() >= deadlineMs) throw new Error('fresh_send_lock_deadline_exhausted');
  return undefined;
}

function releaseFreshSendLock(lock?: DomainLock): void {
  try { lock?.release(); } catch (error) {
    if (!(error instanceof Error) || error.message !== 'lock_ownership_lost') throw error;
  }
}

async function clearFreshComposerDraft(page: any): Promise<void> {
  try {
    await boundedBrowserRead(page.locator(COMPOSER_SELECTOR).fill('', { timeout: MAX_LOCAL_READ_WAIT_MS }),
      MAX_LOCAL_READ_WAIT_MS, 'fresh_composer_clear_timeout');
  } catch { /* Best-effort cleanup must not hide the pre-send failure. */ }
}

export const __testFreshSend = { acquireFreshSendLock, releaseFreshSendLock, renderedPayloadMatches, clearFreshComposerDraft };

async function runTurn(
  args: ParsedTurnArgs,
  recoveryHooks: StateLightRecoveryHooks = {},
  entryLivenessHeartbeat = false,
  heartbeatSchedulerReady?: (scheduler: TurnScopedHeartbeatScheduler) => void,
  freshCleanup?: FreshComposerCleanupContext,
): Promise<TurnRunOutcome> {
  let diagnostic: ProductWallDiagnostic = { wall_kind: 'none', matched_text: 'none', matched_selector: 'none' };
  freshCleanup ??= {};
  try {
    const outcome = await runTurnCore(args, recoveryHooks, entryLivenessHeartbeat, heartbeatSchedulerReady, (value) => {
      if (value.matched_text !== 'none') diagnostic = value;
    }, freshCleanup);
    return { ...outcome, result: { ...outcome.result, product_wall_diagnostic: diagnostic } };
  } finally {
    try {
      if (freshCleanup.page && !freshCleanup.sendAttempted
        && freshCleanup.sendLock?.isOwned?.() !== false
        && isBlankProjectSurfaceUrl(String(freshCleanup.page.url()), freshCleanup.projectUrl ?? '')) {
        await clearFreshComposerDraft(freshCleanup.page);
      }
    } catch {
      // A lost page must not hide the original pre-send result.
    } finally {
      releaseFreshSendLock(freshCleanup.sendLock);
      freshCleanup.sendLock = undefined;
    }
  }
}

async function runTurnCore(
  args: ParsedTurnArgs,
  recoveryHooks: StateLightRecoveryHooks,
  entryLivenessHeartbeat: boolean,
  heartbeatSchedulerReady: ((scheduler: TurnScopedHeartbeatScheduler) => void) | undefined,
  onProductWallDiagnostic: (diagnostic: ProductWallDiagnostic) => void,
  freshCleanup?: FreshComposerCleanupContext,
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
  ]);
  const invocationId = stringOption(args, 'invocation-id') ?? '';
  let profileKey = 'profile-unresolved';
  let browser: any;
  let page: any;
  let sendCount = 0;
  let pollCount = 0;
  const navigation = new StateLightNavigationCounter();
  let journalWriteFailed = false;
  const incidents: BrowserIncident[] = [];
  let afterSend = false;
  let sendAttempted = false;
  let ownedStopDeliveryObserved = false;
  let deliveryProofPendingRecovery = false;
  let ownershipForfeited = false;
  let sendSlotOwnerDeadlineMs = Infinity;
  let cancellationReceiptEmitted = false;
  let heartbeatScheduler: TurnScopedHeartbeatScheduler | undefined;
  let heartbeatPhase: BrowserTurnLivenessPhase = 'admitted_pre_send';
  let heartbeatDecision: PageObservationDecision = { state: 'waiting' };
  let heartbeatStableReads = 0;
  let heartbeatCompletionReady = false;
  let heartbeatLastReply = '';

  const setHeartbeatPhase = (phase: BrowserTurnLivenessPhase, pulse = true): void => {
    heartbeatPhase = phase;
    if (pulse) heartbeatScheduler?.pulse();
  };

  const incident = (
    eventClass: string,
    symptom: string,
    action?: string,
    composerMutationDiagnostic?: ComposerMutationDiagnosticV1,
  ): void => {
    const ok = recordIncident(
      incidents,
      {
        eventClass,
        symptom,
        ...(action ? { action } : {}),
        ...(composerMutationDiagnostic ? { composerMutationDiagnostic } : {}),
      },
      invocationId,
      navigation.snapshot(),
    );
    if (!ok) journalWriteFailed = true;
  };

  const observeProductWall = (wall: ReturnType<typeof classifyProductWall>): void => {
    if (!('wall_kind' in wall) || wall.matched_text === 'none') return;
    onProductWallDiagnostic(wall);
    if (wall.wall_kind !== 'none') {
      try { recordProductWallAdvisory(profileKey, wall, invocationId); } catch { /* advisory I/O is fail-open */ }
    }
  };

  try {
    if (!invocationId) throw new Error('input_invalid:invocation_id_required');
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
    const destination = destinationIdentity(requireOption(args, 'output'));
    const config = baseConfig;
    const marker = generateOwnedPromptMarker();
    admitStateLightTurnObservation({ profileKey, invocationId, marker });
    const invocationStartedAt = Date.now();
    const invocationDeadlineMs = invocationStartedAt + config.timeoutMs;
    const invocationBudget = createTurnOperationBudget(config.timeoutMs, invocationStartedAt);
    if (entryLivenessHeartbeat) {
      const livenessTiming = resolveBrowserTurnLivenessTiming();
      heartbeatScheduler = startTurnScopedHeartbeatScheduler({
        timing: livenessTiming,
        emit: () => emit(buildObservationHeartbeat(
          heartbeatDecision,
          heartbeatStableReads,
          pollCount,
          heartbeatCompletionReady,
          heartbeatLastReply,
          heartbeatPhase,
        )),
      });
      heartbeatSchedulerReady?.(heartbeatScheduler);
    }
    if (!config.newChat && config.chatUrl) {
      transitionStateLightTurnObservation({
        profileKey,
        invocationId,
        phase: 'prepared',
        reason: 'existing_conversation_bound_before_send',
        conversationUrl: normalizeConversationUrl(config.chatUrl),
      });
    }

    const profileWaitMs = invocationBudget.clampOperationWaitMs();
    if (profileWaitMs <= 0) throw new BrowserOperationTimeoutError('profile_verification');
    const profile = await boundedBrowserRead(
      verifyProfile(config, invocationBudget),
      profileWaitMs,
      'browser_operation_timeout:profile_verification',
    );
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

    if (config.newChat && freshCleanup) {
      freshCleanup.sendLock = await acquireFreshSendLock(profileKey, invocationDeadlineMs);
    }
    const chromium = loadChromium();
    const connectWaitMs = invocationBudget.clampOperationWaitMs();
    if (connectWaitMs <= 0) throw new BrowserOperationTimeoutError('connect_over_cdp');
    browser = await chromium.connectOverCDP(config.cdp, { timeout: Math.min(30_000, connectWaitMs) });
    const selection = await selectConversationPage(browser, chromium, config, invocationBudget);
    browser = selection.browser;
    page = selection.page;
    if (page && typeof page === 'object') {
      // Existing tabs and URL-reselected CDP targets are not direct creation
      // handles; never infer cleanup authority from matching URLs.
      cleanupAuthorityUnprovenPages.add(page);
    }
    if (!page) {
      page = await createDedicatedTurnPage(browser, invocationBudget);
      if (config.newChat && freshCleanup) {
        freshCleanup.page = page;
        freshCleanup.projectUrl = config.projectUrl;
      }
      await navigateOwnedTurnPage(page, config, navigation, invocationDeadlineMs);
    }

    let baselineCount = 0;
    let baselineUserNodeCount = 0;
    let baselineSnapshot: AtomicTranscriptSnapshot | undefined;
    let ownedConversationUrl: string | undefined;

    const returnComposerMutationFailure = (
      cause: PreSendComposerFailureCause,
      diagnostic?: ComposerMutationDiagnosticV1,
    ): TurnRunOutcome => {
      incident('invocation_blocker', cause, 'return_local_error', diagnostic);
      return {
        page,
        browser,
        result: compactResult(
          cause === 'composer_unavailable' ? 'send_failed' : 'driver_error',
          'invocation',
          cause,
          invocationId,
          profileKey,
          sendCount,
          pollCount, navigation, incidents,
          { ...(diagnostic ? { composer_mutation_diagnostic: diagnostic } : {}) },
          journalWriteFailed,
        ),
      };
    };

    const captureBaseline = async (): Promise<TurnRunOutcome | null> => {
      const baseline = await readPageObservation(
        page,
        undefined,
        undefined,
        true,
        invocationDeadlineMs,
      );
      if (baseline.transcriptIncomplete || !baseline.snapshot?.complete) {
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
      baselineUserNodeCount = baseline.messages.filter((message) => message.role === 'user').length;
      return null;
    };

    const markedPayload = wrapOwnedPromptPayload(marker, snapshot.text);
    const assertFreshOwner = (): void => {
      if (Date.now() >= sendSlotOwnerDeadlineMs) {
        throw new Error('state_light_new_chat_owner_pre_dispatch_deadline_exhausted');
      }
      if (freshCleanup?.sendLock?.isOwned?.() === false) {
        ownershipForfeited = true;
        throw new Error('state_light_new_chat_send_slot_owner_lost');
      }
      let observedUrl = '';
      try { observedUrl = String(page.url()); } catch { /* fail closed */ }
      if (!isBlankProjectSurfaceUrl(observedUrl, config.projectUrl ?? '')) {
        ownershipForfeited = true;
        throw new Error('ui_contract_mismatch:fresh_conversation_surface_unavailable');
      }
    };
    const requireFreshSendReserve = (additionalPreSendMs: number): void => {
      assertFreshOwner();
      const availableUntil = Math.min(invocationDeadlineMs, sendSlotOwnerDeadlineMs);
      if (Date.now() + additionalPreSendMs + FRESH_SEND_RESERVE_MS > availableUntil) {
        throw new Error('state_light_new_chat_send_budget_unavailable');
      }
    };
    // Reserve bounded composer insertion time after the readiness wait.
    const composerReadinessDeadline = (): number => Math.max(
      Date.now(),
      Math.min(invocationDeadlineMs, sendSlotOwnerDeadlineMs)
        - deriveComposerInsertionBudgetMs(markedPayload),
    );

    // A URL is only a candidate. A complete conversation-local census and
    // exactly one owned user carrier/marker token are required before *any*
    // fresh claim, URL transition or receipt on the early and recovery paths.
    const freshProjectMarkerProven = async (
      candidatePage: any,
      conversationUrl: string,
      observationDeadlineMs: number,
    ): Promise<boolean> => {
      if (!config.newChat || !config.projectUrl
        || !projectConversationUrlMatchesProject(conversationUrl, config.projectUrl)) return false;
      try {
        const observedPageUrl = String(candidatePage.url());
        if (!projectConversationUrlMatchesProject(observedPageUrl, config.projectUrl)
          || conversationUuidFromUrl(observedPageUrl) !== conversationUuidFromUrl(conversationUrl)) return false;
        const remainingMs = observationDeadlineMs - Date.now();
        if (remainingMs <= 0) return false;
        const census = await boundedBrowserRead(
          readRecoveryAuthoritativeUserMessages(candidatePage),
          Math.min(MAX_LOCAL_READ_WAIT_MS, remainingMs),
          'fresh_conversation_marker_census_timeout',
        );
        if (census.incomplete) return false;
        const count = recoveryMarkerCardinality(census.messages, marker);
        return count.matchingUserCarrierCount === 1 && count.exactMarkerTokenCount === 1;
      } catch {
        return false;
      }
    };

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

    const sendOwnedFreshPrompt = async (): Promise<TurnRunOutcome | null> => {
      setHeartbeatPhase('composer_dispatch');
      if (freshCleanup) freshCleanup.markedPayload = markedPayload;
      // Preparation, stale-draft cleanup, baseline and insertion must not
      // consume either of the two readiness windows.
      requireFreshSendReserve(deriveComposerInsertionBudgetMs(markedPayload) + FRESH_SEND_PREPARE_RESERVE_MS);
      if (cleanupAuthorityUnprovenPages.has(page)) {
        incident('invocation_blocker', 'fresh_composer_ownership_unproven', 'preserve_reselected_page');
        return {
          page, browser, cleanupAction: 'preserve',
          result: compactResult(
            'ui_contract_mismatch', 'invocation', 'fresh_composer_ownership_unproven',
            invocationId, profileKey, sendCount, pollCount, navigation, incidents, {}, journalWriteFailed,
          ),
        };
      }
      const stopBeforeDraft = await readFreshStopVisible(page, invocationDeadlineMs);
      if (stopBeforeDraft !== false) {
        incident('invocation_blocker', 'fresh_conversation_busy_before_send', 'preserve_page');
        return {
          page, browser, cleanupAction: 'preserve',
          result: compactResult(
            'conversation_busy', 'invocation', 'fresh_conversation_busy_before_send',
            invocationId, profileKey, sendCount, pollCount, navigation, incidents, {}, journalWriteFailed,
          ),
        };
      }
      assertFreshOwner();
      requireFreshSendReserve(deriveComposerInsertionBudgetMs(markedPayload) + FRESH_SEND_PREPARE_RESERVE_MS);
      if (freshCleanup) {
        freshCleanup.page = page;
        freshCleanup.markedPayload = markedPayload;
      }
      const insertionContext: { insertionDeadlineMs?: number; diagnostic?: ComposerMutationDiagnosticV1 } = {};
      const mutationFailure = await mutateComposerOrCause(page, markedPayload, invocationDeadlineMs, insertionContext);
      assertFreshOwner();
      if (mutationFailure) return returnComposerMutationFailure(mutationFailure, insertionContext.diagnostic);
      requireFreshSendReserve(FRESH_SEND_PREPARE_RESERVE_MS);
      if (!await readComposerReadiness(page, invocationDeadlineMs)) {
        return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      }
      const composer = page.locator(COMPOSER_SELECTOR);
      if (!renderedPayloadMatches(await readComposerTextForSendDelivery(composer, invocationDeadlineMs), markedPayload)) {
        return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      }
      const sendButton = page.locator(SEND_BUTTON_SELECTOR);
      await markPreSendAlerts(page, Math.min(MAX_LOCAL_READ_WAIT_MS, invocationDeadlineMs - Date.now()));
      requireFreshSendReserve(0);
      if (await readFreshStopVisible(page, invocationDeadlineMs) !== false) {
        incident('invocation_blocker', 'fresh_conversation_busy_before_send', 'preserve_page');
        return {
          page, browser, cleanupAction: 'preserve',
          result: compactResult(
            'conversation_busy', 'invocation', 'fresh_conversation_busy_before_send',
            invocationId, profileKey, sendCount, pollCount, navigation, incidents, {}, journalWriteFailed,
          ),
        };
      }
      // The last Stop probe is awaited: reserve both full windows after it.
      requireFreshSendReserve(0);
      const readinessStartedAtMs = Date.now();
      const readinessDeadlineMs = readinessStartedAtMs + FRESH_SEND_RESERVE_MS;
      const readiness = await waitForFreshSendButton(page, sendButton, assertFreshOwner, readinessStartedAtMs);
      assertFreshOwner();
      if (readiness === 'busy') {
        incident('invocation_blocker', 'fresh_send_actionability_unknown_or_busy', 'retain_page');
        return {
          page, browser, cleanupAction: 'preserve',
          result: compactResult(
            'ui_contract_mismatch', 'invocation', 'fresh_send_actionability_unknown_or_busy',
            invocationId, profileKey, sendCount, pollCount, navigation, incidents, {}, journalWriteFailed,
          ),
        };
      }
      if (readiness === 'never_enabled' || Date.now() >= readinessDeadlineMs) {
        incident('invocation_blocker', 'fresh_send_button_never_enabled', 'cleanup_own_unsent_payload');
        return {
          page, browser,
          result: compactResult(
            'send_failed', 'invocation', 'fresh_send_button_never_enabled',
            invocationId, profileKey, sendCount, pollCount, navigation, incidents, {}, journalWriteFailed,
          ),
        };
      }
      const beforeClick = (): void => {
        assertFreshOwner();
        if (Date.now() >= invocationDeadlineMs) throw new Error('state_light_new_chat_send_budget_unavailable');
        if (Date.now() >= readinessDeadlineMs) throw new Error('fresh_send_readiness_deadline_exhausted');
        transitionStateLightTurnObservation({
          profileKey, invocationId, phase: 'dispatching', reason: 'dispatch_boundary_entered',
        });
        sendAttempted = true;
        if (freshCleanup) freshCleanup.sendAttempted = true;
      };
      // The composer can change during Send readiness polling. Do not send a
      // different draft as though it were the invocation's marked payload.
      if (!renderedPayloadMatches(await readComposerTextForSendDelivery(
        composer, Math.min(invocationDeadlineMs, readinessDeadlineMs),
      ), markedPayload)) throw new Error('ui_contract_mismatch:fresh_owned_payload_changed_before_click');
      assertFreshOwner();
      const sendAction = async () => await dispatchStateLightSendAndObserveDelivery({
        page, browser, composer, sendButton, hasSendButton: true, marker,
        baselineUserNodeCount, sendWaitMs: Math.max(1, Math.min(MAX_LOCAL_READ_WAIT_MS, readinessDeadlineMs - Date.now())),
        invocationDeadlineMs, preSendAlertsAlreadyMarked: true, allowOwnedStopWitness: true,
        onDispatch: beforeClick,
        onActionError: (diagnostic) => incident('send_transport_error', diagnostic, 'observe_delivery_no_blind_resend'),
      });
      let delivery = await sendAction();
      if (delivery.sendCount === 0
        && delivery.witness === 'unproven'
        && delivery.preDispatchTimeoutProven === true
        && Date.now() < readinessDeadlineMs
        && await freshRetryDomGuards({
          page, browser, composer, markerPayload: markedPayload, baselineUserNodeCount,
          deadlineMs: Math.min(invocationDeadlineMs, Date.now() + MAX_LOCAL_READ_WAIT_MS * 2),
        })) {
        // Positive Playwright actionability proof and all independent current
        // DOM/owner checks are required; no third attempt after this second call.
        assertFreshOwner();
        delivery = await sendAction();
      }
      if (delivery.sendCount === 0) {
        if (browserOrPageDefinitelyLost(page, browser)) {
          deliveryProofPendingRecovery = true;
          return null;
        }
        incident('send_observation_error', 'send_delivery_unproven', 'retain_owned_page_no_resend');
        return {
          cleanupAction: 'preserve', page, browser,
          result: compactResult(
            'send_failed', 'invocation', delivery.actionError ?? 'send_delivery_unproven',
            invocationId, profileKey, sendCount, pollCount, navigation, incidents,
            { send_attempted: true, ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
            journalWriteFailed,
          ),
        };
      }
      sendCount += delivery.sendCount;
      releaseFreshSendLock(freshCleanup?.sendLock);
      if (freshCleanup) freshCleanup.sendLock = undefined;
      if (delivery.witness === 'owned_stop') ownedStopDeliveryObserved = true;
      afterSend = true;
      setHeartbeatPhase('post_send_observation');
      transitionStateLightTurnObservation({
        profileKey, invocationId, phase: 'sent_unbound', reason: 'send_observed_fresh_chat',
        sendCount, sendWitness: 'numeric_send_count',
      });
      return null;
    };

    const sendOwnedPrompt = async (): Promise<TurnRunOutcome | null> => {
      if (config.newChat) return await sendOwnedFreshPrompt();
      setHeartbeatPhase('composer_dispatch');
      const insertionContext: { insertionDeadlineMs?: number; diagnostic?: ComposerMutationDiagnosticV1 } = {};
      const mutationFailure = await mutateComposerOrCause(
        page,
        markedPayload,
        invocationDeadlineMs,
        insertionContext,
      );
      if (mutationFailure) return returnComposerMutationFailure(mutationFailure, insertionContext.diagnostic);
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
      const hasSendButton = await locatorCount(
        sendButton,
        Math.min(insertionDeadlineMs, invocationDeadlineMs),
      ) > 0;
      remainingMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
      if (remainingMs <= 0) return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      if (!(await readComposerReadiness(page, insertionDeadlineMs))) {
        return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      }
      let sendWaitMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
      if (sendWaitMs <= 0) return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      await markPreSendAlerts(page, Math.min(MAX_LOCAL_READ_WAIT_MS, sendWaitMs));
      sendWaitMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
      if (sendWaitMs <= 0) return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      // Reapply existing read-only destination predicates after composer mutation
      // and immediately before entering the actual dispatch boundary.
      if (!config.newChat) {
        const identity = readOwnedConversationIdentity(page, normalizeConversationUrl(config.chatUrl ?? ''));
        if (!identity.matched) {
          return returnOwnedConversationIdentityMismatch(
            identity, page, browser, invocationId, profileKey, sendCount,
            pollCount, navigation, incidents, journalWriteFailed, incident, false,
          );
        }
      } else {
        let currentUrl = '';
        try { currentUrl = String(page.url()); } catch { /* fail closed */ }
        if (!isBlankProjectSurfaceUrl(currentUrl, config.projectUrl ?? '')) {
          incident('invocation_blocker', 'fresh_conversation_surface_unavailable', 'return_local_error');
          return {
            page,
            browser,
            result: compactResult(
              'ui_contract_mismatch', 'invocation', 'fresh_conversation_surface_unavailable',
              invocationId, profileKey, sendCount, pollCount, navigation, incidents, {},
              journalWriteFailed,
            ),
          };
        }
      }
      const dispatchExisting = async (clickWaitMs: number) =>
        await dispatchStateLightSendAndObserveDelivery({
          page,
          browser,
          composer,
          sendButton,
          hasSendButton,
          marker,
          baselineUserNodeCount,
          sendWaitMs: clickWaitMs,
          invocationDeadlineMs,
          preSendAlertsAlreadyMarked: true,
          onDispatch: () => {
            transitionStateLightTurnObservation({
              profileKey, invocationId, phase: 'dispatching', reason: 'dispatch_boundary_entered',
            });
            sendAttempted = true;
          },
          onActionError: (diagnostic) => incident('send_transport_error', diagnostic, 'observe_delivery_no_resend'),
        });
      let delivery = await dispatchExisting(sendWaitMs);
      if (hasSendButton && delivery.sendCount === 0 && delivery.witness === 'unproven'
        && delivery.preDispatchTimeoutProven === true
        && await existingRetryDomGuards({
          page, browser, composer, targetChatUrl: normalizeConversationUrl(config.chatUrl ?? ''),
          markedPayload, marker, baselineSnapshot, deadlineMs: invocationDeadlineMs,
        })) {
        // Only the first click's actual positive non-dispatch action result grants
        // this one optional repeat; an uncertain first action or Enter never does.
        const repeatWaitMs = Math.min(MAX_LOCAL_READ_WAIT_MS, invocationDeadlineMs - Date.now());
        if (repeatWaitMs > 0) delivery = await dispatchExisting(repeatWaitMs);
      }
      if (delivery.sendCount === 0) {
        if (browserOrPageDefinitelyLost(page, browser)) {
          deliveryProofPendingRecovery = true;
          if (!config.newChat) ownedConversationUrl = pageConversationUrl(page) ?? ownedConversationUrl;
          return null;
        }
        incident('send_observation_error', 'send_delivery_unproven', 'retain_owned_page_no_resend');
        return {
          cleanupAction: 'preserve',
          page,
          browser,
          result: compactResult(
            'send_failed',
            'invocation',
            delivery.actionError ?? 'send_delivery_unproven',
            invocationId,
            profileKey,
            sendCount,
            pollCount,
            navigation,
            incidents,
            { send_attempted: true, ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
            journalWriteFailed,
          ),
        };
      }
      sendCount += delivery.sendCount;
      afterSend = true;
      setHeartbeatPhase('post_send_observation');
      if (!config.newChat && config.chatUrl) {
        const conversationUrl = normalizeConversationUrl(config.chatUrl);
        transitionStateLightTurnObservation({
          profileKey,
          invocationId,
          phase: 'sent_unharvested',
          reason: 'send_observed_existing_chat',
          sendCount,
          sendWitness: 'numeric_send_count',
          conversationUrl,
        });
        emitCancellationReceipt(conversationUrl);
      } else {
        transitionStateLightTurnObservation({
          profileKey,
          invocationId,
          phase: 'sent_unbound',
          reason: 'send_observed_fresh_chat',
          sendCount,
          sendWitness: 'numeric_send_count',
        });
      }
      return null;
    };

    if (config.newChat) {
      sendSlotOwnerDeadlineMs = invocationDeadlineMs;
      {
        assertFreshOwner();
        const returnFreshPrepareFailure = (
          prepared: Awaited<ReturnType<typeof prepareStateLightFreshConversation>>,
        ): TurnRunOutcome | null => {
          if (prepared.state === 'ready') return null;
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
          if (composerState.state === 'ready' || composerState.cause === 'composer_unavailable') return null;
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
          invocationDeadlineMs,
          Date.now,
          observeProductWall,
        );
        assertFreshOwner();
        const initialPrepareFailure = returnFreshPrepareFailure(initialPrepare);
        if (initialPrepareFailure) return initialPrepareFailure;

        let composerState = await waitForComposer(page, composerReadinessDeadline(), true, observeProductWall);
        assertFreshOwner();
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
              invocationDeadlineMs,
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
              invocationDeadlineMs,
              Date.now,
              observeProductWall,
            );
            assertFreshOwner();
            const preparedFailure = returnFreshPrepareFailure(prepared);
            if (preparedFailure) return preparedFailure;
            composerState = await waitForComposer(page, composerReadinessDeadline(), true, observeProductWall);
            assertFreshOwner();
            const composerFailure = returnComposerBlocker(composerState);
            if (composerFailure) return composerFailure;
            sendAuthorized = true;
          }

          if (sendAuthorized) {
            if (freshCleanup?.sendLock?.isOwned?.() === false) {
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
            assertFreshOwner();
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
                invocationDeadlineMs,
              );
              if (landingEvidence === 'not_landed' && !ownedStopDeliveryObserved && !pageConversationUrl(page)) {
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
          if (!isSupportedChatGptConversationUrl(conversationUrl)) {
            incident('send_observation_error', 'fresh_conversation_url_unsupported', 'return_local_error');
            return {
              page,
              browser,
              result: compactResult(
                'driver_error',
                'invocation',
                'fresh_conversation_url_unsupported',
                invocationId,
                profileKey,
                sendCount,
                pollCount,
                navigation,
                incidents,
                { conversation_id: conversationUrl },
                journalWriteFailed,
              ),
            };
          }

          // The early URL alone cannot bind an invocation. The incumbent
          // post-send observer can bind later once the marker becomes visible.
          if (!(await freshProjectMarkerProven(page, conversationUrl, invocationDeadlineMs))) {
            incident('send_observation_deferred', 'fresh_conversation_marker_unproven', 'continue_observing_after_send');
            claimed = true;
            break;
          }
          if (freshCleanup?.sendLock?.isOwned?.() === false) {
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
              invocationDeadlineMs,
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
            if (!deliveryProofPendingRecovery) {
              transitionStateLightTurnObservation({
                profileKey,
                invocationId,
                phase: 'sent_unharvested',
                reason: 'fresh_conversation_url_bound',
                sendCount,
                sendWitness: 'numeric_send_count',
                conversationUrl,
              });
            }
            claimed = true;
            ownedConversationUrl = conversationUrl;
            if (!deliveryProofPendingRecovery) emitCancellationReceipt(conversationUrl);
            break;
          }
        }

        if (!claimed) {
          const landingEvidence = await classifySendLandingEvidence(
            page,
            markedPayload,
            lastAttemptConversationUrl,
            invocationDeadlineMs,
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

      // A long existing chat gets an initial hydration window before one
      // optional same-URL reopen. Navigation and renewed readiness retain a
      // positive share of the original absolute invocation deadline.
      const postReopenReserveMs = COMPOSER_READINESS_WAIT_MS
        + deriveComposerInsertionBudgetMs(markedPayload) + MAX_LOCAL_READ_WAIT_MS;
      const mayReopenComposer = invocationDeadlineMs - Date.now()
        > EXISTING_GENERATION_RESUME_WINDOW_MS + postReopenReserveMs + 3 * MAX_LOCAL_READ_WAIT_MS;
      const initialComposerDeadline = mayReopenComposer
        ? Math.min(composerReadinessDeadline(), Date.now() + EXISTING_GENERATION_RESUME_WINDOW_MS)
        : composerReadinessDeadline();
      let composerState = await waitForComposer(page, initialComposerDeadline, true, observeProductWall);
      if (composerState.state !== 'ready' && composerState.cause === 'composer_unavailable' && mayReopenComposer
        && !browserOrPageDefinitelyLost(page, browser)
        && readOwnedConversationIdentity(page, chatUrlTarget).matched
        && Date.now() + postReopenReserveMs + MAX_LOCAL_READ_WAIT_MS < invocationDeadlineMs) {
        const stop = await readFreshStopVisible(page, invocationDeadlineMs);
        const observation = await readPageObservation(page, undefined, undefined, true, invocationDeadlineMs);
        if (stop === false && !observation.transcriptIncomplete
          && observation.snapshot?.complete === true
          // A complete snapshot covers only currently rendered rows. Require
          // affirmative idle plus readable historical user context; absence of
          // pageTurnEvidence or an unknown generation must not trigger reload.
          && observation.pageTurnEvidence?.generationInProgress === false
          && observation.snapshot?.carriers.some((carrier) =>
            carrier.role === 'user' && normalizeVisibleText(carrier.text).length > 0) === true
          && !browserOrPageDefinitelyLost(page, browser)
          && readOwnedConversationIdentity(page, chatUrlTarget).matched
          && Date.now() + postReopenReserveMs < invocationDeadlineMs) {
          try {
            // navigateOwnedTurnPage already uses goto(waitUntil:'commit') and
            // verifies the same conversation identity; the subdeadline keeps
            // room for the renewed composer read and insertion.
            await navigateOwnedTurnPage(
              page, config, navigation, invocationDeadlineMs - postReopenReserveMs,
            );
          } catch {
            return returnComposerMutationFailure('composer_unavailable');
          }
          if (browserOrPageDefinitelyLost(page, browser)
            || !readOwnedConversationIdentity(page, chatUrlTarget).matched) {
            return returnComposerMutationFailure('composer_unavailable');
          }
          composerState = await waitForComposer(page, composerReadinessDeadline(), true, observeProductWall);
        }
      }
      if (composerState.state !== 'ready' && composerState.cause !== 'composer_unavailable') {
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
      if (composerState.state !== 'ready' && Date.now() >= invocationDeadlineMs) {
        return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      }
      // Preserve the incumbent mutation path: it owns late readiness and the
      // historical composer-unavailable/budget-exhausted result distinction.
      // A failed one-time reopen does not grant a second navigation.


      const baselineFailure = await captureBaseline();
      if (baselineFailure) return baselineFailure;
      const existingGeneration = await waitForExistingGeneration(page, invocationDeadlineMs);
      if (existingGeneration === 'settled') {
        const settledBaselineFailure = await captureBaseline();
        if (settledBaselineFailure) return settledBaselineFailure;
      }
      if (existingGeneration === 'busy') {
        incident('invocation_blocker', 'existing_generation_active', 'return_local_error');
        return {
          page,
          browser,
          result: compactResult(
            'conversation_busy',
            'conversation',
            'existing_generation_active',
            invocationId,
            profileKey,
            sendCount,
            pollCount, navigation, incidents,
            { conversation_id: chatUrlTarget },
            journalWriteFailed,
          ),
        };
      }
      const sendFailure = await sendOwnedPrompt();
      if (sendFailure) return sendFailure;
    }

    const targetChatUrl = config.newChat
      ? undefined
      : normalizeConversationUrl(config.chatUrl ?? '');
    if (targetChatUrl && !browserOrPageDefinitelyLost(page, browser)) {
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

    if (config.newChat && ownedConversationUrl && !browserOrPageDefinitelyLost(page, browser)) {
      await navigateToProjectConversationIfNeeded(
        page,
        ownedConversationUrl,
        navigation,
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
    let lastReadyObservedText = '';
    let bestReadyReply = '';
    let stableReads = 0;
    let lastReadyAssistantIdentity = '';
    let uncertainCause = '';
    let observedUserHeads: string[] | undefined;
    let ownedPromptEverSeen = false;
    let ownedCarrierKey: string | undefined;
    let lastMarkerlessSnapshotSignature = '';
    let completionReadySeen = false;
    let deadEvidenceReads = 0;
    let markerlessFinishedReads = 0;
    let markerlessReloadUsed = false;
    let freshMarkerlessReply = '';
    let streamRecoveryBannerReads = 0;
    let streamRecoveryBannerCause: string | undefined;
    // Roleless recovery banners outlive the turn that raised them; one ends this
    // turn only after its own Stop was seen or the Stop grace since the send ran out.
    let ownedGenerationSeen = false;
    let firstSentPollAt: number | undefined;
    let sendObservationDeferredLogged = false;
    const updateHeartbeatForPoll = (decision: PageObservationDecision): void => {
      heartbeatDecision = decision;
      heartbeatStableReads = stableReads;
      heartbeatCompletionReady = completionReadySeen;
      heartbeatLastReply = decision.state === 'ready' && decision.reply
        ? decision.reply
        : (bestReadyReply || lastReadyReply);
    };

    const recoveryState: PostSendRecoveryState = {
      lossEpoch: 0,
      successorCreated: false,
      cleanupAuthorityPage: page,
      stopAuthorityPage: page,
      ...(targetChatUrl ?? ownedConversationUrl
        ? { immutableConversationUrl: targetChatUrl ?? ownedConversationUrl }
        : {}),
    };
    let faultActuatorUsed = false;

    const recoveryFailureOutcome = (
      failure: PostSendRecoveryFailure,
    ): TurnRunOutcome => {
      incident(failure.eventClass, failure.cause, failure.action);
      return {
        browser: failure.browser,
        ...(failure.stopAuthorityPage ? {
          page: failure.stopAuthorityPage,
          stopAuthorityPage: failure.stopAuthorityPage,
        } : {}),
        cleanupAction: 'preserve',
        result: compactResult(
          failure.state,
          'invocation',
          failure.cause,
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
    };

    const recoverCurrentObservation = async (): Promise<TurnRunOutcome | null> => {
      const recovered = await runPostSendRecovery({
        browser,
        currentPage: page,
        marker,
        hardDeadlineMs: hardExhaustionDeadline,
        pollMs: config.pollMs,
        state: recoveryState,
        observer: recoveryHooks.observer,
        adapter: {
          enumeratePages: async (activeBrowser) => {
            const contexts = (activeBrowser as any).contexts();
            if (!Array.isArray(contexts) || contexts.length !== 1) {
              throw new Error('recovery_context_count_unproven');
            }
            const pages = contexts[0].pages();
            if (!Array.isArray(pages)) throw new Error('recovery_page_enumeration_failed');
            const targetUrl = recoveryState.immutableConversationUrl;
            if (!targetUrl) return pages;
            return pages.filter((candidate: any) => {
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
          readAuthoritativeMessages: async (candidatePage) => {
            const remainingMs = hardExhaustionDeadline - Date.now();
            if (remainingMs <= 0) return { messages: [], incomplete: true };
            try {
              return await boundedBrowserRead(
                readRecoveryAuthoritativeUserMessages(candidatePage),
                Math.min(MAX_LOCAL_READ_WAIT_MS, remainingMs),
                'recovery_authoritative_read_timeout',
              );
            } catch {
              return { messages: [], incomplete: true };
            }
          },
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
            const recoveryBudget = createTurnOperationBudget(
              Math.max(0, hardExhaustionDeadline - Date.now()),
            );
            const successor = await createDedicatedTurnPage(activeBrowser, recoveryBudget);
            navigation.recordGoto();
            await successor.goto(immutableConversationUrl, {
              waitUntil: 'domcontentloaded',
              timeout: STATE_LIGHT_NAVIGATION_TIMEOUT_MS,
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
      if (deliveryProofPendingRecovery) {
        sendCount = 1;
        afterSend = true;
        deliveryProofPendingRecovery = false;
      }
      if (config.newChat && !ownedConversationUrl) {
        if (!(await freshProjectMarkerProven(recovered.page, recovered.conversationUrl, hardExhaustionDeadline))) {
          incident('post_send_observation_error', 'recovered_fresh_owner_marker_or_project_unproven', 'retain_page_no_resend');
          return {
            page: recovered.page,
            browser,
            cleanupAction: 'preserve',
            result: compactResult(
              'observation_uncertain', 'invocation',
              'recovered_fresh_owner_marker_or_project_unproven',
              invocationId, profileKey, sendCount, pollCount, navigation,
              incidents, {}, journalWriteFailed,
            ),
          };
        }
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
      if (config.newChat) emitCancellationReceipt(recovered.conversationUrl);
      transitionStateLightTurnObservation({
        profileKey,
        invocationId,
        phase: 'sent_unharvested',
        reason: 'recovered_conversation_url_bound',
        sendCount,
        sendWitness: 'numeric_send_count',
        conversationUrl: recovered.conversationUrl,
      });

      page = recovered.page;
      if (!recovered.cleanupOwned && page && typeof page === 'object') {
        cleanupAuthorityUnprovenPages.add(page);
      }
      recoveryState.immutableConversationUrl = recovered.conversationUrl;
      // Issue #1283 owns recovered-page integration. Do not fabricate a new
      // pre-send baseline from a post-send successor; markerless harvest stays
      // disabled after recovery until that sibling path supplies its own proof.
      baselineSnapshot = undefined;
      baselineCount = 0;
      return null;
    };

    // `timeout-ms` is a soft post-send observation threshold. Once a prompt has
    // landed and this invocation still owns a reachable page, #1120 requires us
    // to keep that page rather than manufacture lost-chat/resend eligibility.
    while (true) {
      if ((sendCount >= 1 || deliveryProofPendingRecovery) && browserOrPageDefinitelyLost(page, browser)) {
        const terminal = await recoverCurrentObservation();
        if (terminal) return terminal;
        continue;
      }
      pollCount++;
      if (config.newChat && sendCount >= 1 && ownedConversationUrl) {
        recoveryState.immutableConversationUrl = ownedConversationUrl;
        await navigateToProjectConversationIfNeeded(
          page,
          ownedConversationUrl,
          navigation,
        );
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
          marker,
          baselineCount,
          hardExhaustionDeadline,
          observeProductWall,
        );
      } catch (error) {
        if (isPostSendTargetCrash(error)) {
          incident('post_send_target_loss', 'post_send_target_crashed', 'retain_owned_page_no_resend');
          return {
            page,
            browser,
            cleanupAction: 'preserve',
            result: compactResult(
              'driver_error',
              'invocation',
              'post_send_target_crashed',
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
        if (browserOrPageDefinitelyLost(page, browser)) {
          const terminal = await recoverCurrentObservation();
          if (terminal) return terminal;
          continue;
        }
        const symptom = error instanceof Error ? error.message : String(error);
        incident('post_send_observation_error', symptom, 'continue_polling_owned_page');
        stableReads = 0;
        lastReadyReply = '';
        lastReadyObservedText = '';
        bestReadyReply = '';
        completionReadySeen = false;
        lastReadyAssistantIdentity = '';
        uncertainCause = ownedCarrierKey
          ? 'transcript_continuity_unproven'
          : 'owned_carrier_unproven';
        const readErrorUncertain = maybeReturnObservationUncertain(
          Date.now(), hardExhaustionDeadline, sendCount, uncertainCause, ownedPromptEverSeen,
          observedUserHeads, page, browser, invocationId, profileKey, sendCount, pollCount,
          navigation, incidents, journalWriteFailed, incident,
        );
        if (readErrorUncertain) return readErrorUncertain;
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
          ownedCarrierKey,
        );
        if (readErrorExhausted) return readErrorExhausted;
        updateHeartbeatForPoll({ state: 'waiting' });
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
      if (sendCount >= 1 && firstSentPollAt === undefined) firstSentPollAt = Date.now();
      if (!ownedGenerationSeen) {
        try {
          ownedGenerationSeen = await locatorCount(page.locator(RENDERED_STOP_BUTTON_SELECTOR), hardExhaustionDeadline) > 0;
        } catch (error) {
          if (isPostSendTargetCrash(error)) throw error;
        }
      }
      const recoveryBannerTrusted = ownedGenerationSeen
        || (firstSentPollAt !== undefined && Date.now() - firstSentPollAt >= RECOVERY_BANNER_STOP_GRACE_MS);
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
      if (wall.state === 'recovery_required' && (
        recoveryBannerTrusted || (wall.cause !== 'stream_recovery_polling_timed_out' && wall.cause !== 'message_stream_error')
      )) {
        const cause = wall.cause;
        incident('invocation_blocker', cause, 'return_local_error');
        return {
          page,
          browser,
          result: compactResult(
            'recovery_required',
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
        stableReads = 0;
        lastReadyReply = '';
        lastReadyObservedText = '';
        bestReadyReply = '';
        completionReadySeen = false;
        lastReadyAssistantIdentity = '';
        incident('post_send_observation_error', 'transcript_read_incomplete', 'continue_polling_owned_page');
        uncertainCause = ownedCarrierKey
          ? 'transcript_continuity_unproven'
          : 'owned_carrier_unproven';
        const incompleteUncertain = maybeReturnObservationUncertain(
          Date.now(), hardExhaustionDeadline, sendCount, uncertainCause, ownedPromptEverSeen,
          observedUserHeads, page, browser, invocationId, profileKey, sendCount, pollCount,
          navigation, incidents, journalWriteFailed, incident,
        );
        if (incompleteUncertain) return incompleteUncertain;
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
          ownedCarrierKey,
        );
        if (incompleteExhausted) return incompleteExhausted;
        updateHeartbeatForPoll({ state: 'waiting' });
        await sleep(page, INITIAL_POLL_MS);
        continue;
      }

      const markerCardinality = recoveryMarkerCardinality(messages, marker);
      if (
        ownedWindowCompletionReady
        && markerCardinality.matchingUserCarrierCount === 1
        && markerCardinality.exactMarkerTokenCount === 1
      ) {
        completionReadySeen = true;
      }
      if (
        config.newChat
        && sendCount >= 1
        && !ownedConversationUrl
        && markerCardinality.matchingUserCarrierCount === 1
        && markerCardinality.exactMarkerTokenCount === 1
      ) {
        const observedConversationUrl = readProjectConversationUrl(page, config.projectUrl ?? '');
        if (observedConversationUrl && isSupportedChatGptConversationUrl(observedConversationUrl)) {
          let claim: ReturnType<typeof tryClaimStateLightFreshConversation>;
          try {
            claim = tryClaimStateLightFreshConversation(
              profileKey,
              observedConversationUrl,
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
              'state_light_observed_conversation_claim_contended',
              'retain_owned_page_no_resend',
            );
            return {
              page,
              browser,
              ownershipForfeited: true,
              cleanupAction: 'preserve',
              result: compactResult(
                'driver_error',
                'invocation',
                'state_light_observed_conversation_claim_contended',
                invocationId,
                profileKey,
                sendCount,
                pollCount,
                navigation,
                incidents,
                { conversation_id: observedConversationUrl },
                journalWriteFailed,
              ),
            };
          }
          transitionStateLightTurnObservation({
            profileKey,
            invocationId,
            phase: 'sent_unharvested',
            reason: 'fresh_conversation_url_observed_owned_marker',
            sendCount,
            sendWitness: 'numeric_send_count',
            conversationUrl: observedConversationUrl,
          });
          ownedConversationUrl = observedConversationUrl;
          recoveryState.immutableConversationUrl = observedConversationUrl;
          emitCancellationReceipt(observedConversationUrl);
        }
      }
      const durableConversationUrl = targetChatUrl ?? ownedConversationUrl;
      if (durableConversationUrl && sendCount >= 1) {
        const durableRecord = readStateLightTurnObservation(profileKey, invocationId);
        if (!durableRecord.conversation_url) {
          transitionStateLightTurnObservation({
            profileKey,
            invocationId,
            phase: 'sent_unharvested',
            reason: 'conversation_url_observed',
            sendCount,
            sendWitness: 'numeric_send_count',
            conversationUrl: durableConversationUrl,
          });
        }
      }
      if (
        durableConversationUrl
        && markerCardinality.matchingUserCarrierCount === 1
        && markerCardinality.exactMarkerTokenCount === 1
      ) {
        emitCancellationReceipt(durableConversationUrl);
      }
      if (
        !faultActuatorUsed
        && recoveryHooks.faultActuator
        && durableConversationUrl
        && markerCardinality.matchingUserCarrierCount === 1
        && markerCardinality.exactMarkerTokenCount === 1
      ) {
        faultActuatorUsed = true;
        recoveryState.immutableConversationUrl = durableConversationUrl;
        const conversationUrlSha256 = createHash('sha256')
          .update(durableConversationUrl, 'utf8')
          .digest('hex');
        const markerSha256 = createHash('sha256').update(marker, 'utf8').digest('hex');
        recoveryHooks.observer?.({
          event: 'census',
          lossEpoch: recoveryState.lossEpoch,
          eligiblePageCount: 1,
          supportedPageCount: 1,
          censusComplete: true,
          conversationUrlSha256,
        });
        await recoveryHooks.faultActuator({
          page,
          browser,
          sendCount,
          conversationUrlSha256,
          markerSha256,
          matchingUserCarrierCount: markerCardinality.matchingUserCarrierCount,
          exactMarkerTokenCount: markerCardinality.exactMarkerTokenCount,
        });
        if (browserOrPageDefinitelyLost(page, browser)) {
          const terminal = await recoverCurrentObservation();
          if (terminal) return terminal;
          continue;
        }
      }

      const currentOwnedCarrier = snapshotOwnedCarrier(transcriptSnapshot, marker);
      if (currentOwnedCarrier?.key) {
        if (ownedCarrierKey && ownedCarrierKey !== currentOwnedCarrier.key) {
          uncertainCause = 'transcript_continuity_unproven';
        } else {
          ownedCarrierKey = currentOwnedCarrier.key;
        }
      }

      const markerVisible = hasOwnedUserMessage(messages, marker);
      let forcedDecision: PageObservationDecision | undefined;
      if (!markerVisible && !ownedCarrierKey) {
        const postBaselineUsers = messages
          .slice(Math.min(baselineCount, messages.length))
          .filter((message) => message.role === 'user').length;
        uncertainCause = ownedPromptEverSeen || postBaselineUsers === 1
          ? 'owned_carrier_unproven'
          : postBaselineUsers > 1
            ? 'owned_reply_boundary_unproven'
            : '';
      } else if (!markerVisible && ownedCarrierKey) {
        const candidate = keyedHarvestCandidate(transcriptSnapshot, baselineSnapshot, ownedCarrierKey);
        const signature = atomicSnapshotSignature(transcriptSnapshot);
        if (candidate.state === 'continuity-unproven') {
          uncertainCause = 'transcript_continuity_unproven';
        } else if (candidate.state === 'foreign-user') {
          uncertainCause = 'foreign_user_after_owned_send';
          forcedDecision = { state: 'uncertain', cause: uncertainCause };
        } else {
          uncertainCause = '';
        }
        if (candidate.state === 'ready' && signature === lastMarkerlessSnapshotSignature) {
          const revalidated = await revalidateKeyedHarvest(
            page,
            baselineSnapshot,
            ownedCarrierKey,
            { ...candidate, snapshotSignature: signature },
          );
          if (revalidated.state !== 'ready') {
            uncertainCause = 'transcript_continuity_unproven';
          } else {
            // Revalidate the owned page before accepting markerless harvested bytes.
            // Page loss remains a no-resend transport incident.
            {
              const liveness = await probePageLiveness(page, browser);
              if (liveness === 'lost') {
                incident('helper_failure_after_send', 'page_or_browser_lost_after_send', 'skip_lost_page_no_resend');
                return {
                  page,
                  browser,
                  cleanupAction: 'skip',
                  result: compactResult('driver_error', 'invocation', 'page_or_browser_lost_after_send', invocationId, profileKey, sendCount, pollCount, navigation, incidents, {}, journalWriteFailed),
                };
              }
              if (liveness !== 'live') {
                incident('helper_failure_after_send', 'helper_error_after_send_page_retained', 'retain_owned_page_no_resend');
                return {
                  page,
                  browser,
                  cleanupAction: 'preserve',
                  result: compactResult('driver_error', 'invocation', 'helper_error_after_send_page_retained', invocationId, profileKey, sendCount, pollCount, navigation, incidents, {}, journalWriteFailed),
                };
              }
            }
            forcedDecision = { state: 'ready', reply: revalidated.reply };
            completionReadySeen = true;
            lastReadyReply = revalidated.reply;
            bestReadyReply = revalidated.reply;
            stableReads = 1;
          }
        }
        lastMarkerlessSnapshotSignature = signature;
      } else {
        lastMarkerlessSnapshotSignature = '';
      }

      // Issue #2226/#2235: ChatGPT can stop an unrendered-owner turn with a
      // roleless alert; any post-send alert counts, unknown texts as
      // product_error_banner. The marker-based execution recovery classifier cannot
      // prove ownership then, and a reload would hide the alert while the turn
      // stays dead. Return the reserved conversation-scoped recovery cause for
      // this invocation's own bound conversation instead, without reload or resend.
      if (!markerVisible && durableConversationUrl && sendCount >= 1 && recoveryBannerTrusted && pageTurnEvidence?.generationInProgress !== true) {
        let bannerCause: string | undefined;
        let bannerText: string | undefined;
        try {
          const alertTexts = await boundedBrowserRead(
            page.locator(UNMARKED_ALERT_SELECTOR).allInnerTexts(),
            Math.min(MAX_LOCAL_READ_WAIT_MS, Math.max(1, hardExhaustionDeadline - Date.now())),
            'stream_recovery_banner_read_timeout',
          ) as string[];
          const texts = (Array.isArray(alertTexts) ? alertTexts : []).map(String);
          const causes = new Set(
            texts
              .map((text) => unrenderedOwnerAlertCause(text))
              .filter((cause): cause is NonNullable<typeof cause> => cause !== undefined),
          );
          bannerCause = causes.size === 1 ? [...causes][0] : causes.size > 1 ? 'product_error_banner' : undefined;
          bannerText = texts.map(alertHeading).find(Boolean)?.slice(0, 160);
        } catch (error) {
          if (isPostSendTargetCrash(error)) throw error;
        }
        streamRecoveryBannerReads = bannerCause && bannerCause === streamRecoveryBannerCause
          ? streamRecoveryBannerReads + 1
          : bannerCause ? 1 : 0;
        streamRecoveryBannerCause = bannerCause;
        if (bannerCause && streamRecoveryBannerReads >= 2) {
          incident('invocation_blocker', bannerCause, 'retain_owned_page_no_resend');
          return {
            page,
            browser,
            cleanupAction: 'preserve',
            result: compactResult(
              'recovery_required',
              'conversation',
              bannerCause,
              invocationId,
              profileKey,
              sendCount,
              pollCount,
              navigation,
              incidents,
              { conversation_id: durableConversationUrl, ...(bannerText ? { product_banner_text: bannerText } : {}) },
              journalWriteFailed,
            ),
          };
        }
      } else {
        streamRecoveryBannerReads = 0;
        streamRecoveryBannerCause = undefined;
      }

      // A fresh conversation this invocation created and still owns cannot hold
      // anyone else's turn. When ChatGPT renders no user message there, the
      // single finished assistant reply is ours without the marker; harvest it
      // after two identical finished reads instead of reloading.
      const freshTranscriptUsers = messages.filter((message) => message.role === 'user').length;
      const freshTranscriptAssistants = messages.filter((message) => message.role === 'assistant');
      if (
        !markerVisible
        && !forcedDecision
        && config.newChat
        && ownedConversationUrl
        && freshClaimOwnerFenceValid(profileKey, ownedConversationUrl, invocationId, config.timeoutMs)
        && !ownershipForfeited
        && sendCount >= 1
        && freshTranscriptUsers === 0
        && freshTranscriptAssistants.length === 1
        && (ownedWindowCompletionReady || transcriptSnapshot.carriers.length === 1 && transcriptSnapshot.carriers[0]!.role === 'assistant' && transcriptSnapshot.carriers[0]!.completionReady === true)
      ) {
        const reply = normalizeVisibleText(freshTranscriptAssistants[0]!.text);
        if (reply && reply === freshMarkerlessReply) {
          forcedDecision = { state: 'ready', reply };
          uncertainCause = '';
          completionReadySeen = true;
          lastReadyReply = reply;
          bestReadyReply = reply;
          stableReads = 1;
        }
        freshMarkerlessReply = reply;
      } else {
        freshMarkerlessReply = '';
      }

      // Issue #2197: after a finished answer ChatGPT can leave the owned user
      // message unrendered, so neither the marker nor the keyed carrier is
      // visible; reopening the conversation renders it. Reload the owned
      // conversation once, never resend, and observe the reloaded page without
      // the pre-send baseline, as post-send recovery does.
      if (
        !markerVisible
        && !forcedDecision
        && (uncertainCause === 'owned_carrier_unproven' || uncertainCause === 'transcript_continuity_unproven')
        && !markerlessReloadUsed
        && durableConversationUrl
        && sendCount >= 1
        && (ownedPromptEverSeen || Date.now() >= dispatchDeadline)
        && (ownedWindowCompletionReady || transcriptSnapshot.carriers.filter((carrier) => carrier.role === 'assistant').length === 1 && transcriptSnapshot.carriers.every((carrier) => carrier.role !== 'user') && transcriptSnapshot.carriers.find((carrier) => carrier.role === 'assistant')?.completionReady === true)
      ) {
        markerlessFinishedReads += 1;
        if (markerlessFinishedReads >= MARKERLESS_RELOAD_SETTLE_READS) {
          markerlessReloadUsed = true;
          incident(
            'post_send_observation_error',
            'owned_marker_not_rendered',
            'reload_owned_conversation_no_resend',
          );
          try {
            navigation.recordGoto();
            await page.goto(durableConversationUrl, {
              waitUntil: 'domcontentloaded',
              timeout: STATE_LIGHT_NAVIGATION_TIMEOUT_MS,
            });
          } catch (error) {
            if (isPostSendTargetCrash(error)) throw error;
          }
          baselineSnapshot = undefined;
          baselineCount = 0;
          lastMarkerlessSnapshotSignature = '';
          updateHeartbeatForPoll({ state: 'waiting' });
          await sleep(page, INITIAL_POLL_MS);
          continue;
        }
      } else {
        markerlessFinishedReads = 0;
      }

      const ownedReplyWindow = resolveOwnedReplyWindow(messages, baselineCount, marker);
      const currentTurnAssistantNodes = currentOwnedCarrier?.key
        ? countAssistantNodesAfterOwnedCarrier(transcriptSnapshot, currentOwnedCarrier.key)
        : undefined;
      const pageTurnStatus = pageTurnEvidence && currentTurnAssistantNodes !== undefined
        ? classifyBrowserGptPageTurnStatus(
          pageTurnEvidence.generationInProgress,
          currentTurnAssistantNodes,
        )
        : 'unknown';
      const deadEvidenceEligible = Boolean(
        markerVisible
        && durableConversationUrl
        && !ownedReplyWindow.uncertainCause
        && markerCardinality.matchingUserCarrierCount === 1
        && markerCardinality.exactMarkerTokenCount === 1
        && Date.now() >= dispatchDeadline
      );
      if (deadEvidenceEligible && pageTurnStatus === 'dead') {
        deadEvidenceReads += 1;
        if (deadEvidenceReads >= 2) {
          incident('dead_turn_observed', 'dead_turn_page_evidence', 'retain_owned_page_no_resend');
          return {
            page,
            browser,
            cleanupAction: 'preserve',
            result: compactResult(
              'no_reply',
              'conversation',
              'dead_turn_page_evidence',
              invocationId,
              profileKey,
              sendCount,
              pollCount,
              navigation,
              incidents,
              { conversation_id: durableConversationUrl },
              journalWriteFailed,
            ),
          };
        }
      } else {
        deadEvidenceReads = 0;
      }

      const inProgress = !ownedWindowCompletionReady;
      const decision = forcedDecision ?? classifyPageObservation(messages, baselineCount, marker, inProgress);

      if (hasOwnedUserMessage(messages, marker)) {
        ownedPromptEverSeen = true;
      }

      if (decision.state === 'uncertain') {
        uncertainCause = decision.cause === 'owned_prompt_marker_ambiguous'
          ? 'owned_reply_boundary_unproven'
          : decision.cause ?? 'owned_reply_boundary_unproven';
        observedUserHeads = decision.observedUserHeads
          ? [...decision.observedUserHeads]
          : observedUserHeads;
        stableReads = 0;
        lastReadyReply = '';
        bestReadyReply = '';
        lastReadyObservedText = '';
        completionReadySeen = false;
        lastReadyAssistantIdentity = '';
        if (uncertainCause === 'foreign_user_after_owned_send') {
          incident('observation_exhausted', uncertainCause, 'retain_owned_page_no_resend');
          return {
            page,
            browser,
            cleanupAction: 'preserve',
            result: compactResult(
              'no_reply',
              'invocation',
              uncertainCause,
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
          ownedCarrierKey,
        );
        if (uncertainWaitingExhausted) return uncertainWaitingExhausted;
        updateHeartbeatForPoll(decision);
        await sleep(page, INITIAL_POLL_MS);
        continue;
      }

      if (markerVisible || forcedDecision) uncertainCause = '';
      observedUserHeads = undefined;
      if (decision.state !== 'ready' && !forcedDecision) {
        const continuationCarrier = selectedOwnedReplyCarrier({
          messages,
          snapshot: transcriptSnapshot,
          baselineSnapshot,
          baselineCount,
          marker,
          ownedCarrierKey,
        });
        const hasOwnershipEvidence = hasOwnedUserMessage(messages, marker)
          || Boolean(ownedCarrierKey)
          || Boolean(config.newChat && ownedConversationUrl && !ownershipForfeited
            && freshClaimOwnerFenceValid(profileKey, ownedConversationUrl, invocationId, config.timeoutMs));
        let continued = false;
        try {
          if (hasOwnershipEvidence && !continuationCarrier?.continuationVisible) {
            try {
              // Read only for target-loss classification; never use this page-wide result as owned-turn evidence or a click target.
              await locatorCount(page.getByRole('button', { name: CONTINUE_GENERATING_BUTTON_NAME }), hardExhaustionDeadline);
            } catch (error) {
              if (isPostSendTargetCrash(error)) throw error;
            }
          }
          if (continuationCarrier && hasOwnershipEvidence) {
            continued = await maybeContinueGeneration(
              page,
              hardExhaustionDeadline,
              continuationCarrier.domIndex,
              continuationCarrier.continuationVisible === true,
            );
          }
        } catch (error) {
          if (isPostSendTargetCrash(error)) {
            incident('post_send_target_loss', 'post_send_target_crashed', 'retain_owned_page_no_resend');
            return {
              page,
              browser,
              cleanupAction: 'preserve',
              result: compactResult(
                'driver_error',
                'invocation',
                'post_send_target_crashed',
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
          throw error;
        }
        if (continued) {
          stableReads = 0;
          lastReadyReply = '';
          lastReadyObservedText = '';
          bestReadyReply = '';
          completionReadySeen = false;
          lastReadyAssistantIdentity = '';
          updateHeartbeatForPoll({ state: 'waiting' });
          await sleep(page, INITIAL_POLL_MS);
          continue;
        }
      }

      if (decision.state === 'ready' && decision.reply) {
        const currentObservedText = selectedOwnedReplyText({
          messages,
          snapshot: transcriptSnapshot,
          baselineSnapshot,
          baselineCount,
          marker,
          ownedCarrierKey,
        });
        const currentAssistantIdentity = selectedOwnedReplyIdentity({
          messages,
          snapshot: transcriptSnapshot,
          baselineSnapshot,
          baselineCount,
          marker,
          ownedCarrierKey,
        });
        const currentKeyedCandidate = !markerVisible && ownedCarrierKey
          ? keyedHarvestCandidate(transcriptSnapshot, baselineSnapshot, ownedCarrierKey)
          : undefined;
        const currentKeyedAssistant = currentKeyedCandidate?.state === 'ready'
          ? transcriptSnapshot.carriers.filter((carrier) => carrier.role === 'assistant' && carrier.key === currentKeyedCandidate.assistantKey)
          : [];
        const currentCandidateReady = markerVisible
          ? ownedWindowCompletionReady
          : currentKeyedAssistant.length === 1 && currentKeyedAssistant[0]!.completionReady === true
            || Boolean(config.newChat && ownedConversationUrl && !ownershipForfeited
              && messages.every((message) => message.role !== 'user')
              && transcriptSnapshot.carriers.filter((carrier) => carrier.role === 'assistant').length === 1
              && transcriptSnapshot.carriers.find((carrier) => carrier.role === 'assistant')?.completionReady === true);
        if (!currentObservedText || !currentAssistantIdentity || currentAssistantIdentity === 'ambiguous' || !currentCandidateReady) {
          stableReads = 0;
          lastReadyReply = '';
          lastReadyObservedText = '';
          bestReadyReply = '';
          completionReadySeen = false;
          lastReadyAssistantIdentity = '';
          updateHeartbeatForPoll({ state: 'waiting' });
          await sleep(page, INITIAL_POLL_MS);
          continue;
        }
        if (decision.reply.length > bestReadyReply.length) bestReadyReply = decision.reply;
        if (currentAssistantIdentity === lastReadyAssistantIdentity && replyStabilityMatches(currentObservedText, lastReadyObservedText)) stableReads++;
        else {
          lastReadyReply = decision.reply;
          lastReadyObservedText = currentObservedText;
          lastReadyAssistantIdentity = currentAssistantIdentity;
          stableReads = 1;
        }
        if (stableReads >= 2) {
          if (config.newChat && !ownedConversationUrl) {
            // A ready assistant on a root/foreign/unproven fresh URL does not
            // authenticate the selected conversation. Keep observing within
            // the incumbent deadline; do not publish or close an unbound page.
            if (Date.now() >= hardExhaustionDeadline) {
              incident('post_send_observation_error', 'fresh_conversation_owner_unproven', 'retain_page_no_resend');
              return {
                page,
                browser,
                cleanupAction: 'preserve',
                result: compactResult(
                  'observation_uncertain', 'invocation', 'fresh_conversation_owner_unproven',
                  invocationId, profileKey, sendCount, pollCount, navigation, incidents, {},
                  journalWriteFailed,
                ),
              };
            }
            stableReads = 0;
            lastReadyReply = '';
            lastReadyObservedText = '';
            bestReadyReply = '';
            lastReadyAssistantIdentity = '';
            await sleep(page, INITIAL_POLL_MS);
            continue;
          }
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
          const finalConversationTarget = targetChatUrl ?? ownedConversationUrl;
          if (finalConversationTarget) {
            const finalIdentity = readOwnedConversationIdentity(page, finalConversationTarget);
            if (!finalIdentity.matched) {
              return returnOwnedConversationIdentityMismatch(
                finalIdentity,
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
          // Never publish a historical longest candidate: only the current full reply
          // that passed exact full-content stability is admissible.
          const captureReply = decision.reply;
          const managerReply = captureReply;
          const finalObservation = await readPostSendObservation(page, marker, baselineCount, hardExhaustionDeadline, observeProductWall);
          const finalKeyedCandidate = ownedCarrierKey
            ? keyedHarvestCandidate(finalObservation.snapshot, baselineSnapshot, ownedCarrierKey)
            : undefined;
          const finalKeyedAssistant = finalKeyedCandidate?.state === 'ready'
            ? finalObservation.snapshot.carriers.filter((carrier) => carrier.role === 'assistant' && carrier.key === finalKeyedCandidate.assistantKey)
            : [];
          const finalFreshClaimReady = Boolean(config.newChat && ownedConversationUrl && !ownershipForfeited
            && freshClaimOwnerFenceValid(profileKey, ownedConversationUrl, invocationId, config.timeoutMs)
            && finalObservation.messages.every((message) => message.role !== 'user')
            && finalObservation.snapshot.carriers.filter((carrier) => carrier.role === 'assistant').length === 1
            && finalObservation.snapshot.carriers.find((carrier) => carrier.role === 'assistant')?.completionReady === true);
          const finalReady = !finalObservation.transcriptIncomplete
            && (hasOwnedUserMessage(finalObservation.messages, marker)
              ? finalObservation.ownedWindowCompletionReady
              : finalKeyedAssistant.length === 1 && finalKeyedAssistant[0]!.completionReady === true || finalFreshClaimReady);
          const finalAssistantMessages = finalObservation.messages.filter((message) => message.role === 'assistant');
          const finalUsers = finalObservation.messages.filter((message) => message.role === 'user');
          const finalMarkerlessReply = finalKeyedAssistant.length === 1
            ? normalizeVisibleText(finalKeyedAssistant[0]!.text)
            : finalAssistantMessages.length === 1
              ? normalizeVisibleText(finalAssistantMessages[0]!.text)
              : '';
          const finalMarkerlessEligible = finalReady
            && (ownedCarrierKey
              ? finalKeyedCandidate?.state === 'ready'
                && finalKeyedAssistant.length === 1
                && normalizeVisibleText(finalKeyedAssistant[0]!.text) === managerReply
              : !hasOwnedUserMessage(finalObservation.messages, marker)
                && finalUsers.length === 0
                && finalMarkerlessReply === managerReply
                && Boolean(config.newChat && ownedConversationUrl && !ownershipForfeited
                  && freshClaimOwnerFenceValid(profileKey, ownedConversationUrl, invocationId, config.timeoutMs)));
          const classifiedFinal = finalReady
            ? classifyPageObservation(finalObservation.messages, baselineCount, marker, false)
            : { state: 'waiting' as const };
          const finalDecision = classifiedFinal.state === 'ready'
            ? classifiedFinal
            : finalMarkerlessEligible ? { state: 'ready' as const, reply: finalMarkerlessReply } : classifiedFinal;
          const finalObservedText = finalReady ? selectedOwnedReplyText({
            messages: finalObservation.messages,
            snapshot: finalObservation.snapshot,
            baselineSnapshot,
            baselineCount,
            marker,
            ownedCarrierKey,
          }) : '';
          const finalAssistantIdentity = finalReady ? selectedOwnedReplyIdentity({
            messages: finalObservation.messages,
            snapshot: finalObservation.snapshot,
            baselineSnapshot,
            baselineCount,
            marker,
            ownedCarrierKey,
          }) : '';
          if (finalDecision.state !== 'ready'
            || finalDecision.reply !== managerReply
            || !finalObservedText
            || finalObservedText !== currentObservedText
            || finalAssistantIdentity !== currentAssistantIdentity) {
            stableReads = 0;
            lastReadyReply = '';
            lastReadyObservedText = '';
            bestReadyReply = '';
            completionReadySeen = false;
            lastReadyAssistantIdentity = '';
            updateHeartbeatForPoll({ state: 'waiting' });
            await sleep(page, INITIAL_POLL_MS);
            continue;
          }
          const publication = await finalizeStateLightPrimaryPublication({
            profileKey,
            invocationId,
            target: destination.finalPath,
            bytes: managerReply,
            publish: () => publishStateLightReply(
              destination.finalPath,
              invocationId,
              managerReply,
            ),
          });
          if (publication.state !== 'committed_ok') {
            incident('output_publication_error', publication.cause ?? publication.state, 'return_local_error');
            const publicationState: TurnState = publication.state === 'conflict' ? 'output_conflict' : 'driver_error';
            return {
              page,
              browser,
              publicationState: publication.state,
              result: {
                ...compactResult(
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
                ...(publication.retirement_cleanup_required ? { retirement_cleanup_required: true } : {}),
              },
            };
          }
          return {
            page,
            browser,
            publicationState: publication.state,
            ...(ownedConversationUrl ? { profileKey, ownedConversationUrl } : {}),
            ...(ownershipForfeited ? { ownershipForfeited: true } : {}),
            result: {
              ...compactResult(
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
              ...(publication.retirement_cleanup_required ? { retirement_cleanup_required: true } : {}),
            },
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
          ownedCarrierKey,
        );
        if (readyExhausted) return readyExhausted;
        updateHeartbeatForPoll(decision);
        await sleep(page, STABILITY_READ_DELAY_MS);
        continue;
      }

      stableReads = 0;
      lastReadyReply = '';
      lastReadyObservedText = '';
      bestReadyReply = '';
      completionReadySeen = false;
      lastReadyAssistantIdentity = '';
      if (
        config.newChat
        && sendCount >= 1
        && Date.now() >= freshConversationLandingDeadline
        && !readProjectConversationUrl(page, config.projectUrl ?? '')
        && !ownedPromptEverSeen
        && !ownedStopDeliveryObserved
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
        ownedCarrierKey,
      );
      if (waitingExhausted) return waitingExhausted;

      updateHeartbeatForPoll(decision);

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
    const retirementCleanupRequired = message === 'observation_mutation_retirement_cleanup_required';
    const holderTimeout = error instanceof StateLightSendSlotTimeoutError ? error : undefined;
    const lostAfterSend = afterSend && browserOrPageDefinitelyLost(page, browser);
    const cause = retirementCleanupRequired
      ? message
      : afterSend
        ? lostAfterSend
          ? 'page_or_browser_lost_after_send'
          : 'helper_error_after_send_page_retained'
        : message === 'ui_contract_mismatch:fresh_conversation_surface_unavailable'
          ? 'fresh_conversation_surface_unavailable'
          : message;
    if (!isInput && !isOutput) {
      incident(
        retirementCleanupRequired
          ? 'observation_mutation_retirement_cleanup_required'
          : afterSend
            ? 'helper_failure_after_send'
            : 'helper_failure_before_send',
        cause,
        retirementCleanupRequired
          ? 'retry_cleanup_later_no_resend'
          : afterSend
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
      ...(ownershipForfeited ? { cleanupAction: 'preserve' as const } : {}),
      result: {
        ...compactResult(
          state,
          'invocation',
          cause,
          invocationId,
          profileKey,
          sendCount,
          pollCount, navigation, incidents,
          {
            ...(sendAttempted ? { send_attempted: true } : {}),
            ...(page && pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}),
            ...(holderTimeout ? {
              send_slot_holder_invocation_id: holderTimeout.send_slot_holder_invocation_id,
              send_slot_holder_phase: holderTimeout.send_slot_holder_phase,
            } : {}),
          },
          journalWriteFailed,
        ),
        ...(retirementCleanupRequired ? { retirement_cleanup_required: true } : {}),
      },
    };
  }
}

async function finalizeTurn(outcome: TurnRunOutcome): Promise<CompactTurnResult> {
  let cleanup: ResourceCleanupOutcome = 'skipped';
  let journalWriteFailed = outcome.result.journal_write_failed === true;
  let retirementCleanupRequired = outcome.result.retirement_cleanup_required === true;
  const incidents = [...outcome.result.incidents];
  const pageLost = browserOrPageDefinitelyLost(outcome.page, outcome.browser);
  let observedNotSent = false;

  // Only prepared state proves no dispatch. A dispatching record is possible
  // delivery even with a zero observed count; preserve its recovery identity.
  if (
    outcome.result.send_count === 0
    && outcome.result.invocation_id.length > 0
    && outcome.result.configured_profile_key !== 'profile-unresolved'
  ) {
    try {
      const observation = readStateLightTurnObservation(
        outcome.result.configured_profile_key,
        outcome.result.invocation_id,
      );
      if (observation.phase === 'prepared' && outcome.result.send_attempted !== true) {
        transitionStateLightTurnObservation({
          profileKey: outcome.result.configured_profile_key,
          invocationId: outcome.result.invocation_id,
          phase: 'not_sent',
          reason: 'terminal_pre_send',
          sendCount: 0,
          sendWitness: 'numeric_send_count',
        });
        observedNotSent = true;
      } else if (observation.phase === 'not_sent' && outcome.result.send_attempted !== true) {
        observedNotSent = true;
      }
      if (observation.phase === 'dispatching') {
        outcome = {
          ...outcome,
          cleanupAction: 'preserve',
          result: { ...outcome.result, send_attempted: true },
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'observation_mutation_retirement_cleanup_required') {
        retirementCleanupRequired = true;
        const cleanupIncident: BrowserIncident = {
          eventClass: 'observation_mutation_retirement_cleanup_required',
          symptom: message,
          action: 'retry_cleanup_later_no_resend',
        };
        incidents.push(cleanupIncident.eventClass);
        if (!appendIncident(cleanupIncident, outcome.result.invocation_id)) journalWriteFailed = true;
      }
      // Missing/malformed observation is itself fail-closed; do not manufacture
      // not_sent or alter the transport result solely for cleanup bookkeeping.
    }
  }

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
  let pageAction = (outcome.result.send_count >= 1 || outcome.result.send_attempted === true) && outcome.result.state !== 'ok'
    ? 'preserve'
    : requestedPageAction;
  if (pageAction === 'close' && outcome.result.send_count === 0 && outcome.ownedFreshProjectUrl) {
    // The slot was already owner-released. For this proven-created tab, check
    // its current blank project identity and no foreign Stop at each destructive
    // boundary, never only its original creation handle or old composer read.
    const stillOwnedBlankSurface = (): boolean => {
      try {
        return cleanupAuthorityProven
          && !browserOrPageDefinitelyLost(outcome.page, outcome.browser)
          && isBlankProjectSurfaceUrl(String(outcome.page.url()), outcome.ownedFreshProjectUrl!);
      } catch { return false; }
    };
    const safeComposerBoundary = async (): Promise<boolean> => stillOwnedBlankSurface()
      && await readFreshStopVisible(outcome.page, Date.now() + MAX_LOCAL_READ_WAIT_MS) === false
      && stillOwnedBlankSurface();
    let cleared = false;
    if (observedNotSent && !pageLost && outcome.result.send_attempted !== true) {
      try {
        const composer = outcome.page.locator(COMPOSER_SELECTOR);
        if (await safeComposerBoundary()) {
          const text = await readComposerTextForSendDelivery(composer, Date.now() + MAX_LOCAL_READ_WAIT_MS);
          // Draft clearing happened while holding the fresh-send lock.
          // After release, never modify a draft belonging to the next sender.
          if (text === ''
            && await safeComposerBoundary()
            && await readComposerTextForSendDelivery(composer, Date.now() + MAX_LOCAL_READ_WAIT_MS) === text
            && stillOwnedBlankSurface()) {
            cleared = await safeComposerBoundary()
              && (await readComposerTextForSendDelivery(composer, Date.now() + MAX_LOCAL_READ_WAIT_MS))?.trim() === ''
              && await safeComposerBoundary();
          }
        }
      } catch {
        // Preserve the tab if owner, Stop, content or clearing is uncertain.
      }
    }
    if (!cleared) {
      pageAction = 'preserve';
      incidents.push('owned_composer_cleanup_unavailable');
      const cleanupIncident: BrowserIncident = {
        eventClass: 'owned_composer_cleanup_unavailable',
        symptom: 'typed_payload_not_proven_cleared',
        action: 'preserve_page_without_modifying_foreign_text',
      };
      if (!appendIncident(cleanupIncident, outcome.result.invocation_id)) journalWriteFailed = true;
    }
  }
  if (pageAction === 'close') {
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

  if (outcome.profileKey && outcome.ownedConversationUrl && !outcome.ownershipForfeited) {
    releaseStateLightFreshConversationClaim(
      outcome.profileKey,
      outcome.ownedConversationUrl,
      outcome.result.invocation_id,
    );
  }
  await releaseCdpBrowser(outcome.browser);
  return {
    ...outcome.result,
    cleanup,
    incidents,
    ...(retirementCleanupRequired ? { retirement_cleanup_required: true } : {}),
    ...(journalWriteFailed ? { journal_write_failed: true } : {}),
  };
}

export const __testFinalizeTurn = finalizeTurn;
export const __testBrowserOrPageDefinitelyLost = browserOrPageDefinitelyLost;
export const __testWaitForExistingGeneration = waitForExistingGeneration;
export const __testConversationPageSelection = { selectConversationPage };

export const __testComposerMutation = {
  remainingComposerMutationMs,
  readComposerReadiness,
  mutateComposerOrCause,
  hasBlockingPageOverlay,
  waitForComposer,
};

export const __testSendDelivery = {
  dispatchStateLightSendAndObserveDelivery,
  affirmativePreActionabilityTimeout,
  waitForFreshSendButton,
};

export type StateLightTurnDependencies = {
  readonly runTurn?: (args: ParsedTurnArgs) => Promise<TurnRunOutcome>;
  readonly recoveryHooks?: StateLightRecoveryHooks;
  readonly entryLivenessHeartbeat?: boolean;
};

export async function runStateLightTurn(
  argv: readonly string[],
  dependencies: StateLightTurnDependencies = {},
): Promise<number> {
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

  let heartbeatScheduler: TurnScopedHeartbeatScheduler | undefined;
  const freshCleanup: FreshComposerCleanupContext = {};
  const outcome = dependencies.runTurn
    ? await dependencies.runTurn(args)
    : await runTurn(
        args,
        dependencies.recoveryHooks,
        dependencies.entryLivenessHeartbeat === true,
        (scheduler) => { heartbeatScheduler = scheduler; },
        freshCleanup,
      );
  try {
    const augmented: TurnRunOutcome = {
      ...outcome,
      ...(freshCleanup.page && outcome.page === freshCleanup.page && freshCleanup.markedPayload
        ? { ownedTypedPayload: freshCleanup.markedPayload } : {}),
      ...(freshCleanup.page && outcome.page === freshCleanup.page && freshCleanup.projectUrl
        ? { ownedFreshProjectUrl: freshCleanup.projectUrl } : {}),
    };
    const result = await finalizeTurn(augmented);
    // Keep liveness continuous through every pre-emission cleanup await, then
    // stop the scheduler at the terminal publication boundary so no heartbeat
    // can follow turn-result/v1 or keep the subprocess alive.
    heartbeatScheduler?.dispose();
    emit(result);
    return turnExitCode(result.state);
  } finally {
    heartbeatScheduler?.dispose();
  }
}
