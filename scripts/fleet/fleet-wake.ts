#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';
import { createHash } from 'node:crypto';
import { runProcessSync } from '../kernel/subprocess.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargetContext } from '../lib/target-context.ts';
import {
  ORCHESTRATION_RUN_PANE_KEY_PATH,
  createAdapterSubmitDeps,
  createOrcaMessageSubmitDeps,
} from '../cursor-unsent-composer-submit.ts';
import { OrcaRuntimeAdapter } from '../orca-runtime/adapter.ts';
import { parseOrcaJsonOutput, resolveOrcaOperation, type OrcaJsonResponse } from '../orca-runtime/native.ts';
import { resolveWakeSupervisorStateRoot } from '../pr2-foundation/wake-supervisor-state-root.ts';
import {
  DEFAULT_BUSY_RE,
  DEFAULT_ORCHESTRATOR_TITLE_RE,
  FileFleetStateStore,
  FleetScreenReadError,
  collectFleetDiagnostics,
  formatFleetDiagnostics,
  compileRegex,
  defaultOrcaExecutor,
  defaultWorkspaceRegex,
  isBusyScreen,
  listFleetTerminals,
  readFleetScreen,
  runFleetSweep,
  type FleetPaneObservation,
  type FleetPollingStore,
  type FleetTerminal,
  type OrcaExecutor,
} from './fleet-sweep.ts';
import {
  DEFAULT_CHAT_CDP_URL,
  closeChatTarget,
  conversationCreatedAt,
  readProjectChats,
  projectConversationPrefix,
  type ChatBannerScope,
  type ChatErrorBanner,
  type ProjectChat,
} from './chat-error-banners.ts';
import { readChatBinding } from '../chatgpt-browser-turn/chat-bindings.ts';
import { readStateLightTurnObservation } from '../chatgpt-browser-turn/state-light-turn-observation.ts';
import { TERMINAL_SCHEMA, isWakeableTerminalEnvelopePath, type DeliveryState } from '../flow-manager-long-running-child.ts';

export interface FleetWakeConfig {
  readonly projectId: string;
  readonly primary: string;
  readonly workspaceRe: RegExp;
  readonly orchestratorTitleRe: RegExp;
  readonly orchestratorHandle?: string;
  readonly architectHandle?: string;
  readonly busyRe: RegExp;
  readonly intervalSeconds: number;
  readonly chatCdpUrl?: string;
  readonly chatScope?: ChatBannerScope;
}

export interface FleetWakeStateStore extends FleetPollingStore {
  readLastSentSignature(): string | null;
  writeLastSentSignature(signature: string): void;
  clearLastSentSignature(): void;
  readBannerSignature?(): string | null;
  writeBannerSignature?(signature: string): void;
  readStalledSeen?(): string | null;
  writeStalledSeen?(urls: string): void;
  hasParkedWakeEvent(key: string): boolean;
  readParkedWakeEventStatus(key: string): 'sent' | 'attempted_unverified' | undefined;
  markParkedWakeEvent(key: string, status?: 'sent' | 'attempted_unverified'): void;
  rearmParkedWakeEvents(observedKeys: ReadonlyMap<string, string | null>): void;
  readLastSentAt?(): number | undefined;
  writeLastSentAt?(at: number): void;
  clearLastSentAt?(): void;
  readParkedEpoch?(handle: string): { key: string; since: number; started?: number } | undefined;
  writeParkedEpoch?(handle: string, epoch: { key: string; since: number; started?: number }): void;
  clearParkedEpoch?(handle: string): void;
  pruneParkedEpochs?(keys: ReadonlyMap<string, string>): void;
}

export class FileFleetWakeStateStore extends FileFleetStateStore implements FleetWakeStateStore {
  private signaturePath(): string {
    return join(this.root, 'last-sent.signature');
  }

  readLastSentSignature(): string | null {
    try {
      return existsSync(this.signaturePath()) ? readFileSync(this.signaturePath(), 'utf8').trim() || null : null;
    } catch {
      return null;
    }
  }

  writeLastSentSignature(signature: string): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.signaturePath(), `${signature}\n`, 'utf8');
  }

  clearLastSentSignature(): void {
    rmSync(this.signaturePath(), { force: true });
  }

  private sentAtPath(): string {
    return join(this.root, 'last-sent.at');
  }

  readLastSentAt(): number | undefined {
    try {
      const value = Number(readFileSync(this.sentAtPath(), 'utf8'));
      return Number.isFinite(value) && value >= 0 ? value : undefined;
    } catch { return undefined; }
  }

  writeLastSentAt(at: number): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.sentAtPath(), String(at), 'utf8');
  }

  clearLastSentAt(): void {
    rmSync(this.sentAtPath(), { force: true });
  }

  private parkedEpochPath(handle: string): string {
    const digest = createHash('sha256').update(handle).digest('hex').slice(0, 32);
    return join(this.root, `parked-epoch-${digest}.mark`);
  }

  readParkedEpoch(handle: string): { key: string; since: number; started?: number } | undefined {
    try {
      const record = JSON.parse(readFileSync(this.parkedEpochPath(handle), 'utf8')) as
        { handle?: unknown; key?: unknown; since?: unknown; started?: unknown };
      return record.handle === handle && typeof record.key === 'string'
        && typeof record.since === 'number' && Number.isFinite(record.since)
        ? { key: record.key, since: record.since, ...(typeof record.started === 'number' && Number.isFinite(record.started) ? { started: record.started } : {}) } : undefined;
    } catch { return undefined; }
  }

  writeParkedEpoch(handle: string, epoch: { key: string; since: number; started?: number }): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.parkedEpochPath(handle), JSON.stringify({ handle, ...epoch }), 'utf8');
  }

  clearParkedEpoch(handle: string): void {
    rmSync(this.parkedEpochPath(handle), { force: true });
  }

  pruneParkedEpochs(keys: ReadonlyMap<string, string>): void {
    let entries;
    try { entries = readdirSync(this.root, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !/^parked-epoch-[0-9a-f]{32}\.mark$/u.test(entry.name)) continue;
      const path = join(this.root, entry.name);
      try {
        const record = JSON.parse(readFileSync(path, 'utf8')) as { handle?: string; key?: string };
        if (!record.handle || keys.get(record.handle) !== record.key) rmSync(path, { force: true });
      } catch { rmSync(path, { force: true }); }
    }
  }

  private bannerSignaturePath(): string {
    return join(this.root, 'banner-sent.signature');
  }

  readBannerSignature(): string | null {
    try {
      return existsSync(this.bannerSignaturePath()) ? readFileSync(this.bannerSignaturePath(), 'utf8').trim() : null;
    } catch {
      return null;
    }
  }

  writeBannerSignature(signature: string): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.bannerSignaturePath(), `${signature}\n`, 'utf8');
  }

  private stalledSeenPath(): string {
    return join(this.root, 'stalled-seen.list');
  }

  readStalledSeen(): string | null {
    try {
      return existsSync(this.stalledSeenPath()) ? readFileSync(this.stalledSeenPath(), 'utf8').trim() : null;
    } catch {
      return null;
    }
  }

  writeStalledSeen(urls: string): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.stalledSeenPath(), `${urls}\n`, 'utf8');
  }

  private parkedWakeEventPath(key: string): string {
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 32);
    return join(this.root, `parked-wake-${digest}.mark`);
  }

  hasParkedWakeEvent(key: string): boolean {
    return existsSync(this.parkedWakeEventPath(key));
  }

  readParkedWakeEventStatus(key: string): 'sent' | 'attempted_unverified' | undefined {
    if (!this.hasParkedWakeEvent(key)) return undefined;
    try {
      const [storedKey, status] = readFileSync(this.parkedWakeEventPath(key), 'utf8').split(/\r?\n/u);
      // Old single-line successful marks remain valid; malformed marks fail closed.
      return storedKey === key && (!status || status === 'sent') ? 'sent' : 'attempted_unverified';
    } catch {
      return 'attempted_unverified';
    }
  }

  markParkedWakeEvent(key: string, status: 'sent' | 'attempted_unverified' = 'sent'): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.parkedWakeEventPath(key), `${key}\n${status}\n`, 'utf8');
  }

  rearmParkedWakeEvents(observedKeys: ReadonlyMap<string, string | null>): void {
    let entries;
    try {
      entries = readdirSync(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('parked-wake-') || !entry.name.endsWith('.mark')) continue;
      const path = join(this.root, entry.name);
      try {
        const key = readFileSync(path, 'utf8').split('\n', 1)[0] ?? '';
        for (const [handle, activeKey] of observedKeys) {
          if (!key.startsWith(`parked:${handle}:`)) continue;
          if (key !== activeKey) rmSync(path, { force: true });
          break;
        }
      } catch {
        // A partial state file is not an active PARKED episode.
      }
    }
  }
}

export interface RunMailWakeEvent {
  readonly id: string;
  readonly subject: string;
  readonly toHandle: string;
  readonly fromHandle: string;
}

export interface FleetAlarmTickOptions {
  readonly config: FleetWakeConfig;
  readonly executor?: OrcaExecutor;
  readonly store?: FleetWakeStateStore;
  readonly sleepMs?: (milliseconds: number) => void | Promise<void>;
  readonly log?: (line: string) => void;
  readonly readChats?: (cdpUrl: string, scope: ChatBannerScope) => Promise<ProjectChat[]>;
  readonly closeChat?: (cdpUrl: string, targetId: string) => Promise<boolean>;
  readonly listTerminalEnvelopes?: () => readonly TerminalEnvelopeEvent[];
  readonly listUnreadRunMessages?: (coordinatorHandle: string) => readonly RunMailWakeEvent[];
  readonly listOpenPulls?: (repository: string) => readonly OpenPullHead[];
  readonly checkRunsFinishedAt?: (repository: string, sha: string) => number | undefined;
  readonly supervisedPullOwner?: (pull: OpenPullHead, panes: readonly FleetPaneObservation[]) => FleetPaneObservation | undefined;
  readonly readWorktreeHead?: (worktreePath: string) => string | undefined;
  readonly readNamedPull?: (repository: string, number: number) => NativePull | undefined;
  readonly readNamedReview?: (repository: string, number: number, reviewId: number) => NativeReview | undefined;
  readonly readPackReviewStage?: (repository: string, sha: string) => PackReviewStageFact | undefined;
  readonly now?: () => number;
}

