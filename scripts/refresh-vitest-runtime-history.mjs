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
import { discoverVitestFiles } from './lib/vitest-ci-lanes.mjs';

const SUPPLEMENTAL_TUPLE_ERROR =
  'SupplementalReportsDir, SupplementalSourceSha, SupplementalRunId, and SupplementalRunAttempt must be supplied together';

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
  --output <path> \\
  [--repo-root <path>] \\
  [--require-equal-inventory]`);
}

function parseArgs(argv) {
  if (argv[0] === 'reconcile') {
    const options = {
      mode: 'reconcile',
      remotePath: '',
      proposedPath: '',
      outputPath: '',
      repoRoot: defaultRepoRoot,
      requireEqualInventory: false,
    };
    for (let index = 1; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === '--remote') {
        options.remotePath = argv[++index] ?? '';
      } else if (arg === '--proposed') {
        options.proposedPath = argv[++index] ?? '';
      } else if (arg === '--output') {
        options.outputPath = argv[++index] ?? '';
      } else if (arg === '--repo-root') {
        options.repoRoot = argv[++index] ?? defaultRepoRoot;
      } else if (arg === '--require-equal-inventory') {
        options.requireEqualInventory = true;
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

function hasFinitePositiveWeight(value) {
  const weight = Number(value);
  return Number.isFinite(weight) && weight > 0;
}

function preserveTrustedLegacyMeasuredWeights(mergedHistory, proposedHistory) {
  for (const [file, provenance] of Object.entries(proposedHistory.provenance ?? {})) {
    if (provenance !== 'measured' || !hasFinitePositiveWeight(proposedHistory.files?.[file])) {
      continue;
    }

    const proposedSamples = proposedHistory.recentSamples?.[file];
    const proposedChangedAt = proposedHistory.fileChangedAt?.[file];
    const hasOrderingMetadata =
      (Array.isArray(proposedSamples) && proposedSamples.length > 0)
      || (typeof proposedChangedAt === 'string' && proposedChangedAt.trim().length > 0);
    if (hasOrderingMetadata) {
      continue;
    }

    const mergedHasValidWeight =
      hasFinitePositiveWeight(mergedHistory.files?.[file])
      && mergedHistory.provenance?.[file] !== 'fallback';
    if (mergedHasValidWeight) {
      continue;
    }

    mergedHistory.files[file] = Number(proposedHistory.files[file]);
    mergedHistory.provenance[file] = 'measured';
    delete mergedHistory.recentSamples[file];
    delete mergedHistory.fileChangedAt[file];
  }
  return mergedHistory;
}

function runReconcile(options) {
  if (!options.remotePath || !options.proposedPath || !options.outputPath) {
    printUsage();
    process.exit(1);
  }
  const remoteHistory = loadHistoryFromFile(options.remotePath);
  const proposedHistory = loadHistoryFromFile(options.proposedPath);
  try {
    const currentInventory = options.requireEqualInventory
      ? discoverVitestFiles(options.repoRoot)
      : null;
    let merged = reconcileProposedHistoryAgainstRemote(proposedHistory, remoteHistory, {
      currentInventory,
      requireEqualInventory: options.requireEqualInventory,
    });
    if (options.requireEqualInventory) {
      merged = preserveTrustedLegacyMeasuredWeights(merged, proposedHistory);
    }
    writeFileSync(options.outputPath, historyBytes(merged), 'utf8');
    console.log('[PASS] runtime-history stale-base reconcile complete');
  } catch (error) {
    console.error(
      `[FAIL] runtime-history stale-base reconcile refused: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
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
  const supplementalTuple = [
    options.supplementalReportsDir,
    options.supplementalSourceSha,
    options.supplementalRunId,
    options.supplementalRunAttempt,
  ];
  const supplementalCount = supplementalTuple.filter((value) => Boolean(String(value ?? '').trim())).length;
  if (supplementalCount !== 0 && supplementalCount !== supplementalTuple.length) {
    console.error(`[FAIL] ${SUPPLEMENTAL_TUPLE_ERROR}`);
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
  const supplementalReports = supplementalCount === supplementalTuple.length
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
    console.error('[FAIL] runtime-history refresh rejected evidence:');
    for (const error of result.errors) {
      console.error(` - ${error}`);
    }
    console.error('[FAIL] runtime-history refresh left committed history unchanged after rejection');
    process.exit(1);
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

try {
  main();
} catch (error) {
  console.error(
    `[FAIL] runtime-history refresh execution failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
