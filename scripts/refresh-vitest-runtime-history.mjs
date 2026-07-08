#!/usr/bin/env node
/**
 * CLI for runtime-history refresh (Issue #691).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultRepoRoot,
  emitCoverageSignal,
  loadHistoryFromFile,
  loadShardReportsFromDir,
  refreshRuntimeHistory,
  runtimeHistoryPath,
  writeHistoryIfChanged,
} from './lib/vitest-runtime-history-merge.mjs';
import { loadLanesConfig } from './lib/vitest-ci-lanes.mjs';

function printUsage() {
  console.error(`Usage: node scripts/refresh-vitest-runtime-history.mjs \\
  --reports-dir <dir> \\
  --commit-sha <sha> \\
  [--history-path <path>] \\
  [--repo-root <path>] \\
  [--dry-run]`);
}

function parseArgs(argv) {
  const options = {
    reportsDir: '',
    commitSha: '',
    historyPath: '',
    repoRoot: defaultRepoRoot,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--reports-dir') {
      options.reportsDir = argv[++index] ?? '';
    } else if (arg === '--commit-sha') {
      options.commitSha = argv[++index] ?? '';
    } else if (arg === '--history-path') {
      options.historyPath = argv[++index] ?? '';
    } else if (arg === '--repo-root') {
      options.repoRoot = argv[++index] ?? defaultRepoRoot;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.reportsDir || !options.commitSha) {
    printUsage();
    process.exit(1);
  }

  const historyPath =
    options.historyPath || join(options.repoRoot, 'scripts/vitest-runtime-history.json');
  const config = loadLanesConfig(options.repoRoot);
  const shardReports = loadShardReportsFromDir(options.reportsDir, config.heavyShardCount);
  const baseHistory = loadHistoryFromFile(historyPath);

  const result = refreshRuntimeHistory({
    baseHistory,
    shardReports,
    expectedCommitSha: options.commitSha,
    repoRoot: options.repoRoot,
  });

  emitCoverageSignal(result.coverage);

  if (result.rejected) {
    console.warn('[WARN] runtime-history refresh rejected bad provenance:');
    for (const error of result.errors) {
      console.warn(` - ${error}`);
    }
    console.log('[PASS] runtime-history refresh left committed history unchanged');
    process.exit(0);
  }

  if (result.idempotent) {
    console.log('[PASS] runtime-history refresh idempotent no-op (no data changes)');
    process.exit(0);
  }

  if (!options.dryRun) {
    writeHistoryIfChanged(historyPath, result);
  }

  console.log(
    `[PASS] runtime-history refresh updated ${Object.keys(result.history.files).length} file weight(s); source=${result.history.source}`,
  );
}

main();
