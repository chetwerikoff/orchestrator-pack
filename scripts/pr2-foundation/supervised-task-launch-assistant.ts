#!/usr/bin/env -S node --experimental-strip-types

import '../toolchain/native-entrypoint-preflight.ts';
import { runProcess } from '../kernel/subprocess.ts';
import { evaluateCommandRuntimePreflight } from '../lib/command-runtime-bootstrap.mjs';
import { selectRuntimeAdapter } from '../runtime/registry.ts';
import type { RuntimeAdapter, RuntimeWorkerIdentity } from '../runtime/contracts.ts';
import { runSupervisedWorkerStart, type SupervisedWorkerStartResult } from './supervised-worker-start.ts';

export const LAUNCH_ASSISTANT_SCHEMA = 'supervised-task-launch-assistant/v1' as const;
export const LAUNCH_WORK_CLASSES = ['manager', 't1', 't2', 't3'] as const;
export type LaunchWorkClass = (typeof LAUNCH_WORK_CLASSES)[number];
export type LaunchStage = 'command_preflight' | 'repository_preflight' | 'executor_profile'
  | 'manager_run' | 'manager_task' | 'dispatch_admission_early' | 'worktree_prepare'
  | 'terminal_prepare' | 'dispatch_admission_final' | 'supervised_start';
export type LaunchActor = 'operator' | 'orchestrator' | 'manager' | 'provider';

export interface StageTiming {
  readonly stage: LaunchStage;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly elapsedMs: number;
  readonly outcome: 'passed' | 'continued';
}

export interface LaunchResources {
  readonly repository: string;
  readonly issueNumber?: number;
  readonly runId?: string;
  readonly taskId?: string;
  readonly worktreeId?: string;
  readonly worktreeSelector?: string;
  readonly worktreePath?: string;
  readonly terminal?: RuntimeWorkerIdentity;
  readonly dispatchId?: string;
}

export interface NextAction {
  readonly kind: 'repair_preflight' | 'repair_executor_profile' | 'reconcile_manager_run'
    | 'reconcile_manager_task' | 'retry_manager_task_create' | 'reconcile_dispatch'
    | 'reconcile_worktree_setup' | 'remediate_terminal' | 'retry_supervised_start'
    | 'reconcile_supervised_start';
  readonly requestId?: string;
  readonly command?: string;
  readonly note?: string;
}

export interface ContinueResult {
  readonly schema: typeof LAUNCH_ASSISTANT_SCHEMA;
  readonly outcome: 'continue';
  readonly workClass: LaunchWorkClass;
  readonly stage: LaunchStage;
  readonly observedCause: string;
  readonly resources: LaunchResources;
  readonly responsibleActor: LaunchActor;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly nextAction: NextAction;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly elapsedMs: number;
  readonly firstAbsentOrFailedCheckpoint: LaunchStage;
  readonly timings: readonly StageTiming[];
}

export interface ReadyResult {
  readonly schema: typeof LAUNCH_ASSISTANT_SCHEMA;
  readonly outcome: 'ready';
  readonly workClass: LaunchWorkClass;
  readonly resources: LaunchResources & {
    readonly taskId: string;
    readonly worktreeId: string;
    readonly worktreeSelector: string;
    readonly worktreePath: string;
    readonly terminal: RuntimeWorkerIdentity;
    readonly dispatchId: string;
  };
  readonly supervisedStart: SupervisedWorkerStartResult & { readonly ok: true };
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly elapsedMs: number;
  readonly timings: readonly StageTiming[];
}

export type LaunchResult = ContinueResult | ReadyResult;
export type EdgeResult<T> =
  | { readonly status: 'ok'; readonly value: T; readonly evidence?: Readonly<Record<string, unknown>> }
  | { readonly status: 'continue'; readonly cause: string; readonly actor: LaunchActor;
      readonly evidence?: Readonly<Record<string, unknown>>; readonly nextAction: NextAction };

export interface ExecutorProfile {
  readonly launchCommand: string;
  readonly modelId: string;
  readonly orcaAgent: 'cursor';
  readonly names: readonly [string, string, string];
}

export interface PreparedWorktree {
  readonly id: string;
  readonly selector: string;
  readonly path: string;
  readonly setupWitness: 'same_invocation_complete' | 'proven_reuse';
}

export interface WorktreePreparationRequest {
  readonly repository: string;
  readonly issueNumber?: number;
  readonly taskId: string;
  readonly worktreeSelector?: string;
  readonly worktreeName?: string;
  readonly baseBranch?: string;
}

export type DispatchObservation = { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly dispatchId?: string };

export interface LaunchInput {
  readonly repository: string;
  readonly workClass: LaunchWorkClass;
  readonly issueNumber?: number;
  readonly runId?: string;
  readonly taskId?: string;
  readonly managerBrief?: string;
  readonly worktreeSelector?: string;
  readonly worktreeName?: string;
  readonly baseBranch?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly cwd?: string;
}

