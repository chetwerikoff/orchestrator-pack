import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  applyOpkVitestHarnessEscalationEnv,
  sharedDefaultEscalationStatePath,
} from './test-harness-escalation-env.js';

type SharedDefaultSnapshot = {
  exists: boolean;
  mtimeMs?: number;
  contentHash?: string;
};

let sharedDefaultSnapshot: SharedDefaultSnapshot;

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

export default function setup() {
  sharedDefaultSnapshot = snapshotSharedDefaultStore();
  applyOpkVitestHarnessEscalationEnv();
}

export async function teardown() {
  assertSharedDefaultUnmutated();
}
