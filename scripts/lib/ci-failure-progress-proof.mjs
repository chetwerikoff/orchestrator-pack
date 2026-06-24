import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideCiFailureNotification } from '../../docs/ci-failure-notification.mjs';
import { buildCaptureWorkerState } from './ci-failure-capture-worker-state.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureDir = path.join(repoRoot, 'scripts/fixtures/ci-failure-notification');

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));
}

function buildEpisode() {
  return {
    repo: 'chetwerikoff/orchestrator-pack',
    prNumber: 283,
    headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    redPeriod: 'suite-100-attempt-1',
    targetId: 'session-active-redacted',
    targetGeneration: 'generation-active-redacted',
  };
}

/**
 * @param {'freshness' | 'stale'} mode
 */
export function buildCiFailureProgressProofPayload(mode) {
  const pins = loadJson('ci-failure-progress-pinned.json');
  const scenarioFixture = mode === 'freshness'
    ? 'live-worker-fixing-ci-captured.json'
    : 'live-worker-stale-same-head-fixing-ci.json';
  const decision = decideCiFailureNotification({
    episode: buildEpisode(),
    workerState: buildCaptureWorkerState(scenarioFixture, buildEpisode(), fixtureDir),
    nowMs: mode === 'freshness' ? pins.freshEvaluationMs : pins.staleEvaluationMs,
    config: { progressFreshnessMs: pins.defaultProgressFreshnessMs },
  });

  return mode === 'freshness'
    ? { 'ci-failure-progress-freshness': { freshDecision: decision.reason } }
    : { 'ci-failure-progress-stale': { auditReason: decision.audit?.reason ?? decision.reason } };
}

/**
 * @param {'freshness' | 'stale'} mode
 */
export function emitCiFailureProgressProof(mode) {
  process.stdout.write(`${JSON.stringify(buildCiFailureProgressProofPayload(mode))}\n`);
}
