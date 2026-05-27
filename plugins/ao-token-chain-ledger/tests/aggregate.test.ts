import { describe, expect, it } from 'vitest';
import { aggregateChain } from '../lib/aggregate.js';
import { computeFindingSignature } from '../lib/finding_signature.js';
import type { LedgerRow } from '../lib/types.js';

function row(overrides: Partial<LedgerRow> & Pick<LedgerRow, 'event_kind' | 'role'>): LedgerRow {
  return {
    chain_id: 'chain-a',
    chain_id_source: 'manual',
    iteration_id: 'iter-1',
    session_id: 'sess-1',
    parent_session_id: null,
    parent_session_id_source: 'unavailable',
    task_id: '1',
    timestamp: '2026-05-01T00:00:00.000Z',
    finding: null,
    reaction: null,
    cost: {
      input_tokens: null,
      output_tokens: null,
      estimated_cost_usd: null,
      source: 'unavailable',
    },
    ...overrides,
  };
}

describe('aggregateChain', () => {
  it('sums available cost rows without zero-filling missing totals', () => {
    const report = aggregateChain(
      [
        row({
          event_kind: 'cost-observed',
          role: 'worker',
          cost: {
            input_tokens: 10,
            output_tokens: 5,
            estimated_cost_usd: 0.1,
            source: 'manual-import',
          },
        }),
        row({ event_kind: 'started', role: 'worker' }),
      ],
      'chain-a',
    );
    expect(report.total_input_tokens).toBe(10);
    expect(report.total_output_tokens).toBe(5);
    expect(report.total_estimated_cost_usd).toBe(0.1);
    expect(report.missing_data.unavailable_cost_rows).toBe(1);
  });

  it('groups totals by role tag', () => {
    const report = aggregateChain(
      [
        row({
          role: 'planner',
          event_kind: 'finished',
          cost: {
            input_tokens: 1,
            output_tokens: 2,
            estimated_cost_usd: 0.01,
            source: 'ao-session-cost',
          },
        }),
        row({
          role: 'worker',
          event_kind: 'finished',
          cost: {
            input_tokens: 3,
            output_tokens: 4,
            estimated_cost_usd: 0.02,
            source: 'ao-session-cost',
          },
        }),
      ],
      'chain-a',
    );
    expect(report.by_role).toHaveLength(2);
    const planner = report.by_role.find((entry) => entry.role === 'planner');
    expect(planner?.input_tokens).toBe(1);
    const worker = report.by_role.find((entry) => entry.role === 'worker');
    expect(worker?.input_tokens).toBe(3);
  });

  it('preserves unknown event_kind values', () => {
    const report = aggregateChain(
      [row({ event_kind: 'future-kind', role: 'worker' })],
      'chain-a',
    );
    expect(report.by_event_kind['future-kind']).toBe(1);
    expect(report.unknown_event_kinds).toContain('future-kind');
  });

  it('counts finding signature recurrence', () => {
    const finding = {
      type: 'quality',
      code: 'unused-var',
      severity: 'blocking',
      path: 'plugins/demo/lib.ts',
      summary: 'unused',
      source: 'codex-local',
    };
    const signature = computeFindingSignature(finding);
    const report = aggregateChain(
      [
        row({
          event_kind: 'finding',
          role: 'reviewer',
          finding: { ...finding, signature },
        }),
        row({
          event_kind: 'finding',
          role: 'reviewer',
          finding: { ...finding, signature },
        }),
      ],
      'chain-a',
    );
    expect(report.finding_signatures).toHaveLength(1);
    expect(report.finding_signatures[0]?.count).toBe(2);
  });
});
