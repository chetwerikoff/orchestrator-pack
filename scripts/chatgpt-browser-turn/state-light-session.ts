import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { destinationIdentity } from './coordination.ts';
import {
  boundedResourceCleanup,
  releaseCdpBrowser,
  RESOURCE_CLEANUP_BOUND_MS,
  type ResourceCleanupOutcome,
} from './browser-session.ts';
import {
  turnExitCode,
  type FailureScope,
  type TurnResultV1,
  type TurnState,
} from './contracts.ts';
import { readStableInput, type InputSnapshot } from './input.ts';
import {
  generateOwnedPromptMarker,
  ownedPromptMarkerMatches,
  wrapOwnedPromptPayload,
} from './owned-prompt-marker.ts';
import {
  STATE_LIGHT_MAX_TIMEOUT_MS,
  StateLightNavigationCounter,
  acquireStateLightNewChatSendSlot,
  conversationUuidFromUrl,
  ownedConversationIdentityMatches,
  prepareStateLightFreshConversation,
  projectConversationPrefix,
  releaseStateLightNewChatSendSlot,
} from './state-light-fresh-conversation.ts';
import { configuredProfileKey } from './storage-common.ts';
import {
  __testComposerMutation,
  buildObservationHeartbeat,
  classifyPageObservation,
  compactResult,
  MAX_LOCAL_READ_WAIT_MS,
  OBSERVATION_HEARTBEAT_MS,
  ownedPromptMatches,
  POST_SEND_OBSERVATION_POLL_MS,
  readPageObservation,
  replyStabilityMatches,
  type CompactTurnResult,
  type PageObservationDecision,
  type PageObservationResult,
} from './state-light-turn.ts';
import {
  classifyProductWall,
  COMPOSER_SELECTOR,
  createTurnOperationBudget,
  loadChromium,
  locateContinueGeneratingControl,
  normalizeConversationUrl,
  productStatusText,
  SEND_BUTTON_SELECTOR,
  verifyProfile,
  type BrowserConfig,
  type ProfileVerification,
  type TurnOperationBudget,
} from './ui-adapter.ts';

const MAX_SESSION_PAYLOADS = 32;
const MAX_SESSION_INPUT_BYTES = 8_388_608;
const DEFAULT_SESSION_POLL_MS = POST_SEND_OBSERVATION_POLL_MS;
const HEARTBEAT_POLL_INTERVAL = 2;

export const STATE_LIGHT_SESSION_HELP = `Usage:
  state-light-entry.ts session --profile <path> --cdp <url> (--chat-url <url> | --new-chat --project-url <url>) --timeout-ms <ms> [--poll-ms <ms>] --input <path> --output <path> [--input <path> --output <path> ...]

Session mode accepts 1-32 ordered input/output pairs, snapshots all inputs before browser setup, uses one owned tab and one whole-session deadline, and emits progressive session-payload/v1 records followed by session-result/v1. Ordinary turn mode is unchanged.`;

export type SessionDeliveryState = 'delivered' | 'not_sent' | 'delivery_unknown' | 'not_attempted';
export type SessionPayloadPhase = 'dispatch-latched' | 'delivery-bound' | 'terminal';

export interface SessionDigest {
  readonly byte_length: number;
  readonly sha256: string;
}

export interface SessionPayloadRecord {
  readonly schema: 'session-payload/v1';
  readonly ordinal: number;
  readonly input: SessionDigest;
  readonly phase: SessionPayloadPhase;
  readonly send_count: 0 | 1;
  readonly delivery_state: SessionDeliveryState;
  readonly expected_marker?: string;
  readonly marker_match_count?: number;
  readonly conversation_id?: string;
  readonly state?: TurnState;
  readonly scope?: FailureScope;
  readonly cause?: string;
  readonly output?: SessionDigest;
}

export interface SessionPayloadSummary {
  readonly ordinal: number;
  readonly input: SessionDigest;
  readonly latest_phase: SessionPayloadPhase;
  readonly delivery_state: SessionDeliveryState;
  readonly send_count: 0 | 1;
  readonly expected_marker?: string;
  readonly state?: TurnState;
  readonly scope?: FailureScope;
  readonly cause?: string;
  readonly output?: SessionDigest;
}

export interface SessionResultV1 {
  readonly schema: 'session-result/v1';
  readonly payload_count: number;
  readonly attempted_payload_count: number;
  readonly total_send_count: number;
  readonly conversation_id?: string;
  readonly terminal_stop_ordinal: number | null;
  readonly decisive_payload_ordinal: number | null;
  readonly state: TurnState;
  readonly scope: FailureScope;
  readonly cause: string;
  readonly exit_code: number;
  readonly cleanup: ResourceCleanupOutcome;
  readonly owned_tab_count: 0 | 1;
  readonly goto_count: number;
  readonly new_chat_click_count: number;
  readonly navigation_count: number;
  readonly payloads: readonly SessionPayloadSummary[];
}

interface SessionManifestItem {
  readonly ordinal: number;
  readonly snapshot: InputSnapshot;
  readonly input: SessionDigest;
  readonly outputPath: string;
  readonly outputIdentity: string;
}

interface ParsedSessionConfig {
  readonly browser: BrowserConfig;
  readonly pollMs: number;
  readonly manifest: readonly SessionManifestItem[];
}

interface SessionTerminalTuple {
  readonly state: TurnState;
  readonly scope: FailureScope;
  readonly cause: string;
}

interface MutablePayloadState {
  readonly item: SessionManifestItem;
  sendCount: 0 | 1;
  deliveryState: SessionDeliveryState;
  expectedMarker?: string;
  markerMatchCount?: number;
  conversationId?: string;
  output?: SessionDigest;
  terminal?: SessionTerminalTuple;
  latestWrittenRecord?: SessionPayloadRecord;
  terminalWritten: boolean;
}

interface SessionExecutionState {
  readonly invocationId: string;
  readonly config: ParsedSessionConfig;
  readonly payloads: MutablePayloadState[];
  readonly navigation: StateLightNavigationCounter;
  readonly writer: SessionStdoutWriter;
  readonly wholeSessionDeadline: number;
  browser?: any;
  page?: any;
  conversationId?: string;
  decisiveOrdinal?: number;
  stopped: boolean;
}

