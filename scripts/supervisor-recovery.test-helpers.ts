import * as core from './supervisor-recovery.test-helpers-core.js';

export {
  repoRoot,
  supervisorScript,
  fixtureDir,
  supervisorHookTimeoutMs,
  supervisorAsyncTimeoutMs,
  thawFrozenSupervisorPids,
  freezeSupervisorPid,
  SUPERVISOR_TEST_POLL_INTERVAL_MS,
  sleepMs,
  fixedObservationWindow,
  waitForCondition,
  waitForStdoutContains,
  waitForMarkerPidChange,
  waitForSupervisorLogMatchFromOffset,
  runSupervisor,
  runSupervisorAsync,
  startSupervisorBackground,
  waitForSupervisorHealthyStatus,
  isAlive,
  waitForProcessesStopped,
  countLogMatches,
  readSupervisorLog,
  readChildRecovery,
  readChildPid,
  waitForSupervisorLogMatch,
  stopSupervisorChild,
  runPwsh,
  psString,
  type WakeMarker,
} from './supervisor-recovery.test-helpers-core.js';

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

const trackedStateDirs = new Set<string>();

export function makeStateDir(): string {
  const stateDir = core.makeStateDir();
  trackedStateDirs.add(stateDir);
  return stateDir;
}

export function cleanupSupervisorTests(): void {
  for (const stateDir of trackedStateDirs) {
    try {
      core.runSupervisor(
        ['-Action', 'Stop', '-Force', '-StateDir', stateDir],
        { AO_WAKE_SUPERVISOR_TEST_FAST_STOP: '1' },
      );
    } catch {
      // Core cleanup handles stale marker/pid fallbacks.
    }
  }
  trackedStateDirs.clear();
  core.cleanupSupervisorTests();
}

function normalizeLegacyTestRole(role: string): string {
  return role === 'listener' ? 'review-trigger-reconcile' : role;
}

export async function waitForMarkers(
  stateDir: string,
  timeoutMs = 25_000,
  roles: readonly string[] = managedChildRoles,
): Promise<void> {
  await core.waitForMarkers(
    stateDir,
    timeoutMs,
    roles.map(normalizeLegacyTestRole) as readonly core.ManagedChildRole[],
  );
}

export async function waitForMarker(
  stateDir: string,
  role: string,
  timeoutMs = 25_000,
): Promise<void> {
  await core.waitForMarker(stateDir, normalizeLegacyTestRole(role), timeoutMs);
}

export async function readMarker(
  stateDir: string,
  role: string,
  timeoutMs = 5000,
): Promise<core.WakeMarker> {
  return core.readMarker(stateDir, normalizeLegacyTestRole(role), timeoutMs);
}
