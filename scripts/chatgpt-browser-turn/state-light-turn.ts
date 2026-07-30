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
  prepareStateLightFreshConversation,
  projectConversationPrefix,
  readStateLightAdvisoryWall,
  recordStateLightAdvisoryWall,
  releaseStateLightFreshConversationClaim,
  releaseStateLightNewChatSendSlot,
  StateLightNavigationCounter,
  STATE_LIGHT_FRESH_RECOVERY_ATTEMPTS,
  tryClaimStateLightFreshConversation,
  waitForConversationUrlAfterSend,
} from './state-light-fresh-conversation.ts';
import { configuredProfileKey } from './storage-common.ts';
import {
  classifyProductWall,
  loadChromium,
  normalizeConversationUrl,
  productStatusText,
  readAssistantTurnCompletionReady,
  verifyProfile,
  type BrowserConfig,
} from './ui-adapter.ts';

const DEFAULT_TIMEOUT_MS = 1_800_000;
const DEFAULT_POLL_MS = 300_000;
const INITIAL_POLL_MS = 500;
const DISPATCH_OBSERVATION_MS = 30_000;
const STABILITY_READ_DELAY_MS = 1_000;
const MAX_LOCAL_READ_WAIT_MS = 5_000;
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
  readonly state: 'waiting' | 'ready' | 'foreign_activity';
  readonly reply?: string;
  readonly cause?: string;
}

interface BrowserIncident {
  readonly eventClass: string;
  readonly symptom: string;
  readonly action?: string;
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

function normalizeVisibleText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\t ]+/g, ' ').trim();
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

export function classifyPageObservation(
  messages: readonly PageMessage[],
  baselineCount: number,
  prompt: string,
  inProgress: boolean,
): PageObservationDecision {
  const novel = messages.slice(Math.max(0, baselineCount));
  const promptText = normalizeVisibleText(prompt);
  const users = novel
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'user');

  if (users.length === 0) return { state: 'waiting' };
  if (users.length !== 1 || normalizeVisibleText(users[0]!.message.text) !== promptText) {
    return { state: 'foreign_activity', cause: 'foreign_or_ambiguous_user_activity' };
  }

  const afterOwnUser = novel.slice(users[0]!.index + 1);
  if (afterOwnUser.some((message) => message.role === 'user')) {
    return { state: 'foreign_activity', cause: 'foreign_user_after_owned_send' };
  }

  const assistants = afterOwnUser.filter((message) => message.role === 'assistant');
  if (inProgress || assistants.length === 0) return { state: 'waiting' };
  const finalReply = normalizeVisibleText(assistants.at(-1)?.text ?? '');
  return finalReply ? { state: 'ready', reply: finalReply } : { state: 'waiting' };
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

async function locatorText(locator: any): Promise<string> {
  try {
    return normalizeVisibleText(String(await locator.innerText({ timeout: MAX_LOCAL_READ_WAIT_MS })));
  } catch {
    try {
      return normalizeVisibleText(String(await locator.textContent({ timeout: MAX_LOCAL_READ_WAIT_MS }) ?? ''));
    } catch {
      return '';
    }
  }
}

