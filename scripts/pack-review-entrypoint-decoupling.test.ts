import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('pack review entrypoint delivery decoupling (Issue #894)', () => {
  it('leaves post-verdict journaling and delivery entirely to the TypeScript runner', () => {
    const entrypoint = readFileSync(path.join(repoRoot, 'scripts/invoke-pack-review.ps1'), 'utf8');
    expect(entrypoint).not.toContain('Invoke-ScriptedReviewPostSubmitDeliveryFromPackReview');
    expect(entrypoint).not.toContain('Invoke-ScriptedReviewPostSubmitDelivery.ps1');

    const runner = readFileSync(path.join(repoRoot, 'scripts/pack-review-runner.ts'), 'utf8');
    expect(runner).toContain('deliverPackReviewVerdict');
    expect(runner).toContain('recordMalformedPackReviewStatus');
  });
});
