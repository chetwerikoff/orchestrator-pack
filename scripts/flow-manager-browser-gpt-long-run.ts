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
import {
  runCreateIssueBrowserPreflight,
  type CreateIssueBrowserPreflightFailure,
} from './lib/create-issue-browser-gpt-preflight.ts';
import {
  createIssueNextAction,
  createIssueRecoverableResult,
  createIssueStaleNextAction,
  createIssueTerminalResult,
  type CreateIssueActionBinding,
  type CreateIssueSemanticStage,
} from './lib/create-issue-next-action.ts';
import { emitCreateIssueManagerResult } from './lib/create-issue-manager-boundary.ts';
import {
  inspectLifecycleInvocationBinding,
  recordLifecycleInvocationAdmission,
  type LifecycleReviewStage,
} from './lib/create-issue-stage-lifecycle.ts';
import { defaultGhTransport, fetchIssueRevision } from './lib/create-issue-stage-record-gh.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcherPath = join(repoRoot, 'scripts/flow-manager-long-running-child.ts');
const browserEntry = join(repoRoot, 'scripts/chatgpt-browser-turn/state-light-entry.ts');
const adapterPath = join(repoRoot, 'scripts/flow-manager-browser-gpt-long-run.ts');

function requiredOption(options: Map<string, string | true>, key: string): string {
  const value = options.get(key);
  if (typeof value !== 'string' || !value.trim()) throw new Error(`argument_required:${key}`);
  return value;
}

function emitBrowserManagerResult(argv: readonly string[], result: unknown): number {
  return emitCreateIssueManagerResult({
    producer: 'flow-manager-browser-gpt-long-run.ts:main',
    currentArgv: argv,
    produce: () => result,
  }).exitCode;
}

function refuse(argv: readonly string[], reason: string, details: Record<string, unknown> = {}): number {
  process.stderr.write(`flow-manager-browser-gpt-long-run: ${reason}\n`);
  const binding = createIssueBinding(parseFlagArgv(argv));
  // Ungoverned adapter/library callers keep the historical refusal contract.
  // A create-Issue manager invocation is identifiable only once its action
  // binding is present; those bound calls continue through the manager boundary.
  if (!binding) return 2;
  const detail = [
    reason,
    typeof details.blocker === 'string' ? details.blocker : '',
    typeof details.remedy === 'string' ? details.remedy : '',
  ].filter(Boolean).join(': ');
  return emitCreateIssueManagerResult({
    producer: 'flow-manager-browser-gpt-long-run.ts:main',
    currentArgv: argv,
    ...(binding ? { reconcileAction: browserReconcileAction(binding) } : {}),
    produce: () => {
      throw new Error(detail);
    },
  }).exitCode;
}

function browserReconcileAction(binding: CreateIssueActionBinding) {
  const actionArgv = [
    'node', '--experimental-strip-types', 'scripts/create-issue-stage-finalize.ts',
    'reconcile-stage',
    '--repo', binding.repository,
    '--issue-number', String(binding.issueNumber),
    '--expected-source-revision', binding.sourceRevision,
    '--expected-stage', binding.stage,
  ];
  if (binding.stageAttemptId) actionArgv.push('--expected-stage-attempt-id', binding.stageAttemptId);
  actionArgv.push('--json');
  return createIssueNextAction({
    kind: 'reconcile-stage-read-only',
    binding,
    argv: actionArgv,
  });
}

function projectPreflightFailure(
  argv: readonly string[],
  result: CreateIssueBrowserPreflightFailure,
): number {
  process.stderr.write(`flow-manager-browser-gpt-long-run: ${result.blocker}\n`);
  if (result.nextAction) {
    return emitBrowserManagerResult(argv, createIssueRecoverableResult({
      cause: result.cause,
      blocker: result.blocker,
      nextAction: result.nextAction,
    }));
  }
  return refuse(argv, result.cause, {
    blocker: result.blocker,
    remedy: result.remedy,
  });
}

export interface BrowserAdapterDependencies {
  runPreflight?: typeof runCreateIssueBrowserPreflight;
  readIssueRevision?: (repository: string, issueNumber: number) => { title: string; body: string; labels: string[] };
  inspectLifecycleBinding?: typeof inspectLifecycleInvocationBinding;
  recordAdmission?: typeof recordLifecycleInvocationAdmission;
  spawnLauncher?: typeof spawnDetachedLauncher;
}

