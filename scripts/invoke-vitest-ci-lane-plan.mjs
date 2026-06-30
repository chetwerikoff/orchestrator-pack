#!/usr/bin/env node
/**
 * Emit Vitest CI lane plan JSON for PowerShell runners (Issue #556).
 *
 * Usage:
 *   node scripts/invoke-vitest-ci-lane-plan.mjs light
 *   node scripts/invoke-vitest-ci-lane-plan.mjs heavy --shard 3
 */
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

const { mode, shard } = parseArgs(process.argv);
const plan = buildLanePlan();

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
    console.error(`heavy shard ${shard} not found (count=${plan.config.heavyShardCount})`);
    process.exit(1);
  }
  console.log(JSON.stringify(heavyShard));
  process.exit(0);
}

console.error('usage: invoke-vitest-ci-lane-plan.mjs <light|heavy> [--shard N]');
process.exit(1);