export type FleetAlarmTickResult =
  | { readonly state: 'sent'; readonly coordinator: string; readonly coordinatorState: 'idle' | 'busy'; readonly count: number; readonly signature: string }
  | { readonly state: 'nothing_stopped' }
  | { readonly state: 'same_stopped_set'; readonly coordinator: string; readonly signature: string }
  | { readonly state: 'no_orchestrator' }
  | { readonly state: 'unreadable'; readonly handle: string }
  | { readonly state: 'send_failed'; readonly coordinator: string };

function samePath(left: string, right: string): boolean {
  return resolve(left).replaceAll('\\', '/') === resolve(right).replaceAll('\\', '/');
}

export function resolveCoordinatorPane(
  terminals: readonly FleetTerminal[],
  config: FleetWakeConfig,
): FleetTerminal | undefined {
  if (config.orchestratorHandle) {
    const pinned = terminals.find((terminal) => terminal.handle === config.orchestratorHandle);
    if (!pinned) return undefined;
    const worktree = pinned.worktreePath.replaceAll('\\', '/');
    config.workspaceRe.lastIndex = 0;
    if (!samePath(pinned.worktreePath, config.primary) && config.workspaceRe.test(worktree)) {
      return undefined;
    }
    return pinned;
  }
  return terminals.find((terminal) => {
    config.orchestratorTitleRe.lastIndex = 0;
    return Boolean(terminal.worktreePath)
      && samePath(terminal.worktreePath, config.primary)
      && config.orchestratorTitleRe.test(terminal.title);
  });
}

export function actionablePanes(observations: readonly FleetPaneObservation[]): FleetPaneObservation[] {
  return observations.filter((pane) => pane.state === 'STOPPED' || pane.state === 'POLLING');
}

export function stoppedSignature(observations: readonly FleetPaneObservation[]): string {
  return actionablePanes(observations)
    .map((pane) => JSON.stringify([pane.state, pane.handle, pane.incarnationId, pane.taskBinding, pane.branch, pane.lines]))
    .sort((left, right) => left.localeCompare(right))
    .join('\n');
}

// The sweep has already stripped TUI framing/status bars. Fingerprint the
// normalized own output, including unpunctuated action requests, not only
// lines matching a limited question/error vocabulary.
function meaningfulStoppedSignature(observations: readonly FleetPaneObservation[]): string {
  return actionablePanes(observations)
    .map((pane) => {
      const response = pane.lines
        .map((line) => line.replace(/\s+/gu, ' ').trim())
        .filter((line) => line && line !== '>' && !/^[─━═▀▄╹╻┃│\-]{6,}$/u.test(line))
        .join('\n');
      return JSON.stringify([
        pane.state, pane.handle, pane.incarnationId, pane.branch, pane.taskBinding,
        createHash('sha256').update(response).digest('hex').slice(0, 24),
      ]);
    })
    .sort((left, right) => left.localeCompare(right)).join('\n');
}

function isWorkerPane(terminal: FleetTerminal, config: FleetWakeConfig): boolean {
  if (terminal.handle === config.architectHandle) return false;
  if (!terminal.worktreePath || samePath(terminal.worktreePath, config.primary)) return false;
  config.workspaceRe.lastIndex = 0;
  return config.workspaceRe.test(terminal.worktreePath.replaceAll('\\', '/'));
}

// A worktree may also host plain shell panes; the agent pane is the manager.
function singleOwner(candidates: readonly FleetTerminal[]): FleetTerminal | undefined {
  if (candidates.length === 1) return candidates[0];
  const agents = candidates.filter((terminal) => terminal.agentIdentity);
  return agents.length === 1 ? agents[0] : undefined;
}

const prHeadRefs = new Map<string, string>();

// PR head refs do not change, so one tracked-transport read per PR is enough.
export function readPrHeadRef(repository: string, pull: number): string | undefined {
  const key = `${repository}#${pull}`;
  const cached = prHeadRefs.get(key);
  if (cached) return cached;
  const result = runProcessSync({
    command: fileURLToPath(new URL('../gh', import.meta.url)),
    args: ['api', `repos/${repository}/pulls/${pull}`, '--jq', '.head.ref'],
    timeoutMs: 15_000,
    inheritParentEnv: true,
  });
  const ref = result.ok ? result.stdout.trim() : '';
  if (!ref) return undefined;
  prHeadRefs.set(key, ref);
  return ref;
}

/**
 * The chat binding written by the turn entry names the launching worktree;
 * without one, a PR-review chat is owned by the pane on the PR head branch, and
 * an execution chat by the workspace ending in `-<issue>`. Only a single
 * unambiguous pane is addressed.
 */
// An unsaved URL is not a launcher, owner, or an Issue/PR task identity.
// Reject even malformed/foreign placeholders before any saved-chat fallback.
function isLocalPlaceholderUrl(url: string): boolean {
  return /local-chatgpt(?::|%3a)/iu.test(url);
}

function localChatIdentity(url: string, config: FleetWakeConfig): { key: string; url: string } | undefined {
  if (!config.chatScope) return undefined;
  try {
    const prefix = new URL(projectConversationPrefix(config.chatScope.projectUrl));
    const observed = new URL(url);
    if (observed.origin !== prefix.origin || !observed.pathname.startsWith(prefix.pathname)) return undefined;
    const id = /^local-chatgpt:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu
      .exec(observed.pathname.slice(prefix.pathname.length));
    if (!id) return undefined;
    // Query/fragment, CDP targetId and DOM task/role hints are not local-chat identity.
    const normalizedUrl = prefix.origin + prefix.pathname + 'local-chatgpt:' + id[1]!.toLowerCase();
    return {
      url: normalizedUrl,
      key: 'local-chat:' + JSON.stringify([config.projectId, config.chatScope.repository, normalizedUrl]),
    };
  } catch { return undefined; }
}

export function bannerOwnerPane(
  banner: Pick<ChatErrorBanner, 'url' | 'issue' | 'pull'>,
  terminals: readonly FleetTerminal[],
  config: FleetWakeConfig,
  readBinding: typeof readChatBinding = readChatBinding,
  headRef: typeof readPrHeadRef = readPrHeadRef,
): FleetTerminal | undefined {
  if (isLocalPlaceholderUrl(banner.url)) return undefined;
  const binding = readBinding(banner.url);
  if (config.architectHandle && binding?.terminal_handle === config.architectHandle) return undefined;
  const launcher = binding?.terminal_handle
    ? terminals.find((terminal) => terminal.handle === binding.terminal_handle && isWorkerPane(terminal, config))
    : undefined;
  if (launcher) return launcher;
  if (binding) {
    const bound = resolve(binding.worktree).replaceAll('\\', '/');
    const owners = terminals.filter((terminal) => {
      if (!isWorkerPane(terminal, config)) return false;
      const worktree = resolve(terminal.worktreePath).replaceAll('\\', '/');
      return bound === worktree || bound.startsWith(`${worktree}/`);
    });
    const owner = singleOwner(owners);
    if (owner) return owner;
  }
  const ref = banner.pull && config.chatScope ? headRef(config.chatScope.repository, banner.pull) : undefined;
  if (ref) {
    const owner = singleOwner(terminals.filter((terminal) => isWorkerPane(terminal, config)
      && terminal.branch === `refs/heads/${ref}`));
    if (owner) return owner;
  }
  if (!banner.issue) return undefined;
  const name = new RegExp(`^[a-z][a-z0-9-]*-${banner.issue}$`, 'i');
  const matches = terminals.filter((terminal) => {
    return isWorkerPane(terminal, config)
      && name.test(basename(terminal.worktreePath.replaceAll('\\', '/')));
  });
  return singleOwner(matches);
}

/**
 * A task that moved to a fresh chat leaves its earlier chats behind; only the
 * newest chat per owner pane (else per Issue, else per PR) stays current.
 */
export function supersededChats(
  chats: readonly ProjectChat[],
  taskKey: (chat: ProjectChat) => string | undefined,
): ProjectChat[] {
  const newest = new Map<string, number>();
  const keys = chats.map((chat) => taskKey(chat));
  chats.forEach((chat, index) => {
    const key = keys[index];
    if (key) newest.set(key, Math.max(newest.get(key) ?? 0, conversationCreatedAt(chat.url)));
  });
  return chats.filter((chat, index) => {
    const key = keys[index];
    return key !== undefined && conversationCreatedAt(chat.url) < newest.get(key)!;
  });
}

export const EXECUTION_CONTINUATION_TEXT = 'Доделай и сообщи статус';
export const REVIEW_CONTINUATION_TEXT = 'Заверши ревью: выдай итоговый вердикт строго в формате из первого сообщения (NO_FINDINGS или JSON с findings). Ничего не исправляй и не меняй код.';

