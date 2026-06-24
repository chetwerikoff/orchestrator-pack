import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  claimEpisodePreflight,
  decideCiFailureNotification,
  evaluatePreflightRevalidation,
  markSendDelivered,
  recordPendingEpisode,
  reserveSubmitIntent,
  resolveSubmittedDelivery,
} from '../docs/ci-failure-notification.mjs';
import { buildCaptureWorkerState } from './lib/ci-failure-capture-worker-state.mjs';
import { buildCiFailureProgressProofPayload } from './lib/ci-failure-progress-proof.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'scripts/fixtures/ci-failure-notification');

const episode = {
  repo: 'chetwerikoff/orchestrator-pack',
  prNumber: 283,
  headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  redPeriod: 'suite-100-attempt-1',
  targetId: 'session-active-redacted',
  targetGeneration: 'generation-active-redacted',
};

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as T;
}

function captureWorkerState(scenarioFixture: string) {
  return buildCaptureWorkerState(scenarioFixture, episode, fixturesDir);
}

function staleProgressClock() {
  const pins = fixture<{
    defaultProgressFreshnessMs: number;
    staleEvaluationMs: number;
  }>('ci-failure-progress-pinned.json');
  return {
    nowMs: pins.staleEvaluationMs,
    config: { progressFreshnessMs: pins.defaultProgressFreshnessMs },
  };
}

function tempStore() {
  return mkdtempSync(path.join(tmpdir(), 'ci-failure-progress-stale-'));
}

describe('ci-failure-progress-stale (Issue #439 AC#2)', () => {
  it('stale same-head fixing_ci escalates via progress_stale SEND path', () => {
    const emission = buildCiFailureProgressProofPayload('stale');
    expect(emission['ci-failure-progress-stale'].auditReason).toBe('progress_stale');
    console.log(JSON.stringify(emission));
  });

  it('positive-outcome: stale progress arms SEND instead of suppressed-live-worker', () => {
    const pins = fixture<{ defaultProgressFreshnessMs: number; staleEvaluationMs: number }>('ci-failure-progress-pinned.json');
    const result = decideCiFailureNotification({
      episode,
      workerState: captureWorkerState('live-worker-stale-same-head-fixing-ci.json'),
      nowMs: pins.staleEvaluationMs,
      config: { progressFreshnessMs: pins.defaultProgressFreshnessMs },
    });
    expect(result.terminal_action).toBe('SEND');
    expect(result.reason).not.toBe('suppressed-live-worker');
    expect(result.audit!.terminal_action).toBe('SEND');
  });

  it('preflight reconcile delivery persists progress_stale terminal audit', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'test' });
      const preflight = evaluatePreflightRevalidation({
        storeDir: dir,
        episode,
        workerState: captureWorkerState('live-worker-stale-same-head-fixing-ci.json'),
        ...staleProgressClock(),
      });
      expect(preflight.action).toBe('send_allowed');
      expect((preflight.decision as { reason?: string }).reason).toBe('progress_stale');
      reserveSubmitIntent({ storeDir: dir, episode });
      markSendDelivered({ storeDir: dir, episode });
      const resolved = resolveSubmittedDelivery({ storeDir: dir, episode, acknowledged: true });
      expect(resolved.terminalReason).toBe('progress_stale');
      const auditFiles = readdirSync(path.join(dir, 'audit')).filter((name) => name.endsWith('.json'));
      expect(auditFiles.some((name) => {
        const audit = JSON.parse(readFileSync(path.join(dir, 'audit', name), 'utf8'));
        return audit.reason === 'progress_stale'
          && audit.terminal_action === 'SEND'
          && audit.diagnostic?.progress_stale;
      })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
