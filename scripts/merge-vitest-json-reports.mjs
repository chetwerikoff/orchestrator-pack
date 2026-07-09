#!/usr/bin/env node
/**
 * Merge Vitest JSON reporter outputs into one aggregate report (Issue #683 / #556).
 * Used when heavy shards run one file per invocation to avoid birpc onTaskUpdate timeouts.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const outputPath = process.argv[2];
const inputPaths = process.argv.slice(3);

if (!outputPath || inputPaths.length === 0) {
  console.error('usage: merge-vitest-json-reports.mjs <output.json> <input.json>...');
  process.exit(1);
}

function loadReport(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function mergeReports(reports) {
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
    snapshot: {
      added: 0,
      failure: false,
      filesAdded: 0,
      filesRemoved: 0,
      filesRemovedList: [],
      filesUnmatched: 0,
      filesUpdated: 0,
      matched: 0,
      total: 0,
      unchecked: 0,
      uncheckedKeysByFile: [],
      unmatched: 0,
      updated: 0,
      didUpdate: false,
    },
    startTime: Number.POSITIVE_INFINITY,
    success: true,
    testResults: [],
  };

  for (const report of reports) {
    merged.numTotalTestSuites += Number(report.numTotalTestSuites ?? 0);
    merged.numPassedTestSuites += Number(report.numPassedTestSuites ?? 0);
    merged.numFailedTestSuites += Number(report.numFailedTestSuites ?? 0);
    merged.numPendingTestSuites += Number(report.numPendingTestSuites ?? 0);
    merged.numTotalTests += Number(report.numTotalTests ?? 0);
    merged.numPassedTests += Number(report.numPassedTests ?? 0);
    merged.numFailedTests += Number(report.numFailedTests ?? 0);
    merged.numPendingTests += Number(report.numPendingTests ?? 0);
    merged.numTodoTests += Number(report.numTodoTests ?? 0);
    merged.success = merged.success && report.success !== false;
    if (Array.isArray(report.testResults)) {
      merged.testResults.push(...report.testResults);
    }
    const start = Number(report.startTime);
    if (Number.isFinite(start) && start < merged.startTime) {
      merged.startTime = start;
    }
  }

  if (!Number.isFinite(merged.startTime)) {
    merged.startTime = Date.now();
  }

  return merged;
}

const reports = inputPaths.map(loadReport);
const merged = mergeReports(reports);
writeFileSync(outputPath, `${JSON.stringify(merged)}\n`, 'utf8');
console.log(
  `[PASS] merged ${inputPaths.length} vitest report(s) -> ${outputPath} (${merged.numTotalTests} tests)`,
);
