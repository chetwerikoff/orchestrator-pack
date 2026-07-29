import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { publishReply } from './publication.ts';
import { configuredProfileKey } from './storage-common.ts';
import {
  classifyProductWall,
  loadChromium,
  normalizeConversationUrl,
  productStatusText,
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
  readonly cleanup: ResourceCleanupOutcome;
  readonly incidents: readonly string[];
  readonly journal_write_failed?: boolean;
}

interface TurnRunOutcome {
  readonly result: Omit<CompactTurnResult, 'cleanup'>;
  readonly page?: any;
  readonly browser?: any;
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

export function classifyPageObservation(
  messages: readonly PageMessage[],
  baselineCount: number,
  prompt: string,
  generating: boolean,
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
  if (generating || assistants.length === 0) return { state: 'waiting' };
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
    incidents: incidents.map((incident) => incident.eventClass),
    ...(journalWriteFailed ? { journal_write_failed: true } : {}),
    ...extra,
  };
}

function appendIncident(
  incident: BrowserIncident,
  invocationId: string,
  env: NodeJS.ProcessEnv = process.env,
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
): boolean {
  incidents.push(incident);
  return appendIncident(incident, invocationId);
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

async function pageGenerating(page: any): Promise<boolean> {
  try {
    if (await locatorCount(page.locator('[data-testid="stop-button"], button[aria-label*="Stop"]').first()) > 0) return true;
  } catch {
    // Fall through to assistant-local signals.
  }
  const assistants = page.locator('[data-message-author-role="assistant"]');
  const count = await locatorCount(assistants);
  if (count === 0) return false;
  const last = assistants.nth(count - 1);
  try {
    if ((await last.getAttribute('data-is-streaming', { timeout: MAX_LOCAL_READ_WAIT_MS })) === 'true') return true;
    if ((await last.getAttribute('aria-busy', { timeout: MAX_LOCAL_READ_WAIT_MS })) === 'true') return true;
  } catch {
    return true;
  }
  try {
    return await locatorCount(page.getByText(/continue generating/i)) > 0;
  } catch {
    return false;
  }
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

async function navigateOwnedTurnPage(page: any, config: BrowserConfig): Promise<void> {
  const target = config.newChat ? config.projectUrl : config.chatUrl;
  if (!target) throw new Error('ui_contract_mismatch:target_required');
  await page.goto(target, {
    waitUntil: 'domcontentloaded',
    timeout: Math.min(MAX_LOCAL_READ_WAIT_MS * 6, config.timeoutMs),
  });
  if (!config.newChat && normalizeConversationUrl(page.url()) !== normalizeConversationUrl(target)) {
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
  let journalWriteFailed = false;
  const incidents: BrowserIncident[] = [];
  let afterSend = false;

  const incident = (eventClass: string, symptom: string, action?: string): void => {
    const ok = recordIncident(incidents, { eventClass, symptom, ...(action ? { action } : {}) }, invocationId);
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
          pollCount,
          incidents,
          {},
          journalWriteFailed,
        ),
      };
    }

    const chromium = loadChromium();
    browser = await chromium.connectOverCDP(config.cdp, { timeout: Math.min(30_000, config.timeoutMs) });
    page = await createDedicatedTurnPage(browser);
    await navigateOwnedTurnPage(page, config);

    const composerDeadline = Date.now() + Math.min(30_000, config.timeoutMs);
    const composerState = await waitForComposer(page, composerDeadline);
    if (composerState.state !== 'ready') {
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
          pollCount,
          incidents,
          {},
          journalWriteFailed,
        ),
      };
    }

    const baselineCount = (await readPageMessages(page)).length;
    const composer = page.locator('#prompt-textarea');
    await composer.click({ timeout: MAX_LOCAL_READ_WAIT_MS });
    await composer.fill(snapshot.text, { timeout: MAX_LOCAL_READ_WAIT_MS });
    const sendButton = page.locator('[data-testid="send-button"]');

    if (await locatorCount(sendButton) > 0) {
      await sendButton.click({ timeout: MAX_LOCAL_READ_WAIT_MS });
    } else {
      await composer.press('Enter', { timeout: MAX_LOCAL_READ_WAIT_MS });
    }
    sendCount = 1;
    afterSend = true;

    const startedAt = Date.now();
    const deadline = startedAt + config.timeoutMs;
    const dispatchDeadline = startedAt + Math.min(DISPATCH_OBSERVATION_MS, config.timeoutMs);
    let lastReadyReply = '';
    let stableReads = 0;

    while (Date.now() < deadline) {
      pollCount++;
      const messages = await readPageMessages(page);
      const generating = await pageGenerating(page);
      const decision = classifyPageObservation(messages, baselineCount, snapshot.text, generating);

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
            pollCount,
            incidents,
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
          const publication = publishReply(
            profileKey,
            invocationId,
            destination.finalPath,
            destination.identity,
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
                pollCount,
                incidents,
                { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
                journalWriteFailed,
              ),
            };
          }
          return {
            page,
            browser,
            result: compactResult(
              'ok',
              'none',
              'completed_page_only',
              invocationId,
              profileKey,
              sendCount,
              pollCount,
              incidents,
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
        await sleep(page, Math.min(STABILITY_READ_DELAY_MS, Math.max(1, deadline - Date.now())));
        continue;
      }

      stableReads = 0;
      lastReadyReply = '';
      if (await maybeContinueGeneration(page)) {
        await sleep(page, Math.min(INITIAL_POLL_MS, Math.max(1, deadline - Date.now())));
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
              pollCount,
              incidents,
              { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
              journalWriteFailed,
            ),
          };
        }
      }

      const elapsed = Date.now() - startedAt;
      const delay = elapsed < DISPATCH_OBSERVATION_MS ? INITIAL_POLL_MS : config.pollMs;
      await sleep(page, Math.min(delay, Math.max(1, deadline - Date.now())));
    }

    incident('turn_timeout', 'page_reply_not_complete_before_timeout', 'caller_may_open_fresh_chat');
    return {
      page,
      browser,
      result: compactResult(
        'stream_timeout',
        'invocation',
        'page_reply_not_complete_before_timeout',
        invocationId,
        profileKey,
        sendCount,
        pollCount,
        incidents,
        { ...(pageConversationUrl(page) ? { conversation_id: pageConversationUrl(page) } : {}) },
        journalWriteFailed,
      ),
    };
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
    const cause = afterSend ? 'helper_or_page_error_after_send' : message;
    if (!isInput && !isOutput) {
      incident(
        afterSend ? 'helper_failure_after_send' : 'helper_failure_before_send',
        cause,
        afterSend ? 'caller_may_open_fresh_chat' : 'return_local_error',
      );
    }
    return {
      ...(page ? { page } : {}),
      ...(browser ? { browser } : {}),
      result: compactResult(
        state,
        'invocation',
        cause,
        invocationId,
        profileKey,
        sendCount,
        pollCount,
        incidents,
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
  if (outcome.page) {
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
      cleanup: 'skipped',
      incidents: [],
    });
    return 22;
  }

  const result = await finalizeTurn(await runTurn(args));
  emit(result);
  return turnExitCode(result.state);
}
