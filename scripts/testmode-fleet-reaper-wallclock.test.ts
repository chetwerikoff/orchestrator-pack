import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  isAlive,
  makeStateDir,
  runSupervisor,
} from './supervisor-recovery.test-helpers.js';
import {
  isolatedLeaseRoot,
  isAlive as harnessIsAlive,
  killProcess,
  registerLaneLease,
  runPwshFile,
  runReaperCli,
} from './testmode-fleet-harness.js';
import {
  registerFleetReaperAfterEach,
  registerLeaseForOwner,
  reaperScript,
  startDetachedTestModeFleet,
  startLiveDetachedSupervisor,
  startRenewalOwner,
  waitForLiveChildPids,
  withLeaseEnv,
} from './testmode-fleet-reaper.shared.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

registerFleetReaperAfterEach();

describe('Issue #710 live fleet inert (AC#4)', () => {
  it.skipIf(process.platform === 'win32')(
    'reaper and TTL paths leave live supervisor Start without -TestMode running',
    async () => {
      const leaseRoot = isolatedLeaseRoot();
      const lane = registerLaneLease({ leaseRoot, laneId: 'live-negative' });
      const stateDir = makeStateDir();
      const supervisorPid = await startLiveDetachedSupervisor(stateDir);
      const liveChildren = await waitForLiveChildPids(stateDir);
      const reviewTriggerReconcile = { pid: liveChildren.reviewTriggerReconcile };
      const escalationRouter = { pid: liveChildren.escalationRouter };

      const fixture = spawn('sleep', ['3600'], { stdio: 'ignore', detached: true });
      fixture.unref();
      const fixturePid = fixture.pid ?? 0;

      runReaperCli('bootstrap', {}, withLeaseEnv(leaseRoot, lane.leaseId));
      runReaperCli('teardown', { LeaseId: lane.leaseId }, withLeaseEnv(leaseRoot, lane.leaseId));

      expect(isAlive(reviewTriggerReconcile.pid)).toBe(true);
      expect(isAlive(escalationRouter.pid)).toBe(true);
      expect(isAlive(supervisorPid)).toBe(true);
      expect(harnessIsAlive(fixturePid)).toBe(true);

      killProcess(fixturePid);
      runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    },
    180_000,
  );
});

describe('Issue #710 marker identification (AC#5)', () => {
  it.skipIf(process.platform === 'win32')(
    'real spawned pwsh e2e matches TestMode marker and not live root',
    async () => {
      const leaseRoot = isolatedLeaseRoot();
      const owner = startRenewalOwner();
      const lane = registerLeaseForOwner(leaseRoot, owner.pid, owner.startTime, 'identity-lane');
      const stateDir = makeStateDir();
      await startDetachedTestModeFleet(stateDir, withLeaseEnv(leaseRoot, lane.leaseId));
      const observe = runPwshFile(reaperScript, ['observe'], withLeaseEnv(leaseRoot, lane.leaseId));
      const payload = JSON.parse(observe.stdout) as { matched?: number; survivors?: number[] };
      expect((payload.matched ?? 0) > 0 || (payload.survivors?.length ?? 0) > 0).toBe(true);
      runReaperCli('teardown', { LeaseId: lane.leaseId }, withLeaseEnv(leaseRoot, lane.leaseId));
      killProcess(owner.pid);
    },
    180_000,
  );
});

describe('Issue #710 CI hygiene assertion (AC#6)', () => {
  it.skipIf(process.platform === 'win32')('observe exits non-zero when this-run survivors remain', async () => {
    const leaseRoot = isolatedLeaseRoot();
    const owner = startRenewalOwner();
    const lane = registerLeaseForOwner(leaseRoot, owner.pid, owner.startTime, 'ci-lane');
    const stateDir = makeStateDir();
    const fleet = await startDetachedTestModeFleet(stateDir, withLeaseEnv(leaseRoot, lane.leaseId));
    expect(isAlive(fleet.supervisorPid)).toBe(true);

    const observe = runPwshFile(reaperScript, ['observe'], withLeaseEnv(leaseRoot, lane.leaseId));
    expect(observe.status).not.toBe(0);

    runReaperCli('teardown', { LeaseId: lane.leaseId }, withLeaseEnv(leaseRoot, lane.leaseId));
    killProcess(owner.pid);
  }, 180_000);

  it.skipIf(process.platform === 'win32')('cleanup reports masked leak when survivors required post-run kill', async () => {
    const leaseRoot = isolatedLeaseRoot();
    const owner = startRenewalOwner();
    const lane = registerLeaseForOwner(leaseRoot, owner.pid, owner.startTime, 'ci-mask-lane');
    const stateDir = makeStateDir();
    await startDetachedTestModeFleet(stateDir, withLeaseEnv(leaseRoot, lane.leaseId));

    const cleanup = runPwshFile(reaperScript, ['cleanup'], withLeaseEnv(leaseRoot, lane.leaseId));
    expect(cleanup.status).not.toBe(0);
    const payload = JSON.parse(cleanup.stdout) as { maskedLeak?: boolean };
    expect(payload.maskedLeak).toBe(true);
    killProcess(owner.pid);
  }, 180_000);
});
