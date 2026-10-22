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
  releaseCdpBrowser,
  RESOURCE_CLEANUP_BOUND_MS,
  type ResourceCleanupOutcome,
} from './browser-session.ts';
import { destinationIdentity } from './coordination.ts';
import {
  attachOwnTarget,
  authorizeGuardedHistoricalTargetClose,
  countUninspectedRecoveryTargets,
  getOwnTargetInfo,
} from './own-target-attach.ts';
import { listCdpPageTargets, probeCdpSiblingEvaluations } from './own-target-cdp-proxy.ts';
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
  extractOwnedPromptMarkerToken,
  isOwnedPromptMarker,
  generateOwnedPromptMarker,
  ownedPromptMarkerMatches,
  wrapOwnedPromptPayload,
} from './owned-prompt-marker.ts';
import {
  conversationUuidFromUrl,
  ownedConversationIdentityMatches,
  prepareStateLightFreshConversation,
  isBlankProjectSurfaceUrl,
  projectSurfaceUrlsEquivalent,
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
import { atomicJson, configuredProfileKey, profileDirs } from './storage-common.ts';
import {
  admitStateLightTurnObservation,
  bindStateLightOwnedTarget,
  finalizeStateLightPrimaryPublication,
  readVerifiedStateLightHarvestedPrimary,
  readStateLightTurnObservation,
  transitionStateLightTurnObservation,
} from './state-light-turn-observation.ts';
import {
  ASSISTANT_MESSAGE_STYLE,
  ASSISTANT_TURN_ACTION_SELECTOR,
  ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
  classifyProductWall,
  classifyConversationProductWall,
  heldPage429Diagnostic,
  observeHeldPageConversation429,
  type HeldPage429Witness,
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
  probeAccountLoadError,
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
  takeRecoveryCensus,
  type PostSendRecoveryAdapter,
  type PostSendRecoveryResult,
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

// #2617: the sole shared-Chrome cross-invocation admission value is an
// actionable, finite epoch-ms cooldown (no turn slots or failure hold).
const ACCOUNT_COOLDOWN_FILE = 'state-light-account-cooldown.v1.json';
const ACCOUNT_COOLDOWN_GUARD = 'state-light-account-cooldown.v1.guard';
const ACCOUNT_COOLDOWN_MS = 300_000;
const ACCOUNT_COOLDOWN_ACTIONABLE_MS = ACCOUNT_COOLDOWN_MS + 1_000;
const ACCOUNT_COOLDOWN_QUIET_RESET_MS = 30 * 60_000;
const ACCOUNT_COOLDOWN_STEPS_MS = [60_000, 120_000, 240_000, ACCOUNT_COOLDOWN_MS] as const;

const FRESH_LOCAL_POSSIBLY_DELIVERED_NEXT_ACTION =
  'No durable ChatGPT conversation URL was bound for this invocation; delivery is POSSIBLY_DELIVERED. '
  + 'Check expected GitHub effects first (Issue body revision, comment, commit, PR) and re-check up to 20 minutes '
  + 'after the original Send, while also searching the project sidebar for the turn-marker chat and harvesting it if found. '
  + 'Never click Retry or auto-resend. A new-invocation-ID manual send is allowed only if no GitHub effect and no marker chat '
  + 'appeared by 20 minutes after Send, and only by an explicit operator/workflow decision acknowledging possibly duplicated side effects.';

// A local-chatgpt id is never a durable conversation locator. Match both the
// current project identity and exact route; the root /c/local-chatgpt route
// and a foreign project's tab cannot authorize the local-only behavior.
function matchingFreshProjectLocalUrl(observedUrl: string, projectUrl: string): boolean {
  try {
    const url = new URL(observedUrl);
    const route = /^\/g\/(g-p-[^/]+)\/c\/local-chatgpt(?::|%3A)[a-z0-9-]+$/iu.exec(url.pathname);
    return url.origin === 'https://chatgpt.com'
      && !url.username && !url.password && !url.search && !url.hash
      && Boolean(route && projectSurfaceUrlsEquivalent(
        url.origin + '/g/' + route[1] + '/project', projectUrl,
      ));
  } catch {
    return false;
  }
}

export interface StateLightAccountCooldown {
  readonly active: boolean;
  readonly until?: number;
  readonly diagnostic?: string;
  readonly lastWitnessAt?: number;
  readonly backoffStep?: number;
}

export function readStateLightAccountCooldown(
  profileKey: string, nowMs = Date.now(),
): StateLightAccountCooldown {
  try {
    const path = join(profileDirs(profileKey).locks, ACCOUNT_COOLDOWN_FILE);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { active: false };
      return { active: false, diagnostic: 'account_cooldown_unreadable' };
    }
    let record: unknown;
    try { record = JSON.parse(raw); }
    catch { return { active: false, diagnostic: 'account_cooldown_malformed' }; }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return { active: false, diagnostic: 'account_cooldown_wrong_shape' };
    }
    const keys = Object.keys(record);
    const legacy = keys.length === 1 && keys[0] === 'cooldown_until_ms';
    const extended = keys.length === 3
      && keys.every((key) => ['cooldown_until_ms', 'last_witness_at_ms', 'backoff_step'].includes(key));
    if (!legacy && !extended) return { active: false, diagnostic: 'account_cooldown_wrong_shape' };
    const until = (record as { cooldown_until_ms?: unknown }).cooldown_until_ms;
    if (typeof until !== 'number' || !Number.isSafeInteger(until) || until < 0) {
      return { active: false, diagnostic: 'account_cooldown_invalid_deadline' };
    }
    const lastWitnessAt = extended ? (record as { last_witness_at_ms?: unknown }).last_witness_at_ms : undefined;
    const backoffStep = extended ? (record as { backoff_step?: unknown }).backoff_step : undefined;
    if (extended && (typeof lastWitnessAt !== 'number'
      || !Number.isSafeInteger(lastWitnessAt) || lastWitnessAt < 0
      || typeof backoffStep !== 'number' || !Number.isSafeInteger(backoffStep)
      || backoffStep < 1 || backoffStep > 4)) {
      return { active: false, diagnostic: 'account_cooldown_invalid_witness' };
    }
    const witness = extended ? { lastWitnessAt: lastWitnessAt as number, backoffStep: backoffStep as number } : {};
    if (until <= nowMs) return { ...witness, active: false, diagnostic: 'account_cooldown_expired' };
    if (until > nowMs + ACCOUNT_COOLDOWN_ACTIONABLE_MS) {
      return { active: false, diagnostic: 'account_cooldown_far_future' };
    }
    return { ...witness, active: true, until };
  } catch {
    // An inaccessible shared store never becomes a physical Send admission failure.
    return { active: false, diagnostic: 'account_cooldown_store_unavailable' };
  }
}

export function publishWitnessedStateLight429(
  profileKey: string, nowMs = Date.now(),
): StateLightAccountCooldown {
  let guardFd: number | undefined;
  let guardPath: string | undefined;
  try {
    const locks = profileDirs(profileKey).locks;
    guardPath = join(locks, ACCOUNT_COOLDOWN_GUARD);
    // Short writer-integrity guard only: no persistent owner, lease, wait or slot.
    guardFd = openSync(guardPath, 'wx', 0o600);
    const previous = readStateLightAccountCooldown(profileKey, nowMs);
    const continuous = previous.lastWitnessAt !== undefined
      && previous.lastWitnessAt <= nowMs
      && nowMs - previous.lastWitnessAt <= ACCOUNT_COOLDOWN_QUIET_RESET_MS;
    const step = continuous ? Math.min(4, (previous.backoffStep ?? 0) + 1) : 1;
    const until = Math.max(nowMs + ACCOUNT_COOLDOWN_STEPS_MS[step - 1]!, previous.active ? previous.until! : 0);
    atomicJson(join(locks, ACCOUNT_COOLDOWN_FILE), {
      cooldown_until_ms: until, last_witness_at_ms: nowMs, backoff_step: step,
    });
    return { active: true, until };
  } catch {
    return { active: false, diagnostic: 'account_cooldown_write_unavailable' };
  } finally {
    if (guardFd !== undefined) {
      try { closeSync(guardFd); } catch { /* the unavailability remains fail-open */ }
      try { if (guardPath) unlinkSync(guardPath); } catch { /* diagnostic only */ }
    }
  }
}

export { stopOwnedGeneration };
export type { StopOwnedGenerationOutcome };

const DEFAULT_TIMEOUT_MS = 1_800_000;
/** Local CDP DOM reads after dispatch; not send/navigation pacing. */
export const POST_SEND_OBSERVATION_POLL_MS = 15_000;
// After the tab closes, a 15s ordinary poll and up to a 5s read can precede
// detection. Reserve the existing 15s CDP release and 7s terminal/overshoot
// headroom inside AC2's 60s child-only bound: 15 + 5 + 18 + 15 + 7 = 60.
// Do not shorten healthy/open-page observation or manufacture a loss timestamp.
const CONFIRMED_OWNED_PAGE_LOSS_RECOVERY_MS = 18_000;
const DEFAULT_POLL_MS = POST_SEND_OBSERVATION_POLL_MS;
const INITIAL_POLL_MS = 500;
// Consecutive finished-answer reads without a rendered owned user message
// before the helper reloads its owned conversation once (Issue #2197).
const MARKERLESS_RELOAD_SETTLE_READS = 3;
const DISPATCH_OBSERVATION_MS = 30_000;
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
const ASSISTANT_CONTENT_ROOT_SELECTOR = '.markdown';
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


type ExtendedReadinessOutcome = 'enabled' | 'still_frozen' | 'recovered_but_disabled'
  | 'target_disappeared_or_changed' | 'terminal_unknown' | 'budget_exhausted';

interface ExtendedReadinessDiagnostic {
  readonly entryNonresponsiveCount: number;
  readonly terminalNonresponsiveCount?: number;
  readonly elapsedMs: number;
  readonly outcome: ExtendedReadinessOutcome;
}

interface BrowserIncident {
  readonly eventClass: string;
  readonly symptom: string;
  readonly action?: string;
  readonly uncertaintyDiagnostics?: ObservationUncertaintyDiagnostics;
  readonly composerMutationDiagnostic?: ComposerMutationDiagnosticV1;
  readonly extendedReadiness?: ExtendedReadinessDiagnostic;
}

export interface CompactTurnResult extends TurnResultV1 {
  readonly attach_attempts?: number;
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
  /** Positive original Page and exact URL for a no-dispatch existing-chat fetch-429 close. */
  readonly ownedPreSendFetch429Page?: any;
  readonly ownedPreSendFetch429Url?: string;
  /** Process-local authority for the two still-owned counted fresh/local terminals. */
  readonly retainOwnedFreshLocalPage?: boolean;
  /** Exact owned page observation; never cancellation authority by itself. */
  readonly stopAuthorityPage?: any;
  readonly ownedConversationUrl?: string;
  readonly profileKey?: string;
  readonly ownershipForfeited?: boolean;
  /** Private, process-local cleanup value; never emitted as turn-result. */
  readonly ownedTypedPayload?: string;
  /** Process-local handle of the originally CDP-created Page, not a recovery successor. */
  readonly originalCreatedPage?: any;
  /** Exact attach-created target retirement after failed Playwright bootstrap. */
  readonly createdAttachFailureCleanup?: 'confirmed' | 'unconfirmed';
  /** Affirmative newly allocated ID, retained even if observation binding fails. */
  readonly createdAttachFailureTargetId?: string;
  /** Exact new-chat project surface of a proven created tab; never emitted. */
  readonly ownedFreshProjectUrl?: string;
  /** Process-only positive-recovery cleanup, never a terminal locator. */
  readonly ownedDeadLocalPage?: any;
  readonly ownedDeadLocalUrl?: string;
  readonly ownedDeadLocalConversationUrl?: string;
  readonly ownedDeadLocalTimeoutMs?: number;
}

