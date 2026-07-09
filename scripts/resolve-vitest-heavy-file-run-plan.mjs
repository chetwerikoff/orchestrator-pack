#!/usr/bin/env node
import {
  loadLanesConfig,
  loadRuntimeHistory,
  resolveHeavyFileRunPlan,
  resolveRepoRoot,
} from './lib/vitest-ci-lanes.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: resolve-vitest-heavy-file-run-plan.mjs <vitest-file>');
  process.exit(1);
}

const repoRoot = resolveRepoRoot();
const config = loadLanesConfig(repoRoot);
const runtimeHistory = loadRuntimeHistory(repoRoot);
const plan = resolveHeavyFileRunPlan(file, config, runtimeHistory, repoRoot);
if (plan.mode === 'tests' && plan.tests.length === 0) {
  console.error(`no tests enumerated for per-test isolate file: ${file}`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(plan)}\n`);
