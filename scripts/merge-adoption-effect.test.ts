// @vitest-ci-lane heavy
// @vitest-pre-topology-seconds 20
import { runProcess, runProcessSync, type ProcessResult } from './kernel/subprocess.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as subprocess from './kernel/subprocess.ts';
import { canonicalFoundationPaths } from './lib/cutover/foundation-observation.ts';
import { readOriginUrlFromGitConfig } from './lib/git-origin-slug.mjs';
import {
  defaultSupervisorStateDir,
  linuxProcessStartTimeMs,
  mapChangedPathsToConsumers,
  runCli,
  verifyAdoptionEffect,
  type ConsumerController,
} from './merge-adoption-effect.ts';

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function mappingFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'merge-adoption-map-'));
  // The real card parser reads origin via git, not a raw .git/config; create an actual synthetic checkout.
  for (const args of [
    ['-C', root, 'init', '-q'],
    ['-C', root, 'remote', 'add', 'origin', readOriginUrlFromGitConfig(process.cwd())],
  ]) {
    const result = runProcessSync({ command: 'git', args, inheritParentEnv: true });
    if (!result.ok) throw new Error('synthetic fixture git repository initialization failed');
  }
  write(root, 'package.json', JSON.stringify({ imports: { '#opk-kernel/*': './scripts/kernel/*.ts' } }));
  write(root, 'scripts/orchestrator-side-process-registry.json', JSON.stringify({ children: [{ id: 'pr2-scheduler', script: 'pr2-foundation/scheduler.ts' }] }));
  write(root, 'scripts/orchestrator-wake-supervisor.ts', "import './lib/supervisor-core.ts';\nimport '#opk-kernel/shared';\n");
  write(root, 'scripts/lib/supervisor-core.ts', 'export const supervisor = true;\n');
  write(root, 'scripts/kernel/shared.ts', 'export const shared = true;\n');
  write(root, 'scripts/pr2-foundation/scheduler.ts', "import './scheduler-core.ts';\n");
  write(root, 'scripts/pr2-foundation/scheduler-core.ts', 'export const scheduler = true;\n');
  write(root, 'scripts/fleet/fleet-wake.ts', "import './wake-library.ts';\nexport const wake = true;\n");
  write(root, 'scripts/fleet/wake-library.ts', 'export const wakeLibrary = true;\n');
  write(root, 'scripts/lib/Invoke-TypeScriptCli.ts', 'export const invoke = true;\n');
  write(root, 'scripts/fleet/fleet-wake@.service', '[Service]\n');
  write(root, 'scripts/invoke-read-delegation-audit-stop.ts', 'export const hook = true;\n');
  return root;
}

async function waitForProcessStart(pid: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const started = linuxProcessStartTimeMs(pid);
    if (started !== null) return started;
    await delay(20);
  }
  throw new Error('fixture process start time was not observable');
}

interface FixtureProcess {
  readonly pid: number;
  readonly abort: AbortController;
  readonly done: Promise<ProcessResult>;
}

async function stopFixture(child: FixtureProcess): Promise<void> {
  child.abort.abort();
  await child.done;
}

async function startFixture(): Promise<FixtureProcess> {
  const abort = new AbortController();
  let pid = 0;
  const done = runProcess({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    inheritParentEnv: true,
    signal: abort.signal,
    onSpawn: (spawnedPid) => { pid = spawnedPid; },
  });
  const deadline = Date.now() + 5_000;
  while (pid === 0 && Date.now() < deadline) await delay(5);
  if (pid === 0) {
    abort.abort();
    const result = await done;
    throw new Error('fixture process did not start: ' + (result.error ?? result.stderr ?? result.outcome));
  }
  await waitForProcessStart(pid);
  return { pid, abort, done };
}


function registeredCards(primaryRoot: string, configHome: string): NodeJS.ProcessEnv {
  for (const projectId of ['orchestrator-pack', 'leopoker', 'sample-target']) {
    write(configHome, 'orchestrator-pack/projects/' + projectId + '.json', JSON.stringify({
      projectId,
      repository: 'chetwerikoff/orchestrator-pack',
      primaryRoot,
      defaultBranch: 'main',
      orcaWorkspacePattern: '.*',
      orchestratorTitlePattern: '.*',
      browserGpt: { projectUrl: 'https://example.test/project' },
    }));
  }
  return { ...process.env, XDG_CONFIG_HOME: configHome, OPK_PROJECT_ID: 'orchestrator-pack' };
}

