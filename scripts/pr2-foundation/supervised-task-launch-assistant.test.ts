import { describe, expect, it } from 'vitest';
import type { RuntimeAdapter, RuntimeWorker } from '../runtime/contracts.ts';
import type { SupervisedWorkerStartResult } from './supervised-worker-start.ts';
import {
  parseLaunchAssistantCli,
  prepareWorktreeWithOrca,
  resolveExecutorProfile,
  runSupervisedTaskLaunchAssistant,
  type DispatchObservation,
  type EdgeResult,
  type LaunchDependencies,
  type LaunchInput,
} from './supervised-task-launch-assistant.ts';

const worker: RuntimeWorker = {
  identity: { runtime: 'orca', id: 'terminal-fresh', generation: 'pty-1' },
  workspacePath: '/tmp/exact-worktree',
  title: 'worker',
  provenance: 'internal',
};

function runtimeAdapter(input: {
  worker?: RuntimeWorker;
  liveness?: 'busy' | 'idle' | 'unknown' | 'gone';
  onSpawn?: () => void;
} = {}): RuntimeAdapter {
  const target = input.worker ?? worker;
  const status = input.liveness ?? 'idle';
  return {
    id: 'orca',
    readiness: () => ({ status: 'ok', value: { ready: true, workspacePath: target.workspacePath } }),
    listWorkers: () => ({ status: 'ok', value: [target] }),
    findWorkerById: () => ({ status: 'ok', value: target }),
    findWorker: () => ({ status: 'ok', value: target }),
    resolveAssignmentWorker: () => ({ status: 'ok', value: { kind: 'resolved', worker: target } }),
    spawnWorker: () => { input.onSpawn?.(); return { status: 'ok', value: target }; },
    dispatchInput: () => ({ status: 'dispatched' }),
    readBoundedOutput: () => ({ status: 'ok', value: {
      worker: target.identity,
      lines: [],
      observationToken: { opaque: 'token' },
      changed: false,
      terminalState: 'running',
    } }),
    liveness: () => ({ status, worker: target.identity }),
    stopWorker: () => ({ status: 'ok', value: { stopped: true } }),
  };
}

function profileEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PACK_EXECUTOR_MANAGER_AGENT: 'cursor-agent', PACK_EXECUTOR_MANAGER_MODEL: 'model', PACK_EXECUTOR_MANAGER_EFFORT: 'medium',
    PACK_EXECUTOR_T1_AGENT: 'cursor-agent', PACK_EXECUTOR_T1_MODEL: 'model', PACK_EXECUTOR_T1_EFFORT: 'medium',
    PACK_EXECUTOR_T2_AGENT: 'cursor-agent', PACK_EXECUTOR_T2_MODEL: 'model', PACK_EXECUTOR_T2_EFFORT: 'medium',
    PACK_EXECUTOR_T3_AGENT: 'cursor-agent', PACK_EXECUTOR_T3_MODEL: 'model', PACK_EXECUTOR_T3_EFFORT: 'medium',
    ...overrides,
  };
}

function readyStart(taskId: string): SupervisedWorkerStartResult {
  return {
    ok: true,
    reason: 'ready_and_assignment_bound',
    receipt: { taskId, dispatchId: 'dispatch-1', state: 'ready' },
    assignment: {
      schemaVersion: 2,
      assignmentId: 'assignment-1',
      generation: 1,
      projectId: 'orchestrator-pack',
      repository: 'chetwerikoff/orchestrator-pack',
      taskId,
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-1',
      assignedAt: '2026-08-19T00:00:00.000Z',
    },
  } as unknown as SupervisedWorkerStartResult;
}