export interface LaunchDependencies {
  readonly commandPreflight: () => Promise<EdgeResult<true>> | EdgeResult<true>;
  readonly repositoryPreflight: (repository: string) => Promise<EdgeResult<true>>;
  readonly resolveProfile: (workClass: LaunchWorkClass, env: Readonly<NodeJS.ProcessEnv>) => Promise<EdgeResult<ExecutorProfile>> | EdgeResult<ExecutorProfile>;
  readonly observeManagerRun: (runId: string) => Promise<EdgeResult<{ readonly runId: string }>>;
  readonly proveManagerTaskMembership: (runId: string, taskId: string) => Promise<EdgeResult<{ readonly taskId: string }>>;
  readonly createManagerTask: (runId: string, brief: string) => Promise<EdgeResult<{ readonly taskId: string; readonly status: string }>>;
  readonly observeDispatch: (taskId: string) => Promise<EdgeResult<DispatchObservation>>;
  readonly prepareWorktree: (input: WorktreePreparationRequest) => Promise<EdgeResult<PreparedWorktree>>;
  readonly adapter: RuntimeAdapter;
  readonly runSupervisedStart: typeof runSupervisedWorkerStart;
  readonly now: () => number;
}

const PROFILE_NAMES: Record<LaunchWorkClass, readonly [string, string, string]> = {
  manager: ['PACK_EXECUTOR_MANAGER_AGENT', 'PACK_EXECUTOR_MANAGER_MODEL', 'PACK_EXECUTOR_MANAGER_EFFORT'],
  t1: ['PACK_EXECUTOR_T1_AGENT', 'PACK_EXECUTOR_T1_MODEL', 'PACK_EXECUTOR_T1_EFFORT'],
  t2: ['PACK_EXECUTOR_T2_AGENT', 'PACK_EXECUTOR_T2_MODEL', 'PACK_EXECUTOR_T2_EFFORT'],
  t3: ['PACK_EXECUTOR_T3_AGENT', 'PACK_EXECUTOR_T3_MODEL', 'PACK_EXECUTOR_T3_EFFORT'],
};
const PROFILE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u;
const MODEL_TOKEN = '[A-Za-z0-9._:/+-]';
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const sameIdentity = (a: RuntimeWorkerIdentity, b: RuntimeWorkerIdentity): boolean =>
  a.runtime === b.runtime && a.id === b.id && a.generation === b.generation;
const regexEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function cursorModelListContains(output: string, modelId: string): boolean {
  if (!modelId || !PROFILE_VALUE.test(modelId)) return false;
  const pattern = new RegExp(`(^|[^${MODEL_TOKEN.slice(1, -1)}])${regexEscape(modelId)}(?=$|[^${MODEL_TOKEN.slice(1, -1)}])`, 'mu');
  return pattern.test(output);
}

export function resolveExecutorProfile(
  workClass: LaunchWorkClass,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): EdgeResult<ExecutorProfile> {
  const names = PROFILE_NAMES[workClass];
  const values = names.map((name) => env[name]?.trim() ?? '') as [string, string, string];
  const missing = names.filter((_name, index) => !values[index]);
  if (missing.length) return {
    status: 'continue', cause: 'executor_profile_missing', actor: 'operator', evidence: { missingVariables: missing },
    nextAction: { kind: 'repair_executor_profile', note: `export the required stable profile variables: ${missing.join(',')}` },
  };
  const malformed = names.filter((_name, index) => !PROFILE_VALUE.test(values[index]!));
  if (malformed.length) return {
    status: 'continue', cause: 'executor_profile_malformed', actor: 'operator', evidence: { malformedVariables: malformed },
    nextAction: { kind: 'repair_executor_profile', note: `repair malformed stable profile variables: ${malformed.join(',')}` },
  };
  if (values[0] !== 'cursor-agent') return {
    status: 'continue', cause: values[0] === 'cursor' ? 'executor_profile_literal_cursor_unsupported' : 'executor_profile_agent_unsupported',
    actor: 'operator', evidence: { agentVariable: names[0] },
    nextAction: { kind: 'repair_executor_profile', note: `${names[0]} must select cursor-agent for this helper` },
  };
  const modelId = `${values[1]}-${values[2]}`;
  return {
    status: 'ok',
    value: { names, modelId, launchCommand: `cursor-agent --model ${quote(modelId)}`, orcaAgent: 'cursor' },
    evidence: { profileVariables: names, executable: 'cursor-agent' },
  };
}

function initialResources(input: LaunchInput): LaunchResources {
  return {
    repository: input.repository.trim().toLowerCase(),
    ...(input.issueNumber ? { issueNumber: input.issueNumber } : {}),
    ...(input.runId ? { runId: input.runId.trim() } : {}),
    ...(input.taskId ? { taskId: input.taskId.trim() } : {}),
  };
}

