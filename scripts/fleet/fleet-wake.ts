#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';
import { runProcessSync } from '../kernel/subprocess.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
}

export interface FleetAlarmTickOptions {
  readonly config: FleetWakeConfig;
  readonly executor?: OrcaExecutor;
  readonly store?: FleetWakeStateStore;
  readonly sleepMs?: (milliseconds: number) => void | Promise<void>;
  readonly log?: (line: string) => void;
  readonly readChats?: (cdpUrl: string, scope: ChatBannerScope) => Promise<ProjectChat[]>;
  readonly closeChat?: (cdpUrl: string, targetId: string) => Promise<boolean>;
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

export const REVIEW_CONTINUATION_TEXT = 'Заверши ревью: выдай итоговый вердикт строго в формате из первого сообщения (NO_FINDINGS или JSON с findings). Ничего не исправляй и не меняй код.';

export function managerBannerMessage(banner: ChatErrorBanner): string {
  if (banner.review) {
    const reason = banner.kind === 'stalled' ? banner.text : `red banner "${banner.text}"${banner.retry ? ' (Retry shown)' : ''}`;
    return `Your GPT PR-review chat ${banner.url} ended without a verdict (${reason}). This is a review chat: do not ask it to fix code or continue the task. Send exactly this in the same chat: "${REVIEW_CONTINUATION_TEXT}" Then collect the verdict through your review tool as usual. Never press Retry.`;
  }
  if (banner.kind === 'stalled') {
    return `${banner.text} in your GPT chat ${banner.url} (no Stop control and no error banner for over a minute). Run GitHub-first reconciliation, then send "Доделай задачу и сообщи статус" in this same chat (runbook: Repeated product-error streak - up to two repeats; on the third continuation failure open a fresh chat). Never press Retry.`;
  }
  return `GPT chat error in your execution chat ${banner.url}: red banner "${banner.text}"${banner.retry ? ' (Retry shown)' : ''}, generation stopped. Run GitHub-first reconciliation, then send "Доделай задачу" in this same chat (runbook: Repeated product-error streak - up to two repeats; on the third continuation failure open a fresh chat). Never press Retry.`;
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
  const bannerText = banners.length > 0
    ? ` ${banners.length} ChatGPT chat(s) need a continuation (generation stopped): ${banners.map((banner) => `${banner.url} "${banner.text}"${banner.retry ? ' (Retry shown)' : ''}${banner.review ? ' (PR-review chat)' : ''}`).join('; ')}. Tell the manager that owns each chat to run GitHub-first reconciliation and send "Доделай задачу и сообщи статус" in that same chat (runbook: Repeated product-error streak - two repeats, a fresh chat on the third continuation failure); for a PR-review chat send "${REVIEW_CONTINUATION_TEXT}" instead. Never press Retry.`
    : '';
  return `Fleet alarm (${coordinatorState}):${paneText}${bannerText}`;
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
