#!/usr/bin/env -S node --experimental-strip-types

import '../toolchain/native-entrypoint-preflight.ts';
import { runProcess } from '../kernel/subprocess.ts';
import { evaluateCommandRuntimePreflight } from '../lib/command-runtime-bootstrap.mjs';
import { selectRuntimeAdapter } from '../runtime/registry.ts';
import type { RuntimeAdapter, RuntimeWorker, RuntimeWorkerIdentity } from '../runtime/contracts.ts';
import {
  buildExecutorCommand,
  buildProviderInvocation,
  CURSOR_TASK_ROUTE_CAPABILITIES,
  evaluateExecutorRouteAdmission,
  EXECUTOR_FAMILY_DESCRIPTORS,
  executorCatalogContains,
  openCodeEdgeCapabilities,
  profileNamesForTask,
  resolveSemanticExecutorProfile,
  type ExecutorFamily,
  type ExecutorRoute,
  type SemanticExecutorProfile,
} from '../executor-profile-policy.ts';
import { runSupervisedWorkerStart, type SupervisedWorkerStartResult, type WorkerStartMode } from './supervised-worker-start.ts';

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
  readonly providerAgentTerminalId?: string;
  readonly dispatchId?: string;
}

export interface NextAction {
  readonly kind: 'repair_preflight' | 'repair_executor_profile' | 'reconcile_manager_run'
    | 'reconcile_manager_task' | 'retry_manager_task_create' | 'reconcile_dispatch'
    | 'reconcile_worktree_setup' | 'remediate_terminal' | 'retry_supervised_start'
    | 'reconcile_supervised_start';
  readonly requestId?: string;
  readonly command?: string;
  readonly replay?: {
    readonly operation: 'orca_orchestration_task_create';
    readonly runId: string;
    readonly requestId: string;
    readonly inputSource: 'caller_held_manager_brief';
  };
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
    readonly terminal?: RuntimeWorkerIdentity;
    readonly providerAgentTerminalId?: string;
    readonly dispatchId: string;
  };
  readonly supervisedStart: {
    readonly ok: true;
    readonly reason: 'ready_and_assignment_bound';
    readonly assignmentBound: true;
  };
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
  readonly family: ExecutorFamily;
  readonly route: ExecutorRoute;
  readonly launchCommand: string;
  readonly providerArgs?: readonly string[];
  readonly names: readonly [string, string, string];
}

export interface PreparedWorktree {
  readonly id?: string;
  readonly selector: string;
  readonly path?: string;
  readonly repositorySelector?: string;
  readonly setupWitness: 'same_invocation_complete' | 'proven_reuse' | 'provider_top_level';
}

export interface WorktreePreparationRequest {
  readonly repository: string;
  readonly issueNumber?: number;
  readonly taskId: string;
  readonly worktreeSelector?: string;
  readonly worktreeName?: string;
  readonly baseBranch?: string;
  readonly providerTopLevel?: boolean;
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
  readonly startMode?: WorkerStartMode;
}