function continued(
  input: LaunchInput,
  stage: LaunchStage,
  edge: { cause: string; actor: LaunchActor; evidence?: Readonly<Record<string, unknown>>; nextAction: NextAction },
  resources: LaunchResources,
  startedAtMs: number,
  timings: readonly StageTiming[],
  now: () => number,
): ContinueResult {
  const finishedAtMs = now();
  return {
    schema: LAUNCH_ASSISTANT_SCHEMA,
    outcome: 'continue',
    workClass: input.workClass,
    stage,
    observedCause: edge.cause,
    resources,
    responsibleActor: edge.actor,
    evidence: edge.evidence ?? {},
    nextAction: edge.nextAction,
    startedAtMs,
    finishedAtMs,
    elapsedMs: Math.max(0, finishedAtMs - startedAtMs),
    firstAbsentOrFailedCheckpoint: stage,
    timings,
  };
}

async function checkpoint<T>(
  stage: LaunchStage,
  timings: StageTiming[],
  now: () => number,
  edge: () => Promise<EdgeResult<T>> | EdgeResult<T>,
): Promise<EdgeResult<T>> {
  const startedAtMs = now();
  const result = await edge();
  const finishedAtMs = now();
  timings.push({
    stage,
    startedAtMs,
    finishedAtMs,
    elapsedMs: Math.max(0, finishedAtMs - startedAtMs),
    outcome: result.status === 'ok' ? 'passed' : 'continued',
  });
  return result;
}

