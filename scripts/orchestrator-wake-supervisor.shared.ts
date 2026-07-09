import path from 'node:path';
import { afterEach } from 'vitest';
import { cleanupSupervisorTests, fixtureDir, runSupervisor } from './supervisor-recovery.test-helpers.js';

export { execFileSync, spawn, spawnSync } from 'node:child_process';
export { default as fs } from 'node:fs';
export { default as path } from 'node:path';
export { afterEach, describe, expect, it } from 'vitest';
export {
  cleanupSupervisorTests,
  fixtureDir,
  isAlive,
  makeStateDir,
  managedChildRoles,
  readMarker,
  repoRoot,
  runSupervisor,
  startSupervisorBackground,
  supervisorScript,
  waitForMarkers,
  waitForSupervisorHealthyStatus,
  waitForProcessesStopped,
  type ManagedChildRole,
  type WakeMarker,
} from './supervisor-recovery.test-helpers.js';

export const aoStub = path.join(fixtureDir, 'ao-stub.sh');
export const supervisorHookTimeoutMs = 120_000;
export const detachedSupervisorTimeoutMs = 120_000;
export const issue205TimeoutMs = 60_000;

afterEach(() => {
  cleanupSupervisorTests();
}, supervisorHookTimeoutMs);

export async function stopSupervisorChild(
  child: { kill: (signal: NodeJS.Signals) => void },
  stateDir: string,
): Promise<void> {
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
}
