#!/usr/bin/env node
/**
 * End-to-end reviewer-flow fixture for checkpoint-2 (Issue #376 AC#13).
 * Requires the AO --execute reviewer path; mechanical-only runs do not pass.
 *
 * Operator gate (prevents verify/vitest from spawning junk workers):
 *   OPK_REVERIFY_E2E_LIVE=1            — run the live AO path
 *   OPK_REVERIFY_E2E_SESSION=<id>      — reuse an existing worker (preferred)
 *   OPK_REVERIFY_E2E_ALLOW_SPAWN=1     — optional: spawn one fixture holder when live
 *   OPK_REVERIFY_E2E_ALLOW_SKIP=1      — local opt-out when AO is unavailable (not for acceptance)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  FIXTURE_HOLDER_PROMPT,
  claimOrSpawnFixtureHolder,
  isDedicatedFixtureHolderBranch,
  listAoSessionRecordsFromOutputs,
  resolveAoFixtureSessionId,
  sessionOwnsRealPr,
} from './lib/reverify-e2e-fixture-session.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.join(here, '..');
const fixtureDir = path.join(packRoot, 'tests/fixtures/contract-evidence-reverify/e2e');
const fixtureSessionFile = path.join(fixtureDir, 'fixture-session-id.txt');
const fixtureClaimFile = path.join(fixtureDir, 'fixture-holder.claim');
const preferredSessionId = existsSync(fixtureSessionFile)
  ? readFileSync(fixtureSessionFile, 'utf8').trim()
  : 'opk-reverify-e2e';

function isTruthyEnv(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function isAc13E2eRequired() {
  return isTruthyEnv('OPK_REVERIFY_E2E_REQUIRED');
}

function isAc13E2eAllowSkip() {
  return isTruthyEnv('OPK_REVERIFY_E2E_ALLOW_SKIP');
}

function isLiveE2eEnabled() {
  return isTruthyEnv('OPK_REVERIFY_E2E_LIVE');
}

function ac13E2eEnv(overrides = {}) {
  return {
    ...process.env,
    OPK_REVERIFY_E2E_REQUIRED: '1',
    ...overrides,
  };
}

function summaryRunOutcomeRowsEvaluated(text) {
  return /run-outcome:\s*rows-evaluated/.test(text);
}

function summaryHasEvaluatedRowEntries(text) {
  if (/rows:\s*none/i.test(text)) {
    return false;
  }
  if (/run-outcome:\s*check-error/i.test(text)) {
    return false;
  }
  return /^- #\d+\s+status=/m.test(text);
}

function isCheckpoint2ReviewerSummary(text) {
  const trimmed = text.trim();
  return trimmed.includes('## Checkpoint-2 contract-evidence re-verification')
    && summaryRunOutcomeRowsEvaluated(trimmed)
    && trimmed.includes('never-blocks: true')
    && summaryHasEvaluatedRowEntries(trimmed);
}

function listAoSessions() {
  const jsonListed = spawnSync('ao', ['session', 'ls', '--json'], {
    cwd: packRoot,
    encoding: 'utf8',
  });
  const textListed = spawnSync('ao', ['session', 'ls'], {
    cwd: packRoot,
    encoding: 'utf8',
  });
  if (jsonListed.status !== 0 && textListed.status !== 0) {
    return [];
  }
  return listAoSessionRecordsFromOutputs({
    jsonStdout: jsonListed.status === 0 ? jsonListed.stdout : '',
    textStdout: textListed.status === 0 ? textListed.stdout : '',
  });
}

function spawnEphemeralFixtureSession() {
  const spawned = spawnSync(
    'ao',
    ['spawn', '--prompt', FIXTURE_HOLDER_PROMPT],
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
  const knownSessions = listAoSessions();
  return resolveAoFixtureSessionId({
    envSession: process.env.OPK_REVERIFY_E2E_SESSION,
    liveE2eEnabled: isLiveE2eEnabled(),
    preferredSessionId,
    knownSessions,
    allowSpawn: isTruthyEnv('OPK_REVERIFY_E2E_ALLOW_SPAWN'),
    spawnSession: spawnEphemeralFixtureSession,
    claimSpawn: (spawnSession, sessions) => claimOrSpawnFixtureHolder({
      claimPath: fixtureClaimFile,
      knownSessions: sessions,
      spawnSession,
    }),
  });
}

function parseAoReviewRunJson(stdout) {
  const jsonStart = stdout.indexOf('{');
  if (jsonStart < 0) {
    return null;
  }
  try {
    const payload = JSON.parse(stdout.slice(jsonStart));
    return payload?.run ?? null;
  } catch {
    return null;
  }
}

function resolveAoFindingsDir() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const base = process.env.AO_BASE_DIR?.trim() || path.join(home, '.agent-orchestrator');
  const projectId = process.env.AO_PROJECT_ID?.trim()
    || process.env.AO_PROJECT?.trim()
    || 'orchestrator-pack';
  return path.join(base, 'projects', projectId, 'code-reviews', 'findings');
}

function loadReviewFindingsForRun(runId) {
  if (!runId) {
    return [];
  }
  const findingsDir = resolveAoFindingsDir();
  if (!existsSync(findingsDir)) {
    return [];
  }
  const findings = [];
  for (const entry of readdirSync(findingsDir)) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const filePath = path.join(findingsDir, entry);
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      if (parsed?.runId === runId) {
        findings.push(parsed);
      }
    } catch {
      // ignore malformed finding records
    }
  }
  return findings;
}

function extractCheckpoint2SummaryFromText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    return '';
  }
  if (isCheckpoint2ReviewerSummary(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(/## Checkpoint-2 contract-evidence re-verification[\s\S]*/);
  if (match && isCheckpoint2ReviewerSummary(match[0])) {
    return match[0].trim();
  }
  return '';
}

