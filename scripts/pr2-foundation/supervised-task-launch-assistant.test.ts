import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as subprocess from '../kernel/subprocess.ts';
import { runProcess } from '../kernel/subprocess.ts';
import { OrcaTaskRuntimeAdapter } from '../orca-runtime/task-adapter.ts';
import { openCodeControlFromCommand } from '../orca-runtime/adapter.ts';
import { lastFleetParkedLine, ownPaneOutcome } from '../fleet/fleet-sweep.ts';
import type { OrcaJsonResponse } from '../orca-runtime/native.ts';
import type { RuntimeAdapter, RuntimeWorker } from '../runtime/contracts.ts';
import { runSupervisedWorkerStart, type SupervisedWorkerStartResult } from './supervised-worker-start.ts';
import {
  currentWorkerAssignment, publishCurrentWorkerAssignment, resolveWorkerAssignmentStorePath,
  type DelegatedIntegrationMarker, type WorkerAssignment,
} from '../lib/worker-assignment-store.ts';
import {
  createManagerTaskWithOrca,
  createProductionLaunchDependencies,
  claudePaneProfileObserved,
  readManagerBriefTemplateFromDisk,
  parseLaunchAssistantCli,
  prepareWorktreeWithOrca,
  resolveExecutorProfile,
  resolveLiveExecutorProfile,
  finalizeOpenCodeExecutorProfile,
  parseOpenCodePrimaryProbeArgs,
  runOpenCodePrimaryProbe,
  runExistingOpenCodeResume,
  runSupervisedTaskLaunchAssistant,
  LAUNCH_STARTUP_OBSERVATION_WINDOW_MS,
  CANONICAL_MERGE_LAUNCH_COMMAND,
  repoCanonicalKey,
  type DispatchObservation,
  type EdgeResult,
  type LaunchDependencies,
  type LaunchInput,
  type OpenCodeResumeDependencies,
} from './supervised-task-launch-assistant.ts';
import {
  buildExecutorCommand,
  buildOpenCodeAgentOverlay,
  openCodeAgentConfigFromInfo,
  withOpenCodeFleetBrowserDenies,
  buildProviderInvocation,
  catalogIdentityForProfile,
  openCodeAgentSemantics,
  openCodeFleetBrowserDenyRulesAreTerminal,
  openCodeLaunchHasFleetBrowserDenies,
  openCodeControlPort,
  EXECUTOR_FAMILY_DESCRIPTORS,
  profileNamesForTask,
  profileNamesForSmoke,
  resolveSemanticExecutorProfile,
} from '../executor-profile-policy.ts';
import { overlayExecutorProfileEnv, readExecutorProfileStore } from '../executor-profile-store.ts';

describe('production manager Run observation command seam', () => {
  it.each([
    { name: 'bound coordinator', runId: 'run-1', run: { id: 'run-1', coordinator_handle: 'term-selected' }, bound: true, ok: true },
    { name: 'unbound caller with exact id', runId: 'run-1', run: { id: 'run-1', coordinator_handle: 'term-selected' }, bound: false, ok: true },
    { name: 'foreign coordinator', runId: 'run-1', run: { id: 'run-1', coordinator_handle: 'term-foreign' }, bound: true, ok: false },
    { name: 'unknown Run', runId: 'run-unknown', run: null, bound: true, ok: false },
    { name: 'missing Run id', runId: 'run-1', run: { coordinator_handle: 'term-selected' }, bound: true, ok: false },
    { name: 'mismatched Run id', runId: 'run-1', run: { id: 'run-other', coordinator_handle: 'term-selected' }, bound: true, ok: false },
    { name: 'missing coordinator', runId: 'run-1', run: { id: 'run-1' }, bound: true, ok: false },
    { name: 'missing selected caller', runId: 'run-1', run: { id: 'run-1', coordinator_handle: 'term-selected' }, bound: true, ok: false },
    { name: 'unreadable Run', runId: 'run-1', run: { id: 'run-1', coordinator_handle: 'term-selected' }, bound: true, ok: false },
    { name: 'no-id fallback', runId: '', run: { id: 'run-1', coordinator_handle: 'term-selected' }, bound: true, ok: true },
  ])('$name', async ({ name, runId, run, bound, ok }) => {
    const config = mkdtempSync(join(tmpdir(), 'manager-run-seam-'));
    const cards = join(config, 'orchestrator-pack', 'projects');
    mkdirSync(cards, { recursive: true });
    writeFileSync(join(cards, 'orchestrator-pack.json'), JSON.stringify({
      projectId: 'orchestrator-pack', repository: 'chetwerikoff/orchestrator-pack',
      primaryRoot: process.cwd(), defaultBranch: 'main', orcaWorkspacePattern: '.*',
      orchestratorTitlePattern: '.*', browserGpt: { projectUrl: 'https://example.test/project' },
    }));
    const commands: string[][] = [];
    const execute = vi.spyOn(subprocess, 'runProcess').mockImplementation(async (options) => {
      const argv = [options.command, ...(options.args ?? [])];
      commands.push(argv);
      const observed = argv.includes('run-current') && !bound ? null : run;
      const result = argv.includes('task-list')
        ? { runId, tasks: [{ id: 'task-1' }] } : { run: observed };
      return { outcome: 'exit', ok: name !== 'unreadable Run', exitCode: name === 'unreadable Run' ? 1 : 0, signal: null, stdout: JSON.stringify({ ok: true, result }), stderr: '', timedOut: false, cancelled: false };
    });
    try {
      const production = await createProductionLaunchDependencies({
        ...launchInput(), projectId: 'orchestrator-pack',
        env: { ...profileEnv(), XDG_CONFIG_HOME: config, ORCA_TERMINAL_HANDLE: name === 'missing selected caller' ? '' : 'term-selected' },
      });
      const result = await production.observeManagerRun(runId);
      expect(result.status).toBe(ok ? 'ok' : 'continue');
      if (ok) expect(result).toMatchObject({ status: 'ok', value: { runId: 'run-1' } });
      else expect(result).toMatchObject({ status: 'continue', cause: 'manager_run_observation_unavailable', nextAction: { kind: 'reconcile_manager_run', note: expect.any(String) } });
      expect(commands).toEqual([runId
        ? ['orca', 'orchestration', 'run-show', '--id', runId, '--json']
        : ['orca', 'orchestration', 'run-current', '--json']]);
      if (runId) {
        commands.length = 0;
        let artifacts = 0;
        const result = await runSupervisedTaskLaunchAssistant({ ...launchInput('manager'), runId }, {
          ...deps({ onWorktree: () => { artifacts += 1; }, onSupervised: () => { artifacts += 1; } }),
          observeManagerRun: production.observeManagerRun,
          proveManagerTaskMembership: production.proveManagerTaskMembership,
        });
        expect(result.outcome).toBe(ok ? 'ready' : 'continue');
        expect(artifacts).toBe(ok ? 2 : 0);
        if (!ok) expect(result).toMatchObject({ observedCause: 'manager_run_observation_unavailable', nextAction: { kind: 'reconcile_manager_run' } });
        expect(commands).toEqual([
          ['orca', 'orchestration', 'run-show', '--id', runId, '--json'],
          ...(ok ? [['orca', 'orchestration', 'task-list', '--run', runId, '--json']] : []),
        ]);
      }
    } finally { execute.mockRestore(); rmSync(config, { recursive: true, force: true }); }
  });
});

describe('Issue #2547 strict production GitHub origin preflight', () => {
  it.each([
    ['mixed-case SSH', 'git@GITHUB.COM:Chetwerikoff/AppliedIN.git', 'CHETWERIKOFF/AppliedIn', true],
    ['mixed-case HTTPS', 'https://GitHub.com/CHETWERIKOFF/appliedIN.git', 'chetwerikoff/AppliedIn', true],
    ['extra SSH segment', 'git@github.com:other/chetwerikoff/AppliedIn.git', 'chetwerikoff/AppliedIn', false],
    ['extra HTTPS segment', 'https://github.com/other/chetwerikoff/AppliedIn.git', 'chetwerikoff/AppliedIn', false],
    ['confusable HTTP scheme', 'httpſ://github.com/chetwerikoff/AppliedIn.git', 'chetwerikoff/AppliedIn', false],
    ['confusable SSH repository', 'git@github.com:chetwerikoff/Kepo.git', 'chetwerikoff/Kepo', false],
    ['confusable HTTPS repository', 'https://github.com/chetwerikoff/Kepo.git', 'chetwerikoff/Kepo', false],
    ['confusable card repository', 'git@github.com:chetwerikoff/Kepo.git', 'chetwerikoff/Kepo', false],
    ['empty segment', 'git@github.com:chetwerikoff//AppliedIn.git', 'chetwerikoff/AppliedIn', false],
    ['non-GitHub origin', 'git@example.com:chetwerikoff/AppliedIn.git', 'chetwerikoff/AppliedIn', false],
    ['wrong origin', 'git@github.com:other/AppliedIn.git', 'chetwerikoff/AppliedIn', false],
    ['invalid card', 'git@github.com:chetwerikoff/AppliedIn.git', 'other/chetwerikoff/AppliedIn', false],
  ] as const)('direct callback: %s', async (_name, remote, repository, matched) => {
    const config = mkdtempSync(join(tmpdir(), 'production-origin-'));
    const cards = join(config, 'orchestrator-pack', 'projects');
    mkdirSync(cards, { recursive: true });
    writeFileSync(join(cards, 'orchestrator-pack.json'), JSON.stringify({
      projectId: 'orchestrator-pack', repository: 'chetwerikoff/AppliedIn',
      primaryRoot: process.cwd(), defaultBranch: 'main', orcaWorkspacePattern: '.*',
      orchestratorTitlePattern: '.*', browserGpt: { projectUrl: 'https://example.test/project' },
    }));
    const commands: Array<{ argv: string[]; cwd: string | undefined }> = [];
    const mockSync = vi.spyOn(subprocess, 'runProcessSync').mockImplementation(() => ({
      outcome: 'exit', ok: true, exitCode: 0, signal: null,
      stdout: 'https://github.com/chetwerikoff/AppliedIn.git\n', stderr: '',
      timedOut: false, cancelled: false,
    }));
    const mock = vi.spyOn(subprocess, 'runProcess').mockImplementation(async (options) => {
      commands.push({ argv: [options.command, ...(options.args ?? [])], cwd: options.cwd });
      return {
        outcome: 'exit', ok: true, exitCode: 0, signal: null,
        stdout: remote + '\n', stderr: '', timedOut: false, cancelled: false,
      };
    });
    try {
      const production = await createProductionLaunchDependencies({
        ...launchInput(), projectId: 'orchestrator-pack', repository: 'chetwerikoff/AppliedIn',
        env: { ...profileEnv(), XDG_CONFIG_HOME: config },
      });
      const direct = await production.repositoryPreflight(repository);
      expect(direct.status).toBe(matched ? 'ok' : 'continue');
      if (!matched) expect(direct).toMatchObject({ cause: 'repository_preflight_mismatch' });
      expect(commands).toEqual([{ argv: ['git', 'remote', 'get-url', 'origin'], cwd: process.cwd() }]);
      if (matched) {
        commands.length = 0;
        const ordinary = await runSupervisedTaskLaunchAssistant({
          ...launchInput(), repository: 'CHETWERIKOFF/AppliedIn',
        }, { ...deps(), repositoryPreflight: production.repositoryPreflight });
        expect(ordinary.outcome).toBe('ready');
        expect(ordinary.resources.repository).toBe('chetwerikoff/appliedin');
        expect(commands).toEqual([{ argv: ['git', 'remote', 'get-url', 'origin'], cwd: process.cwd() }]);
      }
    } finally {
      mock.mockRestore();
      mockSync.mockRestore();
      rmSync(config, { recursive: true, force: true });
    }
  });

  it.each([
    ['git@GITHUB.COM:CHETWERIKOFF/AppliedIn.git', 'github.com/chetwerikoff/appliedin'],
    ['https://github.com/CHETWERIKOFF/AppliedIn.git', 'github.com/chetwerikoff/appliedin'],
    ['git@github.com:other/chetwerikoff/AppliedIn.git', ''],
    ['https://github.com/other/chetwerikoff/AppliedIn.git', ''],
    ['git@github.com:chetwerikoff//AppliedIn.git', ''],
    ['https://github.com//chetwerikoff/AppliedIn.git', ''],
    ['httpſ://github.com/chetwerikoff/AppliedIn.git', ''],
    ['git@github.com:chetwerikoff/Kepo.git', ''],
    ['https://github.com/chetwerikoff/Kepo.git', ''],
    ['git@elsewhere.example:chetwerikoff/AppliedIn.git', ''],
  ] as const)('normalizes only an exact GitHub owner/repo path: %s', (origin, expected) => {
    expect(repoCanonicalKey(origin)).toBe(expected);
  });
});

const MANAGER_PREAMBLE_FIXTURE = `# Manager launch preamble

Manager work may hand a correction to the firefighter role when required.
Do not classify an ordinary manager launch as firefighter work from the preamble alone.
`;
const FIREFIGHTER_PROMPT_FIXTURE = `# Firefighter universal
Firefighter rules.
`;
const OLDER_MANAGER_PREAMBLE_FIXTURE = `# Manager launch preamble

Older manager work rules differ from the current canonical body.
Older manager body remains ordinary unless the Issue title or delta says firefighter.
`;

const worker: RuntimeWorker = {
  identity: { runtime: 'orca', id: 'terminal-fresh', generation: 'pty-1' },
  workspacePath: '/tmp/exact-worktree',
  title: 'worker',
  provenance: 'internal',
};

function runtimeAdapter(input: {
  worker?: RuntimeWorker;
  liveness?: 'busy' | 'idle' | 'unknown' | 'gone';
  livenessSequence?: readonly ('busy' | 'idle' | 'unknown' | 'gone')[];
  livenessWorker?: RuntimeWorker['identity'];
  onSpawn?: () => void;
  onLiveness?: (observationWindowMs: number) => void;
  onLivenessSample?: (status: 'busy' | 'idle' | 'unknown' | 'gone') => void;
} = {}): RuntimeAdapter {
  const target = input.worker ?? worker;
  const fixedStatus = input.liveness ?? 'idle';
  const livenessSequence = [...(input.livenessSequence ?? [fixedStatus])];
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
    liveness: ({ observationWindowMs }) => {
      input.onLiveness?.(observationWindowMs);
      let status = fixedStatus;
      for (const sample of livenessSequence) {
        status = sample;
        input.onLivenessSample?.(sample);
        if (sample !== 'busy') break;
      }
      return { status, worker: input.livenessWorker ?? target.identity };
    },
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

function opencodeProfileEnv(workClass: LaunchInput['workClass'] = 't2'): NodeJS.ProcessEnv {
  const prefix = workClass === 'manager' ? 'MANAGER' : workClass.toUpperCase();
  return profileEnv({
    [`PACK_EXECUTOR_${prefix}_AGENT`]: 'opencode',
    [`PACK_EXECUTOR_${prefix}_MODEL`]: 'fixture-opencode-model',
    [`PACK_EXECUTOR_${prefix}_EFFORT`]: 'fixture-opencode-effort',
  });
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
  managerTemplate?: EdgeResult<string>;
  firefighterTemplate?: EdgeResult<string>;
  managerIssueTitle?: EdgeResult<string>;
  managerCreate?: EdgeResult<{ readonly taskId: string; readonly status: string }>;
  onManagerCreate?: (brief: string) => void;
  supervised?: SupervisedWorkerStartResult;
  onSupervised?: () => void;
  currentAssignment?: WorkerAssignment | null;
  proveTerminalGone?: LaunchDependencies['proveTerminalGone'];
  clock?: number[];
} = {}): LaunchDependencies {
  const dispatch = [...(input.dispatch ?? [{ kind: 'absent' }, { kind: 'absent' }])];
  let clockIndex = 0;
  return {
    now: () => input.clock?.[clockIndex++] ?? clockIndex++,
    adapter: input.adapter ?? runtimeAdapter(),
    commandPreflight: () => ({ status: 'ok', value: true }),
    repositoryPreflight: async () => ({ status: 'ok', value: true }),
    resolveProfile: (workClass, env, startMode) => resolveExecutorProfile(workClass, env, startMode),
    observeManagerRun: async () => input.managerRun ?? ({ status: 'ok', value: { runId: 'run-1' } }),
    proveManagerTaskMembership: async () => input.managerMembership ?? ({ status: 'ok', value: { taskId: 'task-1' } }),
    readManagerBriefTemplate: async (name) => name === 'manager-preamble.md'
      ? input.managerTemplate ?? ({ status: 'ok', value: MANAGER_PREAMBLE_FIXTURE })
      : input.firefighterTemplate ?? ({ status: 'ok', value: FIREFIGHTER_PROMPT_FIXTURE }),
    readIssueTitle: async () => input.managerIssueTitle ?? ({ status: 'ok', value: 'ordinary issue' }),
    createManagerTask: async (_runId, brief) => {
      input.onManagerCreate?.(brief);
      return input.managerCreate ?? ({ status: 'ok', value: { taskId: 'task-created', status: 'ready' } });
    },
    observeDispatch: async () => { input.onDispatch?.(); return { status: 'ok', value: dispatch.shift() ?? { kind: 'absent' } }; },
    readCurrentAssignment: () => input.currentAssignment ?? null,
    ...(input.proveTerminalGone ? { proveTerminalGone: input.proveTerminalGone } : {}),
    prepareWorktree: async () => { input.onWorktree?.(); return { status: 'ok', value: {
      id: 'repo::exact-worktree', selector: 'id:repo::exact-worktree', path: '/tmp/exact-worktree', setupWitness: 'same_invocation_complete',
    } }; },
    finalizeProfile: async (profile) => ({ status: 'ok', value: profile }),
    runSupervisedStart: async (start) => { input.onSupervised?.(); return input.supervised ?? readyStart(String(start.orcaArgs[1])); },
  };
}

function launchInput(workClass: LaunchInput['workClass'] = 't2'): LaunchInput {
  return {
    repository: 'chetwerikoff/orchestrator-pack', workClass, issueNumber: 1479,
    taskId: 'task-1', env: profileEnv(), startMode: 'exact_terminal_worktree',
    ...(workClass === 'manager' ? { runId: 'run-1', worktreeSelector: 'id:manager-worktree' } : { worktreeName: 'issue-1479' }),
  };
}

function okEnvelope(result: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, result });
}

function repoListEnvelope(repos: readonly Record<string, unknown>[]): string {
  return okEnvelope({ repos });
}

const REGISTERED_ORCA_ROOT = '/tmp/orca-registered-checkout';

function registeredOrcaRepo(id = 'orca-repo-1', path = REGISTERED_ORCA_ROOT): Record<string, unknown> {
  return {
    id, path, kind: 'git', executionHostId: 'local',
    gitRemoteIdentity: { canonicalKey: 'github.com/upstream/unrelated' },
  };
}

function freshRepoFixture(input: {
  repos?: readonly Record<string, unknown>[];
  listOutput?: string;
  originByPath?: Readonly<Record<string, string>>;
  rootByPath?: Readonly<Record<string, string>>;
  failRoot?: boolean;
  failOrigin?: boolean;
  setupState?: 'not_configured' | 'running' | 'absent';
  waitExitCode?: number;
  freshStatus?: string;
} = {}) {
  const calls: Array<{ argv: string[]; cwd: string | undefined }> = [];
  const execute = async (
    args: readonly string[], _timeoutMs?: number, _env?: Readonly<NodeJS.ProcessEnv>, cwd?: string,
  ) => {
    const argv = [...args];
    calls.push({ argv, cwd });
    const command = argv.join(' ');
    if (command === 'orca repo list --json') {
      return { ok: true, stdout: input.listOutput ?? repoListEnvelope(input.repos ?? [registeredOrcaRepo()]), stderr: '' };
    }
    if (command === 'git rev-parse --show-toplevel') {
      return {
        ok: !input.failRoot, stdout: (input.rootByPath?.[cwd ?? ''] ?? cwd ?? '') + '\n', stderr: '',
      };
    }
    if (command === 'git remote get-url origin') {
      return {
        ok: !input.failOrigin,
        stdout: (input.originByPath?.[cwd ?? ''] ?? 'git@github.com:chetwerikoff/orchestrator-pack.git') + '\n',
        stderr: '',
      };
    }
    if (command === 'git status --porcelain=v1 --untracked-files=all') {
      return { ok: true, stdout: input.freshStatus ?? '', stderr: '' };
    }
    if (args[0] === 'orca' && args[1] === 'worktree' && args[2] === 'create') {
      const receipt = input.setupState === 'absent' ? {} : {
        setupReceipt: input.setupState === 'running'
          ? { requested: 'run', hookFound: true, state: 'running', terminalHandle: 'setup-term' }
          : { requested: 'run', hookFound: false, state: 'not_configured' },
      };
      return {
        ok: true, stdout: okEnvelope({ worktree: { id: 'repo::wt', path: '/tmp/wt' }, ...receipt }), stderr: '',
      };
    }
    if (args[0] === 'orca' && args[1] === 'terminal' && args[2] === 'wait') {
      return {
        ok: true,
        stdout: okEnvelope({ wait: {
          handle: 'setup-term', satisfied: true, status: 'exited', exitCode: input.waitExitCode ?? 0,
        } }), stderr: '',
      };
    }
    return { ok: false, stdout: '', stderr: 'unexpected command: ' + command };
  };
  return { execute, calls };
}

function managerReuseFixture(input: {
  worktreeId?: string;
  worktreePath?: string;
  head?: string;
  originMain?: string;
  branch?: string;
  remoteUrl?: string;
  status?: string;
  fetchOk?: boolean;
  originResolved?: boolean;
  ancestor?: boolean;
  mergeOk?: boolean;
  sharedBranch?: boolean;
  prOverrides?: Readonly<Record<string, unknown>>;
  noPr?: boolean;
  duplicatePr?: boolean;
  prListOk?: boolean;
  prViewOk?: boolean;
  prChanged?: boolean;
  taskMembership?: boolean;
  localHeadChanged?: boolean;
} = {}) {
  const worktreeId = input.worktreeId ?? 'repo::existing';
  const worktreePath = input.worktreePath ?? '/tmp/existing';
  const originMain = input.originMain ?? '2'.repeat(40);
  const branch = input.branch ?? 'manager-2024';
  let head = input.head ?? '1'.repeat(40);
  let mergeTransitions = 0;
  let headReads = 0;
  const prReads = new Map<number, number>();
  const firstPr: Record<string, unknown> = {
    number: 42,
    body: 'Closes #2430',
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: branch,
    headRefOid: head,
    headRepository: { nameWithOwner: 'chetwerikoff/orchestrator-pack' },
    ...input.prOverrides,
  };
  const prs: Array<Record<string, unknown>> = input.noPr
    ? []
    : input.duplicatePr ? [firstPr, { ...firstPr, number: 43 }] : [firstPr];
  const calls: string[][] = [];
  const execute = async (
    args: readonly string[],
    _timeoutMs?: number,
    _env?: Readonly<NodeJS.ProcessEnv>,
    cwd?: string,
  ) => {
    calls.push([...args]);
    if (args[0] === 'orca') {
      if (args[2] === 'task-list') {
        return { ok: true, stdout: okEnvelope({
          runId: 'run-1',
          tasks: input.taskMembership === false ? [{ id: 'task-other' }] : [{ id: 'task-1' }],
        }), stderr: '' };
      }
      return { ok: true, stdout: okEnvelope({ worktree: { id: worktreeId, path: worktreePath } }), stderr: '' };
    }
    if (cwd !== worktreePath) return { ok: false, stdout: '', stderr: 'wrong cwd' };
    const command = args.join(' ');
    if (args[0] === 'gh' && args[1] === 'pr' && args[2] === 'list') {
      return {
        ok: input.prListOk !== false,
        stdout: JSON.stringify(prs.map((pr) => ({
          number: pr.number, baseRefName: pr.baseRefName, headRefName: pr.headRefName, headRefOid: pr.headRefOid,
        }))),
        stderr: '',
      };
    }
    if (args[0] === 'gh' && args[1] === 'pr' && args[2] === 'view') {
      const number = Number(args[3]);
      const count = (prReads.get(number) ?? 0) + 1;
      prReads.set(number, count);
      const pr = prs.find((candidate) => candidate.number === number);
      return {
        ok: input.prViewOk !== false && Boolean(pr),
        stdout: JSON.stringify(input.prChanged && count > 1 ? { ...pr, headRefOid: 'f'.repeat(40) } : pr),
        stderr: '',
      };
    }
    if (command === 'git symbolic-ref --quiet --short HEAD') {
      return { ok: true, stdout: branch + '\n', stderr: '' };
    }
    if (command === 'git rev-parse --show-toplevel') return { ok: true, stdout: `${worktreePath}\n`, stderr: '' };
    if (command === 'git remote get-url origin') {
      return {
        ok: true,
        stdout: `${input.remoteUrl ?? 'git@github.com:chetwerikoff/orchestrator-pack.git'}\n`,
        stderr: '',
      };
    }
    if (command === 'git worktree list --porcelain') {
      return {
        ok: true,
        stdout: [
          'worktree /tmp/primary',
          `HEAD ${originMain}`,
          'branch refs/heads/main',
          '',
          `worktree ${worktreePath}`,
          `HEAD ${head}`,
          `branch refs/heads/${branch}`,
          ...(input.sharedBranch ? ['', 'worktree /tmp/sibling', `HEAD ${head}`, `branch refs/heads/${branch}`] : []),
          '',
        ].join('\n'),
        stderr: '',
      };
    }
    if (command === 'git fetch --no-tags origin main:refs/remotes/origin/main') {
      return { ok: input.fetchOk !== false, stdout: '', stderr: input.fetchOk === false ? 'fetch failed' : '' };
    }
    if (command === 'git rev-parse --verify refs/remotes/origin/main^{commit}') {
      return input.originResolved === false
        ? { ok: false, stdout: '', stderr: 'origin/main unresolved' }
        : { ok: true, stdout: `${originMain}\n`, stderr: '' };
    }
    if (command === 'git status --porcelain=v1 --untracked-files=all') {
      return { ok: true, stdout: input.status ?? '', stderr: '' };
    }
    if (command === 'git rev-parse --verify HEAD^{commit}') {
      headReads += 1;
      return { ok: true, stdout: (input.localHeadChanged && headReads > 1 ? 'f'.repeat(40) : head) + '\n', stderr: '' };
    }
    if (args[0] === 'git' && args[1] === 'merge-base' && args[2] === '--is-ancestor'
      && args[4] === originMain) {
      return { ok: input.ancestor !== false, stdout: '', stderr: input.ancestor === false ? 'not ancestor' : '' };
    }
    if (args[0] === 'git' && args[1] === 'merge' && args[2] === '--ff-only' && args[3] === originMain) {
      if (input.mergeOk === false) return { ok: false, stdout: '', stderr: 'merge failed' };
      if (head !== originMain) {
        head = originMain;
        mergeTransitions += 1;
      }
      return { ok: true, stdout: '', stderr: '' };
    }
    return { ok: false, stdout: '', stderr: `unexpected command: ${command}` };
  };
  return {
    execute,
    calls,
    head: () => head,
    mergeTransitions: () => mergeTransitions,
    originMain,
    worktreeId,
    worktreePath,
  };
}

function opencodeProbeResult(args: readonly string[], variant = true): { ok: boolean; stdout: string; stderr: string } {
  if (args[0] === 'opencode' && args[1] === 'models' && args.includes('--verbose')) {
    return {
      ok: true,
      stdout: [
        'fixture-opencode-model',
        '{',
        '  "variants": {',
        '    "fixture-opencode-effort": { "reasoningEffort": "fixture" }',
        '  }',
        '}',
        '',
      ].join('\n'),
      stderr: '',
    };
  }
  if (args[0] === 'opencode' && args[1] === 'models') return { ok: true, stdout: 'fixture-opencode-model\n', stderr: '' };
  if (args[0] === 'opencode' && args[1] === 'debug' && args[2] === 'agent') {
    if (!variant) return { ok: true, stdout: JSON.stringify({ model: { providerID: 'opencode', modelID: 'fixture-opencode-model' } }), stderr: '' };
    return { ok: true, stdout: JSON.stringify({ model: { providerID: 'opencode', modelID: 'fixture-opencode-model' }, variant: 'fixture-opencode-effort' }), stderr: '' };
  }
  if (args[0] === 'opencode' && args.includes('--help')) {
    return { ok: true, stdout: '', stderr: 'Usage: opencode --agent AGENT\n' };
  }
  if (args[0] === 'orca' || args[0] === 'opencode') return { ok: true, stdout: 'supported help surface\n', stderr: '' };
  if (args[0] === process.execPath) return { ok: true, stdout: '', stderr: '' };
  return { ok: false, stdout: '', stderr: '' };
}

