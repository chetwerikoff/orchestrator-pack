#!/usr/bin/env node
/**
 * Materialize the committed generated launch-argv inventory for audit without
 * storing hundreds of hash-pinned census rows by hand (Issue #661 / #745).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditLaunchArgvInventory,
  buildDefaultInventoryRows,
  loadLaunchArgvBundle,
} from './launch-argv-registry.mjs';

export const GENERATED_LAUNCH_ARGV_INVENTORY_VERSION =
  'launch-argv-inventory/generated-v1';

function inventoryPath(repoRoot) {
  return join(repoRoot, 'scripts', 'launch-argv-inventory.json');
}

export function materializeGeneratedLaunchArgvInventory(repoRoot) {
  const path = inventoryPath(repoRoot);
  const source = JSON.parse(readFileSync(path, 'utf8'));
  if (source.generatedVersion !== GENERATED_LAUNCH_ARGV_INVENTORY_VERSION) {
    return { generated: false, inventory: source };
  }
  return {
    generated: true,
    inventory: {
      ...source,
      rows: buildDefaultInventoryRows(repoRoot),
    },
  };
}

export function loadCommittedLaunchArgvBundle(repoRoot) {
  const bundle = loadLaunchArgvBundle(repoRoot);
  const materialized = materializeGeneratedLaunchArgvInventory(repoRoot);
  return { ...bundle, inventory: materialized.inventory };
}

export function auditCommittedLaunchArgvInventory(repoRoot) {
  const path = inventoryPath(repoRoot);
  const original = readFileSync(path, 'utf8');
  const materialized = materializeGeneratedLaunchArgvInventory(repoRoot);
  if (!materialized.generated) {
    return auditLaunchArgvInventory(repoRoot);
  }
  try {
    writeFileSync(path, `${JSON.stringify(materialized.inventory, null, 2)}\n`, 'utf8');
    return auditLaunchArgvInventory(repoRoot);
  } finally {
    writeFileSync(path, original, 'utf8');
  }
}

function cli() {
  const repoRoot = process.argv[2]
    ? resolve(process.argv[2])
    : join(dirname(fileURLToPath(import.meta.url)), '..');
  const result = auditCommittedLaunchArgvInventory(repoRoot);
  if (result.verdict !== 'PASS') {
    for (const violation of result.violations) {
      process.stderr.write(`${violation}\n`);
    }
    process.stderr.write(
      `[FAIL] generated launch-argv inventory audit (${result.stats.productionHits} production hits, ${result.stats.inventoryRows} rows)\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `[PASS] generated launch-argv inventory audit (${result.stats.productionHits} production hits, ${result.stats.inventoryRows} rows)\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  cli();
}
