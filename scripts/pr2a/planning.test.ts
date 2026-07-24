import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  validateFinalVerificationEnvironment,
  validatePreReceiptVerificationEnvironment,
} from './closure-receipt.ts';
import { buildPlanningManifest } from './closed-world-scanner.ts';
import { D928, FOUNDATION_COMMIT } from './contracts.ts';
import { validatePlanningManifest } from './planning-validator.ts';

describe('Issue #948 planning tooling bootstrap', () => {
  it('classifies every tracked file and closes the known target reverse references', () => {
    const reviewed = JSON.parse(readFileSync('scripts/pr2a/planning-manifest.json', 'utf8'));
    const manifest = buildPlanningManifest(reviewed.lineage.planningCommit);
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

  it('fails closed on unsupported pre-receipt and final verification environments', () => {
    const unsupported = {
      repository: 'chetwerikoff/orchestrator-pack',
      platform: 'win32',
      filesystem: 'cifs',
      nodeVersion: 'v20.0.0',
      pwshVersion: '5.1.0',
    };
    expect(validatePreReceiptVerificationEnvironment(unsupported)).toEqual(expect.arrayContaining([
      'pre-receipt-platform-unsupported',
      'pre-receipt-node-version-mismatch',
      'pre-receipt-pwsh-version-mismatch',
      'pre-receipt-filesystem-mismatch',
    ]));
    expect(validateFinalVerificationEnvironment(unsupported)).toEqual(expect.arrayContaining([
      'final-verification-platform-unsupported',
      'final-verification-node-version-mismatch',
      'final-verification-pwsh-version-mismatch',
      'final-verification-filesystem-mismatch',
    ]));
  });
});
