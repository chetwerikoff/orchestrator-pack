#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  runProcessSync,
  type ProcessResult,
  type RunProcessSyncOptions,
} from './kernel/subprocess.ts';
import { resolveOrcaExecutable } from './orca-runtime/native.ts';

const DEFAULT_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const SEND_TIMEOUT_MS = 10_000;

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

interface OrcaEnvelope {
  readonly ok?: unknown;
  readonly result?: {
    readonly wait?: {
      readonly condition?: unknown;
      readonly satisfied?: unknown;
      readonly status?: unknown;
      readonly exitCode?: unknown;
    };
    readonly send?: {
      readonly accepted?: unknown;
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
    'The helper waits for the watched Orca terminal to exit, then sends the wake text',
    'to the target terminal with --enter. Submission is confirmed only by',
    'result.send.accepted === true in Orca JSON output.',
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

function failed(label: string, result: ProcessResult, reason: string): UnitWatcherWakeResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: 'unit watcher wake failed: ' + reason + '\n'
      + commandOutput(label, result) + '\n',
  };
}

export function runUnitWatcherWake(
  config: UnitWatcherWakeConfig,
  dependencies: {
    readonly run?: WatcherCommandRunner;
    readonly executable?: string;
  } = {},
): UnitWatcherWakeResult {
  const run = dependencies.run ?? runProcessSync;
  const executable = dependencies.executable ?? resolveOrcaExecutable();

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
    return failed('orca terminal wait', waitResult, 'watched terminal exit was not confirmed');
  }

  const sendResult = run({
    command: executable,
    args: [
      'terminal', 'send',
      '--terminal', config.targetTerminal,
      '--text', config.wakeText,
      '--enter',
      '--json',
    ],
    inheritParentEnv: true,
    timeoutMs: SEND_TIMEOUT_MS,
  });
  const sendEnvelope = parseEnvelope(sendResult.stdout);

  if (
    sendResult.ok
    && sendEnvelope?.ok === true
    && sendEnvelope.result?.send?.accepted === true
  ) {
    return {
      exitCode: 0,
      stdout: 'watcher wake submission confirmed: accepted:true target='
        + config.targetTerminal + '\n',
      stderr: '',
    };
  }

  if (sendResult.ok && sendEnvelope?.ok === true) {
    return failed(
      'orca terminal send',
      sendResult,
      'delivery-unknown: result.send.accepted was not true',
    );
  }

  return failed('orca terminal send', sendResult, 'terminal send was not accepted');
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
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

  const result = runUnitWatcherWake(config);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  process.exitCode = main();
}
