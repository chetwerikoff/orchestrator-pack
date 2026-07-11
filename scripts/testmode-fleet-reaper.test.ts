import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  isAlive,
  makeStateDir,
  repoRoot,
  waitForProcessesStopped,
} from './supervisor-recovery.test-helpers.js';
import {
  getCanonicalDefaultLeaseRoot,
  isolatedLeaseRoot,
  isAlive as harnessIsAlive,
  killProcess,
  registerLaneLease,
  runReaperCli,
  seedStaleLeaseRecord,
  writeCorruptLeaseRecord,
} from './testmode-fleet-harness.js';
import {
  registerFleetReaperAfterEach,
  registerLeaseForOwner,
  renewLaneLease,
  runPwsh,
  spawnOrphanTestModeChild,
  startDetachedTestModeFleet,
  startLeaseHeartbeat,
  startRenewalOwner,
  supervisorLib,
  testChildScript,
  reaperScript,
  ttlLeaseEnv,
  withLeaseEnv,
} from './testmode-fleet-reaper.shared.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

registerFleetReaperAfterEach();

describe('Issue #710 TestMode fleet lease TTL (AC#1)', () => {
  it.skipIf(process.platform === 'win32')(
    'TestMode supervisor and children self-exit when renewal-owner dies',
    async () => {
      const leaseRoot = isolatedLeaseRoot();
      const owner = startRenewalOwner();
      const lane = registerLeaseForOwner(leaseRoot, owner.pid, owner.startTime, 'ttl-lane');
      const stateDir = makeStateDir();
      const fleet = await startDetachedTestModeFleet(
        stateDir,
        withLeaseEnv(leaseRoot, lane.leaseId, ttlLeaseEnv),
      );

      killProcess(owner.pid);
      await waitForProcessesStopped(
        [fleet.supervisorPid, fleet.listener.pid, fleet.escalationRouter.pid],
        45_000,
      );
      expect(isAlive(fleet.supervisorPid)).toBe(false);
      expect(isAlive(fleet.listener.pid)).toBe(false);
      expect(isAlive(fleet.escalationRouter.pid)).toBe(false);
    },
    90_000,
  );
});

