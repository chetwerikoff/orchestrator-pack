#!/usr/bin/env node
/**
 * Shared Vitest --reporter=json per-file duration parsing (Issues #488, #691).
 */
import { readFileSync, writeFileSync } from 'node:fs';

export function normalizeFilePath(file, repoRoot) {
  const normalized = String(file ?? 'unknown').replace(/\\/g, '/');
  const root = String(repoRoot ?? '').replace(/\\/g, '/').replace(/\/$/, '');
  if (root && normalized.startsWith(`${root}/`)) {
    return normalized.slice(root.length + 1);
  }
  return normalized;
}

export function sumAssertionDurationMs(assertions) {
  let total = 0;
  for (const assertion of assertions) {
    const durationMs = Number(assertion.duration ?? 0);
    if (Number.isFinite(durationMs)) {
      total += durationMs;
    }
  }
  return total;
}

export function resolveFileDurationMs(fileResult) {
  const start = Number(fileResult.startTime);
  const end = Number(fileResult.endTime);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return end - start;
  }
  return sumAssertionDurationMs(fileResult.assertionResults ?? []);
}

export function collectFromVitestJson(payload, repoRoot) {
  const results = payload?.testResults;
  if (!Array.isArray(results)) {
    return null;
  }

  const files = [];
  const tests = [];
  for (const fileResult of results) {
    const file = normalizeFilePath(fileResult.name, repoRoot);
    const assertions = fileResult.assertionResults ?? [];
    files.push({
      file,
      durationMs: resolveFileDurationMs(fileResult),
      testCount: assertions.length,
      timingSource:
        Number.isFinite(Number(fileResult.startTime)) &&
        Number.isFinite(Number(fileResult.endTime)) &&
        Number(fileResult.endTime) >= Number(fileResult.startTime)
          ? 'file-wall'
          : 'assertion-sum',
    });

    for (const assertion of assertions) {
      const titleParts = [];
      if (Array.isArray(assertion.ancestorTitles) && assertion.ancestorTitles.length > 0) {
        titleParts.push(...assertion.ancestorTitles);
      }
      if (assertion.title) {
        titleParts.push(assertion.title);
      }
      const name = titleParts.join(' > ') || assertion.fullName || 'unnamed test';
      const durationMs = Number(assertion.duration ?? 0);
      tests.push({
        kind: 'test',
        name,
        file,
        durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      });
    }
  }

  return { tests, files };
}

export function isCleanVitestJsonReport(payload) {
  return payload?.success === true && Number(payload?.numFailedTests ?? 1) === 0;
}

export function isCleanVitestJsonReportFile(reportPath) {
  if (!reportPath) {
    return false;
  }
  try {
    const payload = JSON.parse(readFileSync(reportPath, 'utf8'));
    return isCleanVitestJsonReport(payload);
  } catch {
    return false;
  }
}

export function parseVitestReportFile(reportPath, repoRoot) {
  const payload = JSON.parse(readFileSync(reportPath, 'utf8'));
  return collectFromVitestJson(payload, repoRoot);
}

export function mergeVitestJsonPayloads(payloads) {
  const testResults = [];
  for (const payload of payloads) {
    if (!payload || typeof payload !== 'object') {
      continue;
    }
    if (Array.isArray(payload.testResults)) {
      testResults.push(...payload.testResults);
    }
  }
  return { testResults };
}

export function mergeVitestReportFiles(reportPaths, outputPath) {
  const payloads = reportPaths.map((reportPath) =>
    JSON.parse(readFileSync(reportPath, 'utf8')),
  );
  const merged = mergeVitestJsonPayloads(payloads);
  writeFileSync(outputPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

function parseMergeCli(argv) {
  if (argv[0] === 'is-clean') {
    const reportPath = argv[1] ?? '';
    process.stdout.write(isCleanVitestJsonReportFile(reportPath) ? '1\n' : '0\n');
    process.exit(0);
  }
  if (argv[0] !== 'merge') {
    return null;
  }
  let outputPath = '';
  const reportPaths = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') {
      outputPath = argv[++index] ?? '';
      continue;
    }
    reportPaths.push(arg);
  }
  if (!outputPath || reportPaths.length === 0) {
    throw new Error('usage: node vitest-json-report.mjs merge --output <path> <report>...');
  }
  return { outputPath, reportPaths };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cli = parseMergeCli(process.argv.slice(2));
  if (cli) {
    mergeVitestReportFiles(cli.reportPaths, cli.outputPath);
  }
}