export interface SessionWritable {
  readonly destroyed?: boolean;
  readonly writable?: boolean;
  readonly writableEnded?: boolean;
  readonly writableNeedDrain?: boolean;
  write(chunk: string): boolean;
  once?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  destroy?(error?: Error): unknown;
}

export interface StateLightSessionDependencies {
  readonly now: () => number;
  readonly uuid: () => string;
  readonly readInput: typeof readStableInput;
  readonly resolveDestination: typeof destinationIdentity;
  readonly profileKey: typeof configuredProfileKey;
  readonly verifyProfile: (
    config: BrowserConfig,
    segmentBudget?: TurnOperationBudget,
  ) => Promise<ProfileVerification>;
  readonly prepareFresh: typeof prepareStateLightFreshConversation;
  readonly loadChromium: typeof loadChromium;
  readonly marker: typeof generateOwnedPromptMarker;
  readonly wrapPayload: typeof wrapOwnedPromptPayload;
  readonly waitForComposer: typeof __testComposerMutation.waitForComposer;
  readonly mutateComposer: typeof __testComposerMutation.mutateComposerOrCause;
  readonly readComposerReady: typeof __testComposerMutation.readComposerReadiness;
  readonly readObservation: typeof readPageObservation;
  readonly classifyObservation: typeof classifyPageObservation;
  readonly replyStable: typeof replyStabilityMatches;
  readonly publishReply: (outputPath: string, invocationId: string, reply: string) => PublicationResult;
  readonly cleanup: typeof boundedResourceCleanup;
  readonly releaseBrowser: typeof releaseCdpBrowser;
  readonly stdout: SessionWritable;
  readonly sleep: (page: any, ms: number) => Promise<void>;
}

interface PublicationResult {
  readonly state: 'committed_ok' | 'conflict' | 'error';
  readonly cause?: string;
  readonly output?: SessionDigest;
}

const defaultDependencies: StateLightSessionDependencies = {
  now: Date.now,
  uuid: randomUUID,
  readInput: readStableInput,
  resolveDestination: destinationIdentity,
  profileKey: configuredProfileKey,
  verifyProfile,
  prepareFresh: prepareStateLightFreshConversation,
  loadChromium,
  marker: generateOwnedPromptMarker,
  wrapPayload: wrapOwnedPromptPayload,
  waitForComposer: __testComposerMutation.waitForComposer,
  mutateComposer: __testComposerMutation.mutateComposerOrCause,
  readComposerReady: __testComposerMutation.readComposerReadiness,
  readObservation: readPageObservation,
  classifyObservation: classifyPageObservation,
  replyStable: replyStabilityMatches,
  publishReply: publishSessionReply,
  cleanup: boundedResourceCleanup,
  releaseBrowser: releaseCdpBrowser,
  stdout: process.stdout as Writable,
  sleep: async (page: any, ms: number): Promise<void> => {
    if (ms <= 0) return;
    if ((page as { __fakeBrowserGptPage?: boolean }).__fakeBrowserGptPage
      && typeof page.waitForTimeout === 'function') {
      await page.waitForTimeout(ms);
      return;
    }
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
  },
};

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code ?? '') || undefined
    : undefined;
}

function bestEffortUnlink(path: string): void {
  try { unlinkSync(path); } catch { /* no authority after final-path decision */ }
}

/** Session mode deliberately preserves the landed atomic hard-link publication contract. */
export function publishSessionReply(
  outputPath: string,
  invocationId: string,
  reply: string,
): PublicationResult {
  const finalPath = resolve(outputPath);
  const tempPath = join(dirname(finalPath), `.${basename(finalPath)}.${invocationId}.${randomUUID()}.tmp`);
  let fd = -1;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, reply, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    linkSync(tempPath, finalPath);
    const bytes = Buffer.from(reply, 'utf8');
    bestEffortUnlink(tempPath);
    return {
      state: 'committed_ok',
      output: { byte_length: bytes.byteLength, sha256: sha256(bytes) },
    };
  } catch (error) {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    bestEffortUnlink(tempPath);
    if (errnoCode(error) === 'EEXIST') return { state: 'conflict', cause: 'output_exists' };
    const detail = errnoCode(error) ?? (error instanceof Error ? error.message : String(error));
    return { state: 'error', cause: `output_write_failed:${detail}` };
  }
}

function streamOpen(stream: SessionWritable): boolean {
  return stream.destroyed !== true && stream.writable !== false && stream.writableEnded !== true;
}

export class SessionStdoutWriter {
  private usable = true;
  private waitingForDrain = false;
  private readonly stream: SessionWritable;
  private readonly deadline: number;
  private readonly now: () => number;

  constructor(stream: SessionWritable, deadline: number, now: () => number = Date.now) {
    this.stream = stream;
    this.deadline = deadline;
    this.now = now;
  }

  isUsable(): boolean {
    return this.usable && streamOpen(this.stream);
  }

  private abort(): void {
    this.usable = false;
    this.waitingForDrain = false;
    try { this.stream.destroy?.(new Error('session_stdout_unusable')); } catch { /* terminal */ }
  }

