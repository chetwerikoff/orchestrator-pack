#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  runProcessSync,
  type ProcessResult,
  type RunProcessSyncOptions,
} from './kernel/subprocess.ts';
import {
  sameRuntimeWorker,
  type RuntimeAdapter,
  type RuntimeComposerFamilyObservation,
  type RuntimeDispatchResult,
  type RuntimeWorkerIdentity,
} from './runtime/contracts.ts';
import { selectRuntimeAdapter } from './runtime/registry.ts';
import { resolveOrcaExecutable } from './orca-runtime/native.ts';

const DEFAULT_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const RUNTIME_TIMEOUT_MS = 10_000;

export interface UnitWatcherWakeConfig {
  readonly watchTerminal: string;
  readonly targetTerminal: string;
  readonly wakeText: string;
  readonly waitTimeoutMs: number;
}

export interface UnitWatcherWakeResult {
  readonly exitCode: 0 | 1;
  readonly stdout: string;
  readonly stderr: string;
}

export type WatcherCommandRunner = (options: RunProcessSyncOptions) => ProcessResult;

export interface UnitWatcherWakeDependencies {
  readonly run?: WatcherCommandRunner;
  readonly executable?: string;
  readonly adapter?: RuntimeAdapter;
}

interface OrcaEnvelope {
  readonly ok?: unknown;
  readonly result?: {
    readonly wait?: {
      readonly condition?: unknown;
      readonly satisfied?: unknown;
      readonly status?: unknown;
      readonly exitCode?: unknown;
    };
  };
  readonly error?: unknown;
}

function usage(): string {
  return [
    'Usage:',
    '  node --experimental-strip-types scripts/unit-watcher-wake.ts \\',
    '    --watch-terminal <detached-job-terminal> \\',
    '    --target-terminal <unit-terminal> \\',
    '    --wake-text <text> [--wait-timeout-ms <ms>]',
    '',
    'The helper snapshots the target through the registered RuntimeAdapter, waits',
    'for the watched Orca terminal to exit, revalidates the same exact runtime',
    'generation, then makes one adapter dispatch. Raw Orca accepted:true is not',
    'a confirmed submission witness.',
    '',
  ].join('\n');
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value === '') throw new Error(flag + ' requires a non-empty value');
  return value;
}

export function parseUnitWatcherWakeArgs(argv: readonly string[]): UnitWatcherWakeConfig {
  let watchTerminal = '';
  let targetTerminal = '';
  let wakeText = '';
  let waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--watch-terminal') {
      watchTerminal = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--target-terminal') {
      targetTerminal = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--wake-text') {
      wakeText = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--wait-timeout-ms') {
      const raw = requiredValue(argv, index, arg);
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error('--wait-timeout-ms must be a positive integer');
      }
      waitTimeoutMs = parsed;
      index += 1;
      continue;
    }
    throw new Error('unknown argument: ' + arg);
  }

  if (!watchTerminal) throw new Error('--watch-terminal is required');
  if (!targetTerminal) throw new Error('--target-terminal is required');
  if (!wakeText) throw new Error('--wake-text is required');

  return { watchTerminal, targetTerminal, wakeText, waitTimeoutMs };
}

function parseEnvelope(stdout: string): OrcaEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed && typeof parsed === 'object' ? parsed as OrcaEnvelope : null;
  } catch {
    return null;
  }
}

function commandOutput(label: string, result: ProcessResult): string {
  const runnerError = result.error ? '\nrunner error: ' + result.error : '';
  return label + ' command output:\nstdout:\n' + result.stdout
    + '\nstderr:\n' + result.stderr + runnerError;
}

function adapterOutput(label: string, value: unknown): string {
  return label + ':\n' + JSON.stringify(value);
}

function failedCommand(label: string, result: ProcessResult, reason: string): UnitWatcherWakeResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: 'unit watcher wake failed: ' + reason + '\n'
      + commandOutput(label, result) + '\n',
  };
}

function failedAdapter(label: string, value: unknown, reason: string): UnitWatcherWakeResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: 'unit watcher wake failed: ' + reason + '\n'
      + adapterOutput(label, value) + '\n',
  };
}

function exactTargetIdentity(
  adapter: RuntimeAdapter,
  targetTerminal: string,
): { readonly identity: RuntimeWorkerIdentity } | { readonly failure: UnitWatcherWakeResult } {
  const resolved = adapter.findWorkerById(
    targetTerminal,
    { timeoutMs: RUNTIME_TIMEOUT_MS },
  );
  if (resolved.status !== 'ok') {
    return {
      failure: failedAdapter(
        'runtime target resolution',
        resolved,
        'target runtime identity could not be resolved',
      ),
    };
  }
  if (!resolved.value) {
    return {
      failure: failedAdapter(
        'runtime target resolution',
        resolved,
        'target runtime identity is missing',
      ),
    };
  }
  const identity = resolved.value.identity;
  if (
    identity.runtime !== adapter.id
    || identity.id !== targetTerminal
    || !identity.generation.trim()
  ) {
    return {
      failure: failedAdapter(
        'runtime target resolution',
        resolved,
        'target runtime identity is invalid or mismatched',
      ),
    };
  }
  return { identity };
}

