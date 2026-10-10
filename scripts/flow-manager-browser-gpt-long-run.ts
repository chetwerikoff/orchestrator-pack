#!/usr/bin/env node
import './toolchain/native-entrypoint-preflight.ts';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settleCliMain } from './chatgpt-browser-turn/cli-main.ts';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { runProcess } from './kernel/subprocess.ts';
import {
  HANDOFF_SCHEMA,
  isWakeableTerminalEnvelopePath,
  parseFlagArgv,
  readHandoffReceipt,
  readInvocationReceiptLocator,
  type HandoffReceipt,
  unwakeableTerminalEnvelopeHint,
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
    { flag: '--owner-task-id', value: 'id' },
    { flag: '--owner-dispatch-id', value: 'id' },
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

async function waitForReceipt(
  path: string,
  runIdentity: string,
  attemptIdentity: string,
  invocationId: string,
): Promise<HandoffReceipt | null> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const receipt = readHandoffReceipt(path, { runIdentity, attemptIdentity });
    if (receipt?.invocation_id === invocationId) return receipt;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  return null;
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
  // Mirror the launcher's existing two-part fixture gate; never relax production wake-path checks.
  const fixtureRoot = process.env.OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT;
  const trustedFixtureRoot = process.env.OPK_FM_LONG_CHILD_TEST_GATE === 'fixture-root-v1'
    && typeof fixtureRoot === 'string' && isAbsolute(fixtureRoot)
    ? resolve(fixtureRoot)
    : undefined;
  if (!isWakeableTerminalEnvelopePath(terminalEnvelope, trustedFixtureRoot)) {
    return refuse('terminal_envelope_name_not_wakeable: ' + unwakeableTerminalEnvelopeHint(terminalEnvelope).hint);
  }
  const browserOutput = requiredOption(options, 'output');
  const profile = requiredOption(options, 'profile');
  const cdp = requiredOption(options, 'cdp');
  const input = requiredOption(options, 'input');
  const cwd = typeof options.get('cwd') === 'string' ? options.get('cwd') as string : repoRoot;
  const ownerTaskId = options.has('owner-task-id') ? requiredOption(options, 'owner-task-id') : undefined;
  const ownerDispatchId = options.has('owner-dispatch-id') ? requiredOption(options, 'owner-dispatch-id') : undefined;

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
    '--invocation-id', invocationId,
    '--profile', profile,
    '--cdp', cdp,
    ...(ownerTaskId ? ['--owner-task-id', ownerTaskId] : []),
    ...(ownerDispatchId ? ['--owner-dispatch-id', ownerDispatchId] : []),
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

  // Detached return is a shell-observed PID; synchronous return is an exit status.
  // Neither value is an authoritative launcher PID. The original committed receipt is.
  try {
    await (deps.spawnLauncher ?? spawnDetachedLauncher)(launcherArgs);
  } catch (error) {
    return refuse('launcher_start_failed: ' + (error instanceof Error ? error.message : String(error)));
  }
  const receipt = await waitForReceipt(handoffReceipt, runIdentity, attemptIdentity, invocationId);
  if (!receipt) return refuse('handoff_receipt_missing_or_invocation_mismatch');
  let receiptLocator: string;
  try {
    const bound = readInvocationReceiptLocator({ invocationId, runIdentity, attemptIdentity });
    receiptLocator = bound.path;
    if (bound.locator.handoff_receipt_path !== resolve(handoffReceipt)
      || bound.locator.terminal_envelope_path !== resolve(terminalEnvelope)
      || JSON.stringify(bound.receipt) !== JSON.stringify(receipt)
      || !Number.isSafeInteger(bound.receipt.launcher_pid) || (bound.receipt.launcher_pid ?? 0) <= 1
      || bound.receipt.child_cwd !== realpathSync(cwd)
      || bound.receipt.owner_task_id !== ownerTaskId
      || bound.receipt.owner_dispatch_id !== ownerDispatchId) {
      throw new Error('identity_or_provenance_mismatch');
    }
  } catch (error) {
    return refuse('receipt_locator_readback_failed: ' + (error instanceof Error ? error.message : String(error)));
  }
  process.stdout.write(JSON.stringify({
    schema: 'flow-manager-browser-gpt-long-run-accepted/v1',
    run_identity: runIdentity,
    attempt_identity: attemptIdentity,
    invocation_id: invocationId,
    launcher_pid: receipt.launcher_pid,
    handoff_receipt: handoffReceipt,
    receipt_locator: receiptLocator,
    terminal_envelope: terminalEnvelope,
    browser_output: browserOutput,
    child_cwd: receipt.child_cwd,
    ...(receipt.owner_task_id ? { owner_task_id: receipt.owner_task_id } : {}),
    ...(receipt.owner_dispatch_id ? { owner_dispatch_id: receipt.owner_dispatch_id } : {}),
    ...(receipt.launching_terminal_handle ? { launching_terminal_handle: receipt.launching_terminal_handle } : {}),
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
