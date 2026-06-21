#!/usr/bin/env node
/**
 * End-to-end reviewer-flow fixture for checkpoint-2 (Issue #376 AC#13).
 * Exercises the AO review --execute --command path (mechanical fallback in CI).
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

const reviewCommand = `pwsh -NoProfile -File scripts/run-reviewer-reverify-ao-review-command.ps1 -RepoRoot . -FixtureDir tests/fixtures/contract-evidence-reverify/e2e`;

function resolveAoFixtureSession() {
  const envSession = process.env.OPK_REVERIFY_E2E_SESSION?.trim();
  if (envSession) {
    return envSession;
  }

  const listed = spawnSync('ao', ['session', 'ls'], {
    cwd: packRoot,
    encoding: 'utf8',
  });
  if (listed.status !== 0) {
    return null;
  }

  const lines = listed.stdout.split('\n');
  for (const line of lines) {
    const match = line.match(/^\s+(opk-\S+)/);
    if (!match) {
      continue;
    }
    const sessionId = match[1];
    if (sessionId === preferredSessionId) {
      return sessionId;
    }
  }

  const firstWorker = lines
    .map((line) => line.match(/^\s+(opk-\S+)/)?.[1])
    .find(Boolean);
  return firstWorker ?? null;
}

function runReviewCommand() {
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
    ],
    {
      cwd: packRoot,
      encoding: 'utf8',
    },
  );
}

function runAoReviewExecute(sessionId) {
  return spawnSync(
    'ao',
    ['review', 'run', sessionId, '--execute', '--command', reviewCommand],
    {
      cwd: packRoot,
      encoding: 'utf8',
    },
  );
}

const prompt = readFileSync(path.join(packRoot, 'prompts/codex_review_prompt.md'), 'utf8');
const aoAvailable = spawnSync('which', ['ao']).status === 0;
const sessionId = aoAvailable ? resolveAoFixtureSession() : null;

let viaAo = false;
let commandProc = runReviewCommand();
if (aoAvailable && sessionId && process.env.OPK_REVERIFY_E2E_SKIP_AO !== '1') {
  const aoProc = runAoReviewExecute(sessionId);
  if (aoProc.status === 0) {
    viaAo = true;
  } else if (commandProc.status !== 0) {
    commandProc = aoProc;
  }
}

const summary = commandProc.stdout.trim();
const output = {
  viaAoReviewExecute: viaAo,
  aoSessionId: sessionId,
  promptContainsCheckpoint2: prompt.includes('Checkpoint-2 contract-evidence re-verification'),
  promptContainsInvokeScript: prompt.includes('invoke-contract-evidence-reverify.ps1'),
  summaryIncludesRows: summary.includes('rows:'),
  summaryIncludesNeverBlocks: summary.includes('never-blocks: true'),
  summary,
};

const text = JSON.stringify(output, null, 2);
process.stdout.write(`${text}\n`);

const ok =
  commandProc.status === 0
  && output.promptContainsCheckpoint2
  && output.promptContainsInvokeScript
  && output.summaryIncludesRows
  && output.summaryIncludesNeverBlocks;

process.exit(ok ? 0 : 1);