  async write(value: unknown): Promise<boolean> {
    if (!this.isUsable()) return false;
    const line = `${JSON.stringify(value)}\n`;
    if (this.now() >= this.deadline) {
      if (this.waitingForDrain || this.stream.writableNeedDrain === true) {
        this.abort();
        return false;
      }
      try {
        const complete = this.stream.write(line);
        if (!complete) {
          this.abort();
          return false;
        }
        return true;
      } catch {
        this.abort();
        return false;
      }
    }

    let complete: boolean;
    try {
      complete = this.stream.write(line);
    } catch {
      this.abort();
      return false;
    }
    if (complete) return true;

    const remaining = this.deadline - this.now();
    if (remaining <= 0 || !this.stream.once || !this.stream.removeListener) {
      this.abort();
      return false;
    }
    this.waitingForDrain = true;
    return await new Promise<boolean>((resolveWrite) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.stream.removeListener?.('drain', onDrain);
        this.stream.removeListener?.('error', onFailure);
        this.stream.removeListener?.('close', onFailure);
        this.waitingForDrain = false;
        if (!ok) this.abort();
        resolveWrite(ok);
      };
      const onDrain = (): void => finish(this.now() < this.deadline && this.isUsable());
      const onFailure = (): void => finish(false);
      const timer = setTimeout(() => finish(false), remaining);
      this.stream.once?.('drain', onDrain);
      this.stream.once?.('error', onFailure);
      this.stream.once?.('close', onFailure);
    });
  }

  /** Advisory only: never becomes a progression barrier. */
  writeHeartbeat(value: unknown): void {
    if (!this.isUsable() || this.waitingForDrain || this.stream.writableNeedDrain === true) return;
    try { this.stream.write(`${JSON.stringify(value)}\n`); } catch { /* next required barrier detects failure */ }
  }
}

interface ParsedRawSessionArgs {
  readonly options: Map<string, string | true>;
  readonly inputs: string[];
  readonly outputs: string[];
}

function parseInteger(value: string, minimum: number): number {
  if (!/^\d+$/.test(value)) throw new Error('input_invalid:timeout_ms_invalid');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error('input_invalid:timeout_ms_invalid');
  return parsed;
}

function parseRawArgs(argv: readonly string[]): ParsedRawSessionArgs {
  const options = new Map<string, string | true>();
  const inputs: string[] = [];
  const outputs: string[] = [];
  for (let cursor = 0; cursor < argv.length;) {
    const raw = argv[cursor++];
    if (!raw?.startsWith('--') || raw === '--') throw new Error('input_invalid:argument_invalid');
    const key = raw.slice(2);
    if (key === 'new-chat') {
      if (options.has(key)) throw new Error('input_invalid:argument_duplicate');
      options.set(key, true);
      continue;
    }
    const value = argv[cursor++];
    if (!value || value.startsWith('--')) throw new Error('input_invalid:argument_value_missing');
    if (key === 'input') {
      inputs.push(value);
      continue;
    }
    if (key === 'output') {
      outputs.push(value);
      continue;
    }
    if (options.has(key)) throw new Error('input_invalid:argument_duplicate');
    options.set(key, value);
  }
  return { options, inputs, outputs };
}

function stringOption(raw: ParsedRawSessionArgs, key: string): string | undefined {
  const value = raw.options.get(key);
  return typeof value === 'string' ? value : undefined;
}

function requireOption(raw: ParsedRawSessionArgs, key: string): string {
  const value = stringOption(raw, key);
  if (!value) throw new Error(`input_invalid:argument_required:${key}`);
  return value;
}

function preflightSession(
  argv: readonly string[],
  deps: StateLightSessionDependencies,
): ParsedSessionConfig {
  const raw = parseRawArgs(argv);
  const allowed = new Set(['profile', 'cdp', 'chat-url', 'project-url', 'timeout-ms', 'poll-ms', 'new-chat']);
  const unknown = [...raw.options.keys()].find((key) => !allowed.has(key));
  if (unknown) throw new Error(`input_invalid:argument_unknown:${unknown}`);
  if (raw.inputs.length !== raw.outputs.length) throw new Error('input_invalid:payload_pair_count_mismatch');
  if (raw.inputs.length < 1 || raw.inputs.length > MAX_SESSION_PAYLOADS) {
    throw new Error('input_invalid:payload_count_out_of_range');
  }

  const profile = requireOption(raw, 'profile');
  const cdp = requireOption(raw, 'cdp');
  const newChat = raw.options.get('new-chat') === true;
  const chatUrl = stringOption(raw, 'chat-url');
  const projectUrl = stringOption(raw, 'project-url');
  if (newChat === Boolean(chatUrl)) throw new Error('input_invalid:argument_mode_invalid');
  if (newChat && !projectUrl) throw new Error('input_invalid:argument_required:project-url');
  if (!newChat && projectUrl) throw new Error('input_invalid:argument_mode_invalid');

  const timeoutRaw = requireOption(raw, 'timeout-ms');
  const timeoutMs = parseInteger(timeoutRaw, 1);
  if (!Number.isFinite(timeoutMs) || timeoutMs > STATE_LIGHT_MAX_TIMEOUT_MS) {
    throw new Error('input_invalid:timeout_ms_exceeds_maximum');
  }
  const pollMs = stringOption(raw, 'poll-ms')
    ? parseInteger(requireOption(raw, 'poll-ms'), 1)
    : DEFAULT_SESSION_POLL_MS;

  const identities = new Set<string>();
  let aggregateBytes = 0;
  const manifest = raw.inputs.map((inputPath, index): SessionManifestItem => {
    const snapshot = deps.readInput(inputPath);
    aggregateBytes += snapshot.byteLength;
    if (aggregateBytes > MAX_SESSION_INPUT_BYTES) throw new Error('input_invalid:aggregate_input_too_large');
    const destination = deps.resolveDestination(raw.outputs[index]!);
    if (identities.has(destination.identity)) throw new Error('input_invalid:duplicate_output_destination');
    identities.add(destination.identity);
    return {
      ordinal: index + 1,
      snapshot,
      input: { byte_length: snapshot.byteLength, sha256: sha256(snapshot.bytes) },
      outputPath: destination.finalPath,
      outputIdentity: destination.identity,
    };
  });

  return {
    browser: {
      cdp,
      profile,
      newChat,
      timeoutMs,
      ...(chatUrl ? { chatUrl } : {}),
      ...(projectUrl ? { projectUrl } : {}),
    },
    pollMs,
    manifest,
  };
}

function compactPreflightRefusal(
  cause: string,
  invocationId: string,
  profileKey: string,
): CompactTurnResult {
  const state = cause.startsWith('output_conflict:') ? 'output_conflict' : 'input_invalid';
  return {
    ...compactResult(
      state,
      'invocation',
      cause,
      invocationId,
      profileKey,
      0,
      0,
      new StateLightNavigationCounter(),
      [],
    ),
    cleanup: 'skipped',
  };
}