interface FreshComposerCleanupContext {
  page?: any;
  /** Original invocation-created handle must not silently become the recovery successor. */
  originalCreatedPage?: any;
  markedPayload?: string;
  projectUrl?: string;
  sendAttempted?: boolean;
  predecessorCleanupStatus?: 'confirmed' | 'cleanup_unconfirmed';
  predecessorTargetId?: string;
  /** The original, provably created local-ID failure Page, never the recovered Page. */
  ownedDeadLocalPage?: any;
  ownedDeadLocalUrl?: string;
  ownedDeadLocalConversationUrl?: string;
  ownedDeadLocalTimeoutMs?: number;
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
  // Keyed recovery proves one owned assistant, never merely the last candidate.
  if (assistants.length !== 1) return { state: 'continuity-unproven' };
  const assistant = assistants[0]!;
  const reply = assistant.text;
  if (!assistant.key || !normalizeVisibleText(reply)) return { state: 'continuity-unproven' };
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
          contentRootSelector: string;
        assistantKey: string;
        turnSelector: string;
        inProgressSelector: string;
        actionSelector: string;
        continuationSelector: string;
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
        // Canonical notation for visible DOM only, not reconstructed Markdown.
        const serializeAssistant = (message: Element, selected: boolean): { text: string; complete: boolean } => {
          const wholeRow = () => ({ text: (message as HTMLElement).innerText, complete: true });
          const unsupported = () => selected ? { text: '', complete: false } : wholeRow();
          if (message.querySelectorAll('pre').length === 0) return wholeRow();
          const roots = Array.from(message.querySelectorAll(args.contentRootSelector));
          if (roots.length !== 1) return unsupported();
          const root = roots[0]!;
          const view = root.ownerDocument?.defaultView;
          if (!view || typeof view.getComputedStyle !== 'function') return unsupported();
          const visible = (node: Element): boolean => {
            for (let current: Element | null = node; current; current = current.parentElement) {
              if (current.tagName === 'BUTTON' || current.getAttribute('role') === 'button'
                || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')
                || typeof current.getClientRects !== 'function' || current.getClientRects().length === 0) return false;
              const style = view.getComputedStyle(current);
              if (!style || style.display === 'none' || style.visibility === 'hidden'
                || style.visibility === 'collapse') return false;
              if (current === message) return true;
            }
            return false;
          };
          if (!visible(root)) return unsupported();
          // root.children omits direct Text nodes; do not certify a lossy rich reply.
          if (Array.from(root.childNodes).some((node) => node.nodeType === 3 && Boolean(node.textContent?.trim()))) {
            return unsupported();
          }
          const blocks: string[] = [];
          for (const child of Array.from(root.children)) {
            const pres = [
              ...(child.tagName === 'PRE' ? [child] : []),
              ...Array.from(child.querySelectorAll('pre')),
            ];
            if (!visible(child)) {
              // A display:contents wrapper has no rectangle but may render prose children.
              if (pres.length > 0 || view.getComputedStyle(child)?.display === 'contents') return unsupported();
              continue;
            }
            if (pres.length === 0) {
              // Whole innerText preserves browser whitespace for prose,
              // headings, tables and lists. Ambiguous nested controls fail.
              if (child.querySelector('button, [role="button"], [aria-hidden="true"], [inert]')) return unsupported();
              const block = (child as HTMLElement).innerText;
              if (block) blocks.push(block);
              continue;
            }
            if (pres.length !== 1 || /^(?:P|UL|OL|LI|BLOCKQUOTE|TABLE|H[1-6])$/u.test(child.tagName)) {
              return unsupported();
            }
            const pre = pres[0]!;
            const directCodes = Array.from(pre.children).filter((node) => node.tagName === 'CODE');
            if (!visible(pre) || directCodes.length !== 1 || pre.querySelectorAll('code').length !== 1) {
              return unsupported();
            }
            const code = directCodes[0]!;
            if (!visible(code)) return unsupported();
            // code.innerText includes some aria-hidden/inert/control descendant text.
            if (code.querySelector('button, [role="button"], [aria-hidden="true"], [inert]')) return unsupported();
            // Language comes exclusively from unique visible non-control
            // text outside CODE in this one header-and-pre wrapper.
            const headerSiblings = pre.parentElement === child
              ? Array.from(child.children).filter((candidate) => candidate !== pre
                && candidate.tagName !== 'BUTTON' && candidate.getAttribute('role') !== 'button'
                && visible(candidate))
              : [];
            const header = headerSiblings.length === 1
              && Array.from(child.children).indexOf(headerSiblings[0]!) < Array.from(child.children).indexOf(pre)
              && (headerSiblings[0]!.tagName === 'HEADER'
                || (headerSiblings[0]!.tagName === 'DIV'
                  && (/(?:^|\s)header(?:\s|$)/u.test(headerSiblings[0]!.getAttribute('class') ?? '')
                    || Boolean(headerSiblings[0]!.querySelector('button, [role="button"]')))))
              ? headerSiblings[0]! : null;
            const labels: string[] = [];
            let invalidLabel = false;
            let sawPre = false;
            const visitLabel = (node: Element): void => {
              if (node === code) return;
              // Prose is not a language label: allow only inline header labels
              // outside PRE, or visible language text within this same PRE.
              if (node !== child && node !== pre && !/^(?:SPAN|LABEL|DIV|HEADER)$/u.test(node.tagName)) {
                invalidLabel = true;
                return;
              }
              if (node === pre) sawPre = true;
              const children = Array.from(node.childNodes);
              if (children.length === 0 && node !== child) {
                const leaf = (node as HTMLElement).innerText?.trim();
                if (leaf) {
                  if (node === pre || node.parentElement === pre || (header !== null
                    && (node === header || node.parentElement === header))) labels.push(leaf);
                  else invalidLabel = true;
                }
                return;
              }
              for (const item of children) {
                if (item.nodeType === 3) {
                  const label = item.textContent?.trim();
                  if (label) {
                    if (node === pre || node.parentElement === pre || (header !== null
                      && (node === header || node.parentElement === header))) labels.push(label);
                    else invalidLabel = true;
                  }
                } else if (item.nodeType === 1) {
                  const element = item as Element;
                  if (element === code || element.tagName === 'BUTTON'
                    || element.getAttribute('role') === 'button'
                    || element.getAttribute('aria-hidden') === 'true'
                    || element.hasAttribute('inert') || !visible(element)) continue;
                  if (node === child && child !== pre && sawPre && element !== pre) {
                    invalidLabel = true;
                    continue;
                  }
                  visitLabel(element);
                }
              }
            };
            visitLabel(child);
            if (invalidLabel) return unsupported();
            if (labels.length > 1 || labels.some((label) => !/^[A-Za-z][A-Za-z0-9_+#.-]{0,31}$/u.test(label))) {
              return unsupported();
            }
            const codeText = (code as HTMLElement).innerText;
            if (typeof codeText !== 'string') return unsupported();
            const backtickRuns = codeText.match(/\x60+/gu) ?? [];
            const fence = String.fromCharCode(96).repeat(Math.max(3, ...backtickRuns.map((run) => run.length + 1)));
            blocks.push(fence + (labels[0] ?? '') + '\n' + codeText
              + (codeText.endsWith('\n') ? '' : '\n') + fence);
          }
          return blocks.length > 0 ? { text: blocks.join('\n\n'), complete: true } : unsupported();
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
            let text = (element as HTMLElement).innerText;
            let rowComplete = true;
            if (role === 'assistant') {
              const serialized = serializeAssistant(element, canonicalKey(element) === args.assistantKey);
              text = serialized.text;
              rowComplete = serialized.complete;
            }
            rows.push({
              role,
              text,
              key: canonicalKey(element),
              domIndex,
              complete: rowComplete,
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
        const lateContinue = typeof document !== 'undefined'
          && Array.from(document.querySelectorAll(args.continuationSelector)).some((control) => {
            const rect = control.getBoundingClientRect();
            const style = control.ownerDocument?.defaultView?.getComputedStyle(control);
            return rect.height > 0 && (!style || (style.display !== 'none' && style.visibility !== 'hidden'))
              && !control.hasAttribute('disabled') && control.getAttribute('aria-disabled') !== 'true';
          });
        return { rows, assistantFinal: assistantFinal && !lateContinue };
      }, {
        roleAttribute: MESSAGE_AUTHOR_ROLE_ATTR,
        userMessageStyle: USER_MESSAGE_STYLE,
        unitKeyAttribute: MESSAGE_UNIT_KEY_ATTR,
        assistantMessageStyle: ASSISTANT_MESSAGE_STYLE,
        contentRootSelector: ASSISTANT_CONTENT_ROOT_SELECTOR,
        assistantKey: expected.assistantKey,
        turnSelector: CONVERSATION_TURN_SECTION_SELECTOR,
        inProgressSelector: ASSISTANT_TURN_IN_PROGRESS_SELECTOR,
        actionSelector: ASSISTANT_TURN_ACTION_SELECTOR,
        continuationSelector: CONTINUE_GENERATING_SELECTOR,
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
  // Stability and publication use the same original observation; normalization is
  // reserved for explicit comparison-only callers.
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
  if (assistants.length > 1) {
    return { state: 'uncertain', cause: 'owned_reply_boundary_unproven' };
  }

  if (uncertainCause) {
    if (inProgress || assistants.length === 0) {
      return {
        state: 'uncertain',
        cause: uncertainCause,
        ...(observedUserHeads ? { observedUserHeads } : {}),
      };
    }
    const finalReply = assistants.at(-1)?.text ?? '';
    if (normalizeVisibleText(finalReply)) return { state: 'ready', reply: finalReply };
    return {
      state: 'uncertain',
      cause: uncertainCause,
      ...(observedUserHeads ? { observedUserHeads } : {}),
    };
  }

  if (!inProgress && assistants.length > 0) {
    const finalReply = assistants.at(-1)?.text ?? '';
    if (normalizeVisibleText(finalReply)) return { state: 'ready', reply: finalReply };
  }

  return { state: 'waiting' };
}

function definitelyMalformedChatTarget(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if ((parsed.origin !== 'https://chatgpt.com' && parsed.origin !== 'https://chat.openai.com')
      || parsed.username || parsed.password) return true;
    // A plausible identifier can be absent or temporarily unhydrated; that is
    // not evidence that the conversation does not exist.
    return conversationUuidFromUrl(raw) === undefined
      || !/^\/(?:c\/[^/]+|g\/g-p-[^/]+\/c\/[^/]+)\/?$/iu.test(parsed.pathname);
  } catch {
    return true;
  }
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

      ...(incident.extendedReadiness ? {
        entry_nonresponsive_count: incident.extendedReadiness.entryNonresponsiveCount,
        ...(incident.extendedReadiness.terminalNonresponsiveCount !== undefined ? {
          terminal_nonresponsive_count: incident.extendedReadiness.terminalNonresponsiveCount,
        } : {}),
        extended_readiness_elapsed_ms: incident.extendedReadiness.elapsedMs,
        outcome: incident.extendedReadiness.outcome,
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
  preserveNetworkChange = false,
  useInvocationDeadline = false,
): Promise<number> {
  const waitMs = useInvocationDeadline ? deadlineMs - Date.now()
    : Math.min(MAX_LOCAL_READ_WAIT_MS, deadlineMs - Date.now());
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
    if (preserveNetworkChange && error instanceof Error && /ERR_NETWORK_CHANGED/iu.test(error.message)) throw error;
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
  historicalBaseline = false,
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
          contentRootSelector: string;
          ownedMarker?: string;
          historicalBaseline: boolean;
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
          // Canonical notation for visible DOM only, not reconstructed Markdown.
          const serializeAssistant = (message: Element, selected: boolean): { text: string; complete: boolean } => {
            const wholeRow = () => ({ text: (message as HTMLElement).innerText, complete: true });
            const unsupported = () => selected ? { text: '', complete: false } : wholeRow();
            if (message.querySelectorAll('pre').length === 0) return wholeRow();
            const roots = Array.from(message.querySelectorAll(args.contentRootSelector));
            if (roots.length !== 1) return unsupported();
            const root = roots[0]!;
            const view = root.ownerDocument?.defaultView;
            if (!view || typeof view.getComputedStyle !== 'function') return unsupported();
            const visible = (node: Element): boolean => {
              for (let current: Element | null = node; current; current = current.parentElement) {
                if (current.tagName === 'BUTTON' || current.getAttribute('role') === 'button'
                  || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')
                  || typeof current.getClientRects !== 'function' || current.getClientRects().length === 0) return false;
                const style = view.getComputedStyle(current);
                if (!style || style.display === 'none' || style.visibility === 'hidden'
                  || style.visibility === 'collapse') return false;
                if (current === message) return true;
              }
              return false;
            };
            if (!visible(root)) return unsupported();
            // root.children omits direct Text nodes; do not certify a lossy rich reply.
            if (Array.from(root.childNodes).some((node) => node.nodeType === 3 && Boolean(node.textContent?.trim()))) {
              return unsupported();
            }
            const blocks: string[] = [];
            for (const child of Array.from(root.children)) {
              const pres = [
                ...(child.tagName === 'PRE' ? [child] : []),
                ...Array.from(child.querySelectorAll('pre')),
              ];
              if (!visible(child)) {
                // A display:contents wrapper has no rectangle but may render prose children.
                if (pres.length > 0 || view.getComputedStyle(child)?.display === 'contents') return unsupported();
                continue;
              }
              if (pres.length === 0) {
                // Whole innerText preserves browser whitespace for prose,
                // headings, tables and lists. Ambiguous nested controls fail.
                if (child.querySelector('button, [role="button"], [aria-hidden="true"], [inert]')) return unsupported();
                const block = (child as HTMLElement).innerText;
                if (block) blocks.push(block);
                continue;
              }
              if (pres.length !== 1 || /^(?:P|UL|OL|LI|BLOCKQUOTE|TABLE|H[1-6])$/u.test(child.tagName)) {
                return unsupported();
              }
              const pre = pres[0]!;
              const directCodes = Array.from(pre.children).filter((node) => node.tagName === 'CODE');
              if (!visible(pre) || directCodes.length !== 1 || pre.querySelectorAll('code').length !== 1) {
                return unsupported();
              }
              const code = directCodes[0]!;
              if (!visible(code)) return unsupported();
              // code.innerText includes some aria-hidden/inert/control descendant text.
              if (code.querySelector('button, [role="button"], [aria-hidden="true"], [inert]')) return unsupported();
              // Language comes exclusively from unique visible non-control
              // text outside CODE in this one header-and-pre wrapper.
              const headerSiblings = pre.parentElement === child
                ? Array.from(child.children).filter((candidate) => candidate !== pre
                  && candidate.tagName !== 'BUTTON' && candidate.getAttribute('role') !== 'button'
                  && visible(candidate))
                : [];
              const header = headerSiblings.length === 1
                && Array.from(child.children).indexOf(headerSiblings[0]!) < Array.from(child.children).indexOf(pre)
                && (headerSiblings[0]!.tagName === 'HEADER'
                  || (headerSiblings[0]!.tagName === 'DIV'
                    && (/(?:^|\s)header(?:\s|$)/u.test(headerSiblings[0]!.getAttribute('class') ?? '')
                      || Boolean(headerSiblings[0]!.querySelector('button, [role="button"]')))))
                ? headerSiblings[0]! : null;
              const labels: string[] = [];
              let invalidLabel = false;
              let sawPre = false;
              const visitLabel = (node: Element): void => {
                if (node === code) return;
                // Prose is not a language label: allow only inline header labels
                // outside PRE, or visible language text within this same PRE.
                if (node !== child && node !== pre && !/^(?:SPAN|LABEL|DIV|HEADER)$/u.test(node.tagName)) {
                  invalidLabel = true;
                  return;
                }
                if (node === pre) sawPre = true;
                const children = Array.from(node.childNodes);
                if (children.length === 0 && node !== child) {
                  const leaf = (node as HTMLElement).innerText?.trim();
                  if (leaf) {
                    if (node === pre || node.parentElement === pre || (header !== null
                      && (node === header || node.parentElement === header))) labels.push(leaf);
                    else invalidLabel = true;
                  }
                  return;
                }
                for (const item of children) {
                  if (item.nodeType === 3) {
                    const label = item.textContent?.trim();
                    if (label) {
                      if (node === pre || node.parentElement === pre || (header !== null
                        && (node === header || node.parentElement === header))) labels.push(label);
                      else invalidLabel = true;
                    }
                  } else if (item.nodeType === 1) {
                    const element = item as Element;
                    if (element === code || element.tagName === 'BUTTON'
                      || element.getAttribute('role') === 'button'
                      || element.getAttribute('aria-hidden') === 'true'
                      || element.hasAttribute('inert') || !visible(element)) continue;
                    if (node === child && child !== pre && sawPre && element !== pre) {
                      invalidLabel = true;
                      continue;
                    }
                    visitLabel(element);
                  }
                }
              };
              visitLabel(child);
              if (invalidLabel) return unsupported();
              if (labels.length > 1 || labels.some((label) => !/^[A-Za-z][A-Za-z0-9_+#.-]{0,31}$/u.test(label))) {
                return unsupported();
              }
              const codeText = (code as HTMLElement).innerText;
              if (typeof codeText !== 'string') return unsupported();
              const backtickRuns = codeText.match(/\x60+/gu) ?? [];
              const fence = String.fromCharCode(96).repeat(Math.max(3, ...backtickRuns.map((run) => run.length + 1)));
              blocks.push(fence + (labels[0] ?? '') + '\n' + codeText
                + (codeText.endsWith('\n') ? '' : '\n') + fence);
            }
            return blocks.length > 0 ? { text: blocks.join('\n\n'), complete: true } : unsupported();
          };
          // A final historical assistant is not the current response while
          // taking a pre-Send baseline. After Send the marker, not the last
          // page-wide assistant, bounds the owned turn against later users.
          const isUser = (node: Element): boolean =>
            node.querySelector(`[${args.roleAttribute}]`)?.getAttribute(args.roleAttribute) === args.userMessageStyle
            || (node.getAttribute(args.unitKeyAttribute) ?? '').endsWith(':user');
          const ownedUserIndices = args.ownedMarker
            ? elements.flatMap((node, index) => {
              if (!isUser(node)) return [];
              const rendered = (node as HTMLElement).innerText;
              const head = typeof rendered === 'string'
                ? rendered.match(/^[\p{White_Space}\uFEFF\u200B]*([^\p{White_Space}\uFEFF\u200B]+)/u)?.[1]
                : undefined;
              return head === args.ownedMarker ? [index] : [];
            })
            : [];
          const ownedUserIndex = ownedUserIndices.length === 1 ? ownedUserIndices[0]! : -1;
          const nextUserIndex = ownedUserIndex < 0 ? -1
            : elements.findIndex((node, index) => index > ownedUserIndex && isUser(node));
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
              let text = (element as HTMLElement).innerText;
              let rowComplete = true;
              if (role === 'assistant') {
                const hasLaterAssistant = elements.slice(domIndex + 1).some((later) =>
                  later.querySelector(`[${args.roleAttribute}]`)?.getAttribute(args.roleAttribute)
                    === args.assistantMessageStyle);
                const selected = !args.historicalBaseline && (ownedUserIndex >= 0
                  ? domIndex > ownedUserIndex && (nextUserIndex < 0 || domIndex < nextUserIndex)
                  : !hasLaterAssistant);
                const serialized = serializeAssistant(element, selected);
                text = serialized.text;
                rowComplete = serialized.complete;
              }
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
              rows.push({ role, text, key: canonicalKey(element), domIndex, complete: rowComplete, completionReady, continuationVisible });
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
        contentRootSelector: ASSISTANT_CONTENT_ROOT_SELECTOR,
          ownedMarker: expectedMarker,
          historicalBaseline,
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
  diagnostic: ProductWallDiagnostic<true>,
  invocationId: string,
): void {
  if (diagnostic.wall_kind === 'none'
    || diagnostic.wall_kind === 'conversation_fetch_http_429'
    || diagnostic.wall_kind === 'conversation_load_error'
    || diagnostic.http_status === 429) return;
  recordStateLightAdvisoryWall(
    profileKey, diagnostic.wall_kind, `${diagnostic.wall_kind}_detected`,
    invocationId, undefined, undefined, {
      wall_kind: diagnostic.wall_kind, matched_text: diagnostic.matched_text,
      matched_selector: diagnostic.matched_selector,
    },
  );
}

type StateLightObservedWall = ReturnType<typeof classifyProductWall> | ProductWallDiagnostic<true>;

function classifyStateLightProductWall(
  surface: Awaited<ReturnType<typeof productStatusText>>,
): StateLightObservedWall {
  const legacy = classifyProductWall(surface);
  const conversation = classifyConversationProductWall(surface);
  if (conversation.http_status === 429) return conversation;
  if (legacy.state === 'recovery_required') return legacy;
  return conversation.wall_kind === 'none' ? legacy : conversation;
}

async function readPostSendObservation(
  page: any,
  expectedMarker: string,
  baselineCount: number,
  deadlineMs: number,
  observeProductWall?: (diagnostic: StateLightObservedWall) => void,
): Promise<{
  readonly messages: PageMessage[];
  readonly wall: StateLightObservedWall;
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
  let wall: StateLightObservedWall = { wall_kind: 'none', matched_text: 'none', matched_selector: 'none' };
  try {
    const wallProbeMs = Math.min(POST_SEND_PRODUCT_WALL_PROBE_MS, deadlineMs - Date.now());
    if (wallProbeMs > 0) {
      wall = classifyStateLightProductWall(await productStatusText(page, wallProbeMs));
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

async function readComposerReadiness(
  page: any,
  deadline: number,
  observe?: (state: 'absent' | 'disabled' | 'hidden' | 'not_editable' | 'ready' | 'unknown') => void,
  observeFailure?: (cause: 'network_changed' | 'browser_operation_timeout:locator_count') => void,
): Promise<boolean> {
  try {
    const composer = page.locator(COMPOSER_SELECTOR);
    let remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    if (await locatorCount(composer, deadline, true, true) <= 0) {
      observe?.('absent');
      return false;
    }
    if (Date.now() >= deadline) {
      observe?.('unknown');
      return false;
    }

    remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    const readiness = typeof composer.evaluate === 'function'
      ? await boundedBrowserRead(Promise.resolve(composer.evaluate(
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
      )), remainingMs, 'composer_readiness_timeout')
      : undefined;
    if (Date.now() >= deadline) return false;

    // Legacy page fixtures expose presence only. Real DOM-backed locators return
    // the object above; test fixtures with deterministic controls do the same.
    if (!readiness || typeof readiness !== 'object') {
      observe?.('unknown');
      return Date.now() < deadline;
    }
    const observed = readiness as { visible?: unknown; enabled?: unknown; contentEditable?: unknown };
    observe?.(!observed.visible ? 'hidden'
      : !observed.enabled ? 'disabled'
        : !observed.contentEditable ? 'not_editable'
          : 'ready');
    return Boolean(
      observed.visible
      && observed.enabled
      && observed.contentEditable
      && Date.now() < deadline,
    );
  } catch (error) {
    if (isPostSendTargetCrash(error)) throw error;
    const message = error instanceof Error ? error.message : '';
    if (/ERR_NETWORK_CHANGED/iu.test(message)) observeFailure?.('network_changed');
    else if (message === 'browser_operation_timeout:locator_count') {
      observeFailure?.('browser_operation_timeout:locator_count');
    }
    observe?.('unknown');
    return false;
  }
}

type StateLightSendDeliveryWitness = 'owned_user_node' | 'composer_cleared' | 'owned_stop' | 'own_submission_issued' | 'owned_server_user_marker' | 'unproven';

async function readComposerTextForSendDelivery(
  composer: any,
  deadlineMs: number,
): Promise<string | undefined> {
  const text = await readComposerTextWithinDeadline(
    composer, Math.min(deadlineMs, Date.now() + MAX_LOCAL_READ_WAIT_MS),
  );
  return text === undefined ? undefined : collapseUnicodeWhitespace(text);
}

// Read complete visible text within the invocation deadline. Pre-Send matching
// uses the incumbent rendered-payload normalization as well as exact readers.
async function readComposerTextWithinDeadline(
  composer: any,
  deadlineMs: number,
): Promise<string | undefined> {
  const waitMs = deadlineMs - Date.now();
  if (waitMs <= 0) return undefined;
  try {
    return String(await boundedBrowserRead(
      Promise.resolve(composer.innerText({ timeout: waitMs })),
      waitMs,
      'send_delivery_composer_read_timeout',
    ));
  } catch (error) {
    if (isPostSendTargetCrash(error)) throw error;
    return undefined;
  }
}

async function composerPayloadMatchesBeforeSend(
  composer: any,
  expected: string,
  deadlineMs: number,
): Promise<boolean> {
  const visible = await readComposerTextWithinDeadline(composer, deadlineMs);
  // ProseMirror empty paragraphs/trailing breaks change presentation whitespace.
  // Keep the pre-#2670 semantic match; exact DOM readers are additional paths.
  const expectedMarker = extractOwnedPromptMarkerToken(expected);
  const normalizedMatches = visible !== undefined
    // Use the same token authority as post-Send correlation before normalizing.
    && (!isOwnedPromptMarker(expectedMarker) || ownedPromptMarkerMatches(visible, expectedMarker))
    && renderedPayloadMatches(collapseUnicodeWhitespace(visible), expected);
  const matches = normalizedMatches || visible === expected
    || await readLosslessOwnedComposer(composer, deadlineMs, true) === expected
    || await readStructuredComposerText(composer, expected.length, deadlineMs) === expected;
  return matches && Date.now() < deadlineMs;
}

function composerPayloadFailureCause(deadlineMs: number): PreSendComposerFailureCause {
  return Date.now() >= deadlineMs
    ? 'composer_mutation_budget_exhausted' : 'composer_payload_mismatch';
}

async function readStructuredComposerText(
  composer: any, expectedLength: number, deadlineMs: number,
): Promise<string | undefined> {
  const waitMs = deadlineMs - Date.now();
  if (waitMs <= 0 || typeof composer?.evaluate !== 'function') return undefined;
  try {
    const text = await boundedBrowserRead(
      Promise.resolve(composer.evaluate((element: HTMLElement, maxChars: number) => {
        // ProseMirror paragraphs encode document newlines independently of
        // CSS innerText spacing. Text nodes (including spaces/tabs) are literal.
        if (!element.isConnected || !element.isContentEditable
          || !element.classList.contains('ProseMirror')) return undefined;
        const view = element.ownerDocument.defaultView;
        if (!view) return undefined;
        const parts: string[] = [];
        const maxNodes = Math.min(20_000, maxChars * 2 + 256);
        let nodes = 0;
        let chars = 0;
        const append = (value: string): boolean => {
          chars += value.length;
          if (chars > maxChars) return false;
          parts.push(value);
          return true;
        };
        const readable = (node: HTMLElement): boolean => {
          if (node.getAttribute('hidden') !== null || node.getAttribute('aria-hidden') === 'true'
            || node.getAttribute('contenteditable') === 'false') return false;
          const style = view.getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
        };
        const walk = (node: Node, depth: number, trailingBreak: boolean): boolean => {
          if (++nodes > maxNodes || depth > 32) return false;
          if (node.nodeType === 3) return append(node.nodeValue ?? '');
          if (node.nodeType !== 1) return false;
          const child = node as HTMLElement;
          if (!readable(child)) return false;
          if (child.tagName === 'BR') {
            if (child.childNodes.length !== 0) return false;
            return child.classList.contains('ProseMirror-trailingBreak') ? trailingBreak : append('\n');
          }
          if (!(child.tagName === 'P' && depth === 1)
            && !['A', 'SPAN', 'CODE', 'STRONG', 'EM', 'B', 'I', 'S', 'U'].includes(child.tagName)) return false;
          for (let i = 0; i < child.childNodes.length; i++) {
            if (!walk(child.childNodes[i]!, depth + 1,
              child.tagName === 'P' && i === child.childNodes.length - 1)) return false;
          }
          return true;
        };
        if (!readable(element) || element.childNodes.length > maxNodes) return undefined;
        let paragraphs: boolean | undefined;
        for (let i = 0; i < element.childNodes.length; i++) {
          const child = element.childNodes[i]!;
          const isParagraph = child.nodeType === 1 && (child as HTMLElement).tagName === 'P';
          paragraphs ??= isParagraph;
          if (paragraphs !== isParagraph || (isParagraph && i > 0 && !append('\n'))
            || !walk(child, 1, false)) return undefined;
        }
        return parts.join('');
      }, expectedLength)),
      waitMs, 'send_composer_structure_timeout',
    );
    return typeof text === 'string' ? text : undefined;
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
  readonly ownSubmissionIssued?: () => boolean;
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
  // The request observer is on the same held Page and was marked before the
  // action. An issued own POST proves one physical request, not a landed reply.
  const resolvedWitness = witness === 'unproven' && input.ownSubmissionIssued?.()
    ? 'own_submission_issued' as const : witness;
  return {
    sendCount: resolvedWitness === 'unproven' ? 0 : 1,
    witness: resolvedWitness,
    ...(actionError ? { actionError, preDispatchTimeoutProven: affirmativePreActionabilityTimeout(actionError) } : {}),
  };
}

const FRESH_SEND_WINDOW_MS = 15_000;
const FRESH_SEND_RESERVE_MS = 4 * FRESH_SEND_WINDOW_MS;
const FRESH_SEND_PREPARE_RESERVE_MS = 3 * MAX_LOCAL_READ_WAIT_MS;

const FRESH_SEND_EXTENDED_TOTAL_MS = 600_000;
const FRESH_SEND_TERMINAL_PROBE_MS = 5_000;
const FRESH_SEND_EXTENDED_POLL_MS = 2_000;

async function waitForExtendedFreshSendButton(
  page: any,
  sendButton: any,
  assertOwnerAndPage: () => void,
  cutoffMs: number,
): Promise<'enabled' | 'never_enabled' | 'busy'> {
  while (Date.now() < cutoffMs) {
    assertOwnerAndPage();
    if (await readFreshStopVisible(page, cutoffMs) !== false) return 'busy';
    const waitMs = Math.min(MAX_LOCAL_READ_WAIT_MS, cutoffMs - Date.now());
    if (waitMs <= 0) break;
    try {
      const count = await boundedBrowserRead(
        Promise.resolve(sendButton.count()), waitMs, 'fresh_extended_send_count_timeout',
      );
      if (count === 1 && typeof sendButton.isVisible === 'function'
        && typeof sendButton.isEnabled === 'function') {
        const actionable = await boundedBrowserRead(
          Promise.all([sendButton.isVisible(), sendButton.isEnabled()]),
          Math.min(MAX_LOCAL_READ_WAIT_MS, Math.max(1, cutoffMs - Date.now())),
          'fresh_extended_send_actionability_timeout',
        );
        if (actionable[0] === true && actionable[1] === true && Date.now() < cutoffMs) {
          assertOwnerAndPage();
          return 'enabled';
        }
      }
    } catch {
      // Unknown actionability never grants a physical Send.
      return 'busy';
    }
    if (Date.now() < cutoffMs) {
      await sleep(page, Math.min(FRESH_SEND_EXTENDED_POLL_MS, cutoffMs - Date.now()));
    }
  }
  return 'never_enabled';
}


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
  // All four windows have their full 15s; polls do not sleep to a window boundary
  // when a button becomes enabled.
  for (let windowIndex = 1; windowIndex <= 4; windowIndex++) {
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
    if (!await composerPayloadMatchesBeforeSend(
      input.composer, input.markerPayload, input.deadlineMs,
    )) return false;
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
// Unlike editor-normalizing readers, both DOM views must independently
// reproduce every code point of the invocation payload. ProseMirror/other
// editors whose DOM cannot expose the exact newlines must fail closed.
async function readLosslessOwnedComposer(
  composer: any,
  deadlineMs: number,
  useInvocationDeadline = false,
): Promise<string | undefined> {
  const waitMs = useInvocationDeadline ? deadlineMs - Date.now()
    : Math.min(MAX_LOCAL_READ_WAIT_MS, deadlineMs - Date.now());
  if (waitMs <= 0 || typeof composer?.evaluate !== 'function') return undefined;
  try {
    const result = await boundedBrowserRead(
      Promise.resolve(composer.evaluate((element: HTMLElement) => ({
        content: element.textContent,
        visible: element.innerText,
      }))),
      waitMs, 'recovery_lossless_composer_timeout',
    ) as { content?: unknown; visible?: unknown };
    return typeof result.content === 'string' && result.content === result.visible
      ? result.content : undefined;
  } catch {
    return undefined;
  }
}

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
    if (!await composerPayloadMatchesBeforeSend(
      input.composer, input.markedPayload, input.deadlineMs,
    )) return false;
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
    // Any new turn carrier, including a completed assistant reply with no Stop,
    // contradicts the immutable pre-Send baseline during negative recovery.
    if (current.length !== baseline.carriers.length) return false;
    // The final Stop/liveness/URL check follows the transcript read so a late
    // generation or redirect cannot turn a stale census into a second click.
    return await readFreshStopVisible(input.page, input.deadlineMs) === false && samePage();
  } catch {
    return false;
  }
}

const SERVER_CHECKED_SEND_SETTLE_MS = 30_000;
// A skipped poll cannot certify a continuous idle interval; fail closed under
// event-loop stalls or slow DOM reads without extending the settle/deadline.
const SERVER_CHECKED_MAX_SAMPLE_GAP_MS = INITIAL_POLL_MS * 3;

/** Only an existing exactly owned held Page may spend the one recovery click.
 * This uses the D45 observer for both the explicit request and the completed
 * response; no transport or listener is added and all failed reads stay unknown.
 */
async function observeExistingServerCheckedRecovery(input: {
  page: any;
  browser: any;
  composer: any;
  targetChatUrl: string;
  markedPayload: string;
  marker: string;
  baselineSnapshot?: AtomicTranscriptSnapshot;
  heldWitness?: HeldPage429Witness;
  deadlineMs: number;
}): Promise<'server_marker_present' | 'marker_absent_complete' | 'unproven'> {
  const witness = input.heldWitness;
  const expectedUuid = conversationUuidFromUrl(input.targetChatUrl);
  if (!witness || !expectedUuid || !input.baselineSnapshot?.complete) return 'unproven';
  const identity = () => !browserOrPageDefinitelyLost(input.page, input.browser)
    && getOwnTargetInfo(input.browser)?.created === true
    && !cleanupAuthorityUnprovenPages.has(input.page)
    && normalizeConversationUrl(String(input.page.url())) === input.targetChatUrl
    && readOwnedConversationIdentity(input.page, input.targetChatUrl).matched
    && Date.now() < input.deadlineMs;
  const positive = () => witness.ownSubmissionIssued() || witness.serverMarkerPresent() === true;
  if (!identity() || positive()) {
    return witness.serverMarkerPresent() ? 'server_marker_present' : 'unproven';
  }
  // Reserve a bounded same-Page GET and possible action in the original budget.
  const settleStart = Date.now();
  const settleUntil = settleStart + SERVER_CHECKED_SEND_SETTLE_MS;
  if (settleUntil + 3 * MAX_LOCAL_READ_WAIT_MS >= input.deadlineMs) return 'unproven';
  let lastSampleAt = settleStart;
  while (Date.now() < settleUntil) {
    if (!identity() || positive()
      || await readLosslessOwnedComposer(input.composer, input.deadlineMs) !== input.markedPayload
      || !await existingRetryDomGuards({
        page: input.page, browser: input.browser, composer: input.composer,
        targetChatUrl: input.targetChatUrl, markedPayload: input.markedPayload,
        marker: input.marker, baselineSnapshot: input.baselineSnapshot,
        deadlineMs: input.deadlineMs,
      })) return witness.serverMarkerPresent() ? 'server_marker_present' : 'unproven';
    // A slow read or stalled event loop could hide a transient Stop/generation.
    // Every sample must follow its predecessor within the bounded poll gap.
    const sampledAt = Date.now();
    if (sampledAt - lastSampleAt > SERVER_CHECKED_MAX_SAMPLE_GAP_MS) return 'unproven';
    lastSampleAt = sampledAt;
    if (!identity()) return 'unproven';
    const waitMs = Math.min(INITIAL_POLL_MS, settleUntil - Date.now());
    if (waitMs > 0) await sleep(input.page, waitMs);
    if (Date.now() - lastSampleAt > SERVER_CHECKED_MAX_SAMPLE_GAP_MS) return 'unproven';
  }
  if (Date.now() - lastSampleAt > SERVER_CHECKED_MAX_SAMPLE_GAP_MS
    || !identity() || positive() || Date.now() >= input.deadlineMs - 2 * MAX_LOCAL_READ_WAIT_MS
    || await readLosslessOwnedComposer(input.composer, input.deadlineMs) !== input.markedPayload
    || !await existingRetryDomGuards({
      page: input.page, browser: input.browser, composer: input.composer,
      targetChatUrl: input.targetChatUrl, markedPayload: input.markedPayload,
      marker: input.marker, baselineSnapshot: input.baselineSnapshot, deadlineMs: input.deadlineMs,
    })) return witness.serverMarkerPresent() ? 'server_marker_present' : 'unproven';
  const beforeSequence = witness.ownedGetRequestSequence();
  const getDeadline = Math.min(input.deadlineMs - MAX_LOCAL_READ_WAIT_MS,
    Date.now() + MAX_LOCAL_READ_WAIT_MS);
  try {
    const waitMs = getDeadline - Date.now();
    if (waitMs <= 0) return 'unproven';
    // The browser performs precisely one explicit same-origin GET from the
    // held Page. A returned status/body alone is NEVER authority for recovery.
    await boundedBrowserRead(
      Promise.resolve(input.page.evaluate(async (details: { uuid: string; marker: string }) => {
        const response = await fetch('/backend-api/conversations/' + details.uuid, {
          credentials: 'same-origin',
          headers: { 'x-opk-recovery-invocation': details.marker },
        });
        await response.arrayBuffer();
      }, { uuid: expectedUuid, marker: input.marker })),
      waitMs, 'recovery_owned_conversation_get_timeout',
    );
  } catch { return 'unproven'; }
  if (!identity() || positive() || witness.ownedGetRequestSequence() !== beforeSequence + 1) {
    return witness.serverMarkerPresent() ? 'server_marker_present' : 'unproven';
  }
  const expectedSequence = beforeSequence + 1;
  // The existing response callback finishes its body asynchronously. Wait
  // within the remaining original deadline; never initiate another GET.
  const resultDeadline = Math.min(input.deadlineMs - MAX_LOCAL_READ_WAIT_MS, Date.now() + MAX_LOCAL_READ_WAIT_MS);
  while (identity() && Date.now() < resultDeadline) {
    const summary = witness.latestSuccessfulGet();
    if (summary?.requestSequence === expectedSequence && summary.uuid === expectedUuid && summary.complete) {
      if (summary.markerPresent) return 'server_marker_present';
      return summary.explicitRecoveryProbe && !positive()
        ? 'marker_absent_complete' : 'unproven';
    }
    await sleep(input.page, Math.min(INITIAL_POLL_MS, resultDeadline - Date.now()));
  }
  return 'unproven';
}

async function waitForComposer(
  page: any,
  invocationDeadlineMs: number,
  useWholePreSendDeadline = false,
  observeProductWall?: (diagnostic: ReturnType<typeof classifyProductWall>) => void,
  detectAccountLoadError = false,
  observeComposer?: (state: 'absent' | 'disabled' | 'hidden' | 'not_editable' | 'ready' | 'unknown') => void,
  observeConversationWall?: (diagnostic: ProductWallDiagnostic<true>) => void,
): Promise<{ state: 'ready' } | { state: TurnState; cause: string }> {
  // Preserve the legacy two-argument helper contract used by in-process tests.
  // Committed pre-send navigations explicitly opt into the whole invocation deadline.
  const readinessDeadline = useWholePreSendDeadline
    ? invocationDeadlineMs
    : Math.min(Date.now() + COMPOSER_READINESS_WAIT_MS, invocationDeadlineMs);
  let observedFailure: 'network_changed' | 'browser_operation_timeout:locator_count' | undefined;
  while (true) {
    let remainingMs = readinessDeadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      const surface = await productStatusText(page, Math.min(MAX_LOCAL_READ_WAIT_MS, remainingMs));
      const wall = classifyStateLightProductWall(surface);
      observeProductWall?.(classifyProductWall(surface));
      if ('wall_kind' in wall && (wall.wall_kind === 'conversation_load_error'
        || wall.wall_kind === 'conversation_fetch_http_429')) observeConversationWall?.(wall);
      const held429 = heldPage429Diagnostic(page);
      if (held429) {
        observeConversationWall?.(held429);
        return { state: 'rate_limit', cause: held429.wall_kind };
      }
      if (detectAccountLoadError && 'wall_kind' in wall && wall.wall_kind === 'account_load_error') {
        return { state: 'ui_contract_mismatch', cause: 'account_load_error' };
      }
      if ('wall_kind' in wall && wall.wall_kind === 'conversation_load_error') {
        return { state: 'recovery_required', cause: 'conversation_load_error' };
      }
      if (wall.state === 'recovery_required') return { state: 'recovery_required', cause: wall.cause };
    } catch {
      // Status-probe failures cannot veto the composer; the probe is advisory.
    }
    if (Date.now() >= readinessDeadline) break;
    if (await readComposerReadiness(page, readinessDeadline, observeComposer, (cause) => {
      // Preserve only witnessed transport failures; a slow/disabled composer is
      // not a network error. A later ready composer supersedes these probes.
      if (cause === 'network_changed' || observedFailure !== 'network_changed') observedFailure = cause;
    })) {
      const late429 = heldPage429Diagnostic(page);
      if (late429) {
        observeConversationWall?.(late429);
        return { state: 'rate_limit', cause: late429.wall_kind };
      }
      return { state: 'ready' };
    }
    remainingMs = readinessDeadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(page, Math.min(INITIAL_POLL_MS, remainingMs));
  }
  return { state: 'ui_contract_mismatch', cause: observedFailure ?? 'composer_unavailable' };
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
  beforeAction?: () => void,
): Promise<PreSendComposerFailureCause | null> {
  const composer = page.locator(COMPOSER_SELECTOR);
  const insertionStart = Date.now();
  const insertionBudgetMs = deriveComposerInsertionBudgetMs(text);
  // The line estimate is diagnostic only. Both fill() timeouts, including a
  // single large line, use the remaining finite invocation deadline below.
  const insertionDeadlineMs = invocationDeadlineMs;
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
      composerAbsent = await locatorCount(composer, invocationDeadlineMs, false, true) === 0;
    } catch {
      return exhausted('readiness_before_click');
    }
    try {
      let actionBudgetMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
      if (actionBudgetMs <= 0) return exhausted('budget_before_click');
      beforeAction?.();
      await composer.click({ timeout: actionBudgetMs });
      actionBudgetMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
      if (actionBudgetMs <= 0) return exhausted('budget_before_fill');
      beforeAction?.();
      await composer.fill(text, { timeout: actionBudgetMs });
      // Verify the complete draft even when readiness recovered during fill.
      if (await readComposerReadiness(page, invocationDeadlineMs)) {
        return await composerPayloadMatchesBeforeSend(composer, text, invocationDeadlineMs)
          ? null : composerPayloadFailureCause(invocationDeadlineMs);
      }
    } catch (error) {
      if (error instanceof Error && (error.message === 'conversation_fetch_http_429'
        || (error.message === 'rate_limit' && heldPage429Diagnostic(page)?.http_status === 429)
        || error.message === 'account_cooldown_active')) throw error;
      // The mutation was attempted; classify from the pre-attempt presence proof.
    }
    return composerAbsent ? 'composer_unavailable' : exhausted('readiness_before_click');
  }

  try {
    let actionBudgetMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
    if (actionBudgetMs <= 0) return exhausted('budget_before_click');
    beforeAction?.();
    await composer.click({ timeout: actionBudgetMs });
    if (Date.now() >= insertionDeadlineMs) return exhausted('after_click');

    actionBudgetMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
    if (actionBudgetMs <= 0) return exhausted('budget_before_fill');
    if (!(await readComposerReadiness(page, insertionDeadlineMs))) {
      return exhausted('readiness_before_fill');
    }
    actionBudgetMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
    if (actionBudgetMs <= 0) return exhausted('budget_before_fill2');
    beforeAction?.();
    await composer.fill(text, { timeout: actionBudgetMs });
    if (Date.now() >= invocationDeadlineMs) return 'composer_mutation_budget_exhausted';
    return await composerPayloadMatchesBeforeSend(composer, text, invocationDeadlineMs)
      ? null : composerPayloadFailureCause(invocationDeadlineMs);
  } catch (error) {
    if (error instanceof Error && (error.message === 'conversation_fetch_http_429'
      || (error.message === 'rate_limit' && heldPage429Diagnostic(page)?.http_status === 429)
      || error.message === 'account_cooldown_active')) throw error;
    if (
      isPlaywrightTimeoutError(error)
      && Date.now() < invocationDeadlineMs
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
  browser: any, config: BrowserConfig,
): Promise<ConversationPageLookup> {
  if (config.newChat || !config.chatUrl) return { contextUsable: false };
  const target = normalizeConversationUrl(config.chatUrl);
  const contexts = browser.contexts();
  const contextUsable = contexts.length === 1 && typeof contexts[0]?.newPage === 'function';
  if (contexts.length !== 1 || typeof contexts[0].pages !== 'function') return { contextUsable };
  const candidates = (contexts[0].pages() as any[]).filter((candidate) => {
    try { return !candidate.isClosed?.() && ownedConversationIdentityMatches(String(candidate.url()), target); }
    catch { return false; }
  });
  if (candidates.length > 1) throw new Error('ui_contract_mismatch:ambiguous_conversation_targets');
  // The filtered CDP connection already pins one target ID. Existing Stop,
  // marker and exact-conversation checks still gate Send on that Page.
  return { page: candidates[0], contextUsable };
}

async function selectConversationPage(
  browser: any,
  chromium: { connectOverCDP: (endpoint: string, options?: { timeout?: number }) => Promise<any> },
  config: BrowserConfig,
  operationBudget: TurnOperationBudget,
  deadlineMs = Date.now() + operationBudget.clampOperationWaitMs(),
): Promise<{ browser: any; page: any | undefined }> {
  const binding = getOwnTargetInfo(browser);
  if (!binding) throw new Error('ui_contract_mismatch:own_target_attachment_required');
  const contexts = browser.contexts();
  if (binding.created) {
    // Fresh/zero-match fallback target was allocated by this invocation before
    // Playwright bootstrap, never adopted from a pre-existing matching URL.
    if (contexts.length !== 1 || contexts[0].pages().length !== 1) {
      throw new Error('ui_contract_mismatch:own_page_unavailable');
    }
    return { browser, page: contexts[0].pages()[0] };
  }
  let lookup = await findOpenConversationPage(browser, config);
  if (lookup.page) {
    if (typeof lookup.page === 'object') cleanupAuthorityUnprovenPages.add(lookup.page);
    return { browser, page: lookup.page };
  }
  if (lookup.contextUsable) throw new Error('ui_contract_mismatch:own_target_identity_changed');

  // A broken context may reconnect only to the same pinned ID, never another
  // exact-URL tab; the full invocation budget still controls the reconnect.
  await releaseCdpBrowser(browser, Math.min(RESOURCE_CLEANUP_BOUND_MS, operationBudget.clampOperationWaitMs()));
  const attached = await attachOwnTarget(chromium, {
    mode: 'own-target',
    cdp: config.cdp,
    deadlineMs,
    cleanupBudgetMs: RESOURCE_CLEANUP_BOUND_MS,
    chatUrl: config.chatUrl,
    newChat: false,
    pinnedTargetId: binding.targetId,
  });
  lookup = await findOpenConversationPage(attached.browser, config);
  if (!lookup.page) {
    await releaseCdpBrowser(attached.browser, RESOURCE_CLEANUP_BOUND_MS);
    throw new Error('ui_contract_mismatch:own_target_identity_changed');
  }
  if (typeof lookup.page === 'object') cleanupAuthorityUnprovenPages.add(lookup.page);
  return { browser: attached.browser, page: lookup.page };
}

async function navigateOwnedTurnPage(
  page: any,
  config: BrowserConfig,
  navigation: StateLightNavigationCounter,
  invocationDeadlineMs: number,
  beforeGoto?: () => void,
): Promise<void> {
  const target = config.newChat
    ? projectConversationPrefix(config.projectUrl ?? '')
    : normalizeConversationUrl(config.chatUrl ?? '');
  if (!target) throw new Error('ui_contract_mismatch:target_required');
  const remainingMs = invocationDeadlineMs - Date.now();
  if (remainingMs <= 0) throw new BrowserOperationTimeoutError('navigation');
  beforeGoto?.();
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

/** AC12 only: UUID equality never grants destructive close after a route change. */
function ownedPreSendFetch429ExactRoute(page: any, expectedUrl: string): boolean {
  try {
    return normalizeConversationUrl(String(page.url())) === normalizeConversationUrl(expectedUrl);
  } catch {
    return false;
  }
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
    // A mismatched identity is observed foreign UI, not authority to close the held Page.
    ownershipForfeited: true,
    cleanupAction: 'preserve',
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

/**
 * Positive, read-only fetch-loss evidence on the invocation-created Page.
 * Both root and project local-ID routes are supported; a project route must
 * match the configured project before either recovery or destructive cleanup.
 */
async function ownedLocalFetchFailureVisibleOnPage(
  targetPage: any,
  projectUrl: string,
  deadlineMs: number,
  expectedUrl?: string,
): Promise<boolean> {
  try {
    if (deadlineMs <= Date.now()) return false;
    const observedUrl = String(targetPage.url());
    if (expectedUrl !== undefined && observedUrl !== expectedUrl) return false;
    const local = new URL(observedUrl);
    const project = new URL(projectUrl);
    const localRoute = /^\/(?:g\/(g-p-[^/]+)\/)?c\/local-chatgpt(?::|%3a)[a-z0-9-]+$/iu.exec(local.pathname);
    if (!localRoute || local.origin !== project.origin || local.username || local.password
      || (localRoute[1] && !projectSurfaceUrlsEquivalent(
        `${local.origin}/g/${localRoute[1]}`, projectUrl,
      ))) return false;
    // Read only this Page, within one absolute deadline. Never click Retry.
    if (await locatorCount(targetPage.getByText('Failed to fetch', { exact: true }), deadlineMs) <= 0
      || await locatorCount(targetPage.getByRole('button', { name: 'Retry', exact: true }), deadlineMs) <= 0) return false;
    return Date.now() < deadlineMs && String(targetPage.url()) === observedUrl;
  } catch {
    return false;
  }
}

function renderedPayloadMatches(actual: string | undefined, expected: string): boolean {
  return actual !== undefined && actual.replace(/\s+/gu, '') === expected.replace(/\s+/gu, '');
}

/** Compare and clear in one browser-side task, never a stale read followed
 * by a separate fill. An unknown ProseMirror representation is not authority
 * to destroy a shared or foreign draft. */
async function conditionalClearOwnedComposerDraft(
  page: any,
  exactPayload: string,
  deadlineMs: number,
  expectedPageUrl?: string,
): Promise<boolean> {
  const waitMs = Math.min(MAX_LOCAL_READ_WAIT_MS, deadlineMs - Date.now());
  if (!exactPayload || waitMs <= 0) return false;
  const composer = page?.locator?.(COMPOSER_SELECTOR);
  if (typeof composer?.evaluate !== 'function') return false;
  // A Page can navigate after the pre-clear owner read. Compare its current
  // browser-side URL and every payload code point in the SAME modifying task.
  // Direct helper callers without a proved Page route retain the exact-payload
  // comparison only and do not gain finalization/close authority.
  const guard: string | { payload: string; pageUrl: string } = expectedPageUrl
    ? { payload: exactPayload, pageUrl: expectedPageUrl } : exactPayload;
  try {
    return await boundedBrowserRead(
      Promise.resolve(composer.evaluate((element: HTMLElement, guarded: typeof guard) => {
        const expected = typeof guarded === 'string' ? guarded : guarded.payload;
        if (typeof guarded !== 'string'
          && element.ownerDocument?.defaultView?.location?.href !== guarded.pageUrl) return false;
        if (!element.isConnected || !element.isContentEditable
          || element.textContent !== expected || element.innerText !== expected) return false;
        element.textContent = '';
        return element.textContent === '' && element.innerText === '';
      }, guard)),
      waitMs, 'conditional_owned_composer_clear_timeout',
    ) === true;
  } catch {
    return false;
  }
}

async function clearFreshComposerDraft(page: any): Promise<void> {
  try {
    await boundedBrowserRead(page.locator(COMPOSER_SELECTOR).fill('', { timeout: MAX_LOCAL_READ_WAIT_MS }),
      MAX_LOCAL_READ_WAIT_MS, 'fresh_composer_clear_timeout');
  } catch { /* Best-effort cleanup must not hide the pre-send failure. */ }
}

export const __testFreshSend = { renderedPayloadMatches, clearFreshComposerDraft };

async function runTurn(
  args: ParsedTurnArgs,
  recoveryHooks: StateLightRecoveryHooks = {},
  entryLivenessHeartbeat = false,
  heartbeatSchedulerReady?: (scheduler: TurnScopedHeartbeatScheduler) => void,
  freshCleanup?: FreshComposerCleanupContext,
): Promise<TurnRunOutcome> {
  let diagnostic: ProductWallDiagnostic<true> = { wall_kind: 'none', matched_text: 'none', matched_selector: 'none' };
  freshCleanup ??= {};
  try {
    const outcome = await runTurnCore(args, recoveryHooks, entryLivenessHeartbeat, heartbeatSchedulerReady, (value) => {
      if (value.wall_kind === 'account_load_error') diagnostic = value;
      else if (value.http_status === 429) {
        if (diagnostic.wall_kind !== 'account_load_error') diagnostic = value;
      } else if (diagnostic.http_status !== 429 && diagnostic.wall_kind !== 'account_load_error'
        && (value.wall_kind !== 'none' || value.matched_text !== 'none')) diagnostic = value;
    }, freshCleanup);
    // A historical 429 is cooldown evidence, not a verdict on the original
    // positively created target's *current* close ownership. Recovered,
    // selected-existing and unproven Pages still fail closed.
    const knownCreatedOriginal = Boolean(outcome.page
      && outcome.page === freshCleanup.originalCreatedPage
      && getOwnTargetInfo(outcome.browser)?.created === true);
    const ownNotSentFetch429 = outcome.ownedPreSendFetch429Page === outcome.page
      && outcome.result.state === 'rate_limit'
      && outcome.result.cause === 'conversation_fetch_http_429'
      && outcome.result.send_count === 0 && outcome.result.send_attempted !== true;
    if (outcome.page && typeof outcome.page === 'object' && !ownNotSentFetch429
      && !knownCreatedOriginal
      && (diagnostic.http_status === 429 || diagnostic.wall_kind === 'conversation_load_error'
        || outcome.result.cause === 'account_cooldown_active')) {
      cleanupAuthorityUnprovenPages.add(outcome.page);
    }
    return {
      ...outcome,
      result: {
        ...outcome.result,
        product_wall_diagnostic: diagnostic,
        ...(freshCleanup.predecessorCleanupStatus
          ? { predecessor_cleanup_status: freshCleanup.predecessorCleanupStatus,
            ...(freshCleanup.predecessorTargetId ? { predecessor_target_id: freshCleanup.predecessorTargetId } : {}) }
          : {}),
      },
    };
  } finally {
    try {
      if (freshCleanup.page && !freshCleanup.sendAttempted
        && diagnostic.http_status !== 429
        && isBlankProjectSurfaceUrl(String(freshCleanup.page.url()), freshCleanup.projectUrl ?? '')) {
        if (!cleanupAuthorityUnprovenPages.has(freshCleanup.page)
          && typeof freshCleanup.markedPayload === 'string'
          && freshCleanup.markedPayload.length > 0
          && await readFreshStopVisible(freshCleanup.page, Date.now() + MAX_LOCAL_READ_WAIT_MS) === false
          && isBlankProjectSurfaceUrl(String(freshCleanup.page.url()), freshCleanup.projectUrl ?? '')) {
          await conditionalClearOwnedComposerDraft(
            freshCleanup.page, freshCleanup.markedPayload, Date.now() + MAX_LOCAL_READ_WAIT_MS,
            String(freshCleanup.page.url()),
          );
        }
      }
    } catch {
      // A lost page must not hide the original pre-send result.
    }
  }
}

async function runTurnCore(
  args: ParsedTurnArgs,
  recoveryHooks: StateLightRecoveryHooks,
  entryLivenessHeartbeat: boolean,
  heartbeatSchedulerReady: ((scheduler: TurnScopedHeartbeatScheduler) => void) | undefined,
  onProductWallDiagnostic: (diagnostic: ProductWallDiagnostic<true>) => void,
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
    'predecessor-invocation-id',
    'predecessor-attempt-identity',
    'predecessor-run-identity',
    'predecessor-owner-task-id',
  ]);
  const invocationId = stringOption(args, 'invocation-id') ?? '';
  const previousInvocation = stringOption(args, 'predecessor-invocation-id');
  const previousAttempt = stringOption(args, 'predecessor-attempt-identity');
  const previousRun = stringOption(args, 'predecessor-run-identity');
  const previousOwnerTask = stringOption(args, 'predecessor-owner-task-id');
  let profileKey = 'profile-unresolved';
  let browser: any;
  let page: any;
  let sendCount = 0;
  let refusedCooldownUntil: number | undefined;
  let attachAttempts = 0;
  let createdAttachFailureCleanup: 'confirmed' | 'unconfirmed' | undefined;
  let createdAttachFailureTargetId: string | undefined;
  let pollCount = 0;
  const navigation = new StateLightNavigationCounter();
  let journalWriteFailed = false;
  const incidents: BrowserIncident[] = [];
  let afterSend = false;
  let sendAttempted = false;
  let ownedStopDeliveryObserved = false;
  let deliveryProofPendingRecovery = false;
  let ownershipForfeited = false;
  let invocationCreatedExistingChatPage: any;
  let invocationCreatedExistingChatUrl: string | undefined;
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

  let preSendComposerState = 'not_probed';
  let observedProductErrorText = '';
  let held429Witness: HeldPage429Witness | undefined;
  let held429Page: any;
  const preSendPageRoute = (): string => {
    try {
      const url = new URL(String(page.url()));
      // No private chat/project IDs, query, fragment or authentication in logs.
      const path = url.pathname.includes('/c/') ? '/g/<project>/c/<conversation>'
        : url.pathname.includes('/g/') ? '/g/<project>' : '/';
      return url.origin + path;
    } catch { return 'unavailable'; }
  };
  const preSendDiagnostic = (cause: string): void => {
    incident('pre_send_surface_diagnostic',
      `${cause};composer=${preSendComposerState};url=${preSendPageRoute()};product_error=${observedProductErrorText.slice(0, 160)}`,
      'return_local_error');
  };
  const observeProductWall = (wall: StateLightObservedWall): void => {
    const witnessed = heldPage429Diagnostic(page);
    const isAccountHeading = 'wall_kind' in wall && wall.wall_kind === 'account_load_error';
    const hasConversationHeading = 'wall_kind' in wall
      && (wall.wall_kind === 'conversation_load_error'
        || wall.wall_kind === 'conversation_fetch_http_429')
      && wall.matched_text !== 'none';
    const value = witnessed && !isAccountHeading
      ? { ...witnessed,
        matched_text: hasConversationHeading ? wall.matched_text : witnessed.matched_text,
        matched_selector: hasConversationHeading ? wall.matched_selector : witnessed.matched_selector }
      : wall;
    if (!('wall_kind' in value) || (value.matched_text === 'none' && value.wall_kind === 'none')) return;
    if (value.matched_text !== 'none') {
      observedProductErrorText = value.matched_text.replace(/\s+/gu, ' ').slice(0, 160);
    }
    onProductWallDiagnostic(value);
    if (value.wall_kind !== 'none') {
      try { recordProductWallAdvisory(profileKey, value, invocationId); } catch { /* advisory I/O is fail-open */ }
    }
  };
  const attachHeld429 = (heldPage: any, ownedChatUrl?: string): void => {
    held429Witness?.dispose();
    held429Page = heldPage;
    held429Witness = observeHeldPageConversation429(heldPage, ownedChatUrl, (observed) => {
      const published = publishWitnessedStateLight429(profileKey);
      if (published.diagnostic) {
        incident('shared_account_cooldown_diagnostic', published.diagnostic, 'fail_open');
      }
      onProductWallDiagnostic({ ...observed, matched_text: 'none', matched_selector: 'none' });
    });
  };
  const beforeBrowserAction = (): void => {
    const owned429 = heldPage429Diagnostic(page);
    if (owned429) {
      onProductWallDiagnostic(owned429);
      throw new Error(owned429.wall_kind);
    }
    const cooldown = readStateLightAccountCooldown(profileKey);
    if (cooldown.diagnostic) {
      incident('shared_account_cooldown_diagnostic', cooldown.diagnostic, 'fail_open');
    }
    if (cooldown.active) throw new Error('account_cooldown_active');
  };
  // Fresh preparation owns its internal goto. Intercept its existing counter hook
  // immediately before that goto without modifying the excluded helper module.
  const ownedPreSendFetch429CleanupFields = (
    state: TurnState, cause: string,
  ): Pick<TurnRunOutcome, 'ownedPreSendFetch429Page' | 'ownedPreSendFetch429Url'> => (
    state === 'rate_limit' && cause === 'conversation_fetch_http_429'
    && held429Witness?.current()?.wall_kind === 'conversation_fetch_http_429'
    && held429Witness.current()?.http_status === 429
    && !afterSend && !sendAttempted && sendCount === 0
    && !ownershipForfeited && page === invocationCreatedExistingChatPage
    && Boolean(invocationCreatedExistingChatUrl)
    && !cleanupAuthorityUnprovenPages.has(page)
    && !browserOrPageDefinitelyLost(page, browser)
    && ownedPreSendFetch429ExactRoute(page, invocationCreatedExistingChatUrl!)
      ? { ownedPreSendFetch429Page: page, ownedPreSendFetch429Url: invocationCreatedExistingChatUrl }
      : {}
  );
  const guardedFreshPreparationNavigation = new Proxy(navigation, {
    get(target, property, receiver) {
      if (property === 'recordGoto') return () => {
        beforeBrowserAction();
        target.recordGoto();
        held429Witness?.beforeNavigation();
      };
      return Reflect.get(target, property, receiver);
    },
  });

  try {
    if (!invocationId) throw new Error('input_invalid:invocation_id_required');
    if ([previousInvocation, previousAttempt, previousRun, previousOwnerTask].some((value) => Boolean(value))
      && (!previousInvocation || !previousAttempt || !previousRun || !previousOwnerTask
        || previousInvocation === invocationId)) {
      throw new Error('input_invalid:exact_predecessor_selector_required');
    }
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
    if (!baseConfig.newChat && baseConfig.chatUrl
      && definitelyMalformedChatTarget(baseConfig.chatUrl)) {
      incident('invocation_blocker', 'chat_not_found', 'return_local_error');
      return {
        result: compactResult(
          'ui_contract_mismatch', 'invocation', 'chat_not_found',
          invocationId, profileKey, 0, pollCount, navigation, incidents, {},
          journalWriteFailed,
        ),
      };
    }
    const snapshot = readStableInput(requireOption(args, 'input'));
    const destination = destinationIdentity(requireOption(args, 'output'));
    const config = baseConfig;
    const marker = generateOwnedPromptMarker();
    admitStateLightTurnObservation({ profileKey, invocationId, marker });
    const invocationStartedAt = Date.now();
    const invocationDeadlineMs = invocationStartedAt + config.timeoutMs;
    // One absolute fresh-Send budget, shared by early URL landing, post-send
    // observation, bounded Page/CDP cleanup and terminal emission.
    const freshUnboundReturnByMs = invocationDeadlineMs
      - RESOURCE_CLEANUP_BOUND_MS - 15_000 - 2_000;
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

    if (previousInvocation && previousAttempt && previousRun && previousOwnerTask) {
      const previous = await retireExplicitPredecessor({
        previousInvocationId: previousInvocation,
        previousAttemptIdentity: previousAttempt,
        runIdentity: previousRun, ownerTaskId: previousOwnerTask,
        profileKey, cdp: config.cdp,
        deadlineMs: Math.min(invocationDeadlineMs, Date.now() + 20_000),
      });
      if (freshCleanup) {
        freshCleanup.predecessorCleanupStatus = previous.status;
        freshCleanup.predecessorTargetId = previous.targetId;
      }
      if (previous.status !== 'confirmed') throw new Error('predecessor_cleanup_unconfirmed');
    }

    // Refuse a new Send against the shared account cooldown before attachOwnTarget:
    // target allocation (including CDP creation) happens before page selection.
    // Refusal is read-only and cannot extend the existing cooldown deadline.
    const admissionCooldown = readStateLightAccountCooldown(profileKey);
    if (admissionCooldown.diagnostic) {
      incident('shared_account_cooldown_diagnostic', admissionCooldown.diagnostic, 'fail_open');
    }
    if (admissionCooldown.active) {
      refusedCooldownUntil = admissionCooldown.until;
      throw new Error('account_cooldown_active');
    }

    // Distinct invocation-owned Pages do not share a profile-wide composer lock.
    // Exact destination claims and the selected Page's own Stop/marker guards
    // continue to prohibit attaching to another invocation.
    const chromium = loadChromium();
    const connectWaitMs = invocationBudget.clampOperationWaitMs();
    if (connectWaitMs <= 0) throw new BrowserOperationTimeoutError('connect_over_cdp');
    let initiallyAttached: Awaited<ReturnType<typeof attachOwnTarget>>;
    try {
      initiallyAttached = await attachOwnTarget(chromium, {
        mode: 'own-target',
        cdp: config.cdp,
        deadlineMs: invocationDeadlineMs,
        cleanupBudgetMs: RESOURCE_CLEANUP_BOUND_MS,
        ...(config.chatUrl ? { chatUrl: config.chatUrl } : {}),
        newChat: config.newChat,
      });
    } catch (error) {
      // CDP may have created an exact new Page before the proxy or Playwright
      // connection failed. A positive creation ID is carried by that error;
      // no raw-ID close or foreign Page attach is permitted.
      const createdTargetId = (error as { createdTargetId?: unknown } | null)?.createdTargetId;
      if (typeof createdTargetId === 'string' && createdTargetId.length > 0) {
        createdAttachFailureTargetId = createdTargetId;
        createdAttachFailureCleanup = 'unconfirmed';
        try {
          bindStateLightOwnedTarget({
            profileKey, invocationId, targetId: createdTargetId,
            created: true, cdp: config.cdp,
            initialRoute: config.newChat
              ? projectConversationPrefix(config.projectUrl ?? '')
              : normalizeConversationUrl(config.chatUrl ?? ''),
          });
          const retirement = await retireDetachedOriginalTarget({
            profileKey, invocationId, cdp: config.cdp,
            deadlineMs: Date.now() + 20_000,
          });
          if (retirement.targetId === createdTargetId && retirement.status === 'confirmed') {
            createdAttachFailureCleanup = 'confirmed';
          }
        } catch {
          // Never fabricate a confirmed close after a failed independent attach.
        }
      }
      throw error;
    }
    attachAttempts = initiallyAttached.attachAttempts;
    if (initiallyAttached.created && freshCleanup) {
      freshCleanup.originalCreatedPage = initiallyAttached.page;
    }
    browser = initiallyAttached.browser;
    const selection = await selectConversationPage(browser, chromium, config, invocationBudget, invocationDeadlineMs);
    browser = selection.browser;
    page = selection.page;
    const pinOriginalTargetBeforeNavigation = (): void => {
      const info = getOwnTargetInfo(browser);
      if (page && info) {
        bindStateLightOwnedTarget({
          profileKey, invocationId,
          targetId: info.targetId,
          created: info.created,
          cdp: config.cdp,
          initialRoute: config.newChat
            ? projectConversationPrefix(config.projectUrl ?? '')
            : normalizeConversationUrl(config.chatUrl ?? ''),
        });
      }
    };
    pinOriginalTargetBeforeNavigation();
    // Created is attachOwnTarget's affirmative target provenance, not a URL
    // match or a cleanupAction hint. Capture only the original existing-chat Page.
    if (!config.newChat && config.chatUrl && page
      && getOwnTargetInfo(browser)?.created === true
      && !cleanupAuthorityUnprovenPages.has(page)) {
      invocationCreatedExistingChatPage = page;
      invocationCreatedExistingChatUrl = normalizeConversationUrl(config.chatUrl);
    }
    if (page) attachHeld429(page, !config.newChat ? config.chatUrl : undefined);
    if (page && typeof page === 'object' && !getOwnTargetInfo(browser)?.created) {
      // An existing URL-selected tab never grants cleanup or Stop authority.
      cleanupAuthorityUnprovenPages.add(page);
    }
    if (!page || getOwnTargetInfo(browser)?.created) {
      if (!page) {
        page = await createDedicatedTurnPage(browser, invocationBudget);
        pinOriginalTargetBeforeNavigation();
        // Explicit newPage resolution also proves creation, even when the
        // original attach target did not carry a created Page.
        if (!config.newChat && config.chatUrl && !cleanupAuthorityUnprovenPages.has(page)) {
          invocationCreatedExistingChatPage = page;
          invocationCreatedExistingChatUrl = normalizeConversationUrl(config.chatUrl);
        }
      }
      attachHeld429(page, !config.newChat ? config.chatUrl : undefined);
      if (config.newChat && freshCleanup) {
        freshCleanup.page = page;
        freshCleanup.projectUrl = config.projectUrl;
      }
      try {
        // First owned-page load is not a shared cooldown admission gate.
        await navigateOwnedTurnPage(page, config, navigation, invocationDeadlineMs, () => { if (heldPage429Diagnostic(page)) beforeBrowserAction(); held429Witness?.beforeNavigation(); });
      } catch (error) {
        // One total pre-Send reopen: an initial failed committed navigation
        // consumes the first opening; retry only on the same created Page.
        if (!config.newChat || navigation.snapshotGoto() !== 1
          || Date.now() + COMPOSER_READINESS_WAIT_MS + FRESH_SEND_RESERVE_MS >= invocationDeadlineMs
          || /ERR_NETWORK_CHANGED/u.test(error instanceof Error ? error.message : String(error)) === false
            && !(error instanceof Error && /timeout|net::ERR_|navigation|fetch/iu.test(error.message))) {
          throw error;
        }
        await navigateOwnedTurnPage(page, config, navigation, invocationDeadlineMs, () => { beforeBrowserAction(); held429Witness?.beforeNavigation(); });
      }
    }

    let baselineCount = 0;
    let baselineUserNodeCount = 0;
    let baselineSnapshot: AtomicTranscriptSnapshot | undefined;
    let ownedConversationUrl: string | undefined;
    // One invocation-local recovery cap, independent of terminal close authority.
    const originalHeldPage = page;
    const createdFreshPage = config.newChat && getOwnTargetInfo(browser)?.created === true
      && !cleanupAuthorityUnprovenPages.has(page);
    const originalExactChat = !config.newChat && config.chatUrl
      && readOwnedConversationIdentity(page, normalizeConversationUrl(config.chatUrl)).matched
      ? normalizeConversationUrl(config.chatUrl) : undefined;
    let accountReloadAttempted = false;
    let zeroWitnessAccountRecovery = false;
    let markerDerivedSend = false;
    let freshPreSendFetchAlertAbsent = false;

    const accountErrorTerminal = (): TurnRunOutcome => {
      incident('invocation_blocker', 'account_load_error', 'retain_page_no_resend');
      return {
        page, browser, cleanupAction: 'preserve',
        result: compactResult(
          'recovery_required', 'invocation', 'account_load_error',
          invocationId, profileKey, sendCount, pollCount, navigation, incidents,
          { ...(sendAttempted ? { send_attempted: true } : {}) }, journalWriteFailed,
        ),
      };
    };
    const accountErrorOwnershipMismatch = (): TurnRunOutcome => {
      incident('invocation_blocker', 'account_error_page_ownership_unproven', 'preserve_unproven_page');
      return {
        page, browser,
        ...(ownershipForfeited ? { ownershipForfeited: true } : {}),
        cleanupAction: 'preserve',
        result: compactResult(
          'ui_contract_mismatch', 'invocation', 'account_error_page_ownership_unproven',
          invocationId, profileKey, sendCount, pollCount, navigation, incidents,
          { ...(sendAttempted ? { send_attempted: true } : {}) }, journalWriteFailed,
        ),
      };
    };
    const checkAccountLoadError = async (): Promise<TurnRunOutcome | 'recovered' | null> => {
      if (browserOrPageDefinitelyLost(page, browser)) return null;
      let error: ProductWallDiagnostic | null = null;
      try { error = await probeAccountLoadError(page, 600); } catch { /* no positive heading evidence */ }
      if (!error) return null;
      observeProductWall(error);
      // URL changes are not owner evidence. A verified selected existing chat
      // retains reload (never close) authority only on the same held Page.
      if (page !== originalHeldPage || ownershipForfeited
        || (config.newChat ? !createdFreshPage : !originalExactChat)) {
        return accountErrorOwnershipMismatch();
      }
      let observedUrl = '';
      try { observedUrl = String(page.url()); } catch { /* no URL authority */ }
      if (config.newChat && config.projectUrl
        && conversationUuidFromUrl(observedUrl)
        && !projectConversationUrlMatchesProject(observedUrl, config.projectUrl)) {
        ownershipForfeited = true;
        return accountErrorOwnershipMismatch();
      }
      if (originalExactChat && conversationUuidFromUrl(observedUrl)
        && !ownedConversationIdentityMatches(observedUrl, originalExactChat)) {
        return accountErrorOwnershipMismatch();
      }
      if (config.newChat && ownedConversationUrl
        && !freshClaimOwnerFenceValid(profileKey, ownedConversationUrl, invocationId, config.timeoutMs)) {
        ownershipForfeited = true;
        return accountErrorOwnershipMismatch();
      }
      if (accountReloadAttempted) return accountErrorTerminal();
      // Reserve Page/CDP cleanup and terminal projection before liveness expiry.
      const returnByMs = config.newChat && (sendAttempted || sendCount > 0)
        && !ownedConversationUrl ? freshUnboundReturnByMs
        : invocationDeadlineMs - RESOURCE_CLEANUP_BOUND_MS - 2_000;
      const availableMs = returnByMs - Date.now();
      if (availableMs <= 1_000) return accountErrorTerminal();
      beforeBrowserAction(); // Shared cooldown and first witnessed 429 forbid a new reload.
      accountReloadAttempted = true; // Failure consumes the only allowance.
      held429Witness?.beforeNavigation();
      try {
        await boundedBrowserRead(
          page.reload({ waitUntil: 'domcontentloaded', timeout: Math.min(25_000, availableMs - 500) }),
          Math.min(25_000, availableMs - 500),
          'account_load_error_reload_timeout',
        );
      } catch {
        return accountErrorTerminal();
      }
      if (browserOrPageDefinitelyLost(page, browser)) return accountErrorTerminal();
      try {
        if (await probeAccountLoadError(page, 600)) return accountErrorTerminal();
      } catch { /* ordinary binding checks still apply */ }
      if (originalExactChat && !readOwnedConversationIdentity(page, originalExactChat).matched) {
        return accountErrorOwnershipMismatch();
      }
      if (config.newChat && sendAttempted) {
        let currentUrl = '';
        try { currentUrl = String(page.url()); } catch { /* fail closed below */ }
        const currentConversationId = conversationUuidFromUrl(currentUrl);
        if (currentConversationId
          && (!projectConversationUrlMatchesProject(currentUrl, config.projectUrl ?? '')
            || (ownedConversationUrl
              && !ownedConversationIdentityMatches(currentUrl, ownedConversationUrl)))) {
          ownershipForfeited = true;
          return accountErrorOwnershipMismatch();
        }
        if (ownedConversationUrl
          && !freshClaimOwnerFenceValid(profileKey, ownedConversationUrl, invocationId, config.timeoutMs)) {
          ownershipForfeited = true;
          return accountErrorOwnershipMismatch();
        }
      }
      if (config.newChat && !sendAttempted) {
        // A pre-dispatch reload grants no authority to send on an already
        // populated/foreign conversation; the composer is checked downstream.
        let currentUrl = '';
        try { currentUrl = String(page.url()); } catch { /* fail closed */ }
        if (!isBlankProjectSurfaceUrl(currentUrl, config.projectUrl ?? '')) {
          ownershipForfeited = true;
          return accountErrorOwnershipMismatch();
        }
        try {
          const census = await boundedBrowserRead(
            readRecoveryAuthoritativeUserMessages(page), MAX_LOCAL_READ_WAIT_MS,
            'account_error_pre_send_marker_check_timeout',
          );
          if (census.incomplete
            || recoveryMarkerCardinality(census.messages, marker).exactMarkerTokenCount !== 0) {
            return accountErrorOwnershipMismatch();
          }
        } catch { return accountErrorOwnershipMismatch(); }
      }
      return 'recovered';
    };

    const waitForComposerWithAccountRecovery = async (deadlineMs: number): Promise<
      TurnRunOutcome | { state: 'ready' } | { state: TurnState; cause: string }
    > => {
      let readiness = await waitForComposer(
        page, deadlineMs, true, observeProductWall, true,
        (state) => { preSendComposerState = state; },
        observeProductWall,
      );
      while (readiness.state === 'ui_contract_mismatch' && readiness.cause === 'account_load_error') {
        const recovery = await checkAccountLoadError();
        if (recovery && recovery !== 'recovered') return recovery;
        readiness = await waitForComposer(
          page, deadlineMs, true, observeProductWall, true,
          (state) => { preSendComposerState = state; },
          observeProductWall,
        );
      }
      return readiness;
    };

    const returnComposerMutationFailure = (
      cause: PreSendComposerFailureCause,
      diagnostic?: ComposerMutationDiagnosticV1,
    ): TurnRunOutcome => {
      incident('invocation_blocker', cause, 'return_local_error', diagnostic);
      preSendDiagnostic(cause);
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
        true, // Every pre-Send assistant is historical, including the final one.
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
    /** A positive disabled-before-click log for EVERY action is necessary but
     * not sufficient. Destroy only the original invocation-created exact draft
     * and close its tab while the incumbent POST witness is still attached.
     */
    const finalizeAffirmativeNoDispatch = async (): Promise<TurnRunOutcome | null> => {
      const stillOwned = (): boolean => {
        if (ownershipForfeited || page !== originalHeldPage
          || cleanupAuthorityUnprovenPages.has(page)
          || browserOrPageDefinitelyLost(page, browser)
          || getOwnTargetInfo(browser)?.created !== true
          || held429Witness?.ownSubmissionIssued() === true
          || held429Witness?.serverMarkerPresent() === true
          || held429Witness?.current()) return false;
        try {
          return config.newChat
            ? Boolean(config.projectUrl && isBlankProjectSurfaceUrl(String(page.url()), config.projectUrl))
            : Boolean(originalExactChat
              && readOwnedConversationIdentity(page, originalExactChat).matched);
        } catch { return false; }
      };
      const uncontradicted = async (): Promise<boolean> => {
        if (!stillOwned() || Date.now() + 2 * MAX_LOCAL_READ_WAIT_MS >= invocationDeadlineMs
          || await readFreshStopVisible(page, invocationDeadlineMs) !== false) return false;
        try {
          const observed = await readPageObservation(page, undefined, undefined, true, invocationDeadlineMs);
          const expected = baselineSnapshot?.carriers;
          if (!expected || observed.transcriptIncomplete || !observed.snapshot?.complete
            || observed.pageTurnEvidence?.generationInProgress !== false
            || observed.pageTurnEvidence?.continueGeneratingVisible === true
            || observed.snapshot.carriers.length !== expected.length) return false;
          for (let index = 0; index < expected.length; index++) {
            const baseline = expected[index]!;
            const now = observed.snapshot.carriers[index]!;
            if (!baseline.fingerprint || baseline.fingerprint !== now.fingerprint
              || baseline.role !== now.role || baseline.key !== now.key
              || now.text.includes(marker)) return false;
          }
          return stillOwned() && await readFreshStopVisible(page, invocationDeadlineMs) === false;
        } catch { return false; }
      };
      if (!await uncontradicted()
        || await readLosslessOwnedComposer(page.locator(COMPOSER_SELECTOR), invocationDeadlineMs) !== markedPayload
        || !await uncontradicted()) return null;
      if (!await conditionalClearOwnedComposerDraft(
        page, markedPayload, invocationDeadlineMs, String(page.url()),
      )) return null;
      if (!await uncontradicted()
        || await readLosslessOwnedComposer(page.locator(COMPOSER_SELECTOR), invocationDeadlineMs) !== ''
        // The blank read can itself await while Stop, transcript or a foreign
        // shared draft changes. Revalidate every guard after that await and
        // finish with another lossless blank check immediately before close.
        || !await uncontradicted()
        || await readLosslessOwnedComposer(page.locator(COMPOSER_SELECTOR), invocationDeadlineMs) !== ''
        || !stillOwned()) return null;
      const close = await abandonLatePageHandle(page, RESOURCE_CLEANUP_BOUND_MS);
      // Closing has to be positively observed; a timed-out close is not finalization.
      if (close !== 'confirmed' || typeof page.isClosed !== 'function' || page.isClosed() !== true
        || held429Witness?.ownSubmissionIssued() || held429Witness?.serverMarkerPresent()) return null;
      transitionStateLightTurnObservation({
        profileKey, invocationId, phase: 'not_sent',
        reason: 'affirmative_pre_actionability_no_dispatch',
        sendCount: 0, sendWitness: 'none',
      });
      incident('send_observation_affirmative', 'affirmative_pre_actionability_no_dispatch',
        'exact_owned_composer_cleared_and_created_tab_closed');
      return {
        page, browser, cleanupAction: 'skip',
        result: compactResult(
          'send_failed', 'invocation', 'affirmative_pre_actionability_no_dispatch',
          invocationId, profileKey, 0, pollCount, navigation, incidents,
          { send_attempted: true }, journalWriteFailed,
        ),
      };
    };

    const assertFreshOwner = (): void => {
      // Preserve a positively witnessed first wall before diagnosing a redirected fresh URL.
      beforeBrowserAction();
      if (Date.now() >= invocationDeadlineMs) {
        throw new Error('state_light_new_chat_owner_pre_dispatch_deadline_exhausted');
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
      if (Date.now() + additionalPreSendMs + FRESH_SEND_RESERVE_MS > invocationDeadlineMs) {
        throw new Error('state_light_new_chat_send_budget_unavailable');
      }
    };
    // Reserve bounded composer insertion time after the readiness wait.
    const composerReadinessDeadline = (): number => Math.max(
      Date.now(),
      invocationDeadlineMs - deriveComposerInsertionBudgetMs(markedPayload),
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


    // A committed same-chat reopen needs fresh DOM/owner proof, including at
    // the dispatch boundary. The incumbent generation watcher stays unchanged.
    let reopenedExistingComposer = false;
    const returnExistingBusy = (): TurnRunOutcome => {
      incident('invocation_blocker', 'another_turn_active', 'return_local_error');
      return {
        page, browser,
        result: compactResult(
          'conversation_busy', 'conversation', 'another_turn_active',
          invocationId, profileKey, sendCount, pollCount, navigation, incidents,
          { conversation_id: normalizeConversationUrl(config.chatUrl ?? '') },
          journalWriteFailed,
        ),
      };
    };
    const verifyReopenedExistingPage = async (): Promise<TurnRunOutcome | null> => {
      const target = normalizeConversationUrl(config.chatUrl ?? '');
      while (true) {
        if (browserOrPageDefinitelyLost(page, browser)) throw new Error('Target closed');
        const identity = readOwnedConversationIdentity(page, target);
        if (!identity.matched) return returnOwnedConversationIdentityMismatch(
          identity, page, browser, invocationId, profileKey, sendCount,
          pollCount, navigation, incidents, journalWriteFailed, incident, false,
        );
        // A slow transcript is not a wrong transcript. Observe the same owned
        // page until the existing invocation deadline, without granting Send
        // while its user history or generation state is still unproven.
        beforeBrowserAction();
        if (Date.now() >= invocationDeadlineMs) {
          return returnOwnedConversationRenderMismatch(
            page, browser, invocationId, profileKey, sendCount, pollCount,
            navigation, incidents, journalWriteFailed, incident,
          );
        }
        if (await readFreshStopVisible(page, invocationDeadlineMs) !== false) return returnExistingBusy();
        const observed = await readPageObservation(page, undefined, undefined, true, invocationDeadlineMs);
        beforeBrowserAction();
        if (observed.pageTurnEvidence?.generationInProgress === true
          || observed.pageTurnEvidence?.continueGeneratingVisible === true) return returnExistingBusy();
        if (!observed.transcriptIncomplete && observed.snapshot?.complete === true
          && observed.snapshot.carriers.some((carrier) =>
            carrier.role === 'user' && normalizeVisibleText(carrier.text).length > 0)
          && observed.pageTurnEvidence?.generationInProgress === false) {
          if (await readFreshStopVisible(page, invocationDeadlineMs) !== false) return returnExistingBusy();
          if (browserOrPageDefinitelyLost(page, browser)) throw new Error('Target closed');
          const finalIdentity = readOwnedConversationIdentity(page, target);
          return finalIdentity.matched ? null : returnOwnedConversationIdentityMismatch(
            finalIdentity, page, browser, invocationId, profileKey, sendCount,
            pollCount, navigation, incidents, journalWriteFailed, incident, false,
          );
        }
        const remainingMs = invocationDeadlineMs - Date.now();
        if (remainingMs > 0) await sleep(page, Math.min(INITIAL_POLL_MS, remainingMs));
      }
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
      beforeBrowserAction();
      const mutationFailure = await mutateComposerOrCause(page, markedPayload, invocationDeadlineMs, insertionContext, beforeBrowserAction);
      assertFreshOwner();
      if (mutationFailure) {
        if (held429Witness?.current()) beforeBrowserAction();
        return returnComposerMutationFailure(mutationFailure, insertionContext.diagnostic);
      }
      requireFreshSendReserve(FRESH_SEND_PREPARE_RESERVE_MS);
      if (!await readComposerReadiness(page, invocationDeadlineMs)) {
        return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      }
      const composer = page.locator(COMPOSER_SELECTOR);
      if (!await composerPayloadMatchesBeforeSend(composer, markedPayload, invocationDeadlineMs)) {
        return returnComposerMutationFailure(composerPayloadFailureCause(invocationDeadlineMs));
      }
      const sendButton = page.locator(SEND_BUTTON_SELECTOR);
      // A pre-existing recovery alert is not evidence from this Send. Read
      // the incumbent unmarked-alert surface before markPreSendAlerts tags old
      // alerts; an unreadable baseline cannot authorize an early diagnostic.
      // Do not consume the separate Failed-to-fetch locator's post-Send read.
      try {
        const alertDeadline = Math.min(invocationDeadlineMs, Date.now() + MAX_LOCAL_READ_WAIT_MS);
        freshPreSendFetchAlertAbsent =
          await locatorCount(page.locator(UNMARKED_ALERT_SELECTOR), alertDeadline) === 0
          && await locatorCount(page.getByRole('button', { name: 'Retry', exact: true }), alertDeadline) === 0;
      } catch { freshPreSendFetchAlertAbsent = false; }
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
      let preDispatchCutoffMs = readinessDeadlineMs;
      let readiness = await waitForFreshSendButton(page, sendButton, assertFreshOwner, readinessStartedAtMs);
      assertFreshOwner();
      let extendedEntryCount = 0;
      let extendedRecorded = false;
      const recordExtended = (
        outcome: ExtendedReadinessOutcome, terminalNonresponsiveCount?: number,
      ): void => {
        if (!extendedEntryCount || extendedRecorded) return;
        extendedRecorded = true;
        const diagnostic: ExtendedReadinessDiagnostic = {
          entryNonresponsiveCount: extendedEntryCount,
          ...(terminalNonresponsiveCount !== undefined ? { terminalNonresponsiveCount } : {}),
          elapsedMs: Math.max(0, Date.now() - readinessStartedAtMs),
          outcome,
        };
        if (!recordIncident(incidents, {
          eventClass: 'fresh_send_extended_readiness',
          symptom: outcome,
          action: outcome === 'enabled' ? 'dispatch_owned_send' : 'cleanup_own_unsent_payload',
          extendedReadiness: diagnostic,
        }, invocationId, navigation.snapshot())) journalWriteFailed = true;
      };
      const failExtended = (
        cause: string, outcome: ExtendedReadinessOutcome, terminalNonresponsiveCount?: number,
      ): TurnRunOutcome => {
        recordExtended(outcome, terminalNonresponsiveCount);
        return {
          page, browser,
          result: compactResult(
            'send_failed', 'invocation', cause,
            invocationId, profileKey, 0, pollCount, navigation, incidents, {}, journalWriteFailed,
          ),
        };
      };
      if (readiness === 'never_enabled') {
        // A disabled own Send is not evidence about another renderer. Only a
        // direct-target post-timeout *control-surviving* witness may extend.
        const ownTargetId = getOwnTargetInfo(browser)?.targetId;
        const entry = ownTargetId
          ? await probeCdpSiblingEvaluations(config.cdp, ownTargetId) : undefined;
        assertFreshOwner();
        if (entry?.nonresponsive.length && ownTargetId) {
          const originals = entry.nonresponsive;
          extendedEntryCount = originals.length;
          const readinessReturnByMs = Math.min(
            readinessStartedAtMs + FRESH_SEND_EXTENDED_TOTAL_MS,
            freshUnboundReturnByMs - DISPATCH_OBSERVATION_MS - 4 * MAX_LOCAL_READ_WAIT_MS,
          );
          preDispatchCutoffMs = readinessReturnByMs - FRESH_SEND_TERMINAL_PROBE_MS;
          if (Date.now() >= preDispatchCutoffMs) {
            return failExtended('fresh_send_readiness_budget_exhausted', 'budget_exhausted');
          }
          // Assert the original marker before extending, not just before Send.
          if (!await composerPayloadMatchesBeforeSend(
            composer, markedPayload, Math.min(invocationDeadlineMs, preDispatchCutoffMs),
          )) {
            if (Date.now() >= preDispatchCutoffMs) {
              return failExtended('fresh_send_readiness_budget_exhausted', 'budget_exhausted');
            }
            recordExtended('terminal_unknown');
            return returnComposerMutationFailure(composerPayloadFailureCause(preDispatchCutoffMs));
          }
          readiness = await waitForExtendedFreshSendButton(
            page, sendButton, assertFreshOwner, preDispatchCutoffMs,
          );
          assertFreshOwner();
          if (readiness === 'never_enabled' || Date.now() >= preDispatchCutoffMs) {
            if (readinessReturnByMs <= Date.now()) {
              return failExtended('fresh_send_readiness_budget_exhausted', 'budget_exhausted');
            }
            // Single fresh bounded re-probe of original positive ID/URL pairs.
            // No new candidates, implicit recovery, retry or sibling mutation.
            const terminal = await probeCdpSiblingEvaluations(
              config.cdp, ownTargetId, originals,
              Math.min(FRESH_SEND_TERMINAL_PROBE_MS, readinessReturnByMs - Date.now()),
            );
            if (Date.now() > readinessReturnByMs) {
              return failExtended('fresh_send_readiness_budget_exhausted', 'budget_exhausted');
            }
            if (terminal.nonresponsive.length) {
              return failExtended(
                'fresh_send_blocked_by_frozen_sibling', 'still_frozen', terminal.nonresponsive.length,
              );
            }
            if (terminal.responsive.length === originals.length) {
              return failExtended('fresh_send_button_never_enabled', 'recovered_but_disabled');
            }
            if (terminal.disappearedOrChanged.length) {
              return failExtended('fresh_send_button_never_enabled', 'target_disappeared_or_changed');
            }
            return failExtended('fresh_send_button_never_enabled', 'terminal_unknown');
          }
        }
      }
      if (readiness === 'busy') {
        recordExtended('terminal_unknown');
        incident('invocation_blocker', 'fresh_send_actionability_unknown_or_busy', 'retain_page');
        return {
          page, browser, cleanupAction: 'preserve',
          result: compactResult(
            'ui_contract_mismatch', 'invocation', 'fresh_send_actionability_unknown_or_busy',
            invocationId, profileKey, sendCount, pollCount, navigation, incidents, {}, journalWriteFailed,
          ),
        };
      }
      if (readiness === 'never_enabled' || Date.now() >= preDispatchCutoffMs) {
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
        beforeBrowserAction();
        assertFreshOwner();
        if (Date.now() >= invocationDeadlineMs) throw new Error('state_light_new_chat_send_budget_unavailable');
        if (Date.now() >= preDispatchCutoffMs) throw new Error('fresh_send_readiness_deadline_exhausted');
        transitionStateLightTurnObservation({
          profileKey, invocationId, phase: 'dispatching', reason: 'dispatch_boundary_entered',
        });
        sendAttempted = true;
        afterSend = true; // Dispatch was attempted even without positive delivery proof.
        held429Witness?.markDispatch(marker, markedPayload);
        if (freshCleanup) freshCleanup.sendAttempted = true;
        recordExtended('enabled');
      };
      // The composer can change during Send readiness polling. Do not send a
      // different draft as though it were the invocation's marked payload.
      const finalPayloadMatches = await composerPayloadMatchesBeforeSend(
        composer, markedPayload, Math.min(invocationDeadlineMs, preDispatchCutoffMs),
      );
      // A qualified extended wait may expire during its last awaited marker
      // read. No dispatch callback or physical click has run yet.
      if (extendedEntryCount && Date.now() >= preDispatchCutoffMs) {
        return failExtended('fresh_send_readiness_budget_exhausted', 'budget_exhausted');
      }
      if (!finalPayloadMatches) {
        return returnComposerMutationFailure(composerPayloadFailureCause(
          Math.min(invocationDeadlineMs, preDispatchCutoffMs),
        ));
      }
      assertFreshOwner();
      const sendAction = async () => await dispatchStateLightSendAndObserveDelivery({
        page, browser, composer, sendButton, hasSendButton: true, marker,
        baselineUserNodeCount, sendWaitMs: Math.max(1, Math.min(MAX_LOCAL_READ_WAIT_MS, preDispatchCutoffMs - Date.now())),
        invocationDeadlineMs, preSendAlertsAlreadyMarked: true, allowOwnedStopWitness: true,
        onDispatch: beforeClick,
        ownSubmissionIssued: () => held429Witness?.ownSubmissionIssued() === true,
        onActionError: (diagnostic) => incident('send_transport_error', diagnostic, 'observe_delivery_no_blind_resend'),
      });
      let delivery: Awaited<ReturnType<typeof dispatchStateLightSendAndObserveDelivery>>;
      try {
        delivery = await sendAction();
      } catch (error) {
        // onDispatch rejects this deadline before Playwright can click. Only
        // that exact zero-dispatch rejection is an extended budget terminal.
        if (extendedEntryCount && !sendAttempted && Date.now() >= preDispatchCutoffMs
          && error instanceof Error && error.message === 'fresh_send_readiness_deadline_exhausted') {
          return failExtended('fresh_send_readiness_budget_exhausted', 'budget_exhausted');
        }
        throw error;
      }
      const firstActionAffirmative = delivery.preDispatchTimeoutProven === true && delivery.sendCount === 0;
      let freshRepeated = false;
      if (delivery.sendCount === 0
        && delivery.witness === 'unproven'
        && delivery.preDispatchTimeoutProven === true
        && Date.now() < preDispatchCutoffMs
        && await freshRetryDomGuards({
          page, browser, composer, markerPayload: markedPayload, baselineUserNodeCount,
          deadlineMs: Math.min(invocationDeadlineMs, preDispatchCutoffMs, Date.now() + MAX_LOCAL_READ_WAIT_MS * 2),
        })) {
        // Positive Playwright actionability proof and all independent current
        // DOM/owner checks are required; no third attempt after this second call.
        if (await composerPayloadMatchesBeforeSend(
          composer, markedPayload, Math.min(invocationDeadlineMs, preDispatchCutoffMs),
        )) {
          assertFreshOwner();
          if (Date.now() < preDispatchCutoffMs) {
            freshRepeated = true;
            delivery = await sendAction();
          }
        }
      }
      if (delivery.sendCount === 0 && delivery.preDispatchTimeoutProven === true
        && (!freshRepeated || firstActionAffirmative)
        && !held429Witness?.ownSubmissionIssued()) {
        const affirmed = await finalizeAffirmativeNoDispatch();
        if (affirmed) return affirmed;
      }
      if (delivery.sendCount === 0) {
        if (browserOrPageDefinitelyLost(page, browser)) {
          deliveryProofPendingRecovery = true;
          return null;
        }
        if (sendAttempted) {
          const recovery = await checkAccountLoadError();
          if (recovery && recovery !== 'recovered') return recovery;
          if (recovery === 'recovered') {
            zeroWitnessAccountRecovery = true;
            afterSend = true;
            return null;
          }
        }
        // The five-second DOM/composer probe is not negative Send evidence.
        // Continue observing the same Page and original invocation; never resend.
        incident('send_observation_deferred', 'send_delivery_unproven', 'continue_observing_after_send');
        setHeartbeatPhase('post_send_observation');
        return null;
      }
      sendCount += delivery.sendCount;
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
      // Initial and reopened continuations share the incumbent complete-history guard.
      const preInsertHistoryFailure = await verifyReopenedExistingPage();
      if (preInsertHistoryFailure) return preInsertHistoryFailure;
      beforeBrowserAction();
      const insertionContext: { insertionDeadlineMs?: number; diagnostic?: ComposerMutationDiagnosticV1 } = {};
      const mutationFailure = await mutateComposerOrCause(
        page,
        markedPayload,
        invocationDeadlineMs,
        insertionContext,
        beforeBrowserAction,
      );
      if (mutationFailure) {
        if (held429Witness?.current()) beforeBrowserAction();
        return returnComposerMutationFailure(mutationFailure, insertionContext.diagnostic);
      }
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
        invocationDeadlineMs, false, true,
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
      {
        const beforeDispatchFailure = await verifyReopenedExistingPage();
        if (beforeDispatchFailure) return beforeDispatchFailure;
        sendWaitMs = remainingComposerMutationMs(insertionDeadlineMs, invocationDeadlineMs);
        if (sendWaitMs <= 0) return returnComposerMutationFailure('composer_mutation_budget_exhausted');
        if (!await composerPayloadMatchesBeforeSend(
          composer, markedPayload, invocationDeadlineMs,
        )) {
          return returnComposerMutationFailure(composerPayloadFailureCause(invocationDeadlineMs));
        }
        sendWaitMs = invocationDeadlineMs - Date.now();
        if (sendWaitMs <= 0) return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      }
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
      let recoveryReclickArmed = false;
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
            beforeBrowserAction();
            // An own POST or completed server-marker witness may arrive after
            // the last DOM guard. Neither retry path may cross into a second
            // physical click once a positive for this invocation is known.
            if (sendAttempted && (held429Witness?.ownSubmissionIssued()
              || held429Witness?.serverMarkerPresent() === true)) {
              throw new Error('server_checked_reclick_guard_lost');
            }
            if (recoveryReclickArmed && (
              held429Witness?.ownSubmissionIssued()
              || held429Witness?.serverMarkerPresent() === true
              || !originalExactChat
              || page !== originalHeldPage
              || getOwnTargetInfo(browser)?.created !== true
              || cleanupAuthorityUnprovenPages.has(page)
              || browserOrPageDefinitelyLost(page, browser)
              || !readOwnedConversationIdentity(page, originalExactChat).matched
            )) throw new Error('server_checked_reclick_guard_lost');
            transitionStateLightTurnObservation({
              profileKey, invocationId, phase: 'dispatching', reason: 'dispatch_boundary_entered',
            });
            sendAttempted = true;
            afterSend = true; // Post-onDispatch exceptions must not become pre-Send failures.
            held429Witness?.markDispatch(marker, markedPayload);
          },
          ownSubmissionIssued: () => held429Witness?.ownSubmissionIssued() === true,
          onActionError: (diagnostic) => incident('send_transport_error', diagnostic, 'observe_delivery_no_resend'),
        });
      let delivery = await dispatchExisting(sendWaitMs);
      const firstActionAffirmative = delivery.sendCount === 0 && delivery.preDispatchTimeoutProven === true;
      let repeated = false;
      if (hasSendButton && delivery.sendCount === 0 && delivery.witness === 'unproven'
        && delivery.preDispatchTimeoutProven === true
        && await existingRetryDomGuards({
          page, browser, composer, targetChatUrl: normalizeConversationUrl(config.chatUrl ?? ''),
          markedPayload, marker, baselineSnapshot, deadlineMs: invocationDeadlineMs,
        })) {
        // Only the first click's actual positive non-dispatch action result grants
        // this one optional repeat; an uncertain first action or Enter never does.
        if (await composerPayloadMatchesBeforeSend(composer, markedPayload, invocationDeadlineMs)
          && originalExactChat && !browserOrPageDefinitelyLost(page, browser)
          && normalizeConversationUrl(String(page.url())) === originalExactChat
          && readOwnedConversationIdentity(page, originalExactChat).matched) {
          const repeatWaitMs = Math.min(MAX_LOCAL_READ_WAIT_MS, invocationDeadlineMs - Date.now());
          if (repeatWaitMs > 0) {
            repeated = true;
            delivery = await dispatchExisting(repeatWaitMs);
          }
        }
      }
      if (!repeated && hasSendButton && delivery.sendCount === 0
        && delivery.witness === 'unproven' && originalExactChat
        && page === originalHeldPage && getOwnTargetInfo(browser)?.created === true
        && !cleanupAuthorityUnprovenPages.has(page)) {
        const state = await observeExistingServerCheckedRecovery({
          page, browser, composer, targetChatUrl: originalExactChat,
          markedPayload, marker, baselineSnapshot,
          heldWitness: held429Witness, deadlineMs: invocationDeadlineMs,
        });
        if (state === 'server_marker_present') {
          delivery = { ...delivery, sendCount: 1, witness: 'owned_server_user_marker' };
        } else if (state === 'marker_absent_complete' && !held429Witness?.ownSubmissionIssued()
          && await readLosslessOwnedComposer(composer, invocationDeadlineMs) === markedPayload
          && await existingRetryDomGuards({
            page, browser, composer, targetChatUrl: originalExactChat,
            markedPayload, marker, baselineSnapshot, deadlineMs: invocationDeadlineMs,
          })
          // The guard above contains awaits. Recheck exact text after it so
          // a concurrent whitespace-only edit cannot authorize a re-click.
          && await readFreshStopVisible(page, invocationDeadlineMs) === false
          && await readLosslessOwnedComposer(composer, invocationDeadlineMs) === markedPayload
          && page === originalHeldPage && getOwnTargetInfo(browser)?.created === true
          && !cleanupAuthorityUnprovenPages.has(page)
          && !held429Witness?.ownSubmissionIssued()
          && !held429Witness?.serverMarkerPresent()
          && readOwnedConversationIdentity(page, originalExactChat).matched) {
          // A complete server-negative snapshot only permits the one guarded
          // physical re-click. It never certifies that the original did not Send.
          repeated = true;
          const remaining = Math.min(MAX_LOCAL_READ_WAIT_MS, invocationDeadlineMs - Date.now());
          if (remaining > 0) {
            recoveryReclickArmed = true;
            delivery = await dispatchExisting(remaining);
          }
        }
      }
      if (delivery.sendCount === 0 && delivery.preDispatchTimeoutProven === true
        && !held429Witness?.ownSubmissionIssued()
        && (!repeated || firstActionAffirmative)) {
        const affirmative = await finalizeAffirmativeNoDispatch();
        if (affirmative) return affirmative;
      }
      if (delivery.sendCount === 0) {
        if (browserOrPageDefinitelyLost(page, browser)) {
          deliveryProofPendingRecovery = true;
          if (!config.newChat) ownedConversationUrl = pageConversationUrl(page) ?? ownedConversationUrl;
          return null;
        }
        if (sendAttempted) {
          const recovery = await checkAccountLoadError();
          if (recovery && recovery !== 'recovered') return recovery;
          if (recovery === 'recovered') {
            zeroWitnessAccountRecovery = true;
            afterSend = true;
            return null;
          }
        }
        // No immediate positive witness is not permission to re-send or
        // terminalize an already attempted click/Enter.
        incident('send_observation_deferred', 'send_delivery_unproven', 'continue_observing_after_send');
        setHeartbeatPhase('post_send_observation');
        return null;
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
      {
        const entryAccountError = await checkAccountLoadError();
        if (entryAccountError && entryAccountError !== 'recovered') return entryAccountError;
        assertFreshOwner();
        const returnFreshPrepareFailure = (
          prepared: Awaited<ReturnType<typeof prepareStateLightFreshConversation>>,
        ): TurnRunOutcome | null => {
          if (prepared.state === 'ready') return null;
          // A swallowed internal navigation refusal must retain its named first-wall/cooldown cause.
          beforeBrowserAction();
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

        let initialPrepare = await prepareStateLightFreshConversation(
          page,
          config,
          profileKey,
          invocationId,
          guardedFreshPreparationNavigation,
          invocationDeadlineMs,
          Date.now,
          observeProductWall,
          2,
        );
        if (initialPrepare.state === 'recovery_required') {
          const recovery = await checkAccountLoadError();
          if (recovery && recovery !== 'recovered') return recovery;
          if (recovery === 'recovered') initialPrepare = await prepareStateLightFreshConversation(
            page, config, profileKey, invocationId, guardedFreshPreparationNavigation, invocationDeadlineMs,
            Date.now, observeProductWall, 2,
          );
          if (initialPrepare.state === 'recovery_required') return accountErrorTerminal();
        }
        const duringPrepareError = await checkAccountLoadError();
        if (duringPrepareError && duringPrepareError !== 'recovered') return duringPrepareError;
        assertFreshOwner();
        const initialPrepareFailure = returnFreshPrepareFailure(initialPrepare);
        if (initialPrepareFailure) return initialPrepareFailure;

        const initialComposer = await waitForComposerWithAccountRecovery(
          navigation.snapshotGoto() < 2
            ? Math.min(composerReadinessDeadline(), Date.now() + COMPOSER_READINESS_WAIT_MS)
            : composerReadinessDeadline(),
        );
        if ('result' in initialComposer) return initialComposer;
        let composerState = initialComposer;
        if (composerState.state !== 'ready' && composerState.cause === 'composer_unavailable'
          && createdFreshPage && navigation.snapshotGoto() < 2
          && !browserOrPageDefinitelyLost(page, browser)
          && Date.now() + COMPOSER_READINESS_WAIT_MS + FRESH_SEND_RESERVE_MS
            + deriveComposerInsertionBudgetMs(markedPayload) < invocationDeadlineMs) {
          // Reopen this invocation's blank Page once; the same navigation
          // counter also limits retries inside fresh preparation.
          const beforeReopen = await checkAccountLoadError();
          if (beforeReopen && beforeReopen !== 'recovered') return beforeReopen;
          if (beforeReopen !== 'recovered') {
            await navigateOwnedTurnPage(page, config, navigation, invocationDeadlineMs, () => { beforeBrowserAction(); held429Witness?.beforeNavigation(); });
          }
          const reopened = await prepareStateLightFreshConversation(
            page, config, profileKey, invocationId, guardedFreshPreparationNavigation, invocationDeadlineMs,
            Date.now, observeProductWall, 2,
          );
          const prepareFailure = returnFreshPrepareFailure(reopened);
          if (prepareFailure) return prepareFailure;
          const afterReopen = await waitForComposerWithAccountRecovery(composerReadinessDeadline());
          if ('result' in afterReopen) return afterReopen;
          composerState = afterReopen;
        }
        assertFreshOwner();
        const initialComposerFailure = returnComposerBlocker(composerState);
        if (initialComposerFailure) return initialComposerFailure;

        let claimed = false;
        let sendAuthorized = true;
        let lastAttemptConversationUrl: string | undefined;
        for (let recovery = 0; recovery < STATE_LIGHT_FRESH_RECOVERY_ATTEMPTS && !claimed; recovery++) {
          if (recovery > 0) beforeBrowserAction();
          // A dispatched action with unknown delivery is never a pre-Send
          // collision license for another fresh Send.
          if (recovery > 0 && sendAttempted) {
            claimed = true;
            break;
          }
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
            const beforeReprepare = await checkAccountLoadError();
            if (beforeReprepare && beforeReprepare !== 'recovered') return beforeReprepare;
            const prepared = await prepareStateLightFreshConversation(
              page,
              config,
              profileKey,
              invocationId,
              guardedFreshPreparationNavigation,
              invocationDeadlineMs,
              Date.now,
              observeProductWall,
              2,
            );
            if (prepared.state === 'recovery_required') {
              const accountFailure = await checkAccountLoadError();
              if (accountFailure && accountFailure !== 'recovered') return accountFailure;
              return accountErrorTerminal();
            }
            assertFreshOwner();
            const preparedFailure = returnFreshPrepareFailure(prepared);
            if (preparedFailure) return preparedFailure;
            const recoveredComposer = await waitForComposerWithAccountRecovery(composerReadinessDeadline());
            if ('result' in recoveredComposer) return recoveredComposer;
            composerState = recoveredComposer;
            assertFreshOwner();
            const composerFailure = returnComposerBlocker(composerState);
            if (composerFailure) return composerFailure;
            sendAuthorized = true;
          }

          if (sendAuthorized) {
            const baselineFailure = await captureBaseline();
            assertFreshOwner();
            if (baselineFailure) return baselineFailure;
            const sendFailure = await sendOwnedPrompt();
            if (sendFailure) return sendFailure;
            sendAuthorized = false;
            if (zeroWitnessAccountRecovery) {
              claimed = true;
              break; // send_attempted=true: never re-enter the fresh Send loop.
            }
          }

          if (sendAttempted && Date.now() >= freshUnboundReturnByMs) {
            incident('send_observation_deferred', 'fresh_conversation_url_wait_budget_exhausted', 'continue_observing_after_send');
            claimed = true;
            break;
          }
          const urlDeadline = Math.min(
            Date.now() + Math.min(30_000, config.timeoutMs),
            freshUnboundReturnByMs,
          );
          let conversationUrl: string | undefined;
          const beforeUrlWait = await checkAccountLoadError();
          if (beforeUrlWait && beforeUrlWait !== 'recovered') return beforeUrlWait;
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
          const afterUrlWait = await checkAccountLoadError();
          if (afterUrlWait && afterUrlWait !== 'recovered') return afterUrlWait;
          if (!conversationUrl && afterUrlWait === 'recovered') {
            claimed = true;
            break; // observe the original possibly delivered Send; do not retry.
          }
          if (!conversationUrl) {
            if (sendAttempted && Date.now() >= freshUnboundReturnByMs) {
              incident('send_observation_deferred', 'fresh_conversation_url_wait_budget_exhausted', 'continue_observing_after_send');
              claimed = true;
              break;
            }
            if (sendCount >= 1) {
              // A counted invocation-owned Send can leave the composer unchanged.
              // Its absent early URL is uncertainty, not proof of non-landing.
              incident(
                'send_observation_deferred',
                'fresh_conversation_url_not_observed',
                'continue_observing_after_send',
              );
              lastAttemptConversationUrl = pageConversationUrl(page) ?? lastAttemptConversationUrl;
              claimed = true;
              break;
            }
            if (sendAttempted) {
              incident('send_observation_deferred', 'fresh_conversation_url_not_observed', 'continue_observing_after_send');
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
          if (!(await freshProjectMarkerProven(page, conversationUrl, freshUnboundReturnByMs))) {
            incident('send_observation_deferred', 'fresh_conversation_marker_unproven', 'continue_observing_after_send');
            claimed = true;
            break;
          }
          if (sendAttempted && sendCount === 0 && Date.now() >= freshUnboundReturnByMs) {
            claimed = true;
            break; // A late census cannot extend this invocation's owner budget.
          }
          if (sendAttempted && sendCount === 0) {
            sendCount = 1;
            markerDerivedSend = true;
            zeroWitnessAccountRecovery = false;
            transitionStateLightTurnObservation({
              profileKey, invocationId, phase: 'sent_unbound',
              reason: 'fresh_owned_marker_observed', sendCount, sendWitness: 'owned_marker',
            });
          }
          // The bounded marker read may cross the unbound cutoff. A URL that
          // existed earlier cannot retrospectively authorize this first claim.
          if (Date.now() >= freshUnboundReturnByMs) {
            claimed = true;
            break;
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
                sendWitness: markerDerivedSend ? 'owned_marker' : 'numeric_send_count',
                conversationUrl,
              });
            }
            claimed = true;
            ownedConversationUrl = conversationUrl;
            // The fresh Send positively owns this /c/<id> on the original Page too.
            // Keep an earlier account-list first wall instead of replacing it.
            if (!held429Witness?.current()) attachHeld429(page, conversationUrl);
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
      const beforeExistingIdentity = await checkAccountLoadError();
      if (beforeExistingIdentity && beforeExistingIdentity !== 'recovered') return beforeExistingIdentity;
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

      // Preserve late hydration without freezing reopen eligibility before it.
      // A short-budget turn keeps its original full readiness window unless
      // there is time to reserve a full watch or an actually finished turn.
      const insertionBudgetMs = deriveComposerInsertionBudgetMs(markedPayload);
      const postReopenReserveMs = EXISTING_GENERATION_RESUME_WINDOW_MS
        + insertionBudgetMs + MAX_LOCAL_READ_WAIT_MS;
      const remainingBeforeHydrationMs = invocationDeadlineMs - Date.now();
      const fullWatchHydrationRoom = remainingBeforeHydrationMs
        > postReopenReserveMs + 20_000;
      const canBoundInitialHydration = fullWatchHydrationRoom
        || (remainingBeforeHydrationMs > 20_000 + insertionBudgetMs + MAX_LOCAL_READ_WAIT_MS
          && await existingTurnHasNothingToResume(page, invocationDeadlineMs)
          && Date.now() + 20_000 + insertionBudgetMs + MAX_LOCAL_READ_WAIT_MS < invocationDeadlineMs);
      const initialHydrationWaitMs = Math.min(
        EXISTING_GENERATION_RESUME_WINDOW_MS,
        Math.max(20_000, remainingBeforeHydrationMs - postReopenReserveMs - INITIAL_POLL_MS),
      );
      const initialComposerDeadline = canBoundInitialHydration
        ? Math.min(composerReadinessDeadline(), Date.now() + initialHydrationWaitMs)
        : composerReadinessDeadline();
      const initialComposer = await waitForComposerWithAccountRecovery(initialComposerDeadline);
      if ('result' in initialComposer) return initialComposer;
      let composerState = initialComposer;
      // A present-tense idle snapshot cannot waive the incumbent 30s watcher.
      // Only the existing observed finished-action/alert branch may do so.
      const nothingToResumeBeforeReopen = composerState.state !== 'ready'
        && composerState.cause === 'composer_unavailable'
        && !browserOrPageDefinitelyLost(page, browser)
        && readOwnedConversationIdentity(page, chatUrlTarget).matched
        && await existingTurnHasNothingToResume(page, invocationDeadlineMs);
      const reopenReserveMs = insertionBudgetMs + MAX_LOCAL_READ_WAIT_MS
        + (nothingToResumeBeforeReopen ? 0 : EXISTING_GENERATION_RESUME_WINDOW_MS);
      if (composerState.state !== 'ready' && composerState.cause === 'composer_unavailable'
        && sendCount === 0 && !sendAttempted
        && !browserOrPageDefinitelyLost(page, browser)
        && readOwnedConversationIdentity(page, chatUrlTarget).matched
        && Date.now() + reopenReserveMs < invocationDeadlineMs) {
        const stop = await readFreshStopVisible(page, invocationDeadlineMs);
        const observation = await readPageObservation(page, undefined, undefined, true, invocationDeadlineMs);
        if (stop === false && !observation.transcriptIncomplete
          && observation.snapshot?.complete === true
          && observation.pageTurnEvidence?.generationInProgress === false
          && observation.pageTurnEvidence?.continueGeneratingVisible !== true
          && observation.snapshot.carriers.some((carrier) =>
            carrier.role === 'user' && normalizeVisibleText(carrier.text).length > 0)
          && !browserOrPageDefinitelyLost(page, browser)
          && readOwnedConversationIdentity(page, chatUrlTarget).matched
          && Date.now() + reopenReserveMs < invocationDeadlineMs) {
          const reopenDeadlineMs = invocationDeadlineMs
            - (nothingToResumeBeforeReopen ? 0 : EXISTING_GENERATION_RESUME_WINDOW_MS)
            - insertionBudgetMs;
          try {
            await navigateOwnedTurnPage(page, config, navigation, reopenDeadlineMs, () => { beforeBrowserAction(); held429Witness?.beforeNavigation(); });
          } catch (error) {
            if (browserOrPageDefinitelyLost(page, browser)) throw new Error('Target closed');
            const identity = readOwnedConversationIdentity(page, chatUrlTarget);
            if (!identity.matched) return returnOwnedConversationIdentityMismatch(
              identity, page, browser, invocationId, profileKey, sendCount,
              pollCount, navigation, incidents, journalWriteFailed, incident, false,
            );
            // Preserve the witnessed transport/timeout/operation cause.
            throw error;
          }
          if (browserOrPageDefinitelyLost(page, browser)) throw new Error('Target closed');
          const identity = readOwnedConversationIdentity(page, chatUrlTarget);
          if (!identity.matched) return returnOwnedConversationIdentityMismatch(
            identity, page, browser, invocationId, profileKey, sendCount,
            pollCount, navigation, incidents, journalWriteFailed, incident, false,
          );
          reopenedExistingComposer = true;
          // A composer reading from the old Page is not post-navigation evidence.
          preSendComposerState = 'not_probed';
          const reopenedComposer = await waitForComposerWithAccountRecovery(Math.min(
            composerReadinessDeadline(),
            reopenDeadlineMs,
          ));
          if ('result' in reopenedComposer) return reopenedComposer;
          composerState = reopenedComposer;
        }
      }
      if (composerState.state !== 'ready' && Date.now() >= invocationDeadlineMs) {
        return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      }
      if (reopenedExistingComposer && composerState.state !== 'ready'
        && composerState.cause === 'composer_unavailable') {
        if (browserOrPageDefinitelyLost(page, browser)) throw new Error('Target closed');
        const identity = readOwnedConversationIdentity(page, chatUrlTarget);
        if (!identity.matched) return returnOwnedConversationIdentityMismatch(
          identity, page, browser, invocationId, profileKey, sendCount,
          pollCount, navigation, incidents, journalWriteFailed, incident, false,
        );
        if (Date.now() >= invocationDeadlineMs
          || !['absent', 'hidden', 'disabled', 'not_editable'].includes(preSendComposerState)) {
          // Exhausted renewed readiness without an affirmative post-goto
          // unavailable observation is a budget failure, not a missing editor.
          return returnComposerMutationFailure('composer_mutation_budget_exhausted');
        }
        return returnComposerMutationFailure('composer_unavailable');
      }
      // Preserve the pre-existing mutation fallback for initial readiness probes.
      // A very short timeout can make their reserved readiness window zero,
      // even though a physical composer remains actionable (#2495/#2538).
      if (composerState.state !== 'ready' && composerState.cause !== 'composer_unavailable') {
        incident('invocation_blocker', composerState.cause, 'return_local_error');
        return {
          page, browser,
          ...ownedPreSendFetch429CleanupFields(composerState.state, composerState.cause),
          result: compactResult(
            composerState.state, 'invocation', composerState.cause, invocationId,
            profileKey, sendCount, pollCount, navigation, incidents, {}, journalWriteFailed,
          ),
        };
      }
      if (reopenedExistingComposer) {
        const postReopenFailure = await verifyReopenedExistingPage();
        if (postReopenFailure) return postReopenFailure;
      }
      const baselineFailure = await captureBaseline();
      if (baselineFailure) return baselineFailure;
      // An idle return from a deadline-clamped watch is not safe settlement.
      const nothingToResume = reopenedExistingComposer
        && await existingTurnHasNothingToResume(page, invocationDeadlineMs);
      if (reopenedExistingComposer && !nothingToResume
        && Date.now() + EXISTING_GENERATION_RESUME_WINDOW_MS + insertionBudgetMs >= invocationDeadlineMs) {
        return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      }
      const generationWatchStartedAt = Date.now();
      const existingGeneration = await waitForExistingGeneration(page, invocationDeadlineMs);
      if (existingGeneration === 'settled') {
        const settledBaselineFailure = await captureBaseline();
        if (settledBaselineFailure) return settledBaselineFailure;
      }
      if (existingGeneration === 'busy') return returnExistingBusy();
      if (reopenedExistingComposer && existingGeneration === 'idle' && !nothingToResume
        && Date.now() - generationWatchStartedAt < EXISTING_GENERATION_RESUME_WINDOW_MS) {
        return returnComposerMutationFailure('composer_mutation_budget_exhausted');
      }
      if (reopenedExistingComposer) {
        const afterWatchFailure = await verifyReopenedExistingPage();
        if (afterWatchFailure) return afterWatchFailure;
        if (Date.now() + insertionBudgetMs >= invocationDeadlineMs) {
          return returnComposerMutationFailure('composer_mutation_budget_exhausted');
        }
      }
      const sendFailure = await sendOwnedPrompt();
      if (sendFailure) return sendFailure;
    }

    const targetChatUrl = config.newChat
      ? undefined
      : normalizeConversationUrl(config.chatUrl ?? '');
    const ownedFreshLocalPostSendPage = (): boolean => {
      if (!config.newChat || !createdFreshPage || page !== originalHeldPage
        || ownershipForfeited || cleanupAuthorityUnprovenPages.has(page)
        || browserOrPageDefinitelyLost(page, browser) || sendCount < 1
        || targetChatUrl || ownedConversationUrl || !config.projectUrl) return false;
      try {
        return matchingFreshProjectLocalUrl(String(page.url()), config.projectUrl);
      } catch {
        return false;
      }
    };
    const beforePostDispatch = await checkAccountLoadError();
    if (beforePostDispatch && beforePostDispatch !== 'recovered') return beforePostDispatch;
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
      if (normalizeConversationUrl(String(page.url())) !== ownedConversationUrl) {
        beforeBrowserAction();
        attachHeld429(page, ownedConversationUrl);
        held429Witness?.beforeNavigation();
      }
      await navigateToProjectConversationIfNeeded(
        page,
        ownedConversationUrl,
        navigation,
      );
    }

    const startedAt = Date.now();
    // Do not restart the original invocation's post-Send observation clock.
    const hardAbsoluteDeadline = Math.min(invocationDeadlineMs, invocationStartedAt + STATE_LIGHT_MAX_TIMEOUT_MS);
    const softDeadline = Math.min(startedAt + config.timeoutMs, hardAbsoluteDeadline);
    let hardExhaustionDeadline = hardAbsoluteDeadline;
    const postSendSleep = async (ms: number): Promise<void> => {
      const remaining = hardExhaustionDeadline - Date.now();
      if (remaining > 0) await sleep(page, Math.min(ms, remaining));
    };
    const dispatchDeadline = startedAt + Math.min(DISPATCH_OBSERVATION_MS, config.timeoutMs);
    let lastReadyReply = '';
    let lastReadyObservedText = '';
    let bestReadyReply = '';
    let stableReads = 0;
    let lastReadyAssistantIdentity = '';
    let uncertainCause = '';
    let observedUserHeads: string[] | undefined;
    let ownedPromptEverSeen = false;
    let persistedOriginalMarkerProof = false;
    let ownedCarrierKey: string | undefined;
    let lastMarkerlessSnapshotSignature = '';
    let completionReadySeen = false;
    let deadEvidenceReads = 0;
    let markerlessFinishedReads = 0;
    let markerlessReloadUsed = false;
    let freshMarkerlessReply = '';
    let streamRecoveryBannerReads = 0;
    let streamRecoveryBannerCause: string | undefined;
    let streamRecoveryBannerRoute: 'local' | 'durable' | undefined;
    let streamRecoveryBannerFirstHeading: string | undefined;
    let streamRecoveryBannerLastIteration = -1;
    let bannerPollIteration = 0;
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
          // An unproved attempted Send remains possibly delivered at its original cutoff,
          // even when a lost-Page recovery census cannot complete.
          !config.newChat && sendAttempted && sendCount === 0
            && Date.now() >= invocationDeadlineMs
            ? 'observation_uncertain'
            : failure.state,
          'invocation',
          failure.cause,
          invocationId,
          profileKey,
          sendCount,
          pollCount,
          navigation,
          incidents,
          { ...(sendAttempted ? { send_attempted: true } : {}) },
          journalWriteFailed,
        ),
      };
    };

    const recoverCurrentObservation = async (localFetchFailure = false): Promise<TurnRunOutcome | null> => {
      // Reuse the existing read-only recovery adapter and preserve the lifecycle
      // graph's recoverCurrentObservation owner for its page/context census.
      // Positive page/browser loss retains its independent recovery cap.
      // The fresh unbound-only cutoff bounds recovery, not an owned reply.
      if (!localFetchFailure && recoveryState.lossEpoch === 0) {
        hardExhaustionDeadline = Math.min(
          hardExhaustionDeadline,
          Date.now() + CONFIRMED_OWNED_PAGE_LOSS_RECOVERY_MS,
        );
      }
      const recoveryDeadlineMs = config.newChat && !ownedConversationUrl && !ownedPromptEverSeen
        ? Math.min(hardExhaustionDeadline, freshUnboundReturnByMs)
        : !config.newChat && sendAttempted && sendCount === 0
          ? Math.min(hardExhaustionDeadline, invocationDeadlineMs)
          : hardExhaustionDeadline;
      const recoveryAdapter: PostSendRecoveryAdapter = {
      accountActionBlocker: () => {
        const observed = held429Witness?.current();
        if (observed) return observed.wall_kind === 'rate_limit' ? 'account_cooldown_active' : observed.wall_kind;
        const cooldown = readStateLightAccountCooldown(profileKey);
        if (cooldown.diagnostic) {
          incident('shared_account_cooldown_diagnostic', cooldown.diagnostic, 'fail_open');
        }
        return cooldown.active ? 'account_cooldown_active' : undefined;
      },
      uninspectedPotentialPages: async (activeBrowser, immutableUrl) => {
        const binding = getOwnTargetInfo(activeBrowser);
        if (!binding) throw new Error('recovery_target_binding_unavailable');
        return await countUninspectedRecoveryTargets(
          config.cdp, [binding.targetId, ...binding.successorTargetIds],
          immutableUrl, recoveryDeadlineMs,
        );
      },
      enumeratePages: async (activeBrowser) => {
        const contexts = (activeBrowser as any).contexts();
        if (!Array.isArray(contexts) || contexts.length !== 1) {
          throw new Error('recovery_context_count_unproven');
        }
        const pages = contexts[0].pages();
        if (!Array.isArray(pages)) throw new Error('recovery_page_enumeration_failed');
        const targetUrl = recoveryState.immutableConversationUrl;
        if (!targetUrl) {
          if (!(localFetchFailure && config.newChat && config.projectUrl)) return pages;
          // Only exclude a foreign project before transcript reads when its
          // canonical project identity is positively established. Unknown or
          // unreadable URLs remain in the census and fail closed.
          return pages.filter((candidate: any) => {
            try {
              const url = String(candidate.url());
              const parsed = new URL(url);
              const projectSegment = /^\/g\/(g-p-[^/]+)\/c\/[^/]+$/i.exec(parsed.pathname)?.[1];
              return !(projectSegment
                && projectConversationUrlMatchesProject(url, parsed.origin + '/g/' + projectSegment)
                && !projectConversationUrlMatchesProject(url, config.projectUrl!));
            } catch {
              return true;
            }
          });
        }
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
        const remainingMs = recoveryDeadlineMs - Date.now();
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
        const previous = getOwnTargetInfo(browser);
        if (!previous) throw new Error('ui_contract_mismatch:recovery_target_unbound');
        if (recoveryDeadlineMs <= Date.now()) throw new Error('browser_operation_timeout:recovery_deadline');
        const observed = await attachOwnTarget(chromium, {
          mode: 'own-target',
          cdp: config.cdp,
          deadlineMs: recoveryDeadlineMs,
          cleanupBudgetMs: RESOURCE_CLEANUP_BOUND_MS,
          postSend: true,
          pinnedTargetId: previous.targetId,
          chatUrl: recoveryState.immutableConversationUrl,
          newChat: false,
        });
        return observed.browser;
      },
      createSuccessor: async (activeBrowser, immutableConversationUrl) => {
        beforeBrowserAction();
        const recoveryBudget = createTurnOperationBudget(
          Math.max(0, recoveryDeadlineMs - Date.now()),
        );
        const successor = await createDedicatedTurnPage(activeBrowser, recoveryBudget);
        attachHeld429(successor, immutableConversationUrl);
        beforeBrowserAction();
        held429Witness?.beforeNavigation();
        navigation.recordGoto();
        await successor.goto(immutableConversationUrl, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(STATE_LIGHT_NAVIGATION_TIMEOUT_MS, Math.max(1, recoveryDeadlineMs - Date.now())),
        });
        return successor;
      },
      sleep: async (milliseconds) => {
        // An unproved attempted existing-chat Send cannot poll past its original cutoff.
        const remainingMs = !config.newChat && sendAttempted && sendCount === 0
          ? recoveryDeadlineMs - Date.now()
          : milliseconds;
        if (remainingMs <= 0) return;
        const waitMs = Math.min(milliseconds, remainingMs);
        if (recoveryHooks.sleep) {
          await recoveryHooks.sleep(waitMs);
        } else {
          await postSendSleep(waitMs);
        }
      },
      now: () => Date.now(),
      };
      let recovered: PostSendRecoveryResult;
      if (localFetchFailure) {
        // This invocation's local-chatgpt: tab lost the initial Send fetch.
        // Server execution is unknown; use only existing browser census evidence.
        const census = await takeRecoveryCensus(browser, marker, recoveryAdapter);
        const committedAfterCensus = verifiedExternalPrimary();
        if (committedAfterCensus) return committedAfterCensus;
        const matches = census.pages.filter((candidate) => candidate.eligible);
        const unbound = (cause: string): TurnRunOutcome => {
          incident('post_send_observation_error', cause, 'retain_page_no_resend');
          cleanupAuthorityUnprovenPages.add(page);
          return {
            page, browser, cleanupAction: 'preserve',
            result: compactResult(
              'observation_uncertain', 'invocation', cause,
              invocationId, profileKey, sendCount, pollCount, navigation, incidents,
              { send_attempted: true }, journalWriteFailed,
            ),
          };
        };
        if (census.monotonicAmbiguity || matches.length > 1) {
          return unbound('owned_prompt_marker_ambiguous');
        }
        if (!census.complete) return unbound(recoveryAdapter.accountActionBlocker?.() ?? 'owned_conversation_recovery_census_failed');
        if (matches.length === 0) return unbound('fresh_send_fetch_failed');
        const match = matches[0]!;
        if (!config.projectUrl || !projectConversationUrlMatchesProject(match.normalizedUrl, config.projectUrl)) {
          return unbound('recovered_fresh_owner_marker_or_project_unproven');
        }
        recovered = {
          kind: 'recovered', browser, page: match.page,
          conversationUrl: match.normalizedUrl, cleanupOwned: false,
          lossEpoch: recoveryState.lossEpoch,
        };
      } else {
        recovered = await runPostSendRecovery({
        browser,
        currentPage: page,
        marker,
        hardDeadlineMs: recoveryDeadlineMs,
        pollMs: Math.min(config.pollMs, 1_000),
        state: recoveryState,
        observer: recoveryHooks.observer,
        adapter: recoveryAdapter,
      });
      }

      browser = recovered.browser;
      const committedAfterRecovery = verifiedExternalPrimary();
      if (committedAfterRecovery) return committedAfterRecovery;
      if (recovered.kind === 'failure') return recoveryFailureOutcome(recovered);
      if (deliveryProofPendingRecovery) {
        sendCount = 1;
        afterSend = true;
        deliveryProofPendingRecovery = false;
      } else if (!config.newChat && sendAttempted && sendCount === 0) {
        // A successful exact-chat recovery already requires one unique
        // invocation-owned marker. Count it before persisting the irreversible
        // sent_unharvested observation, not on the next DOM poll.
        sendCount = 1;
        afterSend = true;
        markerDerivedSend = true;
        zeroWitnessAccountRecovery = false;
      }
      if (config.newChat && !ownedConversationUrl) {
        const recoveredMarkerProven = await freshProjectMarkerProven(
          recovered.page, recovered.conversationUrl, recoveryDeadlineMs,
        );
        // A probe may commit while this final read is awaiting the Page.
        // Publication truth outranks either marker refusal or phase rollback.
        const committedAfterRecoveryMarkerRead = verifiedExternalPrimary();
        if (committedAfterRecoveryMarkerRead) return committedAfterRecoveryMarkerRead;
        if (!recoveredMarkerProven) {
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
      const committedBeforeRecoveryBinding = transitionUnlessProbeCommitted({
        profileKey,
        invocationId,
        phase: 'sent_unharvested',
        reason: 'recovered_conversation_url_bound',
        sendCount,
        sendWitness: markerDerivedSend ? 'owned_marker' : 'numeric_send_count',
        conversationUrl: recovered.conversationUrl,
      });
      if (committedBeforeRecoveryBinding) return committedBeforeRecoveryBinding;

      if (localFetchFailure && createdFreshPage && page === originalHeldPage
        && recovered.page !== page && !cleanupAuthorityUnprovenPages.has(page)
        && freshCleanup && sendCount === 1 && sendAttempted
        && ownedConversationUrl === recovered.conversationUrl) {
        // Hold the created dead tab separately: reassigning `page` must not
        // discard its identity or make the recovered/sibling tab closable.
        freshCleanup.ownedDeadLocalPage = page;
        freshCleanup.ownedDeadLocalUrl = String(page.url());
        freshCleanup.ownedDeadLocalConversationUrl = recovered.conversationUrl;
        freshCleanup.ownedDeadLocalTimeoutMs = config.timeoutMs;
      }
      page = recovered.page;
      if (held429Page !== page || (config.newChat && !held429Witness?.current())) {
        attachHeld429(page, recovered.conversationUrl);
      }
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

    const ownedLocalFetchFailureVisible = async (): Promise<boolean> => {
      if (!config.newChat || !config.projectUrl || ownedConversationUrl || sendCount !== 1
        || browserOrPageDefinitelyLost(page, browser)) return false;
      return await ownedLocalFetchFailureVisibleOnPage(
        page, config.projectUrl,
        Math.min(freshUnboundReturnByMs, Date.now() + MAX_LOCAL_READ_WAIT_MS),
      );
    };

    // An independent read-only Page probe may have committed the original
    // invocation's complete primary while the driver saw an incomplete DOM.
    // Verify the actual committed output, not merely an observed path or phase.
    const verifiedExternalPrimary = (): TurnRunOutcome | null => {
      let verified: ReturnType<typeof readVerifiedStateLightHarvestedPrimary>;
      try {
        verified = readVerifiedStateLightHarvestedPrimary({
          profileKey, invocationId, marker, target: destination.finalPath,
        });
      } catch {
        return null;
      }
      if (!verified) return null;
      sendCount = 1;
      ownedPromptEverSeen = true;
      markerDerivedSend = verified.sendWitness === 'owned_marker';
      return {
        page, browser,
        publicationState: 'committed_ok',
        ...(ownedConversationUrl ? { profileKey, ownedConversationUrl } : {}),
        ...(ownershipForfeited ? { ownershipForfeited: true } : {}),
        result: compactResult(
          'ok', 'none', 'completed_page_probe_primary',
          invocationId, profileKey, 1, pollCount, navigation, incidents,
          {
            ...(sendAttempted ? { send_attempted: true } : {}),
            ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}),
            output: { byte_length: verified.byteLength, sha256: verified.sha256 },
          },
          journalWriteFailed,
        ),
      };
    };
    // A probe can commit while a driver read is awaited. Revalidate the exact
    // committed bytes before any competing phase mutation, and on only the
    // harvested-phase race. Unrelated observation errors must still surface.
    const transitionUnlessProbeCommitted = (
      input: Parameters<typeof transitionStateLightTurnObservation>[0],
    ): TurnRunOutcome | null => {
      const committed = verifiedExternalPrimary();
      if (committed) return committed;
      try {
        transitionStateLightTurnObservation(input);
      } catch (error) {
        if (error instanceof Error && error.message === 'observation_phase_transition_invalid') {
          const raced = verifiedExternalPrimary();
          if (raced) return raced;
        }
        throw error;
      }
      return null;
    };
    // The early unbound cutoff remains valid ONLY while the original owned
    // marker is unproven. A verified marker (including on a local-chatgpt URL)
    // continues through the original absolute deadline for a late full reply.
    const unprovenFreshCutoff = (): TurnRunOutcome | null => {
      if (!config.newChat || ownedConversationUrl || ownedPromptEverSeen
        || (!sendAttempted && sendCount < 1) || Date.now() < freshUnboundReturnByMs) return null;
      incident('post_send_observation_error', 'fresh_conversation_owner_unproven', 'terminal_cleanup_no_resend');
      return {
        page, browser,
        result: compactResult(
          'observation_uncertain', 'invocation', 'fresh_conversation_owner_unproven',
          invocationId, profileKey, sendCount, pollCount, navigation, incidents,
          { ...(sendAttempted ? { send_attempted: true } : {}),
            next_action: FRESH_LOCAL_POSSIBLY_DELIVERED_NEXT_ACTION },
          journalWriteFailed,
        ),
      };
    };
    // Each iteration rechecks a same-invocation committed primary before any
    // mutable Send-count/late-URL transition or new transcript acquisition.
    while (true) {
      const independentlyCommitted = verifiedExternalPrimary();
      if (independentlyCommitted) return independentlyCommitted;
      if (Date.now() >= hardExhaustionDeadline) {
        const cause = uncertainCause || 'post_send_absolute_deadline_elapsed';
        incident('post_send_observation_error', cause, 'terminal_cleanup_no_resend');
        return {
          page, browser,
          result: compactResult(
            sendCount === 0 && !sendAttempted ? 'no_reply' : 'observation_uncertain',
            'invocation', cause, invocationId, profileKey,
            sendCount, pollCount, navigation, incidents,
            { ...(sendAttempted ? { send_attempted: true } : {}),
              ...(config.newChat && !ownedConversationUrl
                ? { next_action: FRESH_LOCAL_POSSIBLY_DELIVERED_NEXT_ACTION } : {}) },
            journalWriteFailed,
          ),
        };
      }
      bannerPollIteration += 1;
      // A late observed own request is still the original physical Send.
      const zeroCountCutoffMs = config.newChat && !ownedConversationUrl
        ? freshUnboundReturnByMs : invocationDeadlineMs;
      // A finished exact-owned server GET with this invocation's user marker
      // proves delivery even after an ambiguous second action. Its sticky
      // current-epoch witness outranks a later GET that lacks the marker.
      // Bind this only to the unchanged original held Page and owned URL.
      if (!config.newChat && sendAttempted && sendCount === 0
        && targetChatUrl && held429Page === page
        && readOwnedConversationIdentity(page, targetChatUrl).matched
        && held429Witness?.serverMarkerPresent() === true) {
        sendCount = 1;
        markerDerivedSend = true;
        ownedPromptEverSeen = true;
        const committed = transitionUnlessProbeCommitted({
          profileKey, invocationId, phase: 'sent_unharvested',
          reason: 'owned_server_user_marker', sendCount, sendWitness: 'owned_marker',
          conversationUrl: targetChatUrl,
        });
        if (committed) return committed;
        emitCancellationReceipt(targetChatUrl);
      }
      if (sendAttempted && sendCount === 0 && Date.now() < zeroCountCutoffMs
        && held429Witness?.ownSubmissionIssued()) {
        sendCount = 1;
        if (config.newChat) {
          const committed = transitionUnlessProbeCommitted({
            profileKey, invocationId, phase: 'sent_unbound',
            reason: 'own_submission_post_issued', sendCount, sendWitness: 'numeric_send_count',
          });
          if (committed) return committed;
        } else if (targetChatUrl) {
          const committed = transitionUnlessProbeCommitted({
            profileKey, invocationId, phase: 'sent_unharvested',
            reason: 'own_submission_post_issued', sendCount, sendWitness: 'numeric_send_count',
            conversationUrl: targetChatUrl,
          });
          if (committed) return committed;
          emitCancellationReceipt(targetChatUrl);
        }
      }
      if (config.newChat && sendAttempted && sendCount === 0 && !ownedConversationUrl
        && freshPreSendFetchAlertAbsent && createdFreshPage
        && page === originalHeldPage && !ownershipForfeited
        && !cleanupAuthorityUnprovenPages.has(page) && config.projectUrl
        && !held429Witness?.ownSubmissionIssued()
        // An alert marked before dispatch, or no live unmarked alert, cannot
        // establish a new F4 symptom. Missing alert provenance fails closed.
        && await (async () => {
          try {
            return await locatorCount(
              page.locator(UNMARKED_ALERT_SELECTOR),
              Math.min(freshUnboundReturnByMs, Date.now() + MAX_LOCAL_READ_WAIT_MS),
            ) > 0;
          } catch {
            // A missing/foreign/failed alert read cannot establish F4 freshness.
            return false;
          }
        })()
        && await ownedLocalFetchFailureVisibleOnPage(
          page, config.projectUrl,
          Math.min(freshUnboundReturnByMs, Date.now() + MAX_LOCAL_READ_WAIT_MS),
        )
        // A transient alert can disappear as an accepted send commits.
        // A second fresh read at the same exact Page/route is required.
        && !held429Witness?.ownSubmissionIssued()
        && await ownedLocalFetchFailureVisibleOnPage(
          page, config.projectUrl,
          Math.min(freshUnboundReturnByMs, Date.now() + MAX_LOCAL_READ_WAIT_MS),
        )
        && !held429Witness?.ownSubmissionIssued()) {
        // Do not terminate before the incumbent read-only census can find an
        // already-delivered unique owned marker on another existing Page.
        // Otherwise it returns the existing uncertain fresh_send_fetch_failed.
        const terminal = await recoverCurrentObservation(true);
        if (terminal) return terminal;
        continue;
      }
      // Never turn the fresh URL subwindow into a terminal Send verdict.
      // The still-live original Page may expose its unique owned marker and a
      // completed reply after freshUnboundReturnByMs. The whole post-Send loop
      // remains bounded by hardExhaustionDeadline (the original invocation
      // absolute maximum), while confirmed Page loss retains its separate
      // bounded, read-only recovery deadline below.
      if ((sendCount >= 1 || deliveryProofPendingRecovery || sendAttempted) && browserOrPageDefinitelyLost(page, browser)) {
        const terminal = await recoverCurrentObservation();
        if (terminal) return terminal;
        continue;
      }
      const liveAccountError = await checkAccountLoadError();
      if (liveAccountError && liveAccountError !== 'recovered') return liveAccountError;
      if (liveAccountError === 'recovered') continue;
      if (await ownedLocalFetchFailureVisible()) {
        const terminal = await recoverCurrentObservation(true);
        if (terminal) return terminal;
        continue;
      }
      pollCount++;
      if (config.newChat && sendCount >= 1 && ownedConversationUrl) {
        recoveryState.immutableConversationUrl = ownedConversationUrl;
        if (normalizeConversationUrl(String(page.url())) !== ownedConversationUrl) {
          beforeBrowserAction();
          attachHeld429(page, ownedConversationUrl);
          held429Witness?.beforeNavigation();
        }
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
        const committedDuringRead = verifiedExternalPrimary();
        if (committedDuringRead) return committedDuringRead;
      } catch (error) {
        const committedDuringRead = verifiedExternalPrimary();
        if (committedDuringRead) return committedDuringRead;
        if (browserOrPageDefinitelyLost(page, browser)) {
          const terminal = await recoverCurrentObservation();
          if (terminal) return terminal;
          continue;
        }
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
        const symptom = error instanceof Error ? error.message : String(error);
        incident('post_send_observation_error', symptom, 'continue_polling_owned_page');
        streamRecoveryBannerReads = 0;
        streamRecoveryBannerCause = undefined;
        streamRecoveryBannerRoute = undefined;
        streamRecoveryBannerFirstHeading = undefined;
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
        await postSendSleep(INITIAL_POLL_MS);
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
          if (browserOrPageDefinitelyLost(page, browser)) {
            const terminal = await recoverCurrentObservation();
            if (terminal) return terminal;
            continue;
          }
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
      if ('wall_kind' in wall && wall.wall_kind === 'conversation_load_error' && !held429Witness?.current()) {
        incident('post_send_observation_error', 'conversation_load_error', 'retain_owned_page_no_resend');
        return {
          page, browser, cleanupAction: 'preserve',
          result: compactResult(
            'observation_uncertain', 'invocation', 'conversation_load_error',
            invocationId, profileKey, sendCount, pollCount, navigation, incidents,
            { ...(sendAttempted ? { send_attempted: true } : {}) },
            journalWriteFailed,
          ),
        };
      }
      if (wall.state === 'recovery_required' && !held429Witness?.current()
        // Only the unrendered-owner local alert is handled by the new adjacent
        // poll gate. A visible owned marker retains the pre-existing wall route.
        && (hasOwnedUserMessage(messages, marker) || !ownedFreshLocalPostSendPage()) && (
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
        streamRecoveryBannerReads = 0;
        streamRecoveryBannerCause = undefined;
        streamRecoveryBannerRoute = undefined;
        streamRecoveryBannerFirstHeading = undefined;
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
        const unproven = unprovenFreshCutoff();
        if (unproven) return unproven;
        updateHeartbeatForPoll({ state: 'waiting' });
        await postSendSleep(INITIAL_POLL_MS);
        continue;
      }

      const markerCardinality = recoveryMarkerCardinality(messages, marker);
      if (sendAttempted && sendCount === 0
        && markerCardinality.matchingUserCarrierCount === 1
        && markerCardinality.exactMarkerTokenCount === 1
        && (config.newChat
          ? Boolean(createdFreshPage && page === originalHeldPage
            && !ownershipForfeited && config.projectUrl
            && (matchingFreshProjectLocalUrl(String(page.url()), config.projectUrl)
              || isBlankProjectSurfaceUrl(String(page.url()), config.projectUrl)
              || Boolean(readProjectConversationUrl(page, config.projectUrl))))
          : Boolean(targetChatUrl && readOwnedConversationIdentity(page, targetChatUrl).matched))) {
        // The original exact Page's unique owned marker proves the attempted
        // Send even if DOM evidence first appears after the 30s subwindow.
        sendCount = 1;
        markerDerivedSend = true;
        ownedPromptEverSeen = true;
        zeroWitnessAccountRecovery = false;
        if (config.newChat) {
          const committed = transitionUnlessProbeCommitted({
            profileKey, invocationId, phase: 'sent_unbound',
            reason: 'fresh_owned_marker_observed', sendCount, sendWitness: 'owned_marker',
          });
          if (committed) return committed;
        }
      }
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
        if (observedConversationUrl && isSupportedChatGptConversationUrl(observedConversationUrl)
          && Date.now() < hardExhaustionDeadline) {
          // A probe's committed result outranks any new URL claim/transition.
          const committedBeforeBinding = verifiedExternalPrimary();
          if (committedBeforeBinding) return committedBeforeBinding;
          // A marker on the original pinned Page can validate a later URL
          // even after the initial fresh URL subwindow. The first-claim fence
          // remains mandatory; no new Page, Retry or Send is authorized here.
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
          const committed = transitionUnlessProbeCommitted({
            profileKey,
            invocationId,
            phase: 'sent_unharvested',
            reason: 'fresh_conversation_url_observed_owned_marker',
            sendCount,
            sendWitness: markerDerivedSend ? 'owned_marker' : 'numeric_send_count',
            conversationUrl: observedConversationUrl,
          });
          if (committed) return committed;
          ownedConversationUrl = observedConversationUrl;
          if (!held429Witness?.current()) attachHeld429(page, observedConversationUrl);
          recoveryState.immutableConversationUrl = observedConversationUrl;
          emitCancellationReceipt(observedConversationUrl);
        }
      }
      const durableConversationUrl = targetChatUrl ?? ownedConversationUrl;
      if (durableConversationUrl && sendCount >= 1) {
        const durableRecord = readStateLightTurnObservation(profileKey, invocationId);
        if (durableRecord.phase === 'dispatching' || !durableRecord.conversation_url) {
          const committed = transitionUnlessProbeCommitted({
            profileKey,
            invocationId,
            phase: 'sent_unharvested',
            reason: 'conversation_url_observed',
            sendCount,
            sendWitness: markerDerivedSend ? 'owned_marker' : 'numeric_send_count',
            conversationUrl: durableConversationUrl,
          });
          if (committed) return committed;
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

      // Keep the established durable Stop/grace behavior. A positively created,
      // still-held fresh project-local Page has no durable locator, so only two
      // adjacent complete idle observations on that exact Page may settle it.
      const localBanner = !markerVisible && ownedFreshLocalPostSendPage();
      // Pin the exact initial local route, not just its project/pattern: a
      // different local-chatgpt id on the same held Page breaks the streak.
      let localBannerUrl: string | undefined;
      try { if (localBanner) localBannerUrl = String(page.url()); } catch { /* Not eligible. */ }
      const sameLocalRoute = (): boolean => {
        if (!localBannerUrl || !ownedFreshLocalPostSendPage()) return false;
        try { return String(page.url()) === localBannerUrl; } catch { return false; }
      };
      const durableBanner = !markerVisible && Boolean(durableConversationUrl)
        && sendCount >= 1 && recoveryBannerTrusted
        && pageTurnEvidence?.generationInProgress !== true;
      if (localBanner || durableBanner) {
        const bannerRoute = localBanner ? 'local' : 'durable';
        // Zero rendered messages may leave pageTurnEvidence undefined. A
        // latched earlier Stop is not current negative generation evidence.
        const currentLocalIdle = !localBanner || (
          pageTurnEvidence?.generationInProgress !== true
          && await readFreshStopVisible(
            page, Math.min(freshUnboundReturnByMs, Date.now() + MAX_LOCAL_READ_WAIT_MS),
          ) === false
          && sameLocalRoute()
        );
        let bannerCause: string | undefined;
        let bannerText: string | undefined;
        if (currentLocalIdle) {
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
            // Multiple/conflicting local alerts cannot be an adjacent trustworthy
            // observation. Keep the incumbent durable multi-alert fallback.
            bannerCause = localBanner
              ? texts.length === 1 && causes.size === 1 ? [...causes][0] : undefined
              : causes.size === 1 ? [...causes][0] : causes.size > 1 ? 'product_error_banner' : undefined;
            bannerText = texts.map(alertHeading).find(Boolean)?.slice(0, 160);
          } catch (error) {
            if (isPostSendTargetCrash(error)) throw error;
            // Unreadable/failed polling is an interruption, not a streak member.
          }
        }
        // Alert extraction itself awaits the live DOM. The held local Page may
        // gain a durable route, a rendered marker/reply, or a new Stop during
        // that read; the pre-read idle proof must not settle a stale poll.
        if (localBanner && bannerCause) {
          let stillLocalIdle = false;
          try {
            if (sameLocalRoute()) {
              const currentTranscript = await readPageObservation(
                page, marker, baselineCount, false,
                Math.min(freshUnboundReturnByMs, Date.now() + MAX_LOCAL_READ_WAIT_MS),
              );
              stillLocalIdle = !currentTranscript.transcriptIncomplete
                && currentTranscript.messages.length === 0
                && currentTranscript.pageTurnEvidence?.generationInProgress !== true
                && sameLocalRoute()
                && await readFreshStopVisible(
                  page, Math.min(freshUnboundReturnByMs, Date.now() + MAX_LOCAL_READ_WAIT_MS),
                ) === false
                && sameLocalRoute();
            }
          } catch (error) {
            if (isPostSendTargetCrash(error)) throw error;
          }
          if (!stillLocalIdle) {
            bannerCause = undefined;
            bannerText = undefined;
          }
        }
        if (streamRecoveryBannerRoute !== bannerRoute) {
          streamRecoveryBannerReads = 0;
          streamRecoveryBannerCause = undefined;
          streamRecoveryBannerFirstHeading = undefined;
        }
        const adjacentLocalPoll = bannerPollIteration === streamRecoveryBannerLastIteration + 1;
        streamRecoveryBannerReads = bannerCause && bannerCause === streamRecoveryBannerCause
          && (!localBanner || adjacentLocalPoll)
          ? streamRecoveryBannerReads + 1
          : bannerCause ? 1 : 0;
        if (streamRecoveryBannerReads === 1) streamRecoveryBannerFirstHeading = bannerText;
        streamRecoveryBannerCause = bannerCause;
        streamRecoveryBannerRoute = bannerCause ? bannerRoute : undefined;
        streamRecoveryBannerLastIteration = bannerCause ? bannerPollIteration : -1;
        if (bannerCause && streamRecoveryBannerReads >= 2) {
          incident('invocation_blocker', bannerCause, 'retain_owned_page_no_resend');
          return {
            page,
            browser,
            cleanupAction: 'preserve',
            ...(localBanner ? { retainOwnedFreshLocalPage: true } : {}),
            result: compactResult(
              'recovery_required',
              localBanner ? 'invocation' : 'conversation',
              bannerCause,
              invocationId,
              profileKey,
              sendCount,
              pollCount,
              navigation,
              incidents,
              {
                ...(localBanner
                  ? { next_action: FRESH_LOCAL_POSSIBLY_DELIVERED_NEXT_ACTION }
                  : { conversation_id: durableConversationUrl }),
                ...((localBanner ? streamRecoveryBannerFirstHeading : bannerText)
                  ? { product_banner_text: localBanner ? streamRecoveryBannerFirstHeading : bannerText } : {}),
              },
              journalWriteFailed,
            ),
          };
        }
      } else {
        streamRecoveryBannerReads = 0;
        streamRecoveryBannerCause = undefined;
        streamRecoveryBannerRoute = undefined;
        streamRecoveryBannerFirstHeading = undefined;
        streamRecoveryBannerLastIteration = -1;
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
        const reply = freshTranscriptAssistants[0]!.text;
        if (normalizeVisibleText(reply) && reply === freshMarkerlessReply) {
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
          beforeBrowserAction();
          markerlessReloadUsed = true;
          incident(
            'post_send_observation_error',
            'owned_marker_not_rendered',
            'reload_owned_conversation_no_resend',
          );
          try {
            held429Witness?.beforeNavigation();
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
          await postSendSleep(INITIAL_POLL_MS);
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

      if (markerCardinality.matchingUserCarrierCount === 1
        && markerCardinality.exactMarkerTokenCount === 1
        && (config.newChat
          ? (createdFreshPage && page === originalHeldPage
            && !ownershipForfeited && Boolean(config.projectUrl)
            && (matchingFreshProjectLocalUrl(String(page.url()), config.projectUrl!)
              || isBlankProjectSurfaceUrl(String(page.url()), config.projectUrl!)))
          : Boolean(targetChatUrl && readOwnedConversationIdentity(page, targetChatUrl).matched))) {
        ownedPromptEverSeen = true;
        if (!persistedOriginalMarkerProof) {
          try {
            const beforeProof = readStateLightTurnObservation(profileKey, invocationId);
            if (beforeProof.phase === 'harvested') {
              const committed = verifiedExternalPrimary();
              if (committed) return committed;
            } else if (!beforeProof.owned_marker_confirmed) {
              transitionStateLightTurnObservation({
                profileKey, invocationId,
                phase: beforeProof.phase,
                reason: 'unique_original_page_first_token_marker',
                ownedMarkerConfirmed: true,
              });
            }
            persistedOriginalMarkerProof = true;
          } catch (error) {
            if (error instanceof Error && error.message === 'observation_phase_transition_invalid') {
              const racedCommit = verifiedExternalPrimary();
              if (racedCommit) return racedCommit;
            }
            throw error;
          }
        }
      }

      // Check only after this Page's complete marker census. Never use URL
      // absence alone to reject a uniquely marker-proven late local reply.
      const unproven = unprovenFreshCutoff();
      if (unproven) return unproven;

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
        await postSendSleep(INITIAL_POLL_MS);
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
        const hasOwnershipEvidence = (
          hasOwnedUserMessage(messages, marker)
          || Boolean(ownedCarrierKey)
          || Boolean(config.newChat && ownedConversationUrl && !ownershipForfeited
            && freshClaimOwnerFenceValid(profileKey, ownedConversationUrl, invocationId, config.timeoutMs))
        ) && (!config.newChat || Boolean(
          ownedConversationUrl
          && !ownershipForfeited
          && readProjectConversationUrl(page, config.projectUrl ?? '')
          && readOwnedConversationIdentity(page, ownedConversationUrl).matched
          && freshClaimOwnerFenceValid(profileKey, ownedConversationUrl, invocationId, config.timeoutMs)
        ));
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
              continuationCarrier.continuationVisible === true
                && !held429Witness?.current()
                && !readStateLightAccountCooldown(profileKey).active,
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
          await postSendSleep(INITIAL_POLL_MS);
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
          await postSendSleep(INITIAL_POLL_MS);
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
          if (config.newChat && !ownedConversationUrl
            && !(createdFreshPage && page === originalHeldPage && ownedPromptEverSeen)) {
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
            await postSendSleep(INITIAL_POLL_MS);
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
          const beforeFinalRead = await checkAccountLoadError();
          if (beforeFinalRead && beforeFinalRead !== 'recovered') return beforeFinalRead;
          if (beforeFinalRead === 'recovered') continue;
          const captureReply = decision.reply;
          const managerReply = captureReply;
          let finalObservation: Awaited<ReturnType<typeof readPostSendObservation>>;
          try {
            finalObservation = await readPostSendObservation(page, marker, baselineCount, hardExhaustionDeadline, observeProductWall);
          } catch (error) {
            if (browserOrPageDefinitelyLost(page, browser)) {
              const terminal = await recoverCurrentObservation();
              if (terminal) return terminal;
              continue;
            }
            throw error;
          }
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
            ? finalKeyedAssistant[0]!.text
            : finalAssistantMessages.length === 1
              ? finalAssistantMessages[0]!.text
              : '';
          const finalMarkerlessEligible = finalReady
            && (ownedCarrierKey
              ? finalKeyedCandidate?.state === 'ready'
                && finalKeyedAssistant.length === 1
                && finalKeyedAssistant[0]!.text === managerReply
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
            await postSendSleep(INITIAL_POLL_MS);
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
        await postSendSleep(STABILITY_READ_DELAY_MS);
        continue;
      }

      stableReads = 0;
      lastReadyReply = '';
      lastReadyObservedText = '';
      bestReadyReply = '';
      completionReadySeen = false;
      lastReadyAssistantIdentity = '';
      // Absence at the intermediate landing clock is not negative evidence.
      // The existing freshUnboundReturnByMs guard owns unbound termination.

      if (Date.now() >= dispatchDeadline) {
        if (!hasOwnedUserMessage(messages, marker)) {
          if (sendCount >= 1 || sendAttempted || zeroWitnessAccountRecovery) {
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
      await postSendSleep(sendAttempted && sendCount === 0 && Date.now() < zeroCountCutoffMs
        ? Math.min(delay, Math.max(1, zeroCountCutoffMs - Date.now()))
        : config.newChat && !ownedConversationUrl && Date.now() < freshUnboundReturnByMs
          ? Math.min(delay, Math.max(1, freshUnboundReturnByMs - Date.now()))
        : recoveryState.lossEpoch > 0
          ? Math.min(delay, Math.max(1, hardExhaustionDeadline - Date.now()))
          : beforeSoftDeadline
            ? Math.min(delay, Math.max(1, softDeadline - Date.now()))
            : delay);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attemptsOnFailure = (error as { attachAttempts?: unknown } | null)?.attachAttempts;
    if (typeof attemptsOnFailure === 'number' && Number.isSafeInteger(attemptsOnFailure)) {
      attachAttempts += attemptsOnFailure;
    }
    const isInput = message.startsWith('input_invalid:');
    const isOutput = message.startsWith('output_conflict:');
    const isUi = message.startsWith('ui_contract_mismatch:');
    const isAccountCooldown = message === 'account_cooldown_active';
    const isNamed429 = message === 'conversation_fetch_http_429'
      || (message === 'rate_limit' && held429Witness?.current()?.http_status === 429);
    const isSharedBlocked = isNamed429 || isAccountCooldown;
    const state: TurnState = isInput
      ? 'input_invalid'
      : isOutput
        ? 'output_conflict'
        : isSharedBlocked
          ? (afterSend || sendAttempted ? 'observation_uncertain' : 'rate_limit')
          : isUi || (!afterSend && /ERR_NETWORK_CHANGED/iu.test(message))
            ? 'ui_contract_mismatch'
            : 'driver_error';
    const retirementCleanupRequired = message === 'observation_mutation_retirement_cleanup_required';
    const holderTimeout = error instanceof StateLightSendSlotTimeoutError ? error : undefined;
    const lostAfterSend = afterSend && browserOrPageDefinitelyLost(page, browser);
    const observedNetworkChange = !afterSend && /ERR_NETWORK_CHANGED/iu.test(message);
    const cause = isSharedBlocked ? message : observedNetworkChange ? 'network_changed' : retirementCleanupRequired
      ? message
      : afterSend
        ? lostAfterSend
          ? 'page_or_browser_lost_after_send'
          : 'helper_error_after_send_page_retained'
        : message === 'ui_contract_mismatch:fresh_conversation_surface_unavailable'
          ? 'fresh_conversation_surface_unavailable'
          : message;
    if (!isInput && !isOutput) {
      if (!afterSend) preSendDiagnostic(cause);
      incident(
        retirementCleanupRequired
          ? 'observation_mutation_retirement_cleanup_required'
          : afterSend
            ? 'helper_failure_after_send'
            : 'helper_failure_before_send',
        cause,
        retirementCleanupRequired
          ? 'retry_cleanup_later_no_resend'
          : isSharedBlocked
            ? 'retain_owned_page_no_resend'
            : afterSend
              ? lostAfterSend
                ? 'skip_lost_page_no_resend'
                : 'retain_owned_page_no_resend'
              : 'return_local_error',
      );
    }
    const provenOpenedFetch429 = cause === 'conversation_fetch_http_429'
      && held429Witness?.current()?.wall_kind === 'conversation_fetch_http_429'
      && held429Witness.current()?.http_status === 429
      && state === 'rate_limit' && !afterSend && !sendAttempted && sendCount === 0
      && !ownershipForfeited && page === invocationCreatedExistingChatPage
      && Boolean(invocationCreatedExistingChatUrl)
      && !cleanupAuthorityUnprovenPages.has(page)
      && !browserOrPageDefinitelyLost(page, browser)
      && ownedPreSendFetch429ExactRoute(page, invocationCreatedExistingChatUrl!);
    return {
      ...(page ? { page } : {}),
      ...(browser ? { browser } : {}),
      ...(createdAttachFailureCleanup ? { createdAttachFailureCleanup } : {}),
      ...(createdAttachFailureTargetId ? { createdAttachFailureTargetId } : {}),
      ...(provenOpenedFetch429 ? {
        ownedPreSendFetch429Page: page,
        ownedPreSendFetch429Url: invocationCreatedExistingChatUrl,
      } : {}),
      ...(lostAfterSend ? { cleanupAction: 'skip' as const } : {}),
      ...(isSharedBlocked && !lostAfterSend ? { cleanupAction: 'preserve' as const } : {}),
      ...(ownershipForfeited ? { ownershipForfeited: true, cleanupAction: 'preserve' as const } : {}),
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
            ...(isAccountCooldown && refusedCooldownUntil !== undefined
              ? { cooldown_until_ms: refusedCooldownUntil } : {}),
            ...(!sendAttempted ? { attach_attempts: attachAttempts } : {}),
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
  } finally {
    held429Witness?.dispose();
  }
}

/**
 * Current destructive-boundary authority, not a historical ownership inference.
 * A same-ID/same-route marker with a visible Stop or in-progress assistant can
 * belong to an independent generation; no available current-generation witness
 * makes that active surface closable.
 */
/**
 * Optional exact predecessor handoff: the only accepted locator is the
 * caller-supplied indexed invocation+attempt in the SAME run/task. No
 * profile-wide sweep, URL selection, newPage, Send, Stop, Retry or harvest.
 * The driver alone attaches and performs the current destructive-boundary read.
 */
async function retireExplicitPredecessor(input: {
  readonly previousInvocationId: string;
  readonly previousAttemptIdentity: string;
  readonly runIdentity: string;
  readonly ownerTaskId: string;
  readonly profileKey: string;
  readonly cdp: string;
  readonly deadlineMs: number;
}): Promise<{ status: 'confirmed' | 'cleanup_unconfirmed'; targetId?: string }> {
  let original: ReturnType<typeof readStateLightTurnObservation>;
  let originalId: string | undefined;
  try {
    const { readInvocationReceiptLocator, readTerminalEnvelope } =
      await import('../flow-manager-long-running-child.ts');
    const bound = readInvocationReceiptLocator({
      invocationId: input.previousInvocationId,
      runIdentity: input.runIdentity,
      attemptIdentity: input.previousAttemptIdentity,
      ownerTaskId: input.ownerTaskId,
    });
    const terminal = readTerminalEnvelope(bound.locator.terminal_envelope_path, {
      runIdentity: input.runIdentity, attemptIdentity: input.previousAttemptIdentity,
    });
    if (!terminal || terminal.observed_invocation_id !== input.previousInvocationId
      || terminal.handoff_receipt_path !== bound.locator.handoff_receipt_path
      || terminal.cleanup_status !== 'cleanup_unconfirmed'
      || bound.receipt.owner_task_id !== input.ownerTaskId) return { status: 'cleanup_unconfirmed' };
    original = readStateLightTurnObservation(input.profileKey, input.previousInvocationId);
    originalId = original.owned_target?.id;
    if (!original.owned_target?.created
      || original.owned_target.cdp_sha256 !== createHash('sha256').update(input.cdp, 'utf8').digest('hex')
      || terminal.owned_target_created !== true
      || terminal.owned_target_id !== original.owned_target.id
      || terminal.owned_prompt_marker !== original.marker) {
      return { status: 'cleanup_unconfirmed', ...(originalId ? { targetId: originalId } : {}) };
    }
  } catch {
    return { status: 'cleanup_unconfirmed', ...(originalId ? { targetId: originalId } : {}) };
  }
  const targetId = original.owned_target.id;
  let browser: any;
  try {
    // This census cannot create, navigate to or select a sibling target.
    const census = await listCdpPageTargets(input.cdp, Math.min(
      MAX_LOCAL_READ_WAIT_MS, Math.max(1, input.deadlineMs - Date.now()),
    ));
    const matches = census.filter((target) => target.id === targetId);
    if (matches.length === 0) return { status: 'confirmed', targetId };
    if (matches.length !== 1 || Date.now() >= input.deadlineMs) return { status: 'cleanup_unconfirmed', targetId };
    const attached = await attachOwnTarget(loadChromium(), {
      mode: 'own-target', cdp: input.cdp, newChat: false,
      pinnedTargetId: targetId, deadlineMs: input.deadlineMs,
      cleanupBudgetMs: RESOURCE_CLEANUP_BOUND_MS,
    });
    browser = attached.browser;
    const pages = browser.contexts();
    const page = pages.length === 1 && pages[0]?.pages().length === 1
      ? pages[0].pages()[0] : undefined;
    if (!page || getOwnTargetInfo(browser)?.targetId !== targetId) {
      return { status: 'cleanup_unconfirmed', targetId };
    }
    const result = compactResult(
      'observation_uncertain', 'invocation', 'predecessor_cleanup_only',
      input.previousInvocationId, input.profileKey, original.send_count ?? 0, 0,
      new StateLightNavigationCounter(), [],
    );
    const closed = await guardedOriginalTargetRetirement({
      outcome: { page, browser, result }, cdp: input.cdp, verifiedPredecessor: true,
    });
    return { status: closed.status === 'confirmed' ? 'confirmed' : 'cleanup_unconfirmed', targetId, cause: closed.cause };
  } catch {
    return { status: 'cleanup_unconfirmed', targetId };
  } finally {
    if (browser) await releaseCdpBrowser(browser, RESOURCE_CLEANUP_BOUND_MS);
  }
}

/**
 * Reconnect read-only to this invocation's original created target after a
 * separate recovery Page was used. The original pinned ID is necessary but
 * never sufficient; the normal live destructive-boundary checks still decide.
 */
async function retireDetachedOriginalTarget(input: {
  readonly profileKey: string;
  readonly invocationId: string;
  readonly cdp: string;
  readonly deadlineMs: number;
}): Promise<{ readonly status: 'confirmed' | 'cleanup_unconfirmed'; readonly targetId?: string }> {
  let record: ReturnType<typeof readStateLightTurnObservation>;
  try {
    record = readStateLightTurnObservation(input.profileKey, input.invocationId);
  } catch { return { status: 'cleanup_unconfirmed' }; }
  const pinned = record.owned_target;
  if (!pinned?.created || pinned.cdp_sha256 !== createHash('sha256').update(input.cdp, 'utf8').digest('hex')) {
    return { status: 'cleanup_unconfirmed', ...(pinned ? { targetId: pinned.id } : {}) };
  }
  const targetId = pinned.id;
  let attachedBrowser: any;
  try {
    const census = await listCdpPageTargets(input.cdp,
      Math.min(MAX_LOCAL_READ_WAIT_MS, Math.max(1, input.deadlineMs - Date.now())));
    const selected = census.filter((target) => target.id === targetId);
    if (selected.length === 0) return { status: 'confirmed', targetId };
    if (selected.length !== 1 || Date.now() >= input.deadlineMs) {
      return { status: 'cleanup_unconfirmed', targetId };
    }
    const attached = await attachOwnTarget(loadChromium(), {
      mode: 'own-target', cdp: input.cdp, newChat: false,
      pinnedTargetId: targetId, deadlineMs: input.deadlineMs,
      cleanupBudgetMs: RESOURCE_CLEANUP_BOUND_MS,
    });
    attachedBrowser = attached.browser;
    const contexts = attachedBrowser.contexts();
    const page = contexts.length === 1 && contexts[0]?.pages().length === 1
      ? contexts[0].pages()[0] : undefined;
    if (!page || getOwnTargetInfo(attachedBrowser)?.targetId !== targetId) {
      return { status: 'cleanup_unconfirmed', targetId };
    }
    const result = compactResult('observation_uncertain', 'invocation',
      'original_target_retirement_only', input.invocationId, input.profileKey,
      record.send_count ?? 0, 0, new StateLightNavigationCounter(), []);
    const cleanup = await guardedOriginalTargetRetirement({
      outcome: { page, browser: attachedBrowser, result },
      cdp: input.cdp, verifiedPredecessor: true,
    });
    return { status: cleanup.status === 'confirmed' ? 'confirmed' : 'cleanup_unconfirmed', targetId, cause: cleanup.cause };
  } catch { return { status: 'cleanup_unconfirmed', targetId }; }
  finally { if (attachedBrowser) await releaseCdpBrowser(attachedBrowser, RESOURCE_CLEANUP_BOUND_MS); }
}

type GuardedRetirementResult = {
  readonly status: 'confirmed' | 'unconfirmed';
  readonly cause: string;
};

// The cleanup reader is deliberately NOT the existing-chat re-click reader.
// #2651's raw textContent===innerText retry evidence stays unchanged.
async function readRetirementComposer(
  page: any, ownedLiteral: string | undefined, deadlineMs: number,
): Promise<'empty' | 'own' | 'foreign_draft' | 'composer_unknown' | 'frozen_ownership_unproven'> {
  const budget = () => Math.min(MAX_LOCAL_READ_WAIT_MS, Math.max(1, deadlineMs - Date.now()));
  try {
    const editor = page.locator(COMPOSER_SELECTOR);
    const count = await boundedBrowserRead(Promise.resolve(editor.count()), budget(), 'retirement_editor_count_timeout');
    if (count !== 1) return 'composer_unknown';
    // Supported ProseMirror p/BR/trailingBreak is a document structure, not an
    // innerText presentation; keep intentional blank lines and every codepoint.
    let exact = await readStructuredComposerText(
      editor, Math.max(65_536, ownedLiteral?.length ?? 0), deadlineMs,
    );
    if (exact === undefined) {
      exact = await boundedBrowserRead(
        Promise.resolve(editor.evaluate((el: HTMLElement) => {
          if (!el.isConnected || !el.isContentEditable || !el.ownerDocument?.defaultView) return undefined;
          const style = el.ownerDocument.defaultView.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
            || el.getAttribute('hidden') !== null || el.getAttribute('aria-hidden') === 'true'
            || el.classList?.contains('ProseMirror')) return undefined;
          return typeof el.textContent === 'string' && el.textContent === el.innerText
            ? el.textContent : undefined;
        })),
        budget(), 'retirement_editor_fallback_timeout',
      );
    }
    if (typeof exact !== 'string') return 'composer_unknown';
    if (exact === '') return 'empty';
    return ownedLiteral && exact === ownedLiteral ? 'own' : 'foreign_draft';
  } catch {
    // A timed-out/unreadable renderer is never a synthetic empty editor.
    return 'frozen_ownership_unproven';
  }
}

/**
 * Sole guarded Page.close owner. Historical ID/URL, elapsed effect window and
 * present CDP nonresponse never waive a live readable DOM or outcome settlement.
 * A reattached proxy is permitted only for a durable previously-created pin.
 */
async function guardedOriginalTargetRetirement(input: {
  readonly outcome: TurnRunOutcome;
  readonly cdp: string;
  readonly verifiedPredecessor?: true;
}): Promise<GuardedRetirementResult> {
  const { outcome, cdp } = input;
  const refuse = (cause: string): GuardedRetirementResult => ({ status: 'unconfirmed', cause });
  const targetInfo = getOwnTargetInfo(outcome.browser);
  if (!targetInfo?.targetId || !outcome.page || !cdp
    || (!targetInfo.created && input.verifiedPredecessor !== true)
    || outcome.ownershipForfeited || cleanupAuthorityUnprovenPages.has(outcome.page)) {
    return refuse('created_target_ownership_unproven');
  }
  let observation: ReturnType<typeof readStateLightTurnObservation>;
  try {
    observation = readStateLightTurnObservation(
      outcome.result.configured_profile_key, outcome.result.invocation_id,
    );
  } catch { return refuse('observation_identity_unproven'); }
  const pin = observation.owned_target;
  if (!pin?.created || pin.id !== targetInfo.targetId
    || pin.cdp_sha256 !== createHash('sha256').update(cdp, 'utf8').digest('hex')) {
    return refuse('created_target_ownership_unproven');
  }
  const deadline = Date.now() + 18_000;
  const budget = () => Math.min(MAX_LOCAL_READ_WAIT_MS, Math.max(1, deadline - Date.now()));
  const currentUrl = (): string | null => {
    try {
      return browserOrPageDefinitelyLost(outcome.page, outcome.browser) ? null : String(outcome.page.url());
    } catch { return null; }
  };
  const eligibleRoute = (): boolean => {
    const url = currentUrl();
    if (!url) return false;
    if (observation.phase === 'harvested') {
      // A project-prefix/local suffix is not a committed conversation locator.
      return Boolean(observation.conversation_url && isSupportedChatGptConversationUrl(url)
        && normalizeConversationUrl(url) === normalizeConversationUrl(observation.conversation_url));
    }
    if (observation.phase !== 'not_sent') return false;
    if (url === 'about:blank') return true;
    if (isBlankProjectSurfaceUrl(url, pin.initial_route)) return true;
    return isSupportedChatGptConversationUrl(url)
      && normalizeConversationUrl(url) === normalizeConversationUrl(pin.initial_route);
  };

  // Outcome evidence precedes (and is independent of) idle/marker evidence.
  let row: 'not_sent' | 'harvested';
  if (observation.phase === 'not_sent'
    && observation.transition_reason === 'terminal_pre_send'
    && observation.send_count === 0 && observation.send_witness !== 'owned_marker'
    && observation.owned_marker_confirmed !== true
    && outcome.result.send_count === 0 && outcome.result.send_attempted !== true) {
    row = 'not_sent';
  } else if (observation.phase === 'harvested'
    && observation.send_count === 1 && observation.primary
    && observation.send_witness !== 'none'
    && (input.verifiedPredecessor === true || outcome.result.send_count === 1)) {
    try {
      const primary = readVerifiedStateLightHarvestedPrimary({
        profileKey: outcome.result.configured_profile_key,
        invocationId: outcome.result.invocation_id,
        marker: observation.marker, target: observation.primary.target,
      });
      if (!primary) return refuse('harvested_primary_unverified');
    } catch { return refuse('harvested_primary_unverified'); }
    row = 'harvested';
  } else if (observation.phase === 'sent_unbound'
    || observation.phase === 'sent_unharvested') {
    // A brief responsive interval with a foreign edit and then a freeze is
    // indistinguishable from continuous freeze by CDP; never physically close.
    if (await readFreshStopVisible(outcome.page, Date.now() + budget()) === null) {
      return refuse('frozen_ownership_unproven');
    }
    return refuse(observation.phase === 'sent_unbound'
      ? 'checkpoint_or_settlement_pending' : 'observation_route_only');
  } else {
    return refuse('not_sent_dispatch_unproven');
  }

  if (!eligibleRoute()) return refuse('route_changed');
  const census = async (): Promise<string | null> => {
    if (Date.now() >= deadline || !eligibleRoute()) return 'route_changed';
    try {
      const targets = await listCdpPageTargets(cdp, budget());
      const own = targets.filter((target) => target.id === pin.id && target.type === 'page');
      if (own.length !== 1) return 'target_census_failed';
      if (own[0]!.url !== currentUrl()) return 'route_changed';
      if (!targets.some((target) => target.type === 'page' && target.id !== pin.id)) return 'last_page_guard';
      return null;
    } catch { return 'target_census_failed'; }
  };
  const readableAndIdle = async (): Promise<string | null> => {
    if (!eligibleRoute()) return 'route_changed';
    const stop = await readFreshStopVisible(outcome.page, Date.now() + budget());
    if (stop === null) return 'frozen_ownership_unproven';
    if (stop) return 'stop_visible';
    let stream: number;
    try {
      stream = await boundedBrowserRead(
        Promise.resolve(outcome.page.locator(ASSISTANT_TURN_IN_PROGRESS_SELECTOR).count()),
        budget(), 'retirement_stream_count_timeout',
      );
    } catch { return 'frozen_ownership_unproven'; }
    if (!Number.isSafeInteger(stream) || stream < 0) return 'frozen_ownership_unproven';
    if (stream > 0) return 'generation_in_progress';
    let users: Awaited<ReturnType<typeof readRecoveryAuthoritativeUserMessages>>;
    try {
      users = await boundedBrowserRead(
        readRecoveryAuthoritativeUserMessages(outcome.page),
        budget(), 'retirement_users_timeout',
      );
    } catch { return 'frozen_ownership_unproven'; }
    if (users.incomplete) return 'foreign_user_message';
    const cardinality = recoveryMarkerCardinality(users.messages, observation.marker);
    if (row === 'not_sent') {
      if (users.messages.length !== 0 || cardinality.exactMarkerTokenCount !== 0) {
        return 'foreign_user_message';
      }
    } else {
      if (cardinality.matchingUserCarrierCount !== 1 || cardinality.exactMarkerTokenCount !== 1
        || users.messages.length === 0
        || !ownedPromptMatches(users.messages[users.messages.length - 1]!.text, observation.marker)) {
        return 'foreign_user_message';
      }
    }
    const beforeUrl = currentUrl();
    const draft = await readRetirementComposer(
      outcome.page, input.verifiedPredecessor ? undefined : outcome.ownedTypedPayload, deadline,
    );
    if (draft !== 'empty' && draft !== 'own') return draft;
    if (draft === 'own') {
      // A detached/reconnected owner never has the original literal. Only this
      // live invocation can clear its exact original bytes in one modifying DOM
      // evaluation with an unchanged route and unique editor.
      if (!outcome.ownedTypedPayload || !beforeUrl
        || !await conditionalClearOwnedComposerDraft(
          outcome.page, outcome.ownedTypedPayload, deadline, beforeUrl,
        )) return 'composer_unknown';
      if (await readRetirementComposer(outcome.page, undefined, deadline) !== 'empty') {
        return 'composer_unknown';
      }
    }
    if (!eligibleRoute() || currentUrl() !== beforeUrl) return 'route_changed';
    return null;
  };

  // No real close may proceed on a missing other Page, an unreadable composer,
  // an unsettled turn, a visible Stop or an unknown CDP census.
  for (let i = 0; i < 2; i++) {
    const c = await census();
    if (c) return refuse(c);
    const idle = await readableAndIdle();
    if (idle) return refuse(idle);
  }
  const last = await census();
  if (last) return refuse(last);
  if (!eligibleRoute() || Date.now() >= deadline) return refuse('route_changed');
  if (!targetInfo.created && !authorizeGuardedHistoricalTargetClose(outcome.browser, pin.id)) {
    return refuse('created_target_ownership_unproven');
  }
  const closed = await boundedResourceCleanup(
    () => outcome.page.close(),
    Math.min(RESOURCE_CLEANUP_BOUND_MS, Math.max(1, deadline - Date.now())),
  );
  if (closed !== 'confirmed') return refuse('target_still_present');
  try {
    const after = await listCdpPageTargets(cdp, budget());
    return after.every((target) => target.id !== pin.id)
      ? { status: 'confirmed', cause: 'confirmed' } : refuse('target_still_present');
  } catch {
    return refuse('target_census_failed');
  }
}

async function finalizeTurn(outcome: TurnRunOutcome, cdp = ''): Promise<CompactTurnResult> {
  let cleanup: ResourceCleanupOutcome = outcome.createdAttachFailureCleanup ?? 'skipped';
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
  const ownedPreSendFetch429Close = Boolean(
    observedNotSent && cleanupAuthorityProven && !pageLost
    && outcome.ownershipForfeited !== true
    && outcome.ownedPreSendFetch429Page === outcome.page
    && outcome.ownedPreSendFetch429Url
    && outcome.result.state === 'rate_limit'
    && outcome.result.cause === 'conversation_fetch_http_429'
    && outcome.result.send_count === 0 && outcome.result.send_attempted !== true
    && ownedPreSendFetch429ExactRoute(outcome.page, outcome.ownedPreSendFetch429Url!),
  );
  // A created Page is eligible for a fresh safety assessment even after a
  // possible Send or an unbound local terminal. Neither Send count nor a
  // cleanupAction flag grants destructive authority on its own.
  const pinnedOriginal = getOwnTargetInfo(outcome.browser);
  const positivelyCreatedOriginal = Boolean(
    pinnedOriginal?.created || outcome.createdAttachFailureCleanup || outcome.originalCreatedPage,
  );
  // A recovery successor may share the original's URL but has a different
  // Page handle/target. Never close it using the first target's provenance.
  const outcomePageIsOriginal = !outcome.originalCreatedPage
    || outcome.page === outcome.originalCreatedPage;
  // An in-flight post-Send Target crashed response is not a current idle
  // Page witness, even when Playwright still reports isClosed() === false.
  // The held, failed Page cannot be closed under stale creation authority.
  // A positively lost target may still use the independent exact-ID reattach
  // path below, which rechecks current owner, route and generation evidence.
  let pageAction: PageCleanupAction = cleanupAuthorityProven && !pageLost
    && outcome.result.cause !== 'post_send_target_crashed'
    && outcome.ownershipForfeited !== true && positivelyCreatedOriginal
    && outcomePageIsOriginal ? 'close' : 'skip';
  if (pageAction === 'close' && outcome.result.send_count === 0
    && outcome.result.send_attempted !== true && outcome.ownedFreshProjectUrl) {
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
    if (observedNotSent && !pageLost) {
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
    if (!cleared && observedNotSent) {
      // A blank verified composer needs no destructive cleanup. A changed or
      // unreadable composer cannot authorize closing a shared-draft Page.
      try {
        cleared = await safeComposerBoundary()
          && await readLosslessOwnedComposer(
            outcome.page.locator(COMPOSER_SELECTOR), Date.now() + MAX_LOCAL_READ_WAIT_MS,
          ) === ''
          && await safeComposerBoundary();
      } catch { /* Fail closed on uncertain text, Stop or URL. */ }
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
  if (pageAction === 'close' && outcome.ownedPreSendFetch429Page
    && (!ownedPreSendFetch429Close
      || !ownedPreSendFetch429ExactRoute(outcome.page, outcome.ownedPreSendFetch429Url!))) {
    pageAction = 'preserve';
  }
  if (pageAction === 'close') {
    const retirement = await guardedOriginalTargetRetirement({ outcome, cdp });
    cleanup = retirement.status === 'confirmed' ? 'confirmed' : 'unconfirmed';
    if (retirement.status !== 'confirmed') {
      incidents.push(retirement.cause);
      if (!appendIncident({
        eventClass: 'owned_tab_cleanup_unconfirmed',
        symptom: retirement.cause,
        action: retirement.cause === 'frozen_ownership_unproven'
          ? 'preserve_exact_owner_gitHub_first_reconcile_inspect_on_next_real_wake_no_close_no_resend'
          : 'retain_original_reconcile_then_reinspect_without_resend',
      }, outcome.result.invocation_id)) journalWriteFailed = true;
    }
  }
  // Recovery or an attach reconnect can replace the Playwright Page while
  // the original CDP target remains. Use only its exact reattach/guard path.
  let detachedOriginalCleanupUnconfirmed = false;
  if (outcome.originalCreatedPage && !outcome.ownershipForfeited
    && (outcome.page !== outcome.originalCreatedPage || pageLost || !pinnedOriginal?.created)) {
    const detached = await retireDetachedOriginalTarget({
      profileKey: outcome.result.configured_profile_key,
      invocationId: outcome.result.invocation_id,
      cdp, deadlineMs: Date.now() + 20_000,
    });
    cleanup = detached.status === 'confirmed' ? 'confirmed' : 'unconfirmed';
    detachedOriginalCleanupUnconfirmed = detached.status !== 'confirmed';
  }
  if (positivelyCreatedOriginal && cleanup !== 'confirmed') {
    // Never report a close from an old marker, an old Page reference or a
    // settled Playwright close promise without physical ID disappearance.
    if (cleanup === 'skipped') cleanup = 'unconfirmed';
    incidents.push('owned_tab_cleanup_unconfirmed');
    const cleanupIncident: BrowserIncident = {
      eventClass: 'owned_tab_cleanup_unconfirmed',
      symptom: 'exact_original_target_close_unconfirmed_or_refused',
      action: 'manual_exact_target_reconciliation_no_stop_no_resend',
    };
    if (!appendIncident(cleanupIncident, outcome.result.invocation_id)) journalWriteFailed = true;
  }

  // The originally created dead-local Page may now be on a disconnected
  // browser while a separate read-only recovery Page supplied the reply.
  // Re-pin its exact original CDP target rather than closing an old Page
  // reference or trusting a successful Playwright close promise.
  if (!outcome.originalCreatedPage
    && outcome.ownedDeadLocalPage && outcome.ownedDeadLocalUrl
    && outcome.ownedDeadLocalConversationUrl && outcome.ownedFreshProjectUrl
    && outcome.result.send_count === 1
    && !outcome.ownershipForfeited
    && outcome.result.conversation_id === outcome.ownedDeadLocalConversationUrl
    && outcome.page !== outcome.ownedDeadLocalPage
    && verifyStateLightFreshClaimOwnerFence(
      outcome.result.configured_profile_key,
      outcome.ownedDeadLocalConversationUrl,
      outcome.result.invocation_id,
      outcome.ownedDeadLocalTimeoutMs ?? STATE_LIGHT_MAX_TIMEOUT_MS,
    ) === 'valid') {
    const detached = await retireDetachedOriginalTarget({
      profileKey: outcome.result.configured_profile_key,
      invocationId: outcome.result.invocation_id,
      cdp, deadlineMs: Date.now() + 20_000,
    });
    cleanup = detached.status === 'confirmed' ? 'confirmed' : 'unconfirmed';
    if (detached.status !== 'confirmed') {
      detachedOriginalCleanupUnconfirmed = true;
      incidents.push('owned_tab_cleanup_unconfirmed');
      if (!appendIncident({
        eventClass: 'owned_tab_cleanup_unconfirmed',
        symptom: 'detached_original_target_not_safely_retired',
        action: 'manual_exact_target_reconciliation_no_stop_no_resend',
      }, outcome.result.invocation_id)) journalWriteFailed = true;
    }
  }

  if (outcome.profileKey && outcome.ownedConversationUrl && !outcome.ownershipForfeited) {
    releaseStateLightFreshConversationClaim(
      outcome.profileKey,
      outcome.ownedConversationUrl,
      outcome.result.invocation_id,
    );
  }
  const observedTarget = (() => {
    try {
      return readStateLightTurnObservation(
        outcome.result.configured_profile_key, outcome.result.invocation_id,
      );
    } catch { return undefined; }
  })();
  const cooldown = readStateLightAccountCooldown(outcome.result.configured_profile_key);
  await releaseCdpBrowser(outcome.browser);
  return {
    ...outcome.result,
    ...(observedTarget?.owned_target
      ? { owned_target_id: observedTarget.owned_target.id,
        owned_target_created: observedTarget.owned_target.created,
        owned_prompt_marker: observedTarget.marker }
      : outcome.createdAttachFailureTargetId
        ? { owned_target_id: outcome.createdAttachFailureTargetId,
          owned_target_created: true }
        : {}),
    ...(observedTarget?.owned_marker_confirmed ? { owned_marker_confirmed: true as const } : {}),
    ...(observedTarget ? { send_witness: observedTarget.send_witness } : {}),
    ...(outcome.result.cooldown_until_ms !== undefined
      ? { cooldown_until_ms: outcome.result.cooldown_until_ms }
      : cooldown.active && cooldown.until !== undefined ? { cooldown_until_ms: cooldown.until } : {}),
    ...((positivelyCreatedOriginal || detachedOriginalCleanupUnconfirmed) && cleanup !== 'confirmed'
      ? { cleanup_status: 'cleanup_unconfirmed' as const } : {}),
    cleanup,
    incidents,
    ...(retirementCleanupRequired ? { retirement_cleanup_required: true } : {}),
    ...(journalWriteFailed ? { journal_write_failed: true } : {}),
  };
}

export const __testFinalizeTurn = finalizeTurn;
export const __testBrowserOrPageDefinitelyLost = browserOrPageDefinitelyLost;
export const __testWaitForExistingGeneration = waitForExistingGeneration;
export const __testConversationPageSelection = {
  selectConversationPage,
  // Only a test affordance: mark an already-supplied Page as pre-existing so
  // cleanup tests can assert the no-close boundary without importing it by CDP.
  markSelectedPageUnowned(page: object): void { cleanupAuthorityUnprovenPages.add(page); },
};

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
  readLosslessOwnedComposer,
  composerPayloadMatchesBeforeSend,
  conditionalClearOwnedComposerDraft,
  observeExistingServerCheckedRecovery,
};

export type StateLightTurnDependencies = {
  readonly runTurn?: (args: ParsedTurnArgs) => Promise<TurnRunOutcome>;
  readonly recoveryHooks?: StateLightRecoveryHooks;
  readonly entryLivenessHeartbeat?: boolean;
};

// The launcher promotes every turn-result conversation_id into a recoverable
// locator. For fresh chats, the page URL is only a candidate: admission needs
// this invocation's durable exact-project conversation binding and live claim.
// Apply this to every fresh return path, including thrown errors, without
// changing existing-chat result semantics or the launcher schema.
function admitFreshResultConversationId(
  args: ParsedTurnArgs,
  outcome: TurnRunOutcome,
): TurnRunOutcome {
  if (!hasFlag(args, 'new-chat')) return outcome;
  let ownedUrl: string | undefined;
  try {
    const profileKey = outcome.result.configured_profile_key;
    const invocationId = outcome.result.invocation_id;
    const projectUrl = stringOption(args, 'project-url') ?? '';
    const record = readStateLightTurnObservation(profileKey, invocationId);
    const candidate = record.conversation_url;
    const timeoutMs = stringOption(args, 'timeout-ms')
      ? Number(stringOption(args, 'timeout-ms'))
      : DEFAULT_TIMEOUT_MS;
    if (!outcome.ownershipForfeited
      && outcome.result.send_count === 1
      && record.send_count === 1
      && (record.phase === 'sent_unharvested' || record.phase === 'harvested')
      && candidate
      && projectConversationUrlMatchesProject(candidate, projectUrl)
      && verifyStateLightFreshClaimOwnerFence(profileKey, candidate, invocationId, timeoutMs) === 'valid') {
      ownedUrl = candidate;
    }
  } catch {
    // Missing, unreadable, expired or mismatched authority is never a locator.
  }
  return {
    ...outcome,
    result: { ...outcome.result, conversation_id: ownedUrl },
  };
}

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
      // A numeric Send witness after a same-chat one-goto recovery already
      // proves a Send was attempted. Populate the existing optional v1 field
      // without changing any dispatch/retry or post-Send decision authority.
      ...(!hasFlag(args, 'new-chat') && outcome.result.goto_count === 1
        && outcome.result.send_count === 1 ? {
          result: { ...outcome.result, send_attempted: true },
        } : {}),
      ...(freshCleanup.page && outcome.page === freshCleanup.page && freshCleanup.markedPayload
        ? { ownedTypedPayload: freshCleanup.markedPayload } : {}),
      ...(freshCleanup.page
        && (outcome.page === freshCleanup.page || freshCleanup.ownedDeadLocalPage)
        && freshCleanup.projectUrl
        ? { ownedFreshProjectUrl: freshCleanup.projectUrl } : {}),
    };
    const result = await finalizeTurn(admitFreshResultConversationId(args, {
      ...augmented,
      ...(freshCleanup.originalCreatedPage ? { originalCreatedPage: freshCleanup.originalCreatedPage } : {}),
      ...(freshCleanup.ownedDeadLocalPage ? {
        ownedDeadLocalPage: freshCleanup.ownedDeadLocalPage,
        ownedDeadLocalUrl: freshCleanup.ownedDeadLocalUrl,
        ownedDeadLocalConversationUrl: freshCleanup.ownedDeadLocalConversationUrl,
        ownedDeadLocalTimeoutMs: freshCleanup.ownedDeadLocalTimeoutMs,
      } : {}),
    }), stringOption(args, 'cdp') ?? '');
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