describe('Issue #710 bootstrap pre-sweep (AC#2, AC#7)', () => {
  it.skipIf(process.platform === 'win32')(
    'bootstrap pre-sweep clears stale leaked fleets and keeps concurrent live lane',
    async () => {
      const leaseRoot = isolatedLeaseRoot();
      const staleState = makeStateDir();
      const staleLease = seedStaleLeaseRecord(leaseRoot, staleState);
      const orphanPid = spawnOrphanTestModeChild(staleState);
      expect(harnessIsAlive(orphanPid)).toBe(true);

      const liveOwner = startRenewalOwner();
      const liveLane = registerLeaseForOwner(leaseRoot, liveOwner.pid, liveOwner.startTime, 'live-lane');
      const liveState = makeStateDir();
      const liveHeartbeat = startLeaseHeartbeat(leaseRoot, liveLane.leaseId);
      try {
        const liveFleet = await startDetachedTestModeFleet(
          liveState,
          withLeaseEnv(leaseRoot, liveLane.leaseId),
        );
        renewLaneLease(leaseRoot, liveLane.leaseId);

        const currentLane = registerLaneLease({ leaseRoot, laneId: 'bootstrap-lane' });
        renewLaneLease(leaseRoot, liveLane.leaseId);
        const bootstrap = runReaperCli('bootstrap', {}, withLeaseEnv(leaseRoot, currentLane.leaseId));
        expect(bootstrap.status, bootstrap.stderr || bootstrap.stdout).toBe(0);

        const orphanDeadline = Date.now() + 20_000;
        while (Date.now() < orphanDeadline && harnessIsAlive(orphanPid)) {
          renewLaneLease(leaseRoot, liveLane.leaseId);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(harnessIsAlive(orphanPid)).toBe(false);

        const liveSupervisorPid = Number(
          fs.readFileSync(path.join(liveState, 'supervisor.pid'), 'utf8').trim(),
        );
        expect(isAlive(liveSupervisorPid)).toBe(true);
        expect(isAlive(liveFleet.listener.pid)).toBe(true);
      } finally {
        clearInterval(liveHeartbeat);
      }

      runReaperCli('teardown', { LeaseId: liveLane.leaseId }, withLeaseEnv(leaseRoot, liveLane.leaseId));
      killProcess(liveOwner.pid);
    },
    120_000,
  );

  it.skipIf(process.platform === 'win32')(
    'supervisor crash leaves orphans recovered by bootstrap pre-sweep',
    async () => {
      const leaseRoot = isolatedLeaseRoot();
      const owner = startRenewalOwner();
      const lane = registerLeaseForOwner(leaseRoot, owner.pid, owner.startTime, 'crash-lane');
      const stateDir = makeStateDir();
      const fleet = await startDetachedTestModeFleet(stateDir, withLeaseEnv(leaseRoot, lane.leaseId));
      killProcess(fleet.supervisorPid);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(isAlive(fleet.listener.pid)).toBe(true);
      killProcess(owner.pid);
      await new Promise((resolve) => setTimeout(resolve, 250));

      const recoveryLane = registerLaneLease({ leaseRoot, laneId: 'recovery-lane' });
      const bootstrap = runReaperCli('bootstrap', {}, withLeaseEnv(leaseRoot, recoveryLane.leaseId));
      expect(bootstrap.status, bootstrap.stderr || bootstrap.stdout).toBe(0);
      await waitForProcessesStopped([fleet.listener.pid, fleet.escalationRouter.pid], 45_000);
      expect(isAlive(fleet.listener.pid)).toBe(false);
    },
    120_000,
  );

  it('treats corrupt lease records as stale during bootstrap', () => {
    const leaseRoot = isolatedLeaseRoot();
    const leaseId = 'corrupt-lease';
    writeCorruptLeaseRecord(leaseRoot, leaseId);
      const result = runPwsh(
      `. '${supervisorLib.replace(/'/g, "''")}'; . '${path.join(repoRoot, 'scripts/lib/Invoke-TestModeFleetReaper.ps1').replace(/'/g, "''")}'; $d = Test-TestModeFleetLeaseStale -Record $null -TreatCorruptAsStale; Write-Output $d.stale`,
      { OPK_TESTMODE_LEASE_ROOT: leaseRoot },
    );
    expect(result.stdout.trim()).toBe('True');
  });

  it('uses durable default lease root when leaseRoot omitted', () => {
    const savedRoot = process.env.OPK_TESTMODE_LEASE_ROOT;
    delete process.env.OPK_TESTMODE_LEASE_ROOT;
    try {
      expect(getCanonicalDefaultLeaseRoot()).toContain('opk-testmode-fleet-leases');
      expect(getCanonicalDefaultLeaseRoot()).toMatch(/[/\\]ws-[0-9a-f]{16}$/);
    } finally {
      if (savedRoot !== undefined) {
        process.env.OPK_TESTMODE_LEASE_ROOT = savedRoot;
      } else {
        delete process.env.OPK_TESTMODE_LEASE_ROOT;
      }
    }
  });

  it.skipIf(process.platform === 'win32')(
    'bootstrap reaps orphans linked to corrupt indexed lease records',
    async () => {
      const leaseRoot = isolatedLeaseRoot();
      const stateDir = makeStateDir();
      const leaseId = 'corrupt-bootstrap';
      writeCorruptLeaseRecord(leaseRoot, leaseId);
      fs.writeFileSync(path.join(stateDir, 'testmode-lane-lease.id'), leaseId);
      const orphanPid = spawnOrphanTestModeChild(stateDir);
      expect(harnessIsAlive(orphanPid)).toBe(true);

      const recovery = registerLaneLease({ leaseRoot, laneId: 'recovery-corrupt' });
      const bootstrap = runReaperCli('bootstrap', {}, withLeaseEnv(leaseRoot, recovery.leaseId));
      expect(bootstrap.status).toBe(0);
      await waitForProcessesStopped([orphanPid], 20_000);
      expect(harnessIsAlive(orphanPid)).toBe(false);
    },
    90_000,
  );
});


describe('Issue #710 teardown post-sweep (AC#3)', () => {
  it.skipIf(process.platform === 'win32')(
    'teardown reaps this run TestMode fleet on hook-executable exit path',
    async () => {
      const leaseRoot = isolatedLeaseRoot();
      const owner = startRenewalOwner();
      const lane = registerLeaseForOwner(leaseRoot, owner.pid, owner.startTime, 'teardown-lane');
      const stateDir = makeStateDir();
      const fleet = await startDetachedTestModeFleet(stateDir, withLeaseEnv(leaseRoot, lane.leaseId));
      const teardown = runReaperCli('teardown', { LeaseId: lane.leaseId }, withLeaseEnv(leaseRoot, lane.leaseId));
      expect(teardown.status).toBe(0);
      await waitForProcessesStopped(
        [fleet.supervisorPid, fleet.listener.pid, fleet.escalationRouter.pid],
        20_000,
      );
      killProcess(owner.pid);
    },
    90_000,
  );
});

describe('Issue #710 marker identification (AC#5)', () => {
  it('classifies supervisor cmdline identity using fixtures', () => {
    const stateDir = makeStateDir();
    const fixturePath = path.join(stateDir, 'cmdline-fixture.json');
    const cmdline = [
      'pwsh', '-File', path.join(repoRoot, 'scripts/orchestrator-wake-supervisor.ps1'),
      '-Action', 'Start', '-SupervisorLoop', '-StateDir', stateDir, '-TestMode',
    ].join(' ');
    fs.writeFileSync(fixturePath, JSON.stringify({ '424242': cmdline }));
    const result = runPwsh(
      `$env:AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE='${fixturePath.replace(/'/g, "''")}'; . '${supervisorLib.replace(/'/g, "''")}'; . '${path.join(repoRoot, 'scripts/lib/Invoke-TestModeFleetReaper.ps1').replace(/'/g, "''")}'; $c = Get-TestModeFleetProcessClassification -ProcessId 424242; Write-Output $c.kind`,
    );
    expect(result.stdout.trim()).toBe('testmode_supervisor');
  });

  it('classifies env-only managed child using fixtures (AC#5 non-cmdline markers)', () => {
    const stateDir = makeStateDir();
    const markerDir = path.join(stateDir, 'markers');
    const cmdlineFixturePath = path.join(stateDir, 'cmdline-fixture.json');
    const envFixturePath = path.join(stateDir, 'env-fixture.json');
    const childScript = path.join(repoRoot, 'scripts/orchestrator-wake-supervisor-test-child.ps1');
    fs.writeFileSync(cmdlineFixturePath, JSON.stringify({ '424243': `pwsh -File ${childScript}` }));
    fs.writeFileSync(envFixturePath, JSON.stringify({
      '424243': {
        AO_SIDE_PROCESS_STATE_DIR: stateDir,
        AO_WAKE_SUPERVISOR_TEST_MARKER_DIR: markerDir,
      },
    }));
    const reaperLib = path.join(repoRoot, 'scripts/lib/Invoke-TestModeFleetReaper.ps1');
    const result = runPwsh(
      `$env:AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE='${cmdlineFixturePath.replace(/'/g, "''")}'; `
      + `$env:AO_PROCESS_ENV_FIXTURE='${envFixturePath.replace(/'/g, "''")}'; `
      + `. '${supervisorLib.replace(/'/g, "''")}'; `
      + `. '${reaperLib.replace(/'/g, "''")}'; `
      + '$c = Get-TestModeFleetProcessClassification -ProcessId 424243; Write-Output $c.kind',
    );
    expect(result.stdout.trim()).toBe('testmode_managed');
  });
});

describe('Issue #710 vitest lane context (AC#6 multi-invocation)', () => {
  it('collects every heavy-shard lane lease context for post-run observe', () => {
    const leaseRoot = isolatedLeaseRoot();
    const savedShard = process.env.VITEST_HEAVY_SHARD;
    process.env.VITEST_HEAVY_SHARD = '9';
    try {
      const laneA = registerLaneLease({ leaseRoot, laneId: 'heavy-shard-9', runId: 'invocation-a' });
      const laneB = registerLaneLease({ leaseRoot, laneId: 'heavy-shard-9', runId: 'invocation-b' });
      const result = runPwsh(
      `. '${path.join(repoRoot, 'scripts/lib/TestMode-FleetLease.ps1').replace(/'/g, "''")}'; `
      + `$ctx = @(Get-TestModeVitestLaneLeaseContexts -Shard '9' -LeaseRoot '${leaseRoot.replace(/'/g, "''")}'); `
      + 'Write-Output (($ctx | ForEach-Object { $_.leaseId } | Sort-Object -Unique) -join ",")',
      { OPK_TESTMODE_LEASE_ROOT: leaseRoot, VITEST_HEAVY_SHARD: '9' },
    );
      expect(result.status).toBe(0);
      const leaseIds = result.stdout.trim().split(',').filter(Boolean).sort();
      expect(leaseIds).toEqual([laneA.leaseId, laneB.leaseId].sort());
    } finally {
      if (savedShard === undefined) {
        delete process.env.VITEST_HEAVY_SHARD;
      } else {
        process.env.VITEST_HEAVY_SHARD = savedShard;
      }
    }
  });

});