describe('Issue #2646 OpenCode merge on primary and mandatory browser overlay', () => {
  const primary = '/tmp/issue-2646-selected-primary';
  const delegated: DelegatedIntegrationMarker = {
    prNumber: 2647, expectedHeadSha: 'a'.repeat(40),
    predecessorAssignmentId: 'assignment-predecessor-2646', predecessorGeneration: 1,
  };
  const predecessor: WorkerAssignment = {
    schema: 'orchestrator-pack/worker-assignment/v1',
    projectId: 'orchestrator-pack', repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: 2646, taskId: 'task-1',
    assignmentId: delegated.predecessorAssignmentId, generation: delegated.predecessorGeneration,
    kind: 'local', provider: 'orca', bindingKey: 'dispatch-predecessor',
    createdAtUtc: '2026-10-18T00:00:00.000Z', role: 'worker',
  };
  const mergeInput = (overrides: Partial<LaunchInput> = {}): LaunchInput => ({
    ...launchInput('t2'), workClass: 'merge', issueNumber: 2646,
    worktreeName: undefined, primaryRoot: primary, worktreeSelector: `path:${primary}`,
    delegatedIntegration: delegated, env: opencodeProfileEnv('manager'), ...overrides,
  });
  const mergeReadyStart = (taskId: string): SupervisedWorkerStartResult => {
    const result = readyStart(taskId);
    if (!result.assignment) throw new Error('missing test assignment');
    return { ...result, assignment: {
      ...result.assignment, issueNumber: 2646, role: 'worker', delegatedIntegration: delegated,
    } };
  };

  it('launches the existing merge Task only on primary with one denied OpenCode config, no new worktree', async () => {
    const input = mergeInput();
    const worktreeCommands: string[][] = [];
    const spawned: Array<{ title: string; command: string; workspace: string }> = [];
    const nativeStarts: string[][] = [];
    const ownedWorker: RuntimeWorker = { ...worker, workspacePath: primary };
    const adapter: RuntimeAdapter = {
      ...runtimeAdapter({ worker: ownedWorker }),
      spawnWorker: ({ title, command, workspace }) => {
        spawned.push({ title, command, workspace });
        return { status: 'ok', value: ownedWorker };
      },
    };
    const result = await runSupervisedTaskLaunchAssistant(input, {
      ...deps({ adapter, currentAssignment: predecessor }),
      resolveProfile: (workClass, env, startMode) => resolveLiveExecutorProfile(
        workClass, env, startMode, async (args) => opencodeProbeResult(args),
      ),
      prepareWorktree: (request) => prepareWorktreeWithOrca(request, async (args) => {
        worktreeCommands.push([...args]);
        return { ok: true, stdout: okEnvelope({ worktree: { id: 'repo::primary', path: primary } }), stderr: '' };
      }),
      finalizeProfile: async (profile) => {
        const overlay = buildOpenCodeAgentOverlay({
          agentName: 'pack-opk-merge-2646',
          baseline: {
            name: 'build', mode: 'primary',
            permission: [
              { permission: 'bash', pattern: '*', action: 'allow' },
              { permission: 'skill', pattern: '*', action: 'allow' },
            ],
          },
          model: 'fixture-opencode-model', effort: 'fixture-opencode-effort',
          stateRoot: '/tmp/issue-2646-isolated-state',
        });
        return { status: 'ok', value: {
          ...profile, launchCommand: overlay.command,
          agentName: overlay.agentName, inlineConfigJson: overlay.inlineConfigJson,
        } };
      },
      runSupervisedStart: async (start) => {
        nativeStarts.push([...start.orcaArgs]);
        expect(start.delegatedIntegration).toEqual(delegated);
        expect(start.issueNumber).toBe(2646);
        return mergeReadyStart('task-1');
      },
    });
    expect(result.outcome, result.outcome === 'continue' ? `stage=${result.stage}; cause=${result.observedCause}` : '').toBe('ready');
    expect(worktreeCommands).toEqual([[
      'orca', 'worktree', 'show', '--worktree', `path:${primary}`, '--json',
    ]]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ title: 'opk-t2-merge-task-1', workspace: primary });
    expect(nativeStarts).toEqual([[
      '--task', 'task-1', '--terminal', 'terminal-fresh', '--worktree', 'id:repo::primary',
    ]]);
    expect(nativeStarts[0]).not.toContain('--agent');

    // Regression for the reported /proc/<pid>/environ count 0: the actual
    // spawn command must contain exactly one full OPENCODE_CONFIG_CONTENT.
    const command = spawned[0]!.command;
    expect(command.match(/OPENCODE_CONFIG_CONTENT=/gu)).toHaveLength(1);
    const inline = /^OPENCODE_CONFIG_CONTENT='([^']+)' XDG_STATE_HOME='[^']+' opencode --hostname 127\.0\.0\.1 --port \d+ --agent '([^']+)'$/u.exec(command);
    expect(inline).not.toBeNull();
    const config = JSON.parse(inline![1]!) as {
      permission: { bash: Record<string, string>; skill: Record<string, string> };
      agent: Record<string, { permission: unknown }>;
    };
    for (const permission of [
      config.permission,
      config.agent[inline![2]!]!.permission,
      config.agent.general!.permission,
      config.agent.explore!.permission,
    ]) {
      expect(openCodeFleetBrowserDenyRulesAreTerminal(permission)).toBe(true);
      const overlay = permission as typeof config.permission;
      expect(overlay.bash.bsk).toBe('deny');
      expect(overlay.bash['bsk *']).toBe('deny');
      expect(overlay.skill['browser-skill']).toBe('deny');
    }
    if (result.outcome === 'ready') {
      expect(result.resources).toMatchObject({
        taskId: 'task-1', worktreePath: primary, worktreeId: 'repo::primary',
      });
    }
  });

  it('persists merge OpenCode ownership and reuses the terminal on a pre-Dispatch retry', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'opk-2646-merge-terminal-'));
    const env = { ...opencodeProfileEnv('manager'), OPK_WAKE_SUPERVISOR_STATE_DIR: stateRoot };
    const title = 'opk-t2-merge-task-1';
    const handle = 'terminal-merge-task-1';
    const generation = 'generation-merge-task-1';
    let creates = 0;
    let createdCommand = '';
    const terminal = () => ({
      handle, incarnationId: generation, worktreePath: primary,
      title, command: createdCommand, status: 'running' as const,
    });
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = String(args[0] ?? '') + ' ' + String(args[1] ?? '');
      switch (operation) {
        case 'terminal list':
          return { ok: true, result: {
            totalCount: creates ? 1 : 0, truncated: false, terminals: creates ? [terminal()] : [],
          } };
        case 'terminal create':
          expect(args[args.indexOf('--title') + 1]).toBe(title);
          expect(args[args.indexOf('--worktree') + 1]).toBe(primary);
          creates += 1;
          createdCommand = String(args[args.indexOf('--command') + 1] ?? '');
          return { ok: true, result: { terminal: terminal() } };
        case 'terminal show':
          return { ok: true, result: { terminal: terminal() } };
        case 'terminal wait':
          return { ok: true, result: { wait: { status: 'running', satisfied: false } } };
        default:
          return { ok: false, error: { code: 'unexpected_operation', message: operation } };
      }
    });
    const requestedUrls: string[] = [];
    const openCodeHttpRequest = (request: { readonly url: string }) => {
      requestedUrls.push(request.url);
      if (request.url.endsWith('/global/health')) {
        return { status: 200, body: JSON.stringify({ healthy: true, version: '1.18.25' }) };
      }
      if (request.url.endsWith(`/session?directory=${encodeURIComponent(primary)}`)) {
        return { status: 200, body: JSON.stringify([{ id: 'ses-merge-task-1', directory: primary }]) };
      }
      throw new Error(`unexpected OpenCode URL: ${request.url}`);
    };
    const launch = (adapter: OrcaTaskRuntimeAdapter) => runSupervisedTaskLaunchAssistant({
      ...mergeInput({ env }),
    }, {
      ...deps({ adapter, currentAssignment: predecessor }),
      resolveProfile: (workClass, profileEnv, startMode) => resolveLiveExecutorProfile(
        workClass, profileEnv, startMode, async (args) => opencodeProbeResult(args),
      ),
      prepareWorktree: async () => ({ status: 'ok', value: {
        id: 'repo::primary', selector: 'id:repo::primary',
        path: primary, setupWitness: 'proven_reuse',
      } }),
      finalizeProfile: async (profile) => ({ status: 'ok', value: profile }),
      runSupervisedStart: async () => { throw new Error('busy merge terminal must not create a Dispatch'); },
    });

    try {
      const first = await launch(new OrcaTaskRuntimeAdapter({ runJson: runJson as never, env, openCodeHttpRequest }));
      expect(first).toMatchObject({
        outcome: 'continue', stage: 'terminal_prepare', observedCause: 'terminal_liveness_busy',
      });
      expect(creates).toBe(1);
      expect(createdCommand.match(/OPENCODE_CONFIG_CONTENT=/gu)).toHaveLength(1);
      const owned = first.resources.terminal;
      expect(owned).toMatchObject({ runtime: 'orca', id: handle, generation });
      if (!owned) throw new Error('first launch must return the owned terminal');

      const recordPath = join(stateRoot, 'launch-task-terminals',
        createHash('sha256').update(title).digest('hex') + '.json');
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
        title: string; workspacePath: string; identity: RuntimeWorker['identity'];
        openCodeControl: { url: string; agent: string };
      };
      const port = /--port ([1-9]\d*)/u.exec(createdCommand)?.[1];
      expect(port).toBeTruthy();
      expect(record).toMatchObject({
        title, workspacePath: primary, identity: owned,
        openCodeControl: { url: 'http://127.0.0.1:' + port, agent: expect.any(String) },
      });

      const afterRestart = new OrcaTaskRuntimeAdapter({ runJson: runJson as never, env, openCodeHttpRequest });
      expect(afterRestart.composerControl?.(owned)?.kind).toBe('opencode-http');
      expect(afterRestart.openCodeHealth(owned)).toMatchObject({
        status: 'ok', value: { healthy: true, version: '1.18.25' },
      });
      expect(requestedUrls).toEqual([
        `${record.openCodeControl.url}/global/health`,
        `${record.openCodeControl.url}/session?directory=${encodeURIComponent(primary)}`,
      ]);
      const retried = await launch(afterRestart);
      expect(retried).toMatchObject({
        outcome: 'continue', stage: 'terminal_prepare', observedCause: 'terminal_liveness_busy',
        resources: { terminal: owned },
      });
      expect(creates).toBe(1);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });


  it('replaces the exact live predecessor and publishes an Issue-scoped delegated worker assignment on the same Task', async () => {
    const base = mkdtempSync(join(tmpdir(), 'opk-2646-delegated-handoff-'));
    const env = { ...opencodeProfileEnv('manager'), OPK_BASE_DIR: base };
    const file = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
    try {
      const published = await publishCurrentWorkerAssignment({
        file, projectId: 'orchestrator-pack', repository: 'chetwerikoff/orchestrator-pack',
        issueNumber: 2646, taskId: 'task-1', kind: 'local', provider: 'orca',
        bindingKey: 'dispatch-predecessor', role: 'worker',
      });
      if (!published.ok) throw new Error(published.reason);
      const marker = {
        ...delegated,
        predecessorAssignmentId: published.assignment.assignmentId,
        predecessorGeneration: published.assignment.generation,
      };
      const oldWorker: RuntimeWorker = {
        ...worker, identity: { runtime: 'orca', id: 'term-implementation', generation: 'generation-implementation' },
        workspacePath: primary,
      };
      const mergeWorker: RuntimeWorker = {
        ...worker, identity: { runtime: 'orca', id: 'term-merge', generation: 'generation-merge' },
        workspacePath: primary,
      };
      let oldLive = true;
      let stopCount = 0;
      let starts = 0;
      const adapter: RuntimeAdapter = {
        ...runtimeAdapter({ worker: mergeWorker }),
        resolveAssignmentWorker: ({ bindingKey }) => {
          expect(bindingKey).toBe('dispatch-predecessor');
          return { status: 'ok', value: oldLive ? { kind: 'resolved', worker: oldWorker } : { kind: 'gone' } };
        },
        findWorker: ({ id }) => ({ status: 'ok', value:
          id === oldWorker.identity.id ? (oldLive ? oldWorker : null) : id === mergeWorker.identity.id ? mergeWorker : null }),
        stopWorker: (identity) => {
          expect(identity).toEqual(oldWorker.identity);
          oldLive = false;
          stopCount += 1;
          return { status: 'ok', value: { stopped: true } };
        },
        liveness: ({ worker: identity }) => ({ status: 'idle', worker: identity }),
      };
      const result = await runSupervisedTaskLaunchAssistant(mergeInput({ env, delegatedIntegration: marker }), {
        ...deps({ adapter, dispatch: [
          { kind: 'present', dispatchId: 'dispatch-predecessor' },
          { kind: 'present', dispatchId: 'dispatch-predecessor' },
        ] }),
        readCurrentAssignment: (issueNumber) => currentWorkerAssignment(file, issueNumber),
        resolveProfile: (workClass, inherited, startMode) => resolveLiveExecutorProfile(
          workClass, inherited, startMode, async (args) => opencodeProbeResult(args),
        ),
        prepareWorktree: async () => ({ status: 'ok', value: {
          id: 'repo::primary', selector: 'id:repo::primary', path: primary,
          setupWitness: 'proven_reuse',
        } }),
        runSupervisedStart: (start) => {
          expect(start.delegatedIntegration).toEqual(marker);
          expect(start.issueNumber).toBe(2646);
          return runSupervisedWorkerStart({
            ...start,
            inspect: async (argv) => {
              if (argv[0] === 'terminal' && argv[1] === 'show') {
                return { ok: true, stdout: okEnvelope({ terminal: {
                  handle: 'term-merge', worktreeId: 'repo::primary', incarnationId: 'generation-merge',
                } }) };
              }
              if (argv[0] === 'worktree' && argv[1] === 'show') {
                return { ok: true, stdout: okEnvelope({ worktree: { id: 'repo::primary', path: primary } }) };
              }
              throw new Error('unexpected native inspection');
            },
            execute: async () => {
              expect(oldLive).toBe(false);
              starts += 1;
              return { ok: true, stdout: okEnvelope({
                taskId: 'task-1', dispatchId: 'dispatch-merge', state: 'ready',
                effects: [
                  { kind: 'worktree', action: 'reused', id: 'repo::primary' },
                  { kind: 'terminal', role: 'agent', action: 'reused', id: 'term-merge' },
                  { kind: 'dispatch_input', role: 'agent', id: 'term-merge', state: 'accepted' },
                ],
              }) };
            },
          });
        },
      });
      expect(result).toMatchObject({ outcome: 'ready', resources: {
        issueNumber: 2646, taskId: 'task-1', dispatchId: 'dispatch-merge',
        worktreePath: primary,
      } });
      expect(stopCount).toBe(1);
      expect(starts).toBe(1);
      const current = currentWorkerAssignment(file, 2646);
      expect(current).toMatchObject({
        issueNumber: 2646, taskId: 'task-1', bindingKey: 'dispatch-merge',
        generation: published.assignment.generation + 1, delegatedIntegration: marker,
      });
      expect(current?.assignmentId).not.toBe(published.assignment.assignmentId);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('requires the delegated marker and exact predecessor Dispatch before any merge terminal effect', async () => {
    let spawns = 0;
    let worktrees = 0;
    const adapter = runtimeAdapter({ onSpawn: () => { spawns += 1; } });
    const baseDeps = {
      ...deps({ adapter, onWorktree: () => { worktrees += 1; } }),
      resolveProfile: (workClass: LaunchInput['workClass'], env: Readonly<NodeJS.ProcessEnv>, startMode?: LaunchInput['startMode']) =>
        resolveLiveExecutorProfile(workClass, env, startMode, async (args) => opencodeProbeResult(args)),
    };
    const missing = await runSupervisedTaskLaunchAssistant(mergeInput({ delegatedIntegration: undefined }), baseDeps);
    expect(missing).toMatchObject({
      outcome: 'continue', stage: 'executor_profile', observedCause: 'merge_delegated_integration_required',
    });
    const missingPredecessor = await runSupervisedTaskLaunchAssistant(mergeInput(), baseDeps);
    expect(missingPredecessor).toMatchObject({
      outcome: 'continue', stage: 'dispatch_admission_early',
      observedCause: 'merge_delegated_predecessor_mismatch',
    });
    const wrongPredecessor = await runSupervisedTaskLaunchAssistant(mergeInput({
      delegatedIntegration: { ...delegated, predecessorAssignmentId: 'other-assignment' },
    }), { ...baseDeps, readCurrentAssignment: () => predecessor });
    expect(wrongPredecessor).toMatchObject({
      outcome: 'continue', stage: 'dispatch_admission_early',
      observedCause: 'merge_delegated_predecessor_mismatch',
    });
    const foreignDispatch = await runSupervisedTaskLaunchAssistant(mergeInput(), {
      ...baseDeps, readCurrentAssignment: () => predecessor,
      observeDispatch: async () => ({ status: 'ok', value: { kind: 'present', dispatchId: 'dispatch-foreign' } }),
    });
    expect(foreignDispatch).toMatchObject({
      outcome: 'continue', stage: 'dispatch_admission_early',
      observedCause: 'fresh_dispatch_not_absent',
    });
    expect(spawns).toBe(0);
    expect(worktrees).toBe(0);
  });

  it('preserves the exact delegated marker in a bounded supervised-start retry command', async () => {
    const result = await runSupervisedTaskLaunchAssistant(mergeInput(), {
      ...deps({
        adapter: runtimeAdapter({ worker: { ...worker, workspacePath: primary } }),
        currentAssignment: predecessor,
        supervised: { ok: false, reason: 'supervised_start_envelope_error', recovery: { requestId: 'req-merge' } },
      }),
      resolveProfile: (workClass, env, startMode) => resolveLiveExecutorProfile(
        workClass, env, startMode, async (args) => opencodeProbeResult(args),
      ),
      prepareWorktree: async () => ({ status: 'ok', value: {
        id: 'repo::primary', selector: 'id:repo::primary', path: primary, setupWitness: 'proven_reuse',
      } }),
    });
    expect(result).toMatchObject({ outcome: 'continue', stage: 'supervised_start',
      nextAction: { kind: 'retry_supervised_start', requestId: 'req-merge' } });
    if (result.outcome === 'continue') {
      expect(result.nextAction.command).toContain('--issue-number 2646');
      expect(result.nextAction.command).toContain("--delegated-integration '" + JSON.stringify(delegated) + "'");
      expect(result.nextAction.command).toContain('--retry-request');
    }
  });

  it.each(['manager', 't1', 't2', 't3'] as const)(
    'keeps the %s OpenCode launch class instead of suggesting merge after an overlay refusal', async (workClass) => {
      const profile = await resolveLiveExecutorProfile(workClass, opencodeProfileEnv(workClass),
        'exact_terminal_worktree', async (args) => opencodeProbeResult(args));
      if (profile.status !== 'ok') throw new Error('OpenCode test profile must resolve');
      const result = await runSupervisedTaskLaunchAssistant({
        ...launchInput(workClass), env: opencodeProfileEnv(workClass),
      }, {
        ...deps(),
        resolveProfile: () => ({ status: 'ok', value: {
          ...profile.value, launchCommand: 'opencode --agent build',
        } }),
      });
      expect(result).toMatchObject({ outcome: 'continue', stage: 'executor_profile',
        observedCause: 'opencode_launch_overlay_required' });
      if (result.outcome === 'continue') {
        expect(result.nextAction.command).toBeUndefined();
        expect(result.nextAction.note).toContain('--work-class ' + workClass);
        expect(result.nextAction.note).toContain('OPENCODE_CONFIG_CONTENT');
      }
    },
  );


  it.each(['manager', 't2'] as const)(
    'retains the %s launch class when finalization strips the OpenCode deny overlay', async (workClass) => {
      const profile = await resolveLiveExecutorProfile(workClass, opencodeProfileEnv(workClass),
        'exact_terminal_worktree', async (args) => opencodeProbeResult(args));
      if (profile.status !== 'ok') throw new Error('OpenCode test profile must resolve');
      let spawns = 0;
      const result = await runSupervisedTaskLaunchAssistant({
        ...launchInput(workClass), env: opencodeProfileEnv(workClass),
      }, {
        ...deps({ adapter: runtimeAdapter({ onSpawn: () => { spawns += 1; } }) }),
        resolveProfile: () => profile,
        finalizeProfile: async (resolved) => ({ status: 'ok', value: {
          ...resolved, launchCommand: 'opencode --agent build',
        } }),
      });
      expect(result).toMatchObject({ outcome: 'continue', stage: 'terminal_prepare',
        observedCause: 'opencode_launch_overlay_required' });
      if (result.outcome === 'continue') {
        expect(result.nextAction.command).toBeUndefined();
        expect(result.nextAction.note).toContain('--work-class ' + workClass);
      }
      expect(spawns).toBe(0);
    },
  );

  it('refuses a bare OpenCode spawn even when stale metadata claims an overlay', async () => {
    const profile = await resolveLiveExecutorProfile('merge', opencodeProfileEnv('manager'),
      'exact_terminal_worktree', async (args) => opencodeProbeResult(args));
    expect(profile.status).toBe('ok');
    if (profile.status !== 'ok') return;
    const bare = { ...profile.value, launchCommand: 'opencode --hostname 127.0.0.1 --agent build' };
    expect(openCodeLaunchHasFleetBrowserDenies({ command: bare.launchCommand, agentName: bare.agentName, inlineConfigJson: bare.inlineConfigJson })).toBe(false);
    let worktrees = 0;
    let spawns = 0;
    const result = await runSupervisedTaskLaunchAssistant(mergeInput(), {
      ...deps({ adapter: runtimeAdapter({ onSpawn: () => { spawns += 1; } }) }),
      resolveProfile: () => ({ status: 'ok', value: bare }),
      prepareWorktree: async () => { worktrees += 1; throw new Error('must not prepare a worktree'); },
    });
    expect(result).toMatchObject({
      outcome: 'continue', stage: 'executor_profile',
      observedCause: 'opencode_launch_overlay_required',
      nextAction: { command: CANONICAL_MERGE_LAUNCH_COMMAND },
    });
    expect(worktrees).toBe(0);
    expect(spawns).toBe(0);
  });

  it('refuses an overlay stripped during finalization before spawning a terminal', async () => {
    const profile = await resolveLiveExecutorProfile('merge', opencodeProfileEnv('manager'),
      'exact_terminal_worktree', async (args) => opencodeProbeResult(args));
    if (profile.status !== 'ok') throw new Error('fixture OpenCode profile must resolve');
    let spawns = 0;
    let starts = 0;
    const result = await runSupervisedTaskLaunchAssistant(mergeInput(), {
      ...deps({ adapter: runtimeAdapter({ onSpawn: () => { spawns += 1; }, worker: { ...worker, workspacePath: primary } }),
        currentAssignment: predecessor, onSupervised: () => { starts += 1; } }),
      resolveProfile: () => profile,
      prepareWorktree: async () => ({ status: 'ok', value: {
        id: 'repo::primary', selector: 'id:repo::primary', path: primary, setupWitness: 'proven_reuse',
      } }),
      finalizeProfile: async (resolved) => ({ status: 'ok', value: {
        ...resolved, launchCommand: 'opencode --agent build',
      } }),
    });
    expect(result).toMatchObject({
      outcome: 'continue', stage: 'terminal_prepare',
      observedCause: 'opencode_launch_overlay_required',
      nextAction: { command: CANONICAL_MERGE_LAUNCH_COMMAND },
    });
    expect(spawns).toBe(0);
    expect(starts).toBe(0);
  });

  it('selects primary from the project card, never accepts worktree creation arguments', () => {
    const select = () => ({
      projectId: 'orchestrator-pack', repository: 'chetwerikoff/orchestrator-pack',
      primaryRoot: primary, defaultBranch: 'main',
    } as ReturnType<typeof import('../lib/target-context.ts').resolveTargetContext>);
    const base = [
      '--project', 'orchestrator-pack', '--work-class', 'merge', '--task', 'task-1',
      '--issue-number', '2646', '--delegated-integration', JSON.stringify(delegated),
    ];
    expect(parseLaunchAssistantCli(base, process.env, select)).toMatchObject({
      workClass: 'merge', taskId: 'task-1', primaryRoot: primary,
      issueNumber: 2646, delegatedIntegration: delegated, worktreeSelector: `path:${primary}`,
    });
    for (const forbidden of [['--worktree', 'id:other'], ['--worktree-name', 'new'],
      ['--run', 'run-1'], ['--manager-brief', 'brief']]) {
      expect(() => parseLaunchAssistantCli([...base, ...forbidden], process.env, select)).toThrow();
    }
    expect(() => parseLaunchAssistantCli(base.slice(0, -2), process.env, select)).toThrow();
    expect(() => parseLaunchAssistantCli(base.filter((_, index) => index !== 6 && index !== 7), process.env, select)).toThrow();
    expect(() => parseLaunchAssistantCli([...base.slice(0, -1), '{}'], process.env, select)).toThrow();
    expect(() => parseLaunchAssistantCli([...base.slice(0, -1), 'not-json'], process.env, select)).toThrow();
  });

  it('rejects an unproven/mismatched primary worktree without creating or refreshing', async () => {
    const seen: string[][] = [];
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1',
      worktreeSelector: `path:${primary}`, primaryReuseRoot: primary,
    }, async (args) => {
      seen.push([...args]);
      return { ok: true, stdout: okEnvelope({ worktree: {
        id: 'repo::other', path: '/tmp/unrelated-worktree',
      } }), stderr: '' };
    });
    expect(result).toMatchObject({ status: 'continue', cause: 'merge_primary_checkout_unproven' });
    expect(seen).toEqual([['orca', 'worktree', 'show', '--worktree', `path:${primary}`, '--json']]);
  });
});

