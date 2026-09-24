#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BUSY_RE,
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

export interface FleetWakeConfig {
  readonly primary: string;
  readonly workspaceRe: RegExp;
  readonly orchestratorTitleRe: RegExp;
  readonly orchestratorHandle?: string;
  readonly busyRe: RegExp;
  readonly intervalSeconds: number;
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
    return terminals.find((terminal) => terminal.handle === config.orchestratorHandle);
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

export function fleetAlarmMessage(
  coordinatorState: 'idle' | 'busy',
  observations: readonly FleetPaneObservation[],
): string {
  const stopped = actionablePanes(observations);
  const panes = stopped.map((pane) => `${pane.state} ${pane.handle} ${pane.title}`).join('; ');
  return `Fleet alarm (${coordinatorState}): ${stopped.length} pane(s) need a step: ${panes} Run your full fleet sweep now (mail, then fleet-sweep) and give every STOPPED/POLLING pane its step this turn. A question a unit typed in its own pane is addressed to you: answer it.`;
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
  const store = options.store ?? new FileFleetWakeStateStore(config.primary);
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
    log('no orchestrator pane found');
    return { state: 'no_orchestrator' };
  }

  let observations: FleetPaneObservation[];
  try {
    observations = runFleetSweep({
      primary: config.primary,
      workspaceRe: config.workspaceRe,
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

  const stopped = actionablePanes(observations);
  if (stopped.length === 0) {
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
  const signature = stoppedSignature(observations);
  if (coordinatorState === 'busy' && store.readLastSentSignature() === signature) {
    log(`${coordinator.handle} same stopped set already queued`);
    return { state: 'same_stopped_set', coordinator: coordinator.handle, signature };
  }

  const message = fleetAlarmMessage(coordinatorState, observations);
  if (!sendCoordinator(executor, coordinator.handle, message)) {
    log(`${coordinator.handle} send failed`);
    return { state: 'send_failed', coordinator: coordinator.handle };
  }
  await sleepMs(4_000);
  if (!submitCoordinator(executor, coordinator.handle)) {
    log(`${coordinator.handle} send failed`);
    return { state: 'send_failed', coordinator: coordinator.handle };
  }

  store.writeLastSentSignature(signature);
  log(`sent to ${coordinator.handle} (${coordinatorState}): ${stopped.length} need a step`);
  return {
    state: 'sent',
    coordinator: coordinator.handle,
    coordinatorState,
    count: stopped.length,
    signature,
  };
}

export function fleetWakeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FleetWakeConfig {
  const primary = env.PRIMARY?.trim();
  if (!primary) throw new Error('PRIMARY is required');
  const intervalSeconds = env.FLEET_WAKE_INTERVAL?.trim() ? Number(env.FLEET_WAKE_INTERVAL) : 300;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error('FLEET_WAKE_INTERVAL must be a positive number of seconds');
  }
  return {
    primary,
    workspaceRe: compileRegex(env.WORKSPACE_RE, defaultWorkspaceRegex(primary)),
    orchestratorTitleRe: compileRegex(env.ORCH_TITLE_RE, /Cursor/iu),
    ...(env.ORCH_HANDLE?.trim() ? { orchestratorHandle: env.ORCH_HANDLE.trim() } : {}),
    busyRe: compileRegex(env.BUSY_RE, DEFAULT_BUSY_RE),
    intervalSeconds,
  };
}

export async function runFleetWakeLoop(
  config: FleetWakeConfig,
  dependencies: Omit<FleetAlarmTickOptions, 'config'> = {},
): Promise<never> {
  const sleepMs = dependencies.sleepMs ?? defaultSleep;
  const log = dependencies.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  log(`start ${basename(resolve(config.primary))} interval=${config.intervalSeconds}s`);
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
  runFleetWakeLoop(fleetWakeConfigFromEnv()).catch((error: unknown) => {
    process.stderr.write(`fleet-wake: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