export function managerBannerMessage(banner: ChatErrorBanner): string {
  if (banner.kind === 'unloadable') {
    return `ChatGPT chat ${banner.url} cannot be loaded ("${banner.text}", no composer). The DOM review hint does not prove workflow role. Independently verify the actual owner, role and GitHub-first Browser-GPT send/no-resend authority. Only for confirmed execution, continue the task in a new chat with the reconciled baseline; only for confirmed PR review, Restart the review in a new chat through the review tool. Never press Try again or Retry.`;
  }
  const reason = banner.kind === 'stalled' ? banner.text
    : `red banner "${banner.text}"${banner.retry ? ' (Retry shown)' : ''}`;
  return `ChatGPT chat ${banner.url} stopped (${reason}). A DOM review=true or review=false is not workflow-role proof. Independently verify the actual owner, workflow role and GitHub-first Browser-GPT send/no-resend authority. Only for confirmed execution and an authorized same-chat product-error continuation, send "${EXECUTION_CONTINUATION_TEXT}" in that chat (runbook: up to two repeats, fresh chat on the third continuation failure). Only for confirmed PR review and its authorized same-chat verdict recovery, send "${REVIEW_CONTINUATION_TEXT}" for the verdict only; never ask a reviewer to fix code. Never press Retry.`;
}

export function chatBannerSignature(banners: readonly ChatErrorBanner[]): string {
  return banners
    .map((banner) => `BANNER ${banner.url} ${banner.text}`)
    .sort((left, right) => left.localeCompare(right))
    .join('\n');
}

export function fleetAlarmMessage(
  coordinatorState: 'idle' | 'busy',
  observations: readonly FleetPaneObservation[],
  banners: readonly ChatErrorBanner[] = [],
  alerts: readonly string[] = [],
  localWarnings: readonly string[] = [],
): string {
  const stopped = actionablePanes(observations);
  const panes = stopped.map((pane) => `${pane.state} ${pane.handle} ${pane.title}`).join('; ');
  const paneText = stopped.length > 0
    ? ` ${stopped.length} pane(s) need a step: ${panes} Run your full fleet sweep now (mail, then fleet-sweep) and give every STOPPED/POLLING pane its step this turn. A question a unit typed in its own pane is addressed to you: answer it.`
    : '';
  const unloadable = banners.filter((banner) => banner.kind === 'unloadable');
  const continuable = banners.filter((banner) => banner.kind !== 'unloadable');
  const unloadableText = unloadable.length > 0
    ? ` ${unloadable.length} ChatGPT chat(s) cannot be loaded (no composer): ${unloadable.map((banner) => banner.url).join('; ')}. Independently identify owner/role and verify GitHub-first send authority. Only confirmed execution may continue the task in a new chat with the reconciled baseline; only confirmed PR review may restart review in a new chat through its review tool. Never press Try again or Retry.`
    : '';
  const bannerText = continuable.length > 0
    ? ` ${continuable.length} ChatGPT chat(s) require independent role and delivery reconciliation: ${continuable.map((banner) => `${banner.url} "${banner.text}"${banner.retry ? ' (Retry shown)' : ''}`).join('; ')}. The DOM review flag is untrusted. Only after confirming execution and GitHub-first Browser-GPT send/no-resend authority may its owner use "${EXECUTION_CONTINUATION_TEXT}" in the same chat (runbook: up to two repeats, fresh chat on the third continuation failure); only after confirming PR review and its own recovery authority may its reviewer use "${REVIEW_CONTINUATION_TEXT}" for verdict only, never code fixes. Never press Retry.`
    : '';
  const localText = localWarnings.length > 0
    ? ` ${localWarnings.length} unsaved local ChatGPT chat(s) require independent triage: ${localWarnings.join('; ')}. Owner, workflow role and latest-turn invocation are unproven. Independently reconcile live Task/Issue/PR, workflow role and existing Browser-GPT send/no-resend evidence before any action. This is a coordinator-only warning, not permission to send, resend, continue, review-fix or close a chat. Never press Retry.`
    : '';
  const alertText = alerts.length ? ' ' + alerts.length + ' parked unit(s) need a producer re-check: '
    + alerts.join('; ') + '. Check the named Task and producer before acting.' : '';
  return `Fleet alarm (${coordinatorState}):${paneText}${bannerText}${unloadableText}${localText}${alertText}`;
}

export interface TerminalEnvelopeEvent {
  readonly path: string;
  readonly invocationId: string;
  readonly cwd?: string;
  readonly terminalHandle?: string;
  /** Only present if this is the producer's exact observed invocation, not an attempt-id guess. */
  readonly observedInvocationId?: string;
  readonly sendCount?: number;
  readonly delivery?: DeliveryState;
  readonly conversationLocator?: string;
  readonly persistedObservationProfileKey?: string;
}

export function listTerminalEnvelopes(root = '/tmp/opencode'): TerminalEnvelopeEvent[] {
  const pending = [root];
  const events: TerminalEnvelopeEvent[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || !isWakeableTerminalEnvelopePath(path, root)) continue;
      try {
        const envelope = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        const cwd = typeof envelope.cwd === 'string' ? envelope.cwd : undefined;
        const terminalHandle = typeof envelope.terminal_handle === 'string' ? envelope.terminal_handle : undefined;
        const observedInvocationId = typeof envelope.observed_invocation_id === 'string'
          && envelope.observed_invocation_id.length > 0
          ? envelope.observed_invocation_id
          : undefined;
        const diagnostics = envelope.diagnostics;
        const persistedObservation = diagnostics && typeof diagnostics === 'object' && !Array.isArray(diagnostics)
          ? (diagnostics as Record<string, unknown>).persisted_observation : undefined;
        const profileKey = persistedObservation && typeof persistedObservation === 'object' && !Array.isArray(persistedObservation)
          ? (persistedObservation as Record<string, unknown>).profile_key : undefined;
        const persistedObservationProfileKey = typeof profileKey === 'string' && profileKey.length > 0
          ? profileKey : undefined;
        if (envelope.schema !== TERMINAL_SCHEMA
          || (!cwd && !terminalHandle && !persistedObservationProfileKey)) continue;
        const invocationId = observedInvocationId
          ?? String(envelope.attempt_identity ?? basename(path));
        const sendCount = typeof envelope.send_count === 'number'
          && Number.isSafeInteger(envelope.send_count) && envelope.send_count >= 0
          ? envelope.send_count : undefined;
        const delivery = envelope.delivery === 'POSSIBLY_DELIVERED'
          || envelope.delivery === 'not-sent' || envelope.delivery === 'landed'
          ? envelope.delivery : undefined;
        events.push({
          path, invocationId,
          ...(cwd ? { cwd } : {}),
          ...(terminalHandle ? { terminalHandle } : {}),
          ...(observedInvocationId ? { observedInvocationId } : {}),
          ...(sendCount !== undefined ? { sendCount } : {}),
          ...(delivery ? { delivery } : {}),
          ...(typeof envelope.conversation_locator === 'string' && envelope.conversation_locator.length > 0
            ? { conversationLocator: envelope.conversation_locator } : {}),
          ...(persistedObservationProfileKey ? { persistedObservationProfileKey } : {}),
        });
      } catch {
        // A partial or unrelated terminal artifact is not completion evidence.
      }
    }
  }
  return events.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * The no-result producer exposes only an observation *pointer*, not launcher
 * authority. Result-present envelopes can have send_count without any pointer.
 * In either case a possible sent-unbound turn must never fall through to the
 * legacy terminal-handle/cwd wake, which targets a potentially recycled pane.
 */
export function potentiallySentUnboundEnvelope(event: TerminalEnvelopeEvent): boolean {
  // A send action may have taken effect before a numeric witness was established.
  if (event.delivery === 'POSSIBLY_DELIVERED' && !event.conversationLocator) return true;
  if (event.sendCount !== undefined && event.sendCount >= 1 && !event.conversationLocator) return true;
  if (!event.persistedObservationProfileKey) return false;
  // No pointer scan or fallback to an environment/current-handle occupant.
  if (!event.observedInvocationId || event.observedInvocationId !== event.invocationId) return true;
  try {
    const record = readStateLightTurnObservation(
      event.persistedObservationProfileKey, event.observedInvocationId,
    );
    if (record.phase === 'sent_unbound' && record.conversation_url === null) return true;
    return record.phase === 'dispatching' && record.conversation_url === null;
  } catch {
    // Unreadable owner of a known no-result event gives no effect, not fallback.
    return true;
  }
}

export interface NativePull {
  readonly number: number;
  readonly headSha: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
}

export interface NativeReview {
  readonly id: number;
  readonly state: string;
  readonly commitSha: string;
  readonly submittedAt?: string;
}

export interface PackReviewStageFact {
  readonly state: string;
  readonly description: string;
}

export interface OpenPullHead {
  readonly number: number;
  readonly ref: string;
  readonly sha: string;
  readonly issue?: number;
}

export function listOpenPullHeads(repository: string): OpenPullHead[] {
  const result = runProcessSync({
    command: fileURLToPath(new URL('../gh', import.meta.url)),
    args: [
      'api', `repos/${repository}/pulls?state=open&per_page=100`,
      '--jq', '.[] | {number, ref: .head.ref, sha: .head.sha, body: (.body // "")} | @json',
    ],
    timeoutMs: 15_000,
    inheritParentEnv: true,
  });
  if (!result.ok) return [];
  const pulls: OpenPullHead[] = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const pull = JSON.parse(line) as { number?: unknown; ref?: unknown; sha?: unknown; body?: unknown };
      if (typeof pull.number !== 'number' || typeof pull.ref !== 'string' || typeof pull.sha !== 'string') continue;
      const issue = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s+#(\d+)\b/iu
        .exec(typeof pull.body === 'string' ? pull.body : '')?.[1];
      pulls.push({ number: pull.number, ref: pull.ref, sha: pull.sha, ...(issue ? { issue: Number(issue) } : {}) });
    } catch {
      // Skip a malformed row.
    }
  }
  return pulls;
}

