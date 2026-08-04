import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runProcessSync } from '../kernel/subprocess.ts';
import {
  RUNTIME_ADAPTER_METHOD_OPERATIONS,
  RUNTIME_CALLER_CENSUS,
  validateRuntimeCallerCensus,
} from './caller-census.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const retiredPowerShellInvariants = [
  'Orchestrator-WakeSupervisorLease.ps1',
  'Orchestrator-SideEffectFence.ps1',
  'Orchestrator-SideProcessCrashBackoff.ps1',
  'Orchestrator-SideProcessDegradedBackoff.ps1',
  'Review-StartClaimLifecycle.ps1',
] as const;

const runtimeImplementationFiles = new Set([
  'scripts/runtime/contracts.ts',
  'scripts/runtime/test-adapter.ts',
  'scripts/runtime/caller-census.ts',
  'scripts/orca-runtime/adapter.ts',
  'scripts/orca-runtime/task-adapter.ts',
]);

function trackedFilesUnderScripts(): readonly string[] {
  const tracked = runProcessSync({
    command: 'git',
    args: ['ls-files', 'scripts'],
    cwd: repoRoot,
    inheritParentEnv: true,
    encoding: 'utf8',
  });
  if (!tracked.ok) {
    throw new Error(`git ls-files failed: ${tracked.stderr || tracked.error || tracked.outcome}`);
  }
  return tracked.stdout.trim().split('\n').filter(Boolean);
}

function residualRetiredPowerShellImports(): readonly string[] {
  const files = trackedFilesUnderScripts()
    .filter((relativePath) => relativePath.endsWith('.ps1'))
    .filter((relativePath) => !relativePath.startsWith('tests/'))
    .filter((relativePath) => relativePath !== 'scripts/check-review-start-claim-guard.ps1');
  const residual: string[] = [];
  for (const relativePath of files) {
    const source = readFileSync(path.join(repoRoot, relativePath), 'utf8');
    for (const retiredName of retiredPowerShellInvariants) {
      if (source.includes(retiredName)) {
        residual.push(`${relativePath}:${retiredName}`);
      }
    }
  }
  return residual.sort();
}

function discoveredRuntimeCalls(): ReadonlyMap<string, ReadonlySet<string>> {
  const methodNames = Object.keys(RUNTIME_ADAPTER_METHOD_OPERATIONS);
  const methodPattern = new RegExp(`\\.(${methodNames.join('|')})\\s*\\(`, 'gu');
  const discovered = new Map<string, Set<string>>();

  for (const relativePath of trackedFilesUnderScripts()) {
    if (!relativePath.endsWith('.ts')
      || relativePath.endsWith('.test.ts')
      || relativePath.endsWith('.spec.ts')
      || relativePath.endsWith('.d.ts')
      || runtimeImplementationFiles.has(relativePath)) continue;
    const source = readFileSync(path.join(repoRoot, relativePath), 'utf8');
    for (const match of source.matchAll(methodPattern)) {
      const method = match[1] as keyof typeof RUNTIME_ADAPTER_METHOD_OPERATIONS;
      const operations = discovered.get(relativePath) ?? new Set<string>();
      operations.add(RUNTIME_ADAPTER_METHOD_OPERATIONS[method]);
      discovered.set(relativePath, operations);
    }
  }
  return discovered;
}

describe('runtime caller census', () => {
  it('is complete for mandatory supervisor invariants', () => {
    expect(validateRuntimeCallerCensus()).toEqual([]);
  });

  it('classifies every repository-derived RuntimeAdapter invocation', () => {
    const rows = new Map(RUNTIME_CALLER_CENSUS.map((row) => [row.surface, row]));
    const unclassified: string[] = [];
    for (const [surface, operations] of discoveredRuntimeCalls()) {
      const row = rows.get(surface);
      if (!row || row.kind !== 'runtime-port'
        || row.disposition === 'delete-dead'
        || row.disposition === 'defer-1250') {
        unclassified.push(`${surface}:row_missing_or_inactive`);
        continue;
      }
      for (const operation of operations) {
        if (!row.operations.includes(operation)) {
          unclassified.push(`${surface}:${operation}`);
        }
      }
    }
    expect(unclassified.sort()).toEqual([]);
  });

  it('includes the current fleet observer caller', () => {
    expect(RUNTIME_CALLER_CENSUS).toContainEqual(expect.objectContaining({
      surface: 'scripts/pr2-foundation/fleet-observer.ts',
      disposition: 'already-runtime-neutral',
    }));
  });

  it('has no PowerShell consumers of retired supervisor invariants', () => {
    expect(residualRetiredPowerShellImports()).toEqual([]);
  });

  it('keeps AO service operations outside RuntimeAdapter', () => {
    const serviceRows = RUNTIME_CALLER_CENSUS.filter(
      (row) => row.kind === 'non-runtime-ao-service',
    );
    expect(serviceRows.length).toBeGreaterThan(0);
    expect(serviceRows.every((row) => row.disposition === 'defer-1250')).toBe(true);
  });

  it('retains the closed send outcome in the runtime contract', async () => {
    const { RUNTIME_DISPATCH_RESULTS } = await import('./contracts.ts');
    expect(RUNTIME_DISPATCH_RESULTS).toEqual([
      'dispatched',
      'send_failed',
      'dispatch_unknown',
    ]);
  });
});