function fixtureMerge(root: string, changed: string): string {
  const git = (...args: string[]): string => {
    const result = runProcessSync({ command: 'git', args: ['-C', root, ...args], inheritParentEnv: true });
    if (!result.ok) throw new Error('synthetic git fixture failed: ' + String(result.exitCode));
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  write(root, changed, 'export const newer = true;\n');
  git('add', changed);
  git('commit', '-qm', 'adopt code');
  return git('rev-parse', 'HEAD');
}

function fixtureVerifyArgv(root: string, mergeSha: string, adoptedAt: number, fleetAt?: number): string[] {
  return [
    'verify', '--repo-root', root, '--merge-sha', mergeSha,
    '--adopted-at', new Date(adoptedAt).toISOString(),
    ...(fleetAt === undefined ? [] : ['--fleet-adopted-at', new Date(fleetAt).toISOString()]),
    '--live-check-json', JSON.stringify([process.execPath, '-e', 'process.exit(0)']),
  ];
}

function systemctlResult(stdout: string, ok = true): ProcessResult {
  return {
    outcome: 'exit', ok, exitCode: ok ? 0 : 3, signal: null,
    stdout, stderr: '', timedOut: false, cancelled: false,
  };
}

interface MockFleetUnit {
  state: 'active' | 'inactive' | 'failed' | 'missing';
  pid?: number;
  nextPid?: number;
  raceToInactive?: boolean;
  failRestart?: boolean;
}

/** Intercept systemctl only; real synthetic child /proc identity makes root/argv checks meaningful. */
function fakeSystemctl(units: Map<string, MockFleetUnit>) {
  const commandLog: string[][] = [];
  const original = subprocess.runProcessSync;
  const spy = vi.spyOn(subprocess, 'runProcessSync').mockImplementation((request) => {
    if (request.command !== 'systemctl') return original(request);
    const args = [...(request.args ?? [])];
    commandLog.push(args);
    const unitName = args[2] ?? '';
    const unit = units.get(unitName);
    if (args[0] !== '--user') throw new Error('unexpected non-user systemctl');
    if (args[1] === 'is-active') return systemctlResult(unit?.state === 'missing' || !unit ? 'unknown' : unit.state, unit?.state === 'active');
    if (args[1] === 'show' && args[3] === '--property=LoadState') return systemctlResult(unit?.state === 'missing' || !unit ? 'not-found' : 'loaded');
    if (args[1] === 'show' && args[3] === '--property=MainPID') return systemctlResult(String(unit?.pid ?? 0));
    if (args[1] === 'try-restart') {
      if (!unit) return systemctlResult('not-found', false);
      if (unit.raceToInactive) { unit.state = 'inactive'; return systemctlResult(''); }
      if (unit.failRestart) return systemctlResult('failed', false);
      if (unit.state === 'active' && unit.nextPid) unit.pid = unit.nextPid;
      return systemctlResult('');
    }
    throw new Error('unexpected systemctl invocation');
  });
  return { commandLog, restore: () => spy.mockRestore() };
}

async function startFleetFixture(root: string, projectId: string, argsOverride?: string[]): Promise<FixtureProcess> {
  const abort = new AbortController();
  let pid = 0;
  const args = argsOverride ?? [
    '--repo-root', root,
    '--script', path.join(root, 'scripts/fleet/fleet-wake.ts'),
    '--project', projectId,
  ];
  const done = runProcess({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)', '--', ...args],
    inheritParentEnv: true,
    signal: abort.signal,
    onSpawn: (spawnedPid) => { pid = spawnedPid; },
  });
  const deadline = Date.now() + 5_000;
  while (pid === 0 && Date.now() < deadline) await delay(5);
  if (pid === 0) { abort.abort(); await done; throw new Error('fleet synthetic child did not start'); }
  await waitForProcessStart(pid);
  return { pid, abort, done };
}