describe('supervised Task launch assistant', () => {
  it('refuses an explicit atomic provider fresh start before any unverified setup or worker effect', async () => {
    let preparations = 0;
    let spawns = 0;
    let starts = 0;
    const result = await runSupervisedTaskLaunchAssistant({
      ...launchInput('t2'), startMode: 'provider_new_top_level',
    }, {
      ...deps({
        adapter: runtimeAdapter({ onSpawn: () => { spawns += 1; } }),
        onSupervised: () => { starts += 1; },
      }),
      prepareWorktree: async () => { preparations += 1; return {
        status: 'ok', value: { selector: 'new-top-level', setupWitness: 'provider_top_level' },
      }; },
    });
    expect(result).toMatchObject({
      outcome: 'continue', stage: 'executor_profile',
      observedCause: 'fresh_provider_clean_witness_unavailable',
    });
    expect(preparations).toBe(0);
    expect(spawns).toBe(0);
    expect(starts).toBe(0);
  });

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

  it('Issue #2689: canonical next-Task reuse binds its exact existing manager terminal to the explicit Issue', async () => {
    const base = mkdtempSync(join(tmpdir(), 'issue-2689-existing-terminal-'));
    const env = profileEnv({ OPK_BASE_DIR: base });
    const file = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
    const inspect = async (argv: readonly string[]) => ({
      ok: true, stdout: JSON.stringify({ ok: true, result: argv[0] === 'terminal'
        ? { terminal: { handle: worker.identity.id, incarnationId: worker.identity.generation, worktreeId: 'repo::exact-worktree' } }
        : { worktree: { id: 'repo::exact-worktree', path: worker.workspacePath } } }),
    });
    const nativeStarts: string[][] = [];
    const start = async (args: Parameters<typeof runSupervisedWorkerStart>[0]) =>
      runSupervisedWorkerStart({
        ...args, inspect,
        execute: async (argv) => {
          nativeStarts.push([...argv]);
          return { ok: true, stdout: JSON.stringify({ ok: true, result: {
            taskId: argv[1], dispatchId: argv[1] === 'task-old' ? 'dispatch-old' : 'dispatch-new',
            state: 'ready',
            effects: [
              { kind: 'worktree', action: 'reused', id: 'repo::exact-worktree' },
              { kind: 'terminal', role: 'agent', action: 'reused', id: worker.identity.id },
              { kind: 'dispatch_input', role: 'agent', action: 'accepted', id: worker.identity.id },
            ],
          } }) };
        },
      });
    let spawned = 0;
    let prepared = 0;
    try {
      const previous = await runSupervisedTaskLaunchAssistant({
        ...launchInput('manager'), issueNumber: undefined, taskId: 'task-old', env,
      }, { ...deps(), proveManagerTaskMembership: async (_runId, taskId) => ({ status: 'ok', value: { taskId } }), runSupervisedStart: start });
      expect(previous.outcome).toBe('ready');
      expect(currentWorkerAssignment(file, 2689)).toBeNull();

      const transition = await runSupervisedTaskLaunchAssistant({
        ...launchInput('manager'), issueNumber: 2689, taskId: 'task-new', env,
        existingTerminal: worker.identity.id,
      } as LaunchInput & { existingTerminal: string }, {
        ...deps({
          onWorktree: () => { prepared += 1; },
          adapter: runtimeAdapter({ onSpawn: () => { spawned += 1; } }),
        }),
        proveManagerTaskMembership: async (_runId, taskId) => ({ status: 'ok', value: { taskId } }),
        runSupervisedStart: start,
      });
      expect(transition.outcome).toBe('ready');
      expect(spawned).toBe(0);
      expect(prepared).toBe(0);
      expect(nativeStarts.map((argv) => argv[1])).toEqual(['task-old', 'task-new']);
      expect(currentWorkerAssignment(file, 2689)).toMatchObject({
        issueNumber: 2689, role: 'orchestrator', taskId: 'task-new', bindingKey: 'dispatch-new',
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
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

  it.each([
    ['executor_profile_missing', { PACK_EXECUTOR_T2_MODEL: '' }],
    ['executor_profile_malformed', { PACK_EXECUTOR_T2_MODEL: 'model with spaces' }],
    ['executor_profile_malformed', { PACK_EXECUTOR_CURSOR_CONTEXT: '272k with spaces' }],
    ['executor_profile_agent_unsupported', { PACK_EXECUTOR_T2_AGENT: 'codex' }],
    ['executor_profile_agent_unsupported', { PACK_EXECUTOR_T2_AGENT: 'cursor' }],
  ] as const)('rejects invalid executor profile before effects: %s', async (cause, overrides) => {
    let worktrees = 0; let spawns = 0;
    const input: LaunchInput = { ...launchInput('t2'), env: profileEnv(overrides) };
    const result = await runSupervisedTaskLaunchAssistant(input, deps({
      onWorktree: () => { worktrees += 1; }, adapter: runtimeAdapter({ onSpawn: () => { spawns += 1; } }),
    }));
    expect(result).toMatchObject({ outcome: 'continue', stage: 'executor_profile', observedCause: cause });
    expect(worktrees).toBe(0); expect(spawns).toBe(0);
  });

  it('pins Cursor spawn context without changing catalog identity', () => {
    const resolved = resolveSemanticExecutorProfile({
      surface: 'task',
      names: profileNamesForTask('t2'),
      env: profileEnv({ PACK_EXECUTOR_CURSOR_CONTEXT: '272k' }),
    });
    if (!resolved.ok) throw new Error('Cursor profile should resolve');
    expect(catalogIdentityForProfile(resolved.profile)).toBe('model-medium');
    expect(buildExecutorCommand(resolved.profile)).toMatchObject({
      executable: 'cursor-agent',
      modelArgument: 'model[context=272k,reasoning=medium,fast=false]',
      command: "cursor-agent --model 'model[context=272k,reasoning=medium,fast=false]'",
    });
    expect(buildProviderInvocation(resolved.profile)).toEqual({
      orcaAgent: 'cursor',
      argv: ['--agent', 'cursor', '--model', 'model[context=272k,reasoning=medium,fast=false]'],
    });
  });

  it('keeps the legacy Cursor spawn identity when context is unset', () => {
    const resolved = resolveSemanticExecutorProfile({
      surface: 'task',
      names: profileNamesForTask('t2'),
      env: profileEnv(),
    });
    if (!resolved.ok) throw new Error('Cursor profile should resolve');
    expect(buildExecutorCommand(resolved.profile).modelArgument).toBe('model-medium');
    expect(buildProviderInvocation(resolved.profile)?.argv).toEqual(['--agent', 'cursor', '--model', 'model-medium']);
  });

  it('ignores Cursor context settings for OpenCode profiles', () => {
    const withoutContext = resolveSemanticExecutorProfile({
      surface: 'task',
      names: profileNamesForTask('t2'),
      env: opencodeProfileEnv('t2'),
    });
    const withContext = resolveSemanticExecutorProfile({
      surface: 'task',
      names: profileNamesForTask('t2'),
      env: { ...opencodeProfileEnv('t2'), PACK_EXECUTOR_CURSOR_CONTEXT: '272k' },
    });
    if (!withoutContext.ok || !withContext.ok) throw new Error('OpenCode profile should resolve');
    expect(withContext.profile).toEqual(withoutContext.profile);
    const contextual = buildExecutorCommand(withContext.profile);
    const ordinary = buildExecutorCommand(withoutContext.profile);
    expect(contextual.executable).toBe(ordinary.executable);
    expect(contextual.agentName).not.toBe(ordinary.agentName);
    expect(JSON.parse(contextual.inlineConfigJson ?? '{}').permission).toEqual(JSON.parse(ordinary.inlineConfigJson ?? '{}').permission);
  });
  it.each([
    ['manager', 'task', profileNamesForTask('manager')],
    ['t1', 'task', profileNamesForTask('t1')],
    ['t2', 'task', profileNamesForTask('t2')],
    ['t3', 'task', profileNamesForTask('t3')],
    ['firefighter-manager', 'task', profileNamesForTask('manager')],
    ['routine-smoke', 'smoke', profileNamesForSmoke('routine')],
    ['complex-smoke', 'smoke', profileNamesForSmoke('complex')],
  ] as const)('emits global and agent browser and .env read denies in OpenCode JSON for %s', (_name, surface, names) => {
    const resolved = resolveSemanticExecutorProfile({
      surface,
      names,
      env: { [names[0]]: 'opencode', [names[1]]: 'fixture/provider-model', [names[2]]: 'high' },
    });
    if (!resolved.ok) throw new Error('synthetic OpenCode profile should resolve');
    const invocation = buildExecutorCommand(resolved.profile);
    const agentName = invocation.agentName ?? '';
    const config = JSON.parse(invocation.inlineConfigJson ?? '{}') as {
      permission?: { bash?: Record<string, string>; skill?: Record<string, string>; read?: Record<string, string> };
      agent?: Record<string, Record<string, unknown>>;
    };
    const agent = config.agent?.[agentName];
    const bashDenies = {
      bsk: 'deny', 'bsk *': 'deny', '/bsk': 'deny', '/bsk *': 'deny',
      '/*/bsk': 'deny', '/*/bsk *': 'deny', '~?bsk': 'deny', '~?bsk *': 'deny',
      '~?*/bsk': 'deny', '~?*/bsk *': 'deny', 'env bsk': 'deny', 'env bsk *': 'deny',
    };
    expect(agentName).toMatch(/^pack-opk-[a-f0-9]{32}$/u);
    expect(config.agent).not.toHaveProperty('pack');
    expect(config.permission).toEqual({ bash: bashDenies, skill: { 'browser-skill': 'deny' }, read: { '*.env': 'deny', '*.env.*': 'deny' } });
    expect(agent).toMatchObject({
      model: 'fixture/provider-model',
      variant: 'high',
      permission: config.permission,
    });
    expect(config.agent?.general?.permission).toEqual(config.permission);
    expect(config.agent?.explore?.permission).toEqual(config.permission);
    expect(invocation.command).toContain(`OPENCODE_CONFIG_CONTENT='${invocation.inlineConfigJson}'`);
    expect(invocation.command).toContain(`--agent '${agentName}'`);
  });

  it('keeps the browser deny in generated unit config, not fleet service or global-config transport', () => {
    const resolved = resolveSemanticExecutorProfile({
      surface: 'task', names: profileNamesForTask('t2'), env: opencodeProfileEnv('t2'),
    });
    if (!resolved.ok) throw new Error('synthetic OpenCode profile should resolve');
    const invocation = buildExecutorCommand(resolved.profile);
    const config = JSON.parse(invocation.inlineConfigJson ?? '{}') as Record<string, unknown>;
    const fleetService = readFileSync(new URL('../fleet/fleet-wake@.service', import.meta.url), 'utf8');
    const fleetEnvironment = readFileSync(new URL('../fleet/fleet-wake.env.example', import.meta.url), 'utf8');
    expect(Object.keys(config).sort()).toEqual(['agent', 'permission']);
    expect(invocation.command.match(/OPENCODE_CONFIG_CONTENT=/gu)).toHaveLength(1);
    expect(invocation.command).not.toContain('--config');
    expect(invocation.command).not.toMatch(/fleet-wake|systemctl/iu);
    expect(`${fleetService}\n${fleetEnvironment}`).not.toMatch(/OPENCODE_CONFIG_CONTENT|browser-skill|\bbsk\b/iu);
  });


  it.each(['manager', 't1', 't2', 't3'] as const)('closed two-family mapping recognizes OpenCode for %s without inventing a route', (workClass) => {
    const result = resolveExecutorProfile(workClass, opencodeProfileEnv(workClass));
    expect(result).toMatchObject({
      status: 'continue', cause: 'executor_route_unavailable', evidence: { executorFamily: 'opencode' },
    });
  });

  it('checks live cursor model applicability before any follow-up child action', async () => {
    const calls: string[][] = [];
    const result = await resolveLiveExecutorProfile('t2', profileEnv(), undefined, async (args) => {
      calls.push([...args]);
      return { ok: true, stdout: 'other-model-low\n' };
    });
    expect(result).toMatchObject({ status: 'continue', cause: 'executor_profile_model_unavailable' });
    expect(calls).toEqual([['cursor-agent', '--list-models']]);
  });

  it('keeps Cursor route admission static and separate from catalog applicability', async () => {
    const calls: string[][] = [];
    const result = await resolveLiveExecutorProfile('t2', profileEnv(), undefined, async (args) => {
      calls.push([...args]);
      if (args[0] === 'cursor-agent') return { ok: true, stdout: 'model-medium\n' };
      return { ok: true, stdout: '' };
    });
    expect(result).toMatchObject({ status: 'ok', value: { family: 'cursor', route: 'provider_new_top_level' } });
    expect(calls[0]).toEqual(['cursor-agent', '--list-models']);
    expect(calls.some((args) => args[0] === 'orca' && args.includes('--help'))).toBe(false);
  });

  it('OpenCode exact-terminal admission depends only on route-specific evidence', async () => {
    const env = opencodeProfileEnv('t2');
    const admittedCalls: string[][] = [];
    const admitted = await resolveLiveExecutorProfile('t2', env, undefined, async (args) => {
      admittedCalls.push([...args]);
      if (args[0] === 'orca') return { ok: false, stdout: '' };
      return opencodeProbeResult(args, true);
    });
    expect(admitted).toMatchObject({
      status: 'ok',
      value: { family: 'opencode', route: 'exact_terminal_worktree' },
    });
    if (admitted.status !== 'ok') throw new Error('synthetic OpenCode route should admit');
    const launchJson = admitted.value.launchCommand.match(/OPENCODE_CONFIG_CONTENT='([^']+)'/u)?.[1];
    const launchConfig = JSON.parse(launchJson ?? '{}') as {
      permission?: Record<string, unknown>;
      agent?: Record<string, { model: string; variant: string; permission: unknown }>;
    };
    const agentName = Object.keys(launchConfig.agent ?? {})[0] ?? '';
    expect(agentName).toMatch(/^pack-opk-[a-f0-9]{32}$/u);
    expect(admitted.value.launchCommand).toContain(`--agent '${agentName}'`);
    expect(launchConfig.agent?.[agentName]).toMatchObject({
      model: 'fixture-opencode-model', variant: 'fixture-opencode-effort', permission: launchConfig.permission,
    });
    expect(launchConfig.permission).toMatchObject({ skill: { 'browser-skill': 'deny' } });
    expect(launchConfig.permission?.bash).toHaveProperty('bsk *', 'deny');
    expect(admittedCalls[0]).toEqual(['opencode', 'models']);
    expect(admittedCalls).toContainEqual(['opencode', '--help']);
    expect(admittedCalls).toContainEqual(['opencode', 'models', '--verbose']);
    expect(admittedCalls.some((args) => args[0] === 'opencode' && args[1] === 'debug')).toBe(false);
    expect(admittedCalls.some((args) => args[0] === 'orca')).toBe(false);

    const unsupportedEffort = await resolveLiveExecutorProfile('t2', {
      ...env,
      PACK_EXECUTOR_T2_EFFORT: 'fixture-opencode-unsupported-effort',
    }, undefined, async (args) => opencodeProbeResult(args, true));
    expect(unsupportedEffort).toMatchObject({ status: 'continue', cause: 'executor_effort_channel_unavailable' });

    const gated = await resolveLiveExecutorProfile('t2', env, undefined, async (args) => opencodeProbeResult(args, false));
    expect(gated).toMatchObject({ status: 'ok' });

    const mismatch = await resolveLiveExecutorProfile('t2', env, 'provider_new_top_level', async (args) => opencodeProbeResult(args, true));
    expect(mismatch).toMatchObject({ status: 'continue', cause: 'executor_route_mismatch' });
  });

  it('refuses contextual Config/Agent probes before any no-write proof', async () => {
    const resolved = await resolveLiveExecutorProfile('t2', opencodeProfileEnv('t2'), undefined, async (args) => opencodeProbeResult(args, true));
    if (resolved.status !== 'ok') throw new Error('fixture profile should resolve');
    const calls: string[][] = [];
    const result = await finalizeOpenCodeExecutorProfile(resolved.value, '/tmp/exact-worktree', async (args) => {
      calls.push([...args]);
      return { ok: true, stdout: '{}', stderr: '' };
    });
    expect(result).toMatchObject({ status: 'continue', cause: 'executor_effort_channel_unavailable' });
    expect(calls).toEqual([]);
  });

  it.each([
    ['real 1.18.35 normal-config TO-only ordering', 'none', true, 'home'],
    ['tilde runtime allow, only TO moved', 'none', true, 'tilde'],
    ['isolated XDG data-home runtime allow, only TO moved', 'none', true, 'data'],
    ['isolated XDG data-home inherited action drift', 'inherited-drift', false, 'data'],
    ['isolated XDG data-home tool-output action drift', 'changed-action', false, 'data'],
    ['isolated XDG data-home tool-output path drift', 'changed-path', false, 'data'],
    ['foreign XDG data home cannot excuse permission reordering', 'none', false, 'foreign-data'],
    ['unrelated rule reordering', 'other-order', false, 'home'],
    ['an extra allow', 'extra-allow', false, 'home'],
    ['an unchanged inherited external-directory allow', 'inherited-allow', true, 'home'],
    ['a changed inherited external-directory allow', 'inherited-drift', false, 'home'],
    ['a missing deny', 'missing-deny', false, 'home'],
    ['a non-terminal deny', 'non-terminal-deny', false, 'home'],
    ['a changed tool-output action', 'changed-action', false, 'home'],
    ['a changed tool-output path', 'changed-path', false, 'home'],
    ['an unrelated home path', 'none', false, 'foreign'],
    ['model drift', 'model', false, 'home'],
    ['option drift', 'options', false, 'home'],
  ] as const)('contextual tool-output order regression: %s', async (_label, drift, accepted, pathKind) => {
    type FixtureRule = { permission: string; pattern: string; action: string };
    type FixtureAgent = {
      name: string; mode: string; prompt: string; description?: string;
      model: { providerID: string; modelID: string }; variant: string;
      options: Record<string, unknown>; permission: FixtureRule[];
    };
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/opencode-1.18.35-tool-output-order.json', import.meta.url), 'utf8')) as {
      baseline: FixtureAgent; contextual: FixtureAgent;
    };
    // Preserve the historical raw fixture; project the new read policy only in test memory.
    const withSyntheticReadDenies = (rules: FixtureRule[]): FixtureRule[] => {
      const remaining = rules.filter((rule) => rule.permission !== 'read'
        || (rule.pattern !== '*.env' && rule.pattern !== '*.env.*'));
      const lastReadIndex = remaining.findLastIndex((rule) => rule.permission === 'read');
      return [
        ...remaining.slice(0, lastReadIndex + 1),
        { permission: 'read', pattern: '*.env', action: 'deny' },
        { permission: 'read', pattern: '*.env.*', action: 'deny' },
        ...remaining.slice(lastReadIndex + 1),
      ];
    };
    const selectedDataRoot = join(tmpdir(), 'opk2447-synthetic-xdg-data');
    const runtimePattern = pathKind === 'tilde' ? '~/.local/share/opencode/tool-output/*'
      : pathKind === 'data' || pathKind === 'foreign-data'
        ? join(selectedDataRoot, 'opencode', 'tool-output', '*')
        : pathKind === 'foreign' ? join(homedir(), 'unrelated-home', '.local', 'share', 'opencode', 'tool-output', '*')
          : join(homedir(), '.local', 'share', 'opencode', 'tool-output', '*');
    const toolOutput = { permission: 'external_directory', pattern: runtimePattern, action: 'allow' };
    for (const agent of [fixture.baseline, fixture.contextual]) {
      for (const rule of agent.permission) {
        if (rule.permission === 'external_directory' && rule.pattern === '<home>/.local/share/opencode/tool-output/*') {
          rule.pattern = runtimePattern;
        }
      }
    }
    // Replay exactly the 104 raw baseline tuples and 97 contextual canonical
    // tuples supplied by OpenCode 1.18.35 (no Hn alignment or sorting).
    expect(fixture.baseline.permission).toHaveLength(104);
    expect(fixture.contextual.permission).toHaveLength(97);
    expect(fixture.baseline.permission[3]).toEqual(toolOutput);
    expect(fixture.baseline.permission[103]).toEqual(toolOutput);
    expect(fixture.contextual.permission[96]).toEqual(toolOutput);
    expect(fixture.contextual.permission.slice(4, 73)).toEqual(fixture.baseline.permission.slice(5, 74));

    const baselineCanonical = openCodeAgentConfigFromInfo(fixture.baseline).permission;
    const legacyExpected = withOpenCodeFleetBrowserDenies(baselineCanonical);
    const legacyRules = Object.entries(legacyExpected).flatMap(([permission, rules]) =>
      typeof rules === 'string' ? [{ permission, pattern: '*', action: rules }]
        : typeof rules === 'object' && rules !== null
          ? Object.entries(rules).map(([pattern, action]) => ({ permission, pattern, action: String(action) }))
          : []);
    expect(legacyRules).toHaveLength(97);
    expect(legacyRules[3]).toEqual(toolOutput);
    const withoutToolOutput = legacyRules.filter((rule) =>
      !(rule.permission === toolOutput.permission && rule.pattern === toolOutput.pattern && rule.action === toolOutput.action));
    // Only the two new read overrides may differ from the captured 1.18.35 ordering.
    const contextualWithReadDenies = withSyntheticReadDenies(fixture.contextual.permission);
    expect(withoutToolOutput).toEqual(contextualWithReadDenies.slice(0, -1));
    expect(openCodeAgentSemantics({ ...fixture.baseline, permission: legacyExpected }))
      .not.toBe(openCodeAgentSemantics(fixture.contextual));
    expect(openCodeAgentSemantics({ ...fixture.baseline, permission: [...withoutToolOutput, toolOutput] }))
      .toBe(openCodeAgentSemantics({ ...fixture.contextual, permission: contextualWithReadDenies }));
    if (drift === 'inherited-allow') {
      const inherited = { permission: 'external_directory', pattern: '~/already-allowed/*', action: 'allow' };
      const baselineIndex = fixture.baseline.permission.findIndex((rule) => rule.permission === 'question');
      const contextualIndex = fixture.contextual.permission.findIndex((rule) => rule.permission === 'question');
      fixture.baseline.permission.splice(baselineIndex, 0, inherited);
      fixture.contextual.permission.splice(contextualIndex, 0, { ...inherited });
    }

    const sandbox = mkdtempSync(join(tmpdir(), 'opk2447-offline-'));
    vi.stubEnv('XDG_CONFIG_HOME', sandbox);
    vi.stubEnv('OPENCODE_CONFIG_DIR', join(sandbox, 'opencode'));
    vi.stubEnv('OPENCODE_CONFIG', join(sandbox, 'synthetic.json'));
    if (pathKind === 'data' || pathKind === 'foreign-data') vi.stubEnv('XDG_DATA_HOME', selectedDataRoot);
    const dataRoot = pathKind === 'data' ? selectedDataRoot
      : pathKind === 'foreign-data' ? join(tmpdir(), 'opk2447-unselected-xdg-data') : undefined;
    try {
      const env = profileEnv({
        PACK_EXECUTOR_T2_AGENT: 'opencode',
        PACK_EXECUTOR_T2_MODEL: 'gpt-6-luna',
        PACK_EXECUTOR_T2_EFFORT: 'medium',
      });
      const profile = await resolveLiveExecutorProfile('t2', env, undefined, async (args) => {
        const probe = opencodeProbeResult(args);
        return { ...probe, stdout: probe.stdout.replaceAll('fixture-opencode-model', 'gpt-6-luna')
          .replaceAll('fixture-opencode-effort', 'medium') };
      });
      if (profile.status !== 'ok') throw new Error('fixture model/variant should resolve');

      const result = await finalizeOpenCodeExecutorProfile(profile.value, join(sandbox, 'worktree'),
        async (args, _timeoutMs, envOverride) => {
          if (args[2] === 'config') return { ok: true, stdout: JSON.stringify({ default_agent: 'build' }), stderr: '' };
          if (args[2] === 'paths') return { ok: true, stdout: envOverride?.XDG_STATE_HOME ?? '', stderr: '' };
          if (args[2] === 'agent' && args[3] === 'build' && !envOverride?.OPENCODE_CONFIG_CONTENT) {
            return { ok: true, stdout: JSON.stringify(fixture.baseline), stderr: '' };
          }
          if (args[2] === 'agent') {
            const name = args[3] ?? '';
            const resolved = JSON.parse(JSON.stringify(fixture.contextual)) as FixtureAgent;
            resolved.name = name;
            resolved.permission = withSyntheticReadDenies(resolved.permission);
            if (name !== 'general' && name !== 'explore') {
              if (drift === 'other-order') {
                const question = resolved.permission.findIndex((rule) => rule.permission === 'question');
                const planEnter = resolved.permission.findIndex((rule) => rule.permission === 'plan_enter');
                if (question >= 0 && planEnter >= 0) {
                  [resolved.permission[question], resolved.permission[planEnter]] =
                    [resolved.permission[planEnter]!, resolved.permission[question]!];
                }
              }
              if (drift === 'extra-allow') {
                resolved.permission.push({ permission: 'external_directory', pattern: '~/unrelated/*', action: 'allow' });
              }
              if (drift === 'inherited-drift') {
                const inherited = resolved.permission.find((rule) =>
                  rule.permission === 'external_directory' && rule.pattern === '<home>/redacted-2/*');
                if (inherited) inherited.action = 'deny';
              }
              if (drift === 'missing-deny') {
                resolved.permission = resolved.permission.filter((rule) => !(rule.permission === 'bash' && rule.pattern === 'bsk *'));
              }
              if (drift === 'non-terminal-deny') {
                resolved.permission.push({ permission: 'bash', pattern: '*', action: 'allow' });
              }
              if (drift === 'changed-action' || drift === 'changed-path') {
                const rule = resolved.permission.find((item) => item.permission === toolOutput.permission && item.pattern === toolOutput.pattern);
                if (rule) {
                  if (drift === 'changed-action') rule.action = 'ask';
                  else rule.pattern = join(homedir(), '.local', 'share', 'opencode', 'unrelated-output', '*');
                }
              }
              if (drift === 'model') resolved.model.modelID = 'different-model';
              if (drift === 'options') resolved.options = { ...resolved.options, extra: true };
            }
            return { ok: true, stdout: JSON.stringify(resolved), stderr: '' };
          }
          return { ok: false, stdout: '', stderr: 'unexpected fixture probe' };
        }, () => true, undefined, dataRoot);
      expect(result).toMatchObject(accepted
        ? { status: 'ok', evidence: { exactContext: true } }
        : { status: 'continue', cause: 'executor_effort_channel_unavailable' });
      if (pathKind === 'data' && accepted) {
        if (result.status !== 'ok') throw new Error('selected XDG data-home semantics must resolve');
        expect(result.value.launchCommand).toContain(` XDG_DATA_HOME='${selectedDataRoot}' opencode --hostname`);
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('accepts contextual OpenCode probes after a no-write proof', async () => {
    const resolved = await resolveLiveExecutorProfile('t2', opencodeProfileEnv('t2'), undefined, async (args) => opencodeProbeResult(args, true));
    if (resolved.status !== 'ok') throw new Error('fixture profile should resolve');
    const calls: string[][] = [];
    const result = await finalizeOpenCodeExecutorProfile(resolved.value, '/tmp/exact-worktree', async (args, _timeoutMs, envOverride) => {
      calls.push([...args]);
      if (args[1] === 'debug' && args[2] === 'config') {
        return { ok: true, stdout: JSON.stringify({ default_agent: 'build' }), stderr: '' };
      }
      if (args[1] === 'debug' && args[2] === 'agent') {
        const name = args[3] ?? '';
        const baseline = {
          name: 'build', prompt: 'fixture', mode: 'primary', topP: 0.8,
          model: { providerID: 'opencode', modelID: 'fixture-opencode-model' },
          variant: 'fixture-opencode-effort',
          permission: [
            { permission: 'bash', pattern: '*', action: 'allow' },
            { permission: 'skill', pattern: '*', action: 'allow' },
          ],
        };
        if (name === 'build' && !envOverride?.OPENCODE_CONFIG_CONTENT) {
          return { ok: true, stdout: JSON.stringify(baseline), stderr: '' };
        }
        const overlay = JSON.parse(envOverride?.OPENCODE_CONFIG_CONTENT ?? '{}') as {
          permission?: Record<string, string | Record<string, string>>;
          agent?: Record<string, { permission?: Record<string, string | Record<string, string>> }>;
        };
        const flatten = (permissions?: Record<string, string | Record<string, string>>) => Object.entries(permissions ?? {}).flatMap(([permission, patterns]) =>
          typeof patterns === 'string'
            ? [{ permission, pattern: '*', action: patterns }]
            : Object.entries(patterns).map(([pattern, action]) => ({ permission, pattern, action })));
        const effective = [
          ...baseline.permission,
          ...flatten(overlay.permission),
          ...flatten(overlay.agent?.[name]?.permission),
        ];
        return {
          ok: true,
          stdout: JSON.stringify({
            ...baseline, name, permission: effective,
            model: { providerID: 'opencode', modelID: 'fixture-opencode-model' },
          }),
          stderr: '',
        };
      }
      if (args[1] === 'debug' && args[2] === 'paths') {
        return { ok: true, stdout: envOverride?.XDG_STATE_HOME ?? '', stderr: '' };
      }
      return { ok: false, stdout: '', stderr: '' };
    }, () => true);
    expect(result).toMatchObject({ status: 'ok', evidence: { exactContext: true } });
    expect(calls).toContainEqual(['opencode', 'debug', 'config']);
    expect(calls.filter((args) => args[1] === 'debug' && args[2] === 'agent')).toHaveLength(4);
    expect(calls).toContainEqual(['opencode', 'debug', 'agent', 'general']);
    expect(calls).toContainEqual(['opencode', 'debug', 'agent', 'explore']);
    expect(calls).toContainEqual(['opencode', 'debug', 'paths']);
  });
  it('probe surface equals spawn surface', async () => {
    const profile = resolveSemanticExecutorProfile({ surface: 'task', names: profileNamesForTask('t2'), env: opencodeProfileEnv('t2') });
    if (!profile.ok) throw new Error('semantic profile should be ok');
    const invocation = buildExecutorCommand(profile.profile);
    expect(invocation.command).toContain(`--agent '${invocation.agentName}'`);
    expect(invocation.command).not.toContain('--model');
    expect(invocation.command).not.toContain('--variant');
    expect(invocation.inlineConfigJson).toContain('"model":"fixture-opencode-model"');
    expect(invocation.inlineConfigJson).toContain('"variant":"fixture-opencode-effort"');
    const probes = EXECUTOR_FAMILY_DESCRIPTORS.opencode.capabilityProbeCommands;
    expect(probes.length).toBe(2);
    for (const probe of probes) {
      const probeStr = probe.join(' ');
      expect(probeStr).not.toMatch(/\brun\b/);
      expect(['--help', 'models', 'debug'].some((k) => probeStr.includes(k))).toBe(true);
    }
    expect(probes).toContainEqual(['opencode', '--help']);
    expect(probes).toContainEqual(['opencode', 'models', '--verbose']);
    expect(probes.some((probe) => probe[1] === 'debug')).toBe(false);
    expect(invocation.command).toContain('opencode');
    expect(probes[0]?.join(' ')).toContain('opencode');
  });

  it('projects resolved Agent.Info into a config-valid baseline overlay with terminal browser denies', () => {
    const invocation = buildOpenCodeAgentOverlay({
      agentName: 'pack-opk-fixture',
      baseline: {
        name: 'build', native: true, mode: 'primary', topP: 0.8,
        prompt: 'fixture prompt', options: { temperature: 0.2 },
        permission: [
          { permission: 'edit', pattern: '*', action: 'allow' },
          { permission: 'bash', pattern: '*', action: 'ask' },
        ],
      },
      model: 'fixture/provider-model', effort: 'high',
    });
    const config = JSON.parse(invocation.inlineConfigJson ?? '{}') as {
      permission?: Record<string, unknown>;
      agent?: Record<string, Record<string, unknown>>;
    };
    const agent = config.agent?.['pack-opk-fixture'];
    expect(config.permission).toEqual({
      bash: {
        bsk: 'deny', 'bsk *': 'deny', '/bsk': 'deny', '/bsk *': 'deny',
        '/*/bsk': 'deny', '/*/bsk *': 'deny', '~?bsk': 'deny', '~?bsk *': 'deny',
        '~?*/bsk': 'deny', '~?*/bsk *': 'deny', 'env bsk': 'deny', 'env bsk *': 'deny',
      },
      skill: { 'browser-skill': 'deny' },
      read: { '*.env': 'deny', '*.env.*': 'deny' },
    });
    expect(config.agent?.general?.permission).toEqual(config.permission);
    expect(config.agent?.explore?.permission).toEqual(config.permission);
    expect(agent).toMatchObject({
      model: 'fixture/provider-model', variant: 'high', mode: 'primary',
      top_p: 0.8, prompt: 'fixture prompt',
    });
    expect(agent?.permission).toMatchObject({
      edit: 'allow',
      bash: {
        '*': 'ask',
        bsk: 'deny', 'bsk *': 'deny', '/bsk': 'deny', '/bsk *': 'deny',
        '/*/bsk': 'deny', '/*/bsk *': 'deny', '~?bsk': 'deny', '~?bsk *': 'deny',
        '~?*/bsk': 'deny', '~?*/bsk *': 'deny', 'env bsk': 'deny', 'env bsk *': 'deny',
      },
      skill: { 'browser-skill': 'deny' },
      read: { '*.env': 'deny', '*.env.*': 'deny' },
    });
    expect(openCodeFleetBrowserDenyRulesAreTerminal(agent?.permission)).toBe(true);
    expect(agent).not.toHaveProperty('native');
    expect(agent).not.toHaveProperty('name');
    expect(openCodeAgentSemantics({ ...agent, name: 'pack-opk-fixture', model: { providerID: 'fixture', modelID: 'provider-model' }, variant: 'high', native: false }))
      .toBe(openCodeAgentSemantics({ name: 'build', native: true, mode: 'primary', topP: 0.8, prompt: 'fixture prompt', options: { temperature: 0.2 }, permission: agent?.permission }));
  });


  it('appends precise browser denies after inherited allows without changing other permissions', () => {
    const invocation = buildOpenCodeAgentOverlay({
      agentName: 'pack-opk-fixture',
      baseline: {
        name: 'build', prompt: 'original prompt', mode: 'primary',
        permission: [
          { permission: 'bash', pattern: 'bsk*', action: 'allow' },
          { permission: 'bash', pattern: 'git *', action: 'allow' },
          { permission: 'bash', pattern: '*', action: 'allow' },
          { permission: 'skill', pattern: 'browser-skill', action: 'allow' },
          { permission: 'skill', pattern: 'fixture-safe', action: 'allow' },
          { permission: 'skill', pattern: '*', action: 'allow' },
          { permission: 'edit', pattern: '*', action: 'allow' },
          { permission: 'read', pattern: '*', action: 'allow' },
          { permission: 'read', pattern: '*.env', action: 'ask' },
          { permission: 'read', pattern: '*.env.*', action: 'ask' },
          { permission: 'read', pattern: '*.env.example', action: 'allow' },
          { permission: 'read', pattern: 'README.md', action: 'allow' },
        ],
      },
      model: 'fixture/provider-model', effort: 'high',
    });
    const parsed = JSON.parse(invocation.inlineConfigJson ?? '{}') as {
      permission?: Record<string, Record<string, unknown>>;
      agent: Record<string, {
        model: string; variant: string; prompt: string;
        permission: { bash: Record<string, unknown>; skill: Record<string, unknown>; read: Record<string, string>; edit: string };
      }>
    };
    const agent = parsed.agent['pack-opk-fixture']!;
    const deniedBash = [
      'bsk', 'bsk *', '/bsk', '/bsk *', '/*/bsk', '/*/bsk *',
      '~?bsk', '~?bsk *', '~?*/bsk', '~?*/bsk *', 'env bsk', 'env bsk *',
    ];
    expect(agent.model).toBe('fixture/provider-model');
    expect(agent.variant).toBe('high');
    expect(agent.prompt).toBe('original prompt');
    expect(Object.entries(agent.permission.bash).slice(-12)).toEqual(deniedBash.map((pattern) => [pattern, 'deny']));
    expect(agent.permission.bash).toMatchObject({ 'bsk*': 'allow', 'git *': 'allow', '*': 'allow' });
    expect(agent.permission.skill).toEqual({ 'fixture-safe': 'allow', '*': 'allow', 'browser-skill': 'deny' });
    expect(agent.permission.edit).toBe('allow');
    const readRules = Object.entries(agent.permission.read);
    expect(readRules).toEqual([
      ['*', 'allow'],
      ['*.env.example', 'allow'],
      ['README.md', 'allow'],
      ['*.env', 'deny'],
      ['*.env.*', 'deny'],
    ]);
    const matchingReadRule = (path: string) => readRules.filter(([pattern]) =>
      new RegExp('^' + pattern.replaceAll('.', '\\.').replaceAll('*', '.*') + '$', 'u').test(path)).at(-1);
    for (const path of ['.env', 'sub/.env', '.env.local', 'sub/.env.local', 'sub/.env.example']) {
      expect(matchingReadRule(path)?.[1]).toBe('deny');
    }
    expect(matchingReadRule('README.md')).toEqual(['README.md', 'allow']);
    expect(parsed.permission).toEqual({
      bash: Object.fromEntries(deniedBash.map((pattern) => [pattern, 'deny'])),
      skill: { 'browser-skill': 'deny' },
      read: { '*.env': 'deny', '*.env.*': 'deny' },
    });
    expect(openCodeFleetBrowserDenyRulesAreTerminal(agent.permission)).toBe(true);
  });


  it.each([
    ['unchanged', true],
    ['prompt', false],
    ['edit', false],
    ['bash', false],
    ['bash-order', false],
    ['skill', false],
    ['missing-read-deny', false],
    ['non-terminal-read-deny', false],
    ['subagent-read-deny', false],
    ['subagent-bash', false],
    ['subagent-skill', false],
    ['model', false],
    ['effort', false],
  ] as const)('contextual finalization permits only the intended narrowed policy: %s', async (drift, accepted) => {
    const sandbox = mkdtempSync(join(tmpdir(), 'opk2437-offline-'));
    vi.stubEnv('XDG_CONFIG_HOME', sandbox);
    vi.stubEnv('OPENCODE_CONFIG_DIR', join(sandbox, 'opencode'));
    vi.stubEnv('OPENCODE_CONFIG', join(sandbox, 'synthetic.json'));
    try {
      const profile = await resolveLiveExecutorProfile('t2', opencodeProfileEnv('t2'), undefined, async (args) => opencodeProbeResult(args));
      if (profile.status !== 'ok') throw new Error('synthetic OpenCode profile should resolve');
      const baseline = {
        name: 'build', mode: 'primary', prompt: 'original prompt', topP: 0.8,
        options: { temperature: 0.2 },
        model: { providerID: 'opencode', modelID: 'fixture-opencode-model' },
        variant: 'fixture-opencode-effort',
        permission: [
          { permission: 'edit', pattern: '*', action: 'allow' },
          { permission: 'bash', pattern: 'bsk*', action: 'allow' },
          { permission: 'bash', pattern: '*', action: 'allow' },
          { permission: 'skill', pattern: 'browser-skill', action: 'allow' },
          { permission: 'skill', pattern: '*', action: 'allow' },
        ],
      };
      type SyntheticRule = { permission: string; pattern: string; action: string };
      const flatten = (permission?: Record<string, unknown>): SyntheticRule[] => Object.entries(permission ?? {}).flatMap(([scope, patterns]) =>
        typeof patterns === 'string'
          ? [{ permission: scope, pattern: '*', action: patterns }]
          : patterns && typeof patterns === 'object'
            ? Object.entries(patterns).map(([pattern, action]) => ({ permission: scope, pattern, action: String(action) }))
            : []);
      const baselineRules: SyntheticRule[] = baseline.permission;
      const result = await finalizeOpenCodeExecutorProfile(profile.value, join(sandbox, 'worktree'),
        async (args, _timeoutMs, envOverride) => {
          if (args[2] === 'config') return { ok: true, stdout: JSON.stringify({ default_agent: 'build' }), stderr: '' };
          if (args[2] === 'paths') return { ok: true, stdout: envOverride?.XDG_STATE_HOME ?? '', stderr: '' };
          if (args[2] === 'agent' && args[3] === 'build') return { ok: true, stdout: JSON.stringify(baseline), stderr: '' };
          if (args[2] === 'agent') {
            const name = args[3] ?? '';
            const inline = JSON.parse(envOverride?.OPENCODE_CONFIG_CONTENT ?? '{}') as {
              permission?: Record<string, unknown>;
              agent?: Record<string, { permission?: Record<string, unknown> }>;
            };
            const isChild = name === 'general' || name === 'explore';
            const globalRules = flatten(inline.permission);
            const agentRules = flatten(inline.agent?.[name]?.permission);
            if (drift === 'bash-order' && !isChild) {
              const denyIndex = agentRules.findIndex((rule) => rule.permission === 'bash' && rule.pattern === 'bsk *');
              const wildcardIndex = agentRules.findIndex((rule) => rule.permission === 'bash' && rule.pattern === '*' && rule.action !== 'deny');
              if (denyIndex >= 0 && wildcardIndex >= 0 && denyIndex > wildcardIndex) {
                const [deny] = agentRules.splice(denyIndex, 1);
                agentRules.splice(wildcardIndex, 0, deny!);
              }
            }
            const removeOne = (source: SyntheticRule[], scope: string, pattern: string) => {
              const index = source.findIndex((rule) => rule.permission === scope && rule.pattern === pattern);
              if (index >= 0) source.splice(index, 1);
            };
            if (drift === 'bash' && !isChild) {
              removeOne(globalRules, 'bash', 'bsk *');
              removeOne(agentRules, 'bash', 'bsk *');
            }
            if (drift === 'skill' && !isChild) {
              removeOne(globalRules, 'skill', 'browser-skill');
              removeOne(agentRules, 'skill', 'browser-skill');
            }
            if (drift === 'missing-read-deny' && !isChild) {
              removeOne(globalRules, 'read', '*.env.*');
              removeOne(agentRules, 'read', '*.env.*');
            }
            if (drift === 'non-terminal-read-deny' && !isChild) {
              agentRules.push({ permission: 'read', pattern: '*', action: 'allow' });
            }
            if (drift === 'subagent-read-deny' && name === 'general') {
              removeOne(globalRules, 'read', '*.env.*');
              removeOne(agentRules, 'read', '*.env.*');
            }
            if (drift === 'subagent-bash' && name === 'general') {
              removeOne(globalRules, 'bash', 'bsk *');
              removeOne(agentRules, 'bash', 'bsk *');
            }
            if (drift === 'subagent-skill' && name === 'explore') {
              removeOne(globalRules, 'skill', 'browser-skill');
              removeOne(agentRules, 'skill', 'browser-skill');
            }
            const rules = [...baselineRules, ...globalRules, ...agentRules];
            if (drift === 'edit' && !isChild) {
              const edit = [...rules].reverse().find((rule) => rule.permission === 'edit');
              if (edit) edit.action = 'deny';
            }
            const resolved = {
              ...baseline, name, permission: rules,
              prompt: drift === 'prompt' ? 'changed prompt' : baseline.prompt,
              model: { providerID: 'opencode', modelID: drift === 'model' ? 'different-model' : 'fixture-opencode-model' },
              variant: drift === 'effort' ? 'other-effort' : 'fixture-opencode-effort',
            };
            return { ok: true, stdout: JSON.stringify(resolved), stderr: '' };
          }
          return { ok: false, stdout: '', stderr: 'unexpected synthetic probe' };
        }, () => true);
      expect(result.status).toBe(accepted ? 'ok' : 'continue');
      if (!accepted) expect(result).toMatchObject({ status: 'continue', cause: 'executor_effort_channel_unavailable' });
    } finally {
      vi.unstubAllEnvs();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('encodes duplicate star permission rules as a last-wins string action', () => {
    const config = openCodeAgentConfigFromInfo({
      mode: 'primary',
      permission: [
        { permission: 'question', pattern: '*', action: 'deny' },
        { permission: 'question', pattern: '*', action: 'allow' },
      ],
    });
    expect(config.permission).toEqual({ question: 'allow' });
  });

  it('keeps permission-rule order in overlay semantics because deny precedence is ordered', () => {
    const first = [
      { permission: 'edit', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: '*', action: 'ask' },
    ];
    const reversed = [...first].reverse();
    expect(openCodeAgentSemantics({ mode: 'primary', permission: first }))
      .not.toBe(openCodeAgentSemantics({ mode: 'primary', permission: reversed }));
  });

  it('agent config effort channel', async () => {
    const env = opencodeProfileEnv('t2');
    const admitted = await resolveLiveExecutorProfile('t2', env, undefined, async (args) => opencodeProbeResult(args, true));
    expect(admitted).toMatchObject({ status: 'ok' });
    const missingVariant = await resolveLiveExecutorProfile('t2', env, undefined, async (args) => opencodeProbeResult(args, false));
    expect(missingVariant).toMatchObject({ status: 'ok' });
    const differentVariant = await resolveLiveExecutorProfile('t2', env, undefined, async (args) => {
      if (args[0] === 'opencode' && args[1] === 'debug' && args[2] === 'agent') {
        return { ok: true, stdout: JSON.stringify({ model: { providerID: 'opencode', modelID: 'fixture-opencode-model' }, variant: 'different-effort' }), stderr: '' };
      }
      return opencodeProbeResult(args, true);
    });
    expect(differentVariant).toMatchObject({ status: 'ok' });
    const failedProbe = await resolveLiveExecutorProfile('t2', env, undefined, async (args) => {
      if (args[0] === 'opencode' && args[1] === 'debug' && args[2] === 'agent') return { ok: false, stdout: '', stderr: '' };
      return opencodeProbeResult(args, true);
    });
    expect(failedProbe).toMatchObject({ status: 'ok' });
  });

  it('production resolveProfile route-unavailable blocks manager Task and all later effects', async () => {
    let managerTaskCreates = 0;
    let worktrees = 0;
    let spawns = 0;
    let supervisedStarts = 0;
    const input: LaunchInput = {
      repository: 'chetwerikoff/orchestrator-pack', workClass: 'manager', runId: 'run-1', managerBrief: 'abstract brief',
      worktreeName: 'manager-worktree', env: opencodeProfileEnv('manager'),
    };
    const base = deps({
      onWorktree: () => { worktrees += 1; },
      onSupervised: () => { supervisedStarts += 1; },
      adapter: runtimeAdapter({ onSpawn: () => { spawns += 1; } }),
    });
    const result = await runSupervisedTaskLaunchAssistant(input, {
      ...base,
      resolveProfile: (workClass, env, startMode) => resolveLiveExecutorProfile(
        workClass,
        env,
        startMode,
        async (args) => {
          if (args[0] === 'opencode' && args.length === 2 && args[1] === '--help') {
            return { ok: true, stdout: 'Usage: opencode --variant NAME\n' };
          }
          return opencodeProbeResult(args, true);
        },
      ),
      createManagerTask: async () => {
        managerTaskCreates += 1;
        return { status: 'ok', value: { taskId: 'task-created', status: 'ready' } };
      },
    });
    expect(result).toMatchObject({
      outcome: 'continue', stage: 'executor_profile', observedCause: 'executor_route_unavailable',
    });
    expect(managerTaskCreates).toBe(0);
    expect(worktrees).toBe(0);
    expect(spawns).toBe(0);
    expect(supervisedStarts).toBe(0);
  });

  it('manager proves exact current Run before Task membership/effects', async () => {
    let worktrees = 0;
    const result = await runSupervisedTaskLaunchAssistant(launchInput('manager'), deps({
      managerRun: { status: 'ok', value: { runId: 'other-run' } }, onWorktree: () => { worktrees += 1; },
    }));
    expect(result).toMatchObject({ outcome: 'continue', stage: 'manager_run', observedCause: 'manager_run_mismatch' });
    if (result.outcome === 'continue') {
      expect(result.timings.at(-1)).toMatchObject({ stage: 'manager_run', outcome: 'continued' });
    }
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

  it('prepends the newline-terminated canonical manager preamble to a fresh manager brief', async () => {
    expect(MANAGER_PREAMBLE_FIXTURE.endsWith('\n')).toBe(true);
    expect(MANAGER_PREAMBLE_FIXTURE.endsWith('\n\n')).toBe(false);
    let createdBrief = '';
    await runSupervisedTaskLaunchAssistant({
      repository: 'chetwerikoff/orchestrator-pack',
      workClass: 'manager',
      runId: 'run-1',
      managerBrief: 'ordinary delta',
      worktreeName: 'manager-worktree',
      env: profileEnv(),
    }, deps({ onManagerCreate: (brief) => { createdBrief = brief; } }));
    expect(createdBrief).toBe(`${MANAGER_PREAMBLE_FIXTURE}\nordinary delta`);
  });

  it('leaves an exact newline-terminated manager preamble unchanged for ordinary work', async () => {
    expect(MANAGER_PREAMBLE_FIXTURE.match(/\bfirefighter\b/giu)).toHaveLength(2);
    const alreadyPrepared = `${MANAGER_PREAMBLE_FIXTURE}\nordinary delta`;
    let createdBrief = '';
    await runSupervisedTaskLaunchAssistant({
      repository: 'chetwerikoff/orchestrator-pack',
      workClass: 'manager',
      issueNumber: 2385,
      runId: 'run-1',
      managerBrief: alreadyPrepared,
      worktreeName: 'manager-worktree',
      env: profileEnv(),
    }, deps({
      managerIssueTitle: { status: 'ok', value: 'ordinary manager issue' },
      onManagerCreate: (brief) => { createdBrief = brief; },
    }));
    expect(createdBrief).toBe(alreadyPrepared);
  });

  it('inserts the newline-terminated firefighter prompt after an exact canonical manager preamble', async () => {
    expect(FIREFIGHTER_PROMPT_FIXTURE.endsWith('\n')).toBe(true);
    expect(FIREFIGHTER_PROMPT_FIXTURE.endsWith('\n\n')).toBe(false);
    const delta = 'firefighter repair launch';
    let createdBrief = '';
    await runSupervisedTaskLaunchAssistant({
      repository: 'chetwerikoff/orchestrator-pack',
      workClass: 'manager',
      runId: 'run-1',
      managerBrief: `${MANAGER_PREAMBLE_FIXTURE}\n${delta}`,
      worktreeName: 'manager-worktree',
      env: profileEnv(),
    }, deps({ onManagerCreate: (brief) => { createdBrief = brief; } }));
    expect(createdBrief).toBe(
      `${MANAGER_PREAMBLE_FIXTURE}\n${FIREFIGHTER_PROMPT_FIXTURE}\n${delta}`,
    );
  });

  it.each([
    ['heading trailing whitespace', MANAGER_PREAMBLE_FIXTURE.replace(
      '# Manager launch preamble',
      '# Manager launch preamble   ',
    )],
    ['CRLF preamble', MANAGER_PREAMBLE_FIXTURE.replaceAll('\n', '\r\n')],
    ['edited whitespace', MANAGER_PREAMBLE_FIXTURE.replace('Manager work', 'Manager  work')],
    ['older preamble body', OLDER_MANAGER_PREAMBLE_FIXTURE],
  ] as const)('passes an already-headed ordinary noncanonical manager brief through unchanged: %s', async (_label, preamble) => {
    let createdBrief = '';
    await runSupervisedTaskLaunchAssistant({
      repository: 'chetwerikoff/orchestrator-pack',
      workClass: 'manager',
      issueNumber: 2385,
      runId: 'run-1',
      managerBrief: `${preamble}\nordinary delta`,
      worktreeName: 'manager-worktree',
      env: profileEnv(),
    }, deps({
      managerIssueTitle: { status: 'ok', value: 'ordinary manager issue' },
      onManagerCreate: (brief) => { createdBrief = brief; },
    }));
    expect(createdBrief).toBe(`${preamble}\nordinary delta`);
  });

  it.each([
    ['heading trailing whitespace', MANAGER_PREAMBLE_FIXTURE.replace(
      '# Manager launch preamble',
      '# Manager launch preamble   ',
    )],
    ['CRLF preamble', MANAGER_PREAMBLE_FIXTURE.replaceAll('\n', '\r\n')],
    ['edited whitespace', MANAGER_PREAMBLE_FIXTURE.replace('Manager work', 'Manager  work')],
    ['older preamble content', OLDER_MANAGER_PREAMBLE_FIXTURE],
  ] as const)('fails closed for firefighter composition with a noncanonical manager preamble: %s', async (_label, preamble) => {
    let taskCreates = 0;
    const result = await runSupervisedTaskLaunchAssistant({
      repository: 'chetwerikoff/orchestrator-pack',
      workClass: 'manager',
      runId: 'run-1',
      managerBrief: `${preamble}\nfirefighter repair launch`,
      worktreeName: 'manager-worktree',
      env: profileEnv(),
    }, deps({ onManagerCreate: () => { taskCreates += 1; } }));
    expect(result).toMatchObject({
      outcome: 'continue',
      stage: 'manager_task',
      observedCause: 'manager_brief_preamble_noncanonical',
      evidence: { template: 'manager-preamble.md' },
    });
    expect(taskCreates).toBe(0);
  });

  it('prepends the canonical manager preamble when the existing first heading is different', async () => {
    const brief = '# Different manager heading\n\nordinary delta';
    let createdBrief = '';
    await runSupervisedTaskLaunchAssistant({
      repository: 'chetwerikoff/orchestrator-pack',
      workClass: 'manager',
      runId: 'run-1',
      managerBrief: brief,
      worktreeName: 'manager-worktree',
      env: profileEnv(),
    }, deps({ onManagerCreate: (created) => { createdBrief = created; } }));
    expect(createdBrief).toBe(`${MANAGER_PREAMBLE_FIXTURE}\n${brief}`);
  });

  it('orders manager preamble then firefighter prompt for firefighter title or delta detection', async () => {
    const created: string[] = [];
    const base: LaunchInput = {
      repository: 'chetwerikoff/orchestrator-pack',
      workClass: 'manager',
      runId: 'run-1',
      managerBrief: 'delta only',
      worktreeName: 'manager-worktree',
      env: profileEnv(),
    };
    await runSupervisedTaskLaunchAssistant({ ...base, issueNumber: 2385 }, deps({
      managerIssueTitle: { status: 'ok', value: 'firefighter repair launch' },
      onManagerCreate: (brief) => { created.push(brief); },
    }));
    await runSupervisedTaskLaunchAssistant({ ...base, managerBrief: 'firefighter repair launch' }, deps({
      onManagerCreate: (brief) => { created.push(brief); },
    }));
    expect(created).toEqual([
      `${MANAGER_PREAMBLE_FIXTURE}\n${FIREFIGHTER_PROMPT_FIXTURE}\ndelta only`,
      `${MANAGER_PREAMBLE_FIXTURE}\n${FIREFIGHTER_PROMPT_FIXTURE}\nfirefighter repair launch`,
    ]);
  });

  it('canonical manager CLI carries the existing Issue into title-based firefighter classification', async () => {
    const parsedInput = parseLaunchAssistantCli([
      '--project', 'orchestrator-pack',
      '--work-class', 'manager',
      '--issue-number', '2385',
      '--run', 'run-1',
      '--manager-brief', 'ordinary delta',
      '--worktree-name', 'manager-worktree',
    ], {}, () => ({
      projectId: 'orchestrator-pack',
      repository: 'chetwerikoff/orchestrator-pack',
      primaryRoot: '/fixture/target-root',
      defaultBranch: 'main',
    } as ReturnType<typeof import('../lib/target-context.ts').resolveTargetContext>));
    const input: LaunchInput = { ...parsedInput, env: profileEnv(), startMode: 'exact_terminal_worktree' };
    let createdBrief = '';
    const result = await runSupervisedTaskLaunchAssistant(input, deps({
      managerIssueTitle: { status: 'ok', value: 'repair firefighter launch' },
      onManagerCreate: (brief) => { createdBrief = brief; },
    }));
    expect(result.outcome).toBe('ready');
    expect(input.issueNumber).toBe(2385);
    expect(createdBrief).toBe(`${MANAGER_PREAMBLE_FIXTURE}\n${FIREFIGHTER_PROMPT_FIXTURE}\nordinary delta`);
  });

  it('leaves an already-present newline-terminated firefighter prompt unchanged', async () => {
    const alreadyPrepared = `${MANAGER_PREAMBLE_FIXTURE}\n${FIREFIGHTER_PROMPT_FIXTURE}\nfirefighter: existing delta`;
    let createdBrief = '';
    await runSupervisedTaskLaunchAssistant({
      repository: 'chetwerikoff/orchestrator-pack',
      workClass: 'manager',
      runId: 'run-1',
      managerBrief: alreadyPrepared,
      worktreeName: 'manager-worktree',
      env: profileEnv(),
    }, deps({ onManagerCreate: (brief) => { createdBrief = brief; } }));
    expect(createdBrief).toBe(alreadyPrepared);
  });

  it('leaves a complete firefighter prompt section anywhere in the recognized delta unchanged', async () => {
    const delta = `firefighter repair context before the existing section

${FIREFIGHTER_PROMPT_FIXTURE}
context after the existing section`;
    const alreadyPrepared = `${MANAGER_PREAMBLE_FIXTURE}\n${delta}`;
    let createdBrief = '';
    await runSupervisedTaskLaunchAssistant({
      repository: 'chetwerikoff/orchestrator-pack',
      workClass: 'manager',
      runId: 'run-1',
      managerBrief: alreadyPrepared,
      worktreeName: 'manager-worktree',
      env: profileEnv(),
    }, deps({ onManagerCreate: (brief) => { createdBrief = brief; } }));
    expect(createdBrief).toBe(alreadyPrepared);
  });

  it('does not mistake an incidental firefighter prompt phrase for its Markdown heading', async () => {
    const delta = `firefighter repair launch

The words Firefighter universal appear here only as prose.`;
    let createdBrief = '';
    await runSupervisedTaskLaunchAssistant({
      repository: 'chetwerikoff/orchestrator-pack',
      workClass: 'manager',
      runId: 'run-1',
      managerBrief: `${MANAGER_PREAMBLE_FIXTURE}\n${delta}`,
      worktreeName: 'manager-worktree',
      env: profileEnv(),
    }, deps({ onManagerCreate: (brief) => { createdBrief = brief; } }));
    expect(createdBrief).toBe(
      `${MANAGER_PREAMBLE_FIXTURE}\n${FIREFIGHTER_PROMPT_FIXTURE}\n${delta}`,
    );
  });


  it('fails closed before Task-create when the firefighter template is unavailable', async () => {
    let taskCreates = 0;
    const result = await runSupervisedTaskLaunchAssistant({
      repository: 'chetwerikoff/orchestrator-pack',
      workClass: 'manager',
      runId: 'run-1',
      managerBrief: 'firefighter repair launch',
      worktreeName: 'manager-worktree',
      env: profileEnv(),
    }, deps({
      firefighterTemplate: {
        status: 'continue',
        cause: 'manager_brief_template_unavailable',
        actor: 'operator',
        evidence: { template: 'ff-prompt-universal.md', errorCode: 'ENOENT' },
        nextAction: { kind: 'reconcile_manager_task', note: 'restore canonical firefighter template' },
      },
      onManagerCreate: () => { taskCreates += 1; },
    }));
    expect(result).toMatchObject({
      outcome: 'continue',
      stage: 'manager_task',
      observedCause: 'manager_brief_template_unavailable',
      evidence: { template: 'ff-prompt-universal.md', errorCode: 'ENOENT' },
    });
    expect(taskCreates).toBe(0);
  });

  it('blocks Task-create when live Issue title classification cannot be read', async () => {
    let taskCreates = 0;
    const result = await runSupervisedTaskLaunchAssistant({
      repository: 'chetwerikoff/orchestrator-pack',
      workClass: 'manager',
      issueNumber: 2385,
      runId: 'run-1',
      managerBrief: 'ordinary delta',
      worktreeName: 'manager-worktree',
      env: profileEnv(),
    }, deps({
      managerIssueTitle: {
        status: 'continue',
        cause: 'manager_issue_title_unavailable',
        actor: 'provider',
        evidence: { repository: 'chetwerikoff/orchestrator-pack', issueNumber: 2385 },
        nextAction: { kind: 'reconcile_manager_task', note: 'restore Issue title read' },
      },
      onManagerCreate: () => { taskCreates += 1; },
    }));
    expect(result).toMatchObject({
      outcome: 'continue',
      stage: 'manager_task',
      observedCause: 'manager_issue_title_unavailable',
    });
    expect(taskCreates).toBe(0);
  });

  it('production template reader fails closed for ENOENT and empty files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'opk-manager-brief-'));
    try {
      const missing = readManagerBriefTemplateFromDisk('manager-preamble.md', directory);
      expect(missing).toMatchObject({
        status: 'continue',
        cause: 'manager_brief_template_unavailable',
        evidence: {
          template: 'manager-preamble.md',
          path: join(directory, 'manager-preamble.md'),
          errorCode: 'ENOENT',
        },
      });

      writeFileSync(join(directory, 'manager-preamble.md'), '', 'utf8');
      const empty = readManagerBriefTemplateFromDisk('manager-preamble.md', directory);
      expect(empty).toMatchObject({
        status: 'continue',
        cause: 'manager_brief_template_unavailable',
        evidence: {
          template: 'manager-preamble.md',
          path: join(directory, 'manager-preamble.md'),
          errorCode: 'empty',
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed before Task-create when a required canonical template is unavailable', async () => {
    let taskCreates = 0;
    const result = await runSupervisedTaskLaunchAssistant({
      repository: 'chetwerikoff/orchestrator-pack',
      workClass: 'manager',
      runId: 'run-1',
      managerBrief: 'ordinary delta',
      worktreeName: 'manager-worktree',
      env: profileEnv(),
    }, deps({
      managerTemplate: {
        status: 'continue',
        cause: 'manager_brief_template_unavailable',
        actor: 'operator',
        evidence: { template: 'manager-preamble.md', errorCode: 'ENOENT' },
        nextAction: { kind: 'reconcile_manager_task', note: 'restore canonical template' },
      },
      onManagerCreate: () => { taskCreates += 1; },
    }));
    expect(result).toMatchObject({
      outcome: 'continue',
      stage: 'manager_task',
      observedCause: 'manager_brief_template_unavailable',
      evidence: { template: 'manager-preamble.md', errorCode: 'ENOENT' },
    });
    expect(taskCreates).toBe(0);
  });

  it('reconciles an unknown creation without replaying a transformed fresh manager brief', async () => {
    const input: LaunchInput = {
      repository: 'chetwerikoff/orchestrator-pack', workClass: 'manager', issueNumber: 2385, runId: 'run-1',
      managerBrief: 'private brief payload', worktreeName: 'manager-worktree', env: profileEnv(),
    };
    let sentBrief = '';
    const result = await runSupervisedTaskLaunchAssistant(input, deps({
      managerIssueTitle: { status: 'ok', value: 'repair firefighter launch' },
      managerCreate: { status: 'continue', cause: 'manager_task_create_outcome_unknown', actor: 'provider',
        evidence: { requestId: 'req-1' }, nextAction: { kind: 'reconcile_manager_task', requestId: 'req-1', note: 'reconcile unknown create' } },
      onManagerCreate: (brief) => { sentBrief = brief; },
    }));
    expect(sentBrief).toBe(`${MANAGER_PREAMBLE_FIXTURE}\n${FIREFIGHTER_PROMPT_FIXTURE}\nprivate brief payload`);
    expect(result).toMatchObject({ outcome: 'continue', stage: 'manager_task', observedCause: 'manager_task_create_outcome_unknown',
      nextAction: { kind: 'reconcile_manager_task', requestId: 'req-1' } });
    expect(JSON.stringify(result)).not.toContain('private brief payload');
  });

  it('represents outcome-unknown Task-create as reconciliation without replay authority', async () => {
    const calls: string[][] = [];
    const result = await createManagerTaskWithOrca('run-1', 'private brief payload', async (args) => {
      calls.push([...args]);
      return { ok: false, stdout: JSON.stringify({ ok: false, error: {
        code: 'operation_unknown', data: { requestId: 'req-1' },
      } }) };
    });
    expect(calls).toEqual([[
      'orca', 'orchestration', 'task-create', '--spec', 'private brief payload', '--run', 'run-1', '--json',
    ]]);
    expect(result).toMatchObject({
      status: 'continue', cause: 'manager_task_create_outcome_unknown', evidence: { requestId: 'req-1' },
      nextAction: { kind: 'reconcile_manager_task', requestId: 'req-1' },
    });
    if (result.status === 'continue') {
      expect(result.nextAction.command).toBeUndefined();
    }
    expect(JSON.stringify(result)).not.toContain('private brief payload');
  });

  it.each([
    ['mixed malformed orchestration alias', { orchestrationRequestId: 123, requestId: 'req-1' }],
    ['empty orchestration alias', { orchestrationRequestId: '', requestId: 'req-1' }],
    ['conflicting aliases', { orchestrationRequestId: 'req-2', requestId: 'req-1' }],
  ] as const)('retains generic reconciliation for malformed request-id aliases: %s', async (_label, recoveryData) => {
    const result = await createManagerTaskWithOrca('run-1', 'private brief payload', async () => ({
      ok: false,
      stdout: JSON.stringify({ ok: false, error: { code: 'operation_unknown', data: recoveryData } }),
    }));
    expect(result).toMatchObject({
      status: 'continue', cause: 'manager_task_create_failed_or_unknown',
      nextAction: { kind: 'reconcile_manager_task' },
    });
    if (result.status === 'continue') {
      expect(result.nextAction.requestId).toBeUndefined();
    }
  });

  it('early non-null Dispatch creates no worktree or terminal and makes no start', async () => {
    let worktrees = 0; let spawns = 0; let starts = 0;
    const result = await runSupervisedTaskLaunchAssistant(launchInput(), deps({ dispatch: [{ kind: 'present', dispatchId: 'dispatch-existing' }],
      onWorktree: () => { worktrees += 1; }, adapter: runtimeAdapter({ onSpawn: () => { spawns += 1; } }), onSupervised: () => { starts += 1; } }));
    expect(result).toMatchObject({ outcome: 'continue', stage: 'dispatch_admission_early', resources: { dispatchId: 'dispatch-existing' } });
    if (result.outcome === 'continue') {
      expect(result.timings.at(-1)).toMatchObject({ stage: 'dispatch_admission_early', outcome: 'continued' });
    }
    expect(worktrees).toBe(0); expect(spawns).toBe(0); expect(starts).toBe(0);
  });

  it('immediate pre-start Dispatch race is fenced after one fresh terminal and before worker-start', async () => {
    let spawns = 0; let starts = 0;
    const result = await runSupervisedTaskLaunchAssistant(launchInput(), deps({ dispatch: [{ kind: 'absent' }, { kind: 'present', dispatchId: 'dispatch-race' }],
      adapter: runtimeAdapter({ onSpawn: () => { spawns += 1; } }), onSupervised: () => { starts += 1; } }));
    expect(result).toMatchObject({ outcome: 'continue', stage: 'dispatch_admission_final', resources: { dispatchId: 'dispatch-race' } });
    if (result.outcome === 'continue') {
      expect(result.timings.at(-1)).toMatchObject({ stage: 'dispatch_admission_final', outcome: 'continued' });
    }
    expect(spawns).toBe(1); expect(starts).toBe(0);
  });

  it.each([
    ['terminal_provenance_external', { ...worker, provenance: 'external' as const }, 'idle' as const],
    ['terminal_workspace_mismatch', { ...worker, workspacePath: '/tmp/other' }, 'idle' as const],
    ['terminal_liveness_busy', worker, 'busy' as const],
    ['terminal_liveness_unknown', worker, 'unknown' as const],
  ])('fails the machine-enforced terminal boundary: %s', async (cause, target, liveness) => {
    const result = await runSupervisedTaskLaunchAssistant(launchInput(), deps({ adapter: runtimeAdapter({ worker: target, liveness }) }));
    expect(result).toMatchObject({
      outcome: 'continue', stage: 'terminal_prepare', observedCause: cause,
      resources: { terminal: target.identity },
    });
  });

  it('preserves bounded scrubbed native Orca terminal-create detail in terminal_prepare evidence', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'opk-2387-spawn-detail-'));
    const operations: string[] = [];
    const nativeMessage = `spawn permission denied token=fixture-secret ${'x'.repeat(700)}`;
    const runJson = (args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      operations.push(operation);
      if (operation === 'terminal list') {
        return { ok: true, result: { totalCount: 0, truncated: false, terminals: [] } };
      }
      if (operation === 'terminal create') {
        return {
          ok: false,
          operation: 'terminal_create',
          outcomeCategory: 'supported_operation_failure',
          error: { code: 'terminal_create_failed', message: nativeMessage },
        };
      }
      return {
        ok: false,
        outcomeCategory: 'supported_operation_failure',
        error: { code: 'unexpected_operation', message: operation },
      };
    };

    try {
      const adapter = new OrcaTaskRuntimeAdapter({
        runJson: runJson as never,
        env: { OPK_WAKE_SUPERVISOR_STATE_DIR: stateRoot },
      });
      const result = await runSupervisedTaskLaunchAssistant(launchInput(), deps({ adapter }));
      expect(operations).toEqual(['terminal list', 'terminal create']);
      expect(result).toMatchObject({
        outcome: 'continue',
        stage: 'terminal_prepare',
        observedCause: 'terminal_spawn_failed',
        evidence: {
          liveness: 'not_observed',
          spawnReason: 'runtime_operation_failed',
          spawnErrorCode: 'terminal_create_failed',
        },
      });
      if (result.outcome === 'continue') {
        const spawnError = String(result.evidence.spawnError ?? '');
        expect(spawnError).toContain('spawn permission denied token=[REDACTED]');
        expect(spawnError).not.toContain('fixture-secret');
        expect(spawnError).toHaveLength(512);
        expect(spawnError.endsWith('…')).toBe(true);
      }
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('uses the bounded startup window to reach ready when the TUI settles within it', async () => {
    let spawns = 0;
    const windows: number[] = [];
    const samples: string[] = [];
    const adapter = runtimeAdapter({
      livenessSequence: ['busy', 'idle'],
      onSpawn: () => { spawns += 1; },
      onLiveness: (window) => { windows.push(window); },
      onLivenessSample: (status) => { samples.push(status); },
    });
    const result = await runSupervisedTaskLaunchAssistant(launchInput(), deps({ adapter }));
    expect(result).toMatchObject({ outcome: 'ready', resources: { terminal: worker.identity } });
    expect(spawns).toBe(1);
    expect(windows).toEqual([LAUNCH_STARTUP_OBSERVATION_WINDOW_MS]);
    expect(samples).toEqual(['busy', 'idle']);
    expect(LAUNCH_STARTUP_OBSERVATION_WINDOW_MS).toBeGreaterThan(1_000);
  });

  it('continues a busy Task using the same persisted terminal without creating a second pane', async () => {
    const ownership = new Map<string, RuntimeWorker>();
    const spawnAttempts: string[] = [];
    let paneCreations = 0;
    const adapterForInvocation = (): RuntimeAdapter => {
      const base = runtimeAdapter({ liveness: 'busy' });
      return {
        ...base,
        spawnWorker: ({ title }) => {
          spawnAttempts.push(title);
          const existing = ownership.get(title);
          if (existing) return { status: 'ok', value: existing };
          const created = { ...worker, title };
          ownership.set(title, created);
          paneCreations += 1;
          return { status: 'ok', value: created };
        },
      };
    };

    const first = await runSupervisedTaskLaunchAssistant(launchInput(), deps({ adapter: adapterForInvocation() }));
    const continuation = await runSupervisedTaskLaunchAssistant(launchInput(), deps({ adapter: adapterForInvocation() }));

    expect(first).toMatchObject({
      outcome: 'continue', stage: 'terminal_prepare', observedCause: 'terminal_liveness_busy',
      resources: { terminal: worker.identity },
    });
    expect(continuation).toMatchObject({
      outcome: 'continue', stage: 'terminal_prepare', observedCause: 'terminal_liveness_busy',
      resources: { terminal: worker.identity },
    });
    expect(spawnAttempts).toEqual(['opk-t2-task-1', 'opk-t2-task-1']);
    expect(paneCreations).toBe(1);
  });

  it('fails closed when liveness observes a recreated terminal generation', async () => {
    const result = await runSupervisedTaskLaunchAssistant(launchInput(), deps({
      adapter: runtimeAdapter({ livenessWorker: { ...worker.identity, generation: 'pty-2' } }),
    }));
    expect(result).toMatchObject({
      outcome: 'continue', stage: 'terminal_prepare', observedCause: 'terminal_generation_mismatch',
      resources: { terminal: worker.identity },
    });
  });

  it('drops raw provider receipt, residual resources, provider strings, and recovery command from handled failure', async () => {
    const receipt = {
      taskId: 'task-1', dispatchId: 'dispatch-provider', state: 'unknown', stage: 'launching',
      sentinel: 'RAW_RECEIPT_SENTINEL',
    };
    const residualResources = [{ sentinel: 'RAW_RESIDUAL_SENTINEL' }];
    const recoveryCommand = 'PROVIDER_RECOVERY_SENTINEL';
    const result = await runSupervisedTaskLaunchAssistant(launchInput(), deps({ supervised: {
      ok: false,
      reason: 'supervised_start_envelope_error',
      errorCode: 'runtime_timeout',
      errorMessage: 'PROVIDER_ERROR_MESSAGE_SENTINEL',
      nextSteps: ['PROVIDER_NEXT_STEPS_SENTINEL'],
      receipt,
      residualResources,
      recovery: { requestId: 'request-redaction', dispatchId: 'dispatch-provider', recoveryCommand },
    } }));
    expect(result).toMatchObject({
      outcome: 'continue', stage: 'supervised_start', resources: { dispatchId: 'dispatch-provider' },
      evidence: { errorCode: 'runtime_timeout', requestId: 'request-redaction', dispatchId: 'dispatch-provider' },
      nextAction: { kind: 'retry_supervised_start', requestId: 'request-redaction' },
    });
    const serialized = JSON.stringify(result);
    for (const sentinel of [
      'RAW_RECEIPT_SENTINEL', 'RAW_RESIDUAL_SENTINEL', 'PROVIDER_RECOVERY_SENTINEL',
      'PROVIDER_ERROR_MESSAGE_SENTINEL', 'PROVIDER_NEXT_STEPS_SENTINEL',
    ]) expect(serialized).not.toContain(sentinel);
  });

  it('reports only the sanctioned gone-path refusal or native cause unavailable', async () => {
    for (const [message, expected] of [
      ['terminal_reuse_unauthorized', 'terminal_reuse_unauthorized'],
      ['untrusted provider detail', 'native cause unavailable'],
      [undefined, 'native cause unavailable'],
    ] as const) {
      const result = await runSupervisedTaskLaunchAssistant(launchInput(), deps({
        supervised: { ok: false, reason: 'target_unresolved', ...(message ? { errorMessage: message } : {}) },
      }));
      expect(result).toMatchObject({
        outcome: 'continue', stage: 'supervised_start',
        observedCause: 'target_unresolved',
        evidence: { admissionDiagnostic: expected },
        nextAction: { kind: 'reconcile_supervised_start' },
      });
      expect(JSON.stringify(result)).not.toContain('untrusted provider detail');
    }
  });



  it('uses the registered local fork origin, not upstream Orca identity, for both fresh effect boundaries', async () => {
    const repo = {
      ...registeredOrcaRepo('6f030d40'),
      gitRemoteIdentity: { canonicalKey: 'github.com/sayantan94/AppliedIn' },
      repoIcon: { label: 'untrusted/upstream-label' },
    };
    for (const providerTopLevel of [false, true]) {
      const fixture = freshRepoFixture({
        repos: [repo],
        originByPath: { [REGISTERED_ORCA_ROOT]: 'git@GITHUB.COM:CHETWERIKOFF/AppliedIn.git' },
      });
      const result = await prepareWorktreeWithOrca({
        repository: 'Chetwerikoff/aPPLIEDin', taskId: 'task-1', worktreeName: 'wt', issueNumber: 1479,
        providerTopLevel,
      }, fixture.execute);
      if (providerTopLevel) {
        expect(result).toMatchObject({
          status: 'ok', value: {
            selector: 'new-top-level', repositorySelector: 'id:6f030d40', setupWitness: 'provider_top_level',
          },
        });
      } else {
        expect(result).toMatchObject({ status: 'ok', value: { id: 'repo::wt' } });
      }
      expect(fixture.calls.slice(0, 3)).toEqual([
        { argv: ['orca', 'repo', 'list', '--json'], cwd: undefined },
        { argv: ['git', 'rev-parse', '--show-toplevel'], cwd: REGISTERED_ORCA_ROOT },
        { argv: ['git', 'remote', 'get-url', 'origin'], cwd: REGISTERED_ORCA_ROOT },
      ]);
      expect(fixture.calls.filter((call) => call.argv[2] === 'create').map((call) => call.argv)).toEqual(
        providerTopLevel ? [] : [[
          'orca', 'worktree', 'create', '--repo', 'id:6f030d40', '--name', 'wt',
          '--issue', '1479', '--setup', 'run', '--json',
        ]],
      );
    }
  });

  it.each([
    'git@github.com:other/chetwerikoff/AppliedIn.git',
    'https://github.com/other/chetwerikoff/AppliedIn.git',
    'git@github.com:chetwerikoff//AppliedIn.git',
    'https://github.com/chetwerikoff/AppliedIn/extra.git',
  ])('rejects a suffix-match origin in both fresh effect variants: %s', async (origin) => {
    for (const providerTopLevel of [false, true]) {
      const fixture = freshRepoFixture({
        repos: [registeredOrcaRepo()],
        originByPath: { [REGISTERED_ORCA_ROOT]: origin },
      });
      const result = await prepareWorktreeWithOrca({
        repository: 'chetwerikoff/AppliedIn', taskId: 'task-1', worktreeName: 'wt', providerTopLevel,
      }, fixture.execute);
      expect(result).toMatchObject({ status: 'continue', cause: 'worktree_repository_resolution_absent' });
      expect(fixture.calls).toEqual([
        { argv: ['orca', 'repo', 'list', '--json'], cwd: undefined },
        { argv: ['git', 'rev-parse', '--show-toplevel'], cwd: REGISTERED_ORCA_ROOT },
        { argv: ['git', 'remote', 'get-url', 'origin'], cwd: REGISTERED_ORCA_ROOT },
      ]);
    }
  });

  it.each([
    ['confusable HTTP scheme', 'httpſ://github.com/chetwerikoff/AppliedIn.git', 'chetwerikoff/AppliedIn', 'worktree_repository_resolution_absent'],
    ['confusable SSH repository', 'git@github.com:chetwerikoff/Kepo.git', 'chetwerikoff/Kepo', 'worktree_repository_resolution_absent'],
    ['confusable HTTPS repository', 'https://github.com/chetwerikoff/Kepo.git', 'chetwerikoff/Kepo', 'worktree_repository_resolution_absent'],
    ['confusable card repository', 'git@github.com:chetwerikoff/Kepo.git', 'chetwerikoff/Kepo', 'worktree_repository_resolution_malformed'],
  ] as const)('rejects Unicode case-folding at both fresh effect boundaries: %s', async (_name, origin, repository, cause) => {
    for (const providerTopLevel of [false, true]) {
      const fixture = freshRepoFixture({
        repos: [registeredOrcaRepo()],
        originByPath: { [REGISTERED_ORCA_ROOT]: origin },
      });
      const result = await prepareWorktreeWithOrca({
        repository, taskId: 'task-1', worktreeName: 'wt', providerTopLevel,
      }, fixture.execute);
      expect(result).toMatchObject({ status: 'continue', cause });
      expect(fixture.calls.some((call) =>
        call.argv[0] === 'orca' && call.argv[1] === 'worktree' && call.argv[2] === 'create'
      )).toBe(false);
    }
  });

  it.each([
    ['folder under another Git root', { kind: 'folder' }, {}],
    ['ssh-owned colliding local checkout', { executionHostId: 'ssh:remote' }, {}],
    ['runtime-owned colliding local checkout', { executionHostId: 'runtime:other' }, {}],
    ['unknown host', { executionHostId: 'unknown' }, {}],
    ['malformed host', { executionHostId: 42 }, {}],
    ['host connection collision', { executionHostId: 'local', connectionId: 'remote-connection' }, {}],
    ['connection without host', { executionHostId: null, connectionId: 'remote-connection' }, {}],
    ['malformed connection', { connectionId: 42 }, {}],
    ['missing registered path', { path: undefined }, {}],
    ['relative registered path', { path: 'nested/folder' }, {}],
    ['blank registered path', { path: '' }, {}],
    ['missing repository id', { id: undefined }, {}],
    ['unusable repository id', { id: 'unusable id' }, {}],
    ['nested Git directory', {}, { rootByPath: { [REGISTERED_ORCA_ROOT]: '/tmp/parent-root' } }],
    ['failed root probe', {}, { failRoot: true }],
    ['failed origin probe', {}, { failOrigin: true }],
    ['non-GitHub origin', {}, { originByPath: { [REGISTERED_ORCA_ROOT]: 'git@example.com:chetwerikoff/AppliedIn.git' } }],
    ['wrong origin despite matching labels', {
      repoIcon: { label: 'chetwerikoff/AppliedIn' },
      gitRemoteIdentity: { canonicalKey: 'github.com/chetwerikoff/AppliedIn' },
    }, { originByPath: { [REGISTERED_ORCA_ROOT]: 'git@github.com:unrelated/repo.git' } }],
  ] as const)('refuses an ineligible local identity: %s', async (_name, differences, options) => {
    for (const providerTopLevel of [false, true]) {
      const fixture = freshRepoFixture({ repos: [{ ...registeredOrcaRepo(), ...differences }], ...options });
      const result = await prepareWorktreeWithOrca({
        repository: 'chetwerikoff/AppliedIn', taskId: 'task-1', worktreeName: 'wt', providerTopLevel,
      }, fixture.execute);
      expect(result.status).toBe('continue');
      expect(fixture.calls.some((call) => call.argv[0] === 'orca' && call.argv[1] === 'worktree')).toBe(false);
      for (const call of fixture.calls.filter((entry) => entry.argv[0] === 'git')) {
        expect(call.cwd).toBe(REGISTERED_ORCA_ROOT);
      }
    }
  });

  it('accepts an absent legacy kind/host only after the registered Git-root probes', async () => {
    const fixture = freshRepoFixture({
      repos: [{ id: 'legacy-repo', path: REGISTERED_ORCA_ROOT }],
    });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1', worktreeName: 'wt',
      providerTopLevel: true,
    }, fixture.execute);
    expect(result).toMatchObject({
      status: 'ok', value: { selector: 'new-top-level', repositorySelector: 'id:legacy-repo' },
    });
    expect(fixture.calls.slice(1).map((call) => call.cwd)).toEqual([
      REGISTERED_ORCA_ROOT, REGISTERED_ORCA_ROOT,
    ]);
  });

  it('refuses two eligible matching registered origins rather than choosing the first', async () => {
    for (const providerTopLevel of [false, true]) {
      const fixture = freshRepoFixture({ repos: [
        registeredOrcaRepo('orca-1', '/tmp/orca-repo-a'),
        registeredOrcaRepo('orca-2', '/tmp/orca-repo-b'),
      ] });
      const result = await prepareWorktreeWithOrca({
        repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1', worktreeName: 'wt',
        providerTopLevel,
      }, fixture.execute);
      expect(result).toMatchObject({ status: 'continue', cause: 'worktree_repository_resolution_ambiguous' });
      expect(fixture.calls.map((call) => call.cwd)).toEqual([
        undefined, '/tmp/orca-repo-a', '/tmp/orca-repo-a', '/tmp/orca-repo-b', '/tmp/orca-repo-b',
      ]);
      expect(fixture.calls.some((call) => call.argv[2] === 'create')).toBe(false);
    }
  });

  it.each([
    ['missing matching origin', repoListEnvelope([registeredOrcaRepo('other')]), 'worktree_repository_resolution_absent'],
    ['malformed envelope', '{not-json', 'worktree_repository_resolution_malformed'],
    ['malformed row', okEnvelope({ repos: [null] }), 'worktree_repository_resolution_malformed'],
  ] as const)('keeps safe Orca list refusal: %s', async (_name, listed, expectedCause) => {
    const fixture = freshRepoFixture({
      listOutput: listed,
      originByPath: { [REGISTERED_ORCA_ROOT]: 'git@github.com:wrong/repo.git' },
    });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1', worktreeName: 'wt',
      providerTopLevel: true,
    }, fixture.execute);
    expect(result).toMatchObject({
      status: 'continue', cause: expectedCause,
      nextAction: { kind: 'reconcile_worktree_setup' },
    });
    expect(fixture.calls.every((call) => call.argv[2] !== 'create')).toBe(true);
  });

  it('rejects a manager refresh worktree whose origin uses a non-GitHub host', async () => {
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1', worktreeSelector: 'id:orca-repo::manager', managerRefresh: true,
    }, async (args) => {
      if (args[1] === 'worktree') return { ok: true, stdout: okEnvelope({ worktree: { id: 'orca-repo::manager', path: '/tmp/manager' } }) };
      if (args[0] === 'git' && args[1] === 'rev-parse' && args[2] === '--show-toplevel') return { ok: true, stdout: '/tmp/manager\n' };
      if (args[0] === 'git' && args[1] === 'remote') return { ok: true, stdout: 'git@git.example.com:chetwerikoff/orchestrator-pack.git\n' };
      return { ok: true, stdout: '' };
    });
    expect(result).toMatchObject({ status: 'continue', cause: 'manager_worktree_repository_identity_mismatch' });
  });

  it('accepts fresh Orca worktree creation when setup is explicitly not configured', async () => {
    const fixture = freshRepoFixture();
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1', worktreeName: 'wt', issueNumber: 1479,
    }, fixture.execute);
    expect(result).toMatchObject({ status: 'ok', value: { id: 'repo::wt', setupWitness: 'same_invocation_complete' } });
    expect(fixture.calls.map((call) => call.argv[0])).toEqual(['orca', 'git', 'git', 'orca', 'git']);
  });

  it('accepts a fresh worktree with no setup receipt', async () => {
    const fixture = freshRepoFixture({ setupState: 'absent' });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1', worktreeName: 'wt', issueNumber: 1479,
    }, fixture.execute);
    expect(result).toMatchObject({
      status: 'ok', value: { id: 'repo::wt', setupWitness: 'same_invocation_complete' },
      evidence: { setupState: 'not_configured' },
    });
    expect(fixture.calls[3]?.argv).toEqual([
      'orca', 'worktree', 'create', '--repo', 'id:orca-repo-1', '--name', 'wt',
      '--issue', '1479', '--setup', 'run', '--json',
    ]);
  });

  it('refuses dirty newly created worker worktree without reset or stash', async () => {
    const fixture = freshRepoFixture({ freshStatus: ' M tests/test_database_guard.py\n' });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task_98269fb5e0c2',
      worktreeName: 'issue-2653', issueNumber: 2653,
    }, fixture.execute);
    expect(result).toMatchObject({ status: 'continue', cause: 'worktree_fresh_dirty' });
    expect(fixture.calls.some((call) => call.argv.join(' ') ===
      'git status --porcelain=v1 --untracked-files=all')).toBe(true);
    expect(fixture.calls.some((call) =>
      call.argv[0] === 'git' && ['reset', 'stash', 'merge', 'clean'].includes(call.argv[1]!))).toBe(false);
  });

  it('waits for the exact fresh setup terminal to exit successfully', async () => {
    const fixture = freshRepoFixture({ setupState: 'running' });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1', worktreeName: 'wt', baseBranch: 'main',
    }, fixture.execute);
    expect(result).toMatchObject({ status: 'ok', value: { setupWitness: 'same_invocation_complete' } });
    expect(fixture.calls[3]?.argv).toEqual([
      'orca', 'worktree', 'create', '--repo', 'id:orca-repo-1', '--name', 'wt',
      '--base-branch', 'main', '--no-parent', '--setup', 'run', '--json',
    ]);
    expect(fixture.calls[4]?.argv).toEqual([
      'orca', 'terminal', 'wait', '--terminal', 'setup-term', '--for', 'exit', '--timeout-ms', '120000', '--json',
    ]);
  });

  it('fails closed when fresh setup exits non-zero', async () => {
    const fixture = freshRepoFixture({ setupState: 'running', waitExitCode: 1 });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1', worktreeName: 'wt',
    }, fixture.execute);
    expect(result).toMatchObject({ status: 'continue', cause: 'worktree_setup_wait_not_successful', evidence: { exitCode: 1 } });
  });

  it('does not infer reuse readiness from worktree path/head alone', async () => {
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1', worktreeSelector: 'id:repo::existing',
    }, async () => ({ ok: true, stdout: okEnvelope({ worktree: { id: 'repo::existing', path: '/tmp/existing', head: 'abc' } }) }));
    expect(result).toMatchObject({ status: 'continue', cause: 'worktree_reuse_ownership_unproven', evidence: { worktreeId: 'repo::existing' } });
  });

  it('refreshes a bound clean manager worktree before returning proven reuse', async () => {
    const fixture = managerReuseFixture();
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack',
      taskId: 'task-1',
      worktreeSelector: 'id:repo::existing',
      managerRefresh: true,
    }, fixture.execute);
    expect(result).toMatchObject({
      status: 'ok',
      value: {
        id: 'repo::existing',
        selector: 'id:repo::existing',
        path: '/tmp/existing',
        setupWitness: 'proven_reuse',
      },
      evidence: { branch: 'manager-2024', refresh: 'fast_forwarded', head: fixture.originMain },
    });
    expect(fixture.head()).toBe(fixture.originMain);
    expect(fixture.mergeTransitions()).toBe(1);
    expect(fixture.calls).toEqual([
      ['orca', 'worktree', 'show', '--worktree', 'id:repo::existing', '--json'],
      ['git', 'rev-parse', '--show-toplevel'],
      ['git', 'remote', 'get-url', 'origin'],
      ['git', 'worktree', 'list', '--porcelain'],
      ['git', 'fetch', '--no-tags', 'origin', 'main:refs/remotes/origin/main'],
      ['git', 'rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
      ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
      ['git', 'rev-parse', '--verify', 'HEAD^{commit}'],
      ['git', 'merge-base', '--is-ancestor', '1'.repeat(40), fixture.originMain],
      ['git', 'merge', '--ff-only', fixture.originMain],
      ['git', 'rev-parse', '--verify', 'HEAD^{commit}'],
    ]);
  });

  it('refuses a mismatched manager selector before any git command', async () => {
    const fixture = managerReuseFixture({ worktreeId: 'repo::other' });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack',
      taskId: 'task-1',
      worktreeSelector: 'id:repo::expected',
      managerRefresh: true,
    }, fixture.execute);
    expect(result).toMatchObject({ status: 'continue', cause: 'manager_worktree_selector_mismatch' });
    expect(fixture.calls).toEqual([
      ['orca', 'worktree', 'show', '--worktree', 'id:repo::expected', '--json'],
    ]);
  });

  it('allows only read-only identity git before refusing a repository mismatch', async () => {
    const fixture = managerReuseFixture({ remoteUrl: 'git@github.com:other/repo.git' });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack',
      taskId: 'task-1',
      worktreeSelector: 'id:repo::existing',
      managerRefresh: true,
    }, fixture.execute);
    expect(result).toMatchObject({ status: 'continue', cause: 'manager_worktree_repository_identity_mismatch' });
    expect(fixture.calls).toEqual([
      ['orca', 'worktree', 'show', '--worktree', 'id:repo::existing', '--json'],
      ['git', 'rev-parse', '--show-toplevel'],
      ['git', 'remote', 'get-url', 'origin'],
    ]);
  });

  it('refuses a failed manager origin/main fetch before status or mutation', async () => {
    const fixture = managerReuseFixture({ fetchOk: false });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack',
      taskId: 'task-1',
      worktreeSelector: 'id:repo::existing',
      managerRefresh: true,
    }, fixture.execute);
    expect(result).toMatchObject({ status: 'continue', cause: 'manager_worktree_fetch_failed' });
    expect(fixture.calls.some((args) => args[0] === 'git' && args[1] === 'status')).toBe(false);
    expect(fixture.calls.some((args) => args[0] === 'git' && args[1] === 'merge')).toBe(false);
    expect(fixture.head()).toBe('1'.repeat(40));
  });

  it('refuses an unresolved fetched origin/main before status or mutation', async () => {
    const fixture = managerReuseFixture({ originResolved: false });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack',
      taskId: 'task-1',
      worktreeSelector: 'id:repo::existing',
      managerRefresh: true,
    }, fixture.execute);
    expect(result).toMatchObject({ status: 'continue', cause: 'manager_worktree_origin_main_unresolved' });
    expect(fixture.calls.some((args) => args[0] === 'git' && args[1] === 'status')).toBe(false);
    expect(fixture.calls.some((args) => args[0] === 'git' && args[1] === 'merge')).toBe(false);
    expect(fixture.head()).toBe('1'.repeat(40));
  });

  it('fetches but leaves dirty manager worktree bytes untouched', async () => {
    const fixture = managerReuseFixture({ status: '?? local.txt\n' });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack',
      taskId: 'task-1',
      worktreeSelector: 'id:repo::existing',
      managerRefresh: true,
    }, fixture.execute);
    expect(result).toMatchObject({ status: 'continue', cause: 'worktree_reuse_ownership_unproven' });
    expect(fixture.head()).toBe('1'.repeat(40));
    expect(fixture.mergeTransitions()).toBe(0);
    expect(fixture.calls.some((args) => args[0] === 'git' && args[1] === 'merge')).toBe(false);
  });

  it('refuses non-ancestor manager HEAD without repair commands', async () => {
    const fixture = managerReuseFixture({ ancestor: false });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack',
      taskId: 'task-1',
      worktreeSelector: 'id:repo::existing',
      managerRefresh: true,
    }, fixture.execute);
    expect(result).toMatchObject({ status: 'continue', cause: 'manager_worktree_non_ancestor' });
    expect(fixture.head()).toBe('1'.repeat(40));
    const serialized = JSON.stringify(fixture.calls);
    expect(serialized).not.toContain('reset');
    expect(serialized).not.toContain('rebase');
    expect(serialized).not.toContain('--force');
    expect(fixture.calls.some((args) => args[0] === 'git' && args[1] === 'merge')).toBe(false);
  });

  it('admits one live Issue-closing same-repository PR head without rewriting its manager branch', async () => {
    const fixture = managerReuseFixture({ ancestor: false });
    const request = {
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1',
      managerRefresh: true, managerTaskRunId: 'run-1', issueNumber: 2430,
      worktreeSelector: 'id:repo::existing', defaultBranch: 'main',
    } as const;
    const result = await prepareWorktreeWithOrca(request, fixture.execute);
    expect(result).toMatchObject({
      status: 'ok', value: { id: 'repo::existing', path: '/tmp/existing', setupWitness: 'proven_reuse' },
      evidence: { prNumber: 42, head: '1'.repeat(40), refresh: 'pr_head_preserved' },
    });
    expect(fixture.head()).toBe('1'.repeat(40));
    expect(fixture.mergeTransitions()).toBe(0);
    expect(fixture.calls.filter((args) => args.slice(0, 3).join(' ') === 'gh pr view')).toHaveLength(2);
    expect(fixture.calls.some((args) => args[0] === 'orca' && args[2] === 'task-list' && args[3] === '--run')).toBe(true);
    expect(fixture.calls.some((args) => args[0] === 'git' && ['merge', 'reset', 'rebase'].includes(args[1]!))).toBe(false);

    let started = 0;
    const launch = await runSupervisedTaskLaunchAssistant({
      ...launchInput('manager'), issueNumber: 2430, defaultBranch: 'main',
    }, {
      ...deps({ onSupervised: () => { started += 1; } }),
      prepareWorktree: (input) => prepareWorktreeWithOrca(input, managerReuseFixture({ ancestor: false, worktreeId: 'manager-worktree', worktreePath: '/tmp/exact-worktree' }).execute),
    });
    expect(launch).toMatchObject({
      outcome: 'ready', resources: { runId: 'run-1', taskId: 'task-1', dispatchId: 'dispatch-1' },
    });
    expect(started).toBe(1);
  });

  it('accepts only the real closing line after tilde examples and HTML comments', async () => {
    const fixture = managerReuseFixture({
      ancestor: false,
      prOverrides: { body: "~~~md\nCloses #2430\n~~~\n<!--\nCloses #2430\n-->\nCloses #2430" },
    });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1',
      managerRefresh: true, managerTaskRunId: 'run-1', issueNumber: 2430,
      worktreeSelector: 'id:repo::existing', defaultBranch: 'main',
    }, fixture.execute);
    expect(result).toMatchObject({ status: 'ok', evidence: { prNumber: 42, refresh: 'pr_head_preserved' } });
    expect(fixture.calls.some((args) => args[0] === 'git' && args[1] === 'merge')).toBe(false);
  });

  it.each([
    { name: 'no linked PR', fixture: { noPr: true }, cause: 'manager_pr_resume_link_ambiguous' },
    { name: 'multiple linked PRs', fixture: { duplicatePr: true }, cause: 'manager_pr_resume_link_ambiguous' },
    { name: "tilde-fenced closing example", fixture: { prOverrides: { body: "~~~md\nCloses #2430\n~~~" } }, cause: 'manager_pr_resume_link_ambiguous' },
    { name: "long tilde fence and short delimiter", fixture: { prOverrides: { body: "~~~~text\nCloses #2430\n~~~\nCloses #2430\n~~~~" } }, cause: 'manager_pr_resume_link_ambiguous' },
    { name: "multiline HTML comment", fixture: { prOverrides: { body: "<!--\nCloses #2430\n-->" } }, cause: 'manager_pr_resume_link_ambiguous' },
    { name: "unclosed multiline HTML comment", fixture: { prOverrides: { body: "<!-- sample\nCloses #2430" } }, cause: 'manager_pr_resume_link_ambiguous' },
    { name: "comment cannot join fragments into a closing keyword", fixture: { prOverrides: { body: "Clos<!-- sample -->es #2430" } }, cause: 'manager_pr_resume_link_ambiguous' },
    { name: "HTML comment inside a tilde-fenced example", fixture: { prOverrides: { body: "~~~text\n<!-- Closes #2430 -->\nCloses #2430\n~~~" } }, cause: 'manager_pr_resume_link_ambiguous' },
    { name: 'unlinked body', fixture: { prOverrides: { body: 'Mentioned #2430, no closing line' } }, cause: 'manager_pr_resume_link_ambiguous' },
    { name: 'quoted closing text', fixture: { prOverrides: { body: '> Closes #2430' } }, cause: 'manager_pr_resume_link_ambiguous' },
    { name: 'foreign head repository', fixture: { prOverrides: { headRepository: { nameWithOwner: 'foreign/orchestrator-pack' } } }, cause: 'manager_pr_resume_head_mismatch' },
    { name: 'different base', fixture: { prOverrides: { baseRefName: 'release' } }, cause: 'manager_pr_resume_head_mismatch' },
    { name: 'different head branch', fixture: { prOverrides: { headRefName: 'another-branch' } }, cause: 'manager_pr_resume_head_mismatch' },
    { name: 'unpublished local head', fixture: { prOverrides: { headRefOid: '9'.repeat(40) } }, cause: 'manager_pr_resume_head_mismatch' },
    { name: 'closed PR', fixture: { prOverrides: { state: 'CLOSED' } }, cause: 'manager_pr_resume_head_mismatch' },
    { name: 'PR read unavailable', fixture: { prViewOk: false }, cause: 'manager_pr_resume_pr_unavailable' },
    { name: 'PR inventory unavailable', fixture: { prListOk: false }, cause: 'manager_pr_resume_inventory_unavailable' },
    { name: 'PR changed at final read', fixture: { prChanged: true }, cause: 'manager_pr_resume_pr_changed' },
    { name: 'local HEAD changed before new effects', fixture: { localHeadChanged: true }, cause: 'manager_pr_resume_local_changed' },
    { name: 'Task not in requested Run', fixture: { taskMembership: false }, cause: 'manager_pr_resume_task_unproven' },
  ])('refuses non-ancestor restore on $name', async ({ fixture: options, cause }) => {
    const fixture = managerReuseFixture({ ancestor: false, ...options });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1',
      managerRefresh: true, managerTaskRunId: 'run-1', issueNumber: 2430,
      worktreeSelector: 'id:repo::existing', defaultBranch: 'main',
    }, fixture.execute);
    expect(result).toMatchObject({ status: 'continue', cause });
    expect(fixture.head()).toBe('1'.repeat(40));
    expect(fixture.mergeTransitions()).toBe(0);
    expect(fixture.calls.some((args) => args[0] === 'git' && args[1] === 'merge')).toBe(false);
  });

  it('refuses PR-head resume when Issue or native Run/Task binding is absent', async () => {
    for (const missing of ['issue', 'run'] as const) {
      const fixture = managerReuseFixture({ ancestor: false });
      const result = await prepareWorktreeWithOrca({
        repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1',
        managerRefresh: true, ...(missing === 'issue' ? { managerTaskRunId: 'run-1' } : { issueNumber: 2430 }),
        worktreeSelector: 'id:repo::existing', defaultBranch: 'main',
      }, fixture.execute);
      expect(result).toMatchObject({ status: 'continue', cause: 'manager_worktree_non_ancestor' });
      expect(fixture.calls.some((args) => args[0] === 'gh')).toBe(false);
    }
  });

  it('treats an already-equal manager HEAD as success without a local update', async () => {
    const equal = '3'.repeat(40);
    const fixture = managerReuseFixture({ head: equal, originMain: equal });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack',
      taskId: 'task-1',
      worktreeSelector: 'id:repo::existing',
      managerRefresh: true,
    }, fixture.execute);
    expect(result).toMatchObject({ status: 'ok', evidence: { refresh: 'already_equal', head: equal } });
    expect(fixture.mergeTransitions()).toBe(0);
    expect(fixture.calls.some((args) => args[0] === 'git' && args[1] === 'merge')).toBe(false);
  });

  it('rejects a shared manager-local branch before fetch', async () => {
    const fixture = managerReuseFixture({ sharedBranch: true });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack',
      taskId: 'task-1',
      worktreeSelector: 'id:repo::existing',
      managerRefresh: true,
    }, fixture.execute);
    expect(result).toMatchObject({ status: 'continue', cause: 'manager_worktree_branch_not_distinct' });
    expect(fixture.calls.some((args) => args[0] === 'git' && args[1] === 'fetch')).toBe(false);
  });

  it('keeps concurrent manager refresh attempts convergent without a second worktree owner', async () => {
    const fixture = managerReuseFixture();
    const request = {
      repository: 'chetwerikoff/orchestrator-pack',
      taskId: 'task-1',
      worktreeSelector: 'id:repo::existing',
      managerRefresh: true,
    } as const;
    const [first, second] = await Promise.all([
      prepareWorktreeWithOrca(request, fixture.execute),
      prepareWorktreeWithOrca(request, fixture.execute),
    ]);
    expect([first.status, second.status].every((status) => status === 'ok' || status === 'continue')).toBe(true);
    expect(fixture.head()).toBe(fixture.originMain);
    expect(fixture.mergeTransitions()).toBe(1);
    expect(fixture.calls.some((args) => args[0] === 'orca' && args[1] === 'worktree' && args[2] === 'create')).toBe(false);
  });

  it('requires the selected default branch when creating a fresh manager worktree', async () => {
    const calls: string[][] = [];
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack',
      taskId: 'task-1',
      worktreeName: 'manager-2024',
      baseBranch: 'main',
      managerRefresh: true,
    }, async (args) => {
      calls.push([...args]);
      return { ok: false, stdout: '', stderr: '' };
    });
    expect(result).toMatchObject({ status: 'continue', cause: 'manager_worktree_selected_base_required' });
    expect(calls).toEqual([]);
  });

  it('creates a fresh manager worktree from origin/main and proves its distinct local branch', async () => {
    const calls: string[][] = [];
    const path = '/tmp/manager-2024';
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 2024,
      taskId: 'task-1',
      worktreeName: 'manager-2024',
      baseBranch: 'origin/main',
      managerRefresh: true,
    }, async (args, _timeoutMs, _env, cwd) => {
      calls.push([...args]);
      if (args[0] === 'orca' && args[1] === 'repo') {
        return { ok: true, stdout: repoListEnvelope([{
          ...registeredOrcaRepo('orca-repo-1', '/tmp/primary'),
        }]), stderr: '' };
      }
      if (args[0] === 'orca' && args[1] === 'worktree') {
        return { ok: true, stdout: okEnvelope({ worktree: { id: 'repo::manager-2024', path } }), stderr: '' };
      }
      if (cwd === '/tmp/primary' && args.join(' ') === 'git rev-parse --show-toplevel') {
        return { ok: true, stdout: '/tmp/primary\n', stderr: '' };
      }
      if (cwd === '/tmp/primary' && args.join(' ') === 'git remote get-url origin') {
        return { ok: true, stdout: 'git@github.com:chetwerikoff/orchestrator-pack.git\n', stderr: '' };
      }
      if (cwd !== path) return { ok: false, stdout: '', stderr: 'wrong cwd' };
      const command = args.join(' ');
      if (command === 'git rev-parse --show-toplevel') return { ok: true, stdout: `${path}\n`, stderr: '' };
      if (command === 'git remote get-url origin') {
        return { ok: true, stdout: 'git@github.com:chetwerikoff/orchestrator-pack.git\n', stderr: '' };
      }
      if (command === 'git worktree list --porcelain') {
        return {
          ok: true,
          stdout: [
            'worktree /tmp/primary',
            `HEAD ${'2'.repeat(40)}`,
            'branch refs/heads/main',
            '',
            `worktree ${path}`,
            `HEAD ${'2'.repeat(40)}`,
            'branch refs/heads/manager-2024',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      if (command === 'git status --porcelain=v1 --untracked-files=all') {
        return { ok: true, stdout: '', stderr: '' };
      }
      return { ok: false, stdout: '', stderr: `unexpected: ${command}` };
    });
    expect(result).toMatchObject({
      status: 'ok',
      value: { id: 'repo::manager-2024', setupWitness: 'same_invocation_complete' },
      evidence: { branch: 'manager-2024' },
    });
    expect(calls[3]).toEqual([
      'orca', 'worktree', 'create', '--repo', 'id:orca-repo-1', '--name', 'manager-2024',
      '--base-branch', 'origin/main', '--issue', '2024', '--setup', 'run', '--json',
    ]);
  });

  it('records deterministic assistant-entry and per-stage timings only', async () => {
    const clock = Array.from({ length: 40 }, (_value, index) => 1_000 + index * 10);
    const result = await runSupervisedTaskLaunchAssistant(launchInput(), deps({ clock }));
    expect(result.startedAtMs).toBe(1_000);
    expect(result.elapsedMs).toBeGreaterThan(0);
    expect(result.timings[0]).toMatchObject({ stage: 'command_preflight', elapsedMs: 10 });
    expect(result.timings.at(-1)?.stage).toBe('supervised_start');
  });

  it('records a timing for a direct handled stage failure', async () => {
    const result = await runSupervisedTaskLaunchAssistant({
      repository: 'chetwerikoff/orchestrator-pack', workClass: 'manager', taskId: 'task-1',
      worktreeName: 'issue-1479', env: profileEnv(), startMode: 'exact_terminal_worktree',
    }, deps());
    expect(result).toMatchObject({ outcome: 'continue', stage: 'manager_run', observedCause: 'manager_run_required' });
    if (result.outcome === 'continue') {
      expect(result.timings.at(-1)).toMatchObject({ stage: 'manager_run', outcome: 'continued', elapsedMs: 0 });
    }
  });

  it('CLI requires explicit work class and preserves manager argument shapes', () => {
    expect(parseLaunchAssistantCli(
      ['--project', 'orchestrator-pack', '--repository', 'chetwerikoff/orchestrator-pack', '--work-class', 'manager', '--run', 'run-1', '--task', 'task-1', '--worktree', 'id:w'],
      process.env,
      (_input: unknown) => ({
        projectId: 'orchestrator-pack',
        repository: 'chetwerikoff/orchestrator-pack',
        primaryRoot: '/fixture/target-root',
      } as ReturnType<typeof import('../lib/target-context.ts').resolveTargetContext>),
    )).toMatchObject({
      projectId: 'orchestrator-pack', repository: 'chetwerikoff/orchestrator-pack', primaryRoot: '/fixture/target-root',
      workClass: 'manager', runId: 'run-1', taskId: 'task-1', worktreeSelector: 'id:w',
    });
    expect(() => parseLaunchAssistantCli(['--repository', 'chetwerikoff/orchestrator-pack', '--work-class', 'smoke'])).toThrow(/work-class/u);
  });

  it.each([
    ['manager missing run', ['--repository', 'chetwerikoff/orchestrator-pack', '--work-class', 'manager', '--task', 'task-1', '--worktree', 'id:w']],
    ['manager both task and brief', ['--repository', 'chetwerikoff/orchestrator-pack', '--work-class', 'manager', '--run', 'run-1', '--task', 'task-1', '--manager-brief', 'brief', '--worktree', 'id:w']],
    ['manager neither task nor brief', ['--repository', 'chetwerikoff/orchestrator-pack', '--work-class', 'manager', '--run', 'run-1', '--worktree', 'id:w']],
    ['existing manager Task with name', ['--repository', 'chetwerikoff/orchestrator-pack', '--work-class', 'manager', '--run', 'run-1', '--task', 'task-1', '--worktree-name', 'wt']],
    ['fresh manager brief with selector', ['--repository', 'chetwerikoff/orchestrator-pack', '--work-class', 'manager', '--run', 'run-1', '--manager-brief', 'brief', '--worktree', 'id:w']],
    ['worker missing task', ['--repository', 'chetwerikoff/orchestrator-pack', '--work-class', 't2', '--worktree', 'id:w']],
    ['both worktree selectors', ['--repository', 'chetwerikoff/orchestrator-pack', '--work-class', 't2', '--task', 'task-1', '--worktree', 'id:w', '--worktree-name', 'wt']],
    ['neither worktree selector', ['--repository', 'chetwerikoff/orchestrator-pack', '--work-class', 't2', '--task', 'task-1']],
    ['manager-only option on worker', ['--repository', 'chetwerikoff/orchestrator-pack', '--work-class', 't2', '--task', 'task-1', '--run', 'run-1', '--worktree', 'id:w']],
  ] as const)('CLI rejects semantically malformed invocation before effects: %s', (_label, argv) => {
    expect(() => parseLaunchAssistantCli(argv)).toThrow();
  });

  it('CLI entrypoint exits non-zero for semantic shape rejected before dependencies/effects', async () => {
    const entrypoint = fileURLToPath(new URL('./supervised-task-launch-assistant.ts', import.meta.url));
    const execution = await runProcess({
      command: process.execPath,
      args: [
        '--experimental-strip-types', entrypoint,
        '--repository', 'chetwerikoff/orchestrator-pack',
        '--work-class', 'manager',
        '--run', 'run-1',
        '--manager-brief', 'brief',
      ],
      inheritParentEnv: true,
      allowEmptyStdout: true,
      timeoutMs: 5_000,
    });
    expect(execution.ok).toBe(false);
    expect(execution.exitCode).toBe(1);
    expect(execution.stdout).toBe('');
    expect(execution.stderr).toMatch(/target project|worktree/u);
  });

  it.each([
    ['partial issue number', ['--repository', 'chetwerikoff/orchestrator-pack', '--work-class', 't2', '--issue-number', '12abc']],
    ['duplicate option', ['--repository', 'chetwerikoff/orchestrator-pack', '--work-class', 't2', '--task', 'task-1', '--task', 'task-2']],
    ['unknown option', ['--repository', 'chetwerikoff/orchestrator-pack', '--work-class', 't2', '--unexpected', 'value']],
  ] as const)('CLI rejects malformed invocation: %s', (_label, argv) => {
    expect(() => parseLaunchAssistantCli(argv)).toThrow();
  });
});


