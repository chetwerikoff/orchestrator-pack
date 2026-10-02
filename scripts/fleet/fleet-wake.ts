#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';
import { createHash } from 'node:crypto';
import { runProcessSync } from '../kernel/subprocess.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargetContext } from '../lib/target-context.ts';
import {
  DEFAULT_BUSY_RE,
  DEFAULT_ORCHESTRATOR_TITLE_RE,
  FileFleetStateStore,
  FleetScreenReadError,
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
  type ChatBannerScope,
  type ChatErrorBanner,
  type ProjectChat,
} from './chat-error-banners.ts';
import { readChatBinding } from '../chatgpt-browser-turn/chat-bindings.ts';

export interface FleetWakeConfig {
  readonly projectId: string;
  readonly primary: string;
  readonly workspaceRe: RegExp;
  readonly orchestratorTitleRe: RegExp;
  readonly orchestratorHandle?: string;
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
  markParkedWakeEvent(key: string): void;
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

  markParkedWakeEvent(key: string): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.parkedWakeEventPath(key), `${key}\n`, 'utf8');
  }
}

export interface FleetAlarmTickOptions {
  readonly config: FleetWakeConfig;
  readonly executor?: OrcaExecutor;
  readonly store?: FleetWakeStateStore;
  readonly sleepMs?: (milliseconds: number) => void | Promise<void>;
  readonly log?: (line: string) => void;
  readonly readChats?: (cdpUrl: string, scope: ChatBannerScope) => Promise<ProjectChat[]>;
  readonly closeChat?: (cdpUrl: string, targetId: string) => Promise<boolean>;
  readonly findTerminalEnvelope?: (invocationId: string) => string | undefined;
  readonly checkRunsCompleted?: (repository: string, sha: string) => boolean;
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
    .map((pane) => `${pane.state} ${pane.handle}`)
    .sort((left, right) => left.localeCompare(right))
    .join('\n');
}

function isWorkerPane(terminal: FleetTerminal, config: FleetWakeConfig): boolean {
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
export function bannerOwnerPane(
  banner: Pick<ChatErrorBanner, 'url' | 'issue' | 'pull'>,
  terminals: readonly FleetTerminal[],
  config: FleetWakeConfig,
  readBinding: typeof readChatBinding = readChatBinding,
  headRef: typeof readPrHeadRef = readPrHeadRef,
): FleetTerminal | undefined {
  const binding = readBinding(banner.url);
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
  const name = new RegExp(`^[a-z][a-z0-9]*-${banner.issue}$`, 'i');
  const matches = terminals.filter((terminal) => {
    if (!terminal.worktreePath) return false;
    const worktree = terminal.worktreePath.replaceAll('\\', '/');
    config.workspaceRe.lastIndex = 0;
    return !samePath(terminal.worktreePath, config.primary)
      && config.workspaceRe.test(worktree)
      && name.test(basename(worktree));
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
    return banner.review
      ? `Your GPT PR-review chat ${banner.url} cannot be loaded ("${banner.text}", no composer), so nothing can be sent there. Restart the review in a new chat through your review tool. Never press Try again or Retry.`
      : `Your GPT execution chat ${banner.url} cannot be loaded ("${banner.text}", no composer), so nothing can be sent there. Run GitHub-first reconciliation, then continue the task in a new chat with the reconciled baseline. Never press Try again or Retry.`;
  }
  if (banner.review) {
    const reason = banner.kind === 'stalled' ? banner.text : `red banner "${banner.text}"${banner.retry ? ' (Retry shown)' : ''}`;
    return `Your GPT PR-review chat ${banner.url} ended without a verdict (${reason}). This is a review chat: do not ask it to fix code or continue the task. Send exactly this in the same chat: "${REVIEW_CONTINUATION_TEXT}" Then collect the verdict through your review tool as usual. Never press Retry.`;
  }
  if (banner.kind === 'stalled') {
    return `${banner.text} in your GPT chat ${banner.url} (no Stop control and no error banner for over a minute). Run GitHub-first reconciliation, then send "${EXECUTION_CONTINUATION_TEXT}" in this same chat (runbook: Repeated product-error streak - up to two repeats; on the third continuation failure open a fresh chat). Never press Retry.`;
  }
  return `GPT chat error in your execution chat ${banner.url}: red banner "${banner.text}"${banner.retry ? ' (Retry shown)' : ''}, generation stopped. Run GitHub-first reconciliation, then send "${EXECUTION_CONTINUATION_TEXT}" in this same chat (runbook: Repeated product-error streak - up to two repeats; on the third continuation failure open a fresh chat). Never press Retry.`;
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
): string {
  const stopped = actionablePanes(observations);
  const panes = stopped.map((pane) => `${pane.state} ${pane.handle} ${pane.title}`).join('; ');
  const paneText = stopped.length > 0
    ? ` ${stopped.length} pane(s) need a step: ${panes} Run your full fleet sweep now (mail, then fleet-sweep) and give every STOPPED/POLLING pane its step this turn. A question a unit typed in its own pane is addressed to you: answer it.`
    : '';
  const unloadable = banners.filter((banner) => banner.kind === 'unloadable');
  const continuable = banners.filter((banner) => banner.kind !== 'unloadable');
  const unloadableText = unloadable.length > 0
    ? ` ${unloadable.length} ChatGPT chat(s) cannot be loaded (no composer): ${unloadable.map((banner) => `${banner.url}${banner.review ? ' (PR-review chat)' : ''}`).join('; ')}. Tell the manager that owns each chat to run GitHub-first reconciliation and continue in a new chat with the reconciled baseline (a PR-review chat: restart the review in a new chat). Never press Try again or Retry.`
    : '';
  const bannerText = continuable.length > 0
    ? ` ${continuable.length} ChatGPT chat(s) need a continuation (generation stopped): ${continuable.map((banner) => `${banner.url} "${banner.text}"${banner.retry ? ' (Retry shown)' : ''}${banner.review ? ' (PR-review chat)' : ''}`).join('; ')}. Tell the manager that owns each chat to run GitHub-first reconciliation and send "${EXECUTION_CONTINUATION_TEXT}" in that same chat (runbook: Repeated product-error streak - two repeats, a fresh chat on the third continuation failure); for a PR-review chat send "${REVIEW_CONTINUATION_TEXT}" instead. Never press Retry.`
    : '';
  return `Fleet alarm (${coordinatorState}):${paneText}${bannerText}${unloadableText}`;
}

export function findTerminalEnvelopeForInvocation(
  invocationId: string,
  root = '/tmp/opencode',
): string | undefined {
  const pending = [root];
  const matches: string[] = [];
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
      if (!entry.isFile() || !entry.name.endsWith('terminal.json')) continue;
      try {
        const envelope = JSON.parse(readFileSync(path, 'utf8')) as { observed_invocation_id?: unknown };
        const observed = envelope.observed_invocation_id;
        // Panes may name a turn by its first 8+ characters.
        if (typeof observed === 'string' && (observed === invocationId
          || (invocationId.length >= 8 && observed.startsWith(invocationId)))) matches.push(path);
      } catch {
        // A partial or unrelated terminal artifact is not completion evidence.
      }
    }
  }
  return matches.sort((left, right) => left.localeCompare(right))[0];
}

