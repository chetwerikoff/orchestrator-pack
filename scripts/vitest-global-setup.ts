import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  applyOpkVitestHarnessEscalationEnv,
  sharedDefaultEscalationStatePath,
} from './test-harness-escalation-env.js';
import {
  registerLaneLease,
  runReaperCli,
  touchLeaseHeartbeat,
  repoRoot,
} from './testmode-fleet-harness.js';

type SharedDefaultSnapshot = {
  exists: boolean;
  mtimeMs?: number;
  contentHash?: string;
};

let sharedDefaultSnapshot: SharedDefaultSnapshot;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

function snapshotSharedDefaultStore(): SharedDefaultSnapshot {
  const storePath = sharedDefaultEscalationStatePath();
  if (!existsSync(storePath)) {
    return { exists: false };
  }
  const stat = statSync(storePath);
  const content = readFileSync(storePath);
  return {
    exists: true,
    mtimeMs: stat.mtimeMs,
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
}

function assertSharedDefaultUnmutated(): void {
  const after = snapshotSharedDefaultStore();
  if (!sharedDefaultSnapshot.exists && !after.exists) {
    return;
  }
  if (sharedDefaultSnapshot.exists !== after.exists) {
    throw new Error(
      `shared escalation store existence changed during test run: before=${sharedDefaultSnapshot.exists} after=${after.exists}`,
    );
  }
  if (
    sharedDefaultSnapshot.mtimeMs !== after.mtimeMs
    || sharedDefaultSnapshot.contentHash !== after.contentHash
  ) {
    const storePath = sharedDefaultEscalationStatePath();
    let detail = `path=${storePath}`;
    try {
      const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as {
        records?: Record<string, { correlationKey?: string }>;
      };
      const testOriginated = Object.values(parsed.records ?? {}).filter((record) =>
        /opk-vitest/i.test(String(record.correlationKey ?? '')),
      );
      if (testOriginated.length > 0) {
        detail += ` test_originated_records=${testOriginated.length}`;
      }
    } catch {
      // keep hash-only detail when parse fails
    }
    throw new Error(`shared escalation store mutated during test run (${detail})`);
  }
}

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
  sharedDefaultSnapshot = snapshotSharedDefaultStore();
  applyOpkVitestHarnessEscalationEnv();

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

  runReaperCli('bootstrap');
  startLeaseHeartbeat();
}

export async function teardown() {
  stopLeaseHeartbeat();
  try {
    runReaperCli('teardown');
  } finally {
    assertSharedDefaultUnmutated();
  }
}
