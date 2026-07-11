#!/usr/bin/env node
/**
 * Emit Vitest CI lane plan JSON for PowerShell runners (Issue #556).
 *
 * Usage:
 *   node scripts/invoke-vitest-ci-lane-plan.mjs light
 *   node scripts/invoke-vitest-ci-lane-plan.mjs heavy --shard 3
 *   node scripts/invoke-vitest-ci-lane-plan.mjs wallclock
 */
import { existsSync, readFileSync } from 'node:fs';
import { buildLanePlan } from './lib/vitest-ci-lanes.mjs';

function parseArgs(argv) {
  const mode = argv[2];
  let shard = null;
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] === '--shard' && argv[index + 1]) {
      shard = Number(argv[index + 1]);
      index += 1;
    }
  }
  return { mode, shard };
}

function loadArtifactPlan() {
  const artifactPath = process.env.OPK_VITEST_TOPOLOGY_PLAN_PATH?.trim();
  if (!artifactPath || !existsSync(artifactPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch {
    return null;
  }
}

const { mode, shard } = parseArgs(process.argv);
const artifactPlan = loadArtifactPlan();
const plan = artifactPlan
  ? {
      ok: true,
      config: { lightMaxWorkers: Number(process.env.VITEST_LIGHT_MAX_WORKERS ?? 0) || 2 },
      light: artifactPlan.lightFiles ?? [],
      heavy: artifactPlan.heavyFiles ?? [],
      postMergeWallclock: artifactPlan.postMergeWallclockFiles ?? [],
      parked: artifactPlan.parkedFiles ?? [],
      discovered: artifactPlan.discovered ?? [],
      heavyShards: artifactPlan.heavyShards ?? [],
      topology: artifactPlan,
    }
  : buildLanePlan();

if (!plan.ok) {
  console.error(plan.errors.join('\n'));
  process.exit(1);
}

if (mode === 'light') {
  console.log(JSON.stringify({ lightMaxWorkers: plan.config.lightMaxWorkers, light: plan.light }));
  process.exit(0);
}

if (mode === 'heavy') {
  if (!Number.isFinite(shard) || shard < 1) {
    console.error('heavy mode requires --shard <n>');
    process.exit(1);
  }
  const heavyShard = plan.heavyShards.find((entry) => entry.shard === shard);
  if (!heavyShard) {
    console.error(`heavy shard ${shard} not found (count=${plan.topology.heavyShardCount})`);
    process.exit(1);
  }
  console.log(JSON.stringify(heavyShard));
  process.exit(0);
}

if (mode === 'wallclock') {
  console.log(JSON.stringify({ files: plan.postMergeWallclock ?? [] }));
  process.exit(0);
}

console.error('usage: invoke-vitest-ci-lane-plan.mjs <light|heavy|wallclock> [--shard N]');
process.exit(1);