function deps(input: {
  adapter?: RuntimeAdapter;
  dispatch?: DispatchObservation[];
  onDispatch?: () => void;
  onWorktree?: () => void;
  managerRun?: EdgeResult<{ readonly runId: string }>;
  managerMembership?: EdgeResult<{ readonly taskId: string }>;
  managerCreate?: EdgeResult<{ readonly taskId: string; readonly status: string }>;
  supervised?: SupervisedWorkerStartResult;
  onSupervised?: () => void;
  clock?: number[];
} = {}): LaunchDependencies {
  const dispatch = [...(input.dispatch ?? [{ kind: 'absent' }, { kind: 'absent' }])];
  let clockIndex = 0;
  return {
    now: () => input.clock?.[clockIndex++] ?? clockIndex++,
    adapter: input.adapter ?? runtimeAdapter(),
    commandPreflight: () => ({ status: 'ok', value: true }),
    repositoryPreflight: async () => ({ status: 'ok', value: true }),
    resolveProfile: (workClass, env) => resolveExecutorProfile(workClass, env),
    observeManagerRun: async () => input.managerRun ?? ({ status: 'ok', value: { runId: 'run-1' } }),
    proveManagerTaskMembership: async () => input.managerMembership ?? ({ status: 'ok', value: { taskId: 'task-1' } }),
    createManagerTask: async () => input.managerCreate ?? ({ status: 'ok', value: { taskId: 'task-created', status: 'ready' } }),
    observeDispatch: async () => { input.onDispatch?.(); return { status: 'ok', value: dispatch.shift() ?? { kind: 'absent' } }; },
    prepareWorktree: async () => { input.onWorktree?.(); return { status: 'ok', value: {
      id: 'repo::exact-worktree', selector: 'id:repo::exact-worktree', path: '/tmp/exact-worktree', setupWitness: 'same_invocation_complete',
    } }; },
    runSupervisedStart: async (start) => { input.onSupervised?.(); return input.supervised ?? readyStart(String(start.orcaArgs[1])); },
  };
}

function launchInput(workClass: LaunchInput['workClass'] = 't2'): LaunchInput {
  return {
    repository: 'chetwerikoff/orchestrator-pack', workClass, issueNumber: 1479,
    taskId: 'task-1', worktreeName: 'issue-1479', env: profileEnv(),
    ...(workClass === 'manager' ? { runId: 'run-1' } : {}),
  };
}

function okEnvelope(result: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, result });
}

