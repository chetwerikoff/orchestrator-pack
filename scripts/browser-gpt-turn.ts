#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  boundedResourceCleanup,
  releaseCdpBrowser,
  RESOURCE_CLEANUP_BOUND_MS,
  type ResourceCleanupOutcome,
} from './chatgpt-browser-turn/browser-session.ts';
import { destinationIdentity } from './chatgpt-browser-turn/coordination.ts';
import {
  controlExitCode,
  publicationExitCode,
  turnExitCode,
  type FailureScope,
  type PublicationStatusV1,
  type TurnResultV1,
  type TurnState,
} from './chatgpt-browser-turn/contracts.ts';
import { readStableInput } from './chatgpt-browser-turn/input.ts';
import { publicationStatus, publishReply } from './chatgpt-browser-turn/publication.ts';
import { configuredProfileKey } from './chatgpt-browser-turn/storage-common.ts';
import {
  classifyProductWall,
  loadChromium,
  normalizeConversationUrl,
  productStatusText,
  verifyProfile,
  type BrowserConfig,
} from './chatgpt-browser-turn/ui-adapter.ts';

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

interface ParsedArgs {
  readonly command: string;
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

const BOOLEAN_OPTIONS = new Set(['new-chat']);

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0] ?? '';
  const options = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (!token?.startsWith('--') || token.length <= 2) throw new Error('argument_invalid');
    const key = token.slice(2);
    if (options.has(key)) throw new Error('argument_duplicate');
    if (BOOLEAN_OPTIONS.has(key)) {
      options.set(key, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('argument_value_missing');
    options.set(key, value);
    index++;
  }
  return { command, options };
}

function option(args: ParsedArgs, key: string): string | undefined {
  const value = args.options.get(key);
  return typeof value === 'string' ? value : undefined;
}

function required(args: ParsedArgs, key: string): string {
  const value = option(args, key);
  if (!value) throw new Error(`argument_required:${key}`);
  return value;
}

function flag(args: ParsedArgs, key: string): boolean {
  return args.options.get(key) === true;
}

function assertAllowedOptions(args: ParsedArgs, allowed: readonly string[]): void {
  const set = new Set(allowed);
  for (const key of args.options.keys()) {
    if (!set.has(key)) throw new Error(`argument_unknown:${key}`);
  }
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

  const ownUserIndex = users[0]!.index;
  const afterOwnUser = novel.slice(ownUserIndex + 1);
  if (afterOwnUser.some((message) => message.role === 'user')) {
    return { state: 'foreign_activity', cause: 'foreign_user_after_owned_send' };
  }

  const assistants = afterOwnUser.filter((message) => message.role === 'assistant');
  if (generating || assistants.length === 0) return { state: 'waiting' };
  const finalReply = normalizeVisibleText(assistants.at(-1)?.text ?? '');
  return finalReply ? { state: 'ready', reply: finalReply } : { state: 'waiting' };
}

