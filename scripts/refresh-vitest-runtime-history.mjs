#!/usr/bin/env node
/**
 * CLI for runtime-history refresh (Issue #691).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
import {
  PRE_TOPOLOGY_MAX_FILES,
  resolvePreTopologyMeasurementPlan,
} from './lib/vitest-pre-topology-measurement.mjs';

const SUPPLEMENTAL_TUPLE_ERROR =
  'SupplementalReportsDir, SupplementalSourceSha, SupplementalRunId, and SupplementalRunAttempt must be supplied together';
const NORMALIZED_HISTORY_FIELDS = [
  'issue',
  'source',
  'dataChangedAt',
  'smoothingRule',
  'files',
  'provenance',
  'recentSamples',
  'fileChangedAt',
];

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
  [--require-equal-inventory]

Or: node scripts/refresh-vitest-runtime-history.mjs verify-candidate \\
  --trusted-history <path> \\
  --candidate-history <path> \\
  --trusted-repo-root <path> \\
  --candidate-repo-root <path>`);
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

  if (argv[0] === 'verify-candidate') {
    const options = {
      mode: 'verify-candidate',
      trustedHistoryPath: '',
      candidateHistoryPath: '',
      trustedRepoRoot: '',
      candidateRepoRoot: '',
    };
    for (let index = 1; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === '--trusted-history') {
        options.trustedHistoryPath = argv[++index] ?? '';
      } else if (arg === '--candidate-history') {
        options.candidateHistoryPath = argv[++index] ?? '';
      } else if (arg === '--trusted-repo-root') {
        options.trustedRepoRoot = argv[++index] ?? '';
      } else if (arg === '--candidate-repo-root') {
        options.candidateRepoRoot = argv[++index] ?? '';
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

function readRawHistory(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function hasFinitePositiveWeight(value) {
  const weight = Number(value);
  return Number.isFinite(weight) && weight > 0;
}

function countFinitePositiveWeights(history, canonicalPaths = null) {
  const allowed = canonicalPaths ? new Set(canonicalPaths) : null;
  return Object.entries(history?.files ?? {}).filter(
    ([file, value]) => (!allowed || allowed.has(file)) && hasFinitePositiveWeight(value),
  ).length;
}

function filterContentSha(contentSha, canonicalPaths) {
  if (!contentSha || typeof contentSha !== 'object' || Array.isArray(contentSha)) {
    return contentSha;
  }
  const allowed = canonicalPaths ? new Set(canonicalPaths) : null;
  return Object.fromEntries(
    Object.entries(contentSha).filter(([file]) => !allowed || allowed.has(file)),
  );
}

function projectHistoryOntoTrustedShape(history, trustedRawHistory, canonicalPaths = null) {
  const projected = structuredClone(trustedRawHistory ?? {});
  for (const field of NORMALIZED_HISTORY_FIELDS) {
    projected[field] = structuredClone(history[field]);
  }
  if (Object.prototype.hasOwnProperty.call(trustedRawHistory ?? {}, 'contentSha')) {
    projected.contentSha = structuredClone(
      filterContentSha(trustedRawHistory.contentSha, canonicalPaths),
    );
  } else {
    delete projected.contentSha;
  }
  return projected;
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

function stableObjectEntries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

function verifyTrustedCandidate({ trustedHistory, candidateHistory, canonicalPaths }) {
  const violations = [];
  for (const file of canonicalPaths) {
    const trustedWeight = trustedHistory?.files?.[file];
    if (!hasFinitePositiveWeight(trustedWeight)) continue;

    if (!hasFinitePositiveWeight(candidateHistory?.files?.[file])) {
      violations.push(`${file}: trusted positive weight ${trustedWeight} was dropped`);
      continue;
    }

    const trustedProvenance = trustedHistory?.provenance?.[file];
    const candidateProvenance = candidateHistory?.provenance?.[file];
    if (
      (trustedProvenance === 'measured' || trustedProvenance === 'seeded')
      && candidateProvenance !== 'measured'
      && candidateProvenance !== 'seeded'
    ) {
      violations.push(
        `${file}: trusted ${trustedProvenance} provenance became ${candidateProvenance ?? '<missing>'}`,
      );
    }
  }

  const trustedHasContentSha = Object.prototype.hasOwnProperty.call(trustedHistory ?? {}, 'contentSha');
  const candidateHasContentSha = Object.prototype.hasOwnProperty.call(candidateHistory ?? {}, 'contentSha');
  if (trustedHasContentSha !== candidateHasContentSha) {
    violations.push('contentSha shape differs from trusted main');
  } else if (trustedHasContentSha) {
    const trustedContentSha = filterContentSha(trustedHistory.contentSha, canonicalPaths);
    const candidateContentSha = filterContentSha(candidateHistory.contentSha, canonicalPaths);
    if (JSON.stringify(stableObjectEntries(trustedContentSha)) !== JSON.stringify(stableObjectEntries(candidateContentSha))) {
      violations.push('contentSha values differ from trusted main');
    }
  }

  return violations;
}

function runVerifyCandidate(options) {
  if (
    !options.trustedHistoryPath
    || !options.candidateHistoryPath
    || !options.trustedRepoRoot
    || !options.candidateRepoRoot
  ) {
    printUsage();
    process.exit(1);
  }

  const expectedTrustedHistoryPath = resolve(runtimeHistoryPath(options.trustedRepoRoot));
  const expectedCandidateHistoryPath = resolve(runtimeHistoryPath(options.candidateRepoRoot));
  if (resolve(options.trustedHistoryPath) !== expectedTrustedHistoryPath) {
    throw new Error(
      `trusted history path must be ${expectedTrustedHistoryPath}; got ${resolve(options.trustedHistoryPath)}`,
    );
  }
  if (resolve(options.candidateHistoryPath) !== expectedCandidateHistoryPath) {
    throw new Error(
      `candidate history path must be ${expectedCandidateHistoryPath}; got ${resolve(options.candidateHistoryPath)}`,
    );
  }

  const trustedHistory = readRawHistory(options.trustedHistoryPath);
  const candidateHistory = readRawHistory(options.candidateHistoryPath);
  const canonicalPaths = discoverVitestFiles(options.trustedRepoRoot);
  const violations = verifyTrustedCandidate({ trustedHistory, candidateHistory, canonicalPaths });
  if (violations.length > 0) {
    console.error('[FAIL] runtime-history publication guard refused trusted-main corruption:');
    for (const violation of violations) console.error(` - ${violation}`);
    process.exit(1);
  }

  const topologyResult = buildHeavyTopology(options.candidateRepoRoot);
  if (!topologyResult.ok) {
    throw new Error(
      `pre-topology publication guard unavailable: ${topologyResult.errors.join('; ')}`,
    );
  }
  const observedPlan = resolvePreTopologyMeasurementPlan(topologyResult, {
    maxFiles: Number.MAX_SAFE_INTEGER,
  });
  try {
    resolvePreTopologyMeasurementPlan(topologyResult);
  } catch (error) {
    console.error(
      `[FAIL] runtime-history publication guard refused pre-topology bound: observed=${observedPlan.targets.length} bound=${PRE_TOPOLOGY_MAX_FILES}; ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  const trustedPositive = countFinitePositiveWeights(trustedHistory, canonicalPaths);
  const candidatePositive = countFinitePositiveWeights(candidateHistory, canonicalPaths);
  console.log(
    `[PASS] runtime-history publication guard: trusted-positive=${trustedPositive} candidate-positive=${candidatePositive} pre-topology=${observedPlan.targets.length}/${PRE_TOPOLOGY_MAX_FILES} contentSha=preserved`,
  );
}

function runReconcile(options) {
  if (!options.remotePath || !options.proposedPath || !options.outputPath) {
    printUsage();
    process.exit(1);
  }
  const remoteHistory = loadHistoryFromFile(options.remotePath);
  const proposedHistory = loadHistoryFromFile(options.proposedPath);
  const proposedRawHistory = readRawHistory(options.proposedPath);
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
    const outputHistory = projectHistoryOntoTrustedShape(
      merged,
      proposedRawHistory,
      currentInventory,
    );
    writeFileSync(options.outputPath, historyBytes(outputHistory), 'utf8');
    const positiveWeightCount = countFinitePositiveWeights(outputHistory, currentInventory);
    console.log(
      `[PASS] runtime-history stale-base reconcile complete; candidate-positive=${positiveWeightCount}`,
    );
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
  if (options.mode === 'verify-candidate') {
    runVerifyCandidate(options);
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
  const baseHistoryPath = options.baseHistoryFile || historyPath;
  const baseRawHistory = readRawHistory(baseHistoryPath);
  const baseHistory = loadHistoryFromFile(baseHistoryPath);

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

  const currentInventory = discoverVitestFiles(options.repoRoot);
  const outputHistory = projectHistoryOntoTrustedShape(
    result.history,
    baseRawHistory,
    currentInventory,
  );
  const outputBytes = historyBytes(outputHistory);
  const inputBytes = historyBytes(baseRawHistory);
  result.history = outputHistory;
  result.outputBytes = outputBytes;
  result.changed = outputBytes !== inputBytes;
  result.idempotent = !result.changed;

  if (result.idempotent) {
    console.log('[PASS] runtime-history refresh idempotent no-op (no data changes)');
    process.exit(0);
  }

  if (!options.dryRun) {
    writeHistoryIfChanged(historyPath, result);
  }

  console.log(
    `[PASS] runtime-history refresh prepared candidate with ${countFinitePositiveWeights(result.history, currentInventory)} positive weight(s); source=${result.history.source}`,
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
