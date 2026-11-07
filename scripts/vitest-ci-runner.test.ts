// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync } from './kernel/subprocess.ts';
import { validateHeavyBatchReportPayload, type HeavyInvocationUnit } from './lib/vitest-heavy-batching.mjs';
import { hasFailedTestsVitestJsonReport } from './lib/vitest-json-report.mjs';
import { observeHeavyLaneContext, readHeavyLaneContexts } from './lib/testmode-fleet-lane.ts';
import { buildLanePlan, partitionByLane, validateClassification } from './lib/vitest-ci-lanes.mjs';
import {
  aggregateFailures,
  aggregateFromEnv,
  buildHeavyInvocations,
  hasRpcFlake,
  heavyAttemptLimit,
  HEAVY_RETRY_DELAY_MS,
  isDirectEntrypoint,
  repositoryRootFromModuleUrl,
  runtimeReportAvailable,
  type HeavyFileRunPlan,
} from './vitest-ci-runner.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function runCheckedGit(repoRoot: string, args: string[]): string {
  const result = runProcessSync({
    command: 'git',
    args,
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error || 'unknown error'}`);
  }
  return result.stdout;
}

function makeTopologyEmitterFixture(): string {
  const root = makeRoot('opk-vitest-emitter-');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'plugins'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'sample.test.ts'), 'export {};\n', 'utf8');
  writeFileSync(path.join(root, 'scripts', 'vitest-ci-lanes.config.json'), `${JSON.stringify({
    lightMaxWorkers: 1,
    lightShardCount: 1,
    heavyDefaultRuntimeMs: 1000,
    heavyForkPoolMinRuntimeMs: 1000,
    targetShardSeconds: 60,
    minShardCount: 1,
    maxShardCount: 2,
    fallbackHeavyShardCount: 1,
    classification: {
      'scripts/sample.test.ts': 'heavy',
    },
  }, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(root, 'scripts', 'vitest-runtime-history.json'), '{"files": {}}\n', 'utf8');
  writeFileSync(path.join(root, 'scripts', 'vitest-heavy-topology.plan.json'), 'sentinel\n', 'utf8');

  runCheckedGit(root, ['init', '--quiet']);
  runCheckedGit(root, ['add', '.']);
  runCheckedGit(root, [
    '-c', 'user.name=orchestrator-pack-test',
    '-c', 'user.email=orchestrator-pack-test@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ]);
  return root;
}

function runTopologyEmitter(repoRoot: string, overrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPK_REPO_ROOT: repoRoot,
    GITHUB_ACTIONS: 'false',
    ...overrides,
  };
  delete env.GITHUB_EVENT_NAME;
  delete env.GITHUB_BASE_REF;
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.OPK_DISABLE_PRE_TOPOLOGY_MEASUREMENT;
  Object.assign(env, overrides);
  return runProcessSync({
    command: process.execPath,
    args: [path.join(process.cwd(), 'scripts', 'emit-vitest-heavy-topology.mjs'), '--skip-oversized-guard'],
    cwd: process.cwd(),
    env,
  });
}

describe('Vitest topology emitter worktree hygiene', () => {
  it('plans an unlisted test into heavy through the ordinary emitter without changing the manifest', () => {
    const root = makeTopologyEmitterFixture();
    const file = 'scripts/unlisted.test.ts';
    writeFileSync(path.join(root, file), 'export {};\n');
    const configPath = path.join(root, 'scripts/vitest-ci-lanes.config.json');
    const before = readFileSync(configPath, 'utf8');

    const emitted = runTopologyEmitter(root, { OPK_DISABLE_PRE_TOPOLOGY_MEASUREMENT: '1' });
    expect(emitted.exitCode, emitted.stderr).toBe(0);
    const plan = buildLanePlan(root);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.errors.join('\n'));
    expect(plan.heavy.filter((entry) => entry === file)).toHaveLength(1);
    expect(plan.heavyShards.flatMap((shard) => shard.files).filter((entry) => entry === file)).toHaveLength(1);
    expect(plan.light).not.toContain(file);
    expect(plan.parked).not.toContain(file);
    expect(plan.topology.heavyLaneTotalWeightSeconds).toBe(2);
    expect(readFileSync(configPath, 'utf8')).toBe(before);

    // Exercise the CI light planner on the ordinary emitter's fresh artifact,
    // without a lane directive supplying an ephemeral classification.
    const artifactPath = path.join(root, 'emitted-plan.json');
    writeFileSync(artifactPath, emitted.stdout);
    const light = runProcessSync({
      command: process.execPath,
      args: [path.resolve('scripts/invoke-vitest-ci-lane-plan.mjs'), 'light'],
      env: { ...process.env, OPK_VITEST_TOPOLOGY_PLAN_PATH: artifactPath },
      inheritParentEnv: false,
    });
    expect(light.ok, light.stderr).toBe(true);
    expect(JSON.parse(light.stdout).light).not.toContain(file);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('keeps unlisted tests in PR heavy selection and ignores renamed/deleted manifest entries', () => {
    const root = makeTopologyEmitterFixture();
    const oldFile = 'scripts/sample.test.ts';
    const file = 'scripts/renamed.test.ts';
    renameSync(path.join(root, oldFile), path.join(root, file));
    const configPath = path.join(root, 'scripts/vitest-ci-lanes.config.json');
    const before = readFileSync(configPath, 'utf8');
    const plan = buildLanePlan(root, {
      prScopeMode: 'enforce',
      changedPathManifest: {
        version: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), diffOk: true,
        entryCount: 1, entries: [{ status: 'R', path: file, previousPath: oldFile, oldMode: '100644', newMode: '100644' }],
      },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.errors.join('\n'));
    expect(plan.heavy).toEqual([file]);
    expect(plan.topology.prScope.effectiveRunMode).toBe('full'); // Existing rename policy.
    const added = buildLanePlan(root, {
      prScopeMode: 'enforce',
      changedPathManifest: {
        version: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), diffOk: true,
        entryCount: 1, entries: [{ status: 'A', path: file, newMode: '100644' }],
      },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error(added.errors.join('\n'));
    expect(added.topology.prScope.effectiveRunMode).toBe('scoped');
    expect(added.heavy).toEqual([file]);
    rmSync(path.join(root, file));
    const deleted = buildLanePlan(root);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) throw new Error(deleted.errors.join('\n'));
    expect(deleted.heavy).toEqual([]);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('preserves every explicit lane and parked consistency while defaulting only absent keys', () => {
    const classification = {
      'scripts/light.test.ts': 'light',
      'scripts/heavy.test.ts': 'heavy',
      'scripts/wallclock.test.ts': 'postMergeWallclock',
      'scripts/parked.test.ts': 'parked',
      'scripts/deleted.test.ts': 'light',
    };
    const discovered = Object.keys(classification).filter((file) => !file.includes('deleted'));
    discovered.push('scripts/new.test.ts');
    expect(validateClassification(discovered, classification)).toEqual([]);
    expect(partitionByLane(discovered, classification)).toEqual({
      light: ['scripts/light.test.ts'], heavy: ['scripts/heavy.test.ts', 'scripts/new.test.ts'],
      postMergeWallclock: ['scripts/wallclock.test.ts'], parked: ['scripts/parked.test.ts'],
    });
    const root = makeTopologyEmitterFixture();
    const configPath = path.join(root, 'scripts/vitest-ci-lanes.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.classification['scripts/sample.test.ts'] = 'parked';
    writeFileSync(configPath, JSON.stringify(config));
    const inconsistent = buildLanePlan(root);
    expect(inconsistent.ok).toBe(false);
    if (inconsistent.ok) throw new Error('expected inconsistent parked configuration to fail');
    expect(inconsistent.errors.join('\n')).toContain('classified parked file missing');
  });

  it.each(['', 'unknown', null, false, 0])('rejects an explicitly malformed lane %j with the exact correction key', (lane) => {
    const file = 'scripts/invalid.test.ts';
    const errors = validateClassification([file], { [file]: lane } as Record<string, string>);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`classification["${file}"]`);
    expect(errors[0]).toContain('scripts/vitest-ci-lanes.config.json');
    expect(partitionByLane([file], { [file]: lane } as Record<string, string>).heavy).toEqual([]);
  });

  it('leaves the tracked topology plan clean after a successful local run', () => {
    const root = makeTopologyEmitterFixture();
    const planPath = path.join(root, 'scripts', 'vitest-heavy-topology.plan.json');
    const before = readFileSync(planPath, 'utf8');

    const result = runTopologyEmitter(root, { OPK_DISABLE_PRE_TOPOLOGY_MEASUREMENT: '1' });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(planPath, 'utf8')).toBe(before);
    expect(runCheckedGit(root, ['status', '--porcelain'])).toBe('');
  });

  it('leaves the tracked topology plan clean after the diagnostic failure path', () => {
    const root = makeTopologyEmitterFixture();
    const planPath = path.join(root, 'scripts', 'vitest-heavy-topology.plan.json');
    const before = readFileSync(planPath, 'utf8');
    const binDir = makeRoot('opk-vitest-fake-npm-');
    const npmPath = path.join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (process.platform === 'win32') {
      writeFileSync(npmPath, '@exit /b 7\r\n', 'utf8');
    } else {
      writeFileSync(npmPath, '#!/bin/sh\nexit 7\n', 'utf8');
      chmodSync(npmPath, 0o755);
    }

    const result = runTopologyEmitter(root, { PATH: binDir });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('"fallbackClassification":"pre-topology-measurement-failed"');
    expect(readFileSync(planPath, 'utf8')).toBe(before);
    expect(runCheckedGit(root, ['status', '--porcelain'])).toBe('');
  });
});

function greenAggregate() {
  return {
    typecheckResult: 'success',
    vitestLightResult: 'success',
    vitestHeavyResult: 'success',
    contractResult: 'success',
    topologyResult: 'success',
    headSha: 'a'.repeat(40),
    runId: '12345',
  };
}

describe('Vitest CI aggregate authority', () => {
  it.each([
    ['', 'vitest-contracts result missing'],
    ['skipped', 'vitest-contracts unexpectedly skipped'],
    ['cancelled', 'vitest-contracts cancelled'],
    ['failure', 'vitest-contracts failed'],
    ['timed_out', 'vitest-contracts inconclusive (timed_out)'],
  ])('fails closed for contract result %j', (contractResult, expected) => {
    expect(aggregateFailures({ ...greenAggregate(), contractResult })).toContain(expected);
  });

  it('fails closed when current-head or current-run binding is absent', () => {
    const failures = aggregateFailures({ ...greenAggregate(), headSha: '', runId: '' });
    expect(failures).toContain('GITHUB_SHA missing (current-head binding)');
    expect(failures).toContain('GITHUB_RUN_ID missing (current-run binding)');
  });

  it('does not treat the retired PESTER_RESULT variable as a contract signal', () => {
    const input = aggregateFromEnv({
      TYPECHECK_RESULT: 'success',
      VITEST_LIGHT_RESULT: 'success',
      VITEST_HEAVY_RESULT: 'success',
      VITEST_TOPOLOGY_PLAN_RESULT: 'success',
      PESTER_RESULT: 'success',
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_RUN_ID: '12345',
    });
    expect(input.contractResult).toBe('');
    expect(aggregateFailures(input)).toContain('vitest-contracts result missing');
  });
});

describe('Vitest CI runner platform and report fail-closed helpers', () => {
  it('derives the repository root through fileURLToPath-compatible URLs', () => {
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'scripts', 'vitest-ci-runner.ts')).href;
    expect(repositoryRootFromModuleUrl(moduleUrl)).toBe(path.resolve(process.cwd()));
  });

  it('recognizes Windows direct entrypoints without turning wrappers into no-ops', () => {
    const windowsPath = String.raw`C:\repo\scripts\vitest-ci-runner.ts`;
    const moduleUrl = pathToFileURL(windowsPath, { windows: true }).href;
    expect(isDirectEntrypoint(moduleUrl, windowsPath, true)).toBe(true);
    expect(isDirectEntrypoint(moduleUrl, undefined, true)).toBe(false);
  });

  it('fails closed when a successful lane did not emit its JSON report', () => {
    const root = makeRoot('opk-vitest-report-');
    expect(runtimeReportAvailable(path.join(root, 'missing.json'))).toBe(false);
    const present = path.join(root, 'present.json');
    writeFileSync(present, '{}\n', 'utf8');
    expect(runtimeReportAvailable(present)).toBe(true);
  });

  it('distinguishes RPC-flake signatures from genuine assertion failures', () => {
    expect(hasRpcFlake('vitest-worker onTaskUpdate RPC timeout')).toBe(true);
    expect(hasRpcFlake('AssertionError: expected 1 to be 2')).toBe(false);
    expect(hasFailedTestsVitestJsonReport({
      numFailedTests: 1,
      testResults: [{
        name: path.join(process.cwd(), 'scripts', 'sample.test.ts'),
        assertionResults: [{ status: 'failed', title: 'genuine failure' }],
      }],
    })).toBe(true);
  });

  it('bounds heavy retry count to five in CI and one outside CI', () => {
    expect(heavyAttemptLimit({ CI: 'true' })).toBe(5);
    expect(heavyAttemptLimit({ CI: 'false' })).toBe(1);
    expect(heavyAttemptLimit({})).toBe(1);
    expect(HEAVY_RETRY_DELAY_MS).toBe(5_000);
  });
});

describe('Vitest heavy batching and report validation', () => {
  it('batches compatible files while keeping isolated tests separate', () => {
    const plans = new Map<string, HeavyFileRunPlan>([
      ['a.test.ts', { mode: 'file', pool: 'threads' }],
      ['b.test.ts', { mode: 'file', pool: 'threads' }],
      ['c.test.ts', { mode: 'tests', pool: 'forks', tests: ['isolated case'] }],
    ]);
    const invocations = buildHeavyInvocations([...plans.keys()], plans, 4);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.files).toEqual(['a.test.ts', 'b.test.ts']);
    expect(invocations[1]).toMatchObject({ files: ['c.test.ts'], testPattern: 'isolated case' });
  });

  it('throws rather than silently omitting a heavy file with no run plan', () => {
    expect(() => buildHeavyInvocations(['missing.test.ts'], new Map(), 4)).toThrow('missing heavy run plan');
  });

  it('rejects a batch report that omits one of the planned members', () => {
    const members: HeavyInvocationUnit[] = [
      { kind: 'file', file: 'scripts/a.test.ts', pool: 'threads', testPattern: null, label: 'a', batchable: true },
      { kind: 'file', file: 'scripts/b.test.ts', pool: 'threads', testPattern: null, label: 'b', batchable: true },
    ];
    const result = validateHeavyBatchReportPayload({
      testResults: [{
        name: path.join(process.cwd(), 'scripts', 'a.test.ts'),
        assertionResults: [{ status: 'passed', title: 'a' }],
      }],
    }, members, process.cwd());
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('missing reported file: scripts/b.test.ts');
  });
});

describe('Vitest heavy TestMode fleet hygiene', () => {
  it('fails closed when a lane context exists but its lease record is untrusted', async () => {
    const root = makeRoot('opk-vitest-fleet-');
    const leaseRoot = path.join(root, 'leases-root');
    mkdirSync(leaseRoot, { recursive: true });
    writeFileSync(path.join(leaseRoot, 'vitest-lane-context-shard-2.json'), JSON.stringify({
      leaseId: 'lease-untrusted',
      leaseRoot,
      writtenMs: Date.now(),
    }), 'utf8');
    const contexts = readHeavyLaneContexts(2, { OPK_TESTMODE_LEASE_ROOT: leaseRoot });
    expect(contexts).toHaveLength(1);
    await expect(observeHeavyLaneContext(contexts[0]!)).resolves.toEqual({
      ok: false,
      survivors: [],
      leaseId: 'lease-untrusted',
      reason: 'lease_record_untrusted',
    });
  });
});