async function readPageMessages(page: any): Promise<PageMessage[]> {
  const nodes = page.locator('[data-message-author-role]');
  const count = await locatorCount(nodes);
  const messages: PageMessage[] = [];
  for (let index = 0; index < count; index++) {
    const node = nodes.nth(index);
    let role = '';
    try {
      role = String(await node.getAttribute('data-message-author-role', { timeout: MAX_LOCAL_READ_WAIT_MS }) ?? '');
    } catch {
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue;
    messages.push({ role, text: await locatorText(node) });
  }
  return messages;
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
  const composer = page.locator('#prompt-textarea');
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

async function readPostSendObservation(page: any): Promise<{
  readonly messages: PageMessage[];
  readonly wall: ReturnType<typeof classifyProductWall>;
  readonly completionReady: boolean;
}> {
  const messages = await readPageMessages(page);
  const wall = classifyProductWall(await productStatusText(page, MAX_LOCAL_READ_WAIT_MS));
  const completionReady = await readAssistantTurnCompletionReady(page, MAX_LOCAL_READ_WAIT_MS);
  return { messages, wall, completionReady };
}

async function maybeContinueGeneration(page: any): Promise<boolean> {
  try {
    const continuation = page.getByText(/continue generating/i);
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
  const composer = page.locator('#prompt-textarea');
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
  if (!config.newChat && normalizeConversationUrl(page.url()) !== target) {
    throw new Error('ui_contract_mismatch:conversation_redirect');
  }
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

    const sendOwnedPrompt = async (): Promise<void> => {
      const composer = page.locator('#prompt-textarea');
      await composer.click({ timeout: MAX_LOCAL_READ_WAIT_MS });
      await composer.fill(snapshot.text, { timeout: MAX_LOCAL_READ_WAIT_MS });
      const sendButton = page.locator('[data-testid="send-button"]');
      if (await locatorCount(sendButton) > 0) {
        await sendButton.click({ timeout: MAX_LOCAL_READ_WAIT_MS });
      } else {
        await composer.press('Enter', { timeout: MAX_LOCAL_READ_WAIT_MS });
      }
      sendCount += 1;
      afterSend = true;
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
            baselineCount = (await readPageMessages(page)).length;
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

      baselineCount = (await readPageMessages(page)).length;
      await sendOwnedPrompt();
    }

    const startedAt = Date.now();
    const softDeadline = startedAt + config.timeoutMs;
    const dispatchDeadline = startedAt + Math.min(DISPATCH_OBSERVATION_MS, config.timeoutMs);
    let lastReadyReply = '';
    let stableReads = 0;

    // `timeout-ms` is a soft post-send observation threshold. Once a prompt has
    // landed and this invocation still owns a reachable page, #1120 requires us
    // to keep that page rather than manufacture lost-chat/resend eligibility.
    while (true) {
      pollCount++;
      let observation: Awaited<ReturnType<typeof readPostSendObservation>>;
      try {
        observation = await readPostSendObservation(page);
      } catch (error) {
        if (browserOrPageDefinitelyLost(page, browser)) throw error;
        const symptom = error instanceof Error ? error.message : String(error);
        incident('post_send_observation_error', symptom, 'continue_polling_owned_page');
        stableReads = 0;
        lastReadyReply = '';
        await sleep(page, INITIAL_POLL_MS);
        continue;
      }

      const { messages, wall, completionReady } = observation;
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

      const decision = classifyPageObservation(messages, baselineCount, snapshot.text, !completionReady);

      if (decision.state === 'foreign_activity') {
        incident('foreign_activity', decision.cause ?? 'foreign_activity', 'return_local_degraded');
        return {
          page,
          browser,
          result: compactResult(
            'foreign_activity',
            'invocation',
            decision.cause ?? 'foreign_activity',
            invocationId,
            profileKey,
            sendCount,
            pollCount, navigation, incidents,
            { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
            journalWriteFailed,
          ),
        };
      }

      if (decision.state === 'ready' && decision.reply) {
        if (decision.reply === lastReadyReply) stableReads++;
        else {
          lastReadyReply = decision.reply;
          stableReads = 1;
        }
        if (stableReads >= 2) {
          const publication = publishStateLightReply(
            destination.finalPath,
            invocationId,
            decision.reply,
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
        await sleep(page, STABILITY_READ_DELAY_MS);
        continue;
      }

      stableReads = 0;
      lastReadyReply = '';
      if (await maybeContinueGeneration(page)) {
        await sleep(page, INITIAL_POLL_MS);
        continue;
      }

      if (Date.now() >= dispatchDeadline) {
        const novel = messages.slice(Math.max(0, baselineCount));
        if (!novel.some((message) => message.role === 'user')) {
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

      if (Date.now() >= softDeadline && decision.state === 'waiting') {
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
            pollCount, navigation, incidents,
            { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
            journalWriteFailed,
          ),
        };
      }

      const elapsed = Date.now() - startedAt;
      const delay = elapsed < DISPATCH_OBSERVATION_MS ? INITIAL_POLL_MS : config.pollMs;
      const beforeSoftDeadline = Date.now() < softDeadline;
      await sleep(page, beforeSoftDeadline
        ? Math.min(delay, Math.max(1, softDeadline - Date.now()))
        : config.pollMs);
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
  if (!outcome.preserveOwnedPage) await releaseCdpBrowser(outcome.browser);
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
