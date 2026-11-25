// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fleetWakeConfigFromEnv } from './fleet/fleet-wake.ts';
import { runProcessSync } from './kernel/subprocess.ts';
import { resolveWorkerAssignmentStorePath } from './lib/worker-assignment-store.ts';
import { projectCardPath } from './lib/target-context.ts';
import {
  attachOrchestratorSeat,
  checkOrchestratorPrelaunch,
  runOpkOrchStart,
  type NativeCommand,
  type NativeCommandResult,
} from './orca-runtime/orchestrator-attach.ts';

const roots: string[] = [];
const RUN = 'run_restore_2855';
const NEW_HANDLE = 'term_new_seat';
const OLD_HANDLE = 'term_old_seat';
const OTHER_HANDLE = 'term_other_seat';

interface Fixture {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly primary: string;
  readonly otherPin: string;
}

interface World {
  coordinator: string | null;
  listFail: boolean;
  listTruncated: boolean;
  listOmitCensus: boolean;
  listLiveness: 'running' | 'connected' | 'unknown' | 'active' | 'open';
  oldLive: boolean;
  oldListedStatus: string;
  otherListed: boolean;
  showFail: boolean;
  runUseFail: boolean;
  readbackStale: boolean;
  readbackFail: boolean;
  showPath: string;
  readonly calls: string[][];
}

/** Operator-selected Run in the selected project file; the only Run authority. */
function fixture(selected: string | null = `OPK_RUN_ID=${RUN}\n`): Fixture {
  const root = mkdtempSync(path.join('/tmp', 'opk-orch-start-'));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPK_BASE_DIR: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    HOME: root,
    OPK_PROJECT_ID: 'orchestrator-pack',
    OPK_RUN_ID: RUN,
    ORCA_TERMINAL_HANDLE: NEW_HANDLE,
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
  if (selected !== null) writeFileSync(pinPath(env), selected, { mode: 0o600 });
  return { root, env, primary, otherPin };
}

function world(coordinator: string | null): World {
  return {
    coordinator,
    listFail: false,
    listTruncated: false,
    listOmitCensus: false,
    listLiveness: 'running',
    oldLive: false,
    oldListedStatus: '',
    otherListed: false,
    showFail: false,
    runUseFail: false,
    readbackStale: false,
    readbackFail: false,
    showPath: '',
    calls: [],
  };
}

function terminalRow(handle: string, worktreePath: string, liveness: World['listLiveness']): Record<string, unknown> {
  if (liveness === 'connected') return { handle, worktreePath, connected: true };
  if (liveness === 'unknown') return { handle, worktreePath, status: 'unknown', connected: false };
  if (liveness === 'active' || liveness === 'open') return { handle, worktreePath, status: liveness, connected: true };
  return { handle, worktreePath, status: 'running', connected: true };
}