function safeProfileKey(argv: readonly string[], deps: StateLightSessionDependencies): string {
  try {
    const raw = parseRawArgs(argv);
    const profile = stringOption(raw, 'profile');
    const cdp = stringOption(raw, 'cdp');
    return profile && cdp ? deps.profileKey(profile, cdp) : 'profile-unresolved';
  } catch {
    return 'profile-unresolved';
  }
}

function pageConversationId(page: any): string | undefined {
  try {
    const normalized = normalizeConversationUrl(String(page.url()));
    return conversationUuidFromUrl(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function remainingMs(state: SessionExecutionState, deps: StateLightSessionDependencies): number {
  return state.wholeSessionDeadline - deps.now();
}

function deadlineOpen(state: SessionExecutionState, deps: StateLightSessionDependencies): boolean {
  return remainingMs(state, deps) > 0;
}

async function readObservationWithinDeadline(
  state: SessionExecutionState,
  deps: StateLightSessionDependencies,
  expectedMarker?: string,
  baselineCount?: number,
): Promise<PageObservationResult> {
  const remaining = remainingMs(state, deps);
  if (remaining <= 0) throw new Error('whole_session_deadline_exhausted');

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('whole_session_deadline_exhausted')), remaining);
    });
    const observation = await Promise.race([
      deps.readObservation(state.page, expectedMarker, baselineCount),
      timeout,
    ]);
    if (!deadlineOpen(state, deps)) throw new Error('whole_session_deadline_exhausted');
    return observation;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function tuple(state: TurnState, scope: FailureScope, cause: string): SessionTerminalTuple {
  return { state, scope, cause };
}

function activeTerminalRecord(payload: MutablePayloadState): SessionPayloadRecord {
  return {
    schema: 'session-payload/v1',
    ordinal: payload.item.ordinal,
    input: payload.item.input,
    phase: 'terminal',
    send_count: payload.sendCount,
    delivery_state: payload.deliveryState,
    ...(payload.expectedMarker ? { expected_marker: payload.expectedMarker } : {}),
    ...(payload.markerMatchCount !== undefined ? { marker_match_count: payload.markerMatchCount } : {}),
    ...(payload.conversationId ? { conversation_id: payload.conversationId } : {}),
    ...(payload.terminal ? {
      state: payload.terminal.state,
      scope: payload.terminal.scope,
      cause: payload.terminal.cause,
    } : {}),
    ...(payload.output ? { output: payload.output } : {}),
  };
}

function untouchedTerminalRecord(payload: MutablePayloadState): SessionPayloadRecord {
  return {
    schema: 'session-payload/v1',
    ordinal: payload.item.ordinal,
    input: payload.item.input,
    phase: 'terminal',
    send_count: 0,
    delivery_state: 'not_attempted',
  };
}

async function writePayloadRecord(
  state: SessionExecutionState,
  payload: MutablePayloadState,
  record: SessionPayloadRecord,
): Promise<boolean> {
  const written = await state.writer.write(record);
  if (!written) return false;
  payload.latestWrittenRecord = record;
  if (record.phase === 'terminal') payload.terminalWritten = true;
  return true;
}

function countExpectedMarker(messages: readonly { role: string; text: string }[], marker: string): number {
  return messages.filter((message) => message.role === 'user' && ownedPromptMarkerMatches(message.text, marker)).length;
}

function hasLaterUserAfterMarker(
  messages: readonly { role: string; text: string }[],
  marker: string,
): boolean {
  const ownedIndex = messages.findIndex(
    (message) => message.role === 'user' && ownedPromptMarkerMatches(message.text, marker),
  );
  return ownedIndex >= 0 && messages.slice(ownedIndex + 1).some((message) => message.role === 'user');
}

function conversationIdentityContinuity(state: SessionExecutionState): SessionTerminalTuple | null {
  if (!state.conversationId) return null;
  const current = pageConversationId(state.page);
  if (!current || !ownedConversationIdentityMatches(current, state.conversationId)) {
    return tuple('ui_contract_mismatch', 'invocation', 'conversation_identity_changed');
  }
  return null;
}

function predecessorContinuity(
  state: SessionExecutionState,
  predecessor: MutablePayloadState,
  observation: PageObservationResult,
): SessionTerminalTuple | null {
  if (!predecessor.terminalWritten || predecessor.latestWrittenRecord?.phase !== 'terminal') {
    return tuple('driver_error', 'invocation', 'predecessor_terminal_not_written');
  }
  const identityFailure = conversationIdentityContinuity(state);
  if (identityFailure) return identityFailure;
  const marker = predecessor.expectedMarker;
  if (!marker) return tuple('ui_contract_mismatch', 'invocation', 'predecessor_marker_missing');
  if (observation.transcriptIncomplete) {
    return tuple('ui_contract_mismatch', 'conversation', 'predecessor_observation_incomplete');
  }
  const matches = countExpectedMarker(observation.messages, marker);
  if (matches === 0) return tuple('ui_contract_mismatch', 'invocation', 'predecessor_marker_unresolved');
  if (matches > 1) return tuple('ui_contract_mismatch', 'invocation', 'predecessor_marker_ambiguous');
  const ownedIndex = observation.messages.findIndex(
    (message) => message.role === 'user' && ownedPromptMatches(message.text, marker),
  );
  const laterUser = observation.messages.slice(ownedIndex + 1).some((message) => message.role === 'user');
  if (laterUser) return tuple('foreign_activity', 'conversation', 'foreign_user_after_predecessor');
  return null;
}

async function verifyComposerExact(
  page: any,
  expected: string,
  deadline: number,
  deps: StateLightSessionDependencies,
): Promise<boolean> {
  if (deps.now() >= deadline) return false;
  try {
    const composer = page.locator(COMPOSER_SELECTOR);
    const timeout = Math.min(MAX_LOCAL_READ_WAIT_MS, Math.max(1, deadline - deps.now()));
    const text = typeof composer.evaluate === 'function'
      ? String(await composer.evaluate((element: any) => String(element.innerText ?? element.textContent ?? ''), undefined, { timeout }))
      : String(await composer.innerText({ timeout }));
    return deps.now() < deadline && text === expected;
  } catch {
    return false;
  }
}

