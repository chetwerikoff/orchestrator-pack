import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireGithubGovernorAdmission,
  classifyGovernorTransportOutcome,
  GOVERNOR_DENIAL_EXIT_CODE,
  governorStatePath,
  readGovernorStateForFixture,
  recordGithubGovernorObservedLimit,
  releaseGithubGovernorAdmission,
  resolveCallerLane,
  resolveGovernorStateDir,
} from './lib/gh-governor.mjs';
import { resolvePartitionKey } from './lib/gh-graphql-degraded.mjs';
import {
  buildGithubFleetWakeConsumers,
  createGithubFleetCacheHarness,
} from './github-fleet-cache-test-harness.js';

const repoRoot = join(import.meta.dirname, '..');
const governorCli = join(repoRoot, 'docs/github-fleet-governor.mjs');
const wrapperPath = join(repoRoot, 'scripts/lib/gh-wrapper.mjs');
const partitionKey = 'github.com|fixture-token';

function writeExecutable(path: string, body: string) {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function governorEnv(root: string, extra: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    GH_GOVERNOR_ENABLED: '1',
    GH_GOVERNOR_STATE_DIR: join(root, 'governor'),
    GH_GOVERNOR_MAX_TOKENS: '2',
    GH_GOVERNOR_MAX_IN_FLIGHT: '1',
    GH_GOVERNOR_RESERVED_TOKENS: '1',
    GH_GOVERNOR_REFILL_PER_MS: '0',
    GH_GOVERNOR_COLD_START_FRACTION: '1',
    GH_GOVERNOR_COLD_START_RAMP_MS: '0',
    GH_GOVERNOR_EMERGENCY_BUDGET_MAX: '1',
    GH_GOVERNOR_EMERGENCY_PACE_MS: '1',
    GH_GOVERNOR_NOW_MS: '1000',
    GH_TOKEN: 'fixture-token',
    ...extra,
  };
}

function runGovernorCli(subcommand: string, payload: object, env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [governorCli, subcommand], {
    cwd: repoRoot,
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout.trim());
}

function spawnParallelAcquire(count: number, env: NodeJS.ProcessEnv, lane = 'background') {
  const script = `import { acquireGithubGovernorAdmission, releaseGithubGovernorAdmission } from './lib/gh-governor.mjs';
const lane = ${JSON.stringify(lane)};
const env = { ...process.env, GH_GOVERNOR_LANE: lane };
const admission = acquireGithubGovernorAdmission({ env, argv: ['pr','list'], realGh: 'gh', partitionKey: ${JSON.stringify(partitionKey)} });
if (!admission.admitted) {
  process.stdout.write(JSON.stringify({ admitted: false, reason: admission.reason }));
  process.exit(0);
}
releaseGithubGovernorAdmission({ env, partitionKey: ${JSON.stringify(partitionKey)} });
process.stdout.write(JSON.stringify({ admitted: true, emergency: Boolean(admission.emergency) }));`;
  return Array.from({ length: count }, () =>
    spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: join(repoRoot, 'scripts'),
      env,
      encoding: 'utf8',
    }),
  );
}