describe('supervised Task launch assistant', () => {
  it.each(['manager', 't1', 't2', 't3'] as const)('reaches ready only through supervised-start for %s', async (workClass) => {
    let supervised = 0;
    const result = await runSupervisedTaskLaunchAssistant(launchInput(workClass), deps({ onSupervised: () => { supervised += 1; } }));
    expect(result.outcome).toBe('ready');
    expect(supervised).toBe(1);
    if (result.outcome === 'ready') {
      expect(result.supervisedStart.reason).toBe('ready_and_assignment_bound');
      expect(result.resources).toMatchObject({ taskId: 'task-1', dispatchId: 'dispatch-1', terminal: worker.identity });
    }
  });

  it('hands the pre-created terminal to supervised-start without an agent selector', async () => {
    let emittedArgs: readonly string[] = [];
    const baseDeps = deps();
    const result = await runSupervisedTaskLaunchAssistant(launchInput(), {
      ...baseDeps,
      runSupervisedStart: async (start) => {
        emittedArgs = [...start.orcaArgs];
        return readyStart(String(start.orcaArgs[1]));
      },
    });
    expect(result.outcome).toBe('ready');
    expect(emittedArgs).toEqual([
      '--task', 'task-1', '--terminal', 'terminal-fresh', '--worktree', 'id:repo::exact-worktree',
    ]);
    expect(emittedArgs).not.toContain('--agent');
  });

  it('manager without Issue preserves run/task identity and still reaches ordinary supervised-start', async () => {
    const input = { ...launchInput('manager'), issueNumber: undefined };
    const result = await runSupervisedTaskLaunchAssistant(input, deps());
    expect(result.outcome).toBe('ready');
    if (result.outcome === 'ready') {
      expect(result.resources.issueNumber).toBeUndefined();
      expect(result.resources.runId).toBe('run-1');
    }
  });

  it('rejects literal cursor/crossed profile values before Task/runtime effects', async () => {
    let worktrees = 0; let spawns = 0;
    const input: LaunchInput = { ...launchInput('t2'), env: profileEnv({ PACK_EXECUTOR_T2_AGENT: 'cursor' }) };
    const result = await runSupervisedTaskLaunchAssistant(input, deps({
      onWorktree: () => { worktrees += 1; }, adapter: runtimeAdapter({ onSpawn: () => { spawns += 1; } }),
    }));
    expect(result).toMatchObject({ outcome: 'continue', stage: 'executor_profile', observedCause: 'executor_profile_literal_cursor_unsupported' });
    expect(worktrees).toBe(0); expect(spawns).toBe(0);
  });

  it('manager proves exact current Run before Task membership/effects', async () => {
    let worktrees = 0;
    const result = await runSupervisedTaskLaunchAssistant(launchInput('manager'), deps({
      managerRun: { status: 'ok', value: { runId: 'other-run' } }, onWorktree: () => { worktrees += 1; },
    }));
    expect(result).toMatchObject({ outcome: 'continue', stage: 'manager_run', observedCause: 'manager_run_mismatch' });
    expect(worktrees).toBe(0);
  });

  it('manager existing Task requires exact Task-to-Run membership', async () => {
    let worktrees = 0;
    const result = await runSupervisedTaskLaunchAssistant(launchInput('manager'), deps({
      managerMembership: { status: 'continue', cause: 'manager_task_membership_absent', actor: 'manager', evidence: { matchCount: 0 },
        nextAction: { kind: 'reconcile_manager_task' } }, onWorktree: () => { worktrees += 1; },
    }));
    expect(result).toMatchObject({ outcome: 'continue', stage: 'manager_task', observedCause: 'manager_task_membership_absent' });
    expect(worktrees).toBe(0);
  });

  it('manager brief uses exactly one Task-create edge and preserves provider retry identity without echoing brief', async () => {
    const input: LaunchInput = { repository: 'chetwerikoff/orchestrator-pack', workClass: 'manager', runId: 'run-1',
      managerBrief: 'private brief payload', worktreeName: 'manager-worktree', env: profileEnv() };
    const result = await runSupervisedTaskLaunchAssistant(input, deps({
      managerCreate: { status: 'continue', cause: 'manager_task_create_outcome_unknown', actor: 'provider', evidence: { requestId: 'req-1' },
        nextAction: { kind: 'retry_manager_task_create', requestId: 'req-1', command: 'orca orchestration task-create --spec <same-manager-brief> --run run-1 --retry-request req-1 --json' } },
    }));
    expect(result).toMatchObject({ outcome: 'continue', stage: 'manager_task', observedCause: 'manager_task_create_outcome_unknown',
      nextAction: { kind: 'retry_manager_task_create', requestId: 'req-1' } });
    expect(JSON.stringify(result)).not.toContain('private brief payload');
  });

  it('early non-null Dispatch creates no worktree or terminal and makes no start', async () => {
    let worktrees = 0; let spawns = 0; let starts = 0;
    const result = await runSupervisedTaskLaunchAssistant(launchInput(), deps({ dispatch: [{ kind: 'present', dispatchId: 'dispatch-existing' }],
      onWorktree: () => { worktrees += 1; }, adapter: runtimeAdapter({ onSpawn: () => { spawns += 1; } }), onSupervised: () => { starts += 1; } }));
    expect(result).toMatchObject({ outcome: 'continue', stage: 'dispatch_admission_early', resources: { dispatchId: 'dispatch-existing' } });
    expect(worktrees).toBe(0); expect(spawns).toBe(0); expect(starts).toBe(0);
  });

  it('immediate pre-start Dispatch race is fenced after one fresh terminal and before worker-start', async () => {
    let spawns = 0; let starts = 0;
    const result = await runSupervisedTaskLaunchAssistant(launchInput(), deps({ dispatch: [{ kind: 'absent' }, { kind: 'present', dispatchId: 'dispatch-race' }],
      adapter: runtimeAdapter({ onSpawn: () => { spawns += 1; } }), onSupervised: () => { starts += 1; } }));
    expect(result).toMatchObject({ outcome: 'continue', stage: 'dispatch_admission_final', resources: { dispatchId: 'dispatch-race' } });
    expect(spawns).toBe(1); expect(starts).toBe(0);
  });

  it.each([
    ['terminal_provenance_external', { ...worker, provenance: 'external' as const }, 'idle' as const],
    ['terminal_workspace_mismatch', { ...worker, workspacePath: '/tmp/other' }, 'idle' as const],
    ['terminal_liveness_busy', worker, 'busy' as const],
    ['terminal_liveness_unknown', worker, 'unknown' as const],
  ])('fails the machine-enforced terminal boundary: %s', async (cause, target, liveness) => {
    const result = await runSupervisedTaskLaunchAssistant(launchInput(), deps({ adapter: runtimeAdapter({ worker: target, liveness }) }));
    expect(result).toMatchObject({ outcome: 'continue', stage: 'terminal_prepare', observedCause: cause });
  });

  it('preserves worker-start provider mutation recovery as one exact replay action', async () => {
    const result = await runSupervisedTaskLaunchAssistant(launchInput(), deps({ supervised: {
      ok: false, reason: 'supervised_start_envelope_error', errorCode: 'runtime_timeout',
      recovery: { requestId: 'request-7', dispatchId: 'dispatch-accepted', recoveryCommand: 'orca orchestration worker-show --dispatch dispatch-accepted --json' },
    } }));
    expect(result).toMatchObject({ outcome: 'continue', stage: 'supervised_start', resources: { dispatchId: 'dispatch-accepted' },
      nextAction: { kind: 'retry_supervised_start', requestId: 'request-7' } });
    if (result.outcome === 'continue') {
      expect(result.nextAction.command).toContain('--retry-request');
      expect(result.nextAction.command).toContain('request-7');
      expect(result.nextAction.command).not.toContain('--agent');
    }
  });

  it('accepts fresh Orca worktree creation when setup is explicitly not configured', async () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1', worktreeName: 'wt', issueNumber: 1479,
    }, async (args) => {
      mutableCalls.push([...args]);
      return { ok: true, stdout: okEnvelope({
        worktree: { id: 'repo::wt', path: '/tmp/wt' },
        setupReceipt: { requested: 'run', hookFound: false, state: 'not_configured' },
      }) };
    });
    expect(result).toMatchObject({ status: 'ok', value: { id: 'repo::wt', setupWitness: 'same_invocation_complete' } });
    expect(mutableCalls).toHaveLength(1);
  });

  it('waits for the exact fresh setup terminal to exit successfully', async () => {
    const calls: string[][] = [];
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1', worktreeName: 'wt', baseBranch: 'main',
    }, async (args) => {
      calls.push([...args]);
      if (args[1] === 'worktree') return { ok: true, stdout: okEnvelope({
        worktree: { id: 'repo::wt', path: '/tmp/wt' },
        setupReceipt: { requested: 'run', hookFound: true, state: 'running', terminalHandle: 'setup-term' },
      }) };
      return { ok: true, stdout: okEnvelope({ wait: {
        handle: 'setup-term', condition: 'exit', satisfied: true, status: 'exited', exitCode: 0,
      } }) };
    });
    expect(result).toMatchObject({ status: 'ok', value: { setupWitness: 'same_invocation_complete' } });
    expect(calls[1]).toEqual(['orca', 'terminal', 'wait', '--terminal', 'setup-term', '--for', 'exit', '--timeout-ms', '120000', '--json']);
  });

  it('fails closed when fresh setup exits non-zero', async () => {
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1', worktreeName: 'wt',
    }, async (args) => args[1] === 'worktree'
      ? { ok: true, stdout: okEnvelope({ worktree: { id: 'repo::wt', path: '/tmp/wt' },
        setupReceipt: { requested: 'run', hookFound: true, state: 'running', terminalHandle: 'setup-term' } }) }
      : { ok: true, stdout: okEnvelope({ wait: { handle: 'setup-term', satisfied: true, status: 'exited', exitCode: 1 } }) });
    expect(result).toMatchObject({ status: 'continue', cause: 'worktree_setup_wait_not_successful', evidence: { exitCode: 1 } });
  });

  it('does not infer reuse readiness from worktree path/head alone', async () => {
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1', worktreeSelector: 'id:repo::existing',
    }, async () => ({ ok: true, stdout: okEnvelope({ worktree: { id: 'repo::existing', path: '/tmp/existing', head: 'abc' } }) }));
    expect(result).toMatchObject({ status: 'continue', cause: 'worktree_reuse_readiness_unproven', evidence: { worktreeId: 'repo::existing' } });
  });

  it('records deterministic assistant-entry and per-stage timings only', async () => {
    const clock = Array.from({ length: 40 }, (_value, index) => 1_000 + index * 10);
    const result = await runSupervisedTaskLaunchAssistant(launchInput(), deps({ clock }));
    expect(result.startedAtMs).toBe(1_000);
    expect(result.elapsedMs).toBeGreaterThan(0);
    expect(result.timings[0]).toMatchObject({ stage: 'command_preflight', elapsedMs: 10 });
    expect(result.timings.at(-1)?.stage).toBe('supervised_start');
  });

  it('CLI requires explicit work class and preserves manager argument shapes', () => {
    expect(parseLaunchAssistantCli(['--repository', 'chetwerikoff/orchestrator-pack', '--work-class', 'manager', '--run', 'run-1', '--task', 'task-1', '--worktree', 'id:w'])).toMatchObject({
      workClass: 'manager', runId: 'run-1', taskId: 'task-1', worktreeSelector: 'id:w',
    });
    expect(() => parseLaunchAssistantCli(['--repository', 'chetwerikoff/orchestrator-pack', '--work-class', 'smoke'])).toThrow(/work-class/u);
  });
});
