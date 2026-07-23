import { describe, expect, it } from 'vitest';
import { buildPlanningManifest } from './closed-world-scanner.ts';
import { D928, FOUNDATION_COMMIT } from './contracts.ts';
import { validatePlanningManifest } from './planning-validator.ts';

describe('Issue #948 planning tooling bootstrap', () => {
  it('classifies every tracked file and closes the known target reverse references', () => {
    const manifest = buildPlanningManifest('HEAD');
    expect(manifest.issue).toBe(948);
    expect(manifest.lineage.foundationCommit).toBe(FOUNDATION_COMMIT);
    expect(manifest.denominator.length).toBeGreaterThan(1000);
    expect(new Set(manifest.denominator.map((row) => row.path)).size).toBe(manifest.denominator.length);
    expect(manifest.unknown).toEqual([]);
    expect(manifest.dynamicUnsupported).toEqual([]);
    expect(manifest.references.some((row) => row.source === 'scripts/pack-review-runner.ts' && row.disposition === 'repoint')).toBe(true);
    expect(manifest.references.some((row) => row.source === 'scripts/check-side-process-launch-contract.ps1' && row.disposition === 'retire')).toBe(true);
    expect(validatePlanningManifest(manifest)).toEqual({ ok: true });
  });

  it('binds all four D928 members without authorizing their mutation', () => {
    const manifest = buildPlanningManifest('HEAD');
    expect(Object.keys(manifest.d928Sha256).sort()).toEqual([...D928].sort());
    for (const target of D928) expect(manifest.plannedOperations.some((row) => row.path === target)).toBe(false);
  });

  it('censuses every top-level claim and lifecycle function with an overlap disposition', () => {
    const manifest = buildPlanningManifest('HEAD');
    expect(manifest.lifecycle.length).toBeGreaterThanOrEqual(80);
    expect(manifest.lifecycle.every((row) => row.legacyProtocolDisposition && row.rolloutBoundary)).toBe(true);
    expect(manifest.lifecycle.some((row) => row.identity === 'Acquire-ReviewStartClaim')).toBe(true);
    expect(manifest.lifecycle.some((row) => row.identity === 'Confirm-ReviewStartClaimLaunchGate')).toBe(true);
  });
});