export async function runSupervisedTaskLaunchAssistant(
  input: LaunchInput,
  deps: LaunchDependencies,
): Promise<LaunchResult> {
  const startedAtMs = deps.now();
  const timings: StageTiming[] = [];
  let resources = initialResources(input);

  const command = await checkpoint('command_preflight', timings, deps.now, deps.commandPreflight);
  if (command.status !== 'ok') return continued(input, 'command_preflight', command, resources, startedAtMs, timings, deps.now);

  const repository = await checkpoint('repository_preflight', timings, deps.now, () => deps.repositoryPreflight(resources.repository));
  if (repository.status !== 'ok') return continued(input, 'repository_preflight', repository, resources, startedAtMs, timings, deps.now);

  const profileEdge = await checkpoint('executor_profile', timings, deps.now, () => deps.resolveProfile(input.workClass, input.env ?? process.env));
  if (profileEdge.status !== 'ok') return continued(input, 'executor_profile', profileEdge, resources, startedAtMs, timings, deps.now);
  const profile = profileEdge.value;

  let taskId = input.taskId?.trim() ?? '';
  if (input.workClass === 'manager') {
    const runId = input.runId?.trim() ?? '';
    if (!runId) return continued(input, 'manager_run', {
      cause: 'manager_run_required', actor: 'manager', evidence: { requiredArgument: '--run' },
      nextAction: { kind: 'reconcile_manager_run', note: 'reinvoke with the exact currently bound --run id' },
    }, resources, startedAtMs, timings, deps.now);
    resources = { ...resources, runId };

    const runEdge = await checkpoint('manager_run', timings, deps.now, () => deps.observeManagerRun(runId));
    if (runEdge.status !== 'ok') return continued(input, 'manager_run', runEdge, resources, startedAtMs, timings, deps.now);
    if (runEdge.value.runId !== runId) return continued(input, 'manager_run', {
      cause: 'manager_run_mismatch', actor: 'manager', evidence: { observedRunId: runEdge.value.runId },
      nextAction: { kind: 'reconcile_manager_run', note: 'bind the caller to the exact requested Run' },
    }, resources, startedAtMs, timings, deps.now);

    const brief = input.managerBrief ?? '';
    if ((taskId && brief) || (!taskId && !brief)) return continued(input, 'manager_task', {
      cause: 'manager_task_input_invalid', actor: 'manager', evidence: { requiresExactlyOneOf: ['--task', '--manager-brief'] },
      nextAction: { kind: 'reconcile_manager_task', note: 'provide exactly one existing Task or caller-serialized brief' },
    }, resources, startedAtMs, timings, deps.now);

    if (taskId) {
      const member = await checkpoint('manager_task', timings, deps.now, () => deps.proveManagerTaskMembership(runId, taskId));
      if (member.status !== 'ok') return continued(input, 'manager_task', member, resources, startedAtMs, timings, deps.now);
      if (member.value.taskId !== taskId) return continued(input, 'manager_task', {
        cause: 'manager_task_membership_mismatch', actor: 'manager', evidence: {},
        nextAction: { kind: 'reconcile_manager_task', note: 'prove exact Task membership in the exact requested Run' },
      }, resources, startedAtMs, timings, deps.now);
    } else {
      const created = await checkpoint('manager_task', timings, deps.now, () => deps.createManagerTask(runId, brief));
      if (created.status !== 'ok') return continued(input, 'manager_task', created, resources, startedAtMs, timings, deps.now);
      taskId = created.value.taskId.trim();
      if (!taskId || !created.value.status.trim()) return continued(input, 'manager_task', {
        cause: 'manager_task_create_receipt_invalid', actor: 'provider', evidence: {},
        nextAction: { kind: 'reconcile_manager_task', note: 'reconcile this task-create mutation; do not create a second brief Task' },
      }, resources, startedAtMs, timings, deps.now);
      resources = { ...resources, taskId };
    }
  } else if (!taskId) {
    return continued(input, 'manager_task', {
      cause: 'worker_task_required', actor: 'orchestrator', evidence: { requiredArgument: '--task' },
      nextAction: { kind: 'reconcile_manager_task', note: 'reinvoke with the exact existing Orca Task id' },
    }, resources, startedAtMs, timings, deps.now);
  }
  resources = { ...resources, taskId };

  const early = await checkpoint('dispatch_admission_early', timings, deps.now, () => deps.observeDispatch(taskId));
  if (early.status !== 'ok') return continued(input, 'dispatch_admission_early', early, resources, startedAtMs, timings, deps.now);
  if (early.value.kind !== 'absent') return continued(input, 'dispatch_admission_early', {
    cause: 'fresh_dispatch_not_absent', actor: 'orchestrator', evidence: { dispatchState: 'present' },
    nextAction: { kind: 'reconcile_dispatch', note: 'reconcile the existing Dispatch; create no new worktree terminal/start' },
  }, { ...resources, ...(early.value.dispatchId ? { dispatchId: early.value.dispatchId } : {}) }, startedAtMs, timings, deps.now);

  const prepared = await checkpoint('worktree_prepare', timings, deps.now, () => deps.prepareWorktree({
    repository: resources.repository,
    ...(input.issueNumber ? { issueNumber: input.issueNumber } : {}),
    taskId,
    ...(input.worktreeSelector ? { worktreeSelector: input.worktreeSelector } : {}),
    ...(input.worktreeName ? { worktreeName: input.worktreeName } : {}),
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
  }));
  if (prepared.status !== 'ok') return continued(input, 'worktree_prepare', prepared, resources, startedAtMs, timings, deps.now);
  resources = {
    ...resources,
    worktreeId: prepared.value.id,
    worktreeSelector: prepared.value.selector,
    worktreePath: prepared.value.path,
  };

  const terminalStartedAt = deps.now();
  const spawn = deps.adapter.spawnWorker({
    title: `opk-${input.workClass}-${taskId}`,
    command: profile.launchCommand,
    workspace: prepared.value.path,
  });
  let terminalCause = '';
  let liveness: ReturnType<RuntimeAdapter['liveness']> | null = null;
  if (spawn.status !== 'ok') terminalCause = `terminal_spawn_${spawn.status}`;
  else if (!text(spawn.value.identity.runtime) || !text(spawn.value.identity.id) || !text(spawn.value.identity.generation)) terminalCause = 'terminal_identity_invalid';
  else if (spawn.value.provenance !== 'internal') terminalCause = 'terminal_provenance_external';
  else if (spawn.value.workspacePath !== prepared.value.path) terminalCause = 'terminal_workspace_mismatch';
  else if (spawn.value.identity.runtime !== deps.adapter.id) terminalCause = 'terminal_runtime_mismatch';
  else {
    liveness = deps.adapter.liveness({ worker: spawn.value.identity, observationWindowMs: 1_000 });
    if (!sameIdentity(liveness.worker, spawn.value.identity)) terminalCause = 'terminal_generation_mismatch';
    else if (liveness.status !== 'idle') terminalCause = `terminal_liveness_${liveness.status}`;
  }
  const terminalFinishedAt = deps.now();
  timings.push({
    stage: 'terminal_prepare',
    startedAtMs: terminalStartedAt,
    finishedAtMs: terminalFinishedAt,
    elapsedMs: Math.max(0, terminalFinishedAt - terminalStartedAt),
    outcome: terminalCause ? 'continued' : 'passed',
  });
  if (terminalCause || spawn.status !== 'ok') return continued(input, 'terminal_prepare', {
    cause: terminalCause, actor: 'orchestrator', evidence: { liveness: liveness?.status ?? 'not_observed' },
    nextAction: { kind: 'remediate_terminal', note: 'remediate the owned fresh terminal; never reuse a foreign/pre-existing or non-idle target' },
  }, resources, startedAtMs, timings, deps.now);
  const terminal = spawn.value;
  resources = { ...resources, terminal: terminal.identity };

  const final = await checkpoint('dispatch_admission_final', timings, deps.now, () => deps.observeDispatch(taskId));
  if (final.status !== 'ok') return continued(input, 'dispatch_admission_final', final, resources, startedAtMs, timings, deps.now);
  if (final.value.kind !== 'absent') return continued(input, 'dispatch_admission_final', {
    cause: 'fresh_dispatch_not_absent', actor: 'orchestrator', evidence: { dispatchState: 'present' },
    nextAction: { kind: 'reconcile_dispatch', note: 'reconcile the competing Dispatch; do not call worker-start on this terminal' },
  }, { ...resources, ...(final.value.dispatchId ? { dispatchId: final.value.dispatchId } : {}) }, startedAtMs, timings, deps.now);

  const startAt = deps.now();
  const supervised = await deps.runSupervisedStart({
    repository: resources.repository,
    ...(input.issueNumber ? { issueNumber: input.issueNumber } : {}),
    ...(input.env ? { env: { ...input.env } } : {}),
    cwd: input.cwd,
    adapter: deps.adapter,
    orcaArgs: ['--task', taskId, '--terminal', terminal.identity.id, '--worktree', prepared.value.selector],
  });
  const startDone = deps.now();
  timings.push({
    stage: 'supervised_start',
    startedAtMs: startAt,
    finishedAtMs: startDone,
    elapsedMs: Math.max(0, startDone - startAt),
    outcome: supervised.ok ? 'passed' : 'continued',
  });

  if (!supervised.ok || supervised.reason !== 'ready_and_assignment_bound' || !supervised.assignment) {
    const requestId = supervised.recovery?.requestId;
    const retry = requestId ? [
      'node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts --script scripts/pr2-foundation/supervised-worker-start.ts --',
      ...(input.issueNumber ? ['--issue-number', String(input.issueNumber)] : []),
      '--repository', quote(resources.repository), '--', '--task', quote(taskId),
      '--terminal', quote(terminal.identity.id), '--worktree', quote(prepared.value.selector),
      '--retry-request', quote(requestId),
    ].join(' ') : undefined;
    return continued(input, 'supervised_start', {
      cause: supervised.reason,
      actor: 'provider',
      evidence: {
        ...(supervised.errorCode ? { errorCode: supervised.errorCode } : {}),
        ...(requestId ? { requestId } : {}),
        ...(supervised.recovery?.dispatchId ? { dispatchId: supervised.recovery.dispatchId } : {}),
      },
      nextAction: requestId ? {
        kind: 'retry_supervised_start', requestId, command: retry,
        ...(supervised.recovery?.recoveryCommand ? { note: `provider reconciliation command: ${supervised.recovery.recoveryCommand}` } : {}),
      } : {
        kind: 'reconcile_supervised_start',
        ...(supervised.recovery?.recoveryCommand ? { command: supervised.recovery.recoveryCommand } : {}),
        note: 'reconcile the non-ready start; never fall through to a fresh mutation',
      },
    }, { ...resources, ...(supervised.recovery?.dispatchId ? { dispatchId: supervised.recovery.dispatchId } : {}) }, startedAtMs, timings, deps.now);
  }

  const dispatchId = text(supervised.receipt?.dispatchId);
  if (!dispatchId) return continued(input, 'supervised_start', {
    cause: 'supervised_start_dispatch_identity_missing', actor: 'provider', evidence: {},
    nextAction: { kind: 'reconcile_supervised_start', note: 'reconcile the provider receipt; setup/terminal liveness alone is never ready' },
  }, resources, startedAtMs, timings, deps.now);

  resources = { ...resources, dispatchId };
  const finishedAtMs = deps.now();
  return {
    schema: LAUNCH_ASSISTANT_SCHEMA,
    outcome: 'ready',
    workClass: input.workClass,
    resources: resources as ReadyResult['resources'],
    supervisedStart: supervised as ReadyResult['supervisedStart'],
    startedAtMs,
    finishedAtMs,
    elapsedMs: Math.max(0, finishedAtMs - startedAtMs),
    timings,
  };
}

