#!/usr/bin/env node
/**
 * Emit canonical heavy Vitest topology artifact and optional GitHub Actions outputs
 * (Issue #695).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatOversizedGuardFailures,
  topologyArtifactPath,
} from './lib/vitest-heavy-topology.mjs';
import { buildLanePlan } from './lib/vitest-ci-lanes.mjs';
import {
  measurePreTopologyFiles,
  resolvePreTopologyMeasurementTargets,
  shouldMeasurePreTopology,
} from './lib/vitest-pre-topology-measurement.mjs';
import {
  normalizePrScopeMode,
  parseChangedPathManifestFromEnv,
} from './lib/vitest-pr-scoped-selection.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = join(scriptDir, '..');
const prBDiagnosticMode = process.env.GITHUB_ACTIONS === 'true';

function parseArgs(argv) {
  const flags = new Set(argv.slice(2));
  return {
    ghaOutput: flags.has('--gha-output'),
    failOnGuard: !flags.has('--skip-oversized-guard'),
    repoRoot: process.env.OPK_REPO_ROOT?.replace(/\\/g, '/') || defaultRepoRoot,
  };
}

function writeGhaOutput(topology) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(outputPath, `heavy_shard_count=${topology.heavyShardCount}\n`);
  appendFileSync(outputPath, `heavy_shard_matrix=${JSON.stringify(topology.heavyShardMatrix)}\n`);
  appendFileSync(outputPath, `fallback_classification=${topology.fallbackClassification}\n`);
}

function commandDiagnostic(child) {
  const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`.trim();
  return {
    status: child.status,
    signal: child.signal,
    error: child.error?.message ?? null,
    tail: output.split(/\r?\n/).slice(-300),
  };
}

function runPrBDiagnostic(repoRoot) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const files = [
    'scripts/vestigial-fleet-retirement.test.ts',
    'tests/vestigial-fleet-retirement-pr-b.test.ts',
    'scripts/orchestrator-escalation.test.ts',
    'scripts/launch-argv-inventory.test.ts',
    'scripts/reaction-config-messages.test.ts',
    'scripts/orchestrator-wake-supervisor-pr-lane-static.test.ts',
    'scripts/check-supervisor-test-wait-inventory.test.ts',
    'scripts/external-output-shape-guard.test.ts',
    'scripts/run-vitest-heavy-shard.test.ts',
  ];
  const child = spawnSync(npm, ['test', '--', ...files, '--reporter=verbose'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 6 * 60 * 1000,
    maxBuffer: 30 * 1024 * 1024,
    env: { ...process.env, OPK_PR_B_DIAGNOSTIC: '1' },
  });
  return { files, ...commandDiagnostic(child) };
}

const { ghaOutput, failOnGuard, repoRoot } = parseArgs(process.argv);
const changedPathManifest = parseChangedPathManifestFromEnv();
const changedFiles = (changedPathManifest?.entries ?? [])
  .filter((entry) => entry.status !== 'D')
  .map((entry) => entry.path)
  .filter((path) => path.endsWith('.test.ts'));
const laneOptions = {
  changedFiles,
  changedPathManifest,
  prScopeMode: normalizePrScopeMode(),
};

let result = buildLanePlan(repoRoot, laneOptions);
let measurementError = prBDiagnosticMode ? 'skipped in diagnostic mode' : null;
if (!prBDiagnosticMode && result.ok && shouldMeasurePreTopology(repoRoot, laneOptions)) {
  const targets = resolvePreTopologyMeasurementTargets(result, laneOptions);
  if (targets.length > 0) {
    const preTopologyMeasurements = measurePreTopologyFiles(repoRoot, targets, laneOptions);
    result = buildLanePlan(repoRoot, { ...laneOptions, preTopologyMeasurements });
  }
}

const diagnostic = prBDiagnosticMode ? runPrBDiagnostic(repoRoot) : null;
if (!result.ok && !prBDiagnosticMode) {
  console.error(result.errors.join('\n'));
  process.exit(1);
}

const topology = result.ok
  ? result.topology
  : {
      heavyShardCount: 0,
      heavyShardMatrix: [],
      fallbackClassification: 'diagnostic-planner-failure',
      plannerErrors: result.errors,
    };
const artifactPath = topologyArtifactPath(repoRoot);
const artifact = {
  ...topology,
  discovered: result.discovered ?? [],
  fullDiscovered: result.fullDiscovered ?? result.discovered ?? [],
  heavyFiles: result.heavy ?? [],
  lightFiles: result.light ?? [],
  postMergeWallclockFiles: result.postMergeWallclock ?? [],
  parkedFiles: result.parked ?? [],
  heavyShards: result.heavyShards ?? [],
  plannerErrors: result.ok ? [] : result.errors,
  prBDiagnostic: prBDiagnosticMode
    ? { measurementError, changedSuites: diagnostic }
    : null,
};
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

if (result.ok && result.topology.underProvisioned) {
  console.warn(
    `[WARN] heavy shard topology under-provisioned: raw derived count ${result.topology.rawDerivedCount} exceeds maxShardCount ${result.topology.policy.maxShardCount}; clamped to ${result.topology.heavyShardCount}`,
  );
}
if (result.ok && result.topology.fallbackClassification === 'fixed-fallback') {
  console.warn(
    `[WARN] heavy shard topology using fixed fallback count ${result.topology.heavyShardCount} (${result.topology.weightInputReason})`,
  );
}

const guardFailures = result.ok ? formatOversizedGuardFailures(result) : [];
if (!prBDiagnosticMode && failOnGuard && guardFailures.length > 0) {
  console.error(guardFailures.join('\n'));
  process.exit(1);
}
if (ghaOutput) writeGhaOutput(topology);

const logArtifact = {
  ...artifact,
  prBDiagnostic: artifact.prBDiagnostic
    ? {
        measurementError: artifact.prBDiagnostic.measurementError,
        changedSuites: {
          ...artifact.prBDiagnostic.changedSuites,
          tail: [`${artifact.prBDiagnostic.changedSuites.tail.length} lines captured in artifact`],
        },
      }
    : null,
};
console.log(JSON.stringify(logArtifact));