describe('Issue #2461 bounded pack OpenCode primary probe', () => {
  const args = ['--project', 'orchestrator-pack', '--work-class', 'manager',
    '--start-mode', 'exact_terminal_worktree', '--timeout-ms', '50000'];

  it('rejects unrelated work class, provider route, arguments and zero budget before an action', () => {
    expect(parseOpenCodePrimaryProbeArgs(args)).toEqual({ projectId: 'orchestrator-pack', timeoutMs: 50_000 });
    for (const bad of [
      [...args.slice(0, 3), 't2', ...args.slice(4)],
      [...args.slice(0, 5), 'provider_new_top_level', ...args.slice(6)],
      [...args.slice(0, -1), '0'],
      [...args, '--repository', 'other/repo'],
    ]) expect(() => parseOpenCodePrimaryProbeArgs(bad)).toThrow();
  });

  function syntheticTarget(root: string) {
    return {
      projectId: 'orchestrator-pack', repository: 'chetwerikoff/orchestrator-pack',
      primaryRoot: root,
    } as ReturnType<typeof import('../lib/target-context.ts').resolveTargetContext>;
  }

  it('passes only an adopted pack manager OpenCode route, watches actual debug config and removes owned scratch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk2461-primary-'));
    const scratch = join(tmpdir(), `opk-opencode-state-${randomUUID()}`);
    const commands: string[] = [];
    let persistentState = 'unchanged';
    const profile = await resolveLiveExecutorProfile('manager', opencodeProfileEnv('manager'), 'exact_terminal_worktree', async (args) => opencodeProbeResult(args, true));
    if (profile.status !== 'ok') throw new Error('fixture profile failed');
    try {
      const result = await runOpenCodePrimaryProbe(args, {
        resolveTarget: () => syntheticTarget(root),
        resolveProfile: async (_class, _env, _mode, execute) => {
          const catalog = await execute(['opencode', 'models'], 5000);
          if (!catalog.ok) throw new Error('synthetic catalog failed');
          return profile;
        },
        finalizeProfile: async (selected, primaryRoot, execute) => {
          expect(primaryRoot).toBe(root);
          await execute(['opencode', 'debug', 'config'], 5000, { XDG_STATE_HOME: scratch }, primaryRoot);
          return { status: 'ok', value: selected, evidence: { exactContext: true } };
        },
        execute: async (command, timeoutMs, env, cwd) => {
          expect(timeoutMs).toBeGreaterThan(0);
          expect(cwd).toBe(root);
          expect(env?.XDG_CACHE_HOME).toMatch(/opk-launch-canary-/u);
          commands.push(command.join(' '));
          if (command[2] === 'config') {
            mkdirSync(scratch, { recursive: true });
            writeFileSync(join(scratch, 'scratch'), 'owned');
          }
          return { ok: true, stdout: 'synthetic', stderr: '' };
        },
        snapshot: () => persistentState,
      }, opencodeProfileEnv('manager'));
      expect(result).toMatchObject({
        route: 'manager/opencode/exact_terminal_worktree', outcome: 'pass',
        reason: 'installed_primary_context_verified', cleanup_verified: true,
      });
      expect(commands).toEqual(['opencode models', 'opencode debug config']);
      expect(existsSync(scratch)).toBe(false);
      expect(persistentState).toBe('unchanged');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails before any executor action on a non-OpenCode manager selection or wrong pack card', async () => {
    const execute = vi.fn(async () => ({ ok: true, stdout: 'irrelevant', stderr: '' }));
    const root = mkdtempSync(join(tmpdir(), 'opk2461-reject-'));
    try {
      const refused = await runOpenCodePrimaryProbe(args, {
        resolveTarget: () => syntheticTarget(root),
        execute,
      }, profileEnv());
      expect(refused).toMatchObject({ outcome: 'incomplete', reason: 'manager_opencode_profile_unverified' });
      const wrong = await runOpenCodePrimaryProbe(args, {
        resolveTarget: () => ({ ...syntheticTarget(root), repository: 'foreign/repository' }),
        execute,
      }, opencodeProfileEnv('manager'));
      expect(wrong).toMatchObject({ outcome: 'incomplete', reason: 'selected_pack_card_mismatch' });
      expect(execute).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('flags a persistent config write, timeout and never starts an Orca Task or terminal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk2461-snapshot-'));
    const profile = await resolveLiveExecutorProfile('manager', opencodeProfileEnv('manager'), 'exact_terminal_worktree', async (args) => opencodeProbeResult(args, true));
    if (profile.status !== 'ok') throw new Error('fixture profile failed');
    let persistentState = 'before';
    const calls: string[][] = [];
    try {
      const result = await runOpenCodePrimaryProbe(args, {
        resolveTarget: () => syntheticTarget(root),
        resolveProfile: async (_class, _env, _mode, execute) => {
          await execute(['opencode', 'debug', 'config'], 2000);
          return profile;
        },
        execute: async (command) => {
          calls.push([...command]);
          persistentState = 'changed';
          return { ok: true, stdout: '', stderr: '' };
        },
        snapshot: () => persistentState,
      }, opencodeProfileEnv('manager'));
      expect(result).toMatchObject({ outcome: 'incomplete', reason: 'persistent_config_changed' });
      expect(calls).toEqual([['opencode', 'debug', 'config']]);
      expect(calls.some((c) => c.includes('orca') || c.includes('start') || c.includes('spawn'))).toBe(false);

      let now = 0;
      const timeout = await runOpenCodePrimaryProbe(
        [...args.slice(0, -1), '100'],
        {
          now: () => (now += 150),
          resolveTarget: () => syntheticTarget(root),
          snapshot: () => 'constant',
          execute: async () => ({ ok: true, stdout: '', stderr: '' }),
        },
        opencodeProfileEnv('manager'),
      );
      expect(timeout).toMatchObject({ outcome: 'incomplete', reason: 'probe_timeout' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('machine-local executor profile store', () => {
  it('overlays fenced values once, with store values winning in task resolution', () => {
    let reads = 0;
    const env = {
      PATH: '/operator/bin',
      PACK_EXECUTOR_T2_AGENT: 'cursor-agent',
      PACK_EXECUTOR_T2_MODEL: 'live-task-model',
      PACK_EXECUTOR_T2_EFFORT: 'live-task-effort',
      PACK_EXECUTOR_SMOKE_ROUTINE_AGENT: 'cursor',
      PACK_EXECUTOR_SMOKE_ROUTINE_MODEL: 'live-smoke-model',
      PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT: 'live-smoke-effort',
    };
    const effectiveEnv = overlayExecutorProfileEnv(env, {
      storePath: '/operator/executor-profiles.env',
      readFile: () => {
        reads += 1;
        return [
          '# operator-owned profiles',
          'PACK_EXECUTOR_T2_AGENT=cursor-agent',
          'PACK_EXECUTOR_T2_MODEL=store-task-model',
          'PACK_EXECUTOR_T2_EFFORT=store-task-effort',
          'PACK_EXECUTOR_SMOKE_ROUTINE_AGENT=cursor',
          'PACK_EXECUTOR_SMOKE_ROUTINE_MODEL=store-smoke-model',
          'PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT=store-smoke-effort',
        ].join('\n');
      },
    });

    expect(reads).toBe(1);
    expect(effectiveEnv.PATH).toBe('/operator/bin');
    expect(resolveExecutorProfile('t2', effectiveEnv, 'exact_terminal_worktree')).toMatchObject({
      status: 'ok',
      value: { launchCommand: "cursor-agent --model 'store-task-model-store-task-effort'" },
    });

  });

  it('keeps explicit PACK_EXECUTOR_MANAGER_AGENT, MODEL, and EFFORT through the launch overlay', () => {
    const env = {
      PATH: '/operator/bin',
      PACK_EXECUTOR_FF_LOCAL_AGENT: 'cursor-agent',
      PACK_EXECUTOR_FF_LOCAL_MODEL: 'grok-4.7',
      PACK_EXECUTOR_FF_LOCAL_EFFORT: 'high',
      PACK_EXECUTOR_MANAGER_AGENT: 'cursor-agent',
      PACK_EXECUTOR_MANAGER_MODEL: 'grok-4.7',
      PACK_EXECUTOR_MANAGER_EFFORT: 'high',
    };
    const effectiveEnv = overlayExecutorProfileEnv(env, {
      storePath: '/operator/executor-profiles.env',
      readFile: () => [
        'PACK_EXECUTOR_MANAGER_AGENT=opencode',
        'PACK_EXECUTOR_MANAGER_MODEL=openai/gpt-6-luna',
        'PACK_EXECUTOR_MANAGER_EFFORT=medium',
      ].join('\n'),
    });

    expect(effectiveEnv.PACK_EXECUTOR_MANAGER_AGENT).toBe('cursor-agent');
    expect(effectiveEnv.PACK_EXECUTOR_MANAGER_MODEL).toBe('grok-4.7');
    expect(effectiveEnv.PACK_EXECUTOR_MANAGER_EFFORT).toBe('high');
    expect(resolveExecutorProfile('manager', effectiveEnv, 'exact_terminal_worktree')).toMatchObject({
      status: 'ok',
      value: { family: 'cursor', launchCommand: "cursor-agent --model 'grok-4.7-high'" },
    });
  });

  it('rejects a foreign key before applying any store values and never changes PATH', () => {
    const env = { PATH: '/operator/bin', PACK_EXECUTOR_T2_MODEL: 'live-model' };
    expect(() => overlayExecutorProfileEnv(env, {
      storePath: '/operator/executor-profiles.env',
      readFile: () => 'PACK_EXECUTOR_T2_MODEL=store-model\nPATH=/unsafe/bin\n',
    })).toThrow('executor_profile_store_malformed:line=2:key=PATH');
    expect(env).toEqual({ PATH: '/operator/bin', PACK_EXECUTOR_T2_MODEL: 'live-model' });
  });

  it('treats a missing store as no overlay', () => {
    const env = { PATH: '/operator/bin' };
    const missing = () => {
      const error = new Error('missing') as Error & { code?: string };
      error.code = 'ENOENT';
      throw error;
    };
    expect(readExecutorProfileStore({ storePath: '/operator/missing/executor-profiles.env', readFile: missing })).toEqual({});
    expect(overlayExecutorProfileEnv(env, { storePath: '/operator/missing/executor-profiles.env', readFile: missing })).toBe(env);
  });
});

describe('Issue #2655 terminal same-Task start and lossless dirty reuse', () => {
  const nativeGone = (state: 'failed' | 'abandoned' | 'cancelled' | 'done' | 'completed') =>
    async (assignment: WorkerAssignment) => ({
      taskId: assignment.taskId, dispatchId: assignment.bindingKey,
      dispatchState: state, workerAbsent: true as const, worktreeId: 'repo::exact-worktree',
    });

  const terminal = (status: string): DispatchObservation => ({
    kind: 'present', dispatchId: 'ctx_3761867313e2', status,
  });
  const owned = (): WorkerAssignment => ({
    ...readyStart('task-1').assignment,
    role: 'worker',
    bindingKey: 'ctx_3761867313e2',
  } as WorkerAssignment);

  it.each(['failed', 'abandoned', 'cancelled', 'done', 'completed'] as const)(
    'allows the exact %s current Dispatch at both new-start observations', async (status) => {
      let starts = 0;
      const launched = await runSupervisedTaskLaunchAssistant(launchInput('t2'), deps({
        currentAssignment: owned(), dispatch: [terminal(status), terminal(status)],
        proveTerminalGone: nativeGone(status),
        onSupervised: () => { starts += 1; },
      }));
      expect(launched).toMatchObject({
        outcome: 'ready', resources: { taskId: 'task-1', dispatchId: 'dispatch-1' },
      });
      expect(starts).toBe(1);
    },
  );

  it.each([
    { name: 'still-dispatched', early: terminal('dispatched'), final: terminal('dispatched') },
    { name: 'foreign Dispatch', early: { kind: 'present', dispatchId: 'foreign', status: 'failed' }, final: terminal('failed') },
    { name: 'unknown status', early: { kind: 'present', dispatchId: 'ctx_3761867313e2' }, final: terminal('failed') },
  ] as const)('refuses $name without starting an additional worker', async ({ early, final }) => {
    let spawns = 0;
    let starts = 0;
    const launched = await runSupervisedTaskLaunchAssistant(launchInput('t2'), deps({
      currentAssignment: owned(), dispatch: [early, final],
      adapter: runtimeAdapter({ onSpawn: () => { spawns += 1; } }),
      onSupervised: () => { starts += 1; },
    }));
    expect(launched).toMatchObject({
      outcome: 'continue', stage: 'dispatch_admission_early', observedCause: 'fresh_dispatch_not_absent',
    });
    expect(spawns).toBe(0);
    expect(starts).toBe(0);
  });

  it.each(['missing', 'foreign', 'stale-state'] as const)(
    'refuses %s terminal-gone proof before worktree or new terminal effects', async (caseName) => {
      let prepares = 0; let spawns = 0; let starts = 0;
      const old = owned();
      const actual = nativeGone('completed');
      const proof: NonNullable<LaunchDependencies['proveTerminalGone']> = async (assignment) => {
        if (caseName === 'missing') return null;
        const witness = await actual(assignment);
        return caseName === 'foreign'
          ? { ...witness, dispatchId: 'ctx_foreign' }
          : { ...witness, dispatchState: 'failed' };
      };
      const launched = await runSupervisedTaskLaunchAssistant(launchInput('t2'), {
        ...deps({
          currentAssignment: old,
          dispatch: [terminal('completed'), terminal('completed')],
          adapter: runtimeAdapter({ onSpawn: () => { spawns += 1; } }),
          onWorktree: () => { prepares += 1; },
          onSupervised: () => { starts += 1; },
          proveTerminalGone: proof,
        }),
      });
      expect(launched).toMatchObject({
        outcome: 'continue', stage: 'dispatch_admission_early', observedCause: 'fresh_dispatch_not_absent',
      });
      expect(prepares).toBe(0);
      expect(spawns).toBe(0);
      expect(starts).toBe(0);
    },
  );

  it('refuses a Dispatch that becomes live or changes after terminal early witness', async () => {
    let starts = 0;
    const launched = await runSupervisedTaskLaunchAssistant(launchInput('t2'), deps({
      currentAssignment: owned(), dispatch: [terminal('failed'), terminal('dispatched')],
      proveTerminalGone: nativeGone('failed'),
      onSupervised: () => { starts += 1; },
    }));
    expect(launched).toMatchObject({
      outcome: 'continue', stage: 'dispatch_admission_final', observedCause: 'fresh_dispatch_not_absent',
    });
    expect(starts).toBe(0);
  });

  it('recovers dirty manager without an existing PR only from exact native Run/Task and old worktree', async () => {
    const fixture = managerReuseFixture({ noPr: true, status: ' M tests/test_database_guard.py\n' });
    const expected = {
      ...readyStart('task_old').assignment,
      role: 'orchestrator',
      issueNumber: 2430, taskId: 'task_old', bindingKey: 'ctx_2055f1bb0511',
    } as WorkerAssignment;
    const execute: typeof fixture.execute = async (argv, timeout, env, cwd) => {
      if (argv[0] === 'orca' && argv[1] === 'orchestration') {
        if (argv[2] === 'dispatch-show') {
          expect(argv).toContain('task_old');
          return { ok: true, stdout: okEnvelope({
            dispatch: { id: 'ctx_2055f1bb0511', status: 'failed' },
          }) };
        }
        if (argv[2] === 'worker-show') {
          expect(argv).toContain('ctx_2055f1bb0511');
          return { ok: true, stdout: okEnvelope({
            dispatch: { status: 'failed' },
            worker: { worktree_id: 'repo::existing', state: 'abandoned', stage: 'terminal_missing' },
            terminal: null, observation: { exactWorker: false, status: 'missing' },
          }) };
        }
      }
      return fixture.execute(argv, timeout, env, cwd);
    };
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', issueNumber: 2430,
      taskId: 'task-1', worktreeSelector: 'id:repo::existing',
      managerTaskRunId: 'run-1', managerRefresh: true, defaultBranch: 'main',
      reuseAssignment: expected,
    }, execute);
    expect(result).toMatchObject({
      status: 'ok', evidence: {
        reuse: 'dirty_preserved', previousDispatchId: 'ctx_2055f1bb0511',
      },
    });
    expect(fixture.calls.some((argv) => argv[0] === 'gh')).toBe(false);
    expect(fixture.calls.some((argv) =>
      argv[0] === 'git' && ['merge', 'reset', 'stash', 'clean'].includes(argv[1]!))).toBe(false);
    expect(fixture.head()).toBe('1'.repeat(40));
  });

  it('does not launch a foreign manager from an unbound dirty PR with a byte-identical 14-line test diff', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-2655-dirty-worktree-'));
    const testFile = join(root, 'tests', 'test_database_guard.py');
    const untracked = join(root, 'migration-backup.diff');
    try {
      mkdirSync(join(root, 'tests'), { recursive: true });
      writeFileSync(testFile, Array.from({ length: 14 }, (_value, index) =>
        `# preserved reboot change ${index + 1}\n`).join(''));
      writeFileSync(untracked, 'diff --git a/old b/new\n+do not delete\n');
      const beforeTest = readFileSync(testFile);
      const beforeUntracked = readFileSync(untracked);
      const dirty = ' M tests/test_database_guard.py\n?? migration-backup.diff\n';
      const fixture = managerReuseFixture({
        worktreeId: 'manager-worktree', worktreePath: root, status: dirty,
      });
      let starts = 0;
      const result = await runSupervisedTaskLaunchAssistant({
        ...launchInput('manager'), issueNumber: 2430, defaultBranch: 'main',
      }, {
        ...deps({
          adapter: runtimeAdapter({ worker: { ...worker, workspacePath: root } }),
          onSupervised: () => { starts += 1; },
        }),
        prepareWorktree: (request) => prepareWorktreeWithOrca(request, fixture.execute),
      });
      expect(result).toMatchObject({
        outcome: 'continue', stage: 'worktree_prepare', observedCause: 'worktree_reuse_ownership_unproven',
      });
      expect(starts).toBe(0);
      expect(readFileSync(testFile)).toEqual(beforeTest);
      expect(readFileSync(untracked)).toEqual(beforeUntracked);
      expect(fixture.head()).toBe('1'.repeat(40));
      expect(fixture.mergeTransitions()).toBe(0);
      expect(fixture.calls.filter((argv) =>
        argv.join(' ') === 'git status --porcelain=v1 --untracked-files=all')).toHaveLength(1);
      expect(fixture.calls.some((argv) =>
        argv[0] === 'git' && ['merge', 'reset', 'stash', 'rebase'].includes(argv[1]!))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a dirty PR-only checkout without native Task ownership', async () => {
    const dirty = ' M tests/test_database_guard.py\n?? migration-backup.diff\n';
    const fixture = managerReuseFixture({ status: dirty });
    const outcome = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1',
      managerRefresh: true, managerTaskRunId: 'run-1', issueNumber: 2430,
      worktreeSelector: 'id:repo::existing', defaultBranch: 'main',
    }, fixture.execute);
    expect(outcome).toMatchObject({ status: 'continue', cause: 'worktree_reuse_ownership_unproven' });
    expect(fixture.head()).toBe('1'.repeat(40));
    expect(fixture.mergeTransitions()).toBe(0);
    expect(fixture.calls.filter((argv) => argv.join(' ') === 'git status --porcelain=v1 --untracked-files=all')).toHaveLength(1);
    expect(fixture.calls.some((argv) => argv[0] === 'git' && ['merge', 'reset', 'rebase'].includes(argv[1]!))).toBe(false);
  });

  it('refuses a dirty foreign PR and a dirty manager with no exact Run/Task authorization', async () => {
    for (const options of [{ prOverrides: { headRefOid: '9'.repeat(40) } }, { noPr: true }]) {
      const fixture = managerReuseFixture({ status: ' M tests/test_database_guard.py\n', ...options });
      const outcome = await prepareWorktreeWithOrca({
        repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1',
        managerRefresh: true, managerTaskRunId: 'run-1', issueNumber: 2430,
        worktreeSelector: 'id:repo::existing', defaultBranch: 'main',
      }, fixture.execute);
      expect(outcome.status).toBe('continue');
      expect(fixture.mergeTransitions()).toBe(0);
    }
    const fixture = managerReuseFixture({ status: ' M tests/test_database_guard.py\n' });
    const outcome = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', taskId: 'task-1',
      managerRefresh: true, worktreeSelector: 'id:repo::existing',
    }, fixture.execute);
    expect(outcome).toMatchObject({ status: 'continue', cause: 'worktree_reuse_ownership_unproven' });
    expect(fixture.mergeTransitions()).toBe(0);
  });
  it('refuses fresh dirty manager worktree after setup without erasing test changes', async () => {
    const root = '/tmp/fresh-manager';
    const dirty = ' M tests/test_database_guard.py\n';
    const commands: string[][] = [];
    const outcome = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack',
      taskId: 'task-1', issueNumber: 2655,
      worktreeName: 'fresh-manager', baseBranch: 'origin/main', managerRefresh: true,
    }, async (argv, _timeout, _env, cwd) => {
      commands.push([...argv]);
      const joined = argv.join(' ');
      if (joined === 'orca repo list --json')
        return { ok: true, stdout: repoListEnvelope([registeredOrcaRepo('orca-repo-1', '/tmp/primary')]) };
      if (joined === 'git rev-parse --show-toplevel')
        return { ok: true, stdout: (cwd ?? '') + '\n' };
      if (joined === 'git remote get-url origin')
        return { ok: true, stdout: 'git@github.com:chetwerikoff/orchestrator-pack.git\n' };
      if (joined.startsWith('orca worktree create '))
        return { ok: true, stdout: okEnvelope({ worktree: { id: 'repo::fresh-manager', path: root } }) };
      if (joined === 'git worktree list --porcelain')
        return { ok: true, stdout: [
          'worktree /tmp/primary', `HEAD ${'2'.repeat(40)}`, 'branch refs/heads/main', '',
          `worktree ${root}`, `HEAD ${'2'.repeat(40)}`, 'branch refs/heads/fresh-manager', '',
        ].join('\n') };
      if (joined === 'git status --porcelain=v1 --untracked-files=all')
        return { ok: true, stdout: dirty };
      return { ok: false, stdout: '', stderr: 'unexpected ' + joined };
    });
    expect(outcome).toMatchObject({ status: 'continue', cause: 'manager_worktree_dirty' });
    expect(commands.some((argv) => argv[0] === 'git' && ['merge', 'reset', 'rebase', 'stash'].includes(argv[1]!))).toBe(false);
    expect(commands.some((argv) => argv.join(' ') === 'git status --porcelain=v1 --untracked-files=all')).toBe(true);
  });

});