// Latest completion time when every check-run on the sha is completed.
export function checkRunsFinishedAt(repository: string, sha: string): number | undefined {
  const result = runProcessSync({
    command: fileURLToPath(new URL('../gh', import.meta.url)),
    args: ['api', `repos/${repository}/commits/${sha}/check-runs`, '--paginate', '--jq', '.check_runs[] | [.status, (.completed_at // "")] | @tsv'],
    timeoutMs: 15_000,
    inheritParentEnv: true,
  });
  if (!result.ok) return undefined;
  const rows = result.stdout.split(/\r?\n/u).map((row) => row.trim()).filter(Boolean).map((row) => row.split('\t'));
  if (rows.length === 0 || rows.some(([status]) => status !== 'completed')) return undefined;
  const times = rows.map(([, completedAt]) => Date.parse(completedAt ?? '')).filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : undefined;
}

function idlePane(pane: FleetPaneObservation): boolean {
  return pane.state === 'STOPPED' || pane.state === 'PARKED';
}

function onlyPane(panes: readonly FleetPaneObservation[]): FleetPaneObservation | undefined {
  if (panes.length === 1) return panes[0];
  const agents = panes.filter((pane) => pane.agentIdentity);
  return agents.length === 1 ? agents[0] : undefined;
}

function envelopeOwner(cwd: string, panes: readonly FleetPaneObservation[]): FleetPaneObservation | undefined {
  const target = resolve(cwd).replaceAll('\\', '/');
  return onlyPane(panes.filter((pane) => {
    if (!pane.worktreePath) return false;
    const worktree = resolve(pane.worktreePath).replaceAll('\\', '/');
    return target === worktree || target.startsWith(`${worktree}/`);
  }));
}

export function readWorktreeHead(worktreePath: string): string | undefined {
  const result = runProcessSync({
    command: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd: worktreePath,
    timeoutMs: 5_000,
    inheritParentEnv: true,
  });
  const sha = result.ok ? result.stdout.trim() : '';
  return /^[0-9a-f]{40}$/u.test(sha) ? sha : undefined;
}

// A branch pushed under another name still owns the PR when its worktree sits on the PR head.
function pullOwner(
  pull: OpenPullHead,
  panes: readonly FleetPaneObservation[],
  headOf: (worktreePath: string) => string | undefined,
): FleetPaneObservation | undefined {
  const onBranch = onlyPane(panes.filter((pane) => pane.branch === `refs/heads/${pull.ref}`));
  if (onBranch) return onBranch;
  return onlyPane(panes.filter((pane) => pane.worktreePath && headOf(pane.worktreePath) === pull.sha));
}

type OrcaReceipt = { readonly ok?: boolean; readonly result?: Record<string, unknown> };

function executorRunJson(executor: OrcaExecutor) {
  return <T>(args: readonly string[]): OrcaJsonResponse<T> => {
    const result = executor([...args, '--json']);
    const operation = resolveOrcaOperation(args);
    if (result.stdout.trim()) return parseOrcaJsonOutput<T>(result.stdout, operation);
    return {
      ok: false,
      operation,
      outcomeCategory: 'supported_operation_failure',
      error: { code: 'orca_process_exit_without_output', message: result.stderr || `orca ${args.join(' ')} failed` },
    };
  };
}

function listUnreadRunMessages(
  coordinatorHandle: string,
  executor: OrcaExecutor,
  projectId: string,
): RunMailWakeEvent[] {
  const runJson = executorRunJson(executor);
  const adapter = new OrcaRuntimeAdapter({ runJson });
  const runPaneKeyPath = join(
    resolveWakeSupervisorStateRoot({ projectId }),
    basename(ORCHESTRATION_RUN_PANE_KEY_PATH),
  );
  const mail = createOrcaMessageSubmitDeps(
    adapter,
    createAdapterSubmitDeps(adapter),
    runJson,
    runPaneKeyPath,
  );
  const inbox = mail.readInbox?.();
  if (!inbox?.ok) return [];

  const byRun = new Map<string, Array<{ id: string; toHandle: string; subject: string; fromHandle: string }>>();
  for (const row of inbox.result?.messages ?? []) {
    const message = row as typeof row & { readonly subject?: unknown; readonly from_handle?: unknown };
    const id = message.id?.trim() ?? '';
    const runId = message.run_id?.trim() ?? '';
    const toHandle = message.to_handle?.trim() ?? '';
    const subject = typeof message.subject === 'string' ? message.subject.trim() : '';
    const fromHandle = typeof message.from_handle === 'string' ? message.from_handle.trim() : '';
    if (!id || !runId || !subject || !fromHandle || toHandle !== `run:${runId}`
      || message.read === 1 || message.read === true) continue;
    const rows = byRun.get(runId) ?? [];
    rows.push({ id, toHandle, subject, fromHandle });
    byRun.set(runId, rows);
  }

  const events: RunMailWakeEvent[] = [];
  for (const [runId, rows] of byRun) {
    const resolved = mail.resolveWorker({
      id: rows[0]!.id,
      runId,
      recipient: `run:${runId}`,
      consumed: false,
    });
    if (!resolved.ok || !resolved.worker || resolved.worker.identity.id !== coordinatorHandle) continue;

    for (const message of rows) {
      events.push({
        id: message.id,
        subject: message.subject,
        toHandle: message.toHandle,
        fromHandle: message.fromHandle,
      });
    }
  }
  return events;
}
function orcaReceipt(executor: OrcaExecutor, args: string[]): Record<string, unknown> | undefined {
  const result = executor(args);
  if (!result.ok) return undefined;
  try {
    const receipt = JSON.parse(result.stdout) as OrcaReceipt;
    return receipt.ok === true && receipt.result ? receipt.result : undefined;
  } catch {
    return undefined;
  }
}

function supervisedOwnerForPull(
  pull: OpenPullHead,
  panes: readonly FleetPaneObservation[],
  executor: OrcaExecutor,
): FleetPaneObservation | undefined {
  if (!pull.issue) return undefined;
  const runs = orcaReceipt(executor, ['orchestration', 'run-list', '--json'])?.runs;
  if (!Array.isArray(runs)) return undefined;
  const candidates: Array<{ taskId: string }> = [];
  for (const value of runs) {
    if (!value || typeof value !== 'object') continue;
    const run = value as { id?: unknown; objective?: unknown };
    if (typeof run.id !== 'string' || typeof run.objective !== 'string') continue;
    if (!new RegExp(`(?:#${pull.issue}\\b|issues/${pull.issue}\\b)`, 'iu').test(run.objective)) continue;
    const tasks = orcaReceipt(executor, ['orchestration', 'task-list', '--run', run.id, '--json'])?.tasks;
    if (!Array.isArray(tasks)) continue;
    for (const taskValue of tasks) {
      if (!taskValue || typeof taskValue !== 'object') continue;
      const task = taskValue as { id?: unknown; spec?: unknown; status?: unknown };
      if (typeof task.id !== 'string' || typeof task.spec !== 'string' || task.status !== 'dispatched') continue;
      if (new RegExp(`(?:#${pull.issue}\\b|issues/${pull.issue}\\b)`, 'iu').test(task.spec)) {
        candidates.push({ taskId: task.id });
      }
    }
  }
  const owners: FleetPaneObservation[] = [];
  for (const candidate of candidates) {
    const dispatch = orcaReceipt(executor, ['orchestration', 'dispatch-show', '--task', candidate.taskId, '--json'])?.dispatch as
      { id?: unknown; status?: unknown; assignee_handle?: unknown } | undefined;
    if (dispatch?.status !== 'dispatched' || typeof dispatch.id !== 'string') continue;
    const worker = orcaReceipt(executor, ['orchestration', 'worker-show', '--dispatch', dispatch.id, '--json']);
    if (!worker) continue;
    const workerDispatch = worker.dispatch as { taskId?: unknown; status?: unknown } | undefined;
    const terminal = worker.terminal as { handle?: unknown; worktreePath?: unknown; branch?: unknown } | undefined;
    const observation = worker.observation as { status?: unknown; exactWorker?: unknown } | undefined;
    if (workerDispatch?.taskId !== candidate.taskId || workerDispatch.status !== 'dispatched'
      || observation?.status !== 'live' || observation.exactWorker !== true
      || typeof terminal?.handle !== 'string' || terminal.handle !== dispatch.assignee_handle) continue;
    const pane = panes.find((item) => item.handle === terminal.handle
      && item.worktreePath === terminal.worktreePath && item.branch === terminal.branch);
    if (pane) owners.push(pane);
  }
  return owners.length === 1 ? owners[0] : undefined;
}

const REMINDER_INTERVAL_MS = 30 * 60 * 1_000;
const SHA40 = /^[0-9a-f]{40}$/u;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

type ProducerKind = 'gpt' | 'pack-review' | 'review' | 'ci' | 'merge' | 'terminal';
interface NamedProducer {
  readonly kind: ProducerKind;
  readonly label: string;
  readonly id?: string;
  readonly number?: number;
  readonly sha?: string;
  readonly reviewId?: number;
  readonly handle?: string;
  readonly incarnation?: string;
  readonly mergeAgent?: boolean;
}
interface ProducerResolution {
  readonly state: 'ended' | 'pending' | 'unresolvable';
  readonly label: string;
  readonly terminalState?: string;
  readonly evidence?: string;
  readonly legacyKey?: string;
}

