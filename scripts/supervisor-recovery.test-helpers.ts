import fs from 'node:fs';
import path from 'node:path';
import * as core from './supervisor-recovery.test-helpers-core.js';

export * from './supervisor-recovery.test-helpers-core.js';

export const managedChildRoles = [
  'review-trigger-reconcile',
  'review-trigger-reeval',
  'review-ready-report-state-seed',
  'ci-green-wake-reconcile',
  'dead-worker-reconcile',
  'worker-message-submit-reconcile',
  'review-start-claim-reaper',
  'ci-failure-notification-reconcile',
  'escalation-router',
] as const;

export type ManagedChildRole = (typeof managedChildRoles)[number];

export async function waitForMarkers(
  stateDir: string,
  timeoutMs = 25_000,
  roles: readonly ManagedChildRole[] = managedChildRoles,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = roles.every((role) =>
      fs.existsSync(path.join(stateDir, 'markers', `${role}.marker.json`)),
    );
    if (ready) return;
    await core.sleepMs(core.SUPERVISOR_TEST_POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for supervisor child markers: ${roles.join(', ')}`);
}
