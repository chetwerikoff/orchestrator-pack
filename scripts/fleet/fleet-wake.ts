#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
import { DEFAULT_CHAT_CDP_URL, readChatErrorBanners, type ChatErrorBanner } from './chat-error-banners.ts';

export interface FleetWakeConfig {
  readonly projectId: string;
  readonly primary: string;
  readonly workspaceRe: RegExp;
  readonly orchestratorTitleRe: RegExp;
  readonly orchestratorHandle?: string;
  readonly busyRe: RegExp;
  readonly intervalSeconds: number;
  readonly chatCdpUrl?: string;
}

export interface FleetWakeStateStore extends FleetPollingStore {
  readLastSentSignature(): string | null;
  writeLastSentSignature(signature: string): void;
  clearLastSentSignature(): void;
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
}

export interface FleetAlarmTickOptions {
  readonly config: FleetWakeConfig;
  readonly executor?: OrcaExecutor;
  readonly store?: FleetWakeStateStore;
  readonly sleepMs?: (milliseconds: number) => void | Promise<void>;
  readonly log?: (line: string) => void;
  readonly readChatBanners?: (cdpUrl: string) => Promise<ChatErrorBanner[]>;
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
    ? ` ${banners.length} ChatGPT chat(s) show a red error banner with generation stopped: ${banners.map((banner) => `${banner.url} "${banner.text}"${banner.retry ? ' (Retry shown)' : ''}`).join('; ')}. Tell the manager that owns each chat to run GitHub-first reconciliation and send "Доделай задачу" in that same chat (runbook: Repeated product-error streak - two repeats, a fresh chat on the third continuation failure). Never press Retry.`
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

  const banners = config.chatCdpUrl
    ? await (options.readChatBanners ?? readChatErrorBanners)(config.chatCdpUrl).catch(() => [])
    : [];
  const stopped = actionablePanes(observations);
  if (stopped.length === 0 && banners.length === 0) {
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
  const signature = [stoppedSignature(observations), chatBannerSignature(banners)].filter(Boolean).join('\n');
  const deliverySignature = `${coordinator.handle}\n${signature}`;
  if (coordinatorState === 'busy' && store.readLastSentSignature() === deliverySignature) {
    log(`${coordinator.handle} same stopped set already queued`);
    return { state: 'same_stopped_set', coordinator: coordinator.handle, signature };
  }

  const message = fleetAlarmMessage(coordinatorState, observations, banners);
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
  log(`sent to ${coordinator.handle} (${coordinatorState}): ${stopped.length} need a step, ${banners.length} chat banner(s)`);
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