// Only a complete, single, exact own response is a supported dependency.
// The one known suffix adds no condition; "resume when ..." and similar
// semantic tails must not be discarded to make a producer appear resolved.
export function parseNamedParkedProducer(wait: string): NamedProducer | undefined {
  const source = wait.endsWith(' (self-wake armed)')
    ? wait.slice(0, -' (self-wake armed)'.length) : wait;
  let match = new RegExp('^PARKED on GPT turn (' + UUID + ')$', 'u').exec(source);
  if (match) return { kind: 'gpt', label: 'GPT-turn-' + match[1], id: match[1] };
  match = /^PARKED on pack-review PR #([1-9]\d*) head ([0-9a-f]{40})$/u.exec(source);
  if (match) return { kind: 'pack-review', label: 'pack-review-PR-' + match[1], number: Number(match[1]), sha: match[2] };
  match = /^PARKED on PR #([1-9]\d*) review #([1-9]\d*) head ([0-9a-f]{40})$/u.exec(source);
  if (match) return { kind: 'review', label: 'review-' + match[2] + '-PR-' + match[1], number: Number(match[1]), reviewId: Number(match[2]), sha: match[3] };
  match = /^PARKED on CI PR #([1-9]\d*) head ([0-9a-f]{40})$/u.exec(source);
  if (match) return { kind: 'ci', label: 'CI-PR-' + match[1], number: Number(match[1]), sha: match[2] };
  match = /^PARKED on CI on ([0-9a-f]{40})$/u.exec(source);
  if (match) return { kind: 'ci', label: 'CI-' + match[1], sha: match[1] };
  match = /^PARKED on (?:merge-([1-9]\d*)|PR #([1-9]\d*) merged|#([1-9]\d*) merged into main)$/u.exec(source);
  if (match) {
    const number = Number(match[1] ?? match[2] ?? match[3]);
    return { kind: 'merge', label: 'merge-PR-' + number, number };
  }
  match = /^PARKED on terminal ([A-Za-z0-9_.:-]+) incarnation ([A-Za-z0-9_.:-]+)$/u.exec(source);
  if (match) return { kind: 'terminal', label: 'terminal-' + match[1], handle: match[1], incarnation: match[2] };
  match = /^PARKED on merge agent terminal ([A-Za-z0-9_.:-]+) incarnation ([A-Za-z0-9_.:-]+) PR #([1-9]\d*)$/u.exec(source);
  if (match) return { kind: 'terminal', label: 'merge-agent-terminal-' + match[1] + '-PR-' + match[3],
    handle: match[1], incarnation: match[2], number: Number(match[3]), mergeAgent: true };
  return undefined;
}

function githubJson(repository: string, endpoint: string): Record<string, unknown> | undefined {
  const result = runProcessSync({
    command: fileURLToPath(new URL('../gh', import.meta.url)),
    args: ['api', 'repos/' + repository + '/' + endpoint],
    timeoutMs: 15_000,
    inheritParentEnv: true,
  });
  if (!result.ok) return undefined;
  try {
    const value: unknown = JSON.parse(result.stdout);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function readNativePull(repository: string, number: number): NativePull | undefined {
  const row = githubJson(repository, 'pulls/' + number);
  const head = row?.head as { sha?: unknown } | undefined;
  if (row?.number !== number || !SHA40.test(String(head?.sha ?? ''))
    || (row?.state !== 'open' && row?.state !== 'closed') || typeof row?.merged !== 'boolean') return undefined;
  return { number, headSha: String(head!.sha), state: row.state, merged: row.merged };
}

function readNativeReview(repository: string, number: number, reviewId: number): NativeReview | undefined {
  const row = githubJson(repository, 'pulls/' + number + '/reviews/' + reviewId);
  if (row?.id !== reviewId || typeof row?.state !== 'string'
    || !SHA40.test(String(row.commit_id ?? ''))) return undefined;
  return {
    id: reviewId, state: row.state, commitSha: String(row.commit_id),
    ...(typeof row.submitted_at === 'string' ? { submittedAt: row.submitted_at } : {}),
  };
}

function readPackReviewStatus(repository: string, sha: string): PackReviewStageFact | undefined {
  // Current-head status is in GitHub's newest-first order. Its exact runner
  // description, not a generic semantic direct-review projection, is evidence
  // that the named aggregate producer actually reached a terminal outcome.
  const row = githubJson(repository, 'commits/' + sha + '/status');
  const statuses = row?.statuses;
  if (!Array.isArray(statuses)) return undefined;
  const current = statuses.find((value: unknown) => Boolean(value) && typeof value === 'object'
    && (value as { context?: string }).context === 'orchestrator-pack/pack-review') as
    { state?: unknown; description?: unknown } | undefined;
  return typeof current?.state === 'string' && typeof current.description === 'string'
    ? { state: current.state, description: current.description } : undefined;
}

function exactParkedTask(pane: FleetPaneObservation, projectId: string): readonly string[] | undefined {
  if (pane.state !== 'PARKED' || !pane.wait || !pane.incarnationId
    || pane.status?.toLowerCase() === 'exited' || !pane.taskBinding) return undefined;
  try {
    const tuple: unknown = JSON.parse(pane.taskBinding);
    if (!Array.isArray(tuple) || tuple.length !== 7
      || !tuple.every((part) => typeof part === 'string' && part.length > 0)
      || tuple[0] !== projectId || tuple[1] !== pane.handle || tuple[2] !== pane.incarnationId
      || tuple[3] !== pane.worktreePath || tuple[4] !== pane.branch) return undefined;
    return tuple as string[];
  } catch { return undefined; }
}

function resolveNamedProducer(
  producer: NamedProducer,
  pane: FleetPaneObservation,
  terminals: readonly FleetTerminal[],
  options: FleetAlarmTickOptions,
): ProducerResolution {
  const unknown: ProducerResolution = { state: 'unresolvable', label: producer.label };
  const pending: ProducerResolution = { state: 'pending', label: producer.label };
  const ended = (state: string, evidence: string, legacyKey?: string): ProducerResolution => ({
    state: 'ended', label: producer.label, terminalState: state, evidence,
    ...(legacyKey ? { legacyKey } : {}),
  });
  if (producer.kind === 'gpt') {
    const events = (options.listTerminalEnvelopes ?? listTerminalEnvelopes)();
    const matches = events.filter((event) => event.observedInvocationId === producer.id
      && isWakeableTerminalEnvelopePath(event.path, '/tmp/opencode'));
    if (matches.length !== 1) return unknown;
    const event = matches[0]!;
    if (!event.terminalHandle || event.terminalHandle !== pane.handle || !event.cwd
      || !samePath(event.cwd, pane.worktreePath) || potentiallySentUnboundEnvelope(event)) return unknown;
    return ended('terminal-envelope', event.path, 'gpt:' + event.path);
  }
  const repository = options.config.chatScope?.repository;
  if (producer.kind === 'terminal') {
    if (!producer.handle || !producer.incarnation) return unknown;
    if (producer.mergeAgent) {
      if (!repository || !producer.number) return unknown;
      const pull = (options.readNamedPull ?? readNativePull)(repository, producer.number);
      if (!pull || pull.number !== producer.number) return unknown;
    }
    const found = terminals.filter((item) => item.handle === producer.handle
      && item.incarnationId === producer.incarnation);
    if (found.length !== 1) return unknown;
    const term = found[0]!;
    if (term.status?.toLowerCase() === 'exited') {
      return ended('terminal-exited', 'orca://terminal/list/' + producer.handle + '/' + producer.incarnation);
    }
    return term.status?.toLowerCase() === 'running' && Boolean(term.agentIdentity) ? pending : unknown;
  }
  if (!repository) return unknown;
  let number = producer.number;
  if (producer.kind === 'ci' && number === undefined && producer.sha) {
    const heads = (options.listOpenPulls ?? listOpenPullHeads)(repository)
      .filter((pull) => pull.sha === producer.sha);
    if (heads.length !== 1) return unknown;
    number = heads[0]!.number;
  }
  if (!number || !Number.isSafeInteger(number)) return unknown;
  const pull = (options.readNamedPull ?? readNativePull)(repository, number);
  if (!pull || pull.number !== number) return unknown;
  const url = 'https://github.com/' + repository + '/pull/' + number;
  if (producer.kind === 'merge') {
    if (pull.merged === true) return ended('merged', url);
    return pull.state === 'open' ? pending : unknown;
  }
  if (pull.state !== 'open' || pull.headSha !== producer.sha || !SHA40.test(pull.headSha)) return unknown;
  if (producer.kind === 'pack-review') {
    const fact = (options.readPackReviewStage ?? readPackReviewStatus)(repository, pull.headSha);
    const stageEvidence = url + '/commits/' + pull.headSha;
    const description = fact?.description.trim().toLowerCase();
    if (fact?.state === 'success' && (
      description === 'pack review completed with no findings.'
      || description === 'pack review completed with non-blocking findings.'
      || description === 'required pack-review stage completed; no additional review round required.'
      || description === 'required pack-review stage completed; strict descendant of reviewed findings.'
    )) return ended('stage-complete', stageEvidence);
    if (fact?.state === 'failure' && description === 'pack review found blocking issues.') {
      return ended('stage-findings', stageEvidence);
    }
    return fact?.state === 'pending' ? pending : unknown;
  }
  if (producer.kind === 'review') {
    if (!producer.reviewId || !Number.isSafeInteger(producer.reviewId)) return unknown;
    const review = (options.readNamedReview ?? readNativeReview)(repository, number, producer.reviewId);
    if (!review || review.id !== producer.reviewId || review.commitSha !== pull.headSha) return unknown;
    if (review.state === 'PENDING') return pending;
    return review.submittedAt && ['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)
      ? ended('review-submitted', url + '#pullrequestreview-' + review.id) : unknown;
  }
  const at = (options.checkRunsFinishedAt ?? checkRunsFinishedAt)(repository, pull.headSha);
  return at !== undefined && Number.isFinite(at)
    ? ended('checks-completed', url + '/checks', 'ci:' + number + ':' + pull.headSha + ':' + at)
    : pending;
}

// All interpolations and the fixed words pass one physical-line whitelist.
// Encode unsafe evidence bytes rather than reintroducing shell punctuation.
function safeUnitAtom(input: string): string | undefined {
  if (!input || input.length > 512) return undefined;
  const encoded = Array.from(input).map((char) => /^[A-Za-z0-9_.:/%#=+-]$/u.test(char)
    ? char : Array.from(Buffer.from(char)).map((byte) => '%' + byte.toString(16).padStart(2, '0')).join('')).join('');
  return encoded.length <= 240 && /^[A-Za-z0-9_.:/%#=+-]+$/u.test(encoded) ? encoded : undefined;
}

export function safeUnitWakeText(producer: string, state: string, evidence: string): string | undefined {
  const p = safeUnitAtom(producer), s = safeUnitAtom(state), e = safeUnitAtom(evidence);
  if (!p || !s || !e) return undefined;
  const message = 'Wake: ' + p + ' ended state ' + s + ' evidence ' + e
    + ' - re-check the producer yourself before continuing';
  return /^[A-Za-z0-9 _./:%#=+-]+$/u.test(message) ? message : undefined;
}

function safeUnitReminderText(producer: string): string | undefined {
  const p = safeUnitAtom(producer);
  if (!p) return undefined;
  const message = 'Reminder: parked 30 min on ' + p
    + ' - re-check its envelope or PR or CI state yourself - continue only if ended otherwise re-park with the same line';
  return /^[A-Za-z0-9 _./:%#=+-]+$/u.test(message) ? message : undefined;
}

async function sendMarkedUnitMessage(
  store: FleetWakeStateStore, key: string, handle: string, message: string,
  executor: OrcaExecutor, sleepMs: (milliseconds: number) => void | Promise<void>,
  log: (line: string) => void,
  legacyKey?: string,
): Promise<boolean> {
  // Both marks must be durable before the first potentially effectful send.
  // An uncertain result forbids replays through either the named or legacy path.
  try {
    store.markParkedWakeEvent(key, 'attempted_unverified');
    if (legacyKey) store.markParkedWakeEvent(legacyKey, 'attempted_unverified');
  } catch { log('unit mark unwritable: ' + key); return false; }
  let delivered = false;
  try {
    delivered = sendCoordinator(executor, handle, message)
      && (await sleepMs(4_000), submitCoordinator(executor, handle));
  } catch { /* A timeout can have delivered text; no automatic retry. */ }
  if (!delivered) { log('unit attempted_unverified: ' + key); return false; }
  try {
    store.markParkedWakeEvent(key, 'sent');
    if (legacyKey) store.markParkedWakeEvent(legacyKey, 'sent');
  } catch { log('unit sent but mark remains uncertain: ' + key); return false; }
  log('sent re-check to ' + handle + ': ' + key);
  return true;
}

async function wakeNamedParkedProducers(
  options: FleetAlarmTickOptions,
  observations: readonly FleetPaneObservation[],
  terminals: readonly FleetTerminal[],
  store: FleetWakeStateStore,
  executor: OrcaExecutor,
  sleepMs: (milliseconds: number) => void | Promise<void>,
  log: (line: string) => void,
): Promise<{ alerts: string[]; claimedLegacy: Set<string> }> {
  const alerts: string[] = [];
  const claimedLegacy = new Set<string>();
  const observed = new Map<string, string>();
  const now = (options.now ?? Date.now)();
  for (const pane of observations) {
    if (pane.state !== 'PARKED' || !pane.wait || /^PARKED on orchestrator answer:/u.test(pane.wait)) continue;
    const producer = parseNamedParkedProducer(pane.wait);
    const tuple = exactParkedTask(pane, options.config.projectId);
    if (!tuple || !producer) {
      alerts.push('park on unresolvable producer ' + (safeUnitAtom(pane.handle) ?? 'unknown')
        + ' ' + createHash('sha256').update(JSON.stringify([
          options.config.projectId, pane.handle, pane.incarnationId, pane.taskBinding, pane.branch, pane.wait,
        ])).digest('hex').slice(0, 12));
      continue;
    }
    const episode = createHash('sha256').update(JSON.stringify([tuple, pane.wait])).digest('hex').slice(0, 32);
    observed.set(pane.handle, episode);
    // Retain the first observation as park-episode identity even after a successful
    // Wake resets the reminder clock. A changed wait/Task creates a fresh episode.
    let epoch = store.readParkedEpoch?.(pane.handle);
    if (epoch?.key !== episode) {
      epoch = { key: episode, since: now, started: now };
      store.writeParkedEpoch?.(pane.handle, epoch);
    }
    const episodeInstance = episode + ':' + String(epoch?.started ?? epoch?.since ?? now);
    let resolution: ProducerResolution;
    try { resolution = resolveNamedProducer(producer, pane, terminals, options); }
    catch { resolution = { label: producer.label, state: 'unresolvable' }; }
    if (resolution.state === 'unresolvable') {
      alerts.push('park on unresolvable producer ' + (safeUnitAtom(pane.handle) ?? 'unknown')
        + ' ' + episode.slice(0, 12));
    }
    const legacyCoalesced = Boolean(resolution.legacyKey
      && store.hasParkedWakeEvent(resolution.legacyKey));
    const eventKey = 'producer:' + pane.handle + ':' + episodeInstance + ':'
      + createHash('sha256').update(JSON.stringify(resolution)).digest('hex').slice(0, 32);
    const attempted = store.readParkedWakeEventStatus(eventKey);
    // Preserve coordinator visibility after either Enter failure or a failed
    // coordinator send/read. The normal signature clock throttles repeat alarms.
    if (attempted === 'attempted_unverified') {
      alerts.push('uncertain unit Wake ' + (safeUnitAtom(pane.handle) ?? 'unknown') + ' ' + episode.slice(0, 12));
    }
    if (resolution.state === 'ended' && resolution.legacyKey && attempted) {
      claimedLegacy.add(resolution.legacyKey);
    }
    if (resolution.state === 'ended' && !legacyCoalesced && !attempted) {
      const wake = safeUnitWakeText(producer.label, resolution.terminalState ?? '', resolution.evidence ?? '');
      if (!wake) {
        alerts.push('park on unresolvable producer ' + (safeUnitAtom(pane.handle) ?? 'unknown') + ' unsafe-evidence');
      } else {
        const sent = await sendMarkedUnitMessage(store, eventKey, pane.handle, wake, executor, sleepMs, log,
          resolution.legacyKey);
        if (resolution.legacyKey && store.hasParkedWakeEvent(resolution.legacyKey)) {
          claimedLegacy.add(resolution.legacyKey);
        }
        if (sent) {
          if (epoch) store.writeParkedEpoch?.(pane.handle, { ...epoch, since: now });
          store.clearPaneWait?.(pane.handle);
          continue;
        }
        alerts.push('uncertain unit Wake ' + (safeUnitAtom(pane.handle) ?? 'unknown') + ' ' + episode.slice(0, 12));
      }
    }
    // Park age is measured from first eligible observation or the last successful
    // event Wake, never a wall-clock half-hour bucket. An uncertain Wake permits reminders.
    if (epoch && Number.isFinite(now) && now >= epoch.since + REMINDER_INTERVAL_MS) {
      const slot = Math.floor((now - epoch.since) / REMINDER_INTERVAL_MS);
      const reminderKey = 'reminder:' + pane.handle + ':' + episode + ':' + epoch.since + ':' + slot;
      if (slot >= 1) {
        const reminderStatus = store.readParkedWakeEventStatus(reminderKey);
        if (reminderStatus === 'attempted_unverified') {
          alerts.push('uncertain unit Reminder ' + (safeUnitAtom(pane.handle) ?? 'unknown') + ' ' + episode.slice(0, 12));
        } else if (!reminderStatus) {
          const message = safeUnitReminderText(producer.label);
          if (!message || !await sendMarkedUnitMessage(store, reminderKey, pane.handle, message, executor, sleepMs, log)) {
            alerts.push('uncertain unit Reminder ' + (safeUnitAtom(pane.handle) ?? 'unknown') + ' ' + episode.slice(0, 12));
          }
        }
      }
    }
  }
  store.pruneParkedEpochs?.(observed);
  return { alerts, claimedLegacy };
}

/**
 * Wakes idle panes for their own completed events and wakes the coordinator
 * for parked FLEET units or unread Run mail. The event marks suppress repeat wakes.
 */
async function wakePanesOnEvents(
  options: FleetAlarmTickOptions,
  coordinator: FleetTerminal,
  observations: readonly FleetPaneObservation[],
  executor: OrcaExecutor,
  store: FleetWakeStateStore,
  log: (line: string) => void,
  sleepMs: (milliseconds: number) => void | Promise<void>,
  claimedLegacy: ReadonlySet<string>,
): Promise<void> {
  const wakes: Array<{ pane: FleetTerminal | FleetPaneObservation; key: string; message: string }> = [];
  for (const envelope of (options.listTerminalEnvelopes ?? listTerminalEnvelopes)()) {
    const key = `gpt:${envelope.path}`;
    if (claimedLegacy.has(key)) continue;
    if (potentiallySentUnboundEnvelope(envelope)) {
      log(`skip unsafe GPT terminal wake: owner_generation_unproven ${key}`);
      continue;
    }
    const pane = envelope.terminalHandle !== undefined
      ? observations.find((candidate) =>
        candidate.handle === envelope.terminalHandle)
      : envelope.cwd
        ? envelopeOwner(envelope.cwd, observations)
        : undefined;
    if (!pane || !idlePane(pane) || store.hasParkedWakeEvent(key)) continue;
    wakes.push({ pane, key, message: `Wake: GPT turn ${envelope.invocationId} ended, read ${envelope.path}` });
  }
  const parkedEpisodes = observations.flatMap((pane) => {
    if (!pane.worktreePath) return [];
    const lastLine = pane.wait ?? '';
    const parked = pane.state === 'PARKED' ? /^PARKED on orchestrator answer:\s*(.+)$/iu.exec(lastLine) : null;
    return parked ? [{ pane, parked, key: `parked:${pane.handle}:${pane.taskBinding ?? pane.incarnationId ?? ''}:${lastLine}` }] : [];
  });
  const activeParkedKeyByHandle = new Map(
    parkedEpisodes.map(({ pane, key }) => [pane.handle, key] as const),
  );
  const observedParkedKeys = new Map<string, string | null>();
  for (const pane of observations) {
    observedParkedKeys.set(pane.handle, activeParkedKeyByHandle.get(pane.handle) ?? null);
  }
  store.rearmParkedWakeEvents(observedParkedKeys);
  for (const { pane, parked, key } of parkedEpisodes) {
    if (!store.hasParkedWakeEvent(key)) {
      wakes.push({ pane: coordinator, key, message: `Wake: FLEET unit ${pane.handle} parked on orchestrator answer: ${parked[1]}` });
    }
  }
  const unread = options.listUnreadRunMessages
    ? options.listUnreadRunMessages(coordinator.handle)
    : listUnreadRunMessages(coordinator.handle, executor, options.config.projectId);
  for (const event of unread) {
    if (event.toHandle === coordinator.handle || !event.toHandle.startsWith('run:')) continue;
    const key = `mail:${event.fromHandle}:${event.id}`;
    if (store.hasParkedWakeEvent(key)) continue;
    wakes.push({ pane: coordinator, key, message: `Wake: FLEET unit ${event.fromHandle} sent Run message: ${event.subject}` });
  }
  const repository = options.config.chatScope?.repository;
  if (repository && observations.some(idlePane)) {
    const finishedAt = options.checkRunsFinishedAt ?? checkRunsFinishedAt;
    const ownerForPull = options.supervisedPullOwner ?? ((candidate, panes) => supervisedOwnerForPull(candidate, panes, executor));
    const readHead = options.readWorktreeHead ?? readWorktreeHead;
    const heads = new Map<string, string | undefined>();
    const headOf = (worktreePath: string): string | undefined => {
      if (!heads.has(worktreePath)) heads.set(worktreePath, readHead(worktreePath));
      return heads.get(worktreePath);
    };
    for (const pull of (options.listOpenPulls ?? listOpenPullHeads)(repository)) {
      const at = finishedAt(repository, pull.sha);
      if (at === undefined) continue;
      // An exact supervised manager wins; a manager started outside orchestration owns the PR by its head.
      const pane = (pull.issue ? ownerForPull(pull, observations) : undefined) ?? pullOwner(pull, observations, headOf);
      // A re-run of failed checks on the same head is a new event.
      const key = `ci:${pull.number}:${pull.sha}:${at}`;
      if (claimedLegacy.has(key)) continue;
      if (!pane) {
        const unowned = `ci-unowned:${pull.number}:${pull.sha}:${at}`;
        if (!store.hasParkedWakeEvent(unowned)) {
          store.markParkedWakeEvent(unowned);
          log(`no owner pane for PR #${pull.number}: CI finished on ${pull.sha}`);
        }
        continue;
      }
      if (!idlePane(pane) || store.hasParkedWakeEvent(key)) continue;
      wakes.push({ pane, key, message: `Wake: CI on ${pull.sha} finished for PR #${pull.number}` });
    }
  }
  for (const { pane, key, message } of wakes) {
    const delivered = sendCoordinator(executor, pane.handle, message)
      && (await sleepMs(4_000), submitCoordinator(executor, pane.handle));
    if (!delivered) {
      log(`event wake send failed to ${pane.handle}: ${key}`);
      continue;
    }
    store.markParkedWakeEvent(key);
    if (pane.handle !== coordinator.handle) store.clearPaneWait?.(pane.handle);
    log(`sent event wake to ${pane.handle}: ${key}`);
  }
}
 
function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function sendCoordinator(
  executor: OrcaExecutor,
  handle: string,
  message: string,
): boolean {
  return executor(['terminal', 'send', '--terminal', handle, '--text', message, '--enter']).ok;
}

function submitCoordinator(executor: OrcaExecutor, handle: string): boolean {
  return executor(['terminal', 'send', '--terminal', handle, '--enter']).ok;
}

// Bounded pre-effect native census. This is not an atomic generation guard on
// the handle-only Orca sender: a replacement inside terminal send is still possible.
function coordinatorStillSelected(expected: FleetTerminal, config: FleetWakeConfig, executor: OrcaExecutor): boolean {
  try {
    const current = listFleetTerminals(executor);
    const selected = resolveCoordinatorPane(current, config);
    return current.filter((pane) => pane.handle === expected.handle).length === 1
      && selected?.handle === expected.handle && selected.status !== 'exited'
      && samePath(selected.worktreePath, expected.worktreePath)
      && selected.incarnationId === expected.incarnationId;
  } catch { return false; }
}

// A separate, read-only tick projection. It never receives delivery/actionable state,
// and neither its rows nor its page evidence can become wake admission or retry authority.
export interface FleetDiagnosticTickOptions {
  readonly config: FleetWakeConfig;
  readonly executor?: OrcaExecutor;
  readonly store?: FleetPollingStore;
  readonly terminals?: readonly FleetTerminal[];
  readonly observations?: readonly FleetPaneObservation[];
  readonly observedChats?: readonly ProjectChat[];
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly readChats?: (cdpUrl: string, scope: ChatBannerScope) => Promise<ProjectChat[]>;
}

export async function runFleetDiagnosticTick(options: FleetDiagnosticTickOptions): Promise<void> {
  const { config } = options;
  const executor = options.executor ?? defaultOrcaExecutor;
  const store = options.store ?? new FileFleetStateStore(config.projectId);
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  let terminals: readonly FleetTerminal[];
  try {
    terminals = options.terminals ?? listFleetTerminals(executor);
  } catch {
    log('DIAG handle=none incarnation=unknown state=unverified reason=fleet_census_unreadable evidence=terminal list --json: incomplete_or_malformed');
    return;
  }
  const rows = collectFleetDiagnostics({
    projectId: config.projectId, primary: config.primary, workspaceRe: config.workspaceRe,
    coordinatorHandle: config.orchestratorHandle,
    coordinatorTitleRe: config.orchestratorTitleRe, architectHandle: config.architectHandle,
    busyRe: config.busyRe, executor, store, terminals,
    ...(options.observations ? { observations: options.observations } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  for (const line of formatFleetDiagnostics(rows).split('\n').filter(Boolean)) log(line);

  // Positive ORCH_HANDLE only selects an exact pane. An unpinned title match can
  // be ambiguous; neither proves a live child agent or changes the old resolver.
  const matches = terminals.filter((terminal) => {
    config.orchestratorTitleRe.lastIndex = 0;
    return Boolean(terminal.worktreePath) && samePath(terminal.worktreePath, config.primary)
      && config.orchestratorTitleRe.test(terminal.title);
  });
  if (!config.orchestratorHandle && matches.length > 1) {
    log(`DIAG reason=coordinator_ambiguous candidates=${matches.map((pane) => pane.handle).join(',')} evidence=primary-title-matches; no_live_agent_witness`);
  } else {
    const selected = config.orchestratorHandle
      ? resolveCoordinatorPane(terminals, config)
      : matches.length === 1 ? matches[0] : undefined;
    log(`DIAG reason=coordinator_unverified selected=${selected?.handle ?? 'none'} evidence=${config.orchestratorHandle ? 'ORCH_HANDLE exact_selection_only' : 'primary-title-predicate_only'}; no_live_agent_witness`);
  }

  if (config.chatCdpUrl && config.chatScope) {
    const chats = options.observedChats ?? await (options.readChats ?? readProjectChats)(config.chatCdpUrl, config.chatScope).catch(() => []);
    for (const chat of chats) {
      for (const banner of chat.banners) {
        log(`DIAG banner_kind=${banner.kind} url=${banner.url} retry_control_observed=${banner.retry === true} generation_observed=${chat.generating === true} attribution=tentative/unbound evidence=DOM_structure_only; banner_text_untrusted`);
      }
    }
  }
}

export async function runFleetAlarmTick(options: FleetAlarmTickOptions): Promise<FleetAlarmTickResult> {
  const { config } = options;
  const executor = options.executor ?? defaultOrcaExecutor;
  const store = options.store ?? new FileFleetWakeStateStore(config.projectId);
  const sleepMs = options.sleepMs ?? defaultSleep;
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  let terminals: FleetTerminal[];
  try {
    terminals = listFleetTerminals(executor);
  } catch {
    log('DIAG handle=none incarnation=unknown state=unverified reason=fleet_census_unreadable evidence=terminal list --json: incomplete_or_malformed');
    log('terminal list unreadable');
    return { state: 'unreadable', handle: 'terminal-list' };
  }

  // Legacy events and banners run first; advisory reads never delay their effects.
  // The same browser snapshot is reused for logging, with no second CDP scan.
  let operationalObservations: FleetPaneObservation[] | undefined;
  let activeChats: ProjectChat[] = [];
  try {
    const coordinator = resolveCoordinatorPane(terminals, config);
    if (!coordinator) {
      log('normal fleet result: no orchestrator pane found');
      return { state: 'no_orchestrator' };
    }

    let observations: FleetPaneObservation[];
    try {
      observations = runFleetSweep({
        primary: config.primary,
        projectId: config.projectId,
        workspaceRe: config.workspaceRe,
        coordinatorHandle: coordinator.handle,
        coordinatorTitleRe: config.orchestratorTitleRe,
        architectHandle: config.architectHandle,
        busyRe: config.busyRe,
        executor,
        store,
        terminals,
      });
      operationalObservations = observations;
    } catch (error) {
      if (error instanceof FleetScreenReadError) {
        log(`${error.handle} unreadable`);
        return { state: 'unreadable', handle: error.handle };
      }
      log('fleet sweep unreadable');
      return { state: 'unreadable', handle: 'fleet-sweep' };
    }

    const parked = await wakeNamedParkedProducers(
      options, observations, terminals, store, executor, sleepMs, log,
    );
    const parkedAlerts = parked.alerts;
    await wakePanesOnEvents(options, coordinator, observations, executor, store, log, sleepMs, parked.claimedLegacy);

    const chats = config.chatCdpUrl && config.chatScope
      ? await (options.readChats ?? readProjectChats)(config.chatCdpUrl, config.chatScope).catch(() => [])
      : [];
    const superseded = new Set(supersededChats(chats, (chat) => {
      // A local placeholder cannot authorize Issue/PR-based destructive tab closure.
      if (isLocalPlaceholderUrl(chat.url)) return undefined;
      const owner = bannerOwnerPane(chat, terminals, config);
      if (owner) return `pane ${owner.handle}`;
      if (chat.issue) return `issue ${chat.issue}`;
      return chat.pull ? `pull ${chat.pull}` : undefined;
    }));
    for (const chat of superseded) {
      if (chat.generating) continue;
      const closed = await (options.closeChat ?? closeChatTarget)(config.chatCdpUrl!, chat.targetId);
      log(`${closed ? 'closed' : 'close failed for'} superseded chat ${chat.url}`);
    }
    activeChats = chats.filter((chat) => !superseded.has(chat));
    const observed = activeChats.filter((chat) => !chat.generating).flatMap((chat) => chat.banners);
    // The two-tick stall evidence is URL-identity-based, not a mutable CDP target.
    const bannerIdentity = (banner: ChatErrorBanner) => localChatIdentity(banner.url, config)?.key ?? banner.url;
    const stalledNow = observed.filter((banner) => banner.kind === 'stalled')
      .map(bannerIdentity).sort();
    const stalledBefore = new Set((store.readStalledSeen?.() ?? '').split('\n').filter(Boolean));
    store.writeStalledSeen?.(stalledNow.join('\n'));
    const seenUrls = new Set<string>();
    const banners = observed.filter((banner) => {
      const identity = bannerIdentity(banner);
      return (banner.kind !== 'stalled' || stalledBefore.has(identity))
        && !seenUrls.has(identity) && Boolean(seenUrls.add(identity));
    });
    const direct: Array<readonly [FleetTerminal, ChatErrorBanner]> = [];
    const routed: ChatErrorBanner[] = [];
    const pendingLocal: Array<{ readonly key: string; readonly url: string; readonly kind: ChatErrorBanner['kind'] }> = [];
    for (const banner of banners) {
      if (isLocalPlaceholderUrl(banner.url)) {
        const identity = localChatIdentity(banner.url, config);
        if (identity && !store.hasParkedWakeEvent(identity.key)) {
          pendingLocal.push({ ...identity, kind: banner.kind });
        }
        // Invalid/foreign local placeholders remain read-only diagnostic evidence.
        continue;
      }
      const owner = bannerOwnerPane(banner, terminals, config);
      if (owner) direct.push([owner, banner]);
      else routed.push(banner);
    }
    const directSignature = direct
      .map(([owner, banner]) => `${owner.handle} ${banner.url} ${banner.text}`)
      .sort((left, right) => left.localeCompare(right))
      .join('\n');
    if (store.readBannerSignature?.() !== directSignature) {
      for (const [owner, banner] of direct) {
        const delivered = sendCoordinator(executor, owner.handle, managerBannerMessage(banner))
          && (await sleepMs(4_000), submitCoordinator(executor, owner.handle));
        log(`${delivered ? 'sent' : 'send failed'} chat banner to ${owner.handle}: ${banner.url}`);
        if (!delivered) routed.push(banner);
      }
      store.writeBannerSignature?.(directSignature);
    }

    const stopped = actionablePanes(observations);
    if (stopped.length === 0 && routed.length === 0 && parkedAlerts.length === 0 && pendingLocal.length === 0) {
      store.clearLastSentSignature();
      store.clearLastSentAt?.();
      log('nothing stopped');
      return { state: 'nothing_stopped' };
    }

    let coordinatorScreen: string;
    try {
      coordinatorScreen = readFleetScreen(coordinator.handle, executor);
    } catch {
      log(`${coordinator.handle} unreadable`);
      return { state: 'unreadable', handle: coordinator.handle };
    }

    const coordinatorState: 'idle' | 'busy' = isBusyScreen(coordinatorScreen, config.busyRe) ? 'busy' : 'idle';
    // Local one-off warnings are never part of the durable ordinary signature.
    const signature = [meaningfulStoppedSignature(observations), chatBannerSignature(routed),
      ...parkedAlerts.slice().sort()].filter(Boolean).join('\n');
    const deliverySignature = JSON.stringify([coordinator.handle, coordinator.incarnationId ?? '', signature]);
    const now = (options.now ?? Date.now)();
    const lastAt = store.readLastSentAt?.();
    if (pendingLocal.length === 0 && store.readLastSentSignature() === deliverySignature
      && lastAt !== undefined && Number.isFinite(now) && now - lastAt >= 0
      && now - lastAt < REMINDER_INTERVAL_MS) {
      log(`${coordinator.handle} same stopped set already queued`);
      return { state: 'same_stopped_set', coordinator: coordinator.handle, signature };
    }

    const localWarnings = pendingLocal.map((banner) => `${banner.url} (${banner.kind})`);
    const message = fleetAlarmMessage(coordinatorState, observations, routed, parkedAlerts, localWarnings);
    if (pendingLocal.length > 0) {
      if (!coordinatorStillSelected(coordinator, config, executor)) {
        log(`${coordinator.handle} changed before local chat warning send`);
        return { state: 'send_failed', coordinator: coordinator.handle };
      }
      // Persist uncertainty *before* any effect. An unknown delivery is never replayed.
      try {
        for (const banner of pendingLocal) store.markParkedWakeEvent(banner.key, 'attempted_unverified');
      } catch {
        log(`${coordinator.handle} cannot persist local chat attempt before send`);
        return { state: 'send_failed', coordinator: coordinator.handle };
      }
    }
    try {
      if (!sendCoordinator(executor, coordinator.handle, message)) {
        log(`${coordinator.handle} send failed`);
        return { state: 'send_failed', coordinator: coordinator.handle };
      }
      await sleepMs(4_000);
      if (pendingLocal.length > 0 && !coordinatorStillSelected(coordinator, config, executor)) {
        log(`${coordinator.handle} changed before local chat second Enter`);
        return { state: 'send_failed', coordinator: coordinator.handle };
      }
      if (!submitCoordinator(executor, coordinator.handle)) {
        log(`${coordinator.handle} send failed`);
        return { state: 'send_failed', coordinator: coordinator.handle };
      }
    } catch {
      log(`${coordinator.handle} local chat coordinator delivery uncertain`);
      return { state: 'send_failed', coordinator: coordinator.handle };
    }
    // Mark successful delivery only after *both* terminal operations succeeded.
    try {
      for (const banner of pendingLocal) store.markParkedWakeEvent(banner.key, 'sent');
    } catch {
      log(`${coordinator.handle} local chat delivered but final mark unverified`);
      return { state: 'send_failed', coordinator: coordinator.handle };
    }
    store.writeLastSentSignature(deliverySignature);
    store.writeLastSentAt?.(now);
    log(`sent to ${coordinator.handle} (${coordinatorState}): ${stopped.length} need a step, ${routed.length} chat banner(s), ${pendingLocal.length} local warning(s)`);
    return {
      state: 'sent',
      coordinator: coordinator.handle,
      coordinatorState,
      count: stopped.length,
      signature,
    };
  } finally {
    // Advisory history, screen reads, and formatting cannot abort the pre-existing tick.
    try {
      await runFleetDiagnosticTick({
        config, executor, store, terminals, log, observedChats: activeChats,
        ...(operationalObservations ? { observations: operationalObservations } : {}),
      });
    } catch {
      log('DIAG state=unverified reason=diagnostic_unreadable evidence=read_only_projection_failure');
    }
  }
}

export function fleetWakeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = [],
): FleetWakeConfig {
  let projectId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project') {
      const value = argv[++index];
      if (!value) throw new Error('--project requires an id');
      projectId = value;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  const target = resolveTargetContext({ projectId, env });
  const intervalSeconds = env.FLEET_WAKE_INTERVAL?.trim() ? Number(env.FLEET_WAKE_INTERVAL) : 300;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error('FLEET_WAKE_INTERVAL must be a positive number of seconds');
  }
  return {
    projectId: target.projectId,
    primary: target.primaryRoot,
    workspaceRe: compileRegex(target.orcaWorkspacePattern, defaultWorkspaceRegex(target.primaryRoot)),
    orchestratorTitleRe: compileRegex(target.orchestratorTitlePattern, DEFAULT_ORCHESTRATOR_TITLE_RE),
    ...(env.ORCH_HANDLE?.trim() ? { orchestratorHandle: env.ORCH_HANDLE.trim() } : {}),
    ...(env.ARCHITECT_HANDLE?.trim() ? { architectHandle: env.ARCHITECT_HANDLE.trim() } : {}),
    busyRe: compileRegex(env.BUSY_RE, DEFAULT_BUSY_RE),
    intervalSeconds,
    chatCdpUrl: env.PACK_GPT_BROWSER_CDP?.trim() || DEFAULT_CHAT_CDP_URL,
    chatScope: { projectUrl: target.browserGpt.projectUrl, repository: target.repository },
  };
}

export async function runFleetWakeLoop(
  config: FleetWakeConfig,
  dependencies: Omit<FleetAlarmTickOptions, 'config'> = {},
): Promise<never> {
  const sleepMs = dependencies.sleepMs ?? defaultSleep;
  const log = dependencies.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  log(`start ${config.projectId} interval=${config.intervalSeconds}s`);
  while (true) {
    try {
      await runFleetAlarmTick({ ...dependencies, config, sleepMs, log });
    } catch (error) {
      log(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleepMs(config.intervalSeconds * 1_000);
  }
}

function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && resolve(process.argv[1]!) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  runFleetWakeLoop(fleetWakeConfigFromEnv(process.env, process.argv.slice(2))).catch((error: unknown) => {
    process.stderr.write(`fleet-wake: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
