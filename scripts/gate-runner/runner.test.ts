import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatGateRunnerReport, main, runGateRunner } from './runner.ts';

const repoRoot = resolve(import.meta.dirname, '../..');

describe('real gate runner dispatch', () => {
  it('runs the representative ports and census as one lane', () => {
    const report = runGateRunner(repoRoot);
    expect(report.aggregate.status, formatGateRunnerReport(report)).toBe('PASS');
    expect(report.aggregate.green).toBe(true);
    expect(report.results.map((result) => result.gateId)).toEqual([
      'agent-rules-live-reference',
      'agent-rules-size-budget',
      'agent-rules-moved-content',
      'ao-capture-redaction',
      'gate-census',
    ]);
  });

  it('supports a stable per-gate CLI selection without changing the default full run', () => {
    const report = runGateRunner(repoRoot, ['agent-rules-size-budget']);
    expect(report.results.map((result) => result.gateId)).toEqual(['agent-rules-size-budget']);
    expect(report.aggregate.status).toBe('PASS');
  });

  it('fails closed on an unknown per-gate selector', async () => {
    expect(await main(['--repo-root', repoRoot, '--gate', 'missing-gate'])).toBe(2);
  });
});
