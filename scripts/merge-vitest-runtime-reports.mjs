#!/usr/bin/env node
/**
 * Merge Vitest JSON reporter outputs for multi-invocation heavy shards.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const inputs = process.argv.slice(2, -1);
const output = process.argv.at(-1);

if (!output || inputs.length === 0) {
  console.error('usage: merge-vitest-runtime-reports.mjs <report.json>... <out.json>');
  process.exit(1);
}

const merged = {
  numTotalTestSuites: 0,
  numPassedTestSuites: 0,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numTotalTests: 0,
  numPassedTests: 0,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  success: true,
  testResults: [],
};

for (const input of inputs) {
  if (!existsSync(input)) {
    console.error(`[FAIL] missing vitest report: ${input}`);
    process.exit(1);
  }
  const payload = JSON.parse(readFileSync(input, 'utf8'));
  merged.numTotalTestSuites += Number(payload.numTotalTestSuites ?? 0);
  merged.numPassedTestSuites += Number(payload.numPassedTestSuites ?? 0);
  merged.numFailedTestSuites += Number(payload.numFailedTestSuites ?? 0);
  merged.numPendingTestSuites += Number(payload.numPendingTestSuites ?? 0);
  merged.numTotalTests += Number(payload.numTotalTests ?? 0);
  merged.numPassedTests += Number(payload.numPassedTests ?? 0);
  merged.numFailedTests += Number(payload.numFailedTests ?? 0);
  merged.numPendingTests += Number(payload.numPendingTests ?? 0);
  merged.numTodoTests += Number(payload.numTodoTests ?? 0);
  merged.success = merged.success && payload.success !== false;
  merged.testResults.push(...(payload.testResults ?? []));
}

writeFileSync(output, JSON.stringify(merged));
console.log(`[PASS] merged ${inputs.length} vitest report(s) -> ${output}`);
