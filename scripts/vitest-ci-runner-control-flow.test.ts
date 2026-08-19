// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const subprocess = vi.hoisted(() => ({ run: vi.fn() }));
const fleet = vi.hoisted(() => ({
  cleanup: vi.fn(async () => [] as Array<{ ok: boolean; survivors: string[]; leaseId: string; reason?: string }>),
  observe: vi.fn(async () => [] as Array<{ ok: boolean; survivors: string[]; leaseId: string; reason?: string }>),
}));

vi.mock('./toolchain/native-entrypoint-preflight.ts', () => ({}));
vi.mock('./kernel/subprocess.ts', () => ({ runProcess: subprocess.run }));
vi.mock('./lib/vitest-live-store-harness.mjs', () => ({
  createHarnessRoot: () => path.join(process.cwd(), '.vitest-ci-runner-control-harness'),
  applyOpkVitestHarnessEnv: () => undefined,
  cleanupHarnessRoot: () => undefined,
}));
vi.mock('./lib/testmode-fleet-lane.ts', () => ({
  cleanupHeavyShardFleet: fleet.cleanup,
  observeHeavyShardFleet: fleet.observe,
}));

import { main } from './vitest-ci-runner.ts';

interface ProcessReply {
  readonly ok: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly writeReport?: boolean;
}

interface Scenario {
  lightPlan: unknown;
  heavyPlan: unknown;
  wallclockPlan: unknown;
  filePlans: Record<string, unknown>;
  npm: ProcessReply[];
  budget: ProcessReply[];
  failedTests: boolean[];
  cleanReports: boolean[];
  validate: ProcessReply[];
  merge: ProcessReply[];
}

const scenario: Scenario = {
  lightPlan: { lightMaxWorkers: 1, lightShardCount: 99, light: [], shard: 99 },
  heavyPlan: { shard: 99, files: [], totalRuntimeMs: 0 },
  wallclockPlan: { files: [] },
  filePlans: {},
  npm: [],
  budget: [],
  failedTests: [],
  cleanReports: [],
  validate: [],
  merge: [],
};

const touched = new Set<string>();

function result(reply: ProcessReply = { ok: true }): Record<string, unknown> {
  return {
    ok: reply.ok,
    stdout: reply.stdout ?? '',
    stderr: reply.stderr ?? '',
    exitCode: reply.exitCode ?? (reply.ok ? 0 : 1),
    outcome: 'exited',
    signal: null,
    error: null,
  };
}

function writeReportFromArgs(args: readonly string[]): void {
  const output = args.find((arg) => arg.startsWith('--outputFile='))?.slice('--outputFile='.length);
  if (!output) return;
  writeFileSync(output, '{"numFailedTests":0,"testResults":[]}\n', 'utf8');
  touched.add(output);
}

function json(value: unknown): Record<string, unknown> {
  return result({ ok: true, stdout: `${JSON.stringify(value)}\n` });
}