function targetBindingFailure(
  adapter: RuntimeAdapter,
  identity: RuntimeWorkerIdentity,
): UnitWatcherWakeResult | null {
  const current = adapter.findWorker(identity, { timeoutMs: RUNTIME_TIMEOUT_MS });
  if (current.status !== 'ok') {
    return failedAdapter(
      'runtime target revalidation',
      current,
      'target runtime identity could not be revalidated',
    );
  }
  if (!current.value || !sameRuntimeWorker(current.value.identity, identity)) {
    return failedAdapter(
      'runtime target revalidation',
      current,
      'target runtime identity is stale or reused',
    );
  }

  if (!adapter.observeComposerFamily) {
    return failedAdapter(
      'runtime composer binding',
      { status: 'unsupported', reason: 'runtime_composer_observer_unavailable' },
      'target composer binding cannot be proven',
    );
  }
  const family: RuntimeComposerFamilyObservation = adapter.observeComposerFamily(
    identity,
    { timeoutMs: RUNTIME_TIMEOUT_MS },
  );
  if (family.status !== 'known') {
    return failedAdapter(
      'runtime composer binding',
      family,
      'target composer binding cannot be proven',
    );
  }
  if (family.family === 'opencode') {
    const control = adapter.composerControl?.(identity, { timeoutMs: RUNTIME_TIMEOUT_MS });
    if (control?.kind !== 'opencode-http') {
      return failedAdapter(
        'runtime composer control',
        { kind: control?.kind ?? null, reason: 'opencode_control_unbound' },
        'OpenCode target control is unbound',
      );
    }
  }
  return null;
}

function confirmedDispatch(
  identity: RuntimeWorkerIdentity,
  dispatch: RuntimeDispatchResult,
): UnitWatcherWakeResult {
  if (dispatch.status === 'dispatched') {
    return {
      exitCode: 0,
      stdout: 'watcher wake submission confirmed: runtime='
        + identity.runtime
        + ' target=' + identity.id
        + ' generation=' + identity.generation
        + ' dispatch=dispatched\n',
      stderr: '',
    };
  }
  if (dispatch.status === 'dispatch_unknown') {
    return failedAdapter(
      'runtime dispatch result',
      dispatch,
      'delivery-unknown: ' + dispatch.reason,
    );
  }
  if (dispatch.status === 'send_failed') {
    return failedAdapter(
      'runtime dispatch result',
      dispatch,
      'dispatch refused: ' + dispatch.reason,
    );
  }
  return failedAdapter(
    'runtime dispatch result',
    dispatch,
    'dispatch result was not confirmed',
  );
}

export async function runUnitWatcherWake(
  config: UnitWatcherWakeConfig,
  dependencies: UnitWatcherWakeDependencies = {},
): Promise<UnitWatcherWakeResult> {
  const run = dependencies.run ?? runProcessSync;
  const executable = dependencies.executable ?? resolveOrcaExecutable();

  let adapter: RuntimeAdapter;
  try {
    adapter = dependencies.adapter ?? await selectRuntimeAdapter();
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'unit watcher wake failed: runtime adapter selection failed: '
        + (error instanceof Error ? error.message : String(error))
        + '\n',
    };
  }

  const target = exactTargetIdentity(adapter, config.targetTerminal);
  if ('failure' in target) return target.failure;

  const initialBindingFailure = targetBindingFailure(adapter, target.identity);
  if (initialBindingFailure) return initialBindingFailure;

  const waitResult = run({
    command: executable,
    args: [
      'terminal', 'wait',
      '--terminal', config.watchTerminal,
      '--for', 'exit',
      '--timeout-ms', String(config.waitTimeoutMs),
      '--json',
    ],
    inheritParentEnv: true,
    timeoutMs: config.waitTimeoutMs + 1_000,
  });
  const waitEnvelope = parseEnvelope(waitResult.stdout);
  if (
    !waitResult.ok
    || waitEnvelope?.ok !== true
    || waitEnvelope.result?.wait?.condition !== 'exit'
    || waitEnvelope.result?.wait?.satisfied !== true
  ) {
    return failedCommand(
      'orca terminal wait',
      waitResult,
      'watched terminal exit was not confirmed',
    );
  }

  const finalBindingFailure = targetBindingFailure(adapter, target.identity);
  if (finalBindingFailure) return finalBindingFailure;

  const dispatch = adapter.dispatchInput(
    { worker: target.identity, text: config.wakeText },
    { timeoutMs: RUNTIME_TIMEOUT_MS },
  );
  return confirmedDispatch(target.identity, dispatch);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage());
    return 0;
  }

  let config: UnitWatcherWakeConfig;
  try {
    config = parseUnitWatcherWakeArgs(argv);
  } catch (error) {
    process.stderr.write(
      'unit watcher wake usage error: '
      + (error instanceof Error ? error.message : String(error))
      + '\n'
      + usage(),
    );
    return 1;
  }

  const result = await runUnitWatcherWake(config);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(
        'unit watcher wake failed: '
        + (error instanceof Error ? error.message : String(error))
        + '\n',
      );
      process.exitCode = 1;
    },
  );
}
