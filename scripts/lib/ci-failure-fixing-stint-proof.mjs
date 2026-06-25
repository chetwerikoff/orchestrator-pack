import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCiFailureSuppressorDecision } from '../../docs/ci-failure-notification.mjs';
import { buildCaptureWorkerState } from './ci-failure-capture-worker-state.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureDir = path.join(repoRoot, 'scripts/fixtures/ci-failure-notification');

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));
}

const H2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function buildEpisode() {
  return {
    repo: 'chetwerikoff/orchestrator-pack',
    prNumber: 283,
    headSha: H2,
    redPeriod: 'suite-200-attempt-1',
    targetId: 'session-active-redacted',
    targetGeneration: 'generation-active-redacted',
  };
}

export function buildCiFailureFixingStintProofPayload() {
  const pins = loadJson('ci-failure-progress-pinned.json');
  const decision = evaluateCiFailureSuppressorDecision({
    episode: buildEpisode(),
    workerState: buildCaptureWorkerState(
      'live-worker-cross-head-h2-bridge.json',
      buildEpisode(),
      fixtureDir,
    ),
    surface: 'orchestrator-turn',
    nowMs: pins.freshEvaluationMs,
    config: { progressFreshnessMs: pins.defaultProgressFreshnessMs },
  });

  return {
    'ci-failure-fixing-stint': {
      suppressReason: decision.audit?.suppressReason ?? decision.reason,
    },
  };
}