describe('Issue #2655 worker existing-worktree relaunch', () => {
  const bound = (): WorkerAssignment => ({
    ...readyStart('task_original').assignment,
    role: 'worker',
    issueNumber: 1479, taskId: 'task_original', bindingKey: 'ctx_3761867313e2',
  } as WorkerAssignment);

  it('preserves the exact 14-line diff and untracked bytes on a fresh Task in the old worker worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-2655-worker-reboot-'));
    const testFile = join(root, 'tests', 'test_database_guard.py');
    const untracked = join(root, 'migration-backup.diff');
    try {
      mkdirSync(join(root, 'tests'), { recursive: true });
      writeFileSync(testFile, Array.from({ length: 14 }, (_line, n) => `# edit ${n + 1}\n`).join(''));
      writeFileSync(untracked, 'untracked work preserved\n');
      const before = readFileSync(testFile);
      const beforeUntracked = readFileSync(untracked);
      const fixture = managerReuseFixture({
        worktreeId: 'repo::existing', worktreePath: root,
        status: ' M tests/test_database_guard.py\n?? migration-backup.diff\n',
      });
      const inspected: string[][] = [];
      const execute: typeof fixture.execute = async (argv, timeout, env, cwd) => {
        if (argv[0] === 'orca' && argv[1] === 'orchestration') {
          inspected.push([...argv]);
          if (argv[2] === 'dispatch-show') {
            return { ok: true, stdout: okEnvelope({
              dispatch: { id: 'ctx_3761867313e2', status: 'failed' },
            }) };
          }
          if (argv[2] === 'worker-show') {
            return { ok: true, stdout: okEnvelope({
              dispatch: { status: 'failed' },
              worker: { worktree_id: 'repo::existing', state: 'abandoned', stage: 'terminal_missing' },
              terminal: null, observation: { exactWorker: false, status: 'missing' },
            }) };
          }
        }
        return fixture.execute(argv, timeout, env, cwd);
      };
      let started = 0;
      const outcome = await runSupervisedTaskLaunchAssistant({
        ...launchInput('t2'),
        taskId: 'task_6af384b00044', worktreeName: undefined, worktreeSelector: 'id:repo::existing',
      }, {
        ...deps({
          currentAssignment: bound(),
          adapter: runtimeAdapter({ worker: { ...worker, workspacePath: root } }),
          onSupervised: () => { started += 1; },
        }),
        prepareWorktree: (request) => prepareWorktreeWithOrca(request, execute),
      });
      expect(outcome).toMatchObject({
        outcome: 'ready', resources: { taskId: 'task_6af384b00044', worktreePath: root },
      });
      expect(started).toBe(1);
      expect(inspected.map((call) => call.slice(0, 3))).toEqual([
        ['orca', 'orchestration', 'dispatch-show'], ['orca', 'orchestration', 'worker-show'],
      ]);
      expect(readFileSync(testFile)).toEqual(before);
      expect(readFileSync(untracked)).toEqual(beforeUntracked);
      expect(fixture.mergeTransitions()).toBe(0);
      expect(fixture.head()).toBe('1'.repeat(40));
      expect(fixture.calls.some((argv) =>
        argv[0] === 'git' && ['merge', 'reset', 'stash', 'rebase'].includes(argv[1]!))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['foreign owner', 'live worker', 'unverified worktree'] as const)(
    'rejects %s before worker effects', async (scenario) => {
      const fixture = managerReuseFixture({ status: ' M tests/test_database_guard.py\n' });
      const execute: typeof fixture.execute = async (argv, timeout, env, cwd) => {
        if (argv[0] === 'orca' && argv[1] === 'orchestration') {
          if (argv[2] === 'dispatch-show') {
            return { ok: true, stdout: okEnvelope({
              dispatch: { id: 'ctx_3761867313e2', status: scenario === 'live worker' ? 'dispatched' : 'failed' },
            }) };
          }
          return { ok: true, stdout: okEnvelope({
            dispatch: { status: 'failed' },
            worker: {
              worktree_id: scenario === 'foreign owner' ? 'repo::foreign'
                : scenario === 'unverified worktree' ? null : 'repo::existing',
              state: 'abandoned', stage: 'terminal_missing',
            },
            terminal: null, observation: { exactWorker: false, status: 'missing' },
          }) };
        }
        return fixture.execute(argv, timeout, env, cwd);
      };
      const response = await prepareWorktreeWithOrca({
        repository: 'chetwerikoff/orchestrator-pack', issueNumber: 1479,
        taskId: 'task_new', worktreeSelector: 'id:repo::existing',
        baseBranch: 'origin/main', defaultBranch: 'main',
        reuseAssignment: bound(),
      }, execute);
      expect(response).toMatchObject({ status: 'continue', cause: 'worktree_reuse_ownership_unproven' });
      expect(fixture.mergeTransitions()).toBe(0);
    },
  );
});

