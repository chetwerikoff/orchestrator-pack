#!/usr/bin/env node
/**
 * Emit canonical heavy Vitest topology artifact and optional GitHub Actions outputs
 * (Issue #695).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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

function runDiagnostic(command, args, repoRoot, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 30 * 1024 * 1024,
  });
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  return {
    status: result.status,
    signal: result.signal,
    tail: text.split(/\r?\n/).slice(-200),
  };
}

const { ghaOutput, failOnGuard, repoRoot } = parseArgs(process.argv);
const changedPathManifest = parseChangedPathManifestFromEnv();
const changedFiles = (changedPathManifest?.entries ?? [])
  .map((entry) => entry.path)
  .filter((path) => path.endsWith('.test.ts'));
const laneOptions = {
  changedFiles,
  changedPathManifest,
  prScopeMode: normalizePrScopeMode(),
};

let result = buildLanePlan(repoRoot, laneOptions);
if (result.ok && shouldMeasurePreTopology(repoRoot, laneOptions)) {
  const targets = resolvePreTopologyMeasurementTargets(result, laneOptions);
  if (targets.length > 0) {
    const preTopologyMeasurements = measurePreTopologyFiles(repoRoot, targets, laneOptions);
    result = buildLanePlan(repoRoot, { ...laneOptions, preTopologyMeasurements });
  }
}
if (!result.ok) {
  console.error(result.errors.join('\n'));
  process.exit(1);
}

const artifactPath = topologyArtifactPath(repoRoot);
const artifact = {
  ...result.topology,
  discovered: result.discovered,
  fullDiscovered: result.fullDiscovered ?? result.discovered,
  heavyFiles: result.heavy,
  lightFiles: result.light,
  postMergeWallclockFiles: result.postMergeWallclock,
  parkedFiles: result.parked,
  heavyShards: result.heavyShards,
};

if (process.env.GITHUB_ACTIONS === 'true') {
  const sourceDocPaths = [
    'docs/migration_notes.md',
    'docs/orchestrator-autoloop-go-live.md',
    'docs/orchestrator-recovery-runbook.md',
    'docs/orchestrator-wake-runbook.md',
    'docs/wake-supervisor-fleet-operator-reference.md',
  ];
  artifact.prBSourceDocsBase64 = Object.fromEntries(
    sourceDocPaths.map((relativePath) => [
      relativePath,
      Buffer.from(readFileSync(join(repoRoot, relativePath), 'utf8'), 'utf8').toString('base64'),
    ]),
  );
  artifact.prBDiagnostics = {
    verifier: runDiagnostic(
      'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/verify.ps1'],
      repoRoot,
    ),
    typecheck: runDiagnostic(
      'npx',
      ['tsc', '--project', 'tsconfig.base.json', '--noEmit'],
      repoRoot,
    ),
    selfArchitect: runDiagnostic(
      'pwsh',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'scripts/lint-self-architect.ps1',
        '-Strict',
        '-BaseRef',
        process.env.PR_BASE_SHA ?? '',
        '-HeadRef',
        process.env.PR_HEAD_SHA ?? '',
      ],
      repoRoot,
    ),
  };
}

writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

if (result.topology.underProvisioned) {
  console.warn(
    `[WARN] heavy shard topology under-provisioned: raw derived count ${result.topology.rawDerivedCount} exceeds maxShardCount ${result.topology.policy.maxShardCount}; clamped to ${result.topology.heavyShardCount}`,
  );
}
if (result.topology.fallbackClassification === 'fixed-fallback') {
  console.warn(
    `[WARN] heavy shard topology using fixed fallback count ${result.topology.heavyShardCount} (${result.topology.weightInputReason})`,
  );
}

const guardFailures = formatOversizedGuardFailures(result);
if (failOnGuard && guardFailures.length > 0) {
  console.error(guardFailures.join('\n'));
  process.exit(1);
}
if (ghaOutput) writeGhaOutput(result.topology);

const logArtifact = { ...artifact };
if (logArtifact.prBSourceDocsBase64) {
  logArtifact.prBSourceDocsBase64 = Object.keys(logArtifact.prBSourceDocsBase64);
}
if (logArtifact.prBDiagnostics) {
  logArtifact.prBDiagnostics = Object.fromEntries(
    Object.entries(logArtifact.prBDiagnostics).map(([key, value]) => [
      key,
      { ...value, tail: [`${value.tail.length} lines captured in artifact`] },
    ]),
  );
}
console.log(JSON.stringify(logArtifact));
