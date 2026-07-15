import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatGateRunnerReport, runGateRunner } from './runner.ts';

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
});
