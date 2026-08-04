import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runProcessSync } from '../kernel/subprocess.ts';
import {
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

function residualRetiredPowerShellImports(): readonly string[] {
  const tracked = runProcessSync({
    command: 'git',
    args: ['ls-files', '*.ps1'],
    cwd: repoRoot,
    inheritParentEnv: true,
    encoding: 'utf8',
  });
  if (!tracked.ok) {
    throw new Error(`git ls-files failed: ${tracked.stderr || tracked.error || tracked.outcome}`);
  }
  const files = tracked.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
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

describe('runtime caller census', () => {
  it('is complete for mandatory supervisor invariants', () => {
    expect(validateRuntimeCallerCensus()).toEqual([]);
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