interface ChildResult { readonly ok: boolean; readonly stdout: string; readonly stderr?: string }
type ChildExecutor = (args: readonly string[], timeoutMs?: number) => Promise<ChildResult>;

async function child(
  args: readonly string[],
  cwd: string,
  env: Readonly<NodeJS.ProcessEnv>,
  timeoutMs = 15_000,
): Promise<ChildResult> {
  const result = await runProcess({
    command: args[0]!, args: args.slice(1), cwd, env, inheritParentEnv: true,
    allowEmptyStdout: true, timeoutMs,
  });
  return { ok: result.ok, stdout: result.stdout, stderr: result.stderr || result.error };
}

function envelope(execution: ChildResult): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(execution.stdout);
    return record(value) ? value : null;
  } catch {
    return null;
  }
}

function errorData(value: Record<string, unknown> | null): Record<string, unknown> | null {
  const error = value && record(value.error) ? value.error : null;
  return error && record(error.data) ? error.data : null;
}

function mutationRequestId(value: Record<string, unknown> | null): string {
  const data = errorData(value);
  const orchestrationRequestId = text(data?.orchestrationRequestId);
  const requestId = text(data?.requestId);
  if (orchestrationRequestId && requestId && orchestrationRequestId !== requestId) return '';
  return orchestrationRequestId || requestId;
}

