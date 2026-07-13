import { applyOpkVitestHarnessEscalationEnv } from './test-harness-escalation-env.js';
import { startLiveStoreGuard } from './lib/vitest-live-store-harness.mjs';
import {
  registerLaneLease,
  runReaperCli,
  touchLeaseHeartbeat,
  writeVitestLaneLeaseContextFromEnv,
  repoRoot,
} from './testmode-fleet-harness.js';

let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let liveStoreGuard: { stop(): void } | undefined;

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
  // This is a second line of defense for marker-bearing direct invocations. The
  // package/lane parent wrapper starts its guard before Vitest is spawned.
  liveStoreGuard = startLiveStoreGuard({ ...process.env });
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

export async function teardown() {
  stopLeaseHeartbeat();
  let primaryFailure: unknown;
  try {
    writeVitestLaneLeaseContextFromEnv();
    if (process.env.VITEST_HEAVY_SHARD?.trim()) {
      // Per-invocation observe before the next file bootstrap can mask survivors (AC#6).
      const observe = runReaperCli('observe');
      if (observe.status !== 0) {
        throw new Error(
          `TestMode fleet heavy invocation left survivors: status=${observe.status} ${observe.stderr || observe.stdout}`,
        );
      }
    } else {
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
  } catch (error) {
    primaryFailure = error;
  } finally {
    await new Promise((resolveFlush) => setTimeout(resolveFlush, 25));
    try {
      liveStoreGuard?.stop();
    } catch (guardError) {
      if (primaryFailure) {
        throw new AggregateError(
          [primaryFailure, guardError],
          'Vitest teardown and live-store guard both failed',
        );
      }
      throw guardError;
    }
  }
  if (primaryFailure) throw primaryFailure;
}