export interface LaunchDependencies {
  readonly commandPreflight: () => Promise<EdgeResult<true>> | EdgeResult<true>;
  readonly repositoryPreflight: (repository: string) => Promise<EdgeResult<true>>;
  readonly resolveProfile: (
    workClass: LaunchWorkClass,
    env: Readonly<NodeJS.ProcessEnv>,
    startMode?: WorkerStartMode,
  ) => Promise<EdgeResult<ExecutorProfile>> | EdgeResult<ExecutorProfile>;
  readonly observeManagerRun: (runId: string) => Promise<EdgeResult<{ readonly runId: string }>>;
  readonly proveManagerTaskMembership: (runId: string, taskId: string) => Promise<EdgeResult<{ readonly taskId: string }>>;
  readonly createManagerTask: (runId: string, brief: string) => Promise<EdgeResult<{ readonly taskId: string; readonly status: string }>>;
  readonly observeDispatch: (taskId: string) => Promise<EdgeResult<DispatchObservation>>;
  readonly prepareWorktree: (input: WorktreePreparationRequest) => Promise<EdgeResult<PreparedWorktree>>;
  readonly adapter: RuntimeAdapter;
  readonly runSupervisedStart: typeof runSupervisedWorkerStart;
  readonly now: () => number;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const sameIdentity = (a: RuntimeWorkerIdentity, b: RuntimeWorkerIdentity): boolean =>
  a.runtime === b.runtime && a.id === b.id && a.generation === b.generation;

function supportedStartMode(value: WorkerStartMode | undefined): value is ExecutorRoute | undefined {
  return value === undefined || value === 'provider_new_top_level' || value === 'exact_terminal_worktree';
}

function profileResolutionEdge(
  workClass: LaunchWorkClass,
  env: Readonly<NodeJS.ProcessEnv>,
): EdgeResult<SemanticExecutorProfile> {
  const names = profileNamesForTask(workClass);
  const resolved = resolveSemanticExecutorProfile({ surface: 'task', names, env });
  if (resolved.ok) return { status: 'ok', value: resolved.profile };
  const variableKey = resolved.code === 'executor_profile_missing' ? 'missingVariables'
    : resolved.code === 'executor_profile_malformed' ? 'malformedVariables' : 'agentVariable';
  const evidence = resolved.code === 'executor_profile_agent_unsupported'
    ? { [variableKey]: resolved.variables[0] }
    : { [variableKey]: resolved.variables };
  const note = resolved.code === 'executor_profile_missing'
    ? `export the required stable profile variables: ${resolved.variables.join(',')}`
    : resolved.code === 'executor_profile_malformed'
      ? `repair malformed stable profile variables: ${resolved.variables.join(',')}`
      : `select a supported executor family through ${resolved.variables[0]}`;
  return {
    status: 'continue', cause: resolved.code, actor: 'operator', evidence,
    nextAction: { kind: 'repair_executor_profile', note },
  };
}

function admittedProfile(
  semantic: SemanticExecutorProfile,
  route: ExecutorRoute,
): EdgeResult<ExecutorProfile> {
  const invocation = buildExecutorCommand(semantic);
  const provider = buildProviderInvocation(semantic);
  if (route === 'provider_new_top_level' && !provider) return {
    status: 'continue', cause: 'executor_route_unavailable', actor: 'operator',
    evidence: { executorFamily: semantic.family, route },
    nextAction: { kind: 'repair_executor_profile', note: 'select an executor route whose model and effort channels are proven' },
  };
  return {
    status: 'ok',
    value: {
      family: semantic.family,
      route,
      launchCommand: invocation.command,
      ...(provider ? { providerArgs: provider.argv } : {}),
      names: semantic.names,
    },
    evidence: { executorFamily: semantic.family, route, profileVariables: semantic.names },
  };
}

export function resolveExecutorProfile(
  workClass: LaunchWorkClass,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  startMode?: WorkerStartMode,
): EdgeResult<ExecutorProfile> {
  const semanticEdge = profileResolutionEdge(workClass, env);
  if (semanticEdge.status !== 'ok') return semanticEdge;
  if (!supportedStartMode(startMode)) return {
    status: 'continue', cause: 'executor_route_mismatch', actor: 'orchestrator', evidence: { executorFamily: semanticEdge.value.family },
    nextAction: { kind: 'repair_executor_profile', note: 'select a supported worker-start composition route' },
  };
  const capabilities = semanticEdge.value.family === 'cursor'
    ? CURSOR_TASK_ROUTE_CAPABILITIES
    : openCodeEdgeCapabilities([]);
  const verdict = evaluateExecutorRouteAdmission({
    profile: semanticEdge.value,
    ...(startMode ? { startMode } : {}),
    edgeCapabilities: capabilities,
  });
  if (!verdict.ok) return {
    status: 'continue', cause: verdict.refusal, actor: 'operator',
    evidence: { executorFamily: semanticEdge.value.family, profileVariables: semanticEdge.value.names },
    nextAction: { kind: 'repair_executor_profile', note: 'select an executor route whose model and effort channels are proven' },
  };
  return admittedProfile(semanticEdge.value, verdict.route);
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
  timings: StageTiming[],
  now: () => number,
): ContinueResult {
  const lastTiming = timings.at(-1);
  if (lastTiming?.stage === stage) {
    if (lastTiming.outcome !== 'continued') {
      timings[timings.length - 1] = { ...lastTiming, outcome: 'continued' };
    }
  } else {
    const failedAtMs = now();
    timings.push({
      stage,
      startedAtMs: failedAtMs,
      finishedAtMs: failedAtMs,
      elapsedMs: 0,
      outcome: 'continued',
    });
  }
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

function retryProviderArgs(profile: ExecutorProfile): string[] {
  return (profile.providerArgs ?? []).map((arg) => arg.startsWith('--') ? arg : quote(arg));
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

  const profileEdge = await checkpoint('executor_profile', timings, deps.now, () =>
    deps.resolveProfile(input.workClass, input.env ?? process.env, input.startMode));
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

  const providerMode = profile.route === 'provider_new_top_level';
  const prepared = await checkpoint('worktree_prepare', timings, deps.now, () => deps.prepareWorktree({
    repository: resources.repository,
    ...(input.issueNumber ? { issueNumber: input.issueNumber } : {}),
    taskId,
    ...(input.worktreeSelector ? { worktreeSelector: input.worktreeSelector } : {}),
    ...(input.worktreeName ? { worktreeName: input.worktreeName } : {}),
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    ...(providerMode ? { providerTopLevel: true } : {}),
  }));
  if (prepared.status !== 'ok') return continued(input, 'worktree_prepare', prepared, resources, startedAtMs, timings, deps.now);
  resources = {
    ...resources,
    ...(prepared.value.id ? { worktreeId: prepared.value.id } : {}),
    worktreeSelector: prepared.value.selector,
    ...(prepared.value.path ? { worktreePath: prepared.value.path } : {}),
  };

  let terminal: RuntimeWorker | undefined;
  if (providerMode) {
    const terminalStartedAt = deps.now();
    const terminalFinishedAt = deps.now();
    timings.push({ stage: 'terminal_prepare', startedAtMs: terminalStartedAt, finishedAtMs: terminalFinishedAt,
      elapsedMs: Math.max(0, terminalFinishedAt - terminalStartedAt), outcome: 'passed' });
  } else {
    if (!prepared.value.path) return continued(input, 'terminal_prepare', {
      cause: 'terminal_workspace_missing', actor: 'orchestrator', evidence: {},
      nextAction: { kind: 'remediate_terminal', note: 'reconcile the exact prepared worktree path before creating a terminal' },
    }, resources, startedAtMs, timings, deps.now);
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
    else {
      resources = { ...resources, terminal: spawn.value.identity };
      if (spawn.value.provenance !== 'internal') terminalCause = 'terminal_provenance_external';
      else if (spawn.value.workspacePath !== prepared.value.path) terminalCause = 'terminal_workspace_mismatch';
      else if (spawn.value.identity.runtime !== deps.adapter.id) terminalCause = 'terminal_runtime_mismatch';
      else {
        liveness = deps.adapter.liveness({ worker: spawn.value.identity, observationWindowMs: 1_000 });
        if (!sameIdentity(liveness.worker, spawn.value.identity)) terminalCause = 'terminal_generation_mismatch';
        else if (liveness.status !== 'idle') terminalCause = `terminal_liveness_${liveness.status}`;
      }
    }
    const terminalFinishedAt = deps.now();
    timings.push({ stage: 'terminal_prepare', startedAtMs: terminalStartedAt, finishedAtMs: terminalFinishedAt,
      elapsedMs: Math.max(0, terminalFinishedAt - terminalStartedAt), outcome: terminalCause ? 'continued' : 'passed' });
    if (terminalCause || spawn.status !== 'ok') return continued(input, 'terminal_prepare', {
      cause: terminalCause, actor: 'orchestrator', evidence: { liveness: liveness?.status ?? 'not_observed' },
      nextAction: { kind: 'remediate_terminal', note: 'remediate the owned fresh terminal; never reuse a foreign/pre-existing or non-idle target' },
    }, resources, startedAtMs, timings, deps.now);
    terminal = spawn.value;
  }

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
    ...(providerMode ? {} : { adapter: deps.adapter }),
    mode: profile.route,
    role: input.workClass === 'manager' ? 'orchestrator' : 'worker',
    orcaArgs: providerMode
      ? ['--task', taskId, '--worktree', 'new-top-level', '--repo', prepared.value.repositorySelector ?? '',
        '--name', input.worktreeName ?? '', ...(input.baseBranch ? ['--base-branch', input.baseBranch] : []),
        ...(profile.providerArgs ?? []), '--setup', 'run', '--json']
      : ['--task', taskId, '--terminal', terminal!.identity.id, '--worktree', prepared.value.selector],
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
    const receiptDispatchId = text(supervised.receipt?.dispatchId);
    const safeDispatchId = receiptDispatchId || supervised.recovery?.dispatchId;
    const retry = requestId ? [
      'node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts --script scripts/pr2-foundation/supervised-worker-start.ts --',
      ...(input.issueNumber ? ['--issue-number', String(input.issueNumber)] : []),
      '--repository', quote(resources.repository), '--role', input.workClass === 'manager' ? 'orchestrator' : 'worker',
      ...(providerMode ? ['--mode', 'provider_new_top_level'] : []), '--', '--task', quote(taskId),
      ...(providerMode
        ? ['--worktree', 'new-top-level', '--repo', quote(prepared.value.repositorySelector ?? ''), '--name', quote(input.worktreeName ?? ''),
          ...(input.baseBranch ? ['--base-branch', quote(input.baseBranch)] : []),
          ...retryProviderArgs(profile), '--setup', 'run']
        : ['--terminal', quote(terminal!.identity.id), '--worktree', quote(prepared.value.selector)]),
      '--retry-request', quote(requestId),
    ].join(' ') : undefined;
    return continued(input, 'supervised_start', {
      cause: supervised.reason,
      actor: 'provider',
      evidence: {
        ...(supervised.errorCode ? { errorCode: supervised.errorCode } : {}),
        ...(requestId ? { requestId } : {}),
        ...(safeDispatchId ? { dispatchId: safeDispatchId } : {}),
      },
      nextAction: requestId ? {
        kind: 'retry_supervised_start', requestId, command: retry,
      } : {
        kind: 'reconcile_supervised_start',
        note: 'reconcile the non-ready start; never fall through to a fresh mutation',
      },
    }, {
      ...resources,
      ...(safeDispatchId ? { dispatchId: safeDispatchId } : {}),
    }, startedAtMs, timings, deps.now);
  }

  const dispatchId = text(supervised.receipt?.dispatchId);
  if (!dispatchId) return continued(input, 'supervised_start', {
    cause: 'supervised_start_dispatch_identity_missing', actor: 'provider', evidence: {},
    nextAction: { kind: 'reconcile_supervised_start', note: 'reconcile the provider receipt; setup/terminal liveness alone is never ready' },
  }, resources, startedAtMs, timings, deps.now);

  if (providerMode) {
    const receipt = supervised.receipt;
    const worktree = receipt && record(receipt.worktree) ? receipt.worktree : null;
    const providerTerminal = receipt && record(receipt.terminal) ? receipt.terminal
      : receipt && record((receipt as Record<string, unknown>).agentTerminal) ? (receipt as Record<string, unknown>).agentTerminal as Record<string, unknown> : null;
    const effects = receipt && Array.isArray(receipt.effects) ? receipt.effects : [];
    const worktreeEffect = effects.find((effect) => record(effect) && text(effect.kind) === 'worktree'
      && (text(effect.action) === 'created' || text(effect.action) === 'created_top_level'));
    const terminalEffect = effects.find((effect) => record(effect) && text(effect.kind) === 'terminal' && text(effect.role) === 'agent'
      && (text(effect.action) === 'created' || text(effect.action) === 'created_agent_terminal'
        || text(effect.action) === 'reused_agent_terminal'));
    const worktreeId = text(worktree?.id) || (record(worktreeEffect) ? text(worktreeEffect.id) : '');
    const worktreePath = text(worktree?.path) || worktreeId.split('::').slice(1).join('::').trim();
    const terminalId = text(providerTerminal?.handle) || text(providerTerminal?.id) || (record(terminalEffect) ? text(terminalEffect.id) : '');
    if (!worktreeId || !worktreePath || !terminalId) return continued(input, 'supervised_start', {
      cause: 'supervised_start_provider_placement_missing', actor: 'provider', evidence: {},
      nextAction: { kind: 'reconcile_supervised_start', note: 'reconcile provider-owned worktree and terminal identity from the ready receipt' },
    }, resources, startedAtMs, timings, deps.now);
    const runtime = text(providerTerminal?.runtime);
    const generation = text(providerTerminal?.generation);
    resources = { ...resources, worktreeId, worktreePath, providerAgentTerminalId: terminalId,
      ...(runtime && generation ? { terminal: { runtime, id: terminalId, generation } } : {}) };
  }
  resources = { ...resources, dispatchId };
  const readyResources: ReadyResult['resources'] = {
    ...resources,
    taskId,
    worktreeId: resources.worktreeId!,
    worktreeSelector: resources.worktreeSelector!,
    worktreePath: resources.worktreePath!,
    dispatchId,
  };
  const finishedAtMs = deps.now();
  return {
    schema: LAUNCH_ASSISTANT_SCHEMA,
    outcome: 'ready',
    workClass: input.workClass,
    resources: readyResources,
    supervisedStart: { ok: true, reason: 'ready_and_assignment_bound', assignmentBound: true },
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

function routeRefusalEdge(
  profile: SemanticExecutorProfile,
  cause: string,
): EdgeResult<ExecutorProfile> {
  return {
    status: 'continue', cause, actor: 'operator',
    evidence: { executorFamily: profile.family, profileVariables: profile.names },
    nextAction: { kind: 'repair_executor_profile', note: 'select an executor route whose model and effort channels are proven' },
  };
}

export async function resolveLiveExecutorProfile(
  workClass: LaunchWorkClass,
  inheritedEnv: Readonly<NodeJS.ProcessEnv>,
  startMode: WorkerStartMode | undefined,
  execute: ChildExecutor,
): Promise<EdgeResult<ExecutorProfile>> {
  const semanticEdge = profileResolutionEdge(workClass, inheritedEnv);
  if (semanticEdge.status !== 'ok') return semanticEdge;
  const profile = semanticEdge.value;
  if (!supportedStartMode(startMode)) return routeRefusalEdge(profile, 'executor_route_mismatch');

  const descriptor = EXECUTOR_FAMILY_DESCRIPTORS[profile.family];
  const listed = await execute(descriptor.catalogCommand);
  if (!listed.ok) return {
    status: 'continue', cause: 'executor_profile_applicability_unproven', actor: 'operator',
    evidence: { executorFamily: profile.family, profileVariables: profile.names },
    nextAction: { kind: 'repair_executor_profile', note: 'make the selected executor model catalog observable and select an available model' },
  };
  if (!executorCatalogContains(profile, listed.stdout)) return {
    status: 'continue', cause: 'executor_profile_model_unavailable', actor: 'operator',
    evidence: { executorFamily: profile.family, profileVariables: profile.names },
    nextAction: { kind: 'repair_executor_profile', note: 'select a model present in the selected executor model catalog' },
  };

  let capabilities = CURSOR_TASK_ROUTE_CAPABILITIES;
  if (profile.family === 'opencode') {
    const probeOutputs: string[] = [];
    for (const probe of descriptor.capabilityProbeCommands) {
      const observation = await execute(probe);
      if (!observation.ok) return routeRefusalEdge(profile, 'executor_route_unavailable');
      probeOutputs.push(observation.stdout);
    }
    capabilities = openCodeEdgeCapabilities(probeOutputs);
  }

  const verdict = evaluateExecutorRouteAdmission({
    profile,
    ...(startMode ? { startMode } : {}),
    edgeCapabilities: capabilities,
  });
  if (!verdict.ok) return routeRefusalEdge(profile, verdict.refusal);

  const inherited = await execute([
    process.execPath,
    '--input-type=module',
    '-e',
    'const n=process.argv.slice(1);process.exit(n.every((k)=>typeof process.env[k]==="string"&&process.env[k].trim())?0:1)',
    ...profile.names,
  ]);
  if (!inherited.ok) return {
    status: 'continue', cause: 'executor_profile_child_inheritance_unproven', actor: 'operator',
    evidence: { executorFamily: profile.family, profileVariables: profile.names },
    nextAction: { kind: 'repair_executor_profile', note: 'export the selected stable profile variables into the launching process' },
  };
  return admittedProfile(profile, verdict.route);
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

function mutationRequestIdField(
  data: Record<string, unknown>,
  name: 'orchestrationRequestId' | 'requestId',
): { readonly present: boolean; readonly value: string } | null {
  if (!Object.hasOwn(data, name)) return { present: false, value: '' };
  const value = typeof data[name] === 'string' ? data[name].trim() : '';
  return value ? { present: true, value } : null;
}

function mutationRequestId(value: Record<string, unknown> | null): string {
  const data = errorData(value);
  if (!data) return '';
  const orchestrationRequestId = mutationRequestIdField(data, 'orchestrationRequestId');
  const requestId = mutationRequestIdField(data, 'requestId');
  if (!orchestrationRequestId || !requestId) return '';
  if (orchestrationRequestId.present && requestId.present
    && orchestrationRequestId.value !== requestId.value) return '';
  return orchestrationRequestId.value || requestId.value;
}

export async function createManagerTaskWithOrca(
  runId: string,
  brief: string,
  execute: ChildExecutor,
): Promise<EdgeResult<{ readonly taskId: string; readonly status: string }>> {
  const value = envelope(await execute([
    'orca', 'orchestration', 'task-create', '--spec', brief, '--run', runId, '--json',
  ]));
  const result = resultRecord(value);
  const task = result && record(result.task) ? result.task : null;
  const taskId = text(task?.id);
  const status = text(task?.status);
  if (taskId && status) return { status: 'ok', value: { taskId, status } };
  const requestId = mutationRequestId(value);
  return requestId ? {
    status: 'continue', cause: 'manager_task_create_outcome_unknown', actor: 'provider', evidence: { requestId },
    nextAction: {
      kind: 'retry_manager_task_create',
      requestId,
      replay: {
        operation: 'orca_orchestration_task_create',
        runId,
        requestId,
        inputSource: 'caller_held_manager_brief',
      },
      note: 'replay the exact original Task-create with the caller-held original brief and this exact --retry-request id; the brief payload is intentionally not echoed',
    },
  } : {
    status: 'continue', cause: 'manager_task_create_failed_or_unknown', actor: 'provider', evidence: {},
    nextAction: { kind: 'reconcile_manager_task', note: 'reconcile current Orca Task authority; no new brief mutation is authorized' },
  };
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
  note = 'obtain a supported setup-complete/proven-reuse witness; never infer readiness from path/head',
): EdgeResult<PreparedWorktree> {
  return {
    status: 'continue', cause, actor: 'provider', evidence,
    nextAction: {
      kind: 'reconcile_worktree_setup',
      note,
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

  const repository = request.repository.trim().toLowerCase();
  const listed = resultRecord(envelope(await execute([
    'orca', 'repo', 'list', '--json',
  ])));
  const repos = listed?.repos;
  const repositoryResolutionNote = 'reconcile the exact registered Orca repository for the validated GitHub owner/repo before creating a fresh worktree';
  if (!Array.isArray(repos) || repos.some((repo) => !record(repo))) {
    return worktreeContinue('worktree_repository_resolution_malformed', { repository }, repositoryResolutionNote);
  }
  const canonicalKey = `github.com/${repository}`;
  const matches = repos.filter((repo) => {
    const repoRecord = record(repo) ? repo : null;
    const gitRemoteIdentity = repoRecord && record(repoRecord.gitRemoteIdentity) ? repoRecord.gitRemoteIdentity : null;
    return text(gitRemoteIdentity?.canonicalKey).toLowerCase() === canonicalKey;
  });
  if (matches.length === 0) {
    return worktreeContinue('worktree_repository_resolution_absent', { repository, matchCount: 0 }, repositoryResolutionNote);
  }
  if (matches.length !== 1) {
    return worktreeContinue('worktree_repository_resolution_ambiguous', { repository, matchCount: matches.length }, repositoryResolutionNote);
  }
  const repositoryId = record(matches[0]) ? text(matches[0].id) : '';
  if (!repositoryId) {
    return worktreeContinue('worktree_repository_resolution_id_unusable', { repository, matchCount: 1 }, repositoryResolutionNote);
  }
  if (request.providerTopLevel) {
    return {
      status: 'ok',
      value: { selector: 'new-top-level', repositorySelector: `id:${repositoryId}`, setupWitness: 'provider_top_level' },
      evidence: { repository, repositorySelector: `id:${repositoryId}` },
    };
  }

  const created = resultRecord(envelope(await execute([
    'orca', 'worktree', 'create', '--repo', `id:${repositoryId}`, '--name', request.worktreeName!,
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
    resolveProfile: (workClass, inheritedEnv, startMode) => resolveLiveExecutorProfile(
      workClass,
      inheritedEnv,
      startMode,
      (args, timeoutMs) => child(args, cwd, inheritedEnv, timeoutMs),
    ),
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
    createManagerTask: (runId, brief) => createManagerTaskWithOrca(
      runId,
      brief,
      (args, timeoutMs) => child(args, cwd, env, timeoutMs),
    ),
    observeDispatch: async (taskId) => dispatchEdge(envelope(await child([
      'orca', 'orchestration', 'dispatch-show', '--task', taskId, '--json',
    ], cwd, env))),
    prepareWorktree: async (request) => prepareWorktreeWithOrca(
      request,
      (args, timeoutMs) => child(args, cwd, env, timeoutMs),
    ),
  };
}

const LAUNCH_CLI_OPTIONS = new Set([
  '--repository',
  '--work-class',
  '--issue-number',
  '--run',
  '--task',
  '--manager-brief',
  '--worktree',
  '--worktree-name',
  '--base-branch',
]);

function launchCliOptions(argv: readonly string[]): ReadonlyMap<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? '';
    if (!LAUNCH_CLI_OPTIONS.has(name)) throw new Error(`unknown launch option: ${name || '<empty>'}`);
    if (parsed.has(name)) throw new Error(`duplicate launch option: ${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--') || !value.trim()) throw new Error(`${name} requires a non-empty value`);
    parsed.set(name, value);
  }
  return parsed;
}

export function parseLaunchAssistantCli(argv: readonly string[]): LaunchInput {
  const options = launchCliOptions(argv);
  const workClass = (options.get('--work-class') ?? '').trim();
  if (!LAUNCH_WORK_CLASSES.includes(workClass as LaunchWorkClass)) throw new Error('--work-class must be exactly manager|t1|t2|t3');
  const repository = (options.get('--repository') ?? '').trim().toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new Error('--repository owner/repo is required');
  const issueText = (options.get('--issue-number') ?? '').trim();
  let issueNumber: number | undefined;
  if (issueText) {
    if (!/^[1-9]\d*$/u.test(issueText)) throw new Error('--issue-number must be a positive integer');
    issueNumber = Number(issueText);
    if (!Number.isSafeInteger(issueNumber)) throw new Error('--issue-number must be a safe positive integer');
  }
  const runId = (options.get('--run') ?? '').trim();
  const taskId = (options.get('--task') ?? '').trim();
  const managerBrief = options.get('--manager-brief');
  const worktreeSelector = (options.get('--worktree') ?? '').trim();
  const worktreeName = (options.get('--worktree-name') ?? '').trim();
  const baseBranch = (options.get('--base-branch') ?? '').trim();
  const hasTask = Boolean(taskId);
  const hasManagerBrief = managerBrief !== undefined;
  const hasWorktreeSelector = Boolean(worktreeSelector);
  const hasWorktreeName = Boolean(worktreeName);

  if (hasWorktreeSelector === hasWorktreeName) throw new Error('provide exactly one --worktree or --worktree-name');
  if (workClass === 'manager') {
    if (!runId) throw new Error('manager requires --run');
    if (hasTask === hasManagerBrief) throw new Error('manager requires exactly one --task or --manager-brief');
  } else {
    if (!taskId) throw new Error(`${workClass} requires --task`);
    if (runId || hasManagerBrief) throw new Error('--run and --manager-brief are manager-only');
  }

  return {
    repository,
    workClass: workClass as LaunchWorkClass,
    ...(issueNumber ? { issueNumber } : {}),
    ...(runId ? { runId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(managerBrief !== undefined ? { managerBrief } : {}),
    ...(worktreeSelector ? { worktreeSelector } : {}),
    ...(worktreeName ? { worktreeName } : {}),
    ...(baseBranch ? { baseBranch } : {}),
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
