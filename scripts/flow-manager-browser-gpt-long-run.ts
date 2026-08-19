#!/usr/bin/env node
import './toolchain/native-entrypoint-preflight.ts';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { runProcess } from './kernel/subprocess.ts';
import {
  HANDOFF_SCHEMA,
  parseFlagArgv,
  readHandoffReceipt,
} from './flow-manager-long-running-child.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcherPath = join(repoRoot, 'scripts/flow-manager-long-running-child.ts');
const browserEntry = join(repoRoot, 'scripts/chatgpt-browser-turn/state-light-entry.ts');

function requiredOption(options: Map<string, string | true>, key: string): string {
  const value = options.get(key);
  if (typeof value !== 'string' || !value.trim()) throw new Error(`argument_required:${key}`);
  return value;
}

function refuse(reason: string): void {
  process.stderr.write(`${JSON.stringify({ schema: 'flow-manager-browser-gpt-long-run-refusal/v1', reason })}\n`);
  process.exitCode = 2;
}

function refuseStaleHandoffReceipt(
  handoffReceipt: string,
  runIdentity: string,
  attemptIdentity: string,
): boolean {
  if (!existsSync(handoffReceipt) || statSync(handoffReceipt).size === 0) return false;
  try {
    const body = JSON.parse(readFileSync(handoffReceipt, 'utf8')) as {
      schema?: string;
      run_identity?: string;
      attempt_identity?: string;
    };
    if (body.schema !== HANDOFF_SCHEMA) return false;
    if (body.run_identity === runIdentity && body.attempt_identity === attemptIdentity) return false;
  } catch {
    return false;
  }
  refuse('stale_handoff_receipt');
  return true;
}

async function waitForReceipt(
  path: string,
  runIdentity: string,
  attemptIdentity: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = readHandoffReceipt(path, { runIdentity, attemptIdentity });
    if (receipt) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  return false;
}

export async function spawnDetachedLauncher(launcherArgs: readonly string[]): Promise<number> {
  if (process.env.OPK_FM_LONG_CHILD_DISABLE_DETACH === '1') {
    const result = await runProcess({
      command: process.execPath,
      args: ['--experimental-strip-types', launcherPath, ...launcherArgs],
      cwd: repoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: true,
      timeoutMs: 120_000,
    });
    if (!result.ok && result.outcome !== 'exit') throw new Error(`launcher_failed:${result.outcome}`);
    return result.exitCode ?? 1;
  }
  const result = await runProcess({
    command: '/bin/sh',
    args: [
      '-c',
      'node_bin="$1"; launcher="$2"; shift 2; trap "" HUP; "$node_bin" --experimental-strip-types "$launcher" "$@" </dev/null >/dev/null 2>&1 & printf "%s\\n" "$!"',
      'opk-fm-long-child-detach',
      process.execPath,
      launcherPath,
      ...launcherArgs,
    ],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 10_000,
  });
  if (!result.ok) throw new Error(`detach_failed:${result.stderr || result.error}`);
  const pid = Number(result.stdout.trim());
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('detach_pid_invalid');
  return pid;
}