function native(state: World, primary: string): NativeCommand {
  return async (args) => {
    state.calls.push([...args]);
    const command = args[1] ?? '';
    const full = args.includes('--full');
    const seat = state.showPath || primary;
    if (state.showFail && command === 'show') return { code: 1, stdout: '', stderr: 'missing terminal' };
    if (command === 'show') {
      return json({ terminal: { handle: NEW_HANDLE, worktreePath: seat, status: 'running', connected: true } });
    }
    if (command === 'list') {
      if (state.listFail) return { code: 1, stdout: '', stderr: 'list failed' };
      const terminals = [terminalRow(NEW_HANDLE, seat, state.listLiveness)];
      if (state.oldLive) terminals.push(terminalRow(OLD_HANDLE, seat, 'running'));
      else if (state.oldListedStatus) {
        terminals.push({ handle: OLD_HANDLE, worktreePath: seat, status: state.oldListedStatus, connected: false });
      }
      if (state.otherListed) terminals.push(terminalRow(OTHER_HANDLE, seat, 'running'));
      if (state.listOmitCensus) return json({ terminals, hostScope: 'local' });
      return json({
        terminals,
        truncated: state.listTruncated,
        totalCount: terminals.length,
        hostScope: 'local',
      });
    }
    if (command === 'run-show') {
      const used = state.calls.filter((call) => call[1] === 'run-use').length;
      if (state.readbackFail && used > 0) return { code: 1, stdout: '', stderr: 'run-show failed' };
      if (!full) return json({ runId: RUN, objective: 'restore', removedWork: [] });
      const coordinator = state.readbackStale && used > 0 ? OLD_HANDLE : state.coordinator;
      return json({ run: { id: RUN, coordinator_handle: coordinator } });
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

const noNative: NativeCommand = async () => { throw new Error('native should not run'); };

async function attach(fx: Fixture, state: World, extra: NodeJS.ProcessEnv = {}) {
  return attachOrchestratorSeat({
    argv: ['attach', NEW_HANDLE],
    env: { ...fx.env, ...extra },
    runNative: native(state, fx.primary),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('opk-orch-start attach', () => {
  it('repairs the selected pin without run-use when the Run already names the live handle', async () => {
    const fx = fixture(`KEEP=yes\nOPK_RUN_ID=${RUN}\nORCH_HANDLE=term_stale\n`);
    const state = world(NEW_HANDLE);
    const first = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE, 'orchestrator-pack'],
      env: fx.env,
      runNative: native(state, fx.primary),
    });
    const second = await attach(fx, state);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.pin).toBe('written');
    expect(second.pin).toBe('unchanged');
    expect(runUses(state)).toBe(0);
    expect(readFileSync(pinPath(fx.env), 'utf8')).toBe(`KEEP=yes\nOPK_RUN_ID=${RUN}\nORCH_HANDLE=${NEW_HANDLE}\n`);
    expect(lstatSync(pinPath(fx.env)).mode & 0o777).toBe(0o600);
    expect(readFileSync(fx.otherPin, 'utf8')).toBe('OTHER=1\nORCH_HANDLE=term_other\n');
  });

  it('calls run-use once when the old handle is absent, with no WorkerAssignment row or primary binding (#2896)', async () => {
    const fx = fixture();
    const state = world(OLD_HANDLE);
    const report = await attach(fx, state);
    expect(report.ok).toBe(true);
    expect(report.runUseCount).toBe(1);
    expect(runUses(state)).toBe(1);
    expect(state.calls.filter((call) => call[1] === 'run-show').every((call) => call.includes('--full'))).toBe(true);
    // Attach reads and writes no assignment, task, dispatch or worker state at all.
    expect(state.calls.filter((call) => ['task-list', 'dispatch-show', 'worker-show'].includes(call[1] ?? ''))).toHaveLength(0);
    expect(existsSync(resolveWorkerAssignmentStorePath('orchestrator-pack', fx.env))).toBe(false);
    expect(readFileSync(pinPath(fx.env), 'utf8')).toBe(`OPK_RUN_ID=${RUN}\nORCH_HANDLE=${NEW_HANDLE}\n`);
    expect(readFileSync(fx.otherPin, 'utf8')).toContain('term_other');
  });

  it('refuses before run-use when the selected file changes during the native reads (#2896)', async () => {
    for (const { mutate, remains } of [
      { mutate: (file: string) => writeFileSync(file, 'OPK_RUN_ID=run_other_9\nORCH_HANDLE=term_elsewhere\n', { mode: 0o600 }), remains: true },
      { mutate: (file: string) => rmSync(file), remains: false },
    ]) {
      const fx = fixture();
      const state = world(OLD_HANDLE);
      const inner = native(state, fx.primary);
      const report = await attachOrchestratorSeat({
        argv: ['attach', NEW_HANDLE],
        env: fx.env,
        runNative: async (args) => {
          const result = await inner(args);
          if (args[1] === 'run-show') mutate(pinPath(fx.env));
          return result;
        },
      });
      expect(report.ok).toBe(false);
      expect(runUses(state)).toBe(0);
      expect(report.pin).toBe('refused');
      // The changed or removed file is never recreated or overwritten from the stale selection.
      expect(existsSync(pinPath(fx.env))).toBe(remains);
      if (remains) expect(readFileSync(pinPath(fx.env), 'utf8')).toBe('OPK_RUN_ID=run_other_9\nORCH_HANDLE=term_elsewhere\n');
    }
  });

  it('reports a partial result and keeps the new selection when the file changes after run-use (#2896)', async () => {
    const fx = fixture();
    const state = world(OLD_HANDLE);
    const inner = native(state, fx.primary);
    const report = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE],
      env: fx.env,
      runNative: async (args) => {
        const result = await inner(args);
        if (args[1] === 'run-use') {
          writeFileSync(pinPath(fx.env), 'OPK_RUN_ID=run_other_9\nORCH_HANDLE=term_elsewhere\n', { mode: 0o600 });
        }
        return result;
      },
    });
    expect(report.ok).toBe(false);
    expect(runUses(state)).toBe(1);
    expect(report.partial?.runRebound).toBe(true);
    expect(readFileSync(pinPath(fx.env), 'utf8')).toBe('OPK_RUN_ID=run_other_9\nORCH_HANDLE=term_elsewhere\n');
  });

  it('repairs a stale absent pin and binds a Run whose coordinator is null', async () => {
    const fx = fixture(`OPK_RUN_ID=${RUN}\nORCH_HANDLE=term_gone\n`);
    const state = world(null);
    const report = await attach(fx, state);
    expect(report.ok).toBe(true);
    expect(report.runUseCount).toBe(1);
    expect(readFileSync(pinPath(fx.env), 'utf8')).toBe(`OPK_RUN_ID=${RUN}\nORCH_HANDLE=${NEW_HANDLE}\n`);
  });

  it('names a still-live old handle and neither rebinds nor writes the pin', async () => {
    const fx = fixture();
    const state = world(OLD_HANDLE);
    state.oldLive = true;
    const report = await attach(fx, state);
    expect(report.ok).toBe(false);
    expect(report.message).toBe(`close ${OLD_HANDLE} or attach from it`);
    expect(runUses(state)).toBe(0);
    expect(readFileSync(pinPath(fx.env), 'utf8')).toBe(`OPK_RUN_ID=${RUN}\n`);
  });

  it('refuses before effects when the pin names another still-listed terminal', async () => {
    const fx = fixture(`OPK_RUN_ID=${RUN}\nORCH_HANDLE=${OTHER_HANDLE}\n`);
    const state = world(null);
    state.otherListed = true;
    const report = await attach(fx, state);
    expect(report.ok).toBe(false);
    expect(report.pin).toBe('refused');
    expect(report.message).toContain(`selected pin names ${OTHER_HANDLE}, which is still listed`);
    expect(runUses(state)).toBe(0);
    expect(readFileSync(pinPath(fx.env), 'utf8')).toBe(`OPK_RUN_ID=${RUN}\nORCH_HANDLE=${OTHER_HANDLE}\n`);
  });

  it('refuses a failed or truncated terminal list, a failed run-use, and a conflicting readback', async () => {
    const fx = fixture();
    for (const tweak of ['list', 'truncated', 'use', 'readback'] as const) {
      const state = world(OLD_HANDLE);
      if (tweak === 'list') state.listFail = true;
      if (tweak === 'truncated') state.listTruncated = true;
      if (tweak === 'use') state.runUseFail = true;
      if (tweak === 'readback') state.readbackStale = true;
      const report = await attach(fx, state);
      expect(report.ok, tweak).toBe(false);
      expect(runUses(state), tweak).toBe(tweak === 'use' || tweak === 'readback' ? 1 : 0);
      if (tweak === 'list' || tweak === 'truncated') {
        expect(report.message, tweak).toContain('restore Orca terminal visibility, inspect this Run and retry');
      } else {
        expect(report.message, tweak).toContain('inspect the exact Run and retry the restore only after resolving its coordinator');
      }
      if (tweak === 'use') expect(report.partial?.runRebound, tweak).toBe('unknown');
      if (tweak === 'readback') expect(report.partial?.runRebound, tweak).toBe(false);
    }
    expect(readFileSync(pinPath(fx.env), 'utf8')).toBe(`OPK_RUN_ID=${RUN}\n`);
  });

  it('refuses an absent or malformed selected file, and an unequal caller Run or terminal handle, before native effects', async () => {
    const cases: readonly { readonly name: string; readonly selected: string | null; readonly env?: NodeJS.ProcessEnv; readonly text: string }[] = [
      { name: 'absent file', selected: null, text: 'selected project file is unreadable' },
      { name: 'no OPK_RUN_ID', selected: 'ORCH_HANDLE=term_x\n', text: 'has no OPK_RUN_ID' },
      { name: 'malformed OPK_RUN_ID', selected: 'OPK_RUN_ID=not-a-run\n', text: 'malformed OPK_RUN_ID' },
      { name: 'duplicate OPK_RUN_ID', selected: `OPK_RUN_ID=${RUN}\nOPK_RUN_ID=run_other\n`, text: 'selected project file:' },
      { name: 'caller Run unequal', selected: `OPK_RUN_ID=${RUN}\n`, env: { OPK_RUN_ID: 'run_other' }, text: 'set OPK_RUN_ID to the existing Run and retry' },
      { name: 'caller Run empty', selected: `OPK_RUN_ID=${RUN}\n`, env: { OPK_RUN_ID: '' }, text: 'set OPK_RUN_ID to the existing Run and retry' },
      { name: 'caller terminal unequal', selected: `OPK_RUN_ID=${RUN}\n`, env: { ORCA_TERMINAL_HANDLE: OTHER_HANDLE }, text: 'ORCA_TERMINAL_HANDLE must equal the requested handle' },
      { name: 'caller terminal absent', selected: `OPK_RUN_ID=${RUN}\n`, env: { ORCA_TERMINAL_HANDLE: '' }, text: 'ORCA_TERMINAL_HANDLE must equal the requested handle' },
    ];
    for (const row of cases) {
      const fx = fixture(row.selected);
      const report = await attachOrchestratorSeat({
        argv: ['attach', NEW_HANDLE],
        env: { ...fx.env, ...row.env },
        runNative: noNative,
      });
      expect(report.ok, row.name).toBe(false);
      expect(report.message, row.name).toContain(row.text);
      expect(report.runUseCount, row.name).toBe(0);
    }
  });

  it('reports a partial pin failure after native rebind', async () => {
    const fx = fixture();
    // The selected path is replaced by a directory only after the earlier checks pass.
    const state = world(OLD_HANDLE);
    const base = native(state, fx.primary);
    const report = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE],
      env: fx.env,
      runNative: async (args) => {
        const result = await base(args);
        if (args[1] === 'run-use') {
          rmSync(pinPath(fx.env));
          mkdirSync(pinPath(fx.env));
        }
        return result;
      },
    });
    expect(report.ok).toBe(false);
    expect(report.runUseCount).toBe(1);
    expect(report.partial?.runRebound).toBe(true);
    expect(report.pin).toBe('refused');
    expect(report.message).toContain('do not repeat run-use');
  });

  it('refuses a duplicate ORCH_HANDLE entry untouched', async () => {
    const body = `OPK_RUN_ID=${RUN}\nORCH_HANDLE=${OLD_HANDLE}\nORCH_HANDLE=${NEW_HANDLE}\n`;
    const fx = fixture(body);
    const state = world(NEW_HANDLE);
    const report = await attach(fx, state);
    expect(report.ok).toBe(false);
    expect(readFileSync(pinPath(fx.env), 'utf8')).toBe(body);
    expect(runUses(state)).toBe(0);
  });

  it('refuses a symlinked selected file', async () => {
    const fx = fixture(null);
    const target = path.join(fx.root, 'elsewhere.env');
    writeFileSync(target, `OPK_RUN_ID=${RUN}\nORCH_HANDLE=term_elsewhere\n`);
    symlinkSync(target, pinPath(fx.env));
    const state = world(NEW_HANDLE);
    const report = await attachOrchestratorSeat({ argv: ['attach', NEW_HANDLE], env: fx.env, runNative: noNative });
    expect(report.ok).toBe(false);
    expect(report.message).toContain('redirected');
    expect(lstatSync(pinPath(fx.env)).isSymbolicLink()).toBe(true);
    expect(runUses(state)).toBe(0);
  });

  it('refuses a missing terminal and the wrong project', async () => {
    const fx = fixture();
    const state = world(OLD_HANDLE);
    state.showFail = true;
    const missingTerminal = await attach(fx, state);
    expect(missingTerminal.message).toContain('correct the handle/project/Orca runtime and retry');
    const wrongProject = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE, 'missing-project'],
      env: { ...fx.env, OPK_PROJECT_ID: '' },
      runNative: noNative,
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
    expect(usage.join('')).toContain('precheck [project-id]');
    expect(usage.join('')).toContain('resume <existing-session-id>');
  });

  it('always points fleet-wake at the selected project file; an inherited ORCH_HANDLE never selects', () => {
    const fx = fixture(`OPK_RUN_ID=${RUN}\nORCH_HANDLE=${NEW_HANDLE}\n`);
    for (const inherited of [OLD_HANDLE, NEW_HANDLE, undefined]) {
      const config = fleetWakeConfigFromEnv({ ...fx.env, ...(inherited ? { ORCH_HANDLE: inherited } : {}) });
      expect(config.coordinatorPinFile).toBe(pinPath(fx.env));
      expect(config.orchestratorHandle).toBeUndefined();
    }
  });

  it('documents the declared mise attach entry, operator Run adoption and the narrow run-use exception', () => {
    const doc = readFileSync('docs/target_repo_setup.md', 'utf8');
    const declared = JSON.parse(readFileSync('scripts/toolchain/node-version.json', 'utf8')) as { nodeMajor: number };
    const entry = `mise exec node@${String(declared.nodeMajor)} -- node --experimental-strip-types scripts/opk-orch-start attach "$TERMINAL_HANDLE" "$PROJECT_ID"`;
    expect(doc).toContain(entry);
    expect(doc).toContain('EnvironmentFile=%h/.config/orchestrator-fleet/%i.env');
    expect(doc).toContain('systemctl --user daemon-reload');
    expect(doc).toContain('Run bound / pin written; fleet-wake adoption not verified');
    expect(doc).toContain('one literal `OPK_RUN_ID=<run id>`');
    expect(doc).toContain('scripts/opk-orch-start precheck');
    expect(doc).toContain('one `orca orchestration run-use --id "$OPK_RUN_ID"`');
    expect(doc).toContain('cannot be authoritatively proved no longer live');
    expect(doc).toContain('Never** recover a coordinator by calling `worker-start`');
    expect(doc).not.toContain('Remove the retired');
  });

  it('runs the tracked attach entry under the process Node with a synthetic orca', async () => {
    const fx = fixture();
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
const command = args[1];
let result;
if (command === 'show') result = { terminal: { handle, worktreePath: primary } };
else if (command === 'list') result = { terminals: [{ handle, worktreePath: primary, status: 'running', connected: true }], truncated: false, totalCount: 1 };
else if (command === 'run-show') result = args.includes('--full') ? { run: { id: run, coordinator_handle: handle } } : { runId: run };
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
        PATH: process.env.PATH ?? '',
        OPK_RUNTIME_CLI_COMMAND: path.join(bin, 'orca'),
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
    const logged = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(logged.filter((args) => args[0] === 'orchestration').every((args) => args.includes('--full') && args.at(-1) === '--json')).toBe(true);
    expect(logged.some((args) => args[0] === 'terminal' && args.at(-1) === '--json' && !args.includes('--full'))).toBe(true);
    expect(readFileSync(pinPath(fx.env), 'utf8')).toBe(`OPK_RUN_ID=${RUN}\nORCH_HANDLE=${NEW_HANDLE}\n`);
  });

  it('requests full native records and the configured Orca executable', async () => {
    const fx = fixture();
    const state = world(NEW_HANDLE);
    const report = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE],
      env: { ...fx.env, OPK_RUNTIME_CLI_COMMAND: path.join(fx.root, 'orca-override') },
      runNative: native(state, fx.primary),
    });
    expect(report.ok).toBe(true);
    const orchestration = state.calls.filter((call) => call[0] === 'orchestration');
    expect(orchestration.length).toBeGreaterThan(0);
    expect(orchestration.every((call) => call.includes('--full') && call.at(-1) === '--json')).toBe(true);
    expect(state.calls.filter((call) => call[0] === 'terminal').every((call) => !call.includes('--full'))).toBe(true);
  });

  it('rejects an incomplete terminal census and an unknown seat', async () => {
    const fx = fixture();
    const omitted = world(OLD_HANDLE);
    omitted.listOmitCensus = true;
    const omittedReport = await attach(fx, omitted);
    expect(omittedReport.message).toContain('restore Orca terminal visibility, inspect this Run and retry');
    expect(runUses(omitted)).toBe(0);
    const unknown = world(OLD_HANDLE);
    unknown.listLiveness = 'unknown';
    const unknownReport = await attach(fx, unknown);
    expect(unknownReport.message).toContain('correct the handle/project/Orca runtime and retry');
    expect(runUses(unknown)).toBe(0);
  });

  it('accepts a requested seat whose list row omits status or is active or open', async () => {
    const fx = fixture();
    for (const liveness of ['connected', 'active', 'open'] as const) {
      const state = world(NEW_HANDLE);
      state.listLiveness = liveness;
      const report = await attach(fx, state);
      expect(report.ok, liveness).toBe(true);
      expect(runUses(state), liveness).toBe(0);
    }
  });

  it('refuses a workspace-pattern path that is not the selected primary root', async () => {
    const fx = fixture();
    const seat = path.join(fx.root, 'orca', 'workspaces', 'orchestrator-pack', 'other-seat');
    mkdirSync(seat, { recursive: true });
    const state = world(OLD_HANDLE);
    state.showPath = seat;
    const report = await attach(fx, state);
    expect(report.ok).toBe(false);
    expect(report.message).toContain('correct the handle/project/Orca runtime and retry');
    expect(runUses(state)).toBe(0);
    expect(readFileSync(pinPath(fx.env), 'utf8')).toBe(`OPK_RUN_ID=${RUN}\n`);
  });

  it('refuses a symlink above HOME or the config directory before run-use or pin write', async () => {
    const outside = mkdtempSync(path.join('/tmp', 'opk-orch-outside-'));
    roots.push(outside);
    const fx = fixture(null);
    const alias = path.join(fx.root, 'alias');
    symlinkSync(outside, alias);
    const home = path.join(alias, 'user');
    mkdirSync(path.join(outside, 'user', '.config', 'orchestrator-fleet'), { recursive: true });
    writeFileSync(path.join(outside, 'user', '.config', 'orchestrator-fleet', 'orchestrator-pack.env'), `OPK_RUN_ID=${RUN}\n`);
    const state = world(OLD_HANDLE);
    const report = await attachOrchestratorSeat({
      argv: ['attach', NEW_HANDLE],
      env: { ...fx.env, HOME: home },
      runNative: native(state, fx.primary),
    });
    expect(report.ok).toBe(false);
    expect(report.message).toContain('redirected');
    expect(runUses(state)).toBe(0);
    expect(readFileSync(path.join(outside, 'user', '.config', 'orchestrator-fleet', 'orchestrator-pack.env'), 'utf8')).toBe(`OPK_RUN_ID=${RUN}\n`);
  });

  it('reports an unconfirmed run-show after run-use as an unknown rebind', async () => {
    const fx = fixture();
    const state = world(OLD_HANDLE);
    state.readbackFail = true;
    const report = await attach(fx, state);
    expect(report.ok).toBe(false);
    expect(report.runUseCount).toBe(1);
    expect(report.partial?.runRebound).toBe('unknown');
    expect(report.message).toContain('did not confirm the coordinator');
    expect(report.message).not.toContain('did not rebind');
  });

  it('refuses a listed former coordinator that is unknown or exited', async () => {
    const fx = fixture();
    for (const status of ['unknown', 'exited'] as const) {
      const state = world(OLD_HANDLE);
      state.oldListedStatus = status;
      const report = await attach(fx, state);
      expect(report.ok, status).toBe(false);
      expect(report.message, status).toContain(`former coordinator ${OLD_HANDLE} is still listed`);
      expect(runUses(state), status).toBe(0);
    }
  });
});