describe('Issue #2145 merge adoption effect verification', () => {
  it.each([false, true])('refuses a target root (copied registry=%s) before Git, restart controls, or live checks and names target-owned adoption', async (copiedRegistry) => {
    const root = mkdtempSync(path.join(tmpdir(), 'target-adoption-'));
    const effects = vi.spyOn(subprocess, 'runProcessSync');
    const marker = path.join(root, 'effect-ran');
    const effectArgv = [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "ran")', marker];
    try {
      write(root, 'AGENTS.md', '# Target merge-time adoption\nUse the target live check.\n');
      const git = (...args: string[]) => {
        const result = runProcessSync({ command: 'git', args: ['-C', root, ...args], inheritParentEnv: true });
        if (!result.ok) throw new Error(result.stderr || result.error || 'target git fixture failed');
        return result.stdout.trim();
      };
      git('init', '-q');
      git('config', 'user.name', 'fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      git('remote', 'add', 'origin', 'https://github.com/fixture/target.git');
      if (copiedRegistry) write(root, 'scripts/orchestrator-side-process-registry.json', JSON.stringify({ children: [] }));
      git('add', 'AGENTS.md');
      git('commit', '-qm', 'target baseline');
      write(root, 'target.txt', 'target change\n');
      git('add', 'target.txt');
      git('commit', '-qm', 'target adoption');
      const mergeSha = git('rev-parse', 'HEAD');
      effects.mockClear();
      await expect(runCli([
        'verify', '--repo-root', root, '--merge-sha', mergeSha,
        '--adopted-at', new Date().toISOString(),
        '--live-check-json', JSON.stringify(effectArgv),
        '--restart-control-json', JSON.stringify({ 'orchestrator-side-process-supervisor': effectArgv }),
      ])).rejects.toThrow(/pack-only adoption.*PRIMARY_ROOT.*AGENTS\.md.*merge-time adoption.*named live check/u);
      expect(effects).not.toHaveBeenCalled();
      expect(existsSync(marker)).toBe(false);
    } finally {
      effects.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('maps normal consumers but fences template-touch merges as operator activation', () => {
    const root = mappingFixture();
    try {
      const consumers = mapChangedPathsToConsumers(root, [
        'scripts/lib/supervisor-core.ts',
        'scripts/kernel/shared.ts',
        'scripts/pr2-foundation/scheduler-core.ts',
        'scripts/fleet/fleet-wake@.service',
        'scripts/invoke-read-delegation-audit-stop.ts',
      ], { XDG_CONFIG_HOME: path.join(root, 'nonexistent-config') });
      const byId = new Map(consumers.map((row) => [row.id, row.matchedPaths]));
      expect(byId.get('orchestrator-side-process-supervisor')).toContain('scripts/lib/supervisor-core.ts');
      expect(byId.get('orchestrator-side-process-supervisor')).toContain('scripts/kernel/shared.ts');
      expect(byId.get('pr2-scheduler')).toContain('scripts/pr2-foundation/scheduler-core.ts');
      expect(byId.get('fleet-wake-template')).toContain('scripts/fleet/fleet-wake@.service');
      expect(byId.get('agent-hooks')).toContain('scripts/invoke-read-delegation-audit-stop.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('fails closed for a pre-adoption fixture until its normal control restarts it, then verifies the new start time', async () => {
    let child = await startFixture();
    let restartCount = 0;
    try {
      const oldStart = await waitForProcessStart(child.pid);
      await delay(100);
      const adoptionStartedAtMs = Date.now();
      expect(oldStart).toBeLessThan(adoptionStartedAtMs);
      const controller: ConsumerController = {
        observe: async () => {
          const startedAtMs = await waitForProcessStart(child.pid);
          return { state: 'running', startedAtMs, identity: String(child.pid) };
        },
        restart: async () => {
          restartCount += 1;
          await stopFixture(child);
          while (Date.now() <= adoptionStartedAtMs + 100) await delay(10);
          child = await startFixture();
        },
      };
      const consumers = [{ id: 'fixture-consumer', matchedPaths: ['scripts/fixture-consumer.ts'] }];

      const withoutRestart = await verifyAdoptionEffect({
        adoptionStartedAtMs,
        consumers,
        controllers: { 'fixture-consumer': controller },
        restartStaleConsumers: false,
        runLiveCheck: () => ({ ok: true }),
      });
      expect(withoutRestart.effect).toContain('effect_unverified');
      expect(withoutRestart.effect).toContain('stale_consumer:fixture-consumer');
      expect(withoutRestart.operationalOutcome).toBe('operationally_incomplete');
      expect(withoutRestart.coordinatorMessage).toContain('operationally_incomplete');
      expect(restartCount).toBe(0);

      const withRestart = await verifyAdoptionEffect({
        adoptionStartedAtMs,
        consumers,
        controllers: { 'fixture-consumer': controller },
        runLiveCheck: () => ({ ok: true }),
      });
      expect(withRestart.effect).toBe('effect_verified');
      expect(withRestart.operationalOutcome).toBe('operationally_complete');
      expect(withRestart.consumers[0]?.action).toBe('restart');
      expect(withRestart.consumers[0]?.after?.startedAtMs).toBeGreaterThan(adoptionStartedAtMs);
      expect(restartCount).toBe(1);
    } finally {
      await stopFixture(child);
    }
  });


  it('runs the executable Issue live check from the adopted primary checkout', async () => {
    const root = mappingFixture();
    const git = (...args: string[]) => {
      const result = runProcessSync({
        command: 'git',
        args: ['-C', root, ...args],
        inheritParentEnv: true,
      });
      if (!result.ok) throw new Error(result.stderr || result.error || 'git fixture command failed');
      return result.stdout.trim();
    };
    try {
      git('init', '-q');
      git('config', 'user.name', 'fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      git('add', '.');
      git('commit', '-qm', 'baseline');
      write(root, 'scripts/unrelated.ts', 'export const unrelated = true;\n');
      git('add', 'scripts/unrelated.ts');
      git('commit', '-qm', 'change');
      const mergeSha = git('rev-parse', 'HEAD');
      const report = await runCli([
        'verify',
        '--repo-root', root,
        '--merge-sha', mergeSha,
        '--adopted-at', new Date(Date.now() - 1_000).toISOString(),
        '--live-check-json', JSON.stringify([
          process.execPath,
          '-e',
          'process.exit(process.cwd() === process.argv[1] ? 0 : 9)',
          root,
        ]),
      ]);
      expect(report.effect).toBe('effect_verified');
      expect(report.liveCheck).toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the Issue live check fails even if no long-lived consumer is stale', async () => {
    const report = await verifyAdoptionEffect({
      adoptionStartedAtMs: Date.now() - 1_000,
      consumers: [],
      controllers: {},
      runLiveCheck: () => ({ ok: false, reason: 'primary_checkout_smoke_failed' }),
    });
    expect(report.effect).toContain('effect_unverified');
    expect(report.operationalOutcome).toBe('operationally_incomplete');
  });


  it('Issue #2445: maps all validated registered fleet cards with caller selector set, including launcher/static imports', () => {
    const root = mappingFixture();
    const config = mkdtempSync(path.join(tmpdir(), 'fleet-cards-'));
    try {
      const env = registeredCards(root, config);
      for (const changedPath of ['scripts/fleet/fleet-wake.ts', 'scripts/fleet/wake-library.ts', 'scripts/lib/Invoke-TypeScriptCli.ts']) {
        const consumers = mapChangedPathsToConsumers(root, [changedPath], env);
        expect(consumers.filter((row) => row.id.startsWith('fleet-wake@')).map((row) => row.id).sort()).toEqual([
          'fleet-wake@leopoker.service', 'fleet-wake@orchestrator-pack.service', 'fleet-wake@sample-target.service',
        ]);
        expect(consumers.find((row) => row.id === 'fleet-wake-inventory')).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(config, { recursive: true, force: true });
    }
  });

  it('Issue #2445: invalid/missing/aliased cards fail as a mapped inventory residual only for relevant changed paths', () => {
    const root = mappingFixture();
    const config = mkdtempSync(path.join(tmpdir(), 'fleet-bad-cards-'));
    try {
      const env = registeredCards(root, config);
      const badCard = path.join(config, 'orchestrator-pack/projects/leopoker.json');
      const savedCard = readFileSync(badCard, 'utf8');
      const cases: Array<() => void> = [
        () => writeFileSync(badCard, '{ malformed'),
        () => writeFileSync(badCard, savedCard.replace('"leopoker"', '"wrong-project"')),
        () => { rmSync(badCard); symlinkSync('orchestrator-pack.json', badCard); },
      ];
      for (const corrupt of cases) {
        writeFileSync(badCard, savedCard);
        corrupt();
        expect(mapChangedPathsToConsumers(root, ['scripts/fleet/fleet-wake.ts'], env).map((row) => row.id)).toContain('fleet-wake-inventory');
        const unrelated = mapChangedPathsToConsumers(root, ['scripts/lib/supervisor-core.ts'], env);
        expect(unrelated.map((row) => row.id)).toEqual(['orchestrator-side-process-supervisor']);
        rmSync(badCard, { force: true });
      }
      writeFileSync(badCard, savedCard);
      symlinkSync('orchestrator-pack.json', path.join(config, 'orchestrator-pack/projects/alias.json'));
      expect(mapChangedPathsToConsumers(root, ['scripts/fleet/wake-library.ts'], env).map((row) => row.id)).toContain('fleet-wake-inventory');
      const missingEnv = { ...env, XDG_CONFIG_HOME: path.join(config, 'missing') };
      expect(mapChangedPathsToConsumers(root, ['scripts/fleet/fleet-wake.ts'], missingEnv).map((row) => row.id)).toContain('fleet-wake-inventory');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(config, { recursive: true, force: true });
    }
  });

  it('Issue #2445: fleet inventory and tracked template errors remain structured v1 incomplete (including mixed code)', async () => {
    const root = mappingFixture();
    const config = mkdtempSync(path.join(tmpdir(), 'fleet-inventory-error-'));
    const originalXdg = process.env.XDG_CONFIG_HOME;
    const originalProject = process.env.OPK_PROJECT_ID;
    try {
      process.env.XDG_CONFIG_HOME = config;
      process.env.OPK_PROJECT_ID = 'orchestrator-pack';
      const changedCode = fixtureMerge(root, 'scripts/fleet/fleet-wake.ts');
      const report = await runCli(fixtureVerifyArgv(root, changedCode, Date.now() - 5_000, Date.now() - 1_000));
      expect(report.schema).toBe('orchestrator-pack/merge-adoption-effect/v1');
      expect(report.consumers.find((row) => row.id === 'fleet-wake-inventory')?.verified).toBe(false);
      expect(report.effect).toContain('fleet_inventory_invalid_or_missing');
      expect(report.operationalOutcome).toBe('operationally_incomplete');
      expect(report.coordinatorMessage).toContain('Repair the registered project-card inventory');
      // The tracked template cannot be proved installed by code PID/argv or passing offline check.
      const templateRoot = mappingFixture();
      try {
        const mergeSha = fixtureMerge(templateRoot, 'scripts/fleet/fleet-wake@.service');
        const template = await runCli(fixtureVerifyArgv(templateRoot, mergeSha, Date.now() - 5_000, Date.now() - 1_000));
        expect(template.effect).toContain('template_operator_activation_pending');
        expect(template.coordinatorMessage).toContain('daemon-reload');
        expect(template.operationalOutcome).toBe('operationally_incomplete');
        expect(template.consumers.find((row) => row.id === 'fleet-wake-template')?.action).toBe('none');
      const mixed = mapChangedPathsToConsumers(templateRoot, [
        'scripts/fleet/fleet-wake.ts', 'scripts/fleet/fleet-wake@.service',
      ]);
      expect(mixed.map((row) => row.id)).toContain('fleet-wake-template');
      expect(mixed.some((row) => row.id.startsWith('fleet-wake@'))).toBe(false);
      } finally { rmSync(templateRoot, { recursive: true, force: true }); }
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdg;
      if (originalProject === undefined) delete process.env.OPK_PROJECT_ID; else process.env.OPK_PROJECT_ID = originalProject;
      rmSync(root, { recursive: true, force: true });
      rmSync(config, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('Issue #2445: three stale registered instances get exact safe try-restart and independent fresh PID readback', async () => {
    const root = mappingFixture();
    const config = mkdtempSync(path.join(tmpdir(), 'fleet-three-'));
    const originalXdg = process.env.XDG_CONFIG_HOME;
    const originalProject = process.env.OPK_PROJECT_ID;
    const children: FixtureProcess[] = [];
    let fake: ReturnType<typeof fakeSystemctl> | undefined;
    try {
      const env = registeredCards(root, config);
      process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
      process.env.OPK_PROJECT_ID = env.OPK_PROJECT_ID;
      const mergeSha = fixtureMerge(root, 'scripts/fleet/fleet-wake.ts');
      const projects = ['orchestrator-pack', 'leopoker', 'sample-target'];
      const units = new Map<string, MockFleetUnit>();
      for (const id of projects) {
        const old = await startFleetFixture(root, id);
        children.push(old);
        units.set('fleet-wake@' + id + '.service', { state: 'active', pid: old.pid });
      }
      await delay(120);
      const adoptedAt = Date.now() - 100;
      const fleetAt = Date.now();
      await delay(70);
      for (const id of projects) {
        const fresh = await startFleetFixture(root, id);
        children.push(fresh);
        units.get('fleet-wake@' + id + '.service')!.nextPid = fresh.pid;
      }
      await delay(120);
      fake = fakeSystemctl(units);
      const report = await runCli(fixtureVerifyArgv(root, mergeSha, adoptedAt, fleetAt));
      expect(report.effect).toBe('effect_verified');
      expect(report.operationalOutcome).toBe('operationally_complete');
      const rows = report.consumers.filter((row) => row.id.startsWith('fleet-wake@'));
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.action === 'restart' && row.verified && row.before.identity !== row.after?.identity)).toBe(true);
      expect(new Set(rows.map((row) => row.after?.identity)).size).toBe(3);
      const controls = fake.commandLog.filter((args) => args[1] === 'try-restart');
      expect(controls).toEqual(projects.sort().map((id) => ['--user', 'try-restart', 'fleet-wake@' + id + '.service']));
      expect(fake.commandLog.some((args) => ['restart', 'start', 'daemon-reload', 'enable'].includes(args[1] ?? ''))).toBe(false);
    } finally {
      fake?.restore();
      for (const child of children) await stopFixture(child);
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdg;
      if (originalProject === undefined) delete process.env.OPK_PROJECT_ID; else process.env.OPK_PROJECT_ID = originalProject;
      rmSync(root, { recursive: true, force: true });
      rmSync(config, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('Issue #2445: wrong checkout/argv, failed and inactive units perform zero fleet control', async () => {
    const root = mappingFixture();
    const other = mappingFixture();
    const config = mkdtempSync(path.join(tmpdir(), 'fleet-reject-'));
    const originalXdg = process.env.XDG_CONFIG_HOME;
    const originalProject = process.env.OPK_PROJECT_ID;
    const children: FixtureProcess[] = [];
    let fake: ReturnType<typeof fakeSystemctl> | undefined;
    try {
      const env = registeredCards(root, config);
      process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
      process.env.OPK_PROJECT_ID = env.OPK_PROJECT_ID;
      const mergeSha = fixtureMerge(root, 'scripts/fleet/fleet-wake.ts');
      const wrong = await startFleetFixture(other, 'leopoker');
      const invalid = await startFleetFixture(root, 'sample-target', ['--repo-root', root, '--script', path.join(root, 'scripts/fleet/fleet-wake.ts'), '--project', 'unexpected']);
      children.push(wrong, invalid);
      await delay(100);
      const fleetAt = Date.now();
      const units = new Map<string, MockFleetUnit>([
        ['fleet-wake@orchestrator-pack.service', { state: 'failed' }],
        ['fleet-wake@leopoker.service', { state: 'active', pid: wrong.pid }],
        ['fleet-wake@sample-target.service', { state: 'active', pid: invalid.pid }],
      ]);
      fake = fakeSystemctl(units);
      const report = await runCli(fixtureVerifyArgv(root, mergeSha, fleetAt - 100, fleetAt));
      expect(report.effect).toContain('effect_unverified');
      expect(report.operationalOutcome).toBe('operationally_incomplete');
      expect(report.consumers.find((row) => row.id === 'fleet-wake@leopoker.service')?.reason).toContain('checkout_mismatch');
      expect(report.consumers.find((row) => row.id === 'fleet-wake@orchestrator-pack.service')?.before.reason).toBe('fleet_wake_unit_failed');
      expect(report.consumers.find((row) => row.id === 'fleet-wake@sample-target.service')?.before.reason).toContain('invocation');
      expect(fake.commandLog.some((args) => args[1] === 'try-restart')).toBe(false);
      units.get('fleet-wake@orchestrator-pack.service')!.state = 'inactive';
      units.get('fleet-wake@leopoker.service')!.state = 'missing';
      const inactive = await runCli(fixtureVerifyArgv(root, mergeSha, fleetAt - 100, fleetAt));
      expect(inactive.consumers.find((row) => row.id === 'fleet-wake@orchestrator-pack.service')?.action).toBe('not_running');
      expect(inactive.consumers.find((row) => row.id === 'fleet-wake@leopoker.service')?.action).toBe('not_running');
      expect(fake.commandLog.some((args) => args[1] === 'try-restart')).toBe(false);
    } finally {
      fake?.restore();
      for (const child of children) await stopFixture(child);
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdg;
      if (originalProject === undefined) delete process.env.OPK_PROJECT_ID; else process.env.OPK_PROJECT_ID = originalProject;
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
      rmSync(config, { recursive: true, force: true });
    }
  });

  it('Issue #2445: cutoff crossover is fleet-only and does not change supervisor/scheduler freshness', async () => {
    const oldAt = Date.now() - 4_000;
    const fleetAt = Date.now() - 1_000;
    const between = oldAt + 2_000;
    const report = await verifyAdoptionEffect({
      adoptionStartedAtMs: oldAt, fleetAdoptedAtMs: fleetAt,
      consumers: [
        { id: 'orchestrator-side-process-supervisor', matchedPaths: ['scripts/orchestrator-wake-supervisor.ts'] },
        { id: 'pr2-scheduler', matchedPaths: ['scripts/pr2-foundation/scheduler.ts'] },
        { id: 'agent-hooks', matchedPaths: ['scripts/invoke-read-delegation-audit-stop.ts'] },
        { id: 'fleet-wake@leopoker.service', matchedPaths: ['scripts/fleet/fleet-wake.ts'] },
      ],
      controllers: {
        'orchestrator-side-process-supervisor': { observe: () => ({ state: 'running', startedAtMs: between, identity: 'sup:1' }) },
        'pr2-scheduler': { observe: () => ({ state: 'running', startedAtMs: between, identity: 'scheduler:2' }) },
        'agent-hooks': { observe: () => ({ state: 'ephemeral' }) },
        'fleet-wake@leopoker.service': { observe: () => ({ state: 'running', startedAtMs: between, identity: 'fleet:3' }) },
      },
      restartStaleConsumers: false,
      runLiveCheck: () => ({ ok: true }),
    });
    expect(report.consumers.slice(0, 3).map((row) => row.verified)).toEqual([true, true, true]);
    expect(report.consumers[3]?.verified).toBe(false);
    expect(report.effect).toContain('stale_consumer:fleet-wake@leopoker.service');
    const noFleetTime = await verifyAdoptionEffect({
      adoptionStartedAtMs: oldAt,
      consumers: [{ id: 'fleet-wake@leopoker.service', matchedPaths: ['scripts/fleet/fleet-wake.ts'] }],
      controllers: { 'fleet-wake@leopoker.service': { observe: () => ({ state: 'running', startedAtMs: Date.now(), identity: 'fleet:4' }) } },
      runLiveCheck: () => ({ ok: true }),
    });
    expect(noFleetTime.effect).toContain('fleet_adopted_at_missing_or_invalid');
    expect(noFleetTime.operationalOutcome).toBe('operationally_incomplete');
  });


  it('Issue #2445: shared MainPID/start-ticks cannot authorize either instance, and failed third unit cannot hide behind green peers', async () => {
    const old = Date.now() - 10_000;
    const fleetCutoff = Date.now() - 1_000;
    const projects = ['orchestrator-pack', 'leopoker', 'sample-target'];
    const consumers = projects.map((projectId) => ({
      id: 'fleet-wake@' + projectId + '.service', matchedPaths: ['scripts/fleet/fleet-wake.ts'],
    }));
    let aliasControls = 0;
    const aliased = await verifyAdoptionEffect({
      adoptionStartedAtMs: old,
      fleetAdoptedAtMs: fleetCutoff,
      consumers: consumers.slice(0, 2),
      controllers: Object.fromEntries(consumers.slice(0, 2).map((row) => [row.id, {
        observe: () => ({ state: 'running' as const, startedAtMs: old, identity: '123:456' }),
        restart: () => { aliasControls += 1; },
      }])),
      runLiveCheck: () => ({ ok: true }),
    });
    expect(aliased.consumers.map((row) => row.before.reason)).toEqual([
      'fleet_wake_shared_process_identity', 'fleet_wake_shared_process_identity',
    ]);
    expect(aliased.consumers.every((row) => !row.verified && row.action === 'none')).toBe(true);
    expect(aliasControls).toBe(0);
    expect(aliased.operationalOutcome).toBe('operationally_incomplete');

    const restarts: string[] = [];
    const controllers: Record<string, ConsumerController> = {};
    for (const row of consumers) {
      let restarted = false;
      controllers[row.id] = {
        observe: () => ({
          state: 'running', startedAtMs: restarted ? Date.now() + 1000 : old,
          identity: restarted ? row.id + ':new' : row.id + ':old',
        }),
        restart: () => {
          restarts.push(row.id);
          if (row.id.includes('leopoker')) throw new Error('synthetic_control_failed');
          restarted = true;
        },
      };
    }
    const partial = await verifyAdoptionEffect({
      adoptionStartedAtMs: old, fleetAdoptedAtMs: fleetCutoff, consumers, controllers,
      runLiveCheck: () => ({ ok: true }),
    });
    expect(restarts).toHaveLength(3);
    expect(partial.operationalOutcome).toBe('operationally_incomplete');
    expect(partial.effect).toContain('restart_failed:fleet-wake@leopoker.service');
    expect(partial.consumers.find((row) => row.id === 'fleet-wake@orchestrator-pack.service')?.verified).toBe(true);
    expect(partial.consumers.find((row) => row.id === 'fleet-wake@sample-target.service')?.verified).toBe(true);
    expect(partial.consumers.find((row) => row.id === 'fleet-wake@leopoker.service')?.verified).toBe(false);
    expect(partial.coordinatorMessage).toContain('fleet-wake@leopoker.service');
  });

  it('looks for supervisor status in the supervisor directory the cutover layout defines', () => {
    const home = '/home/operator';
    expect(defaultSupervisorStateDir({ HOME: home })).toBe(canonicalFoundationPaths('/repo', home, 'orchestrator-pack', { HOME: home }).supervisorStateDir);
    expect(defaultSupervisorStateDir({ HOME: home })).toBe('/home/operator/.local/state/orchestrator-pack-wake-supervisor/orchestrator-pack/supervisor');
    expect(defaultSupervisorStateDir({ HOME: home, XDG_STATE_HOME: '/xdg' })).toBe('/xdg/orchestrator-pack-wake-supervisor/orchestrator-pack/supervisor');
    expect(defaultSupervisorStateDir({ OPK_WAKE_SUPERVISOR_STATE_DIR: '/custom/root' })).toBe('/custom/root/supervisor');
  });

  it('tracks the common merge procedure rather than delegated integration only', () => {
    const skill = readFileSync('.cursor/skills/merge-with-local-adoption/SKILL.md', 'utf8');
    expect(skill).toContain('## Verify effect — mandatory after Step 7');
    expect(skill).toContain('scripts/merge-adoption-effect.ts');
    expect(skill).toContain('effect_verified');
    expect(skill).toContain('effect_unverified(<reason>)');
    expect(skill).toContain('operationally_incomplete');
    const adoption = skill.split('## Step 4 — Collect local adoption instructions')[1]!.split('## Step 8 — Sibling advisory')[0]!;
    expect(adoption).toContain('For every non-pack selected card, read exactly `{PRIMARY_ROOT}/AGENTS.md`');
    expect(adoption).toContain('target-owned merge-time adoption instructions and named target live check, if any');
    expect(adoption).toContain('Non-pack cards skip this wiki block');
    expect(adoption).toContain('**Non-pack selected cards:** execute only the named target live check, if any');
    expect(adoption.match(/\*\*Pack only \(`TARGET_REPOSITORY=PACK_REPOSITORY`\):\*\*/gu)).toHaveLength(2);
    expect(adoption).toContain('--repo-root "$PRIMARY_ROOT"');
    expect(adoption).toContain('Do not run the pack verifier or substitute pack process/registry evidence');
    expect(skill).toContain('`REPO` is exactly that selected `PRIMARY_ROOT`');
    expect(skill).not.toContain('PROJECT_ID=orchestrator-pack');
    expect(skill).toContain('A pack card named `pack-local` still takes the pack route');
    expect(skill).toContain('a foreign card named `orchestrator-pack` still takes the target route');
    expect(skill.indexOf('resolve the selected project card')).toBeLessThan(skill.indexOf('Snapshot the operator checkout'));
    for (const command of ['rev-parse --show-toplevel', 'branch --show-current', 'status --short', 'diff --stat', 'diff --cached --stat', 'stash list', 'merge-base --is-ancestor "$MERGE_SHA" HEAD', 'log -1 --oneline']) {
      expect(skill).toContain('git -C "$PRIMARY_ROOT" ' + command);
    }
  });
});
