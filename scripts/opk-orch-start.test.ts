// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fleetWakeConfigFromEnv } from './fleet/fleet-wake.ts';
import { runProcessSync } from './kernel/subprocess.ts';
import {
  publishCurrentWorkerAssignment,
  readOperatorPrimaryBinding,
  resolveWorkerAssignmentStorePath,
  type WorkerAssignmentRecord,
} from './lib/worker-assignment-store.ts';
import { projectCardPath } from './lib/target-context.ts';
import {
  attachOrchestratorSeat,
  runOpkOrchStart,
  type NativeCommand,
  type NativeCommandResult,
} from './orca-runtime/orchestrator-attach.ts';

const roots: string[] = [];
const RUN = 'run_restore_2855';
const NEW_HANDLE = 'term_new_seat';
const OLD_HANDLE = 'term_old_seat';

interface Fixture {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly primary: string;
  readonly file: string;
  readonly otherPin: string;
}

interface World {
  coordinator: string | null;
  readonly tasks: { readonly id: string; readonly dispatchId: string }[];
  listFail: boolean;
  listTruncated: boolean;
  oldLive: boolean;
  showFail: boolean;
  runUseFail: boolean;
  readbackStale: boolean;
  dispatchMismatch: boolean;
  readonly calls: string[][];
}

function fixture(): Fixture {
  const root = mkdtempSync(path.join('/tmp', 'opk-orch-start-'));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPK_BASE_DIR: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    HOME: root,
    OPK_PROJECT_ID: 'orchestrator-pack',
    OPK_RUN_ID: RUN,
  };
  const primary = path.join(root, 'primary');
  mkdirSync(primary, { recursive: true });
  const initialized = runProcessSync({ command: 'git', args: ['init'], cwd: primary, inheritParentEnv: true });
  if (!initialized.ok) throw new Error(initialized.stderr || initialized.error || 'git init failed');
  const remote = runProcessSync({
    command: 'git',
    args: ['remote', 'add', 'origin', 'https://github.com/chetwerikoff/orchestrator-pack.git'],
    cwd: primary,
    inheritParentEnv: true,
  });
  if (!remote.ok) throw new Error(remote.stderr || remote.error || 'git remote add failed');
  const card = projectCardPath('orchestrator-pack', env);
  mkdirSync(path.dirname(card), { recursive: true });
  writeFileSync(card, JSON.stringify({
    projectId: 'orchestrator-pack',
    repository: 'chetwerikoff/orchestrator-pack',
    primaryRoot: primary,
    defaultBranch: 'main',
    orcaWorkspacePattern: 'orca/workspaces/orchestrator-pack/',
    orchestratorTitlePattern: 'orchestrator-pack',
    browserGpt: { projectUrl: 'https://chatgpt.com/g/orchestrator-pack/project' },
    verification: { local: ['npm test'] },
  }), 'utf8');
  const otherPin = path.join(root, '.config', 'orchestrator-fleet', 'leopoker.env');
  mkdirSync(path.dirname(otherPin), { recursive: true });
  writeFileSync(otherPin, 'OTHER=1\nORCH_HANDLE=term_other\n', { mode: 0o600 });
  return { root, env, primary, file: resolveWorkerAssignmentStorePath('orchestrator-pack', env), otherPin };
}

let publishedIssues = 2855;

