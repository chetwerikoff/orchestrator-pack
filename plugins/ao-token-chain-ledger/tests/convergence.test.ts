import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aggregateChain } from '../lib/aggregate.js';
import {
  computeConvergence,
  isIterationConverged,
  NULL_ITERATION_KEY,
} from '../lib/convergence.js';
import { computeFindingSignature } from '../lib/finding_signature.js';
import { readLedgerRows } from '../lib/writer.js';
import { ledgerTestRow as row } from './ledger_row.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixturePath(name: string): string {
  return join(fixturesDir, name);
}

const convergenceRowDefaults = { chain_id: 'chain-test', task_id: '19' };

describe('computeConvergence', () => {
  it('reports converged when review flags finding then fix and clean review', () => {
    const rows = readLedgerRows(fixturePath('converging-loop.jsonl'));
    const report = aggregateChain(rows, 'fixture-converging').convergence;

    expect(report.total_iterations).toBe(4);
    expect(report.final_state).toBe('converged');
    expect(report.blocking_findings_by_iteration).toEqual([
      { iteration_id: 'iter-1', blocking_findings: 0 },
      { iteration_id: 'iter-2', blocking_findings: 1 },
      { iteration_id: 'iter-3', blocking_findings: 0 },
      { iteration_id: 'iter-4', blocking_findings: 0 },
    ]);
    expect(report.repeated_signatures).toEqual([]);
  });

  it('detects repeated signatures across iterations', () => {
    const rows = readLedgerRows(fixturePath('repeated-finding-loop.jsonl'));
    const report = aggregateChain(rows, 'fixture-repeated-finding').convergence;
    const signature = computeFindingSignature({
      type: 'quality',
      code: 'unused-var',
      path: 'plugins/demo/lib.ts',
    });

    expect(report.final_state).toBe('abandoned');
    expect(report.repeated_signatures).toHaveLength(1);
    expect(report.repeated_signatures[0]?.signature).toBe(signature);
    expect(report.repeated_signatures[0]?.iterations).toEqual(['iter-2', 'iter-4']);
    expect(report.analytical_warnings.length).toBeGreaterThan(0);
  });

  it('reports converged after CI failure then fix', () => {
    const rows = readLedgerRows(fixturePath('ci-fail-loop.jsonl'));
    const report = aggregateChain(rows, 'fixture-ci-fail').convergence;

    expect(report.final_state).toBe('converged');
    expect(
      report.blocking_findings_by_iteration.find((e) => e.iteration_id === 'iter-2')
        ?.blocking_findings,
    ).toBe(1);
    expect(
      report.blocking_findings_by_iteration.find((e) => e.iteration_id === 'iter-4')
        ?.blocking_findings,
    ).toBe(0);
  });

  it('preserves loop accounting when cost data is missing', () => {
    const rows = readLedgerRows(fixturePath('missing-cost-loop.jsonl'));
    const aggregate = aggregateChain(rows, 'fixture-missing-cost');
    const report = aggregate.convergence;

    expect(report.final_state).toBe('converged');
    expect(report.total_iterations).toBe(4);
    expect(report.missing_cost_summary.unavailable_cost_rows).toBeGreaterThan(0);
    expect(report.missing_cost_summary.sessions_without_cost.length).toBeGreaterThan(0);
    expect(aggregate.total_input_tokens).toBeNull();
  });

  it('marks escalated when an escalation event is present', () => {
    const missing = {
      total_rows: 1,
      unavailable_cost_rows: 0,
      sessions_without_cost: [],
      iterations_without_cost: [],
    };
    const report = computeConvergence(
      [
        row(
          { event_kind: 'escalation', role: 'orchestrator', iteration_id: 'iter-9' },
          convergenceRowDefaults,
        ),
      ],
      'chain-test',
      { missingData: missing },
    );
    expect(report.final_state).toBe('escalated');
  });

  it('accounts for rows with null iteration_id under (none)', () => {
    const missing = {
      total_rows: 2,
      unavailable_cost_rows: 0,
      sessions_without_cost: [],
      iterations_without_cost: [],
    };
    const report = computeConvergence(
      [
        row(
          {
            iteration_id: null,
            event_kind: 'started',
            role: 'worker',
            timestamp: '2026-05-02T10:00:00.000Z',
          },
          { ...convergenceRowDefaults, chain_id: 'chain-null-iter' },
        ),
        row(
          {
            iteration_id: null,
            event_kind: 'finished',
            role: 'worker',
            timestamp: '2026-05-02T10:30:00.000Z',
          },
          { ...convergenceRowDefaults, chain_id: 'chain-null-iter' },
        ),
      ],
      'chain-null-iter',
      { missingData: missing },
    );

    expect(report.total_iterations).toBe(1);
    expect(report.blocking_findings_by_iteration).toEqual([
      { iteration_id: NULL_ITERATION_KEY, blocking_findings: 0 },
    ]);
    expect(report.final_state).toBe('converged');
  });
});

describe('isIterationConverged', () => {
  it('requires no blocking findings, scope violations, or CI failures', () => {
    expect(
      isIterationConverged([
        row(
          {
            event_kind: 'finding',
            role: 'reviewer',
            finding: {
              type: 'scope-violation',
              code: 'scope-violation:path-outside-declaration',
              severity: 'blocking',
              path: 'vendor/foo.ts',
              summary: 'out of scope',
              source: 'codex-local',
            },
          },
          convergenceRowDefaults,
        ),
      ]),
    ).toBe(false);

    expect(
      isIterationConverged([
        row(
          {
            event_kind: 'reaction',
            role: 'reviewer',
            reaction: { trigger: 'ci-failed', action: 'send-to-agent' },
          },
          convergenceRowDefaults,
        ),
      ]),
    ).toBe(false);

    expect(
      isIterationConverged([
        row({ event_kind: 'finished', role: 'reviewer' }, convergenceRowDefaults),
      ]),
    ).toBe(true);
  });
});
