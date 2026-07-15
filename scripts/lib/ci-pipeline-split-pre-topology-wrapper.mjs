#!/usr/bin/env node
/**
 * Ephemeral same-run runtime-history adapter for check-ci-pipeline-split.ps1.
 * The committed artifact is restored byte-for-byte in finally.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  buildHeavyTopology,
  computeFileContentSha,
} from './vitest-heavy-topology.mjs';
import {
  measurePreTopologyFiles,
  resolvePreTopologyMeasurementPlan,
  shouldMeasurePreTopology,
} from './vitest-pre-topology-measurement.mjs';

function parseArgs(argv) {
  const args = argv.slice(2);
  let repoRoot = '';
  let core = '';
  let skipLiveCoverage = false;
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case '--repo-root':
        repoRoot = args[++index] ?? '';
        break;
      case '--core':
        core = args[++index] ?? '';
        break;
      case '--skip-live-coverage':
        skipLiveCoverage = true;
        break;
      default:
        throw new Error(`unknown argument: ${args[index]}`);
    }
  }
  if (!repoRoot) throw new Error('--repo-root is required');
  if (!core) throw new Error('--core is required');
  return {
    repoRoot: resolve(repoRoot),
    core: resolve(core),
    skipLiveCoverage,
  };
}

async function materializeOverlay(repoRoot, originalText) {
  const initial = buildHeavyTopology(repoRoot);
  if (!initial.ok) {
    throw new Error(`initial topology build failed: ${(initial.errors ?? []).join('; ')}`);
  }
  if (!shouldMeasurePreTopology(repoRoot)) {
    return null;
  }
  const plan = resolvePreTopologyMeasurementPlan(initial);
  const { targets } = plan;
  if (targets.length === 0) {
    if (Object.keys(plan.measurements).length === 0) return null;
  }
  const measurements = targets.length > 0
    ? { ...plan.measurements, ...await measurePreTopologyFiles(repoRoot, targets) }
    : plan.measurements;
  const artifact = JSON.parse(originalText);
  artifact.files = artifact.files && typeof artifact.files === 'object' ? artifact.files : {};
  artifact.provenance = artifact.provenance && typeof artifact.provenance === 'object'
    ? artifact.provenance
    : {};
  artifact.contentSha = artifact.contentSha && typeof artifact.contentSha === 'object'
    ? artifact.contentSha
    : {};
  for (const file of plan.allTargets) {
    const contentSha = computeFileContentSha(repoRoot, file);
    if (!contentSha) {
      throw new Error(`cannot bind same-run measurement to missing file: ${file}`);
    }
    artifact.files[file] = Math.max(1, Math.round(Number(measurements[file]) * 1000));
    artifact.provenance[file] = 'measured';
    artifact.contentSha[file] = contentSha;
  }
  return {
    text: `${JSON.stringify(artifact, null, 2)}\n`,
    targets: plan.allTargets,
  };
}

function runCore({ repoRoot, core, skipLiveCoverage }) {
  const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
  const args = ['-NoProfile', '-File', core, '-RepoRoot', repoRoot];
  if (skipLiveCoverage) args.push('-SkipLiveCoverage');
  return spawnSync(pwsh, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      OPK_DISABLE_PRE_TOPOLOGY_MEASUREMENT: '1',
    },
  });
}

const options = parseArgs(process.argv);
const historyPath = join(options.repoRoot, 'scripts', 'vitest-runtime-history.json');
const originalText = readFileSync(historyPath, 'utf8');
let overlayApplied = false;
let exitCode = 1;

try {
  const overlay = await materializeOverlay(options.repoRoot, originalText);
  if (overlay) {
    writeFileSync(historyPath, overlay.text, 'utf8');
    overlayApplied = true;
    process.stderr.write(
      `[ci-pipeline-split] materialized same-run overlay for ${overlay.targets.length} Vitest file(s)\n`,
    );
  }
  const result = runCore(options);
  if (result.error) {
    throw result.error;
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  exitCode = Number.isInteger(result.status) ? result.status : 1;
} finally {
  if (overlayApplied) {
    writeFileSync(historyPath, originalText, 'utf8');
    process.stderr.write('[ci-pipeline-split] restored committed runtime history\n');
  }
}

process.exit(exitCode);