beforeEach(() => {
  // The outer CI lane scans the whole Vitest process output for RPC-flake
  // signatures. These tests intentionally synthesize those signatures inside the
  // mocked child result, so keep runner diagnostics private to the test process.
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);

  scenario.lightPlan = { lightMaxWorkers: 1, lightShardCount: 99, light: [], shard: 99 };
  scenario.heavyPlan = { shard: 99, files: [], totalRuntimeMs: 0 };
  scenario.wallclockPlan = { files: [] };
  scenario.filePlans = {};
  scenario.npm = [];
  scenario.budget = [];
  scenario.failedTests = [];
  scenario.cleanReports = [];
  scenario.validate = [];
  scenario.merge = [];
  subprocess.run.mockReset();
  fleet.cleanup.mockClear();
  fleet.observe.mockReset();
  fleet.observe.mockResolvedValue([]);

  subprocess.run.mockImplementation(async (input: { command: string; args: readonly string[] }) => {
    const args = [...input.args];
    const script = args[0] ?? '';

    if (script.endsWith('invoke-vitest-ci-lane-plan.mjs')) {
      const lane = args[1];
      if (lane === 'light') return json(scenario.lightPlan);
      if (lane === 'heavy') return json(scenario.heavyPlan);
      if (lane === 'wallclock') return json(scenario.wallclockPlan);
    }
    if (script.endsWith('resolve-vitest-heavy-file-run-plan.mjs')) {
      const file = args[1] ?? '';
      return json(scenario.filePlans[file] ?? { mode: 'file', pool: 'threads' });
    }
    if (script.endsWith('enforce-vitest-runtime-budget.mjs')) {
      return result(scenario.budget.shift() ?? { ok: true });
    }
    if (script.endsWith('vitest-json-report.mjs')) {
      const command = args[1];
      if (command === 'has-failed-tests') {
        return result({ ok: true, stdout: scenario.failedTests.shift() ? '1\n' : '0\n' });
      }
      if (command === 'is-clean') {
        return result({ ok: true, stdout: scenario.cleanReports.shift() ? '1\n' : '0\n' });
      }
      if (command === 'merge') {
        const reply = scenario.merge.shift() ?? { ok: true };
        if (reply.ok) {
          const index = args.indexOf('--output');
          const output = index >= 0 ? args[index + 1] : undefined;
          if (output) {
            writeFileSync(output, '{"numFailedTests":0,"testResults":[]}\n', 'utf8');
            touched.add(output);
          }
        }
        return result(reply);
      }
    }
    if (script.endsWith('vitest-heavy-batching.mjs')) {
      return result(scenario.validate.shift() ?? { ok: true });
    }
    if (args[0] === 'test') {
      const reply = scenario.npm.shift() ?? { ok: true };
      if (reply.writeReport) writeReportFromArgs(args);
      return result(reply);
    }
    return result({ ok: false, stderr: `unexpected subprocess: ${input.command} ${args.join(' ')}` });
  });
});

afterEach(() => {
  for (const file of touched) {
    if (existsSync(file)) rmSync(file, { force: true });
  }
  touched.clear();
  vi.restoreAllMocks();
});

function heavySingle(file = 'scripts/control-heavy.test.ts'): void {
  scenario.heavyPlan = { shard: 99, files: [file], totalRuntimeMs: 1 };
  scenario.filePlans[file] = { mode: 'file', pool: 'threads' };
}

