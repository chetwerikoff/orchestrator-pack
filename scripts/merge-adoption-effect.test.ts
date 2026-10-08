// @vitest-ci-lane heavy
// @vitest-pre-topology-seconds 20
import { runProcess, runProcessSync, type ProcessResult } from './kernel/subprocess.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as subprocess from './kernel/subprocess.ts';
import { canonicalFoundationPaths } from './lib/cutover/foundation-observation.ts';
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
  write(root, 'package.json', JSON.stringify({ imports: { '#opk-kernel/*': './scripts/kernel/*.ts' } }));
  write(root, 'scripts/orchestrator-side-process-registry.json', JSON.stringify({ children: [{ id: 'pr2-scheduler', script: 'pr2-foundation/scheduler.ts' }] }));
  write(root, 'scripts/orchestrator-wake-supervisor.ts', "import './lib/supervisor-core.ts';\nimport '#opk-kernel/shared';\n");
  write(root, 'scripts/lib/supervisor-core.ts', 'export const supervisor = true;\n');
  write(root, 'scripts/kernel/shared.ts', 'export const shared = true;\n');
  write(root, 'scripts/pr2-foundation/scheduler.ts', "import './scheduler-core.ts';\n");
  write(root, 'scripts/pr2-foundation/scheduler-core.ts', 'export const scheduler = true;\n');
  write(root, 'scripts/fleet/fleet-wake.ts', 'export const wake = true;\n');
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

describe('Issue #2145 merge adoption effect verification', () => {
  it('refuses a target root before Git, restart controls, or live checks and names target-owned adoption', async () => {
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

  it('maps changed code to the supervisor, registry scheduler, fleet-wake unit, and agent hooks', () => {
    const root = mappingFixture();
    try {
      const consumers = mapChangedPathsToConsumers(root, [
        'scripts/lib/supervisor-core.ts',
        'scripts/kernel/shared.ts',
        'scripts/pr2-foundation/scheduler-core.ts',
        'scripts/fleet/fleet-wake@.service',
        'scripts/invoke-read-delegation-audit-stop.ts',
      ]);
      const byId = new Map(consumers.map((row) => [row.id, row.matchedPaths]));
      expect(byId.get('orchestrator-side-process-supervisor')).toContain('scripts/lib/supervisor-core.ts');
      expect(byId.get('orchestrator-side-process-supervisor')).toContain('scripts/kernel/shared.ts');
      expect(byId.get('pr2-scheduler')).toContain('scripts/pr2-foundation/scheduler-core.ts');
      expect(byId.get('fleet-wake@orchestrator-pack.service')).toContain('scripts/fleet/fleet-wake@.service');
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
    expect(adoption.match(/\*\*Pack only \(`PROJECT_ID=orchestrator-pack`\):\*\*/gu)).toHaveLength(2);
    expect(adoption).toContain('--repo-root "$PRIMARY_ROOT"');
    expect(adoption).toContain('Do not run the pack verifier or substitute pack process/registry evidence');
    expect(skill).toContain('`REPO` is exactly that selected `PRIMARY_ROOT`');
  });
});