export function allCheckRunsCompleted(repository: string, sha: string): boolean {
  const result = runProcessSync({
    command: fileURLToPath(new URL('../gh', import.meta.url)),
    args: ['api', `repos/${repository}/commits/${sha}/check-runs`, '--paginate', '--jq', '.check_runs[].status'],
    timeoutMs: 15_000,
    inheritParentEnv: true,
  });
  if (!result.ok) return false;
  const statuses = result.stdout.split(/\r?\n/u).map((status) => status.trim()).filter(Boolean);
  return statuses.length > 0 && statuses.every((status) => status === 'completed');
}

type ParkedWakeEvent =
  | { readonly kind: 'gpt'; readonly key: string; readonly invocationId: string }
  | { readonly kind: 'ci'; readonly key: string; readonly sha: string };

function parkedWakeEvent(pane: FleetPaneObservation): ParkedWakeEvent | undefined {
  if (pane.state !== 'PARKED') return undefined;
  // The park line may carry a suffix such as "(self-wake armed)." and wrap.
  const tail = pane.lines.slice(-2).join(' ');
  const at = tail.lastIndexOf('PARKED on ');
  if (at < 0) return undefined;
  const line = tail.slice(at);
  const gpt = /^PARKED on GPT turn ([0-9a-f][0-9a-f-]{7,})(?![0-9a-z-])/iu.exec(line);
  if (gpt?.[1]) {
    const invocationId = gpt[1].toLowerCase();
    return { kind: 'gpt', key: `gpt:${invocationId}`, invocationId };
  }
  const ci = /^PARKED on CI on ([0-9a-f]{7,40})(?![0-9a-z])/iu.exec(line);
  if (ci?.[1]) {
    return { kind: 'ci', key: `ci:${ci[1].toLowerCase()}`, sha: ci[1] };
  }
  return undefined;
}