async function dispatchOnce(
  state: SessionExecutionState,
  payload: MutablePayloadState,
  wrapped: string,
  insertionDeadline: number,
  ordinalIndex: number,
  deps: StateLightSessionDependencies,
): Promise<SessionTerminalTuple | null> {
  const composerVerified = await verifyComposerExact(state.page, wrapped, insertionDeadline, deps);
  if (!deadlineOpen(state, deps)) return tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted');
  if (!composerVerified) {
    return tuple('driver_error', 'invocation', 'composer_mutation_budget_exhausted');
  }
  const dispatchContinuity = ordinalIndex > 0
    ? await preactivationCheck(state, ordinalIndex, deps)
    : conversationIdentityContinuity(state);
  if (dispatchContinuity) return dispatchContinuity;
  payload.sendCount = 1;
  payload.deliveryState = 'delivery_unknown';
  const latched: SessionPayloadRecord = {
    schema: 'session-payload/v1',
    ordinal: payload.item.ordinal,
    input: payload.item.input,
    phase: 'dispatch-latched',
    send_count: 1,
    delivery_state: 'delivery_unknown',
    expected_marker: payload.expectedMarker!,
    ...(state.conversationId ? { conversation_id: state.conversationId } : {}),
  };
  if (!(await writePayloadRecord(state, payload, latched))) {
    return tuple('driver_error', 'invocation', 'stdout_dispatch_latched_failed');
  }

  try {
    const composer = state.page.locator(COMPOSER_SELECTOR);
    const sendButton = state.page.locator(SEND_BUTTON_SELECTOR);
    const timeout = Math.min(MAX_LOCAL_READ_WAIT_MS, Math.max(1, remainingMs(state, deps)));
    const count = Number(await sendButton.count());
    if (!deadlineOpen(state, deps)) return tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted');
    if (count > 0) await sendButton.click({ timeout });
    else await composer.press('Enter', { timeout });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return tuple('send_failed', 'invocation', `dispatch_failed:${detail}`);
  }
  return null;
}

interface ObservePayloadResult {
  readonly terminal: SessionTerminalTuple;
  readonly markerCount?: number;
  readonly output?: SessionDigest;
}

async function maybeContinue(page: any, deadline: number, deps: StateLightSessionDependencies): Promise<void> {
  if (deps.now() >= deadline) return;
  try {
    const control = locateContinueGeneratingControl(page);
    if (Number(await control.count()) <= 0 || deps.now() >= deadline) return;
    await control.first().click({ timeout: Math.min(MAX_LOCAL_READ_WAIT_MS, Math.max(1, deadline - deps.now())) });
  } catch {
    // Existing continuation control is opportunistic and does not grant retry authority.
  }
}

