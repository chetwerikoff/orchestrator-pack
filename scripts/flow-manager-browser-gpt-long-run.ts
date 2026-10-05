#!/usr/bin/env node
import './toolchain/native-entrypoint-preflight.ts';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settleCliMain } from './chatgpt-browser-turn/cli-main.ts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { runProcess } from './kernel/subprocess.ts';
import {
  HANDOFF_SCHEMA,
  isWakeableTerminalEnvelopePath,
  parseFlagArgv,
  readHandoffReceipt,
  TERMINAL_ENVELOPE_NAME_SUFFIX,
} from './flow-manager-long-running-child.ts';
import {
  inspectManagerCliInvocation,
  type ManagerCliDeclaration,
} from './lib/manager-cli-contract.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcherPath = join(repoRoot, 'scripts/flow-manager-long-running-child.ts');
const browserEntry = join(repoRoot, 'scripts/chatgpt-browser-turn/state-light-entry.ts');

const CLI = {
  program: 'flow-manager-browser-gpt-long-run.ts',
  options: [
    { flag: '--run-identity', value: 'id', required: true },
    { flag: '--attempt-identity', value: 'id', required: true },
    { flag: '--handoff-receipt', value: 'path', required: true },
    { flag: '--invocation-id', value: 'id', required: true },
    { flag: '--terminal-envelope', value: 'path', required: true },
    { flag: '--output', value: 'path', required: true },
    { flag: '--profile', value: 'key', required: true },
    { flag: '--cdp', value: 'url', required: true },
    { flag: '--input', value: 'path', required: true },
    { flag: '--cwd', value: 'path' },
    { flag: '--project-url', value: 'url' },
    { flag: '--timeout-ms', value: 'ms' },
    { flag: '--poll-ms', value: 'ms' },
    { flag: '--chat-url', value: 'url' },
    { flag: '--new-chat' },
  ],
} as const satisfies ManagerCliDeclaration;

export const FLOW_MANAGER_BROWSER_GPT_CLI_DECLARATION = CLI;

function requiredOption(options: Map<string, string | true>, key: string): string {
  const value = options.get(key);
  if (typeof value !== 'string' || !value.trim()) throw new Error('argument_required:' + key);
  return value;
}

function refuse(reason: string): number {
  process.stderr.write('flow-manager-browser-gpt-long-run: ' + reason + '\n');
  return 2;
}

function staleReceipt(path: string, runIdentity: string, attemptIdentity: string): boolean {
  if (!existsSync(path) || statSync(path).size === 0) return false;
  try {
    const body = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return body.schema === HANDOFF_SCHEMA
      && (body.run_identity !== runIdentity || body.attempt_identity !== attemptIdentity);
  } catch {
    return false;
  }
}

async function waitForReceipt(path: string, runIdentity: string, attemptIdentity: string): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (readHandoffReceipt(path, { runIdentity, attemptIdentity })) return true;
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
    if (!result.ok && result.outcome !== 'exit') throw new Error('launcher_failed:' + result.outcome);
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
  if (!result.ok) throw new Error('detach_failed:' + (result.stderr || result.error));
  const pid = Number(result.stdout.trim());
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('detach_pid_invalid');
  return pid;
}

export interface BrowserAdapterDependencies {
  spawnLauncher?: typeof spawnDetachedLauncher;
}

export async function runBrowserAdapter(
  argv: readonly string[],
  deps: BrowserAdapterDependencies = {},
): Promise<number> {
  const inspection = inspectManagerCliInvocation(CLI, argv);
  if (inspection.help) {
    process.stdout.write(inspection.help + '\n');
    return 0;
  }
  if (inspection.error) {
    process.stderr.write('flow-manager-browser-gpt-long-run: ' + inspection.error + '\n');
    return 2;
  }
  if (argv.some((token) => token === '--completion-mode' || token === '--authority' || token === '--result-protocol')) {
    return refuse('forbidden_authority_selector');
  }

  const options = parseFlagArgv(argv);
  const runIdentity = requiredOption(options, 'run-identity');
  const attemptIdentity = requiredOption(options, 'attempt-identity');
  const handoffReceipt = requiredOption(options, 'handoff-receipt');
  if (staleReceipt(handoffReceipt, runIdentity, attemptIdentity)) return refuse('stale_handoff_receipt');

  const invocationId = requiredOption(options, 'invocation-id');
  const terminalEnvelope = requiredOption(options, 'terminal-envelope');
  if (!isWakeableTerminalEnvelopePath(terminalEnvelope)) {
    return refuse('terminal_envelope_name_not_wakeable: name must end in ' + TERMINAL_ENVELOPE_NAME_SUFFIX);
  }
  const browserOutput = requiredOption(options, 'output');
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
  for (const key of ['timeout-ms', 'poll-ms']) {
    if (typeof options.get(key) === 'string') browserArgs.push('--' + key, options.get(key) as string);
  }
  if (typeof options.get('chat-url') === 'string') browserArgs.push('--chat-url', options.get('chat-url') as string);
  if (typeof options.get('project-url') === 'string') browserArgs.push('--project-url', options.get('project-url') as string);
  if (options.get('new-chat') === true) browserArgs.push('--new-chat');

  const launcherArgs = [
    'launch',
    '--run-identity', runIdentity,
    '--attempt-identity', attemptIdentity,
    '--handoff-receipt', handoffReceipt,
    '--terminal-envelope', terminalEnvelope,
    '--browser-output', browserOutput,
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

  const pid = await (deps.spawnLauncher ?? spawnDetachedLauncher)(launcherArgs);
  if (!(await waitForReceipt(handoffReceipt, runIdentity, attemptIdentity))) {
    return refuse('handoff_receipt_missing');
  }
  process.stdout.write(JSON.stringify({
    schema: 'flow-manager-browser-gpt-long-run-accepted/v1',
    run_identity: runIdentity,
    attempt_identity: attemptIdentity,
    launcher_pid: pid,
    handoff_receipt: handoffReceipt,
    terminal_envelope: terminalEnvelope,
    browser_output: browserOutput,
    completion_mode: 'browser-turn-result-v1',
  }) + '\n');
  return 0;
}

async function main(): Promise<void> {
  process.exitCode = await runBrowserAdapter(process.argv.slice(2));
}

const entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === entryPath) {
  settleCliMain(main);
}

export const ADAPTER_PACKAGE_COMMAND = 'npm run --silent flow-manager-browser-gpt-long-run --';
export const LAUNCHER_PACKAGE_COMMAND = 'npm run --silent flow-manager-long-running-child --';
