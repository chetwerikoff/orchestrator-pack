// @vitest-ci-lane light
// @vitest-pre-topology-seconds 20
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
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

async function stopFixture(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), delay(2_000)]);
}

async function startFixture(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (!child.pid) throw new Error('fixture process did not start');
  await waitForProcessStart(child.pid);
  return child;
}

describe('Issue #2145 merge adoption effect verification', () => {
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
      const oldStart = await waitForProcessStart(child.pid!);
      await delay(100);
      const adoptionStartedAtMs = Date.now();
      expect(oldStart).toBeLessThan(adoptionStartedAtMs);
      const controller: ConsumerController = {
        observe: async () => {
          const startedAtMs = await waitForProcessStart(child.pid!);
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
      const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || 'git fixture command failed');
      return (result.stdout ?? '').trim();
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

  it('tracks the common merge procedure rather than delegated integration only', () => {
    const skill = readFileSync('.cursor/skills/merge-with-local-adoption/SKILL.md', 'utf8');
    expect(skill).toContain('### 8. Verify effect');
    expect(skill).toContain('scripts/merge-adoption-effect.ts');
    expect(skill).toContain('effect_verified');
    expect(skill).toContain('effect_unverified(<reason>)');
    expect(skill).toContain('operationally_incomplete');
  });
});
