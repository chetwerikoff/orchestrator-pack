import { describe, expect, it } from 'vitest';
import { evaluatePostPortEvidence } from './post-port-admission.ts';
import type { PortStageEvidence } from './port-stage-evidence/producer.ts';

function evidence(overrides: Partial<PortStageEvidence> = {}): PortStageEvidence {
  return {
    schemaVersion: 'port-stage-evidence/v1',
    artifactRole: 'post-port',
    producerRevision: 'a'.repeat(40),
    measuredHead: 'a'.repeat(40),
    inputFactTreeDigest: 'b'.repeat(64),
    gateCensus: { populationCount: 1, populationDigest: 'c'.repeat(64), outputDigest: 'd'.repeat(64) },
    historicalExclusions: [],
    entries: [],
    unclassifiedPowerShellSurfaces: [],
    unresolvedCurrentPrescriptiveScriptTargets: [],
    retainedDispositions: [],
    broaderStatusClosed: true,
    dormantRetainedCoverageComplete: true,
    integrityDigest: 'e'.repeat(64),
    ...overrides,
  };
}

describe('Issue #1419 post-port admission', () => {
  it('passes only the closed unchanged-producer fact set', () => {
    expect(evaluatePostPortEvidence(evidence()).status).toBe('PASS');
  });

  it('reports current PowerShell authority and missing dormant retention without weakening producer facts', () => {
    const result = evaluatePostPortEvidence(evidence({
      entries: [
        {
          sourceKind: 'workflow-token-reference',
          occurrence: { sourcePath: '.github/workflows/example.yml', line: 4, column: 8, tokenKind: 'script', matchedBytes: 'scripts/live.ps1' },
          resolvedScriptPath: 'scripts/live.ps1',
          targetResolution: 'exact',
          currentPrescriptive: true,
        },
        {
          sourceKind: 'tracked-ps1-file',
          occurrence: { sourcePath: 'scripts/dormant.ps1', line: 1, column: 1, tokenKind: 'tracked-ps1-file', matchedBytes: 'scripts/dormant.ps1' },
          resolvedScriptPath: 'scripts/dormant.ps1',
          targetResolution: 'exact',
          currentPrescriptive: false,
        },
      ],
      broaderStatusClosed: true,
      dormantRetainedCoverageComplete: false,
    }));
    expect(result.status).toBe('FAIL');
    expect(result.failures).toEqual(['current_prescriptive=1', 'dormant_retained_coverage_incomplete=1']);
    expect(result.currentPrescriptive[0]?.resolvedScriptPath).toBe('scripts/live.ps1');
    expect(result.missingRetainedDispositions).toEqual(['scripts/dormant.ps1']);
  });
});

describe('Issue #1817 terminal zero-estate admission', () => {
  it('accepts a final artifact only when the terminal population is empty', () => {
    expect(evaluatePostPortEvidence(evidence({ artifactRole: 'final' }), 'final').status).toBe('PASS');
  });

  it('rejects tracked PowerShell or retained terminal dispositions', () => {
    const result = evaluatePostPortEvidence(evidence({
      artifactRole: 'final',
      entries: [{
        sourceKind: 'tracked-ps1-file',
        occurrence: { sourcePath: 'scripts/legacy.ps1', line: 1, column: 1, tokenKind: 'tracked-ps1-file', matchedBytes: 'scripts/legacy.ps1' },
        resolvedScriptPath: 'scripts/legacy.ps1',
        targetResolution: 'exact',
        currentPrescriptive: false,
      }],
      retainedDispositions: [{
        path: 'scripts/legacy.ps1',
        disposition: 'retained-for-1251-zero-estate',
        reason: 'fixture',
        owningReference: '#1251',
      }],
    }), 'final');
    expect(result.status).toBe('FAIL');
    expect(result.failures).toEqual(['tracked_powershell=1', 'retained_dispositions=1']);
  });
});
