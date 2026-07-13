import { applyOpkVitestHarnessEscalationEnv } from './test-harness-escalation-env.js';
import {
  registerLaneLease,
  runReaperCli,
  touchLeaseHeartbeat,
  writeVitestLaneLeaseContextFromEnv,
  repoRoot,
} from './testmode-fleet-harness.js';

let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

function startLeaseHeartbeat(): void {
  const intervalSeconds = Number(process.env.AO_TESTMODE_FLEET_HEARTBEAT_INTERVAL_SECONDS ?? '5');
  const intervalMs = Math.max(1, intervalSeconds) * 1000;
  touchLeaseHeartbeat();
  heartbeatTimer = setInterval(() => {
    touchLeaseHeartbeat();
  }, intervalMs);
  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }
}

function stopLeaseHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

export default function setup() {
  // The supported package/lane wrapper owns the parent live-store snapshot and
  // transient watcher before Vitest loads. Global setup propagates the isolated
  // environment and child-process lease root; duplicating an ancestor watcher
  // here would turn unrelated sibling state into false store mutations.
  applyOpkVitestHarnessEscalationEnv();
  process.env.OPK_TESTMODE_FLEET_WORKSPACE_ROOT = repoRoot;

  const laneId = process.env.VITEST_HEAVY_SHARD
    ? `heavy-shard-${process.env.VITEST_HEAVY_SHARD}`
    : process.env.VITEST_CI_LIGHT_LANE === '1'
      ? 'light-lane'
      : 'default-lane';

  registerLaneLease({
    laneId,
    runId: process.env.GITHUB_RUN_ID
      ? `gh-${process.env.GITHUB_RUN_ID}`
      : `local-${process.pid}-${Date.now()}`,
    workspaceRoot: repoRoot,
  });

  const bootstrap = runReaperCli('bootstrap');
  if (bootstrap.status !== 0) {
    throw new Error(
      `TestMode fleet bootstrap pre-sweep failed: status=${bootstrap.status} ${bootstrap.stderr || bootstrap.stdout}`,
    );
  }
  startLeaseHeartbeat();
}

export function teardown() {
  stopLeaseHeartbeat();
  writeVitestLaneLeaseContextFromEnv();
  if (process.env.VITEST_HEAVY_SHARD?.trim()) {
    // Per-invocation observe before the next file bootstrap can mask survivors (AC#6).
    const observe = runReaperCli('observe');
    if (observe.status !== 0) {
      throw new Error(
        `TestMode fleet heavy invocation left survivors: status=${observe.status} ${observe.stderr || observe.stdout}`,
      );
    }
    return;
  }

  const teardownResult = runReaperCli('teardown');
  if (teardownResult.status !== 0) {
    throw new Error(
      `TestMode fleet teardown post-sweep failed: status=${teardownResult.status} ${teardownResult.stderr || teardownResult.stdout}`,
    );
  }
  const observe = runReaperCli('observe');
  if (observe.status !== 0) {
    throw new Error(
      `TestMode fleet teardown left survivors: status=${observe.status} ${observe.stderr || observe.stdout}`,
    );
  }
}