function extractCheckpoint2SummaryFromAoReviewInvocation({ aoProc, run }) {
  const stdout = aoProc.stdout ?? '';
  const jsonStart = stdout.indexOf('{');
  const preJson = jsonStart > 0 ? stdout.slice(0, jsonStart) : '';
  const findingBodies = loadReviewFindingsForRun(run?.id).map((finding) => finding?.body ?? '');
  const candidates = [preJson, ...findingBodies, aoProc.stderr ?? ''];
  for (const candidate of candidates) {
    const summary = extractCheckpoint2SummaryFromText(candidate);
    if (summary) {
      return summary;
    }
  }
  return '';
}

function aoReviewExecuteFailed({ aoProc, run }) {
  if (aoProc.status !== 0) {
    return true;
  }
  if (!run) {
    return true;
  }
  if (run.status === 'failed') {
    return true;
  }
  if (typeof run.terminationReason === 'string' && /Command failed:/i.test(run.terminationReason)) {
    return true;
  }
  return false;
}

function runAoReviewExecute(sessionId) {
  const scriptPath = path.join(packRoot, 'scripts/run-reviewer-reverify-ao-review-command.ps1');
  const mechanicalCommand = [
    'pwsh',
    '-NoProfile',
    '-File',
    scriptPath,
    '-RepoRoot',
    packRoot,
    '-FixtureDir',
    'tests/fixtures/contract-evidence-reverify/e2e',
    '-ManifestPath',
    'tests/fixtures/contract-evidence-reverify/capture-manifest.json',
    '-ExplicitIssue',
    '376',
  ].join(' ');

  const aoProc = spawnSync(
    'ao',
    ['review', 'run', sessionId, '--execute', '--command', mechanicalCommand, '--json'],
    {
      cwd: packRoot,
      encoding: 'utf8',
      env: ac13E2eEnv(),
    },
  );
  const run = parseAoReviewRunJson(aoProc.stdout ?? '');
  return { aoProc, run };
}

