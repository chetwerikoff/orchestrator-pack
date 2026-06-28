#!/usr/bin/env node
/**
 * Fail-closed slow-test budget guard for the full regression lane (Issue #488).
 * Reads Vitest JSON output and reports actionable slow file/test violations.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(repoRoot, 'scripts/test-runtime-budget.config.json');
const reportPath = process.argv[2] ?? join(repoRoot, '.vitest-runtime-report.json');

function loadConfig() {
  if (!existsSync(configPath)) {
    throw new Error(`missing budget config: ${relative(repoRoot, configPath)}`);
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  const perTestMs = Number(raw.perTestMs);
  const perFileMs = Number(raw.perFileMs);
  if (!Number.isFinite(perTestMs) || perTestMs <= 0) {
    throw new Error('test-runtime-budget.config.json perTestMs must be a positive number');
  }
  if (!Number.isFinite(perFileMs) || perFileMs <= 0) {
    throw new Error('test-runtime-budget.config.json perFileMs must be a positive number');
  }
  return { perTestMs, perFileMs };
}

function normalizeFilePath(file) {
  const normalized = String(file ?? 'unknown').replace(/\\/g, '/');
  const root = repoRoot.replace(/\\/g, '/');
  if (normalized.startsWith(`${root}/`)) {
    return normalized.slice(root.length + 1);
  }
  return normalized;
}

function collectFromVitestJson(payload, out) {
  const results = payload?.testResults;
  if (!Array.isArray(results)) {
    return false;
  }
  for (const fileResult of results) {
    const file = normalizeFilePath(fileResult.name);
    const assertions = fileResult.assertionResults ?? [];
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
      out.push({
        kind: 'test',
        name,
        file,
        durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      });
    }
  }
  return out.length > 0 || Array.isArray(results);
}

function collectResults(node, out) {
  if (!node || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectResults(item, out);
    }
    return;
  }
  if (node.type === 'test' && typeof node.name === 'string') {
    const duration = Number(node.duration ?? node.result?.duration ?? 0);
    const file = node.file ?? node.meta?.file ?? node.location?.file ?? 'unknown';
    out.push({
      kind: 'test',
      name: node.name,
      file: normalizeFilePath(file),
      durationMs: Number.isFinite(duration) ? duration : 0,
    });
    return;
  }
  for (const value of Object.values(node)) {
    collectResults(value, out);
  }
}

function summarizeByFile(tests) {
  const byFile = new Map();
  for (const test of tests) {
    const entry = byFile.get(test.file) ?? { file: test.file, totalMs: 0, tests: [] };
    entry.totalMs += test.durationMs;
    entry.tests.push(test);
    byFile.set(test.file, entry);
  }
  return byFile;
}

function main() {
  const { perTestMs, perFileMs } = loadConfig();
  if (!existsSync(reportPath)) {
    console.error(`[FAIL] Vitest runtime budget: missing JSON report at ${reportPath}`);
    process.exit(1);
  }

  const payload = JSON.parse(readFileSync(reportPath, 'utf8'));
  const tests = [];
  if (!collectFromVitestJson(payload, tests)) {
    collectResults(payload, tests);
  }

  const violations = [];
  const byFile = summarizeByFile(tests);

  for (const test of tests) {
    if (test.durationMs > perTestMs) {
      violations.push(
        `slow test: ${test.file} > ${test.name} took ${test.durationMs}ms (budget ${perTestMs}ms per test)`,
      );
    }
  }

  for (const entry of byFile.values()) {
    if (entry.totalMs > perFileMs) {
      violations.push(
        `slow file: ${entry.file} total ${entry.totalMs}ms across ${entry.tests.length} test(s) (budget ${perFileMs}ms per file)`,
      );
    }
  }

  if (violations.length > 0) {
    console.error('[FAIL] Vitest runtime budget exceeded:');
    for (const line of violations) {
      console.error(` - ${line}`);
    }
    console.error(
      `Adjust thresholds in scripts/test-runtime-budget.config.json only when the slowdown is intentional.`,
    );
    process.exit(1);
  }

  console.log(
    `[PASS] Vitest runtime budget OK (${tests.length} test(s); perTest<=${perTestMs}ms perFile<=${perFileMs}ms)`,
  );
}

main();