async function observeAndPublish(
  state: SessionExecutionState,
  payload: MutablePayloadState,
  baselineCount: number,
  deps: StateLightSessionDependencies,
): Promise<ObservePayloadResult> {
  const marker = payload.expectedMarker!;
  let deliveryBound = false;
  let stableReads = 0;
  let previousReply = '';
  let bestReply = '';
  let pollCount = 0;
  let lastHeartbeatAt = deps.now();

  while (deadlineOpen(state, deps)) {
    pollCount += 1;
    let observation: PageObservationResult;
    try {
      observation = await readObservationWithinDeadline(state, deps, marker, baselineCount);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!deadlineOpen(state, deps) || detail === 'whole_session_deadline_exhausted') {
        return { terminal: tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted') };
      }
      return { terminal: tuple('driver_error', 'invocation', `observation_failed:${detail}`) };
    }
    try {
      const wallBudget = Math.min(800, Math.max(1, remainingMs(state, deps)));
      const wall = classifyProductWall(await productStatusText(state.page, wallBudget));
      if (wall.state) {
        return { terminal: tuple(wall.state, 'invocation', wall.cause ?? `${wall.state}_detected`) };
      }
    } catch {
      // Product-wall diagnostics stay advisory when the transcript remains readable.
    }
    if (!deadlineOpen(state, deps)) {
      return { terminal: tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted') };
    }

    const currentConversation = pageConversationId(state.page);
    if (state.conversationId) {
      if (!currentConversation || !ownedConversationIdentityMatches(currentConversation, state.conversationId)) {
        return { terminal: tuple('ui_contract_mismatch', 'invocation', 'conversation_identity_changed') };
      }
    } else if (currentConversation) {
      state.conversationId = currentConversation;
    }

    const markerCount = countExpectedMarker(observation.messages, marker);
    payload.markerMatchCount = markerCount;
    if (markerCount > 1) {
      return { terminal: tuple('ui_contract_mismatch', 'invocation', 'owned_prompt_marker_ambiguous'), markerCount };
    }
    if (deliveryBound && markerCount !== 1) {
      return {
        terminal: tuple('ui_contract_mismatch', 'invocation', markerCount === 0
          ? 'owned_prompt_marker_disappeared'
          : 'owned_prompt_marker_ambiguous'),
        markerCount,
      };
    }
    if (!observation.transcriptIncomplete && markerCount === 1 && hasLaterUserAfterMarker(observation.messages, marker)) {
      return { terminal: tuple('foreign_activity', 'conversation', 'foreign_user_after_owned_send'), markerCount };
    }
    if (!observation.transcriptIncomplete && !deliveryBound && markerCount === 1) {
      payload.deliveryState = 'delivered';
      payload.conversationId = state.conversationId;
      const bound: SessionPayloadRecord = {
        schema: 'session-payload/v1',
        ordinal: payload.item.ordinal,
        input: payload.item.input,
        phase: 'delivery-bound',
        send_count: 1,
        delivery_state: 'delivered',
        expected_marker: marker,
        marker_match_count: 1,
        ...(state.conversationId ? { conversation_id: state.conversationId } : {}),
      };
      if (!(await writePayloadRecord(state, payload, bound))) {
        payload.deliveryState = 'delivery_unknown';
        return { terminal: tuple('driver_error', 'invocation', 'stdout_delivery_bound_failed'), markerCount };
      }
      deliveryBound = true;
    }

    if (observation.transcriptIncomplete) {
      stableReads = 0;
      previousReply = '';
    } else {
      const inProgress = !observation.ownedWindowCompletionReady;
      const decision = deps.classifyObservation(observation.messages, baselineCount, marker, inProgress);
      if (decision.state === 'uncertain') {
        return { terminal: tuple('foreign_activity', 'conversation', decision.cause ?? 'observation_uncertain'), markerCount };
      }
      if (decision.state === 'ready' && decision.reply) {
        if (decision.reply.length > bestReply.length) bestReply = decision.reply;
        if (deps.replyStable(decision.reply, previousReply)) stableReads += 1;
        else {
          previousReply = decision.reply;
          stableReads = 1;
        }
        if (deliveryBound && observation.ownedWindowCompletionReady && stableReads >= 2) {
          if (!deadlineOpen(state, deps)) {
            return { terminal: tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted'), markerCount };
          }
          const reply = bestReply.length >= decision.reply.length ? bestReply : decision.reply;
          const publication = deps.publishReply(payload.item.outputPath, state.invocationId, reply);
          if (publication.state !== 'committed_ok') {
            return {
              terminal: tuple(
                publication.state === 'conflict' ? 'output_conflict' : 'driver_error',
                'invocation',
                publication.cause ?? publication.state,
              ),
              markerCount,
            };
          }
          payload.output = publication.output;
          return {
            terminal: deps.now() < state.wholeSessionDeadline
              ? tuple('ok', 'none', 'completed_page_only')
              : tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted_after_output'),
            markerCount,
            output: publication.output,
          };
        }
      } else {
        stableReads = 0;
        previousReply = '';
      }
      await maybeContinue(state.page, state.wholeSessionDeadline, deps);

      const now = deps.now();
      const dueByPoll = pollCount % HEARTBEAT_POLL_INTERVAL === 0;
      const dueByTime = now - lastHeartbeatAt >= OBSERVATION_HEARTBEAT_MS;
      if (dueByPoll || dueByTime) {
        const heartbeatDecision: PageObservationDecision = decision;
        state.writer.writeHeartbeat(buildObservationHeartbeat(
          heartbeatDecision,
          stableReads,
          pollCount,
          observation.ownedWindowCompletionReady,
          decision.state === 'ready' && decision.reply ? decision.reply : bestReply,
        ));
        lastHeartbeatAt = now;
      }
    }

    const delay = Math.min(
      state.config.pollMs,
      Math.max(0, remainingMs(state, deps)),
      POST_SEND_OBSERVATION_POLL_MS,
    );
    if (delay <= 0) break;
    await deps.sleep(state.page, delay);
  }

  return {
    terminal: payload.deliveryState === 'delivered'
      ? tuple('no_reply', 'invocation', 'observation_exhausted_no_resend')
      : tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted'),
    ...(payload.markerMatchCount !== undefined ? { markerCount: payload.markerMatchCount } : {}),
  };
}

function classifySetupError(error: unknown): SessionTerminalTuple {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('ui_contract_mismatch:')) return tuple('ui_contract_mismatch', 'invocation', message.slice('ui_contract_mismatch:'.length));
  if (message.startsWith('output_conflict:')) return tuple('output_conflict', 'invocation', message.slice('output_conflict:'.length));
  if (message === 'whole_session_deadline_exhausted' || message.startsWith('browser_operation_timeout:')) {
    return tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted');
  }
  return tuple('driver_error', 'invocation', message);
}

async function setupOwnedPage(
  state: SessionExecutionState,
  deps: StateLightSessionDependencies,
): Promise<SessionTerminalTuple | null> {
  if (!deadlineOpen(state, deps)) return tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted');
  let profile: ProfileVerification;
  try {
    profile = await deps.verifyProfile(
      state.config.browser,
      createTurnOperationBudget(Math.max(0, remainingMs(state, deps)), deps.now()),
    );
  } catch (error) {
    return classifySetupError(error);
  }
  if (!deadlineOpen(state, deps)) return tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted');
  if (profile.state !== 'verified') {
    return tuple(profile.state === 'unavailable' ? 'chrome_not_running' : 'profile_mismatch', 'invocation', profile.cause);
  }
  if (!deadlineOpen(state, deps)) return tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted');

  try {
    const chromium = deps.loadChromium();
    state.browser = await chromium.connectOverCDP(state.config.browser.cdp, {
      timeout: Math.min(30_000, Math.max(1, remainingMs(state, deps))),
    });
    if (!deadlineOpen(state, deps)) throw new Error('whole_session_deadline_exhausted');
    const contexts = state.browser.contexts();
    if (contexts.length !== 1) throw new Error('ui_contract_mismatch:context_count');
    state.page = await contexts[0].newPage();
    if (!deadlineOpen(state, deps)) throw new Error('whole_session_deadline_exhausted');
    const target = state.config.browser.newChat
      ? projectConversationPrefix(state.config.browser.projectUrl ?? '')
      : normalizeConversationUrl(state.config.browser.chatUrl ?? '');
    if (!target) throw new Error('ui_contract_mismatch:target_required');
    state.navigation.recordGoto();
    await state.page.goto(target, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(MAX_LOCAL_READ_WAIT_MS * 6, Math.max(1, remainingMs(state, deps))),
    });
    if (!deadlineOpen(state, deps)) throw new Error('whole_session_deadline_exhausted');
    if (!state.config.browser.newChat) {
      if (!ownedConversationIdentityMatches(String(state.page.url()), target)) {
        throw new Error('ui_contract_mismatch:conversation_redirect');
      }
      state.conversationId = normalizeConversationUrl(target);
    } else {
      const remainingConfig: BrowserConfig = {
        ...state.config.browser,
        timeoutMs: Math.max(1, remainingMs(state, deps)),
      };
      const prepared = await deps.prepareFresh(
        state.page,
        remainingConfig,
        deps.profileKey(remainingConfig.profile, remainingConfig.cdp),
        state.invocationId,
        state.navigation,
      );
      if (!deadlineOpen(state, deps)) return tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted');
      if (prepared.state === 'wall') return tuple(prepared.wallState, 'invocation', prepared.cause);
      if (prepared.state !== 'ready') return tuple('ui_contract_mismatch', 'invocation', prepared.cause);
    }
    return null;
  } catch (error) {
    return classifySetupError(error);
  }
}