describe('github-fleet-governor (Issue #585)', () => {
  let root = '';

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = '';
    }
  });

  it('AC#1 shared admission enforces token budget and in-flight cap across processes', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-governor-ac1-'));
    const env = governorEnv(root, { GH_GOVERNOR_MAX_IN_FLIGHT: '3', GH_GOVERNOR_RESERVED_TOKENS: '0' });
    const first = acquireGithubGovernorAdmission({
      env: { ...env, GH_GOVERNOR_LANE: 'background' },
      argv: ['pr', 'list'],
      partitionKey,
    });
    const second = acquireGithubGovernorAdmission({
      env: { ...env, GH_GOVERNOR_LANE: 'background' },
      argv: ['pr', 'list'],
      partitionKey,
    });
    const third = acquireGithubGovernorAdmission({
      env: { ...env, GH_GOVERNOR_LANE: 'background' },
      argv: ['pr', 'list'],
      partitionKey,
    });
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(true);
    expect(third.admitted).toBe(false);
    first.release?.();
    second.release?.();

    const inflightRoot = mkdtempSync(join(tmpdir(), 'gh-governor-ac1-inflight-'));
    const inflightEnv = governorEnv(inflightRoot, { GH_GOVERNOR_MAX_TOKENS: '5', GH_GOVERNOR_MAX_IN_FLIGHT: '1' });
    const hold = acquireGithubGovernorAdmission({
      env: { ...inflightEnv, GH_GOVERNOR_LANE: 'background' },
      argv: ['pr', 'list'],
      partitionKey,
    });
    expect(hold.admitted).toBe(true);
    const blocked = acquireGithubGovernorAdmission({
      env: { ...inflightEnv, GH_GOVERNOR_LANE: 'background' },
      argv: ['pr', 'list'],
      partitionKey,
    });
    expect(blocked.admitted).toBe(false);
    hold.release?.();
  });

  it('AC#3 reserved-lane preflight admits while background is denied under contention', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-governor-ac3-'));
    const env = governorEnv(root, {
      GH_GOVERNOR_MAX_TOKENS: '3',
      GH_GOVERNOR_RESERVED_TOKENS: '1',
      GH_GOVERNOR_MAX_IN_FLIGHT: '3',
    });
    const bg1 = acquireGithubGovernorAdmission({
      env: { ...env, GH_GOVERNOR_LANE: 'background' },
      argv: ['pr', 'list'],
      partitionKey,
    });
    const bg2 = acquireGithubGovernorAdmission({
      env: { ...env, GH_GOVERNOR_LANE: 'background' },
      argv: ['pr', 'list'],
      partitionKey,
    });
    const bg3 = acquireGithubGovernorAdmission({
      env: { ...env, GH_GOVERNOR_LANE: 'background' },
      argv: ['pr', 'list'],
      partitionKey,
    });
    expect(bg1.admitted).toBe(true);
    expect(bg2.admitted).toBe(true);
    expect(bg3.admitted).toBe(false);
    const preflight = acquireGithubGovernorAdmission({
      env: { ...env, GH_GOVERNOR_LANE: 'interactive-preflight' },
      argv: ['pr', 'view', '1', '--json', 'headRefOid'],
      partitionKey,
    });
    expect(preflight.admitted).toBe(true);
    bg1.release?.();
    bg2.release?.();
    preflight.release?.();
  });

  it('AC#4 observed-limit cooldown publishes shared cooldown with Retry-After', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-governor-ac4-'));
    const env = governorEnv(root);
    recordGithubGovernorObservedLimit({
      env,
      partitionKey,
      headers: { 'retry-after': '30' },
      exitCode: 429,
      stderr: 'secondary rate limit',
    });
    const state = readGovernorStateForFixture(env.GH_GOVERNOR_STATE_DIR!, partitionKey);
    expect(state?.cooldownUntilMs).toBeGreaterThan(1000);
    expect(state?.cooldownSource).toBe('retry-after');
    const denied = acquireGithubGovernorAdmission({
      env: { ...env, GH_GOVERNOR_LANE: 'background' },
      argv: ['pr', 'list'],
      partitionKey,
    });
    expect(denied.admitted).toBe(false);
    expect(denied.reason).toBe('governor-cooldown');
  });

  it('AC#4 without headers uses conservative fixed backoff classification', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-governor-ac4b-'));
    const env = governorEnv(root);
    recordGithubGovernorObservedLimit({
      env,
      partitionKey,
      exitCode: 503,
      stderr: 'service unavailable',
    });
    const state = readGovernorStateForFixture(env.GH_GOVERNOR_STATE_DIR!, partitionKey);
    expect(state?.cooldownSource).toBe('fixed-backoff');
    expect(state?.cooldownKind).toBe('transient');
  });

  it('AC#5 background lane fails closed on corrupt governor state', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-governor-ac5-'));
    const env = governorEnv(root);
    const stateDir = env.GH_GOVERNOR_STATE_DIR!;
    mkdirSync(stateDir, { recursive: true });
    const corruptKey = 'github.com|corrupt';
    const statePath = governorStatePath(stateDir, corruptKey);
    writeFileSync(statePath, '{not-json', 'utf8');
    const denied = acquireGithubGovernorAdmission({
      env: { ...env, GH_GOVERNOR_LANE: 'background' },
      argv: ['pr', 'list'],
      partitionKey: corruptKey,
    });
    expect(denied.admitted).toBe(false);
    expect(denied.reason).toMatch(/governor-state-unavailable|governor-lock-timeout/);
  });

  it('AC#5 interactive lane may use audited emergency budget when state is unavailable', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-governor-ac5b-'));
    const env = governorEnv(root, { GH_GOVERNOR_MAX_TOKENS: '0', GH_GOVERNOR_RESERVED_TOKENS: '0' });
    const admission = acquireGithubGovernorAdmission({
      env: { ...env, GH_GOVERNOR_LANE: 'interactive-preflight' },
      argv: ['pr', 'view', '1', '--json', 'headRefOid'],
      partitionKey,
    });
    expect(admission.admitted).toBe(true);
    expect(admission.emergency).toBe(true);
    const state = readGovernorStateForFixture(env.GH_GOVERNOR_STATE_DIR!, partitionKey);
    expect(state?.emergencyBudgetUsed).toBe(1);
  });

  it('emergency release does not decrement unrelated in-flight count', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-governor-emergency-inflight-'));
    const env = governorEnv(root, {
      GH_GOVERNOR_MAX_IN_FLIGHT: '1',
      GH_GOVERNOR_MAX_TOKENS: '10',
      GH_GOVERNOR_RESERVED_TOKENS: '0',
    });
    const hold = acquireGithubGovernorAdmission({
      env: { ...env, GH_GOVERNOR_LANE: 'background' },
      argv: ['pr', 'list'],
      partitionKey,
    });
    expect(hold.admitted).toBe(true);
    let state = readGovernorStateForFixture(env.GH_GOVERNOR_STATE_DIR!, partitionKey);
    expect(state?.inFlight).toBe(1);

    const emergency = acquireGithubGovernorAdmission({
      env: { ...env, GH_GOVERNOR_LANE: 'interactive-preflight' },
      argv: ['pr', 'view', '1', '--json', 'headRefOid'],
      partitionKey,
    });
    expect(emergency.admitted).toBe(true);
    expect(emergency.emergency).toBe(true);
    state = readGovernorStateForFixture(env.GH_GOVERNOR_STATE_DIR!, partitionKey);
    expect(state?.inFlight).toBe(1);

    emergency.release?.();
    state = readGovernorStateForFixture(env.GH_GOVERNOR_STATE_DIR!, partitionKey);
    expect(state?.inFlight).toBe(1);

    const blocked = acquireGithubGovernorAdmission({
      env: { ...env, GH_GOVERNOR_LANE: 'background' },
      argv: ['pr', 'list'],
      partitionKey,
    });
    expect(blocked.admitted).toBe(false);
    hold.release?.();
  });

  it('persists emergency budget usage and exhausts after max admissions', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-governor-emergency-'));
    const env = governorEnv(root, {
      GH_GOVERNOR_MAX_TOKENS: '0',
      GH_GOVERNOR_RESERVED_TOKENS: '0',
      GH_GOVERNOR_EMERGENCY_BUDGET_MAX: '1',
      GH_GOVERNOR_EMERGENCY_PACE_MS: '1',
    });
    const laneEnv = { ...env, GH_GOVERNOR_LANE: 'interactive-preflight' };
    const first = acquireGithubGovernorAdmission({
      env: laneEnv,
      argv: ['pr', 'view', '1', '--json', 'headRefOid'],
      partitionKey,
    });
    expect(first.admitted).toBe(true);
    expect(first.emergency).toBe(true);
    const second = acquireGithubGovernorAdmission({
      env: laneEnv,
      argv: ['pr', 'view', '2', '--json', 'headRefOid'],
      partitionKey,
    });
    expect(second.admitted).toBe(false);
    expect(second.reason).toBe('governor-emergency-exhausted');
  });

  it('release records observed limit once per response', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-governor-release-once-'));
    const env = governorEnv(root);
    const admission = acquireGithubGovernorAdmission({
      env: { ...env, GH_GOVERNOR_LANE: 'background' },
      argv: ['pr', 'list'],
      partitionKey,
    });
    expect(admission.admitted).toBe(true);
    admission.release?.({
      exitCode: 503,
      stderr: 'service unavailable',
    });
    const afterRelease = readGovernorStateForFixture(env.GH_GOVERNOR_STATE_DIR!, partitionKey);
    expect(afterRelease?.cooldownStrike).toBe(1);
    recordGithubGovernorObservedLimit({
      env,
      partitionKey,
      exitCode: 503,
      stderr: 'service unavailable',
    });
    const afterDuplicate = readGovernorStateForFixture(env.GH_GOVERNOR_STATE_DIR!, partitionKey);
    expect(afterDuplicate?.cooldownStrike).toBe(2);
    releaseGithubGovernorAdmission({
      env,
      partitionKey,
      exitCode: 429,
      headers: { 'retry-after': '10' },
      stderr: 'rate limited',
    });
    const afterSecondEvent = readGovernorStateForFixture(env.GH_GOVERNOR_STATE_DIR!, partitionKey);
    expect(afterSecondEvent?.cooldownStrike).toBe(3);
  });

  it('AC#6 terminal classes are not converted into cooldown transients', () => {
    const cases = [
      { exitCode: 401, stderr: 'HTTP 401: Bad credentials', terminalClass: '401' },
      { stderr: 'gh command not found: gh', terminalClass: 'missing-gh' },
      { stderr: 'policy boundary deny', terminalClass: 'policy' },
      { stderr: 'malformed argv', terminalClass: 'malformed' },
      { stderr: 'pull request is not open', terminalClass: 'pr-not-open' },
    ];
    for (const sample of cases) {
      const outcome = classifyGovernorTransportOutcome(sample);
      expect(outcome.disposition).toBe('terminal');
      expect(outcome.terminalClass).toBe(sample.terminalClass);
    }
    root = mkdtempSync(join(tmpdir(), 'gh-governor-ac6-'));
    const env = governorEnv(root);
    const before = readGovernorStateForFixture(env.GH_GOVERNOR_STATE_DIR!, partitionKey);
    recordGithubGovernorObservedLimit({
      env,
      partitionKey,
      exitCode: 401,
      stderr: 'HTTP 401: Bad credentials',
    });
    const after = readGovernorStateForFixture(env.GH_GOVERNOR_STATE_DIR!, partitionKey);
    expect(after?.cooldownUntilMs ?? 0).toBe(before?.cooldownUntilMs ?? 0);
  });

  it('AC#7 cold restart does not grant full budget to simultaneous callers', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-governor-ac7-'));
    const env = governorEnv(root, {
      GH_GOVERNOR_MAX_TOKENS: '10',
      GH_GOVERNOR_COLD_START_FRACTION: '0.3',
      GH_GOVERNOR_COLD_START_RAMP_MS: '60000',
      GH_GOVERNOR_NOW_MS: '5000',
    });
    const results = spawnParallelAcquire(5, env, 'background');
    const admitted = results.filter((r) => JSON.parse(r.stdout).admitted).length;
    expect(admitted).toBeLessThanOrEqual(3);
    const state = readGovernorStateForFixture(env.GH_GOVERNOR_STATE_DIR!, partitionKey);
    expect(state?.tokens ?? 0).toBeLessThan(10);
  });

  it('AC#8 governor integration does not re-enter scripts/gh wrapper', () => {
    const wrapper = readFileSync(wrapperPath, 'utf8');
    expect(wrapper).toMatch(/acquireGithubGovernorAdmission/);
    expect(wrapper).not.toMatch(/spawnSync\([^)]*scripts\/gh/);
    const governor = readFileSync(join(repoRoot, 'scripts/lib/gh-governor.mjs'), 'utf8');
    expect(governor).not.toMatch(/\bgh\b.*spawnSync/);
  });

  it('AC#9 scenario matrix covers representative caller and governor states', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-governor-matrix-'));
    const env = governorEnv(root);
    const matrix = [
      { lane: 'background', tokens: '2', expected: 'admit' },
      { lane: 'retry', tokens: '2', expected: 'admit' },
      { lane: 'interactive-preflight', tokens: '0', expected: 'emergency-paced' },
      { lane: 'background', tokens: '0', expected: 'deny' },
    ];
    for (const cell of matrix) {
      rmSync(env.GH_GOVERNOR_STATE_DIR!, { recursive: true, force: true });
      const cellEnv = governorEnv(root, {
        GH_GOVERNOR_MAX_TOKENS: cell.tokens,
        GH_GOVERNOR_RESERVED_TOKENS: '0',
      });
      const result = runGovernorCli('scenario-evaluate', {
        argv: ['pr', 'list'],
        partitionKey,
      }, { ...cellEnv, GH_GOVERNOR_LANE: cell.lane });
      if (cell.expected === 'deny') {
        expect(result.outcome).toBe('deny');
      } else if (cell.expected === 'emergency-paced') {
        expect(result.outcome).toBe('emergency-paced');
      } else {
        expect(result.outcome).toBe('admit');
      }
    }
  });

  it('AC#2 chokepoint inventory lists wrapper-covered fleet surfaces', () => {
    const inventory = JSON.parse(
      readFileSync(join(repoRoot, 'docs/github-fleet-governor-chokepoint-inventory.json'), 'utf8'),
    );
    const fleetRows = inventory.rows.filter((row: { surface: string }) =>
      /Gh-FleetInventoryCache|Gh-PrChecks|Review-StartPreflightShield/.test(row.surface),
    );
    expect(fleetRows.length).toBeGreaterThanOrEqual(5);
    for (const row of fleetRows) {
      expect(row.participation).toBe('wrapper-covered');
    }
  });

  it('AC#10 placeholder budget telemetry is recorded in governor state', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-governor-ac10-'));
    const env = governorEnv(root);
    const admission = acquireGithubGovernorAdmission({
      env,
      argv: ['pr', 'list'],
      partitionKey,
    });
    expect(admission.admitted).toBe(true);
    admission.release?.();
    const state = readGovernorStateForFixture(env.GH_GOVERNOR_STATE_DIR!, partitionKey);
    expect(state?.placeholderBudget).toBe(true);
    expect(state?.telemetryNote).toMatch(/phase0/i);
  });

  it('wrapper denies with stable exit code when governor rejects background lane', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-governor-wrap-'));
    const fakeGh = join(root, 'fake-gh');
    writeExecutable(fakeGh, `#!/usr/bin/env bash
echo '[]'
`);
    const env = governorEnv(root, {
      GH_GOVERNOR_MAX_TOKENS: '0',
      GH_GOVERNOR_RESERVED_TOKENS: '0',
      GH_GOVERNOR_EMERGENCY_BUDGET_MAX: '0',
      GH_REAL_BINARY: fakeGh,
      PATH: `${root}:${process.env.PATH ?? ''}`,
    });
    const script = `import { spawnSync } from 'node:child_process';
const wrapper = ${JSON.stringify(wrapperPath)};
const result = spawnSync(process.execPath, [wrapper, 'pr', 'list', '--state', 'open', '--json', 'number'], {
  env: process.env,
  encoding: 'utf8',
});
process.stdout.write(String(result.status ?? 1));`;
    const first = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: join(repoRoot, 'scripts'),
      env,
      encoding: 'utf8',
    });
    expect(Number(first.stdout.trim())).toBe(GOVERNOR_DENIAL_EXIT_CODE);
  });

  it('fleet consumers remain compatible with governor lane context helper', async () => {
    const harness = createGithubFleetCacheHarness('gh-governor-fleet-');
    try {
      const consumers = buildGithubFleetWakeConsumers(repoRoot).slice(0, 5);
      expect(consumers.length).toBeGreaterThanOrEqual(5);
      const fleetCache = readFileSync(join(repoRoot, 'scripts/lib/Gh-FleetInventoryCache.ps1'), 'utf8');
      expect(fleetCache).toMatch(/Set-GhGovernorCallerContext/);
      expect(fleetCache).toMatch(/Restore-GhGovernorCallerContext/);
      expect(fleetCache).toMatch(/savedGovernorContext = Set-GhGovernorCallerContext/);
      expect(resolveCallerLane({ GH_GOVERNOR_CONSUMER: consumers[0].id })).toBe('background');
    } finally {
      harness.cleanup();
    }
  });

  it('passthrough streams governed stderr without spawnSync maxBuffer', () => {
    const wrapper = readFileSync(wrapperPath, 'utf8');
    expect(wrapper).toMatch(/function runNativePassthrough/);
    expect(wrapper).toMatch(/captureStderrForGovernor/);
    expect(wrapper).toMatch(/spawn\(realGh, argv/);
    expect(wrapper).not.toMatch(/maxBuffer:\s*PASSTHROUGH_STDERR_CAPTURE_MAX/);
    expect(wrapper).not.toMatch(/Atomics\.wait/);
  });

  it('governor CLI release forwards emergency flag', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-governor-cli-emergency-'));
    const env = governorEnv(root, {
      GH_GOVERNOR_MAX_IN_FLIGHT: '1',
      GH_GOVERNOR_MAX_TOKENS: '10',
      GH_GOVERNOR_RESERVED_TOKENS: '0',
    });
    const hold = acquireGithubGovernorAdmission({
      env: { ...env, GH_GOVERNOR_LANE: 'background' },
      argv: ['pr', 'list'],
      partitionKey,
    });
    expect(hold.admitted).toBe(true);
    const acquired = runGovernorCli('acquire', {
      argv: ['pr', 'view', '1', '--json', 'headRefOid'],
      partitionKey,
    }, {
      ...env,
      GH_GOVERNOR_LANE: 'interactive-preflight',
      GH_GOVERNOR_MAX_TOKENS: '0',
      GH_GOVERNOR_RESERVED_TOKENS: '0',
    });
    expect(acquired.emergency).toBe(true);
    runGovernorCli('release', { partitionKey, emergency: true }, env);
    const state = readGovernorStateForFixture(env.GH_GOVERNOR_STATE_DIR!, partitionKey);
    expect(state?.inFlight).toBe(1);
    hold.release?.();
  });

  it('governor partition key resolution skips gh api user probe', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-governor-partition-'));
    const counter = join(root, 'probe-count');
    const fakeGh = join(root, 'probe-gh');
    writeExecutable(fakeGh, `#!/usr/bin/env bash
if [[ "$*" == *"api"* && "$*" == *"user"* ]]; then
  echo 1 >> "${counter}"
  echo login-from-api
  exit 0
fi
if [[ "$1" == "auth" && "$2" == "token" ]]; then
  exit 1
fi
exit 0
`);
    const env = { ...process.env };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    const governedKey = resolvePartitionKey(fakeGh, ['pr', 'list'], env, { skipApiIdentityProbe: true });
    expect(existsSync(counter)).toBe(false);
    expect(governedKey).toMatch(/^github\.com\|/);
    const defaultKey = resolvePartitionKey(fakeGh, ['pr', 'list'], env);
    expect(readFileSync(counter, 'utf8').trim()).toBe('1');
    expect(defaultKey).not.toBe(governedKey);
  });

  it('graphql passthrough onComplete preserves stderr for governor classification', () => {
    const degraded = readFileSync(join(repoRoot, 'scripts/lib/gh-graphql-degraded.mjs'), 'utf8');
    expect(degraded).toMatch(/buildPassthroughCompleteFields/);
    expect(degraded).toMatch(/stderr: graphqlResult\.stderr \|\| PRIMARY_QUOTA_MARKER/);
    const wrapper = readFileSync(wrapperPath, 'utf8');
    expect(wrapper).toMatch(/stdout: fields\.stdout/);
  });

  it('governor release classifies passthrough rate-limit stderr as observed limit', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-governor-passthrough-'));
    const env = governorEnv(root);
    const admission = acquireGithubGovernorAdmission({
      env: { ...env, GH_GOVERNOR_LANE: 'background' },
      argv: ['extension', 'list'],
      partitionKey,
    });
    expect(admission.admitted).toBe(true);
    admission.release?.({
      exitCode: 1,
      stderr: 'API rate limit exceeded',
    });
    const state = readGovernorStateForFixture(env.GH_GOVERNOR_STATE_DIR!, partitionKey);
    expect(state?.cooldownStrike).toBe(1);
    expect(state?.cooldownSource).toBe('fixed-backoff');
  });
});