async function publishRow(
  file: string,
  taskId: string,
  bindingKey: string,
  role: 'orchestrator' | 'worker' = 'orchestrator',
): Promise<WorkerAssignmentRecord> {
  publishedIssues += 1;
  const result = await publishCurrentWorkerAssignment({
    file,
    projectId: 'orchestrator-pack',
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: publishedIssues,
    taskId,
    kind: 'local',
    provider: 'orca',
    bindingKey,
    role,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.assignment;
}

function world(tasks: World['tasks'], coordinator: string | null): World {
  return {
    coordinator,
    tasks,
    listFail: false,
    listTruncated: false,
    oldLive: false,
    showFail: false,
    runUseFail: false,
    readbackStale: false,
    dispatchMismatch: false,
    calls: [],
  };
}

function native(state: World, primary: string): NativeCommand {
  return async (args) => {
    state.calls.push([...args]);
    const command = args[1] ?? '';
    if (state.showFail && command === 'show') return { code: 1, stdout: '', stderr: 'missing terminal' };
    if (command === 'show') {
      return json({ terminal: { handle: NEW_HANDLE, worktreePath: primary } });
    }
    if (command === 'list') {
      if (state.listFail) return { code: 1, stdout: '', stderr: 'list failed' };
      const terminals = [{ handle: NEW_HANDLE, worktreePath: primary }];
      if (state.oldLive) terminals.push({ handle: OLD_HANDLE, worktreePath: primary });
      return json({
        terminals,
        truncated: state.listTruncated,
        totalCount: terminals.length,
        hostScope: 'local',
      });
    }
    if (command === 'run-show') {
      const used = state.calls.filter((call) => call[1] === 'run-use').length;
      const coordinator = state.readbackStale && used > 0 ? OLD_HANDLE : state.coordinator;
      return json({ run: { id: RUN, coordinator_handle: coordinator } });
    }
    if (command === 'task-list') {
      return json({ tasks: state.tasks.map((task) => ({ id: task.id, status: 'dispatched', title: 'orchestrator' })) });
    }
    if (command === 'dispatch-show') {
      const taskId = args[args.indexOf('--task') + 1] ?? '';
      const task = state.tasks.find((row) => row.id === taskId);
      return json({
        dispatch: {
          id: state.dispatchMismatch ? 'ctx_mismatch' : task?.dispatchId,
          task_id: taskId,
          run_id: RUN,
        },
      });
    }
    if (command === 'worker-show') {
      const dispatchId = args[args.indexOf('--dispatch') + 1] ?? '';
      const task = state.tasks.find((row) => row.dispatchId === dispatchId);
      if (!task) return { code: 1, stdout: '', stderr: 'missing worker' };
      return json({ dispatchId, taskId: task.id, runId: RUN });
    }
    if (command === 'run-use') {
      if (state.runUseFail) return { code: 1, stdout: '', stderr: 'run-use failed' };
      state.coordinator = NEW_HANDLE;
      return json({ runId: RUN });
    }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
}

function json(result: unknown): NativeCommandResult {
  return { code: 0, stdout: `${JSON.stringify({ ok: true, result })}\n`, stderr: '' };
}

function runUses(state: World): number {
  return state.calls.filter((call) => call[0] === 'orchestration' && call[1] === 'run-use').length;
}

function pinPath(env: NodeJS.ProcessEnv): string {
  return path.join(env.HOME ?? '', '.config', 'orchestrator-fleet', 'orchestrator-pack.env');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('opk-orch-start attach', () => {
  it('repairs the selected pin without run-use when the Run already names the live handle', async () => {
    const fx = fixture();
    const row = await publishRow(fx.file, 'task_orch', 'ctx_orch');
    const state = world([{ id: row.taskId, dispatchId: row.bindingKey }], NEW_HANDLE);
    writeFileSync(pinPath(fx.env), 'KEEP=yes\nORCH_HANDLE=term_stale\n', { mode: 0o644 });
    const first = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE, 'orchestrator-pack'],
      env: fx.env,
      runNative: native(state, fx.primary),
    });
    const second = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE],
      env: fx.env,
      runNative: native(state, fx.primary),
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(runUses(state)).toBe(0);
    expect(readFileSync(pinPath(fx.env), 'utf8')).toBe(`KEEP=yes\nORCH_HANDLE=${NEW_HANDLE}\n`);
    expect(lstatSync(pinPath(fx.env)).mode & 0o777).toBe(0o600);
    const binding = readOperatorPrimaryBinding(fx.file, {
      projectId: 'orchestrator-pack',
      repository: 'chetwerikoff/orchestrator-pack',
    });
    expect(binding.ok && binding.status === 'binding_current' && binding.binding.taskId).toBe(row.taskId);
    expect(readFileSync(fx.otherPin, 'utf8')).toBe('OTHER=1\nORCH_HANDLE=term_other\n');
  });

  it('calls run-use once when the old handle is absent and binds the unique orchestrator assignment', async () => {
    const fx = fixture();
    const worker = await publishRow(fx.file, 'task_worker', 'ctx_worker', 'worker');
    const row = await publishRow(fx.file, 'task_orch', 'ctx_orch');
    const { bindOperatorPrimary } = await import('./lib/worker-assignment-store.ts');
    const bound = await bindOperatorPrimary({
      file: fx.file,
      expectedProject: { projectId: 'orchestrator-pack', repository: 'chetwerikoff/orchestrator-pack' },
      taskId: worker.taskId,
      bindingKey: worker.bindingKey,
    });
    expect(bound.ok).toBe(true);
    const state = world([{ id: row.taskId, dispatchId: row.bindingKey }], OLD_HANDLE);
    const report = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE],
      env: fx.env,
      runNative: native(state, fx.primary),
    });
    expect(report.ok).toBe(true);
    expect(report.runUseCount).toBe(1);
    expect(runUses(state)).toBe(1);
    expect(state.calls.filter((call) => call[1] === 'run-show').every((call) => call.includes('--full'))).toBe(true);
    const binding = readOperatorPrimaryBinding(fx.file, {
      projectId: 'orchestrator-pack',
      repository: 'chetwerikoff/orchestrator-pack',
    });
    expect(binding.ok && binding.status === 'binding_current' ? binding.binding : null).toMatchObject({
      taskId: row.taskId,
      bindingKey: row.bindingKey,
      assignmentId: row.assignmentId,
      assignmentGeneration: row.generation,
    });
    expect(readFileSync(pinPath(fx.env), 'utf8')).toBe(`ORCH_HANDLE=${NEW_HANDLE}\n`);
    expect(readFileSync(fx.otherPin, 'utf8')).toContain('term_other');
  });

  it('names a still-live old handle and does not rebind', async () => {
    const fx = fixture();
    const row = await publishRow(fx.file, 'task_orch', 'ctx_orch');
    const state = world([{ id: row.taskId, dispatchId: row.bindingKey }], OLD_HANDLE);
    state.oldLive = true;
    const report = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE],
      env: fx.env,
      runNative: native(state, fx.primary),
    });
    expect(report.ok).toBe(false);
    expect(report.message).toBe(`close ${OLD_HANDLE} or attach from it`);
    expect(runUses(state)).toBe(0);
    expect(readOperatorPrimaryBinding(fx.file, {
      projectId: 'orchestrator-pack',
      repository: 'chetwerikoff/orchestrator-pack',
    })).toMatchObject({ status: 'binding_absent' });
  });

  it('refuses a failed or truncated terminal list, a failed run-use, and a conflicting readback', async () => {
    const fx = fixture();
    const row = await publishRow(fx.file, 'task_orch', 'ctx_orch');
    const tasks = [{ id: row.taskId, dispatchId: row.bindingKey }];
    for (const tweak of ['list', 'truncated', 'use', 'readback'] as const) {
      const state = world(tasks, OLD_HANDLE);
      if (tweak === 'list') state.listFail = true;
      if (tweak === 'truncated') state.listTruncated = true;
      if (tweak === 'use') state.runUseFail = true;
      if (tweak === 'readback') state.readbackStale = true;
      const report = await attachOrchestratorSeat({
        argv: ['attach', NEW_HANDLE],
        env: fx.env,
        runNative: native(state, fx.primary),
      });
      expect(report.ok, tweak).toBe(false);
      expect(runUses(state), tweak).toBe(tweak === 'use' || tweak === 'readback' ? 1 : 0);
      if (tweak === 'list' || tweak === 'truncated') {
        expect(report.message, tweak).toContain('restore Orca terminal visibility, inspect this Run and retry');
      } else {
        expect(report.message, tweak).toContain('inspect the exact Run and retry the restore only after resolving its coordinator');
      }
    }
  });

  it('refuses absent, mismatched, multiple, and stale assignment state before run-use', async () => {
    const fx = fixture();
    const absent = world([], OLD_HANDLE);
    await publishRow(fx.file, 'task_worker', 'ctx_worker', 'worker');
    const absentReport = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE],
      env: fx.env,
      runNative: native(absent, fx.primary),
    });
    expect(absentReport.ok).toBe(false);
    expect(absentReport.message).toContain('reconcile the existing local WorkerAssignment/Dispatch and primary pointer, then retry');
    expect(runUses(absent)).toBe(0);

    const mismatch = world([{ id: 'task_orch', dispatchId: 'ctx_orch' }], OLD_HANDLE);
    mismatch.dispatchMismatch = true;
    await publishRow(fx.file, 'task_orch', 'ctx_orch');
    const mismatchReport = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE],
      env: fx.env,
      runNative: native(mismatch, fx.primary),
    });
    expect(mismatchReport.message).toContain('no unique eligible');
    expect(runUses(mismatch)).toBe(0);

    const second = await publishRow(fx.file, 'task_orch_2', 'ctx_orch_2');
    const multiple = world([
      { id: 'task_orch', dispatchId: 'ctx_orch' },
      { id: second.taskId, dispatchId: second.bindingKey },
    ], OLD_HANDLE);
    const multipleReport = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE],
      env: fx.env,
      runNative: native(multiple, fx.primary),
    });
    expect(multipleReport.message).toContain('2 eligible');
    expect(runUses(multiple)).toBe(0);

    const staleFx = fixture();
    const staleRow = await publishRow(staleFx.file, 'task_orch', 'ctx_orch');
    const store = JSON.parse(readFileSync(staleFx.file, 'utf8')) as {
      operatorPrimary?: { assignmentGeneration: number };
    };
    store.operatorPrimary = {
      route: 'operator-primary',
      taskId: staleRow.taskId,
      bindingKey: staleRow.bindingKey,
      assignmentId: staleRow.assignmentId,
      assignmentGeneration: staleRow.generation + 9,
    };
    writeFileSync(staleFx.file, `${JSON.stringify(store)}\n`);
    const stale = world([{ id: staleRow.taskId, dispatchId: staleRow.bindingKey }], OLD_HANDLE);
    const staleReport = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE],
      env: staleFx.env,
      runNative: native(stale, staleFx.primary),
    });
    expect(staleReport.message).toContain('operator-primary pointer is stale');
    expect(runUses(stale)).toBe(0);
  });

  it('reports a partial pin failure after native rebind and primary replacement', async () => {
    const fx = fixture();
    const row = await publishRow(fx.file, 'task_orch', 'ctx_orch');
    const fleetDir = path.join(fx.root, '.config', 'orchestrator-fleet');
    rmSync(fleetDir, { recursive: true, force: true });
    writeFileSync(fleetDir, 'not-a-directory\n');
    const state = world([{ id: row.taskId, dispatchId: row.bindingKey }], OLD_HANDLE);
    const report = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE],
      env: fx.env,
      runNative: native(state, fx.primary),
    });
    expect(report.ok).toBe(false);
    expect(report.runUseCount).toBe(1);
    expect(report.partial?.runRebound).toBe(true);
    expect(report.primary).toBe('bound');
    expect(report.message).toContain('do not repeat run-use');
    expect(readFileSync(fleetDir, 'utf8')).toBe('not-a-directory\n');
  });

  it('leaves a duplicate pin untouched', async () => {
    const fx = fixture();
    const row = await publishRow(fx.file, 'task_orch', 'ctx_orch');
    const body = `ORCH_HANDLE=${OLD_HANDLE}\nORCH_HANDLE=${NEW_HANDLE}\n`;
    writeFileSync(pinPath(fx.env), body, { mode: 0o600 });
    const state = world([{ id: row.taskId, dispatchId: row.bindingKey }], NEW_HANDLE);
    const report = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE],
      env: fx.env,
      runNative: native(state, fx.primary),
    });
    expect(report.ok).toBe(false);
    expect(report.pin).toBe('refused');
    expect(readFileSync(pinPath(fx.env), 'utf8')).toBe(body);
    expect(runUses(state)).toBe(0);
  });

  it('refuses a symlinked pin path', async () => {
    const fx = fixture();
    const row = await publishRow(fx.file, 'task_orch', 'ctx_orch');
    const target = path.join(fx.root, 'elsewhere.env');
    writeFileSync(target, 'ORCH_HANDLE=term_elsewhere\n');
    symlinkSync(target, pinPath(fx.env));
    const state = world([{ id: row.taskId, dispatchId: row.bindingKey }], NEW_HANDLE);
    const report = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE],
      env: fx.env,
      runNative: native(state, fx.primary),
    });
    expect(report.pin).toBe('refused');
    expect(lstatSync(pinPath(fx.env)).isSymbolicLink()).toBe(true);
    expect(runUses(state)).toBe(0);
  });

  it('refuses a missing Run id, a missing terminal, and the wrong project', async () => {
    const fx = fixture();
    const missingRun = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE],
      env: { ...fx.env, OPK_RUN_ID: '' },
      runNative: async () => { throw new Error('native should not run'); },
    });
    expect(missingRun.message).toContain('set OPK_RUN_ID to the existing Run and retry');
    const state = world([], OLD_HANDLE);
    state.showFail = true;
    const missingTerminal = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE],
      env: fx.env,
      runNative: native(state, fx.primary),
    });
    expect(missingTerminal.message).toContain('correct the handle/project/Orca runtime and retry');
    const wrongProject = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE, 'missing-project'],
      env: { ...fx.env, OPK_PROJECT_ID: '' },
      runNative: async () => { throw new Error('native should not run'); },
    });
    expect(wrongProject.message).toContain('correct the handle/project/Orca runtime and retry');
    expect(runUses(state)).toBe(0);
  });

  it('keeps resume on the existing launcher and rejects new flags', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runOpkOrchStart(['resume', 'session-1'], {
      env: {},
      resume: async (session) => ({ outcome: 'catalog_observed_unverified', session }),
      stdout: (text) => { stdout.push(text); },
      stderr: (text) => { stderr.push(text); },
    });
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('session-1');
    const refused: string[] = [];
    const resumeCode = await runOpkOrchStart(['resume', 'session-2'], {
      env: {},
      resume: async () => { throw new Error('catalog missing'); },
      stderr: (text) => { refused.push(text); },
    });
    expect(resumeCode).toBe(1);
    expect(refused.join('')).toContain('resume refused: catalog missing');
    const usage: string[] = [];
    const usageCode = await runOpkOrchStart(['attach', NEW_HANDLE, '--project', 'orchestrator-pack'], {
      env: {},
      resume: async () => { throw new Error('resume should not run'); },
      stderr: (text) => { usage.push(text); },
    });
    expect(usageCode).toBe(2);
    expect(usage.join('')).toContain('attach <terminal-handle> [project-id]');
    expect(usage.join('')).toContain('resume <existing-session-id>');
  });

  it('discovers a file-backed coordinator only when the inherited pin matches the file', () => {
    const fx = fixture();
    const file = pinPath(fx.env);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `ORCH_HANDLE=${NEW_HANDLE}\n`);
    const stale = fleetWakeConfigFromEnv({ ...fx.env, ORCH_HANDLE: OLD_HANDLE });
    const current = fleetWakeConfigFromEnv({ ...fx.env, ORCH_HANDLE: NEW_HANDLE });
    expect(stale.coordinatorPinFile).toBeUndefined();
    expect(current.coordinatorPinFile).toBe(file);
  });

  it('documents the declared mise attach entry and the narrow run-use exception', () => {
    const doc = readFileSync('docs/target_repo_setup.md', 'utf8');
    const declared = JSON.parse(readFileSync('scripts/toolchain/node-version.json', 'utf8')) as { nodeMajor: number };
    const entry = `mise exec node@${String(declared.nodeMajor)} -- node --experimental-strip-types scripts/opk-orch-start attach "$TERMINAL_HANDLE" "$PROJECT_ID"`;
    expect(doc).toContain(entry);
    expect(doc).toContain('EnvironmentFile=%h/.config/orchestrator-fleet/%i.env');
    expect(doc).toContain('systemctl --user daemon-reload');
    expect(doc).toContain('Run bound / pin written; fleet-wake adoption not verified');
    expect(doc).toContain('former `coordinator_handle` is absent');
    expect(doc).toContain('one `orca orchestration run-use --id "$OPK_RUN_ID"`');
    expect(doc).toContain('cannot be authoritatively proved no longer live');
    expect(doc).toContain('Never** recover a coordinator by calling `worker-start`');
    expect(doc).not.toContain('Remove the retired');
  });

  it('runs the tracked attach entry under the process Node with a synthetic orca', async () => {
    const fx = fixture();
    const row = await publishRow(fx.file, 'task_orch', 'ctx_orch');
    const bin = path.join(fx.root, 'bin');
    mkdirSync(bin);
    const calls = path.join(fx.root, 'calls.ndjson');
    writeFileSync(path.join(bin, 'orca'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.OPK_CALL_LOG, JSON.stringify(args) + '\\n');
const primary = process.env.OPK_PRIMARY;
const handle = ${JSON.stringify(NEW_HANDLE)};
const run = ${JSON.stringify(RUN)};
const task = ${JSON.stringify(row.taskId)};
const dispatch = ${JSON.stringify(row.bindingKey)};
const command = args[1];
let result;
if (command === 'show') result = { terminal: { handle, worktreePath: primary } };
else if (command === 'list') result = { terminals: [{ handle, worktreePath: primary }], truncated: false, totalCount: 1 };
else if (command === 'run-show') result = { run: { id: run, coordinator_handle: handle } };
else if (command === 'task-list') result = { tasks: [{ id: task }] };
else if (command === 'dispatch-show') result = { dispatch: { id: dispatch, task_id: task, run_id: run } };
else if (command === 'worker-show') result = { dispatchId: dispatch, taskId: task, runId: run };
else { process.stderr.write('unexpected\\n'); process.exit(1); }
process.stdout.write(JSON.stringify({ ok: true, result }));
`);
    chmodSync(path.join(bin, 'orca'), 0o755);
    const child = runProcessSync({
      command: process.execPath,
      args: ['--experimental-strip-types', 'scripts/opk-orch-start', 'attach', NEW_HANDLE],
      cwd: process.cwd(),
      env: {
        ...fx.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        OPK_CALL_LOG: calls,
        OPK_PRIMARY: fx.primary,
      },
      inheritParentEnv: true,
    });
    expect(child.exitCode, child.stderr).toBe(0);
    const report = JSON.parse(child.stdout) as { ok: boolean; runUseCount: number };
    expect(report.ok).toBe(true);
    expect(report.runUseCount).toBe(0);
    expect(readFileSync(calls, 'utf8')).not.toContain('run-use');
    expect(readFileSync(pinPath(fx.env), 'utf8')).toBe(`ORCH_HANDLE=${NEW_HANDLE}\n`);
  });
});
