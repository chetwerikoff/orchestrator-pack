import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  checkWaveBReconciliation,
  discoverPortedProducerModules,
  findStaleRemovedEntrypointCalls,
  loadWaveBInventory,
  reconcileWaveBInventory,
  type ReconciliationInput,
  type WaveBInventory,
} from './wave-b-reconciliation.js';

const repoRoot = resolve('.');

function realInput(): ReconciliationInput {
  const inventory = loadWaveBInventory(repoRoot);
  const modules = discoverPortedProducerModules(repoRoot);
  const paths = new Set(inventory.rows.flatMap((row) => [row.path, row.migratedModule, ...row.parityTargets, ...row.parityTests].filter(Boolean) as string[]));
  const fileSources = Object.fromEntries(
    [...new Set([...inventory.rows.map((row) => row.path), ...modules])]
      .map((path) => [path, readFileSync(resolve(repoRoot, path), 'utf8')]),
  );
  return {
    inventory,
    discoveredPowerShellProducers: inventory.rows.filter((row) => row.sourceKind === 'powershell-json-producer').map((row) => row.path),
    discoveredPortedModules: modules,
    fileSources,
    existingPaths: paths,
  };
}

function mutateInventory(
  inventory: WaveBInventory,
  rows: WaveBInventory['rows'],
): WaveBInventory {
  return { ...inventory, rows };
}

describe('Wave B producer inventory reconciliation', () => {
  test('passes on the real final tree', () => {
    expect(checkWaveBReconciliation(repoRoot)).toEqual([]);
  });

  test('fails when a discovered PowerShell producer is missing', () => {
    const input = realInput();
    const missing = input.inventory.rows.find((row) => row.sourceKind === 'powershell-json-producer')!;
    const inventory = mutateInventory(input.inventory, input.inventory.rows.filter((row) => row.path !== missing.path));
    expect(reconcileWaveBInventory({ ...input, inventory })).toContain(`${missing.path}: reachable JSON-producing PowerShell script is absent from inventory`);
  });

  test('fails when a Wave B row has no parity test or live golden', () => {
    const input = realInput();
    const target = input.inventory.rows.find((row) => row.ownerWave === 'wave-b')!;
    const inventory = mutateInventory(input.inventory, input.inventory.rows.map((row) => row === target
      ? { ...row, goldenStatus: 'none' as const, parityTests: [] }
      : row));
    const failures = reconcileWaveBInventory({ ...input, inventory });
    expect(failures).toContain(`${target.path}: Wave B row lacks a live parity target`);
    expect(failures).toContain(`${target.path}: Wave B row has no parity test`);
  });

  test('fails on a duplicate/two-wave claim', () => {
    const input = realInput();
    const target = input.inventory.rows[0]!;
    const duplicate = { ...target, ownerWave: target.ownerWave === 'wave-a' ? 'wave-c' as const : 'wave-a' as const };
    const inventory = mutateInventory(input.inventory, [...input.inventory.rows, duplicate]);
    expect(reconcileWaveBInventory({ ...input, inventory })).toContain(`${target.path}: claimed by more than one inventory row/wave`);
  });

  test('fails when a ported producer has no inventory row', () => {
    const input = realInput();
    const ghost = 'scripts/json-producers/ghost-producer.ts';
    expect(reconcileWaveBInventory({
      ...input,
      discoveredPortedModules: [...input.discoveredPortedModules, ghost],
      fileSources: { ...input.fileSources, [ghost]: "import { serializeJsonArtifact } from '#opk-kernel/json-artifact';" },
      existingPaths: new Set([...input.existingPaths, ghost]),
    })).toContain(`${ghost}: ported producer is absent from inventory`);
  });

  test('fails when a migrated producer hand-rolls JSON', () => {
    const input = realInput();
    const modulePath = input.discoveredPortedModules[0]!;
    const failures = reconcileWaveBInventory({
      ...input,
      fileSources: { ...input.fileSources, [modulePath]: `${input.fileSources[modulePath]}\nJSON.stringify({ drift: true });` },
    });
    expect(failures).toContain(`${modulePath}: hand-rolled JSON serialization bypasses the kernel`);
  });

  test('fails on a seeded stale invocation of a removed PowerShell entrypoint', () => {
    const input = realInput();
    const target = input.inventory.rows.find((row) => row.ownerWave === 'wave-b')!;
    const inventory = mutateInventory(input.inventory, input.inventory.rows.map((row) => row === target
      ? { ...row, entrypointMode: 'removed' as const }
      : row));
    expect(findStaleRemovedEntrypointCalls(inventory, {
      'scripts/synthetic-caller.ps1': `pwsh -File ${target.path}`,
    })).toEqual([`scripts/synthetic-caller.ps1: stale invocation of removed entrypoint ${target.path}`]);
  });

  test('fails when a compatibility wrapper serializes JSON', () => {
    const input = realInput();
    const wrapper = input.inventory.rows.find((row) => row.ownerWave === 'wave-b')!;
    const failures = reconcileWaveBInventory({
      ...input,
      fileSources: { ...input.fileSources, [wrapper.path]: `${input.fileSources[wrapper.path]}\nConvertTo-Json` },
    });
    expect(failures).toContain(`${wrapper.path}: compatibility wrapper still serializes JSON`);
  });
});
