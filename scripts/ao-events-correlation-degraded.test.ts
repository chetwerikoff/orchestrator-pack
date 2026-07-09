import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('AO events degraded correlation sidecars (Issue #688)', () => {
  const repoRoot = join(import.meta.dirname, '..');
  const sidecars = [
    'scripts/ci-green-wake-reconcile.ps1',
    'scripts/review-trigger-reconcile.ps1',
    'scripts/worker-message-submit-reconcile.ps1',
    'scripts/review-finding-delivery-confirm.ps1',
    'scripts/ci-failure-notification-reconcile.ps1',
  ];

  it('loads and calls the shared degraded-correlation helper from all five consumers', () => {
    for (const rel of sidecars) {
      const source = readFileSync(join(repoRoot, rel), 'utf8');
      expect(source, rel).toContain('Write-AoEventsCorrelationDegraded.ps1');
      expect(source, rel).toContain('Write-AoEventsCorrelationDegraded');
    }
  });
});
