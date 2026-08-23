import { describe, expect, it } from 'vitest';
import { checkFindingLedgerGuard } from './finding-ledger-guard.mjs';

function markedFinding(id: string): string {
  return [
    'review-economics-contract: v1',
    `id: ${id}`,
    'type: security',
    'severity: P1',
    'evidence: A security issue is present in the proposed boundary.',
    'recommendation: Keep the existing contract.',
    'persistent-machinery: no',
    'SIMPLIFICATION_CLEAN',
  ].join('\n');
}

function markedClean(): string {
  return ['review-economics-contract: v1', 'NO_FINDINGS', 'SIMPLIFICATION_CLEAN'].join('\n');
}

function currentLens(id: string): string {
  return [
    `m3-protected: id=${id}`,
    'revision=r3',
    'contest=none',
    'outcome=non-activate',
    'evidence=',
    'why-now=',
  ].join(' | ');
}

describe('receipt-backed occurrence M3 lookup uses capture finding id', () => {
  it('resolves GitHub-identity occurrences from m3-protected id= finding lines', () => {
    const findingId = 'SEC1';
    const reviewName = 'pass-01-architectural-review-01.capture.txt';
    const captureIdentity = `sha256:83b098b700000000000000000000000000000000000000000000000000000000:${reviewName}`;
    const occurrenceId = `${captureIdentity}:1`;
    const githubText = markedFinding(findingId);
    const localText = `${markedClean()}\n${currentLens(findingId)}`;
    const result = checkFindingLedgerGuard(
      [githubText, localText],
      JSON.stringify({
        version: 2,
        counts: { rawFindingCount: 1, distinctFindingCount: 1, processedDistinctCount: 1 },
        findings: [{
          id: findingId,
          summary: 'security boundary',
          type: 'security',
          occurrences: [occurrenceId],
          defectDisposition: 'rejected-as-false',
          rejectReason: 'the report misread the existing contract',
          remedyDisposition: 'accepted',
          'persistent-machinery': 'no',
        }],
      }),
      {
        reviewEconomics: true,
        phase: 'final-acceptance',
        issueRevision: 'r3',
        stageTerminalConfirmed: true,
        captureMetadata: [
          { name: reviewName, timestampMs: 1_100, captureIdentity },
          { name: 'pass-02-architectural.capture.txt', timestampMs: 1_200 },
        ],
      } as never,
    );
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });
});
