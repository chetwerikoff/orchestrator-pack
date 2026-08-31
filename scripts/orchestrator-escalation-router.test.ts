// @vitest-ci-lane light
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('terminal escalation routing', () => {
  it('keeps the retired shell router absent and the current S3 source single-seam', () => {
    for (const retired of [
      'scripts/lib/Orchestrator-Escalation.ps1',
      'scripts/orchestrator-escalation-router.ps1',
      'scripts/lib/Invoke-WorkerDegradedCiHandoff.ps1',
    ]) {
      expect(existsSync(path.resolve(retired)), retired).toBe(false);
    }
    const source = readFileSync(
      path.resolve('scripts/pr2-foundation/fleet-escalation-delivery.ts'),
      'utf8',
    );
    expect(source.match(/publishOperatorMessageOnce\(/gu)).toHaveLength(1);
    expect(source).not.toContain('.ps1');
    expect(source).not.toContain('retryAuthority:');
  });
});
