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
  loadSupplementalReportsFromDir,
  reconcileProposedHistoryAgainstRemote,
  refreshRuntimeHistory,
  runtimeHistoryPath,
  historyBytes,
  writeHistoryIfChanged,
} from './lib/vitest-runtime-history-merge.mjs';
import { buildHeavyTopology } from './lib/vitest-heavy-topology.mjs';

function printUsage() {
  console.error(`Usage: node scripts/refresh-vitest-runtime-history.mjs \\
  --reports-dir <dir> \\
  --commit-sha <sha> \\
  [--history-path <path>] \\
  [--base-history-file <path>] \\
  [--repo-root <path>] \\
  [--dry-run]

Or: node scripts/refresh-vitest-runtime-history.mjs reconcile \\
  --remote <path> \\
  --proposed <path> \\
  --output <path>`);
}

function parseArgs(argv) {
  if (argv[0] === 'reconcile') {
    const options = {
      mode: 'reconcile',
      remotePath: '',
      proposedPath: '',
      outputPath: '',
    };
    for (let index = 1; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === '--remote') {
        options.remotePath = argv[++index] ?? '';
      } else if (arg === '--proposed') {
        options.proposedPath = argv[++index] ?? '';
      } else if (arg === '--output') {
        options.outputPath = argv[++index] ?? '';
      } else if (arg === '--help' || arg === '-h') {
        printUsage();
        process.exit(0);
      } else {
        throw new Error(`unknown argument: ${arg}`);
      }
    }
    return options;
  }

  const options = {
    mode: 'refresh',
    reportsDir: '',
    commitSha: '',
    historyPath: '',
    baseHistoryFile: '',
    supplementalReportsDir: '',
    supplementalSourceSha: '',
    supplementalRunId: '',
    supplementalRunAttempt: '',
    repoRoot: defaultRepoRoot,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--reports-dir') {
      options.reportsDir = argv[++index] ?? '';
    } else if (arg === '--commit-sha') {
      options.commitSha = argv[++index] ?? '';
    } else if (arg === '--supplemental-reports-dir') {
      options.supplementalReportsDir = argv[++index] ?? '';
    } else if (arg === '--supplemental-source-sha') {
      options.supplementalSourceSha = argv[++index] ?? '';
    } else if (arg === '--supplemental-run-id') {
      options.supplementalRunId = argv[++index] ?? '';
    } else if (arg === '--supplemental-run-attempt') {
      options.supplementalRunAttempt = argv[++index] ?? '';
    } else if (arg === '--history-path') {
      options.historyPath = argv[++index] ?? '';
    } else if (arg === '--base-history-file') {
      options.baseHistoryFile = argv[++index] ?? '';
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

function runReconcile(options) {
  if (!options.remotePath || !options.proposedPath || !options.outputPath) {
    printUsage();
    process.exit(1);
  }
  const remoteHistory = loadHistoryFromFile(options.remotePath);
  const proposedHistory = loadHistoryFromFile(options.proposedPath);
  const merged = reconcileProposedHistoryAgainstRemote(proposedHistory, remoteHistory);
  writeFileSync(options.outputPath, historyBytes(merged), 'utf8');
  console.log('[PASS] runtime-history stale-base reconcile complete');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'reconcile') {
    runReconcile(options);
    return;
  }

  if (!options.reportsDir || !options.commitSha) {
    printUsage();
    process.exit(1);
  }
  if (Boolean(options.supplementalReportsDir) !== Boolean(options.supplementalSourceSha)) {
    printUsage();
    process.exit(1);
  }
  if (options.supplementalReportsDir && (!options.supplementalRunId || !options.supplementalRunAttempt)) {
    printUsage();
    process.exit(1);
  }

  const historyPath =
    options.historyPath || join(options.repoRoot, 'scripts/vitest-runtime-history.json');
  const topologyResult = buildHeavyTopology(options.repoRoot);
  if (!topologyResult.ok) {
    console.error(topologyResult.errors.join('; '));
    process.exit(1);
  }
  const shardReports = loadShardReportsFromDir(
    options.reportsDir,
    topologyResult.topology.heavyShardCount,
  );
  const supplementalReports = options.supplementalReportsDir
    ? loadSupplementalReportsFromDir(options.supplementalReportsDir)
    : null;
  const baseHistory = options.baseHistoryFile
    ? loadHistoryFromFile(options.baseHistoryFile)
    : loadHistoryFromFile(historyPath);

  const result = refreshRuntimeHistory({
    baseHistory,
    shardReports,
    supplementalReports,
    expectedCommitSha: options.commitSha,
    expectedSupplementalSourceSha: options.supplementalSourceSha,
    expectedSupplementalRunId: options.supplementalRunId,
    expectedSupplementalRunAttempt: options.supplementalRunAttempt,
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