describe('Issue #2655 real parsed Cursor reboot route', () => {
  const target = () => ({
    projectId: 'orchestrator-pack', repository: 'chetwerikoff/orchestrator-pack',
    primaryRoot: '/tmp/primary', defaultBranch: 'main',
  } as ReturnType<typeof import('../lib/target-context.ts').resolveTargetContext>);

  it('chooses exact mode for worker and manager --worktree and refuses conflicting provider route', () => {
    for (const workClass of ['t2', 'manager'] as const) {
      const argv = [
        '--project', 'orchestrator-pack', '--work-class', workClass,
        '--issue-number', '2655',
        ...(workClass === 'manager' ? ['--run', 'run-1'] : []),
        '--task', 'task_new', '--worktree', 'id:repo::existing',
      ];
      expect(parseLaunchAssistantCli(argv, profileEnv(), target).startMode)
        .toBe('exact_terminal_worktree');
      expect(() => parseLaunchAssistantCli([...argv, '--start-mode', 'provider_new_top_level'],
        profileEnv(), target)).toThrow(/exact_terminal_worktree/u);
    }
  });

  it('launches actual supervised start from parsed CLI and native absent Dispatch while preserving dirty bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-2655-real-cli-'));
    const edited = join(root, 'tests', 'test_database_guard.py');
    const untracked = join(root, 'local.patch');
    try {
      mkdirSync(join(root, 'tests'), { recursive: true });
      writeFileSync(edited, Array.from({ length: 14 }, (_line, index) =>
        '# kept change ' + (index + 1) + '\n').join(''));
      writeFileSync(untracked, 'uncommitted bytes stay here\n');
      const before = readFileSync(edited);
      const beforeUntracked = readFileSync(untracked);
      const env = profileEnv({ OPK_BASE_DIR: root });
      const input = {
        ...parseLaunchAssistantCli([
          '--project', 'orchestrator-pack', '--work-class', 't2', '--issue-number', '2655',
          '--task', 'task_6af384b00044', '--worktree', 'id:repo::existing',
        ], env, target), env,
      };
      const file = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
      const prev = await publishCurrentWorkerAssignment({
        file, projectId: 'orchestrator-pack', repository: 'chetwerikoff/orchestrator-pack',
        issueNumber: 2655, taskId: 'task_old', kind: 'local', provider: 'orca',
        bindingKey: 'ctx_3761867313e2', role: 'worker',
      });
      if (!prev.ok) throw new Error(prev.reason);
      const fixture = managerReuseFixture({
        worktreePath: root, status: ' M tests/test_database_guard.py\n?? local.patch\n',
      });
      const nativeCalls: string[][] = [];
      const oldShow = {
        dispatch: { status: 'failed', last_heartbeat_at: null },
        worker: { state: 'abandoned', stage: 'terminal_missing', worktree_id: 'repo::existing' },
        terminal: null, observation: { exactWorker: false, status: 'missing' },
      };
      const inspect = async (argv: readonly string[]) => {
        nativeCalls.push([...argv]);
        if (argv[0] === 'orchestration' && argv[1] === 'dispatch-show') return {
          ok: true, stdout: okEnvelope({ dispatch: { id: 'ctx_3761867313e2', status: 'failed' } }),
        };
        if (argv[0] === 'orchestration' && argv[1] === 'worker-show') return {
          ok: true, stdout: okEnvelope(oldShow),
        };
        if (argv[0] === 'terminal' && argv[1] === 'show') return {
          ok: true, stdout: okEnvelope({ terminal: { handle: 'term-new', worktreeId: 'repo::existing' } }),
        };
        if (argv[0] === 'worktree' && argv[1] === 'show') return {
          ok: true, stdout: okEnvelope({ worktree: { id: 'repo::existing', path: root } }),
        };
        return { ok: false, stdout: '', stderr: 'unexpected native read' };
      };
      const execute = async (argv: readonly string[], timeout?: number,
        extraEnv?: Readonly<NodeJS.ProcessEnv>, cwd?: string) =>
        argv[0] === 'orca' && argv[1] === 'orchestration'
          ? inspect(argv.slice(1)) : fixture.execute(argv, timeout, extraEnv, cwd);
      const live = { ...worker, identity: {
        runtime: 'orca', id: 'term-new', generation: 'pty-new',
      }, workspacePath: root };
      const adapter = runtimeAdapter({ worker: live });
      Object.defineProperty(adapter, 'resolveAssignmentWorker', {
        value: vi.fn(() => ({
          status: 'failed', operation: 'resolve_assignment_worker', reason: 'assignment_target_unresolved',
        })),
      });
      Object.defineProperty(adapter, 'observeAssignmentLifecycle', {
        value: vi.fn(() => ({
          status: 'failed', operation: 'resolve_assignment_worker', reason: 'assignment_target_unresolved',
        })),
      });
      const selectedModes: string[] = [];
      let realStarts = 0;
      const outcome = await runSupervisedTaskLaunchAssistant(input, {
        ...deps({ adapter, currentAssignment: prev.assignment }),
        resolveProfile: (workClass, inherited, mode) => {
          selectedModes.push(mode ?? 'default');
          return resolveLiveExecutorProfile(workClass, inherited, mode, async (argv) => ({
            ok: true, stdout: argv[0] === 'cursor-agent' ? 'model-medium\n' : '',
          }));
        },
        prepareWorktree: (request) => prepareWorktreeWithOrca(request, execute),
        runSupervisedStart: (start) => runSupervisedWorkerStart({
          ...start, inspect, execute: async () => {
            realStarts += 1;
            return { ok: true, stdout: okEnvelope({
              taskId: 'task_6af384b00044', dispatchId: 'dispatch-new', state: 'ready',
              effects: [
                { kind: 'worktree', action: 'reused', id: 'repo::existing' },
                { kind: 'setup', action: 'not_applicable', state: 'not_applicable' },
                { kind: 'terminal', role: 'agent', action: 'reused', id: 'term-new' },
                { kind: 'dispatch_input', role: 'agent', id: 'term-new', state: 'accepted' },
              ],
            }) };
          },
        }),
      });
      expect(outcome).toMatchObject({ outcome: 'ready', resources: {
        taskId: 'task_6af384b00044', dispatchId: 'dispatch-new', worktreePath: root,
      } });
      expect(selectedModes).toEqual(['exact_terminal_worktree']);
      expect(realStarts).toBe(1);
      expect(currentWorkerAssignment(file, 2655)).toMatchObject({
        bindingKey: 'dispatch-new', generation: prev.assignment.generation + 1,
      });
      expect(nativeCalls.some((argv) =>
        argv[0] === 'orchestration' && argv[1] === 'worker-show')).toBe(true);
      expect(readFileSync(edited)).toEqual(before);
      expect(readFileSync(untracked)).toEqual(beforeUntracked);
      expect(fixture.mergeTransitions()).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Issue #2655 provider safety and same-unit dirty ownership', () => {
  it('uses the split setup for fresh default Cursor mode and rejects a dirty setup hook before input', async () => {
    const env = profileEnv();
    const selected = resolveExecutorProfile('t2', env);
    expect(selected).toMatchObject({ status: 'ok',
      value: { family: 'cursor', route: 'provider_new_top_level' } });
    const cli = parseLaunchAssistantCli([
      '--project', 'orchestrator-pack', '--work-class', 't2',
      '--issue-number', '2655', '--task', 'task-new', '--worktree-name', 'issue-2655',
    ], env, () => ({
      projectId: 'orchestrator-pack', repository: 'chetwerikoff/orchestrator-pack',
      primaryRoot: '/tmp/primary', defaultBranch: 'main',
    } as ReturnType<typeof import('../lib/target-context.ts').resolveTargetContext>));
    expect(cli.startMode).toBeUndefined();
    const fixture = freshRepoFixture({
      setupState: 'running',
      freshStatus: ' M tests/test_database_guard.py\n?? setup-hook.txt\n',
    });
    let spawns = 0;
    let starts = 0;
    const result = await runSupervisedTaskLaunchAssistant({ ...cli, env }, {
      ...deps({
        adapter: runtimeAdapter({ onSpawn: () => { spawns += 1; } }),
        onSupervised: () => { starts += 1; },
      }),
      prepareWorktree: (request) => prepareWorktreeWithOrca(request, fixture.execute),
    });
    expect(result).toMatchObject({ outcome: 'continue',
      stage: 'worktree_prepare', observedCause: 'worktree_fresh_dirty' });
    expect(fixture.calls.some((call) =>
      call.argv[0] === 'orca' && call.argv[1] === 'worktree' && call.argv[2] === 'create')).toBe(true);
    expect(fixture.calls.some((call) =>
      call.argv[0] === 'orca' && call.argv[1] === 'terminal' && call.argv[2] === 'wait')).toBe(true);
    expect(fixture.calls.some((call) =>
      call.argv.join(' ') === 'git status --porcelain=v1 --untracked-files=all')).toBe(true);
    expect(spawns).toBe(0);
    expect(starts).toBe(0);
  });

  it.each(['manager onto worker', 'worker onto manager'] as const)(
    'rejects %s on a matching Issue and dirty worktree', async (name) => {
      const isManager = name === 'manager onto worker';
      const fixture = managerReuseFixture({ status: ' M tests/test_database_guard.py\n' });
      const previous = {
        ...readyStart('task_old').assignment, taskId: 'task_old', issueNumber: 2655,
        role: isManager ? 'worker' : 'orchestrator',
        bindingKey: 'ctx_3761867313e2',
      } as WorkerAssignment;
      const result = await prepareWorktreeWithOrca({
        repository: 'chetwerikoff/orchestrator-pack', issueNumber: 2655,
        taskId: 'task-1', worktreeSelector: 'id:repo::existing',
        managerRefresh: isManager, ...(isManager ? { managerTaskRunId: 'run-1' } : {}),
        defaultBranch: 'main', reuseAssignment: previous,
      }, fixture.execute);
      expect(result).toMatchObject({ status: 'continue', cause: 'worktree_reuse_ownership_unproven' });
      expect(fixture.calls.some((argv) =>
        argv[0] === 'git' && ['merge', 'reset', 'stash', 'clean'].includes(argv[1]!))).toBe(false);
    },
  );

  it('refuses a foreign manager Task whose Issue-closing PR happens to name its dirty branch', async () => {
    const fixture = managerReuseFixture({ status: ' M tests/test_database_guard.py\n' });
    const result = await prepareWorktreeWithOrca({
      repository: 'chetwerikoff/orchestrator-pack', issueNumber: 2430,
      taskId: 'task-1', worktreeSelector: 'id:repo::existing',
      managerRefresh: true, managerTaskRunId: 'run-1', defaultBranch: 'main',
    }, fixture.execute);
    expect(result).toMatchObject({ status: 'continue', cause: 'worktree_reuse_ownership_unproven' });
    expect(fixture.calls.some((argv) => argv[0] === 'gh')).toBe(false);
  });
});


