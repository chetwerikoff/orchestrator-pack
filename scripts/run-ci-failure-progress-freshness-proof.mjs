#!/usr/bin/env node
/**
 * Independent producer for Issue #439 AC#1 contract-evidence proof.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideCiFailureNotification } from '../docs/ci-failure-notification.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'scripts/fixtures/ci-failure-notification/ci-failure-progress-pinned.json'),
    'utf8',
  ),
);
const scenario = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'scripts/fixtures/ci-failure-notification/live-worker-fixing-ci-captured.json'),
    'utf8',
  ),
);
const base = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'scripts/fixtures/ci-failure-notification/ci-failure-worker-state-base.json'),
    'utf8',
  ),
);

const episode = {
  repo: 'chetwerikoff/orchestrator-pack',
  prNumber: 283,
  headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  redPeriod: 'suite-100-attempt-1',
  targetId: 'session-active-redacted',
  targetGeneration: 'generation-active-redacted',
};

const workerState = {
  sessions: [
    {
      ...base.sessionShell,
      status: scenario.status,
      lastActivity: scenario.lastActivity ?? base.sessionShell.lastActivity,
      targetGeneration: episode.targetGeneration,
      sessionGeneration: episode.targetGeneration,
      reports: scenario.reports,
    },
  ],
  openPrs: base.openPrs,
};

const decision = decideCiFailureNotification({
  episode,
  workerState,
  nowMs: pins.freshEvaluationMs,
  config: { progressFreshnessMs: pins.defaultProgressFreshnessMs },
});

const payload = {
  'ci-failure-progress-freshness': {
    freshDecision: decision.reason,
  },
};

process.stdout.write(`${JSON.stringify(payload)}\n`);
