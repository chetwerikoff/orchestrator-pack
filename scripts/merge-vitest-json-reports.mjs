#!/usr/bin/env node
/**
 * Merge Vitest JSON reporter outputs from serial per-file CI runs (Issue #695).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , outPath, ...reportPaths] = process.argv;

if (!outPath || reportPaths.length === 0) {
  process.stderr.write('usage: merge-vitest-json-reports.mjs <outPath> <reportPath>...\n');
  process.exit(2);
}

/** @param {string} path */
function loadReport(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** @param {Record<string, unknown>} target */
function addCounts(target, source) {
  for (const key of [
    'numTotalTestSuites',
    'numPassedTestSuites',
    'numFailedTestSuites',
    'numPendingTestSuites',
    'numTotalTests',
    'numPassedTests',
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
  ]) {
    target[key] = Number(target[key] ?? 0) + Number(source[key] ?? 0);
  }
}

const reports = reportPaths.map(loadReport);
const merged = {
  ...reports[0],
  startTime: Math.min(...reports.map((report) => Number(report.startTime ?? 0))),
  success: reports.every((report) => report.success !== false),
  testResults: [],
};

for (const key of [
  'numTotalTestSuites',
  'numPassedTestSuites',
  'numFailedTestSuites',
  'numPendingTestSuites',
  'numTotalTests',
  'numPassedTests',
  'numFailedTests',
  'numPendingTests',
  'numTodoTests',
]) {
  merged[key] = 0;
}

for (const report of reports) {
  addCounts(merged, report);
  merged.testResults.push(...(report.testResults ?? []));
}

writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`);