export async function runBrowserAdapter(argv: readonly string[]): Promise<number> {
  if (argv.some((token) => token === '--completion-mode' || token === '--authority' || token === '--result-protocol')) {
    refuse('forbidden_authority_selector');
    return 2;
  }
  const options = parseFlagArgv(argv);
  const runIdentity = requiredOption(options, 'run-identity');
  const attemptIdentity = requiredOption(options, 'attempt-identity');
  const handoffReceipt = requiredOption(options, 'handoff-receipt');
  if (refuseStaleHandoffReceipt(handoffReceipt, runIdentity, attemptIdentity)) return 2;
  const invocationId = requiredOption(options, 'invocation-id');
  const terminalEnvelope = requiredOption(options, 'terminal-envelope');
  const browserOutput = requiredOption(options, 'output');
  const reviewerSourceOutput = typeof options.get('reviewer-source-output') === 'string'
    ? options.get('reviewer-source-output') as string
    : undefined;
  const directArgumentKeys = [
    'reviewer-source',
    'repository',
    'issue-number',
    'source-revision',
    'stage',
    'source-slot',
  ];
  const directRequested = reviewerSourceOutput !== undefined
    || directArgumentKeys.some((key) => options.has(key));
  if (directRequested && (
    reviewerSourceOutput === undefined
    || directArgumentKeys.some((key) => typeof options.get(key) !== 'string')
  )) {
    refuse('direct_publication_arguments_required');
    return 2;
  }
  const profile = requiredOption(options, 'profile');
  const cdp = requiredOption(options, 'cdp');
  const input = requiredOption(options, 'input');
  const cwd = typeof options.get('cwd') === 'string' ? options.get('cwd') as string : repoRoot;

  const browserArgs = [
    'turn',
    '--invocation-id', invocationId,
    '--profile', profile,
    '--cdp', cdp,
    '--input', input,
    '--output', browserOutput,
  ];
  if (reviewerSourceOutput) browserArgs.push('--reviewer-source-output', reviewerSourceOutput);
  for (const key of [
    'reviewer-source',
    'repository',
    'issue-number',
    'source-revision',
    'stage',
    'source-slot',
    'timeout-ms',
    'poll-ms',
  ]) {
    if (typeof options.get(key) === 'string') browserArgs.push(`--${key}`, options.get(key) as string);
  }
  if (typeof options.get('chat-url') === 'string') browserArgs.push('--chat-url', options.get('chat-url') as string);
  if (options.get('new-chat') === true) browserArgs.push('--new-chat');
  if (typeof options.get('project-url') === 'string') browserArgs.push('--project-url', options.get('project-url') as string);

  const launcherArgs = [
    'launch',
    '--run-identity', runIdentity,
    '--attempt-identity', attemptIdentity,
    '--handoff-receipt', handoffReceipt,
    '--terminal-envelope', terminalEnvelope,
    '--browser-output', browserOutput,
    ...(reviewerSourceOutput ? ['--reviewer-source-output', reviewerSourceOutput] : []),
    '--cwd', cwd,
    ...(typeof options.get('chat-url') === 'string'
      ? ['--conversation-locator', options.get('chat-url') as string]
      : []),
    '--child-command', process.execPath,
    '--',
    '--experimental-strip-types',
    browserEntry,
    ...browserArgs,
  ];

  const pid = await spawnDetachedLauncher(launcherArgs);
  const receiptReady = await waitForReceipt(handoffReceipt, runIdentity, attemptIdentity, 30_000);
  if (!receiptReady) {
    refuse('handoff_receipt_missing');
    return 2;
  }
  const publicationExpectation = directRequested
    ? {
        kind: 'reviewer' as const,
        repository: options.get('repository') as string,
        issue_number: Number(options.get('issue-number')),
        source_revision: options.get('source-revision') as string,
        invocation_id: invocationId,
        stage: options.get('stage') as string,
        source_slot: options.get('source-slot') as string,
      }
    : undefined;
  process.stdout.write(`${JSON.stringify({
    schema: 'flow-manager-browser-gpt-long-run-accepted/v1',
    run_identity: runIdentity,
    attempt_identity: attemptIdentity,
    launcher_pid: pid,
    handoff_receipt: handoffReceipt,
    terminal_envelope: terminalEnvelope,
    browser_output: browserOutput,
    completion_mode: 'browser-turn-result-v1',
    ...(publicationExpectation ? { publication_expectation: publicationExpectation } : {}),
  })}\n`);
  return 0;
}

async function main(): Promise<void> {
  process.exitCode = await runBrowserAdapter(process.argv.slice(2));
}

const entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === entryPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export const ADAPTER_PACKAGE_COMMAND = 'npm run --silent flow-manager-browser-gpt-long-run --';
export const LAUNCHER_PACKAGE_COMMAND = 'npm run --silent flow-manager-long-running-child --';