function repoSlug(remote: string): string {
  const raw = remote.trim().replace(/\.git$/u, '');
  const ssh = raw.match(/^[^@]+@[^:]+:(.+)$/u)?.[1];
  const path = ssh ?? raw.match(/^https?:\/\/[^/]+\/(.+)$/u)?.[1] ?? '';
  const parts = path.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}`.toLowerCase() : '';
}

function resultRecord(value: Record<string, unknown> | null): Record<string, unknown> | null {
  return value?.ok === true && record(value.result) ? value.result : null;
}

function worktreeContinue(
  cause: string,
  evidence: Readonly<Record<string, unknown>> = {},
): EdgeResult<PreparedWorktree> {
  return {
    status: 'continue', cause, actor: 'provider', evidence,
    nextAction: {
      kind: 'reconcile_worktree_setup',
      note: 'obtain a supported setup-complete/proven-reuse witness; never infer readiness from path/head',
    },
  };
}

export async function prepareWorktreeWithOrca(
  request: WorktreePreparationRequest,
  execute: ChildExecutor,
): Promise<EdgeResult<PreparedWorktree>> {
  if (Boolean(request.worktreeSelector) === Boolean(request.worktreeName)) return {
    status: 'continue', cause: 'worktree_input_invalid', actor: 'orchestrator', evidence: {},
    nextAction: { kind: 'reconcile_worktree_setup', note: 'provide exactly one --worktree or --worktree-name' },
  };

  if (request.worktreeSelector) {
    const shown = resultRecord(envelope(await execute([
      'orca', 'worktree', 'show', '--worktree', request.worktreeSelector, '--json',
    ])));
    const worktree = shown && record(shown.worktree) ? shown.worktree : null;
    const id = text(worktree?.id);
    const path = text(worktree?.path);
    if (!id || !path) return worktreeContinue('worktree_prepare_failed_or_unknown');
    return worktreeContinue('worktree_reuse_readiness_unproven', { worktreeId: id, worktreePath: path });
  }

  const created = resultRecord(envelope(await execute([
    'orca', 'worktree', 'create', '--repo', request.repository, '--name', request.worktreeName!,
    ...(request.baseBranch ? ['--base-branch', request.baseBranch] : []),
    ...(request.issueNumber ? ['--issue', String(request.issueNumber)] : ['--no-parent']),
    '--setup', 'run', '--json',
  ], 120_000)));
  const worktree = created && record(created.worktree) ? created.worktree : null;
  const id = text(worktree?.id);
  const path = text(worktree?.path);
  if (!id || !path) return worktreeContinue('worktree_prepare_failed_or_unknown');

  const baseEvidence = { worktreeId: id, worktreePath: path };
  const setup = created && record(created.setupReceipt) ? created.setupReceipt : null;
  if (!setup || text(setup.requested) !== 'run') return worktreeContinue('worktree_setup_receipt_unavailable', baseEvidence);

  const state = text(setup.state);
  if (state === 'not_configured' && setup.hookFound === false) return {
    status: 'ok',
    value: { id, selector: `id:${id}`, path, setupWitness: 'same_invocation_complete' },
    evidence: { ...baseEvidence, setupState: state },
  };
  if (state !== 'running' || setup.hookFound !== true) {
    return worktreeContinue(`worktree_setup_${state || 'unknown'}`, { ...baseEvidence, setupState: state || 'unknown' });
  }

  const terminalHandle = text(setup.terminalHandle);
  if (!terminalHandle) return worktreeContinue('worktree_setup_terminal_missing', { ...baseEvidence, setupState: state });
  const waited = resultRecord(envelope(await execute([
    'orca', 'terminal', 'wait', '--terminal', terminalHandle, '--for', 'exit', '--timeout-ms', '120000', '--json',
  ], 130_000)));
  const wait = waited && record(waited.wait) ? waited.wait : null;
  const exitCode = typeof wait?.exitCode === 'number' && Number.isFinite(wait.exitCode) ? wait.exitCode : null;
  if (!wait || text(wait.handle) !== terminalHandle || wait.satisfied !== true || text(wait.status) !== 'exited' || exitCode !== 0) {
    return worktreeContinue('worktree_setup_wait_not_successful', {
      ...baseEvidence,
      setupState: state,
      setupTerminalHandle: terminalHandle,
      waitStatus: text(wait?.status) || 'unknown',
      exitCode,
    });
  }
  return {
    status: 'ok',
    value: { id, selector: `id:${id}`, path, setupWitness: 'same_invocation_complete' },
    evidence: { ...baseEvidence, setupState: 'completed', setupTerminalHandle: terminalHandle },
  };
}

function dispatchEdge(value: Record<string, unknown> | null): EdgeResult<DispatchObservation> {
  const result = resultRecord(value);
  if (!result || !Object.hasOwn(result, 'dispatch')) return {
    status: 'continue', cause: 'dispatch_observation_malformed', actor: 'provider', evidence: {},
    nextAction: { kind: 'reconcile_dispatch', note: 'reconcile the exact Task Dispatch through installed Orca authority' },
  };
  if (result.dispatch === null) return { status: 'ok', value: { kind: 'absent' } };
  if (!record(result.dispatch)) return {
    status: 'continue', cause: 'dispatch_observation_malformed', actor: 'provider', evidence: {},
    nextAction: { kind: 'reconcile_dispatch', note: 'reconcile the exact Task Dispatch through installed Orca authority' },
  };
  const id = text(result.dispatch.id);
  return { status: 'ok', value: { kind: 'present', ...(id ? { dispatchId: id } : {}) } };
}

export async function createProductionLaunchDependencies(input: LaunchInput): Promise<LaunchDependencies> {
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? process.env;
  const adapter = await selectRuntimeAdapter({ env: { ...env } }, { cwd, transport: { env: { ...env } } });
  return {
    now: Date.now,
    adapter,
    runSupervisedStart: runSupervisedWorkerStart,
    commandPreflight: () => {
      if (process.versions.node.split('.')[0] !== '22') return {
        status: 'continue', cause: 'node_22_required', actor: 'operator', evidence: { requiredMajor: 22 },
        nextAction: { kind: 'repair_preflight', note: 'run the canonical helper under Node.js 22' },
      };
      const preflight = evaluateCommandRuntimePreflight({ inheritedPath: env.PATH ?? '' });
      return preflight.ok ? { status: 'ok', value: true } : {
        status: 'continue', cause: preflight.reason, actor: 'operator', evidence: { missingTool: preflight.missingTool ?? 'unknown' },
        nextAction: { kind: 'repair_preflight', note: preflight.diagnostic ?? 'repair command-runtime preflight' },
      };
    },
    repositoryPreflight: async (repository) => {
      const remote = await child(['git', 'remote', 'get-url', 'origin'], cwd, env);
      if (!remote.ok || repoSlug(remote.stdout) !== repository) return {
        status: 'continue', cause: 'repository_preflight_mismatch', actor: 'operator', evidence: { repository },
        nextAction: { kind: 'repair_preflight', note: 'run from the checkout whose origin exactly matches --repository' },
      };
      return { status: 'ok', value: true };
    },
    resolveProfile: async (workClass, inheritedEnv) => {
      const resolved = resolveExecutorProfile(workClass, inheritedEnv);
      if (resolved.status !== 'ok') return resolved;
      const listed = await child(['cursor-agent', '--list-models'], cwd, inheritedEnv);
      if (!listed.ok || !cursorModelListContains(listed.stdout, resolved.value.modelId)) return {
        status: 'continue',
        cause: listed.ok ? 'executor_profile_model_unavailable' : 'executor_profile_applicability_unproven',
        actor: 'operator',
        evidence: { profileVariables: resolved.value.names },
        nextAction: { kind: 'repair_executor_profile', note: 'select a model/effort combination present in cursor-agent --list-models' },
      };
      const inherited = await child([
        process.execPath,
        '--input-type=module',
        '-e',
        'const n=process.argv.slice(1);process.exit(n.every((k)=>typeof process.env[k]==="string"&&process.env[k].trim())?0:1)',
        ...resolved.value.names,
      ], cwd, inheritedEnv);
      return inherited.ok ? resolved : {
        status: 'continue', cause: 'executor_profile_child_inheritance_unproven', actor: 'operator',
        evidence: { profileVariables: resolved.value.names },
        nextAction: { kind: 'repair_executor_profile', note: 'export the selected stable profile variables into the launching process' },
      };
    },
    observeManagerRun: async (runId) => {
      const result = resultRecord(envelope(await child(['orca', 'orchestration', 'run-current', '--json'], cwd, env)));
      const observed = result && record(result.run) ? text(result.run.id) : '';
      return observed ? { status: 'ok', value: { runId: observed } } : {
        status: 'continue', cause: 'manager_run_observation_unavailable', actor: 'provider', evidence: {},
        nextAction: { kind: 'reconcile_manager_run', note: `reconcile the current Run before using ${runId}` },
      };
    },
    proveManagerTaskMembership: async (runId, taskId) => {
      const result = resultRecord(envelope(await child([
        'orca', 'orchestration', 'task-list', '--run', runId, '--json',
      ], cwd, env)));
      if (!result) return {
        status: 'continue', cause: 'manager_task_membership_unavailable', actor: 'provider', evidence: {},
        nextAction: { kind: 'reconcile_manager_task', note: 'reconcile exact Task-to-Run membership through installed Orca authority' },
      };
      const exposedRun = record(result.run) ? text(result.run.id) : text(result.runId);
      if (exposedRun && exposedRun !== runId) return {
        status: 'continue', cause: 'manager_task_membership_wrong_run', actor: 'provider', evidence: {},
        nextAction: { kind: 'reconcile_manager_task', note: 'do not use a Task list scoped to another Run' },
      };
      const matches = (Array.isArray(result.tasks) ? result.tasks : []).filter((item) => record(item) && text(item.id) === taskId);
      return matches.length === 1 ? { status: 'ok', value: { taskId } } : {
        status: 'continue', cause: matches.length ? 'manager_task_membership_ambiguous' : 'manager_task_membership_absent',
        actor: 'manager', evidence: { matchCount: matches.length },
        nextAction: { kind: 'reconcile_manager_task', note: 'prove exactly one requested Task in the exact Run' },
      };
    },
    createManagerTask: async (runId, brief) => {
      const value = envelope(await child([
        'orca', 'orchestration', 'task-create', '--spec', brief, '--run', runId, '--json',
      ], cwd, env));
      const result = resultRecord(value);
      const task = result && record(result.task) ? result.task : null;
      const taskId = text(task?.id);
      const status = text(task?.status);
      if (taskId && status) return { status: 'ok', value: { taskId, status } };
      const requestId = mutationRequestId(value);
      return requestId ? {
        status: 'continue', cause: 'manager_task_create_outcome_unknown', actor: 'provider', evidence: { requestId },
        nextAction: {
          kind: 'retry_manager_task_create', requestId,
          command: `orca orchestration task-create --spec <same-manager-brief> --run ${quote(runId)} --retry-request ${quote(requestId)} --json`,
          note: 'reuse the exact caller-held original brief; its payload is intentionally not echoed',
        },
      } : {
        status: 'continue', cause: 'manager_task_create_failed_or_unknown', actor: 'provider', evidence: {},
        nextAction: { kind: 'reconcile_manager_task', note: 'reconcile current Orca Task authority; no new brief mutation is authorized' },
      };
    },
    observeDispatch: async (taskId) => dispatchEdge(envelope(await child([
      'orca', 'orchestration', 'dispatch-show', '--task', taskId, '--json',
    ], cwd, env))),
    prepareWorktree: async (request) => prepareWorktreeWithOrca(
      request,
      (args, timeoutMs) => child(args, cwd, env, timeoutMs),
    ),
  };
}

function option(argv: readonly string[], name: string): string {
  const indexes = argv.map((value, index) => value === name ? index : -1).filter((index) => index >= 0);
  if (indexes.length !== 1) return '';
  const value = argv[indexes[0]! + 1] ?? '';
  return value.startsWith('--') ? '' : value;
}

export function parseLaunchAssistantCli(argv: readonly string[]): LaunchInput {
  const workClass = option(argv, '--work-class');
  if (!LAUNCH_WORK_CLASSES.includes(workClass as LaunchWorkClass)) throw new Error('--work-class must be exactly manager|t1|t2|t3');
  const repository = option(argv, '--repository').trim().toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new Error('--repository owner/repo is required');
  const issueText = option(argv, '--issue-number');
  const issueNumber = issueText ? Number.parseInt(issueText, 10) : undefined;
  if (issueNumber !== undefined && (!Number.isInteger(issueNumber) || issueNumber <= 0)) throw new Error('--issue-number must be a positive integer');
  return {
    repository,
    workClass: workClass as LaunchWorkClass,
    ...(issueNumber ? { issueNumber } : {}),
    ...(option(argv, '--run') ? { runId: option(argv, '--run') } : {}),
    ...(option(argv, '--task') ? { taskId: option(argv, '--task') } : {}),
    ...(option(argv, '--manager-brief') ? { managerBrief: option(argv, '--manager-brief') } : {}),
    ...(option(argv, '--worktree') ? { worktreeSelector: option(argv, '--worktree') } : {}),
    ...(option(argv, '--worktree-name') ? { worktreeName: option(argv, '--worktree-name') } : {}),
    ...(option(argv, '--base-branch') ? { baseBranch: option(argv, '--base-branch') } : {}),
  };
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const input = parseLaunchAssistantCli(argv);
  const result = await runSupervisedTaskLaunchAssistant(input, await createProductionLaunchDependencies(input));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1]?.endsWith('supervised-task-launch-assistant.ts')) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