describe('Issue #2655 r02 fresh PR remote head', () => {
  const head = 'a'.repeat(40);
  const branch = 'issue-2655-reboot-relaunch';
  const repo = 'chetwerikoff/orchestrator-pack';
  const project = () => ({
    projectId: 'orchestrator-pack', repository: repo,
    primaryRoot: '/tmp/primary', defaultBranch: 'main',
  } as ReturnType<typeof import('../lib/target-context.ts').resolveTargetContext>);
  const request = () => ({
    repository: repo, issueNumber: 2655, taskId: 'task_8f2c8e5ccab8',
    worktreeName: 'fresh-2655', baseBranch: 'origin/' + branch,
    defaultBranch: 'main', managerRefresh: true,
  } as const);

  function fixture(options: {
    readonly noPr?: boolean;
    readonly duplicate?: boolean;
    readonly pr?: Record<string, unknown>;
    readonly remoteHead?: string;
    readonly checkoutHead?: string;
    readonly fetchOk?: boolean;
    readonly changed?: boolean;
    readonly dirty?: boolean;
  } = {}) {
    const calls: Array<{ argv: string[]; cwd?: string }> = [];
    const root = '/tmp/primary';
    const newPath = '/tmp/fresh-2655';
    const source = {
      number: 2656, state: 'OPEN', baseRefName: 'main',
      headRefName: branch, headRefOid: head,
      headRepository: { nameWithOwner: repo }, body: 'Closes #2655',
      ...options.pr,
    };
    let reads = 0;
    const execute = async (argv: readonly string[], _ms?: number,
      _env?: Readonly<NodeJS.ProcessEnv>, cwd?: string) => {
      calls.push({ argv: [...argv], cwd });
      const cmd = argv.join(' ');
      if (cmd === 'orca repo list --json') return {
        ok: true, stdout: repoListEnvelope([registeredOrcaRepo('repo-1', root)]),
      };
      if (cmd === 'git rev-parse --show-toplevel') return {
        ok: true, stdout: (cwd ?? '') + '\n',
      };
      if (cmd === 'git remote get-url origin') return {
        ok: true, stdout: 'git@github.com:chetwerikoff/orchestrator-pack.git\n',
      };
      if (cmd.startsWith('gh pr list ')) return {
        ok: true, stdout: JSON.stringify(options.noPr ? [] :
          options.duplicate ? [{ number: 2656 }, { number: 2657 }] : [{ number: 2656 }]),
      };
      if (cmd.startsWith('gh pr view ')) {
        reads += 1;
        return { ok: true, stdout: JSON.stringify({
          ...source,
          number: Number(argv[3]),
          ...(options.changed && reads > 1 ? { headRefOid: 'b'.repeat(40) } : {}),
        }) };
      }
      if (cmd === 'git fetch --no-tags origin refs/heads/' + branch +
        ':refs/remotes/origin/' + branch) return {
        ok: options.fetchOk !== false, stdout: '',
      };
      if (cmd === 'git rev-parse --verify refs/remotes/origin/' + branch + '^{commit}')
        return { ok: true, stdout: (options.remoteHead ?? head) + '\n' };
      if (cmd.startsWith('orca worktree create ')) return {
        ok: true, stdout: okEnvelope({
          worktree: { id: 'repo::fresh', path: newPath },
          setupReceipt: { requested: 'run', hookFound: false, state: 'not_configured' },
        }),
      };
      if (cmd === 'git worktree list --porcelain') return {
        ok: true, stdout: [
          'worktree /tmp/primary', 'HEAD ' + 'c'.repeat(40),
          'branch refs/heads/main', '',
          'worktree ' + newPath, 'HEAD ' + (options.checkoutHead ?? head),
          'branch refs/heads/fresh-local-2655', '',
        ].join('\n'),
      };
      if (cmd === 'git rev-parse --verify HEAD^{commit}') return {
        ok: true, stdout: (options.checkoutHead ?? head) + '\n',
      };
      if (cmd === 'git status --porcelain=v1 --untracked-files=all')
        return { ok: true, stdout: options.dirty ? '?? hook-output.txt\n' : '' };
      return { ok: false, stdout: '', stderr: 'unexpected ' + cmd };
    };
    return { execute, calls };
  }

  it('parses a requested remote PR branch only with exact Issue and fresh selector', () => {
    const argv = [
      '--project', 'orchestrator-pack', '--work-class', 'manager', '--run', 'run-1',
      '--manager-brief', 'continue Issue #2655', '--issue-number', '2655',
      '--worktree-name', 'fresh-2655', '--base-branch', 'origin/' + branch,
    ];
    const input = parseLaunchAssistantCli(argv, profileEnv(), project);
    expect(input).toMatchObject({
      issueNumber: 2655, baseBranch: 'origin/' + branch, worktreeName: 'fresh-2655',
    });
    expect(input.startMode).toBeUndefined();
    expect(() => parseLaunchAssistantCli(argv.filter((arg, n) =>
      arg !== '--issue-number' && argv[n - 1] !== '--issue-number'),
      profileEnv(), project)).toThrow(/--issue-number/u);
    expect(() => parseLaunchAssistantCli([
      ...argv.slice(0, -1), 'some-local-branch',
    ], profileEnv(), project)).toThrow(/--base-branch/u);
  });

  it('fetches only PR #2656 remote branch and proves the clean fresh HEAD before launching', async () => {
    const f = fixture();
    const response = await prepareWorktreeWithOrca(request(), f.execute);
    expect(response).toMatchObject({
      status: 'ok', value: {
        id: 'repo::fresh', selector: 'id:repo::fresh', path: '/tmp/fresh-2655',
        setupWitness: 'same_invocation_complete',
      }, evidence: { branch: 'fresh-local-2655' },
    });
    const created = f.calls.find((c) => c.argv.slice(0, 3).join(' ') === 'orca worktree create');
    expect(created?.argv).toContain('origin/' + branch);
    expect(created?.argv).toContain('--issue');
    expect(created?.argv).toContain('2655');
    expect(f.calls.some((c) => c.argv.join(' ') ===
      'git fetch --no-tags origin refs/heads/' + branch +
      ':refs/remotes/origin/' + branch)).toBe(true);
    expect(f.calls.filter((c) => c.argv.slice(0, 3).join(' ') === 'gh pr view')).toHaveLength(3);
    expect(f.calls.some((c) => c.argv.join(' ') === 'git rev-parse --verify HEAD^{commit}'
      && c.cwd === '/tmp/fresh-2655')).toBe(true);
    expect(f.calls.some((c) => c.argv[0] === 'git'
      && ['merge', 'reset', 'rebase', 'stash', 'clean'].includes(c.argv[1]!))).toBe(false);
  });

  it.each([
    ['foreign head repository', { pr: { headRepository: { nameWithOwner: 'foreign/repo' } } }, 'fresh_pr_head_mismatch'],
    ['wrong base', { pr: { baseRefName: 'release' } }, 'fresh_pr_head_mismatch'],
    ['wrong named branch', { pr: { headRefName: 'unrelated' } }, 'fresh_pr_head_mismatch'],
    ['closed PR', { pr: { state: 'CLOSED' } }, 'fresh_pr_head_mismatch'],
    ['wrong Issue', { pr: { body: 'Closes #119' } }, 'fresh_pr_link_ambiguous'],
    ['missing PR', { noPr: true }, 'fresh_pr_link_ambiguous'],
    ['duplicate Issue-closing PR', { duplicate: true }, 'fresh_pr_link_ambiguous'],
    ['remote fetch unavailable', { fetchOk: false }, 'fresh_pr_remote_fetch_failed'],
    ['remote head moved', { remoteHead: 'b'.repeat(40) }, 'fresh_pr_remote_head_mismatch'],
    ['PR changed during preparation', { changed: true }, 'fresh_pr_head_changed'],
  ] as const)('rejects %s before worktree creation', async (_name, options, cause) => {
    const f = fixture(options);
    const result = await prepareWorktreeWithOrca(request(), f.execute);
    expect(result).toMatchObject({ status: 'continue', cause });
    expect(f.calls.some((call) => call.argv.slice(0, 3).join(' ')
      === 'orca worktree create')).toBe(false);
  });

  it.each([
    ['checkout HEAD differs', { checkoutHead: 'f'.repeat(40) }, 'fresh_pr_head_changed_or_unproven'],
    ['setup dirty', { dirty: true }, 'manager_worktree_dirty'],
  ] as const)('refuses %s after creation, without any spawn authority', async (_name, options, cause) => {
    const f = fixture(options);
    const result = await prepareWorktreeWithOrca(request(), f.execute);
    expect(result).toMatchObject({ status: 'continue', cause });
    expect(f.calls.some((call) => call.argv.slice(0, 3).join(' ')
      === 'orca worktree create')).toBe(true);
    expect(f.calls.some((call) => call.argv[0] === 'git'
      && ['merge', 'reset', 'rebase', 'stash', 'clean'].includes(call.argv[1]!))).toBe(false);
  });
});


