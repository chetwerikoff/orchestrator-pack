#!/usr/bin/env node
/**
 * Fail-closed slow-test budget guard for the full regression lane (Issue #488).
 * Reads Vitest JSON output and reports actionable slow file/test violations.
 */
import { readFileSync, existsSync } from 'node:fs';
import { collectFromVitestJson, normalizeFilePath } from './lib/vitest-json-report.mjs';
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
      file: normalizeFilePath(file, repoRoot),
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
    const entry = byFile.get(test.file) ?? { file: test.file, durationMs: 0, testCount: 0 };
    entry.durationMs += test.durationMs;
    entry.testCount += 1;
    byFile.set(test.file, entry);
  }
  return [...byFile.values()];
}

function main() {
  const { perTestMs, perFileMs } = loadConfig();
  if (!existsSync(reportPath)) {
    console.error(`[FAIL] Vitest runtime budget: missing JSON report at ${reportPath}`);
    process.exit(1);
  }

  const payload = JSON.parse(readFileSync(reportPath, 'utf8'));
  const collected = collectFromVitestJson(payload, repoRoot);
  const tests = collected?.tests ?? [];
  const files =
    collected?.files ??
    summarizeByFile(
      (() => {
        const fallbackTests = [];
        collectResults(payload, fallbackTests);
        return fallbackTests;
      })(),
    );

  if (!collected) {
    const fallbackTests = [];
    collectResults(payload, fallbackTests);
    tests.push(...fallbackTests);
  }

  const violations = [];

  for (const test of tests) {
    if (test.durationMs > perTestMs) {
      violations.push(
        `slow test: ${test.file} > ${test.name} took ${test.durationMs}ms (budget ${perTestMs}ms per test)`,
      );
    }
  }

  for (const fileEntry of files) {
    if (fileEntry.durationMs > perFileMs) {
      const timingNote =
        fileEntry.timingSource === 'file-wall'
          ? 'file wall time'
          : 'assertion-duration sum';
      violations.push(
        `slow file: ${fileEntry.file} took ${Math.round(fileEntry.durationMs)}ms ${timingNote} across ${fileEntry.testCount} test(s) (budget ${perFileMs}ms per file)`,
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
