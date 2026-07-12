import path from 'node:path';
import { afterEach } from 'vitest';
import {
  cleanupSupervisorTests,
  fixtureDir,
  runSupervisor,
  waitForMarkers as waitForMarkersCore,
} from './supervisor-recovery.test-helpers.js';

export { execFileSync, spawn, spawnSync } from 'node:child_process';
export { default as fs } from 'node:fs';
export { default as path } from 'node:path';
export { afterEach, describe, expect, it } from 'vitest';
export {
  cleanupSupervisorTests,
  fixtureDir,
  fixedObservationWindow,
  isAlive,
  makeStateDir,
  readMarker,
  readSupervisorLog,
  repoRoot,
  runSupervisor,
  sleepMs,
  startSupervisorBackground,
  stopSupervisorChild,
  supervisorScript,
  waitForCondition,
  waitForMarkerPidChange,
  waitForProcessesStopped,
  waitForStdoutContains,
  waitForSupervisorLogMatch,
  waitForSupervisorLogMatchFromOffset,
  waitForSupervisorHealthyStatus,
  type WakeMarker,
} from './supervisor-recovery.test-helpers.js';

export const managedChildRoles = [
  'review-trigger-reconcile',
  'review-trigger-reeval',
  'review-ready-report-state-seed',
  'ci-green-wake-reconcile',
  'worker-message-submit-reconcile',
  'review-start-claim-reaper',
  'ci-failure-notification-reconcile',
  'dead-worker-reconcile',
  'escalation-router',
] as const;

export type ManagedChildRole = (typeof managedChildRoles)[number];

export async function waitForMarkers(
  stateDir: string,
  timeoutMs = 25_000,
  roles: readonly ManagedChildRole[] = managedChildRoles,
): Promise<void> {
  await waitForMarkersCore(stateDir, timeoutMs, roles);
}

export const aoStub = path.join(fixtureDir, 'ao-stub.sh');
export const supervisorHookTimeoutMs = 120_000;
export const detachedSupervisorTimeoutMs = 120_000;
export const issue205TimeoutMs = 60_000;

afterEach(() => {
  cleanupSupervisorTests();
}, supervisorHookTimeoutMs);