async function preactivationCheck(
  state: SessionExecutionState,
  ordinalIndex: number,
  deps: StateLightSessionDependencies,
): Promise<SessionTerminalTuple | null> {
  if (ordinalIndex === 0) return null;
  if (!deadlineOpen(state, deps)) return tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted');
  const predecessor = state.payloads[ordinalIndex - 1]!;
  let observation: PageObservationResult;
  try {
    observation = await readObservationWithinDeadline(state, deps);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!deadlineOpen(state, deps) || detail === 'whole_session_deadline_exhausted') {
      return tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted');
    }
    return tuple('driver_error', 'invocation', `continuity_observation_failed:${detail}`);
  }
  return predecessorContinuity(state, predecessor, observation);
}

async function runActivePayload(
  state: SessionExecutionState,
  payload: MutablePayloadState,
  ordinalIndex: number,
  deps: StateLightSessionDependencies,
): Promise<SessionTerminalTuple> {
  if (!deadlineOpen(state, deps)) return tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted');
  const composerState = await deps.waitForComposer(state.page, state.wholeSessionDeadline);
  if (!deadlineOpen(state, deps)) return tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted');
  if (composerState.state !== 'ready') return tuple(composerState.state, 'invocation', composerState.cause);

  payload.expectedMarker = deps.marker();
  const wrapped = deps.wrapPayload(payload.expectedMarker, payload.item.snapshot.text);
  const insertionContext: { insertionDeadlineMs?: number } = {};
  const mutationFailure = await deps.mutateComposer(
    state.page,
    wrapped,
    state.wholeSessionDeadline,
    insertionContext,
  );
  if (!deadlineOpen(state, deps)) return tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted');
  if (mutationFailure) return tuple('driver_error', 'invocation', mutationFailure);
  const insertionDeadline = insertionContext.insertionDeadlineMs ?? state.wholeSessionDeadline;

  if (ordinalIndex > 0) {
    const continuity = await preactivationCheck(state, ordinalIndex, deps);
    if (continuity) return continuity;
  }
  if (!deadlineOpen(state, deps)) return tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted');
  const composerReady = await deps.readComposerReady(state.page, insertionDeadline);
  if (!deadlineOpen(state, deps)) return tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted');
  if (!composerReady) {
    return tuple('driver_error', 'invocation', 'composer_mutation_budget_exhausted');
  }

  let baseline: PageObservationResult;
  try {
    baseline = await readObservationWithinDeadline(state, deps);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!deadlineOpen(state, deps) || detail === 'whole_session_deadline_exhausted') {
      return tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted');
    }
    return tuple('driver_error', 'invocation', `baseline_observation_failed:${detail}`);
  }
  const dispatchFailure = await dispatchOnce(state, payload, wrapped, insertionDeadline, ordinalIndex, deps);
  if (dispatchFailure) return dispatchFailure;

  const observed = await observeAndPublish(state, payload, baseline.messages.length, deps);
  if (observed.markerCount !== undefined) payload.markerMatchCount = observed.markerCount;
  if (observed.output) payload.output = observed.output;
  payload.conversationId = state.conversationId;
  return observed.terminal;
}

async function writeNormalTermination(
  state: SessionExecutionState,
  decisiveIndex: number | null,
): Promise<boolean> {
  const start = decisiveIndex ?? state.payloads.length;
  if (decisiveIndex !== null) {
    const decisive = state.payloads[decisiveIndex]!;
    if (!decisive.terminalWritten && !(await writePayloadRecord(state, decisive, activeTerminalRecord(decisive)))) return false;
  }
  for (let index = start + (decisiveIndex === null ? 0 : 1); index < state.payloads.length; index++) {
    const suffix = state.payloads[index]!;
    suffix.deliveryState = 'not_attempted';
    suffix.sendCount = 0;
    if (!(await writePayloadRecord(state, suffix, untouchedTerminalRecord(suffix)))) return false;
  }
  return true;
}

function buildSessionResult(
  state: SessionExecutionState,
  cleanup: ResourceCleanupOutcome,
): SessionResultV1 {
  const terminals = state.payloads.map((payload) => payload.latestWrittenRecord!);
  const firstNonClean = terminals.find((record) => record.state !== undefined && record.state !== 'ok');
  const aggregateTuple = firstNonClean
    ? tuple(firstNonClean.state!, firstNonClean.scope!, firstNonClean.cause!)
    : tuple('ok', 'none', 'completed_page_only');
  const decisiveOrdinal = firstNonClean?.ordinal ?? null;
  return {
    schema: 'session-result/v1',
    payload_count: terminals.length,
    attempted_payload_count: terminals.filter((record) => record.delivery_state !== 'not_attempted').length,
    total_send_count: terminals.reduce((sum, record) => sum + record.send_count, 0),
    ...(state.conversationId ? { conversation_id: state.conversationId } : {}),
    terminal_stop_ordinal: decisiveOrdinal,
    decisive_payload_ordinal: decisiveOrdinal,
    state: aggregateTuple.state,
    scope: aggregateTuple.scope,
    cause: aggregateTuple.cause,
    exit_code: turnExitCode(aggregateTuple.state),
    cleanup,
    owned_tab_count: state.page ? 1 : 0,
    goto_count: state.navigation.snapshotGoto(),
    new_chat_click_count: state.navigation.snapshotNewChatClick(),
    navigation_count: state.navigation.snapshot(),
    payloads: terminals.map((record): SessionPayloadSummary => ({
      ordinal: record.ordinal,
      input: record.input,
      latest_phase: record.phase,
      delivery_state: record.delivery_state,
      send_count: record.send_count,
      ...(record.expected_marker ? { expected_marker: record.expected_marker } : {}),
      ...(record.state ? { state: record.state, scope: record.scope!, cause: record.cause! } : {}),
      ...(record.output ? { output: record.output } : {}),
    })),
  };
}