describe('Vitest CI runner actual fail-closed control flow', () => {
  it('fails the light lane when the runtime budget guard rejects a successful report', async () => {
    scenario.lightPlan = { lightMaxWorkers: 1, lightShardCount: 99, light: ['scripts/control-light.test.ts'], shard: 99 };
    scenario.npm.push({ ok: true, writeReport: true });
    scenario.budget.push({ ok: false, exitCode: 1 });

    await expect(main(['light', '--shard', '99'])).resolves.toBe(1);
  });

  it('fails the light lane on an RPC-flake signature even when npm exits zero', async () => {
    scenario.lightPlan = { lightMaxWorkers: 1, lightShardCount: 99, light: ['scripts/control-light.test.ts'], shard: 99 };
    scenario.npm.push({ ok: true, stdout: 'vitest-worker onTaskUpdate RPC timeout', writeReport: true });

    await expect(main(['light', '--shard', '99'])).resolves.toBe(1);
  });

  it('retries a heavy RPC flake after cleanup and succeeds on fresh report evidence', async () => {
    heavySingle();
    scenario.npm.push(
      { ok: false, stdout: 'vitest-worker onTaskUpdate RPC timeout', exitCode: 1 },
      { ok: true, writeReport: true },
    );
    scenario.failedTests.push(false);
    scenario.cleanReports.push(false);

    await expect(main(['heavy', '--shard', '99'])).resolves.toBe(0);
    expect(fleet.cleanup).toHaveBeenCalledTimes(1);
    expect(subprocess.run.mock.calls.filter(([input]) => input.args?.[0] === 'test')).toHaveLength(2);
  });

  it('does not retry a heavy RPC flake when the report contains a genuine test failure', async () => {
    heavySingle();
    scenario.npm.push({ ok: false, stdout: 'vitest-worker onTaskUpdate RPC timeout', exitCode: 1, writeReport: true });
    scenario.failedTests.push(true);

    await expect(main(['heavy', '--shard', '99'])).resolves.toBe(1);
    expect(subprocess.run.mock.calls.filter(([input]) => input.args?.[0] === 'test')).toHaveLength(1);
  });

  it('fails closed after exhausting the bounded heavy retry budget', async () => {
    heavySingle();
    for (let index = 0; index < 5; index += 1) scenario.npm.push({ ok: false, exitCode: 1 });
    scenario.failedTests.push(false, false, false, false, false);

    await expect(main(['heavy', '--shard', '99'])).resolves.toBe(1);
    expect(subprocess.run.mock.calls.filter(([input]) => input.args?.[0] === 'test')).toHaveLength(5);
    expect(fleet.cleanup).toHaveBeenCalledTimes(5);
  });

  it('does not retry a batched heavy crash with no attributable failed report', async () => {
    const files = ['scripts/control-a.test.ts', 'scripts/control-b.test.ts'];
    scenario.heavyPlan = { shard: 99, files, totalRuntimeMs: 2 };
    for (const file of files) scenario.filePlans[file] = { mode: 'file', pool: 'threads' };
    scenario.npm.push({ ok: false, exitCode: 1 });
    scenario.failedTests.push(false);

    await expect(main(['heavy', '--shard', '99'])).resolves.toBe(1);
    expect(subprocess.run.mock.calls.filter(([input]) => input.args?.[0] === 'test')).toHaveLength(1);
  });

  it('fails when a successful heavy invocation emits no runtime report', async () => {
    heavySingle();
    scenario.npm.push({ ok: true });

    await expect(main(['heavy', '--shard', '99'])).resolves.toBe(1);
  });

  it('fails when heavy batch report validation rejects the produced report', async () => {
    heavySingle();
    scenario.npm.push({ ok: true, writeReport: true });
    scenario.validate.push({ ok: false, exitCode: 1 });

    await expect(main(['heavy', '--shard', '99'])).resolves.toBe(1);
  });

  it('fails when partial heavy reports cannot be merged', async () => {
    heavySingle();
    scenario.npm.push({ ok: true, writeReport: true });
    scenario.merge.push({ ok: false, exitCode: 1 });

    await expect(main(['heavy', '--shard', '99'])).resolves.toBe(1);
  });

  it('fails when the final merged heavy report exceeds the runtime budget', async () => {
    heavySingle();
    scenario.npm.push({ ok: true, writeReport: true });
    scenario.budget.push({ ok: false, exitCode: 1 });

    await expect(main(['heavy', '--shard', '99'])).resolves.toBe(1);
  });

  it('returns hygiene failure and cleans the scoped fleet when survivors remain', async () => {
    heavySingle();
    scenario.npm.push({ ok: true, writeReport: true });
    fleet.observe.mockResolvedValue([{ ok: false, survivors: ['pwsh:123'], leaseId: 'lease-dirty', reason: 'survivor' }]);

    await expect(main(['heavy', '--shard', '99'])).resolves.toBe(2);
    expect(fleet.cleanup).toHaveBeenCalled();
  });

  it('fails wall-clock execution when the configured plan is empty', async () => {
    scenario.wallclockPlan = { files: [] };
    await expect(main(['wallclock'])).resolves.toBe(1);
  });

  it('fails wall-clock execution on an RPC-flake signature', async () => {
    const file = 'scripts/control-wallclock.test.ts';
    scenario.wallclockPlan = { files: [file] };
    scenario.filePlans[file] = { mode: 'file', pool: 'threads' };
    scenario.npm.push({ ok: true, stdout: 'vitest-worker onTaskUpdate RPC timeout' });

    await expect(main(['wallclock'])).resolves.toBe(1);
  });
});
