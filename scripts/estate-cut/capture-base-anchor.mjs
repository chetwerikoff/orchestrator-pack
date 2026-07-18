#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from '../kernel/subprocess.mjs';

const SCRIPT = 'scripts/estate-cut/capture-base-anchor.mjs';
const OUTPUT = 'scripts/estate-cut/issue-906.base-anchor.json';
const CONFIG = 'scripts/estate-cut/issue-906.config.json';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = JSON.parse(readFileSync(path.join(repoRoot, CONFIG), 'utf8'));

const KEEP_CORE_PATHS = [
  'agent-orchestrator.yaml.example',
  'scripts/pack-review-runner.ts',
  'scripts/pack-review-runner.js',
  'scripts/invoke-pack-review.ps1',
  'scripts/lib/pack-review-run-store.ts',
  'scripts/lib/pack-review-run-store.js',
  'scripts/lib/pack-review-delivery.ts',
  'scripts/lib/pack-review-delivery.js',
  'scripts/lib/github-review-reconciliation.ts',
  'scripts/lib/github-review-reconciliation.js',
  'scripts/lib/Review-StartClaim.ps1',
  'scripts/review-start-claim-reaper.ps1',
  'scripts/lib/Orchestrator-Escalation.ps1',
  'scripts/orchestrator-escalation-router.ps1',
  'scripts/gh',
  'scripts/lib/gh-wrapper.mjs',
  'scripts/lib/gh-governor.mjs',
  'docs/github-fleet-governor.mjs',
  'docs/pr-session-binding-cache.mjs',
  'docs/json-state-file-lock.mjs',
  'docs/session-pr-binding-resolver.mjs',
  'scripts/orchestrator-wake-supervisor.ps1',
  'docs/review-producer-contract.mjs',
  'docs/review-head-ready.mjs',
  'docs/review-trigger-reconcile.mjs',
  'scripts/review-trigger-reconcile.ps1',
  'scripts/review-trigger-reeval.ps1',
  'scripts/review-ready-report-state-seed.ps1',
];

const KEEP_CORE_TESTS = [
  'scripts/gate-runner/bulk-declarative-gates.test.ts',
  'scripts/gate-runner/census-generator.test.ts',
  'scripts/gate-runner/contracts.test.ts',
  'scripts/gate-runner/custom/ao-capture-redaction.test.ts',
  'scripts/gate-runner/custom/bulk-cli-parity.test.ts',
  'scripts/gate-runner/custom/bulk-static-gates.test.ts',
  'scripts/gate-runner/custom/node-backed-gates.test.ts',
  'scripts/gate-runner/declarative.test.ts',
  'scripts/gate-runner/goldens.test.ts',
  'scripts/gate-runner/registry.test.ts',
  'scripts/gate-runner/runner.test.ts',
  'scripts/kernel/json-artifact.test.ts',
  'scripts/kernel/json-contract.test.ts',
  'scripts/kernel/subprocess.test.ts',
  'scripts/pack-review-runner-severity.test.ts',
  'scripts/review-delivery.test.ts',
  'scripts/review-head-ready.test.ts',
  'scripts/review-wake-trigger.test.ts',
  'scripts/pr-session-binding-cache.test.ts',
  'scripts/session-pr-binding-resolver.test.ts',
  'scripts/review-start-claim-budget-semantics.test.ts',
  'scripts/review-start-claim-lifecycle.test.ts',
  'scripts/review-start-claim-run-binding.test.ts',
  'scripts/review-start-claim.test.ts',
  'scripts/review-trigger-reconcile.test.ts',
  'scripts/review-trigger-reeval.test.ts',
  'scripts/worker-message-submit-reconcile.test.ts',
  'scripts/orchestrator-escalation-router.test.ts',
  'scripts/orchestrator-escalation.test.ts',
  'scripts/gh-wrapper.test.ts',
];

const ROOT_MEMBERSHIP = {
  'target-review-cycle': [
    'scripts/pack-review-runner.ts',
    'scripts/invoke-pack-review.ps1',
    'scripts/orchestrator-wake-supervisor.ps1',
    'scripts/review-trigger-reconcile.ps1',
    'scripts/review-trigger-reeval.ps1',
    'scripts/review-ready-report-state-seed.ps1',
    'docs/review-trigger-reconcile.mjs',
    'docs/review-head-ready.mjs',
    'docs/review-producer-contract.mjs',
  ],
  CI: [
    '.github/workflows/scope-guard.yml',
    '.github/workflows/typescript-foundation.yml',
    'scripts/verify.ps1',
    'scripts/check-reusable.ps1',
    'scripts/check-ci-cheap-wins.ps1',
    'scripts/check-ci-pipeline-split.ps1',
    'scripts/check-verify-runtime.ps1',
  ],
  'operator-recovery': [
    'scripts/orchestrator-wake-supervisor.ps1',
    'scripts/review-start-claim-reaper.ps1',
    'scripts/orchestrator-escalation-router.ps1',
    'docs/orchestrator-recovery-runbook.md',
    'docs/wake-supervisor-fleet-operator-reference.md',
  ],
  'safety-plugins': [
    'plugins/ao-scope-guard',
    'plugins/ao-codex-pr-reviewer',
  ],
};

function git(args) {
  const result = runProcessSync({ command: 'git', args, cwd: repoRoot, inheritParentEnv: true });
  if (!result.ok) throw new Error(result.stderr || result.error || `git ${args.join(' ')} failed`);
  return result.stdout;
}
function atBase(rel) {
  return Buffer.from(git(['show', `${config.baseCommitSha}:${rel}`]), 'utf8');
}
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
function existsAtBase(rel) {
  try { git(['cat-file', '-e', `${config.baseCommitSha}:${rel}`]); return true; } catch { return false; }
}

const protectedPaths = [...new Set([...KEEP_CORE_PATHS, ...KEEP_CORE_TESTS])].sort();
const missing = protectedPaths.filter((rel) => !existsAtBase(rel));
if (missing.length > 0) throw new Error(`anchor paths absent at base: ${missing.join(', ')}`);
const anchor = {
  schemaVersion: 1,
  issue: 906,
  generatedBy: SCRIPT,
  baseCommitSha: config.baseCommitSha,
  keepCategories: config.keepCategories,
  rootMembership: Object.fromEntries(Object.entries(ROOT_MEMBERSHIP).map(([key, values]) => [key, [...values].sort()])),
  protectedPaths: protectedPaths.map((rel) => ({ path: rel, sha256: sha256(atBase(rel)) })),
  keepCoreTests: [...KEEP_CORE_TESTS].sort(),
};
writeFileSync(path.join(repoRoot, OUTPUT), `${JSON.stringify(anchor, null, 2)}\n`);
console.log(`${OUTPUT}: ${anchor.protectedPaths.length} protected paths, ${anchor.keepCoreTests.length} keep-core tests`);
