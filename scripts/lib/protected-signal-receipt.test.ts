import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectProtectedSignalMatches,
  fingerprintProtectedSignalSpan,
  loadProtectedSignalReceipt,
  suppressProtectedSignalHits,
} from './protected-signal-receipt.mjs';

describe('Issue #1029 protected-signal receipt retirement', () => {
  it('keeps mixed legacy tier-marker and finding-ledger receipts valid with finding-ledger suppression', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-1029-receipt-'));
    try {
      const reviewDir = join(root, '.review', 'fixture');
      mkdirSync(reviewDir, { recursive: true });
      writeFileSync(join(reviewDir, 'decision-log.md'), 'Architect adjudicated protected-signal hits.\n');
      writeFileSync(
        join(reviewDir, 'protected-signal-receipt.json'),
        JSON.stringify({
          'recorded-at': '2026-07-28T00:00:00Z',
          'decision-log': 'decision-log.md',
          entries: [
            {
              guard: 'tier-marker',
              signal: 'ledger-echo',
              fingerprint: fingerprintProtectedSignalSpan('legacy tier-marker row'),
              reason: 'architect-false-positive',
              rationale: 'Retired tier-marker entry must remain inert on read.',
            },
            {
              guard: 'finding-ledger',
              signal: 'ledger-echo',
              fingerprint: fingerprintProtectedSignalSpan('finding ledger echo'),
              reason: 'architect-false-positive',
              rationale: 'Active finding-ledger suppression must still apply.',
            },
          ],
        }),
      );

      const receipt = loadProtectedSignalReceipt({ receiptDir: reviewDir });
      expect(receipt.invalid).toBe(false);
      expect(receipt.entries).toHaveLength(1);
      expect(receipt.entries[0].guard).toBe('finding-ledger');

      const patternSpecs = [{ signal: 'ledger-echo', pattern: /finding ledger echo/i }];
      const matches = collectProtectedSignalMatches('This finding ledger echo should suppress.', patternSpecs);
      const suppressed = suppressProtectedSignalHits(['ledger-echo'], matches, receipt, 'finding-ledger');
      expect(suppressed.hits).toEqual([]);
      expect(suppressed.suppressed).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