async function cleanupSession(
  state: SessionExecutionState,
  deps: StateLightSessionDependencies,
): Promise<ResourceCleanupOutcome> {
  let cleanup: ResourceCleanupOutcome = 'skipped';
  if (state.page) {
    cleanup = await deps.cleanup(() => state.page.close(), RESOURCE_CLEANUP_BOUND_MS);
  }
  await deps.releaseBrowser(state.browser);
  return cleanup;
}

async function executeSession(
  config: ParsedSessionConfig,
  deps: StateLightSessionDependencies,
): Promise<number> {
  const invocationId = deps.uuid();
  const payloads: MutablePayloadState[] = config.manifest.map((item) => ({
    item,
    sendCount: 0,
    deliveryState: 'not_attempted',
    terminalWritten: false,
  }));

  // Ordinal 1 is active before this clock and every profile/CDP/page/navigation operation.
  payloads[0]!.deliveryState = 'not_sent';
  const wholeSessionDeadline = deps.now() + config.browser.timeoutMs;
  const state: SessionExecutionState = {
    invocationId,
    config,
    payloads,
    navigation: new StateLightNavigationCounter(),
    writer: new SessionStdoutWriter(deps.stdout, wholeSessionDeadline, deps.now),
    wholeSessionDeadline,
    stopped: false,
  };

  const freshSlotProfileKey = config.browser.newChat
    ? deps.profileKey(config.browser.profile, config.browser.cdp)
    : undefined;
  let freshSlotAcquired = false;
  let decisiveIndex: number | null = null;
  let activeIndex = 0;

  try {
    let slotFailure: SessionTerminalTuple | null = null;
    if (freshSlotProfileKey) {
      try {
        await acquireStateLightNewChatSendSlot(
          freshSlotProfileKey,
          invocationId,
          Math.max(1, remainingMs(state, deps)),
        );
        freshSlotAcquired = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        slotFailure = !deadlineOpen(state, deps)
          ? tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted')
          : tuple('driver_error', 'invocation', `fresh_chat_send_slot_failed:${detail}`);
      }
    }

    if (slotFailure) {
      payloads[0]!.terminal = slotFailure;
      decisiveIndex = 0;
    } else {
      try {
        const setupFailure = await setupOwnedPage(state, deps);
        if (setupFailure) {
          payloads[0]!.terminal = setupFailure;
          decisiveIndex = 0;
        } else {
          for (let index = 0; index < payloads.length; index++) {
            activeIndex = index;
            const payload = payloads[index]!;
            if (index > 0) {
              const continuity = await preactivationCheck(state, index, deps);
              if (continuity) {
                payload.deliveryState = 'not_attempted';
                payload.terminal = continuity;
                decisiveIndex = index;
                break;
              }
              payload.deliveryState = 'not_sent';
            }

            const terminal = await runActivePayload(state, payload, index, deps);
            payload.terminal = terminal;
            if (!(await writePayloadRecord(state, payload, activeTerminalRecord(payload)))) {
              payload.terminal = tuple('driver_error', 'invocation', 'stdout_terminal_record_failed');
              decisiveIndex = index;
              state.stopped = true;
              break;
            }
            if (terminal.state !== 'ok') {
              decisiveIndex = index;
              break;
            }
            if (config.browser.newChat && index === 0 && !payload.latestWrittenRecord?.conversation_id) {
              // A fresh conversation identity must be caller-visible before ordinal 2 can activate.
              if (payloads.length > 1) {
                const next = payloads[1]!;
                next.terminal = tuple('ui_contract_mismatch', 'invocation', 'fresh_conversation_identity_unavailable');
                decisiveIndex = 1;
              }
              break;
            }
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        payloads[activeIndex]!.terminal = !deadlineOpen(state, deps) || detail === 'whole_session_deadline_exhausted'
          ? tuple('stream_timeout', 'invocation', 'whole_session_deadline_exhausted')
          : tuple('driver_error', 'invocation', `active_operation_failed:${detail}`);
        decisiveIndex = activeIndex;
      }
    }

    let sequenceComplete = !state.stopped;
    if (sequenceComplete) sequenceComplete = await writeNormalTermination(state, decisiveIndex);
    const cleanup = await cleanupSession(state, deps);
    if (!sequenceComplete) {
      const decisiveState = decisiveIndex === null ? 'driver_error' : (payloads[decisiveIndex]!.terminal?.state ?? 'driver_error');
      return turnExitCode(decisiveState === 'ok' ? 'driver_error' : decisiveState);
    }

    const aggregate = buildSessionResult(state, cleanup);
    if (!(await state.writer.write(aggregate))) return aggregate.exit_code === 0 ? 10 : aggregate.exit_code;
    return aggregate.exit_code;
  } finally {
    if (freshSlotAcquired && freshSlotProfileKey) {
      releaseStateLightNewChatSendSlot(freshSlotProfileKey, invocationId);
    }
  }
}

export async function runStateLightSession(
  argv: readonly string[],
  dependencies: Partial<StateLightSessionDependencies> = {},
): Promise<number> {
  const deps: StateLightSessionDependencies = { ...defaultDependencies, ...dependencies };
  if (argv.length === 1 && argv[0] === '--help') {
    try { deps.stdout.write(`${STATE_LIGHT_SESSION_HELP}\n`); } catch { return 22; }
    return 0;
  }
  let config: ParsedSessionConfig;
  try {
    config = preflightSession(argv, deps);
  } catch (error) {
    const invocationId = deps.uuid();
    const raw = error instanceof Error ? error.message : String(error);
    const refusal = compactPreflightRefusal(raw, invocationId, safeProfileKey(argv, deps));
    try { deps.stdout.write(`${JSON.stringify(refusal)}\n`); } catch { /* no alternate channel */ }
    return turnExitCode(refusal.state);
  }
  return await executeSession(config, deps);
}

export const __testSession = {
  preflightSession,
  compactPreflightRefusal,
  predecessorContinuity,
  buildSessionResult,
  publishSessionReply,
};
