#!/usr/bin/env node
import './toolchain/native-entrypoint-preflight.ts';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settleCliMain } from './chatgpt-browser-turn/cli-main.ts';
import { realpathSync } from 'node:fs';
import { runProcess } from './kernel/subprocess.ts';
import {
  launchConfigFromArgv,
  parseFlagArgv,
  readHandoffReceipt,
  readInvocationReceiptLocator,
  readRefusalCompanion,
  REFUSAL_COMPANION_ENV,
  resolveDurableArtifactPath,
  sameHandoffIdentity,
  validateLaunchPreSpawn,
  type HandoffReceipt,
  type LaunchPreSpawnValidation,
} from './flow-manager-long-running-child.ts';
import {
  absoluteProfilePathError, configuredProfileKey, PROFILE_ABSOLUTE_NEXT_STEP, PROFILE_ABSOLUTE_REQUIRED_CODE,
} from './chatgpt-browser-turn/storage-common.ts';
import {
  parseBoundIssueSelector,
  parsePrAuthorBindingPair,
  prAuthorHeadMismatch,
  prelaunchPrAuthorOccupant,
  readPrAuthorHeadViaPackGh,
  readWorktreeBranch,
  PR_AUTHOR_OCCUPIED_NEXT_ACTION,
  type PrAuthorHeadReader,
  type PrAuthorProcessReader,
} from './chatgpt-browser-turn/state-light-turn-base.ts';
import { resolveTargetContext } from './lib/target-context.ts';
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
    { flag: '--profile', value: 'absolute-user-data-dir', required: true },
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
    { flag: '--predecessor-invocation-id', value: 'id' },
    { flag: '--predecessor-attempt-identity', value: 'id' },
    { flag: '--bound-issue', value: 'owner/repo#number' },
    { flag: '--repo', value: 'owner/repo' },
    { flag: '--pr', value: 'number' },
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

/** After a launcher may have started: known wrapper code, never a hidden child code or zero-SEND claim. */
const POSTSPAWN_RECONCILE_STEP = 'physical SEND unknown (POSSIBLY_DELIVERED; no resend license): run the original-invocation '
  + 'owner wait (wait --invocation-id <id> --owner-task-id <task> --owner-dispatch-id <dispatch> --profile <absolute-user-data-dir> --cdp <url>), '
  + 'inspect the original Page and the exact bound GitHub target before any new SEND';

