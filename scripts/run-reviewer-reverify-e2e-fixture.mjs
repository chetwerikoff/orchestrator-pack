#!/usr/bin/env node
/**
 * End-to-end reviewer-flow fixture for checkpoint-2 (Issue #376 AC#13).
 * Requires the AO --execute reviewer path; mechanical-only runs do not pass.
 *
 * Operator gate (prevents verify/vitest from spawning junk workers):
 *   OPK_REVERIFY_E2E_LIVE=1            — run the live AO path
 *   OPK_REVERIFY_E2E_SESSION=<id>      — reuse an existing worker (preferred)
 *   OPK_REVERIFY_E2E_ALLOW_SPAWN=1     — optional: spawn one fixture holder when live
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.join(here, '..');
const fixtureDir = path.join(packRoot, 'tests/fixtures/contract-evidence-reverify/e2e');
const fixtureSessionFile = path.join(fixtureDir, 'fixture-session-id.txt');
const preferredSessionId = existsSync(fixtureSessionFile)
  ? readFileSync(fixtureSessionFile, 'utf8').trim()
  : 'opk-reverify-e2e';

const FIXTURE_PROMPT = 'checkpoint-2 contract-evidence reverify e2e fixture holder';

function isTruthyEnv(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function isLiveE2eEnabled() {
  return isTruthyEnv('OPK_REVERIFY_E2E_LIVE');
}

function isCheckpoint2ReviewerSummary(text) {
  const trimmed = text.trim();
  return trimmed.includes('## Checkpoint-2 contract-evidence re-verification')
    && trimmed.includes('run-outcome:')
    && trimmed.includes('never-blocks: true')
    && trimmed.includes('rows:');
}

function listAoSessions() {
  const listed = spawnSync('ao', ['session', 'ls'], {
    cwd: packRoot,
    encoding: 'utf8',
  });
  if (listed.status !== 0) {
    return [];
  }
  return listed.stdout
    .split('\n')
    .map((line) => line.match(/^\s+(opk-\S+)/)?.[1])
    .filter(Boolean);
}

function spawnEphemeralFixtureSession() {
  const spawned = spawnSync(
    'ao',
    ['spawn', '--prompt', FIXTURE_PROMPT],
    {
      cwd: packRoot,
      encoding: 'utf8',
    },
  );
  if (spawned.status !== 0) {
    return null;
  }
  const match = spawned.stdout.match(/SESSION=(opk-\S+)/);
  return match?.[1] ?? null;
}

function resolveAoFixtureSession() {
  const envSession = process.env.OPK_REVERIFY_E2E_SESSION?.trim();
  if (envSession) {
    return envSession;
  }

  if (!isLiveE2eEnabled()) {
    return null;
  }

  const knownSessions = listAoSessions();
  if (knownSessions.includes(preferredSessionId)) {
    return preferredSessionId;
  }
  if (knownSessions.length > 0) {
    return knownSessions[0];
  }

  if (isTruthyEnv('OPK_REVERIFY_E2E_ALLOW_SPAWN')) {
    return spawnEphemeralFixtureSession();
  }

  return null;
}

function runAoReviewExecute(sessionId) {
  return spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      'scripts/run-reviewer-reverify-ao-review-command.ps1',
      '-RepoRoot',
      packRoot,
      '-FixtureDir',
      'tests/fixtures/contract-evidence-reverify/e2e',
      '-AoSessionId',
      sessionId,
    ],
    {
      cwd: packRoot,
      encoding: 'utf8',
    },
  );
}

const prompt = readFileSync(path.join(packRoot, 'prompts/codex_review_prompt.md'), 'utf8');

const output = {
  skipped: false,
  viaAoReviewExecute: false,
  aoAvailable: false,
  aoSessionId: null,
  aoSessionIsDedicatedFixture: false,
  promptContainsCheckpoint2: prompt.includes('Checkpoint-2 contract-evidence re-verification'),
  promptContainsInvokeScript: prompt.includes('invoke-contract-evidence-reverify.ps1'),
  summaryIncludesRows: false,
  summaryIncludesNeverBlocks: false,
  reviewerOutputIsCheckpoint2Summary: false,
  summary: '',
  error: null,
};

if (!isLiveE2eEnabled() && !process.env.OPK_REVERIFY_E2E_SESSION?.trim()) {
  output.skipped = true;
  output.error = null;
  output.summary = 'skipped: set OPK_REVERIFY_E2E_LIVE=1 (and OPK_REVERIFY_E2E_SESSION or OPK_REVERIFY_E2E_ALLOW_SPAWN=1) for live AC#13 e2e';
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(0);
}

const aoAvailable = spawnSync('which', ['ao']).status === 0;
output.aoAvailable = aoAvailable;

if (!aoAvailable) {
  output.error = 'ao CLI is required for AC#13 end-to-end reviewer-flow fixture';
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(1);
}

const sessionId = resolveAoFixtureSession();
output.aoSessionId = sessionId;
output.aoSessionIsDedicatedFixture = sessionId === preferredSessionId
  || Boolean(process.env.OPK_REVERIFY_E2E_SESSION?.trim());

if (!sessionId) {
  output.error = 'unable to resolve AO fixture session: set OPK_REVERIFY_E2E_SESSION, start a live worker, or set OPK_REVERIFY_E2E_ALLOW_SPAWN=1';
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(1);
}

const aoProc = runAoReviewExecute(sessionId);
output.viaAoReviewExecute = aoProc.status === 0;

if (!output.viaAoReviewExecute) {
  output.error = `AO --execute reviewer path failed (exit ${aoProc.status ?? 'null'})`;
  output.summary = (aoProc.stdout ?? '').trim();
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(1);
}

const summary = (aoProc.stdout ?? '').trim();
output.summary = summary;
output.summaryIncludesRows = summary.includes('rows:');
output.summaryIncludesNeverBlocks = summary.includes('never-blocks: true');
output.reviewerOutputIsCheckpoint2Summary = isCheckpoint2ReviewerSummary(summary);

const ok =
  output.promptContainsCheckpoint2
  && output.promptContainsInvokeScript
  && output.summaryIncludesRows
  && output.summaryIncludesNeverBlocks
  && output.reviewerOutputIsCheckpoint2Summary
  && !summary.includes('reverify-e2e-probe');

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.exit(ok ? 0 : 1);