async function wakeParkedPanes(
  options: FleetAlarmTickOptions,
  observations: readonly FleetPaneObservation[],
  executor: OrcaExecutor,
  store: FleetWakeStateStore,
  log: (line: string) => void,
  sleepMs: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const findTerminalEnvelope = options.findTerminalEnvelope ?? findTerminalEnvelopeForInvocation;
  const checkRunsCompleted = options.checkRunsCompleted ?? allCheckRunsCompleted;
  for (const pane of observations) {
    const event = parkedWakeEvent(pane);
    if (!event || store.hasParkedWakeEvent(event.key)) continue;

    let message: string | undefined;
    if (event.kind === 'gpt') {
      const path = findTerminalEnvelope(event.invocationId);
      if (path) message = `Wake: GPT turn ${event.invocationId} ended, read ${path}`;
    } else {
      const repository = options.config.chatScope?.repository;
      if (repository && checkRunsCompleted(repository, event.sha)) {
        message = `Wake: CI on ${event.sha} finished`;
      }
    }
    if (!message) continue;

    const delivered = sendCoordinator(executor, pane.handle, message)
      && (await sleepMs(4_000), submitCoordinator(executor, pane.handle));
    if (!delivered) {
      log(`parked wake send failed to ${pane.handle}: ${event.key}`);
      continue;
    }
    store.markParkedWakeEvent(event.key);
    log(`sent parked wake to ${pane.handle}: ${event.key}`);
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
    log('terminal list unreadable');
    return { state: 'unreadable', handle: 'terminal-list' };
  }

  const coordinator = resolveCoordinatorPane(terminals, config);
  if (!coordinator) {
    log('normal fleet result: no orchestrator pane found');
    return { state: 'no_orchestrator' };
  }

  let observations: FleetPaneObservation[];
  try {
    observations = runFleetSweep({
      primary: config.primary,
      workspaceRe: config.workspaceRe,
      coordinatorHandle: coordinator.handle,
      coordinatorTitleRe: config.orchestratorTitleRe,
      busyRe: config.busyRe,
      executor,
      store,
      terminals,
    });
  } catch (error) {
    if (error instanceof FleetScreenReadError) {
      log(`${error.handle} unreadable`);
      return { state: 'unreadable', handle: error.handle };
    }
    log('fleet sweep unreadable');
    return { state: 'unreadable', handle: 'fleet-sweep' };
  }

  await wakeParkedPanes(options, observations, executor, store, log, sleepMs);

  const chats = config.chatCdpUrl && config.chatScope
    ? await (options.readChats ?? readProjectChats)(config.chatCdpUrl, config.chatScope).catch(() => [])
    : [];
  const superseded = new Set(supersededChats(chats, (chat) => {
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
  const observed = chats.filter((chat) => !superseded.has(chat)).flatMap((chat) => chat.banners);
  // A stalled chat must be seen on two consecutive ticks; page loads and turn
  // starts briefly show neither Stop nor finished-reply actions.
  const stalledNow = observed.filter((banner) => banner.kind === 'stalled').map((banner) => banner.url).sort();
  const stalledBefore = new Set((store.readStalledSeen?.() ?? '').split('\n').filter(Boolean));
  store.writeStalledSeen?.(stalledNow.join('\n'));
  const seenUrls = new Set<string>();
  const banners = observed.filter((banner) => (banner.kind !== 'stalled' || stalledBefore.has(banner.url))
    && !seenUrls.has(banner.url) && Boolean(seenUrls.add(banner.url)));
  const direct: Array<readonly [FleetTerminal, ChatErrorBanner]> = [];
  const routed: ChatErrorBanner[] = [];
  for (const banner of banners) {
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
  if (stopped.length === 0 && routed.length === 0) {
    store.clearLastSentSignature();
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
  const signature = [stoppedSignature(observations), chatBannerSignature(routed)].filter(Boolean).join('\n');
  const deliverySignature = `${coordinator.handle}\n${signature}`;
  if (coordinatorState === 'busy' && store.readLastSentSignature() === deliverySignature) {
    log(`${coordinator.handle} same stopped set already queued`);
    return { state: 'same_stopped_set', coordinator: coordinator.handle, signature };
  }

  const message = fleetAlarmMessage(coordinatorState, observations, routed);
  if (!sendCoordinator(executor, coordinator.handle, message)) {
    log(`${coordinator.handle} send failed`);
    return { state: 'send_failed', coordinator: coordinator.handle };
  }
  await sleepMs(4_000);
  if (!submitCoordinator(executor, coordinator.handle)) {
    log(`${coordinator.handle} send failed`);
    return { state: 'send_failed', coordinator: coordinator.handle };
  }

  store.writeLastSentSignature(deliverySignature);
  log(`sent to ${coordinator.handle} (${coordinatorState}): ${stopped.length} need a step, ${routed.length} chat banner(s)`);
  return {
    state: 'sent',
    coordinator: coordinator.handle,
    coordinatorState,
    count: stopped.length,
    signature,
  };
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