function refusePostspawn(code: string): number {
  return refuse(code + '; nextStep: ' + POSTSPAWN_RECONCILE_STEP);
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

export interface LauncherSpawnObservation {
  /** OS PID of this newly spawned launcher, never a shell exit status. */
  readonly launcherPid: number;
  /** Present only in synchronous mode; a pre-spawn refusal exits 2. */
  readonly exitCode?: number;
}

export async function spawnDetachedLauncher(launcherArgs: readonly string[]): Promise<LauncherSpawnObservation> {
  if (process.env.OPK_FM_LONG_CHILD_DISABLE_DETACH === '1') {
    let launcherPid: number | undefined;
    const result = await runProcess({
      command: process.execPath,
      args: ['--experimental-strip-types', launcherPath, ...launcherArgs],
      cwd: repoRoot,
      inheritParentEnv: true,
      env: { [REFUSAL_COMPANION_ENV]: 'v1' },
      allowEmptyStdout: true,
      timeoutMs: 120_000,
      onSpawn: (pid) => { launcherPid = pid; },
    });
    if (!result.ok && result.outcome !== 'exit') throw new Error('launcher_failed:' + result.outcome);
    if (!launcherPid || !Number.isSafeInteger(launcherPid) || launcherPid <= 1) {
      throw new Error('launcher_spawn_pid_unavailable');
    }
    return { launcherPid, exitCode: result.exitCode ?? 1 };
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
    // The detached launcher's stderr is discarded; ask it for one bounded refusal companion.
    env: { [REFUSAL_COMPANION_ENV]: 'v1' },
    allowEmptyStdout: false,
    timeoutMs: 10_000,
  });
  if (!result.ok) throw new Error('detach_failed:' + (result.stderr || result.error));
  const pid = Number(result.stdout.trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('detach_pid_invalid');
  return { launcherPid: pid };
}

export interface BrowserAdapterDependencies {
  spawnLauncher?: typeof spawnDetachedLauncher;
  /** Shared in-process launcher pre-spawn validation seam; production uses the launcher's own validator. */
  validatePreSpawn?: (launcherArgs: readonly string[]) => LaunchPreSpawnValidation;
  /** PR-author (#2718) prelaunch seams; production uses the pack card, scripts/gh and /proc. */
  selectedRepository?: () => string;
  readPrAuthorHead?: PrAuthorHeadReader;
  readWorktreeBranch?: (cwd: string) => Promise<string | undefined>;
  processReader?: PrAuthorProcessReader;
}

const PR_AUTHOR_PAIR_NEXT_STEP = 'pass both --repo <owner/repo> and --pr <number> (PR author) or neither (Issue author, reviewer)';

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
  const invocationId = requiredOption(options, 'invocation-id');
  let handoffReceipt: string;
  let terminalEnvelope: string;
  try {
    handoffReceipt = resolveDurableArtifactPath(requiredOption(options, 'handoff-receipt'));
    terminalEnvelope = resolveDurableArtifactPath(requiredOption(options, 'terminal-envelope'));
  } catch (error) {
    return refuse('durable_artifact_root_invalid: ' + (error instanceof Error ? error.message : String(error))
      + '; nextStep: set HOME to an absolute directory');
  }
  const browserOutput = requiredOption(options, 'output');
  const profile = requiredOption(options, 'profile');
  const cdp = requiredOption(options, 'cdp');
  // Pre-SEND, before any occupancy hash, profile key or launcher validation: never resolve against cwd.
  const profileError = absoluteProfilePathError(profile);
  if (profileError) return refuse(PROFILE_ABSOLUTE_REQUIRED_CODE + ': ' + profileError + '; nextStep: ' + PROFILE_ABSOLUTE_NEXT_STEP);
  const input = requiredOption(options, 'input');
  const cwd = typeof options.get('cwd') === 'string' ? options.get('cwd') as string : repoRoot;
  const ownerTaskId = options.has('owner-task-id') ? requiredOption(options, 'owner-task-id') : undefined;
  const ownerDispatchId = options.has('owner-dispatch-id') ? requiredOption(options, 'owner-dispatch-id') : undefined;
  if (!ownerTaskId?.trim()) {
    return refuse('owner_task_id_required; nextStep: pass the upstream-admitted --owner-task-id for this managed launch');
  }
  if (!ownerDispatchId?.trim()) {
    return refuse('owner_dispatch_id_required; nextStep: pass the upstream-admitted --owner-dispatch-id for this managed launch');
  }
  const predecessorInvocation = options.get('predecessor-invocation-id');
  const predecessorAttempt = options.get('predecessor-attempt-identity');
  const hasPredecessor = typeof predecessorInvocation === 'string' && typeof predecessorAttempt === 'string';
  if ((predecessorInvocation !== undefined || predecessorAttempt !== undefined) && !hasPredecessor) {
    return refuse('predecessor_invocation_and_attempt_required; nextStep: supply the exact earlier invocation and attempt selector, then let its durable locator provide its original Run and owner pair');
  }
  if (hasPredecessor && predecessorInvocation === invocationId) {
    return refuse('predecessor_self_invocation_forbidden; nextStep: pass a genuinely earlier --predecessor-invocation-id/--predecessor-attempt-identity pair '
      + '(not this --invocation-id), or omit both for separately admitted independent work; nothing was sent');
  }
  // #2718: --repo/--pr is an atomic optional pair. Absent = unbound (unchanged);
  // present = PR AUTHOR, admitted only for an explicit worktree whose branch is
  // the head of the OPEN bound PR in the selected card repository.
  const prAuthorPair = parsePrAuthorBindingPair(
    typeof options.get('repo') === 'string' ? options.get('repo') as string : undefined,
    typeof options.get('pr') === 'string' ? options.get('pr') as string : undefined,
  );
  if (prAuthorPair.error) return refuse(prAuthorPair.error + '; nextStep: ' + PR_AUTHOR_PAIR_NEXT_STEP);
  const prAuthor = prAuthorPair.binding;
  const selectRepository = (): string => (deps.selectedRepository ?? (() => resolveTargetContext().repository))().toLowerCase();
  // Upstream Task/Dispatch-bound managed Issue target; never guessed from prompt, URL or GitHub activity.
  let boundIssue: ReturnType<typeof parseBoundIssueSelector>;
  try {
    boundIssue = parseBoundIssueSelector(typeof options.get('bound-issue') === 'string'
      ? options.get('bound-issue') as string : undefined);
  } catch {
    return refuse('bound_issue_selector_invalid; nextStep: pass --bound-issue <owner/repo>#<number> from the upstream Task/Dispatch binding, or omit it');
  }
  if (boundIssue && prAuthor) {
    return refuse('bound_issue_conflicts_with_pr_author; nextStep: pass either --repo/--pr (PR author) or --bound-issue (Issue author/reviewer), not both');
  }
  if (boundIssue) {
    let selectedRepository: string;
    try {
      selectedRepository = selectRepository();
    } catch (error) {
      return refuse('bound_issue_target_card_unavailable: ' + (error instanceof Error ? error.message : String(error))
        + '; nextStep: set OPK_PROJECT_ID to the project whose card repository owns the Issue');
    }
    if (selectedRepository !== boundIssue.repo) {
      return refuse('bound_issue_repository_not_selected_card; nextStep: --bound-issue repository must equal the selected card repository '
        + selectedRepository);
    }
  }
  if (prAuthor) {
    if (typeof options.get('cwd') !== 'string') {
      return refuse('pr_author_cwd_required; nextStep: pass --cwd <worktree> whose branch is the PR head ref');
    }
    let selectedRepository: string;
    try {
      selectedRepository = selectRepository();
    } catch (error) {
      return refuse('pr_author_target_card_unavailable: ' + (error instanceof Error ? error.message : String(error))
        + '; nextStep: set OPK_PROJECT_ID to the project whose card repository owns the PR');
    }
    if (selectedRepository !== prAuthor.repo) {
      return refuse('pr_author_repository_not_selected_card; nextStep: --repo must equal the selected card repository '
        + selectedRepository);
    }
    const head = await (deps.readPrAuthorHead ?? readPrAuthorHeadViaPackGh)(prAuthor).catch(() => undefined);
    const branch = await (deps.readWorktreeBranch ?? readWorktreeBranch)(cwd).catch(() => undefined);
    const mismatch = prAuthorHeadMismatch(head, prAuthor, branch);
    if (mismatch) {
      return refuse(mismatch + '; nextStep: bind an OPEN PR of ' + prAuthor.repo
        + ' whose head ref is the --cwd worktree branch');
    }
    // Zero-tab fast path only; the decisive check is the child's PRE-SEND scan.
    const occupant = prelaunchPrAuthorOccupant({
      binding: prAuthor,
      profileKey: configuredProfileKey(profile, cdp),
      worktree: cwd,
      ...(deps.processReader ? { reader: deps.processReader } : {}),
    });
    if (occupant) {
      return refuse('pr_author_occupied: conversation_busy by invocation ' + occupant
        + '; nextStep: ' + PR_AUTHOR_OCCUPIED_NEXT_ACTION);
    }
  }
  // Only pass the exact paired selector. The long-running child authenticates
  // its own handoff against the prior indexed receipt/terminal before spawning
  // the driver; this wrapper has no target-cleanup authority.

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
  if (prAuthor) browserArgs.push('--repo', prAuthor.repo, '--pr', String(prAuthor.pr));
  if (boundIssue) browserArgs.push('--bound-issue', `${boundIssue.repo}#${boundIssue.issue}`);
  if (hasPredecessor) browserArgs.push(
    '--predecessor-invocation-id', predecessorInvocation as string,
    '--predecessor-attempt-identity', predecessorAttempt as string,
  );

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

  // One shared in-process launcher pre-spawn validation, before detachment. It reserves nothing;
  // the launcher alone reserves the invocation key when it re-runs the same validator.
  let validation: LaunchPreSpawnValidation;
  try {
    validation = (deps.validatePreSpawn ?? ((args) => validateLaunchPreSpawn(launchConfigFromArgv(args.slice(1)))))(launcherArgs);
  } catch (error) {
    return refuse('launch_arguments_invalid: ' + (error instanceof Error ? error.message : String(error))
      + '; nextStep: correct the adapter arguments and relaunch the same invocation id');
  }
  if (!validation.ok) {
    return refuse(validation.code + '; nextStep: ' + String(validation.details.nextStep));
  }

  // Require the newly started OS process as a witness, not merely a matching old receipt.
  let spawn: LauncherSpawnObservation;
  try {
    spawn = await (deps.spawnLauncher ?? spawnDetachedLauncher)(launcherArgs);
  } catch (error) {
    return refusePostspawn('launcher_start_failed: ' + (error instanceof Error ? error.message : String(error)));
  }
  if (!Number.isSafeInteger(spawn.launcherPid) || spawn.launcherPid <= 1) {
    return refusePostspawn('launcher_process_identity_unavailable');
  }
  const receipt = spawn.exitCode === 2 ? null
    : await waitForReceipt(handoffReceipt, runIdentity, attemptIdentity, invocationId);
  if (!receipt) {
    // Authenticated same-invocation/Run/attempt launcher pre-SEND refusal: relay its observed code.
    const companion = readRefusalCompanion(handoffReceipt, {
      runIdentity, attemptIdentity, invocationId, launcherPid: spawn.launcherPid,
    });
    if (companion) return refuse(companion.code + '; nextStep: ' + companion.nextStep);
    return refusePostspawn(spawn.exitCode === 2 ? 'launcher_refused_without_companion' : 'handoff_receipt_missing');
  }
  if (receipt.launcher_pid !== spawn.launcherPid) {
    return refusePostspawn('handoff_new_launcher_pid_mismatch');
  }
  let receiptLocator: string;
  try {
    const bound = readInvocationReceiptLocator({ invocationId, runIdentity, attemptIdentity });
    receiptLocator = bound.path;
    if (bound.locator.handoff_receipt_path !== resolve(handoffReceipt)
      || bound.locator.terminal_envelope_path !== resolve(terminalEnvelope)
      || !sameHandoffIdentity(bound.receipt, receipt)
      || bound.receipt.launcher_pid !== spawn.launcherPid
      || bound.receipt.child_cwd !== realpathSync(cwd)
      || bound.receipt.owner_task_id !== ownerTaskId
      || bound.receipt.owner_dispatch_id !== ownerDispatchId) {
      throw new Error('identity_or_provenance_mismatch');
    }
  } catch (error) {
    return refusePostspawn('receipt_locator_readback_failed: ' + (error instanceof Error ? error.message : String(error)));
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