function finalizeReviewerSummary(output, summary) {
  output.summary = summary;
  output.summaryRunOutcomeRowsEvaluated = summaryRunOutcomeRowsEvaluated(summary);
  output.summaryIncludesRows = summaryHasEvaluatedRowEntries(summary);
  output.summaryIncludesNeverBlocks = summary.includes('never-blocks: true');
  output.reviewerOutputIsCheckpoint2Summary = isCheckpoint2ReviewerSummary(summary);
  output.aoReviewOutputIsCheckpoint2Summary = output.reviewerOutputIsCheckpoint2Summary;

  const ok =
    output.promptContainsCheckpoint2
    && output.promptContainsInvokeScript
    && output.viaAoReviewExecute
    && output.aoReviewOutputIsCheckpoint2Summary
    && output.summaryRunOutcomeRowsEvaluated
    && output.summaryIncludesRows
    && output.summaryIncludesNeverBlocks
    && output.reviewerOutputIsCheckpoint2Summary
    && !summary.includes('reverify-e2e-probe');

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

const prompt = readFileSync(path.join(packRoot, 'prompts/codex_review_prompt.md'), 'utf8');

const output = {
  skipped: false,
  viaAoReviewExecute: false,
  viaMechanicalReviewerCommand: false,
  aoReviewRunId: null,
  aoReviewOutputIsCheckpoint2Summary: false,
  aoAvailable: false,
  aoSessionId: null,
  aoSessionIsDedicatedFixture: false,
  promptContainsCheckpoint2: prompt.includes('Checkpoint-2 contract-evidence re-verification'),
  promptContainsInvokeScript: prompt.includes('launch-contract-evidence-reverify.ps1'),
  summaryIncludesRows: false,
  summaryRunOutcomeRowsEvaluated: false,
  summaryIncludesNeverBlocks: false,
  reviewerOutputIsCheckpoint2Summary: false,
  summary: '',
  error: null,
};

if (!isLiveE2eEnabled() && !process.env.OPK_REVERIFY_E2E_SESSION?.trim()) {
  if (isAc13E2eAllowSkip() && !isAc13E2eRequired()) {
    output.skipped = true;
    output.error = null;
    output.summary = 'skipped: set OPK_REVERIFY_E2E_LIVE=1 (and OPK_REVERIFY_E2E_SESSION or OPK_REVERIFY_E2E_ALLOW_SPAWN=1) for live AC#13 e2e';
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exit(0);
  }

  output.skipped = true;
  output.error = 'AC#13 reviewer-flow e2e required: set OPK_REVERIFY_E2E_LIVE=1 and OPK_REVERIFY_E2E_SESSION (or OPK_REVERIFY_E2E_ALLOW_SKIP=1 for local opt-out only when OPK_REVERIFY_E2E_REQUIRED is unset)';
  output.summary = output.error;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(1);
}

const aoAvailable = spawnSync('which', ['ao']).status === 0;
output.aoAvailable = aoAvailable;

if (!aoAvailable) {
  output.error = 'ao CLI is required for AC#13 end-to-end reviewer-flow fixture';
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(1);
}

const knownSessions = listAoSessions();
const sessionId = resolveAoFixtureSession();
output.aoSessionId = sessionId;
const sessionRecord = knownSessions.find((session) => session.id === sessionId);
output.aoSessionIsDedicatedFixture = sessionId === preferredSessionId
  || Boolean(process.env.OPK_REVERIFY_E2E_SESSION?.trim())
  || isDedicatedFixtureHolderBranch(sessionRecord?.branch);

if (!sessionId) {
  const onlyRealPrWorkers = knownSessions.length > 0
    && knownSessions.every((session) => sessionOwnsRealPr(session) || !isDedicatedFixtureHolderBranch(session.branch));
  output.error = onlyRealPrWorkers
    ? 'unable to resolve AO fixture session: only real-PR workers are live; set OPK_REVERIFY_E2E_SESSION to a dedicated fixture holder or OPK_REVERIFY_E2E_ALLOW_SPAWN=1'
    : 'unable to resolve AO fixture session: set OPK_REVERIFY_E2E_SESSION, reuse a dedicated fixture holder, or set OPK_REVERIFY_E2E_ALLOW_SPAWN=1';
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(1);
}

const { aoProc, run: aoReviewRun } = runAoReviewExecute(sessionId);
output.aoReviewRunId = aoReviewRun?.id ?? null;
output.viaAoReviewExecute = !aoReviewExecuteFailed({ aoProc, run: aoReviewRun });

if (!output.viaAoReviewExecute) {
  const detail = aoReviewRun?.terminationReason
    ?? aoReviewRun?.status
    ?? `exit ${aoProc.status ?? 'null'}`;
  output.error = `AO --execute reviewer path failed (${detail})`;
  output.summary = (aoProc.stdout ?? '').trim();
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(1);
}

const aoReviewSummary = extractCheckpoint2SummaryFromAoReviewInvocation({
  aoProc,
  run: aoReviewRun,
});
output.aoReviewOutputIsCheckpoint2Summary = isCheckpoint2ReviewerSummary(aoReviewSummary);

if (!output.aoReviewOutputIsCheckpoint2Summary) {
  output.error = 'AO --execute reviewer path did not surface checkpoint-2 rows in review output';
  output.summary = aoReviewSummary || (aoProc.stdout ?? '').trim();
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(1);
}

finalizeReviewerSummary(output, aoReviewSummary);