function browserConfig(args: ParsedArgs): BrowserConfig & { pollMs: number } {
  const cdp = required(args, 'cdp');
  const profile = required(args, 'profile');
  const newChat = flag(args, 'new-chat');
  const chatUrl = option(args, 'chat-url');
  const projectUrl = option(args, 'project-url');
  if (newChat === Boolean(chatUrl)) throw new Error('argument_mode_invalid');
  if (newChat && !projectUrl) throw new Error('argument_required:project-url');
  const timeoutMs = option(args, 'timeout-ms') ? parseInteger(required(args, 'timeout-ms'), 1) : DEFAULT_TIMEOUT_MS;
  const pollMs = option(args, 'poll-ms') ? parseInteger(required(args, 'poll-ms'), 1) : DEFAULT_POLL_MS;
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

async function waitForComposer(page: any, deadline: number): Promise<{ state: 'ready' } | { state: TurnState; cause: string }> {
  const composer = page.locator('#prompt-textarea');
  while (Date.now() < deadline) {
    const wall = classifyProductWall(await productStatusText(page, Math.min(MAX_LOCAL_READ_WAIT_MS, Math.max(1, deadline - Date.now()))));
    if (wall.state) return { state: wall.state, cause: wall.cause ?? `${wall.state}_detected` };
    if (await locatorCount(composer) > 0) return { state: 'ready' };
    await sleep(page, Math.min(INITIAL_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return { state: 'ui_contract_mismatch', cause: 'composer_unavailable' };
}

async function openDedicatedTurnPage(browser: any, config: BrowserConfig): Promise<any> {
  const contexts = browser.contexts();
  if (contexts.length !== 1) throw new Error('ui_contract_mismatch:context_count');
  const page = await contexts[0].newPage();
  const target = config.newChat ? config.projectUrl : config.chatUrl;
  if (!target) throw new Error('ui_contract_mismatch:target_required');
  await page.goto(target, {
    waitUntil: 'domcontentloaded',
    timeout: Math.min(MAX_LOCAL_READ_WAIT_MS * 6, config.timeoutMs),
  });
  if (!config.newChat && normalizeConversationUrl(page.url()) !== normalizeConversationUrl(target)) {
    throw new Error('ui_contract_mismatch:conversation_redirect');
  }
  return page;
}

function pageConversationUrl(page: any): string | undefined {
  try {
    const url = normalizeConversationUrl(String(page.url()));
    return url.includes('/c/') ? url : undefined;
  } catch {
    return undefined;
  }
}

async function runTurn(args: ParsedArgs): Promise<TurnRunOutcome> {
  assertAllowedOptions(args, [
    'profile', 'cdp', 'input', 'output', 'chat-url', 'new-chat', 'project-url', 'timeout-ms', 'poll-ms',
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
    const snapshot = readStableInput(required(args, 'input'));
    const destination = destinationIdentity(required(args, 'output'));

    const profile = await verifyProfile(config);
    if (profile.state !== 'verified') {
      const state: TurnState = profile.state === 'unavailable' ? 'chrome_not_running' : 'profile_mismatch';
      incident('invocation_blocker', profile.cause, 'return_local_error');
      return {
        result: compactResult(state, 'invocation', profile.cause, invocationId, profileKey, sendCount, pollCount, incidents, {}, journalWriteFailed),
      };
    }

    const chromium = loadChromium();
    browser = await chromium.connectOverCDP(config.cdp, { timeout: Math.min(30_000, config.timeoutMs) });
    page = await openDedicatedTurnPage(browser, config);

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
      incident(afterSend ? 'helper_failure_after_send' : 'helper_failure_before_send', cause, afterSend ? 'caller_may_open_fresh_chat' : 'return_local_error');
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

function advisoryControl(args: ParsedArgs): number {
  const profile = required(args, 'profile');
  const cdp = required(args, 'cdp');
  const profileKey = configuredProfileKey(profile, cdp);
  if (args.command === 'publication-status') {
    const invocation = required(args, 'invocation');
    const status: PublicationStatusV1 = publicationStatus(profileKey, invocation);
    emit(status);
    return publicationExitCode(status.state);
  }
  if (args.command === 'clear') {
    emit({
      schema: 'control-result/v1',
      operation: 'clear',
      state: 'not_found',
      configured_profile_key: profileKey,
      cause: 'legacy_control_non_authoritative',
    });
    return 0;
  }
  if (args.command === 'capability') {
    emit({
      schema: 'control-result/v1',
      operation: 'capability',
      state: 'ok',
      configured_profile_key: profileKey,
      cause: 'legacy_control_non_authoritative',
    });
    return 0;
  }
  emit({
    schema: 'control-result/v1',
    operation: 'status/list',
    state: 'none',
    configured_profile_key: profileKey,
    cause: 'legacy_control_non_authoritative',
    items: [],
  });
  return controlExitCode('none');
}

export async function runCli(argv: readonly string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch {
    emit({
      schema: 'control-result/v1',
      operation: 'status/list',
      state: 'driver_error',
      configured_profile_key: 'profile-unresolved',
      cause: 'argument_invalid',
    });
    return 22;
  }

  try {
    if (args.command === 'turn') {
      const result = await finalizeTurn(await runTurn(args));
      emit(result);
      return turnExitCode(result.state);
    }
    if (['status/list', 'clear', 'capability', 'gate-b-characterization', 'publication-status'].includes(args.command)) {
      return advisoryControl(args);
    }
    emit({
      schema: 'control-result/v1',
      operation: 'status/list',
      state: 'driver_error',
      configured_profile_key: 'profile-unresolved',
      cause: 'command_invalid',
    });
    return 22;
  } catch (error) {
    emit({
      schema: 'control-result/v1',
      operation: 'status/list',
      state: 'driver_error',
      configured_profile_key: 'profile-unresolved',
      cause: error instanceof Error ? error.message : 'command_failed',
    });
    return 22;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
