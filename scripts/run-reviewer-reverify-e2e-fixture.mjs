#!/usr/bin/env node
/**
 * End-to-end reviewer-flow fixture for checkpoint-2 (Issue #376 AC#13).
 * Simulates the reviewer path: load trusted prompt + run reverify + surface summary.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatReviewerReverifySummary,
  runContractEvidenceReverify,
} from './lib/contract-evidence-reverify.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.join(here, '..');
const fixtureDir = path.join(packRoot, 'tests/fixtures/contract-evidence-reverify/e2e');

function load(name) {
  return readFileSync(path.join(fixtureDir, name), 'utf8');
}

const snapshotBody = load('issue-snapshot.md');
const prBody = load('pr-body.md');
const manifestPath = 'tests/fixtures/contract-evidence-reverify/capture-manifest.json';
const prompt = readFileSync(path.join(packRoot, 'prompts/codex_review_prompt.md'), 'utf8');

const reverify = runContractEvidenceReverify({
  repoRoot: packRoot,
  trustedBaseRoot: packRoot,
  reviewTargetRoot: packRoot,
  manifestPath,
  boundSnapshotBody: snapshotBody,
  prBody,
  explicitIssueNumber: 376,
  prHeadSha: 'e2e-fixture-head',
});

const summary = formatReviewerReverifySummary(reverify);

const output = {
  promptContainsCheckpoint2: prompt.includes('Checkpoint-2 contract-evidence re-verification'),
  promptContainsInvokeScript: prompt.includes('invoke-contract-evidence-reverify.ps1'),
  reverifyRunOutcome: reverify.runOutcome,
  reverifyRows: reverify.rows.map((row) => ({
    status: row.status,
    verificationMode: row.verificationMode,
    reason: row.reason ?? null,
  })),
  summaryIncludesRows: summary.includes('rows:'),
  summary,
};

const text = JSON.stringify(output, null, 2);
process.stdout.write(`${text}\n`);
const ok =
  output.promptContainsCheckpoint2
  && output.promptContainsInvokeScript
  && output.reverifyRunOutcome === 'rows-evaluated'
  && output.reverifyRows.some((row) => row.status === 'verified' || row.status === 'divergent' || row.status === 'unverified');
process.exit(ok ? 0 : 1);