function staleHandoffReceiptResult(
  argv: readonly string[],
  handoffReceipt: string,
  runIdentity: string,
  attemptIdentity: string,
): number | null {
  if (!existsSync(handoffReceipt) || statSync(handoffReceipt).size === 0) return null;
  try {
    const body = JSON.parse(readFileSync(handoffReceipt, 'utf8')) as {
      schema?: string;
      run_identity?: string;
      attempt_identity?: string;
    };
    if (body.schema !== HANDOFF_SCHEMA) return null;
    if (body.run_identity === runIdentity && body.attempt_identity === attemptIdentity) return null;
  } catch {
    return null;
  }
  const binding = createIssueBinding(parseFlagArgv(argv));
  if (binding) {
    return emitBrowserManagerResult(argv, createIssueRecoverableResult({
      cause: 'stale_handoff_receipt',
      blocker: 'handoff receipt belongs to a different run/attempt identity',
      nextAction: browserReconcileAction(binding),
    }));
  }
  return refuse(argv, 'stale_handoff_receipt');
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

export async function spawnDetachedLauncher(
  launcherArgs: readonly string[],
  envOverrides: Readonly<Record<string, string>> = {},
): Promise<number> {
  const env = { ...process.env, ...envOverrides };
  if (process.env.OPK_FM_LONG_CHILD_DISABLE_DETACH === '1') {
    const result = await runProcess({
      command: process.execPath,
      args: ['--experimental-strip-types', launcherPath, ...launcherArgs],
      cwd: repoRoot,
      env,
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
    env,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 10_000,
  });
  if (!result.ok) throw new Error(`detach_failed:${result.stderr || result.error}`);
  const pid = Number(result.stdout.trim());
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('detach_pid_invalid');
  return pid;
}

function createIssueBinding(
  options: Map<string, string | true>,
): CreateIssueActionBinding | null {
  const repository = options.get('repository');
  const issueNumber = Number(options.get('issue-number'));
  const sourceRevision = options.get('source-revision');
  const stage = options.get('stage');
  if (
    typeof repository !== 'string'
    || !Number.isSafeInteger(issueNumber)
    || issueNumber < 1
    || typeof sourceRevision !== 'string'
    || (stage !== 'competitive'
      && stage !== 'architectural-review'
      && stage !== 'architectural-lens'
      && stage !== 'architectural')
  ) return null;
  const stageAttemptId = options.get('stage-attempt-id');
  return {
    repository,
    issueNumber,
    sourceRevision,
    stage: stage as CreateIssueSemanticStage,
    ...(typeof stageAttemptId === 'string' && stageAttemptId.trim() ? { stageAttemptId } : {}),
  };
}

export async function runBrowserAdapter(
  argv: readonly string[],
  deps: BrowserAdapterDependencies = {},
): Promise<number> {
  if (argv.some((token) => token === '--completion-mode' || token === '--authority' || token === '--result-protocol')) {
    return refuse(argv, 'forbidden_authority_selector');
  }
  const options = parseFlagArgv(argv);
  const runIdentity = requiredOption(options, 'run-identity');
  const attemptIdentity = requiredOption(options, 'attempt-identity');
  const handoffReceipt = requiredOption(options, 'handoff-receipt');
  const staleReceiptCode = staleHandoffReceiptResult(argv, handoffReceipt, runIdentity, attemptIdentity);
  if (staleReceiptCode !== null) return staleReceiptCode;
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
    'stage-attempt-id',
  ];
  const directRequested = reviewerSourceOutput !== undefined
    || directArgumentKeys.some((key) => options.has(key));
  if (directRequested && (
    reviewerSourceOutput === undefined
    || directArgumentKeys.some((key) => typeof options.get(key) !== 'string')
  )) {
    return refuse(argv, 'direct_publication_arguments_required');
  }
  const directStage = typeof options.get('stage') === 'string' ? options.get('stage') as string : undefined;
  const terminalInputBundle = typeof options.get('terminal-input-bundle') === 'string'
    ? options.get('terminal-input-bundle') as string
    : undefined;
  if (directRequested && directStage === 'architectural' && !terminalInputBundle) {
    return refuse(argv, 'direct_publication_terminal_bundle_required');
  }
  const reviewDir = typeof options.get('review-dir') === 'string'
    ? options.get('review-dir') as string
    : undefined;
  if (directRequested && directStage === 'architectural' && !reviewDir) {
    return refuse(argv, 'direct_publication_terminal_review_dir_required');
  }
  if (directRequested && directStage !== 'architectural' && reviewDir) {
    return refuse(argv, 'direct_publication_terminal_review_dir_unexpected');
  }
  if (directRequested && directStage !== 'architectural' && terminalInputBundle) {
    return refuse(argv, 'direct_publication_terminal_bundle_unexpected');
  }
  const profile = requiredOption(options, 'profile');
  const cdp = requiredOption(options, 'cdp');
  const input = requiredOption(options, 'input');
  const cwd = typeof options.get('cwd') === 'string' ? options.get('cwd') as string : repoRoot;

  let browserChildEnv: Record<string, string> = {};
  let resolvedProjectUrl = typeof options.get('project-url') === 'string'
    ? options.get('project-url') as string
    : undefined;
  if (directRequested) {
    const binding = createIssueBinding(options);
    if (!binding) {
      return refuse(argv, 'create_issue_browser_preflight_binding_invalid');
    }
    const operatorBrowserConfig = typeof options.get('operator-browser-config') === 'string'
      ? options.get('operator-browser-config') as string
      : undefined;
    const retryArgv = [process.execPath, '--experimental-strip-types', adapterPath, ...argv];
    const preflightRunner = deps.runPreflight ?? runCreateIssueBrowserPreflight;
    const preflight = preflightRunner({
      repository: binding.repository,
      cwd,
      operatorBrowserConfig,
      binding,
      retryArgv,
    });
    if (!preflight.ok) {
      return projectPreflightFailure(argv, preflight);
    }
    browserChildEnv = preflight.childEnv;
    resolvedProjectUrl = preflight.config.projectUrl;

    let liveRevision = '';
    try {
      const live = deps.readIssueRevision
        ? deps.readIssueRevision(binding.repository, binding.issueNumber)
        : fetchIssueRevision(defaultGhTransport(), binding.repository, binding.issueNumber);
      liveRevision = /<!--\s*source-revision:\s*(r[0-9]+)\s*-->/i.exec(live.body)?.[1] ?? '';
    } catch (error) {
      const retryAction = createIssueNextAction({
        kind: 'retry-create-issue-browser-preflight',
        binding,
        argv: retryArgv,
      });
      return emitBrowserManagerResult(argv, createIssueRecoverableResult({
        cause: 'source-unavailable',
        blocker: error instanceof Error ? error.message : String(error),
        nextAction: retryAction,
      }));
    }
    if (!liveRevision || liveRevision.toLowerCase() !== binding.sourceRevision.toLowerCase()) {
      return emitBrowserManagerResult(argv, createIssueStaleNextAction({
        binding,
        observed: {
          repository: binding.repository,
          issueNumber: binding.issueNumber,
          ...(liveRevision ? { sourceRevision: liveRevision } : {}),
        },
        nextAction: browserReconcileAction(binding),
      }));
    }

    const inspectBinding = deps.inspectLifecycleBinding ?? inspectLifecycleInvocationBinding;
    const lifecycleBinding = inspectBinding({
      issueNumber: binding.issueNumber,
      stage: binding.stage as LifecycleReviewStage,
      stageAttemptId: binding.stageAttemptId!,
      sourceRevision: binding.sourceRevision,
    });
    if (!lifecycleBinding.ok) {
      return emitBrowserManagerResult(argv, createIssueStaleNextAction({
        binding,
        observed: {
          repository: binding.repository,
          issueNumber: binding.issueNumber,
          sourceRevision: liveRevision,
          ...lifecycleBinding.observed,
        },
        nextAction: browserReconcileAction(binding),
      }));
    }

    try {
      const recordAdmission = deps.recordAdmission ?? recordLifecycleInvocationAdmission;
      recordAdmission({
        issueNumber: binding.issueNumber,
        stage: binding.stage as LifecycleReviewStage,
        stageAttemptId: binding.stageAttemptId!,
        sourceRevision: binding.sourceRevision,
        invocationId,
        reviewerSlot: options.get('source-slot') as string,
        terminalEnvelopePath: terminalEnvelope,
        reviewerSource: options.get('reviewer-source') as string,
        reviewerSourceOutputPath: reviewerSourceOutput,
      });
    } catch (error) {
      const observed = inspectBinding({
        issueNumber: binding.issueNumber,
        stage: binding.stage as LifecycleReviewStage,
        stageAttemptId: binding.stageAttemptId!,
        sourceRevision: binding.sourceRevision,
      });
      if (!observed.ok) {
        return emitBrowserManagerResult(argv, createIssueStaleNextAction({
          binding,
          observed: {
            repository: binding.repository,
            issueNumber: binding.issueNumber,
            sourceRevision: liveRevision,
            ...observed.observed,
          },
          nextAction: browserReconcileAction(binding),
        }));
      }
      const retryAction = createIssueNextAction({
        kind: 'retry-create-issue-browser-preflight',
        binding,
        argv: retryArgv,
      });
      return emitBrowserManagerResult(argv, createIssueRecoverableResult({
        cause: 'create_issue_lifecycle_admission_failed',
        blocker: error instanceof Error ? error.message : String(error),
        nextAction: retryAction,
      }));
    }
  }

  const browserArgs = [
    'turn',
    '--invocation-id', invocationId,
    '--profile', profile,
    '--cdp', cdp,
    '--input', input,
    '--output', browserOutput,
  ];
  if (reviewerSourceOutput) browserArgs.push('--reviewer-source-output', reviewerSourceOutput);
  if (terminalInputBundle) browserArgs.push('--terminal-input-bundle', terminalInputBundle);
  for (const key of [
    'reviewer-source',
    'repository',
    'issue-number',
    'source-revision',
    'stage',
    'source-slot',
    'review-dir',
    'timeout-ms',
    'poll-ms',
  ]) {
    if (typeof options.get(key) === 'string') browserArgs.push(`--${key}`, options.get(key) as string);
  }
  if (typeof options.get('chat-url') === 'string') browserArgs.push('--chat-url', options.get('chat-url') as string);
  if (options.get('new-chat') === true) browserArgs.push('--new-chat');
  if (resolvedProjectUrl) browserArgs.push('--project-url', resolvedProjectUrl);

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

  const spawnLauncher = deps.spawnLauncher ?? spawnDetachedLauncher;
  const pid = await spawnLauncher(launcherArgs, browserChildEnv);
  const receiptReady = await waitForReceipt(handoffReceipt, runIdentity, attemptIdentity, 30_000);
  if (!receiptReady) {
    return refuse(argv, 'handoff_receipt_missing');
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
        stage_attempt_id: options.get('stage-attempt-id') as string,
      }
    : undefined;
  const completed = {
    ...createIssueTerminalResult({ ok: true, cause: 'completed' }),
    schema: 'flow-manager-browser-gpt-long-run-accepted/v1',
    run_identity: runIdentity,
    attempt_identity: attemptIdentity,
    launcher_pid: pid,
    handoff_receipt: handoffReceipt,
    terminal_envelope: terminalEnvelope,
    browser_output: browserOutput,
    completion_mode: 'browser-turn-result-v1',
    ...(publicationExpectation ? { publication_expectation: publicationExpectation } : {}),
  };
  return emitBrowserManagerResult(argv, completed);
}

async function main(): Promise<void> {
  process.exitCode = await runBrowserAdapter(process.argv.slice(2));
}

const entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === entryPath) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(message + '\n');
    process.exitCode = refuse(
      process.argv.slice(2),
      'browser_adapter_uncaught',
      { blocker: message },
    );
  });
}

export const ADAPTER_PACKAGE_COMMAND = 'npm run --silent flow-manager-browser-gpt-long-run --';
export const LAUNCHER_PACKAGE_COMMAND = 'npm run --silent flow-manager-long-running-child --';
