#!/usr/bin/env node
/**
 * Emit canonical heavy Vitest topology artifact and optional GitHub Actions outputs
 * (Issue #695).
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topologyArtifactPath } from './lib/vitest-heavy-topology.mjs';
import { buildLanePlan } from './lib/vitest-ci-lanes.mjs';
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

function commandDiagnostic(command, args, repoRoot, timeout) {
  const child = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, OPK_DISABLE_PRE_TOPOLOGY_MEASUREMENT: '1' },
  });
  const lines = `${child.stdout ?? ''}\n${child.stderr ?? ''}`
    .split(/\r?\n/)
    .filter(Boolean);
  return {
    command: [command, ...args].join(' '),
    status: child.status,
    signal: child.signal,
    error: child.error?.message ?? null,
    tail: lines.slice(-200),
  };
}

const { ghaOutput, repoRoot } = parseArgs(process.argv);
const rawChangedPathManifest = parseChangedPathManifestFromEnv();
const changedPathManifest = rawChangedPathManifest
  ? {
      ...rawChangedPathManifest,
      entries: (rawChangedPathManifest.entries ?? []).filter((entry) => entry.status !== 'D'),
      entryCount: (rawChangedPathManifest.entries ?? []).filter((entry) => entry.status !== 'D').length,
    }
  : null;
const changedFiles = (changedPathManifest?.entries ?? [])
  .map((entry) => entry.path)
  .filter((path) => path.endsWith('.test.ts'));
const laneOptions = {
  changedFiles,
  changedPathManifest,
  prScopeMode: normalizePrScopeMode(),
};

const scopedResult = buildLanePlan(repoRoot, laneOptions);
const fallbackResult = scopedResult.ok
  ? scopedResult
  : buildLanePlan(repoRoot, {
      changedFiles: [],
      changedPathManifest: null,
      prScopeMode: 'full',
    });
if (!fallbackResult.ok) {
  console.error(fallbackResult.errors.join('\n'));
  process.exit(1);
}

const diagnostic = process.env.CI === 'true'
  ? {
      planningErrors: scopedResult.ok ? [] : scopedResult.errors,
      typecheck: commandDiagnostic('npx', ['tsc', '--project', 'tsconfig.base.json', '--noEmit'], repoRoot, 180_000),
      waitInventory: commandDiagnostic('node', ['scripts/lib/supervisor-test-wait-inventory.mjs', 'production'], repoRoot, 90_000),
      lightLane: commandDiagnostic('pwsh', ['-NoProfile', '-File', 'scripts/run-vitest-light-lane.ps1'], repoRoot, 300_000),
    }
  : null;

const artifactPath = topologyArtifactPath(repoRoot);
const artifact = {
  ...fallbackResult.topology,
  discovered: fallbackResult.discovered,
  fullDiscovered: fallbackResult.fullDiscovered ?? fallbackResult.discovered,
  heavyFiles: fallbackResult.heavy,
  lightFiles: fallbackResult.light,
  postMergeWallclockFiles: fallbackResult.postMergeWallclock,
  parkedFiles: fallbackResult.parked,
  heavyShards: fallbackResult.heavyShards,
  pr768Diagnostic: diagnostic,
};
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

if (ghaOutput) writeGhaOutput(fallbackResult.topology);
console.log(JSON.stringify(artifact));
