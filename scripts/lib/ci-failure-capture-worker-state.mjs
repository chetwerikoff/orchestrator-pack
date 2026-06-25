import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultFixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'ci-failure-notification',
);

function loadJson(fixtureDir, name) {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));
}

/**
 * @param {string} scenarioFixture
 * @param {{ targetGeneration: string }} episode
 * @param {string} [fixtureDir]
 */
export function buildCaptureWorkerState(scenarioFixture, episode, fixtureDir = defaultFixtureDir) {
  const base = loadJson(fixtureDir, 'ci-failure-worker-state-base.json');
  const scenario = loadJson(fixtureDir, scenarioFixture);
  const openPrs = base.openPrs.map((row) => ({
    ...row,
    ...(scenario.openPrHeadSha ? { headRefOid: scenario.openPrHeadSha } : {}),
    ...(scenario.openPrHeadCommittedAt ? { headCommittedAt: scenario.openPrHeadCommittedAt } : {}),
  }));
  return {
    sessions: [
      {
        ...base.sessionShell,
        status: scenario.status,
        lastActivity: scenario.lastActivity ?? base.sessionShell.lastActivity,
        targetGeneration: episode.targetGeneration,
        sessionGeneration: episode.targetGeneration,
        ownedHeadSha: scenario.openPrHeadSha ?? base.sessionShell.ownedHeadSha,
        reports: scenario.reports,
      },
    ],
    openPrs,
  };
}