describe('Issue #2655 r02 AppliedIn #118 same Task terminal identity retry', () => {
  it('preserves failed start, refuses replaced terminal, and reuses only exactly verified same-Task terminal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk2655-same-task-118-'));
    const stateRoot = join(root, 'runtime');
    const worktree = join(root, 'appliedin-mgr-118-fresh-1151');
    mkdirSync(worktree, { recursive: true });
    const env = {
      ...opencodeProfileEnv('manager'), OPK_WAKE_SUPERVISOR_STATE_DIR: stateRoot,
      OPK_BASE_DIR: join(root, 'assignments'),
    };
    const taskId = 'task_8f2c8e5ccab8';
    const runId = 'run_a2645892e047';
    const handle = 'term-exact-118';
    const generation = 'incarnation-118';
    const worktreeId = 'appliedin::manager-118';
    const title = 'opk-manager-' + taskId;
    let created = 0;
    let startCalls = 0;
    let nativeVisibility: 'verified' | 'replaced' | 'foreign' | 'absent' | 'unknown' = 'verified';
    let newCommand = '';
    const terminal = () => ({
      handle, incarnationId: nativeVisibility === 'replaced' ? 'replaced-incarnation' : generation,
      title,
      command: newCommand,
      worktreePath: nativeVisibility === 'foreign' ? '/tmp/other-task-worktree' : worktree,
      status: 'running',
    });
    const runJson = ((argv: readonly string[]): OrcaJsonResponse => {
      const operation = argv.slice(0, 2).join(' ');
      if (operation === 'terminal list') {
        if (nativeVisibility === 'unknown') return {
          ok: false, error: { code: 'unavailable', message: 'native inventory unknown' },
        };
        return { ok: true, result: {
          totalCount: created && nativeVisibility !== 'absent' ? 1 : 0,
          truncated: false,
          terminals: created && nativeVisibility !== 'absent' ? [terminal()] : [],
        } };
      }
      if (operation === 'terminal create') {
        created += 1;
        newCommand = String(argv[argv.indexOf('--command') + 1] ?? '');
        return { ok: true, result: { terminal: terminal() } };
      }
      if (operation === 'terminal show') {
        if (nativeVisibility === 'unknown') return {
          ok: false, error: { code: 'unavailable', message: 'terminal identity unknown' },
        };
        return { ok: true, result: { terminal: nativeVisibility === 'absent' ? null : terminal() } };
      }
      if (operation === 'terminal wait') return {
        ok: true, result: { wait: { status: 'running', satisfied: true } },
      };
      return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    }) as typeof import('../orca-runtime/native.ts').runOrcaJson;
    const attempt = (supervised: LaunchDependencies['runSupervisedStart']) => {
      const adapter = new OrcaTaskRuntimeAdapter({ runJson, env });
      return runSupervisedTaskLaunchAssistant({
        repository: 'chetwerikoff/AppliedIn', projectId: 'orchestrator-pack',
        issueNumber: 118, workClass: 'manager', taskId, runId,
        worktreeSelector: 'id:' + worktreeId, defaultBranch: 'main',
        baseBranch: 'origin/main', env,
      }, {
        ...deps({
          adapter,
          managerRun: { status: 'ok', value: { runId } },
          managerMembership: { status: 'ok', value: { taskId } },
        }),
        resolveProfile: (workClass, inherited, mode) => resolveLiveExecutorProfile(
          workClass, inherited, mode, async (args) => opencodeProbeResult(args),
        ),
        prepareWorktree: async () => ({
          status: 'ok', value: {
            id: worktreeId, selector: 'id:' + worktreeId, path: worktree,
            setupWitness: 'proven_reuse',
          },
        }),
        finalizeProfile: async (profile) => ({ status: 'ok', value: profile }),
        runSupervisedStart: supervised,
      });
    };
    try {
      const first = await attempt(async () => {
        startCalls += 1;
        return { ok: false, reason: 'target_unresolved', errorMessage: 'native cause unavailable' };
      });
      expect(first).toMatchObject({ outcome: 'continue', stage: 'supervised_start',
        observedCause: 'target_unresolved' });
      expect(created).toBe(1);
      expect(startCalls).toBe(1);

      for (const visibility of ['replaced', 'foreign', 'absent', 'unknown'] as const) {
        nativeVisibility = visibility;
        const refused = await attempt(async () => {
          startCalls += 1;
          return readyStart(taskId);
        });
        expect(refused).toMatchObject({ outcome: 'continue', stage: 'terminal_prepare' });
        expect(JSON.stringify(refused)).not.toContain('"outcome":"ready"');
        expect(startCalls).toBe(1);
        expect(created).toBe(1);
      }

      nativeVisibility = 'verified';
      const inspect = async (args: readonly string[]) => {
        if (args[0] === 'terminal' && args[1] === 'show') return {
          ok: true, stdout: okEnvelope({ terminal: { handle, worktreeId } }),
        };
        if (args[0] === 'worktree' && args[1] === 'show') return {
          ok: true, stdout: okEnvelope({ worktree: { id: worktreeId, path: worktree } }),
        };
        return { ok: false, stdout: '', stderr: 'unknown native placement' };
      };
      const third = await attempt((start) => runSupervisedWorkerStart({
        ...start, env, inspect,
        execute: async () => {
          startCalls += 1;
          return { ok: true, stdout: okEnvelope({
            taskId, dispatchId: 'dispatch-118-retry', state: 'ready',
            effects: [
              { kind: 'worktree', action: 'reused', id: worktreeId },
              { kind: 'terminal', role: 'agent', action: 'reused', id: handle },
              { kind: 'dispatch_input', role: 'agent', id: handle, state: 'accepted' },
            ],
          }) };
        },
      }));
      expect(third).toMatchObject({
        outcome: 'ready', resources: { taskId, dispatchId: 'dispatch-118-retry',
          worktreePath: worktree, worktreeId },
      });
      expect(created).toBe(1);
      expect(startCalls).toBe(2);
      expect(currentWorkerAssignment(resolveWorkerAssignmentStorePath('orchestrator-pack', env), 118))
        .toMatchObject({ taskId, bindingKey: 'dispatch-118-retry', role: 'orchestrator' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('Issue #2661 B5 existing-session exact intent, census, and safe restart', () => {
  it('B5 extensionless resume entrypoint passes the native Node parser boundary', async () => {
    const entrypoint = fileURLToPath(new URL('../opk-orch-start', import.meta.url));
    for (const flags of [[], ['--experimental-strip-types']]) {
      const parsed = await runProcess({
        command: process.execPath,
        args: [...flags, '--check', entrypoint],
        allowEmptyStdout: true,
      });
      expect(parsed.outcome, parsed.stderr).toBe('exit');
      expect(parsed.exitCode, parsed.stderr).toBe(0);
    }
  });

  const projectId = 'orchestrator-pack';
  const repository = 'chetwerikoff/orchestrator-pack';
  const workspace = '/tmp/opk-2661-selected-workspace';
  const otherWorkspace = '/tmp/opk-2661-other-workspace';
  const session = 'ses_2661requested';
  type NativePane = {
    handle: string;
    incarnationId: string;
    worktreePath: string;
    title: string;
    status: string;
    command: string;
  };
  type FailureMode = 'healthy' | 'first-hang' | 'two-hangs' | 'stop-fails'
    | 'gone-unverified' | 'early-gone' | 'liveness-unknown' | 'generation-drift';

  function resumeFixture(mode: FailureMode = 'healthy', selectedEnv: NodeJS.ProcessEnv = opencodeProfileEnv('manager')) {
    const events: string[] = [];
    const nativePanes: NativePane[] = [];
    const spawnedCommands: string[] = [];
    const queriedUrls: string[] = [];
    const assignment: WorkerAssignment = {
      schema: 'orchestrator-pack/worker-assignment/v1',
      projectId, repository, issueNumber: 2661,
      taskId: 'task-2661', assignmentId: 'assignment-2661', generation: 1,
      kind: 'local', provider: 'orca', bindingKey: 'dispatch-2661',
      role: 'orchestrator', createdAtUtc: '2026-10-19T00:00:00.000Z',
    };
    const state: {
      assignments: WorkerAssignment[];
      catalog: string[];
      unreadableList: boolean;
      rosterMode: 'complete' | 'truncated' | 'count-mismatch';
      truncateAfterStop: boolean;
      catalogRequestFails: boolean;
      extraPane: NativePane | null;
      refuseProfile: boolean;
      assignmentsReadable: boolean;
      unknownIncumbent: boolean;
      goneIncumbent: boolean;
      workerShowUnknown: boolean;
      catalogShape: 'normal' | 'empty' | 'malformed' | 'wrong-directory';
      injectAssignmentAfterStop: boolean;
      stopReturned: boolean;
    } = {
      assignments: [], catalog: [session], unreadableList: false,
      rosterMode: 'complete', truncateAfterStop: false, catalogRequestFails: false,
      extraPane: null,
      refuseProfile: false, assignmentsReadable: true,
      unknownIncumbent: false, goneIncumbent: false,
      workerShowUnknown: false, catalogShape: 'normal',
      injectAssignmentAfterStop: false, stopReturned: false,
    };
    const asResult = (result: Record<string, unknown>) => ({ ok: true, result });
    const native = ((args: readonly string[]): OrcaJsonResponse => {
      const operation = args.slice(0, 2).join(' ');
      events.push(operation);
      if (operation === 'terminal list') {
        if (state.unreadableList) return asResult({ terminals: null, totalCount: 0, truncated: true });
        const selected = [...nativePanes, ...(state.extraPane ? [state.extraPane] : [])];
        const worktreeIndex = args.indexOf('--worktree');
        const rows = worktreeIndex >= 0
          ? selected.filter((pane) => pane.worktreePath === args[worktreeIndex + 1])
          : selected;
        if (state.stopReturned && !selected.some((pane) => pane.handle === 'term-b5-1')) {
          events.push('gone-readback:term-b5-1');
        }
        return asResult({
          terminals: rows,
          totalCount: rows.length + (state.rosterMode === 'count-mismatch' ? 1 : 0),
          truncated: state.rosterMode === 'truncated' || (state.stopReturned && state.truncateAfterStop),
        });
      }
      if (operation === 'terminal create') {
        const index = spawnedCommands.length + 1;
        const command = args[args.indexOf('--command') + 1] ?? '';
        const pane: NativePane = {
          handle: 'term-b5-' + index,
          incarnationId: 'native-inc-b5-' + index,
          worktreePath: args[args.indexOf('--worktree') + 1] ?? '',
          title: args[args.indexOf('--title') + 1] ?? '',
          status: 'running',
          command,
        };
        spawnedCommands.push(command);
        nativePanes.push(pane);
        events.push('created:' + pane.handle);
        return asResult({ terminal: pane });
      }
      if (operation === 'terminal show') {
        const handle = args[args.indexOf('--terminal') + 1] ?? '';
        return asResult({ terminal: nativePanes.find((pane) => pane.handle === handle)
          ?? (state.extraPane?.handle === handle ? state.extraPane : null) });
      }
      if (operation === 'terminal wait') {
        const handle = args[args.indexOf('--terminal') + 1];
        if (state.goneIncumbent && handle === 'incumbent') {
          return asResult({ wait: { status: 'exited', satisfied: false } });
        }
        if (state.unknownIncumbent && handle === 'incumbent') {
          return { ok: false, error: { code: 'unavailable', message: 'synthetic unknown incumbent' } };
        }
        if (mode === 'early-gone' && handle === 'term-b5-1') {
          return asResult({ wait: { status: 'exited', satisfied: false } });
        }
        if (mode === 'liveness-unknown' && handle === 'term-b5-1') {
          return { ok: false, error: { code: 'unavailable', message: 'synthetic native wait unavailable' } };
        }
        return asResult({ wait: { status: 'running', satisfied: false } });
      }
      if (operation === 'terminal close') {
        const handle = args[args.indexOf('--terminal') + 1];
        events.push('closed:' + handle);
        if (mode === 'stop-fails') {
          return { ok: false, error: { code: 'permission_denied', message: 'synthetic close refused' } };
        }
        state.stopReturned = true;
        const index = nativePanes.findIndex((pane) => pane.handle === handle);
        if (index >= 0 && mode !== 'gone-unverified') nativePanes.splice(index, 1);
        if (state.injectAssignmentAfterStop) state.assignments = [assignment];
        return asResult({ closed: true });
      }
      if (operation === 'orchestration worker-show') {
        if (state.workerShowUnknown) {
          return { ok: false, error: { code: 'unavailable', message: 'synthetic Dispatch unreadable' } };
        }
        return asResult({
          dispatch: { id: assignment.bindingKey, taskId: assignment.taskId, status: 'dispatched' },
          terminal: { worktreePath: workspace },
        });
      }
      return { ok: false, error: { code: 'unexpected_synthetic_operation', message: operation } };
    }) as typeof import('../orca-runtime/native.ts').runOrcaJson;

    // No fake "listener belongs to this worker" oracle: an unrelated responder
    // with the exact same JSON is observationally indistinguishable.
    const openCodeHttpRequest = ({ url }: { readonly url: string; readonly method: 'GET' | 'POST'; readonly timeoutMs: number }) => {
      queriedUrls.push(url);
      events.push('http-request');
      const command = spawnedCommands.at(-1) ?? '';
      const binding = openCodeControlFromCommand(command);
      if (!binding || !url.startsWith(binding.url + '/')) {
        throw new Error('synthetic wrong command-derived control URL');
      }
      const spawnIndex = spawnedCommands.length;
      if ((mode === 'first-hang' && spawnIndex === 1) || mode === 'two-hangs'
        || mode === 'stop-fails' || mode === 'gone-unverified'
        || mode === 'generation-drift') {
        if (mode === 'generation-drift' && nativePanes[0]) {
          nativePanes[0].incarnationId = 'native-recycled-incarnation';
        }
        throw new Error('ECONNREFUSED synthetic selected port');
      }
      if (url.endsWith('/global/health')) return { status: 200, body: JSON.stringify({ healthy: true, version: '1.18.35' }) };
      if (url.endsWith('/session?directory=' + encodeURIComponent(workspace))) {
        if (state.catalogRequestFails) throw new Error('ECONNRESET synthetic catalog request after healthy health');
        if (state.catalogShape === 'malformed') return { status: 200, body: '{invalid-fixture-json' };
        if (state.catalogShape === 'empty') return { status: 200, body: '[]' };
        return { status: 200, body: JSON.stringify(state.catalog.map((id) => ({ id,
          directory: state.catalogShape === 'wrong-directory' ? otherWorkspace : workspace }))) };
      }
      throw new Error('synthetic wrong directory/session request');
    };
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: native, openCodeHttpRequest,
      env: { OPK_WAKE_SUPERVISOR_STATE_DIR: '/tmp/opk-2661-no-persisted-launch-owner' } });
    const deps: OpenCodeResumeDependencies = {
      adapter,
      commandPreflight: () => ({ status: 'ok', value: true }),
      repositoryPreflight: async () => ({ status: 'ok', value: true }),
      resolveProfile: (_workClass, inherited, startMode) => state.refuseProfile
        ? Promise.resolve({ status: 'continue' as const, cause: 'executor_effort_channel_unavailable',
          actor: 'operator' as const, evidence: {},
          nextAction: { kind: 'repair_executor_profile' as const, note: 'synthetic pre-spawn refusal' } })
        : resolveLiveExecutorProfile('manager', inherited, startMode, async (args) => opencodeProbeResult(args)),
      finalizeProfile: async (profile, selectedWorkspace, requestedSession, dataRoot) => {
        expect(selectedWorkspace).toBe(workspace);
        expect(dataRoot).toBe(selectedEnv.XDG_DATA_HOME);
        const selectedInline = JSON.parse(profile.inlineConfigJson ?? '{}') as {
          agent?: Record<string, { model?: string; variant?: string }>;
        };
        const admittedAgent = profile.agentName ? selectedInline.agent?.[profile.agentName] : undefined;
        if (!admittedAgent?.model || !admittedAgent.variant) {
          throw new Error('synthetic fixture has no admitted selected model/variant');
        }
        const overlay = buildOpenCodeAgentOverlay({
          agentName: 'pack-opk-b5-selected', model: admittedAgent.model, effort: admittedAgent.variant,
          baseline: { name: 'build', mode: 'primary', prompt: 'synthetic benign task', permission: [] },
          stateRoot: '/tmp/opk-2661-disposable-state',
          ...(dataRoot !== undefined ? { dataRoot } : {}), resumeSession: requestedSession,
        });
        return { status: 'ok', value: {
          ...profile, launchCommand: overlay.command, agentName: overlay.agentName,
          inlineConfigJson: overlay.inlineConfigJson,
        } };
      },
      listAssignments: () => state.assignmentsReadable ? state.assignments : null,
      assignmentWorkspace: async (row) => {
        const result = native(['orchestration', 'worker-show', '--dispatch', row.bindingKey, '--json']);
        const observation = result.ok ? result.result as {
          dispatch?: { id?: string; taskId?: string };
          terminal?: { worktreePath?: string };
        } : null;
        return observation?.dispatch?.id === row.bindingKey
          && observation.dispatch.taskId === row.taskId
          ? observation.terminal?.worktreePath ?? null : null;
      },
    };
    const run = () => runExistingOpenCodeResume({
      session, projectId, repository, workspace, env: selectedEnv,
    }, deps);
    return { run, deps, adapter, native, nativePanes, spawnedCommands,
      queriedUrls, events, state, assignment };
  }

  it('B5 actual requested --session command, full selected overlay, and deliberate unassignment', async () => {
    const f = resumeFixture();
    f.state.catalog = [session, 'ses_wrongother'];
    const result = await f.run();
    expect(result).toMatchObject({
      outcome: 'catalog_observed_unverified', cause: 'requested_session_directory_catalog_membership_only',
      attempts: 1, unassigned: true, activeSelectionVerified: false, listenerOwnershipVerified: false,
    });
    expect(f.spawnedCommands).toHaveLength(1);
    const command = f.spawnedCommands[0]!;
    expect(command).toMatch(/ --session 'ses_2661requested'$/u);
    expect(command.match(/--session /gu)).toHaveLength(1);
    expect(command.match(/OPENCODE_CONFIG_CONTENT=/gu)).toHaveLength(1);
    const binding = openCodeControlFromCommand(command);
    expect(binding).toMatchObject({ session, agent: 'pack-opk-b5-selected' });
    expect(f.queriedUrls).toEqual([
      binding?.url + '/global/health',
      binding?.url + '/session?directory=' + encodeURIComponent(workspace),
    ]);
    const inline = JSON.parse(command.match(/^OPENCODE_CONFIG_CONTENT='([^']+)'/u)?.[1] ?? '{}') as {
      permission: Record<string, Record<string, string>>;
      agent: Record<string, { model?: string; variant?: string; permission: Record<string, Record<string, string>> }>;
    };
    expect(inline.agent['pack-opk-b5-selected']).toMatchObject({
      model: 'fixture-opencode-model', variant: 'fixture-opencode-effort',
    });
    for (const permission of [inline.permission, inline.agent.general?.permission,
      inline.agent.explore?.permission, inline.agent['pack-opk-b5-selected']?.permission]) {
      expect(permission?.read?.['*.env']).toBe('deny');
      expect(permission?.read?.['*.env.*']).toBe('deny');
    }
    expect(openCodeLaunchHasFleetBrowserDenies({
      command, agentName: 'pack-opk-b5-selected',
      inlineConfigJson: JSON.stringify(inline),
    })).toBe(true);
    expect(f.nativePanes).toHaveLength(1);
    expect(f.nativePanes[0]?.title).toBe('opk-resume-' + session);
    expect(f.events.every((event) => !/orchestration (?:task|dispatch|run)-(?:create|start)/u.test(event))).toBe(true);
    expect(f.state.assignments).toEqual([]);
  });


  it('B5 optional selected XDG_DATA_HOME survives native command quoting, validation and adapter parsing', async () => {
    const dataRoot = "/tmp/opk-2661 disposable/it's database --port 49999 --agent bogus --session ses_spoofed";
    for (const explicit of [false, true]) {
      const selectedEnv = opencodeProfileEnv('manager');
      if (explicit) selectedEnv.XDG_DATA_HOME = dataRoot;
      const f = resumeFixture('healthy', selectedEnv);
      const observation = await f.run();
      expect(observation).toMatchObject({
        outcome: 'catalog_observed_unverified', attempts: 1,
        activeSelectionVerified: false, listenerOwnershipVerified: false,
      });
      expect(f.spawnedCommands).toHaveLength(1);
      const command = f.spawnedCommands[0]!;
      expect(command.match(/OPENCODE_CONFIG_CONTENT=/gu)).toHaveLength(1);
      expect(command).toContain(" XDG_STATE_HOME='/tmp/opk-2661-disposable-state'");
      const inlineConfigJson = command.match(/^OPENCODE_CONFIG_CONTENT='([^']+)'/u)?.[1];
      expect(inlineConfigJson).toBeDefined();
      const inline = JSON.parse(inlineConfigJson ?? '{}') as { agent: Record<string, { model: string; variant: string }> };
      expect(inline.agent['pack-opk-b5-selected']).toMatchObject({
        model: 'fixture-opencode-model', variant: 'fixture-opencode-effort',
      });
      expect(openCodeLaunchHasFleetBrowserDenies({
        command, agentName: 'pack-opk-b5-selected', inlineConfigJson,
      })).toBe(true);
      const binding = openCodeControlFromCommand(command);
      expect(binding).toMatchObject({ agent: 'pack-opk-b5-selected', session });
      expect(binding?.url).toBe(`http://127.0.0.1:${openCodeControlPort('pack-opk-b5-selected')}`);
      expect(f.queriedUrls).toEqual([
        binding?.url + '/global/health',
        `${binding?.url}/session?directory=${encodeURIComponent(workspace)}`,
      ]);
      if (explicit) {
        const quotedData = "'" + dataRoot.replaceAll("'", "'\\''") + "'";
        expect(command).toContain(` XDG_DATA_HOME=${quotedData} opencode --hostname 127.0.0.1`);
        expect(openCodeLaunchHasFleetBrowserDenies({
          command: command.replace(`XDG_DATA_HOME=${quotedData}`, `XDG_DATA_HOME=${dataRoot}`),
          agentName: 'pack-opk-b5-selected', inlineConfigJson,
        })).toBe(false);
      } else {
        expect(command).not.toContain('XDG_DATA_HOME=');
        expect(command).toContain("XDG_STATE_HOME='/tmp/opk-2661-disposable-state' opencode --hostname");
      }
    }
  });

  it('B5 wrong-only catalog is non-ready and identical foreign same-session responder proves no owner', async () => {
    const wrong = resumeFixture();
    wrong.state.catalog = ['ses_otheronly'];
    expect(await wrong.run()).toMatchObject({
      outcome: 'continue', cause: 'resume_control_unavailable', attempts: 1,
      activeSelectionVerified: false, listenerOwnershipVerified: false,
    });
    expect(wrong.spawnedCommands).toHaveLength(1);
    expect(wrong.events).not.toContain('closed:term-b5-1');
    for (const catalogShape of ['empty', 'malformed', 'wrong-directory'] as const) {
      const f = resumeFixture();
      f.state.catalogShape = catalogShape;
      expect(await f.run()).toMatchObject({
        outcome: 'continue', cause: 'resume_control_unavailable', attempts: 1,
      });
      expect(f.events).not.toContain('closed:term-b5-1');
      expect(f.spawnedCommands).toHaveLength(1);
    }

    // The returned bytes deliberately cannot tell a local listener from a
    // foreign server that happens to list the requested session in this directory.
    const foreign = resumeFixture();
    foreign.state.catalog = [session, 'ses_another'];
    const observation = await foreign.run();
    expect(observation).toMatchObject({
      outcome: 'catalog_observed_unverified', attempts: 1,
      activeSelectionVerified: false, listenerOwnershipVerified: false,
    });
    expect(foreign.events).not.toContain('closed:term-b5-1');
  });

  it('B5 cross-adapter-instance unknown and ordinary no-session directory-only control', async () => {
    const f = resumeFixture();
    const observed = await f.run();
    expect(observed.terminal).toBeDefined();
    const fresh = new OrcaTaskRuntimeAdapter({
      runJson: f.native,
      openCodeHttpRequest: () => ({ status: 200, body: '[]' }),
      env: { OPK_WAKE_SUPERVISOR_STATE_DIR: '/tmp/opk-2661-no-persisted-launch-owner' },
    });
    expect(fresh.openCodeHealth(observed.terminal!, { cwd: workspace })).toMatchObject({
      status: 'unsupported', reason: 'runtime_opencode_control_unavailable',
    });
    const ordinary = f.adapter.spawnWorker({
      title: 'ordinary-opencode', workspace,
      command: "opencode --hostname 127.0.0.1 --port 47771 --agent 'general'",
    }, { cwd: workspace });
    expect(ordinary.status).toBe('ok');
    if (ordinary.status === 'ok') {
      f.state.catalog = ['ses_unrelated'];
      expect(f.adapter.openCodeHealth(ordinary.value.identity, { cwd: workspace })).toMatchObject({
        status: 'ok',
      });
      expect(f.adapter.composerControl?.(ordinary.value.identity)?.kind).toBe('opencode-http');
    }
  });

  it('B5 rejects well-formed but incomplete native rosters before spawn and after stopped-worker re-admission', async () => {
    for (const rosterMode of ['truncated', 'count-mismatch'] as const) {
      const f = resumeFixture();
      f.state.rosterMode = rosterMode;
      const census = await f.adapter.listWorkersAsync?.({}, { cwd: workspace });
      expect(census).toMatchObject({ status: 'unsupported', reason: 'runtime_worker_list_incomplete' });
      expect(await f.run()).toMatchObject({
        outcome: 'continue', attempts: 0, cause: 'resume_incumbent_or_assignment_unverified',
      });
      expect(f.spawnedCommands).toHaveLength(0);
    }
    const afterStop = resumeFixture('first-hang');
    afterStop.state.truncateAfterStop = true;
    expect(await afterStop.run()).toMatchObject({
      outcome: 'continue', attempts: 1, cause: 'resume_incumbent_or_assignment_unverified',
    });
    expect(afterStop.events).toContain('closed:term-b5-1');
    expect(afterStop.spawnedCommands).toHaveLength(1);
  });

  it('B5 successful health followed by catalog transport failure never authorizes stop or retry', async () => {
    const f = resumeFixture();
    f.state.catalogRequestFails = true;
    expect(await f.run()).toMatchObject({
      outcome: 'continue', attempts: 1, cause: 'resume_control_unavailable',
    });
    expect(f.queriedUrls.some((url) => url.endsWith('/global/health'))).toBe(true);
    expect(f.queriedUrls.some((url) => url.includes('/session?directory='))).toBe(true);
    expect(f.events).not.toContain('terminal close');
    expect(f.spawnedCommands).toHaveLength(1);
  });

  it('B5 explicit resume never exposes effectful composer control for an unverified listener', async () => {
    const f = resumeFixture();
    f.state.catalog = [session, 'ses_foreignother'];
    const result = await f.run();
    expect(result).toMatchObject({
      outcome: 'catalog_observed_unverified',
      activeSelectionVerified: false, listenerOwnershipVerified: false,
    });
    expect(result.terminal).toBeDefined();
    expect(f.adapter.composerControl?.(result.terminal!)).toBeUndefined();
    expect(f.queriedUrls.some((url) => /\/tui\/(?:append|submit)-prompt$/u.test(url))).toBe(false);
  });

  it('B5 full selected-workspace native worker and assignment/Dispatch census refuses incumbents', async () => {
    for (const census of ['live', 'unknown', 'gone', 'foreign-worker', 'unreadable', 'duplicate'] as const) {
      const f = resumeFixture();
      if (census === 'unreadable') f.state.unreadableList = true;
      else if (census === 'duplicate') {
        f.state.extraPane = { handle: 'other', incarnationId: 'generation-a',
          worktreePath: workspace, title: 'other', status: 'running', command: 'other' };
        f.nativePanes.push({ ...f.state.extraPane });
      } else f.state.extraPane = {
        handle: 'incumbent', incarnationId: 'generation-incumbent',
        worktreePath: census === 'foreign-worker' ? otherWorkspace : workspace,
        title: 'native-existing', status: 'running', command: 'other',
      };
      if (census === 'unknown') {
        f.state.unknownIncumbent = true;
        const value = await f.run();
        expect(value).toMatchObject({ outcome: 'continue', attempts: 0,
          cause: 'resume_incumbent_or_assignment_unverified' });
      } else if (census === 'gone') {
        // A native gone witness alone does not prove anything about an assignment.
        f.state.goneIncumbent = true;
        expect((await f.run()).outcome).toBe('catalog_observed_unverified');
      } else if (census === 'foreign-worker') {
        expect((await f.run()).outcome).toBe('catalog_observed_unverified');
      } else {
        expect(await f.run()).toMatchObject({ attempts: 0,
          cause: 'resume_incumbent_or_assignment_unverified' });
      }
      if (census !== 'foreign-worker' && census !== 'gone') expect(f.spawnedCommands).toHaveLength(0);
    }
    for (const type of ['active', 'unknown', 'still-2655-replaceable',
      'wrong-metadata', 'assignment-list-unreadable', 'ambiguous'] as const) {
      const f = resumeFixture();
      if (type === 'assignment-list-unreadable') {
        f.state.assignmentsReadable = false;
      } else if (type === 'ambiguous') {
        f.state.assignments = [f.assignment, { ...f.assignment, assignmentId: 'second-claim' }];
      } else {
        f.state.assignments = [type === 'wrong-metadata'
          ? { ...f.assignment, bindingKey: '' } : f.assignment];
      }
      if (type === 'unknown') f.state.workerShowUnknown = true;
      if (type === 'still-2655-replaceable') {
        f.state.extraPane = {
          handle: 'incumbent', incarnationId: 'previous-native-generation',
          worktreePath: workspace, title: 'previous-manager', status: 'running', command: 'opencode',
        };
        f.state.goneIncumbent = true; // native gone does not retire Dispatch
        const oldIdentity = { runtime: 'orca' as const, id: 'incumbent', generation: 'previous-native-generation' };
        expect(f.adapter.liveness({ worker: oldIdentity, observationWindowMs: 1_000 },
          { cwd: workspace }).status).toBe('gone');
      }
      expect(await f.run()).toMatchObject({ outcome: 'continue',
        cause: 'resume_incumbent_or_assignment_unverified', attempts: 0 });
      expect(f.spawnedCommands).toHaveLength(0);
    }
  });

  it('B5 first port hang then healthy resume', async () => {
    const f = resumeFixture('first-hang');
    f.state.catalog = [session, 'ses_wrongother'];
    const result = await f.run();
    expect(result).toMatchObject({
      outcome: 'catalog_observed_unverified', attempts: 2,
      unassigned: true, activeSelectionVerified: false, listenerOwnershipVerified: false,
    });
    expect(f.spawnedCommands).toHaveLength(2);
    expect(f.spawnedCommands[1]).toBe(f.spawnedCommands[0]);
    expect(f.events.filter((event) => event === 'terminal close')).toHaveLength(1);
    const firstSpawn = f.events.indexOf('created:term-b5-1');
    const closed = f.events.indexOf('closed:term-b5-1');
    const secondSpawn = f.events.indexOf('created:term-b5-2');
    expect(firstSpawn).toBeGreaterThanOrEqual(0);
    expect(closed).toBeGreaterThan(firstSpawn);
    expect(secondSpawn).toBeGreaterThan(closed);
    expect(f.events.slice(closed + 1, secondSpawn)).toContain('gone-readback:term-b5-1');
    expect(f.events.slice(closed + 1, secondSpawn).filter((event) => event === 'terminal list').length)
      .toBeGreaterThan(0); // separately observed gone and renewed full exclusion
    expect(f.nativePanes.map((pane) => pane.handle)).toEqual(['term-b5-2']);
    expect(f.queriedUrls.at(-1)).toContain('/session?directory=');
  });

  it('B5 hung startup fails closed', async () => {
    const expected = [
      ['two-hangs', 'resume_control_unavailable', 2, 1],
      ['stop-fails', 'resume_stop_unverified', 1, 1],
      ['gone-unverified', 'resume_gone_unverified', 1, 1],
      ['early-gone', 'resume_worker_liveness_unverified', 1, 0],
      ['liveness-unknown', 'resume_worker_liveness_unverified', 1, 0],
      ['generation-drift', 'resume_worker_identity_unverified', 1, 0],
    ] as const;
    for (const [mode, cause, attempts, closeCount] of expected) {
      const f = resumeFixture(mode);
      const observation = await f.run();
      expect(observation).toMatchObject({
        outcome: 'continue', cause, attempts,
        activeSelectionVerified: false, listenerOwnershipVerified: false,
      });
      expect(f.spawnedCommands).toHaveLength(attempts);
      expect(f.events.filter((event) => event === 'terminal close')).toHaveLength(closeCount);
      expect(f.spawnedCommands.length).toBeLessThanOrEqual(2);
    }
    const afterStop = resumeFixture('first-hang');
    afterStop.state.injectAssignmentAfterStop = true;
    expect(await afterStop.run()).toMatchObject({
      outcome: 'continue', cause: 'resume_incumbent_or_assignment_unverified', attempts: 1,
    });
    expect(afterStop.spawnedCommands).toHaveLength(1);
    expect(afterStop.events).toContain('closed:term-b5-1');
    const refusal = resumeFixture();
    refusal.state.refuseProfile = true;
    expect(await refusal.run()).toMatchObject({ outcome: 'continue',
      cause: 'executor_effort_channel_unavailable', attempts: 0 });
    expect(refusal.spawnedCommands).toHaveLength(0);
    const invalid = resumeFixture();
    expect(await runExistingOpenCodeResume({
      session: 'invalid_session_token', projectId, repository, workspace,
      env: opencodeProfileEnv('manager'),
    }, invalid.deps)).toMatchObject({ cause: 'resume_input_invalid', attempts: 0 });
    expect(invalid.spawnedCommands).toHaveLength(0);
  });

  it('B4 own-last-line synthetic GPT PARKED excludes an in-flight spinner', () => {
    expect(lastFleetParkedLine('older text\nPARKED on GPT turn invocation-2661')).toBe(
      'PARKED on GPT turn invocation-2661',
    );
    expect(lastFleetParkedLine('⠋ PARKED on GPT turn invocation-2661')).toBeUndefined();
    expect(ownPaneOutcome('⠋ PARKED on GPT turn invocation-2661').wait).toBeUndefined();
    expect(lastFleetParkedLine('PARKED on GPT turn invocation-2661\nAssistant: newer own response'))
      .toBeUndefined();
  });
});



describe('Issue #2716 Claude Code canonical executor and supervised readiness', () => {
  const models = [
    ['claude-opus-5-5', 'medium', 'Opus'],
    ['claude-sonnet-5-5', 'high', 'Sonnet'],
  ] as const;
  const nativeHelp = 'Claude Code\n  --model <model>  Select model\n  --effort <level>  Select effort\n';

  function claudeEnv(model: string, effort: string, workClass: 'manager' | 't2' = 'manager'): NodeJS.ProcessEnv {
    const prefix = workClass === 'manager' ? 'MANAGER' : 'T2';
    return profileEnv({
      ['PACK_EXECUTOR_' + prefix + '_AGENT']: 'claude',
      ['PACK_EXECUTOR_' + prefix + '_MODEL']: model,
      ['PACK_EXECUTOR_' + prefix + '_EFFORT']: effort,
      PACK_EXECUTOR_CURSOR_CONTEXT: '272k',
    });
  }

  function observedClaudeAdapter(
    command: string,
    family: string,
    effort: string,
    options: {
      readonly commandOverride?: string;
      readonly modelOverride?: string;
      readonly effortOverride?: string;
      readonly source?: 'screen' | 'stream';
      readonly state?: 'running' | 'exited';
      readonly generation?: string;
      readonly onSpawn?: () => void;
      readonly onRead?: () => void;
    } = {},
  ): RuntimeAdapter {
    return {
      ...runtimeAdapter({ onSpawn: options.onSpawn }),
      observeComposerFamily: () => ({
        status: 'known', family: 'non-opencode', provenance: 'orca-terminal-show',
        command: options.commandOverride ?? command,
      }),
      readBoundedOutputAsync: async ({ worker: identity, screen }) => {
        options.onRead?.();
        expect(screen).toBe(true);
        return { status: 'ok', value: {
          worker: options.generation ? { ...identity, generation: options.generation } : identity,
          lines: [
            '✻ Welcome to Claude Code!',
            '❯',
            '──────────────────────────────────',
            'Claude ' + (options.modelOverride ?? family) + ' 5.5 · effort: ' + (options.effortOverride ?? effort),
          ],
          source: options.source ?? 'screen',
          terminalState: options.state ?? 'running',
          observationToken: { opaque: 'claude-pane-screen' },
          changed: true,
        } };
      },
    };
  }

  it.each(models)('closes task and smoke argv for %s %s without a context selector', (model, effort) => {
    const task = resolveSemanticExecutorProfile({
      surface: 'task', names: profileNamesForTask('manager'), env: claudeEnv(model, effort),
    });
    const smokeNames = profileNamesForSmoke('routine');
    const smoke = resolveSemanticExecutorProfile({
      surface: 'smoke', names: smokeNames,
      env: { [smokeNames[0]]: 'claude', [smokeNames[1]]: model, [smokeNames[2]]: effort,
        PACK_EXECUTOR_CURSOR_CONTEXT: '272k' },
    });
    expect(task.ok).toBe(true);
    expect(smoke.ok).toBe(true);
    if (!task.ok || !smoke.ok) throw new Error('supported Claude profile refused');
    expect(task.profile.cursorContext).toBeUndefined();
    expect(smoke.profile.cursorContext).toBeUndefined();
    for (const profile of [task.profile, smoke.profile]) {
      const invocation = buildExecutorCommand(profile);
      expect(invocation).toMatchObject({
        executable: 'claude', modelArgument: model, effortArgument: effort,
        command: "claude --model '" + model + "' --effort '" + effort + "'",
      });
      expect(invocation.command).not.toMatch(/context|OPENCODE_CONFIG_CONTENT|--agent/iu);
      expect(buildProviderInvocation(profile)).toBeNull();
    }
    expect(EXECUTOR_FAMILY_DESCRIPTORS.claude.catalogCommand).toEqual([]);
    expect(EXECUTOR_FAMILY_DESCRIPTORS.claude.capabilityProbeCommands).toEqual([['claude', '--help']]);
    expect(EXECUTOR_FAMILY_DESCRIPTORS.claude.smokeCapabilityProbeCommands).toEqual([['claude', '--help']]);
    expect(resolveExecutorProfile('manager', claudeEnv(model, effort), 'exact_terminal_worktree')).toMatchObject({
      status: 'ok', value: { family: 'claude', route: 'exact_terminal_worktree',
        model, effort, launchCommand: "claude --model '" + model + "' --effort '" + effort + "'" },
    });
  });

  it.each(models)('admits %s %s using only native help and verified child inheritance', async (model, effort) => {
    const calls: string[][] = [];
    const output = await resolveLiveExecutorProfile('manager', claudeEnv(model, effort),
      'exact_terminal_worktree', async (argv) => {
        calls.push([...argv]);
        if (argv[0] === 'claude' && argv[1] === '--help') return { ok: true, stdout: nativeHelp, stderr: '' };
        if (argv[0] === process.execPath) return { ok: true, stdout: '', stderr: '' };
        return { ok: false, stdout: '', stderr: '' };
      });
    expect(output).toMatchObject({
      status: 'ok', value: { family: 'claude', route: 'exact_terminal_worktree', model, effort },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['claude', '--help']);
    expect(calls[1]?.[0]).toBe(process.execPath);
    expect(calls[1]).toContain('PACK_EXECUTOR_MANAGER_MODEL');
    expect(calls[1]).toContain('PACK_EXECUTOR_MANAGER_EFFORT');
    expect(calls.some((argv) => argv.includes('models') || argv.includes('--list-models'))).toBe(false);
  });

  it('refuses unknown model, effort and route using the closed vocabulary and a repair action', async () => {
    for (const [env, cause] of [
      [claudeEnv('claude-opus-5-6', 'medium'), 'executor_route_unavailable'],
      [claudeEnv('claude-sonnet-5-5', 'ultra'), 'executor_effort_channel_unavailable'],
    ] as const) {
      const staticResult = resolveExecutorProfile('manager', env, 'exact_terminal_worktree');
      expect(staticResult).toMatchObject({
        status: 'continue', cause, nextAction: { kind: 'repair_executor_profile', note: expect.any(String) },
      });
      const calls: string[][] = [];
      const live = await resolveLiveExecutorProfile('manager', env, 'exact_terminal_worktree', async (argv) => {
        calls.push([...argv]);
        return { ok: true, stdout: nativeHelp, stderr: '' };
      });
      expect(live).toMatchObject({ status: 'continue', cause, nextAction: { kind: 'repair_executor_profile' } });
      expect(calls).toEqual([]);
    }
    const env = claudeEnv('claude-opus-5-5', 'medium');
    const unsupported = resolveExecutorProfile('manager', env, 'provider_new_top_level');
    expect(unsupported).toMatchObject({
      status: 'continue', cause: 'executor_route_mismatch',
      nextAction: { kind: 'repair_executor_profile', note: expect.any(String) },
    });
    for (const [help, cause] of [
      ['Claude Code\n  --model <model>', 'executor_effort_channel_unavailable'],
      ['Claude Code\n  --effort <level>', 'executor_route_unavailable'],
      ['', 'executor_route_unavailable'],
    ] as const) {
      const calls: string[][] = [];
      const result = await resolveLiveExecutorProfile('manager', env, 'exact_terminal_worktree',
        async (argv) => { calls.push([...argv]); return { ok: true, stdout: help, stderr: '' }; });
      expect(result).toMatchObject({
        status: 'continue', cause, nextAction: { kind: 'repair_executor_profile' },
      });
      expect(calls).toEqual([['claude', '--help']]);
    }
    const failedHelp = await resolveLiveExecutorProfile('manager', env, 'exact_terminal_worktree',
      async () => ({ ok: false, stdout: '', stderr: 'unavailable' }));
    expect(failedHelp).toMatchObject({ status: 'continue', cause: 'executor_route_unavailable' });
  });

  it('preserves explicit Claude manager overrides above local store without touching Cursor/OpenCode', () => {
    const env = claudeEnv('claude-sonnet-5-5', 'high');
    const effective = overlayExecutorProfileEnv(env, {
      storePath: '/operator/executor-profiles.env',
      readFile: () => [
        'PACK_EXECUTOR_MANAGER_AGENT=cursor-agent',
        'PACK_EXECUTOR_MANAGER_MODEL=grok-4.7',
        'PACK_EXECUTOR_MANAGER_EFFORT=medium',
      ].join('\n'),
    });
    expect(effective.PACK_EXECUTOR_MANAGER_AGENT).toBe('claude');
    expect(effective.PACK_EXECUTOR_MANAGER_MODEL).toBe('claude-sonnet-5-5');
    expect(effective.PACK_EXECUTOR_MANAGER_EFFORT).toBe('high');
    expect(resolveExecutorProfile('manager', effective, 'exact_terminal_worktree')).toMatchObject({
      status: 'ok', value: { family: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
    });
    expect(resolveExecutorProfile('manager', profileEnv(), 'exact_terminal_worktree')).toMatchObject({
      status: 'ok', value: { family: 'cursor', launchCommand: "cursor-agent --model 'model-medium'" },
    });
    expect(resolveExecutorProfile('t2', opencodeProfileEnv('t2'), 'exact_terminal_worktree')).toMatchObject({
      status: 'continue', cause: 'executor_route_unavailable',
    });
  });

  it.each(models)('launches a new Claude Code manager terminal for %s %s after screen proof', async (model, effort, family) => {
    const env = claudeEnv(model, effort);
    const command = "claude --model '" + model + "' --effort '" + effort + "'";
    let spawns = 0;
    let reads = 0;
    let supervised = 0;
    const adapter = observedClaudeAdapter(command, family, effort, {
      onSpawn: () => { spawns += 1; },
      onRead: () => { reads += 1; },
    });
    const result = await runSupervisedTaskLaunchAssistant({
      ...launchInput('manager'), env, issueNumber: 2716,
      taskId: undefined, managerBrief: 'Implement Issue #2716', worktreeSelector: undefined,
      worktreeName: 'claude-manager-2716',
    }, deps({
      adapter, onSupervised: () => { supervised += 1; },
      managerIssueTitle: { status: 'ok', value: 'firefighter: admit Claude Code executor family' },
    }));
    expect(result).toMatchObject({
      outcome: 'ready', resources: { taskId: 'task-created', terminal: worker.identity },
    });
    expect(spawns).toBe(1);
    expect(reads).toBe(1);
    expect(supervised).toBe(1);
  });

  it.each(models)('reuses the exact Claude manager terminal for %s %s without spawn or profile loss', async (model, effort, family) => {
    const env = claudeEnv(model, effort);
    const command = "claude --model '" + model + "' --effort '" + effort + "'";
    const target = () => ({
      projectId: 'orchestrator-pack', repository: 'chetwerikoff/orchestrator-pack',
      primaryRoot: '/tmp/primary', defaultBranch: 'main',
    } as ReturnType<typeof import('../lib/target-context.ts').resolveTargetContext>);
    const parsed = parseLaunchAssistantCli([
      '--project', 'orchestrator-pack', '--work-class', 'manager',
      '--run', 'run-1', '--task', 'task-1', '--issue-number', '2716',
      '--worktree', 'id:manager-worktree', '--existing-terminal', worker.identity.id,
    ], env, target);
    expect(parsed.existingTerminal).toBe(worker.identity.id);
    expect(parsed.startMode).toBe('exact_terminal_worktree');
    let spawns = 0;
    let prepared = 0;
    let supervised = 0;
    const adapter = observedClaudeAdapter(command, family, effort, { onSpawn: () => { spawns += 1; } });
    const base = readyStart('task-1');
    if (!base.assignment || !base.receipt) throw new Error('missing fixture receipt');
    const start: SupervisedWorkerStartResult = {
      ...base,
      assignment: { ...base.assignment, issueNumber: 2716, role: 'orchestrator' },
      receipt: { ...base.receipt, effects: [{ kind: 'worktree', action: 'reused', id: 'repo::exact-worktree' }] },
    };
    const result = await runSupervisedTaskLaunchAssistant({
      ...parsed, env,
    }, {
      ...deps({ adapter, supervised: start, onWorktree: () => { prepared += 1; },
        onSupervised: () => { supervised += 1; } }),
    });
    expect(result).toMatchObject({
      outcome: 'ready',
      resources: { taskId: 'task-1', worktreeId: 'repo::exact-worktree', terminal: worker.identity },
    });
    expect(spawns).toBe(0);
    expect(prepared).toBe(0);
    expect(supervised).toBe(1);
  });

  it('refuses missing or stale native Claude screen/command/model/effort before Dispatch', async () => {
    const env = claudeEnv('claude-opus-5-5', 'medium');
    const result = resolveExecutorProfile('manager', env, 'exact_terminal_worktree');
    if (result.status !== 'ok') throw new Error('Claude fixture profile refused');
    const command = result.value.launchCommand;
    for (const options of [
      { commandOverride: 'claude --model wrong --effort medium' },
      { modelOverride: 'Sonnet' },
      { effortOverride: 'high' },
      { source: 'stream' as const },
      { state: 'exited' as const },
      { generation: 'other-pty' },
    ]) {
      const adapter = observedClaudeAdapter(command, 'Opus', 'medium', options);
      expect(await claudePaneProfileObserved(result.value, worker, adapter)).toBe(false);
    }
    let starts = 0;
    const failed = await runSupervisedTaskLaunchAssistant({
      ...launchInput('manager'), env, issueNumber: 2716,
    }, deps({
      adapter: observedClaudeAdapter(command, 'Opus', 'high'),
      onSupervised: () => { starts += 1; },
    }));
    expect(failed).toMatchObject({
      outcome: 'continue', stage: 'terminal_prepare',
      observedCause: 'executor_effort_channel_unavailable',
      nextAction: { kind: 'repair_executor_profile', note: expect.any(String) },
    });
    expect(starts).toBe(0);
  });
});
