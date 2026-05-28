import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aggregateChain } from '../lib/aggregate.js';
import { computeFindingSignature } from '../lib/finding_signature.js';
import { runLedgerReport } from '../bin/ledger.js';
import { readLedgerRows } from '../lib/writer.js';

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'three-session-chain.jsonl',
);

describe('ao-token-chain-ledger integration', () => {
  it('aggregates a three-session synthetic chain from fixture', () => {
    const rows = readLedgerRows(fixturePath);
    const report = aggregateChain(rows, 'fixture-chain-8');

    expect(report.total_input_tokens).toBe(3300);
    expect(report.total_output_tokens).toBe(1650);
    expect(report.total_estimated_cost_usd).toBeCloseTo(1.65, 5);
    expect(report.by_role.map((entry) => entry.role).sort()).toEqual([
      'planner',
      'reviewer',
      'worker',
    ]);
    expect(report.unknown_event_kinds).toEqual(['custom-telemetry']);
    expect(report.finding_signatures[0]?.count).toBe(2);
    expect(report.finding_signatures[0]?.signature).toBe(
      computeFindingSignature({
        type: 'quality',
        code: 'unused-var',
        path: 'plugins/demo/lib.ts',
      }),
    );
    expect(report.missing_data.unavailable_cost_rows).toBe(4);
    expect(report.missing_data.sessions_without_cost).toEqual([]);
    expect(report.missing_data.iterations_without_cost).toEqual([]);
  });

  it('prints a human report via ao-ledger CLI', () => {
    const stdout: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const code = runLedgerReport({
        chainId: 'fixture-chain-8',
        repoRoot: process.cwd(),
        ledgerPath: fixturePath,
        json: false,
      });
      expect(code).toBe(0);
      const output = stdout.join('');
      expect(output).toContain('Chain report: fixture-chain-8');
      expect(output).toContain('Finding signature recurrence');
      expect(output).toContain('Convergence');
      expect(output).toContain('final_state: abandoned');
    } finally {
      process.stdout.write = original;
    }
  });
});
