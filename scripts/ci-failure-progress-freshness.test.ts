import { describe, expect, it } from 'vitest';
import { DEFAULT_PROGRESS_FRESHNESS_MS, resolveProgressFreshnessMs } from '../docs/ci-failure-notification.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCiFailureProgressProofPayload } from './lib/ci-failure-progress-proof.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(
  readFileSync(path.join(repoRoot, 'scripts/fixtures/ci-failure-notification/ci-failure-progress-pinned.json'), 'utf8'),
);

describe('ci-failure-progress-freshness (Issue #439 AC#1)', () => {
  it('fresh same-head fixing_ci suppresses with pinned default progressFreshnessMs', () => {
    const emission = buildCiFailureProgressProofPayload('freshness');
    expect(emission['ci-failure-progress-freshness'].freshDecision).toBe('suppressed-live-worker');
    console.log(JSON.stringify(emission));
  });

  it('defaults progressFreshnessMs below report-stale backstop', () => {
    expect(DEFAULT_PROGRESS_FRESHNESS_MS).toBeGreaterThan(0);
    expect(DEFAULT_PROGRESS_FRESHNESS_MS).toBe(pins.defaultProgressFreshnessMs);
    expect(resolveProgressFreshnessMs({})).toBeLessThan(30 * 60 * 1000);
  });
});