describe('opk-orch-start precheck (#2896)', () => {
  const run = (fx: Fixture, state: World, argv: readonly string[] = ['precheck']) =>
    checkOrchestratorPrelaunch({ argv, env: fx.env, runNative: native(state, fx.primary) });

  it('accepts when the configured Run has no live incumbent and states what it does not cover', async () => {
    const fx = fixture();
    const state = world(null);
    const report = await run(fx, state);
    expect(report.ok).toBe(true);
    expect(report.message).toContain('simultaneous starts are not checked');
    expect(state.calls.every((call) => call[1] !== 'run-use')).toBe(true);
  });

  it('refuses a live incumbent coordinator and a pin naming another still-listed terminal, read-only', async () => {
    const fx = fixture();
    const live = world(OLD_HANDLE);
    live.oldLive = true;
    const liveReport = await run(fx, live);
    expect(liveReport.ok).toBe(false);
    expect(liveReport.incumbentHandle).toBe(OLD_HANDLE);
    const pinned = fixture(`OPK_RUN_ID=${RUN}\nORCH_HANDLE=${OTHER_HANDLE}\n`);
    const other = world(null);
    other.otherListed = true;
    const pinnedReport = await run(pinned, other);
    expect(pinnedReport.ok).toBe(false);
    expect(pinnedReport.message).toContain(`selected pin names ${OTHER_HANDLE}`);
    expect([...live.calls, ...other.calls].some((call) => call[1] === 'run-use')).toBe(false);
    expect(readFileSync(pinPath(pinned.env), 'utf8')).toBe(`OPK_RUN_ID=${RUN}\nORCH_HANDLE=${OTHER_HANDLE}\n`);
  });

  it('allows a stale absent pin and refuses an unreadable census, an unreadable Run and a missing selection', async () => {
    const stale = fixture(`OPK_RUN_ID=${RUN}\nORCH_HANDLE=term_gone\n`);
    expect((await run(stale, world(OLD_HANDLE))).ok).toBe(true);
    const census = world(null);
    census.listFail = true;
    expect((await run(fixture(), census)).ok).toBe(false);
    const absent = fixture(null);
    const report = await checkOrchestratorPrelaunch({ argv: ['precheck'], env: absent.env, runNative: noNative });
    expect(report.ok).toBe(false);
    expect(report.message).toContain('selected project file is unreadable');
    const exited = world(OLD_HANDLE);
    exited.oldListedStatus = 'exited';
    expect((await run(fixture(), exited)).ok).toBe(false);
  });

  it('is routed by the launcher entry with a JSON report and exit code', async () => {
    const fx = fixture();
    const state = world(null);
    const stdout: string[] = [];
    const code = await runOpkOrchStart(['precheck'], {
      env: fx.env,
      resume: async () => { throw new Error('resume should not run'); },
      runNative: native(state, fx.primary),
      stdout: (text) => { stdout.push(text); },
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.join('')) as { ok: boolean }).toMatchObject({ ok: true });
  });
});
