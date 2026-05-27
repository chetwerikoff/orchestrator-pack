import { describe, expect, it } from 'vitest';
import { aggregateChain, selectRowsForCostAggregation } from '../lib/aggregate.js';
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
          session_id: 'sess-planner',
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
          session_id: 'sess-worker',
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

  it('prefers ao-session-cost over later parsed cost-observed for the same session', () => {
    const rows = [
      row({
        session_id: 'sess-a',
        event_kind: 'finished',
        role: 'worker',
        timestamp: '2026-05-01T10:00:00.000Z',
        cost: {
          input_tokens: 100,
          output_tokens: 50,
          estimated_cost_usd: 1,
          source: 'ao-session-cost',
        },
      }),
      row({
        session_id: 'sess-a',
        event_kind: 'cost-observed',
        role: 'worker',
        timestamp: '2026-05-01T11:00:00.000Z',
        cost: {
          input_tokens: 999,
          output_tokens: 999,
          estimated_cost_usd: 9,
          source: 'agent-output-parse',
        },
      }),
    ];
    const billable = selectRowsForCostAggregation(rows);
    const sessionRow = [...billable].find((entry) => entry.session_id === 'sess-a');
    expect(sessionRow?.cost.source).toBe('ao-session-cost');

    const report = aggregateChain(rows, 'chain-a');
    expect(report.total_input_tokens).toBe(100);
    expect(report.total_estimated_cost_usd).toBe(1);
  });

  it('does not mark started+finished sessions as missing cost', () => {
    const report = aggregateChain(
      [
        row({ session_id: 'sess-a', event_kind: 'started', role: 'worker' }),
        row({
          session_id: 'sess-a',
          event_kind: 'finished',
          role: 'worker',
          cost: {
            input_tokens: 1,
            output_tokens: 1,
            estimated_cost_usd: 0.01,
            source: 'ao-session-cost',
          },
        }),
      ],
      'chain-a',
    );
    expect(report.missing_data.sessions_without_cost).toEqual([]);
    expect(report.missing_data.iterations_without_cost).toEqual([]);
  });

  it('marks sessions with no billable cost as missing after scanning all rows', () => {
    const report = aggregateChain(
      [
        row({ session_id: 'sess-stuck', event_kind: 'started', role: 'worker' }),
        row({ session_id: 'sess-stuck', event_kind: 'finding', role: 'worker' }),
      ],
      'chain-a',
    );
    expect(report.missing_data.sessions_without_cost).toEqual(['sess-stuck']);
  });

  it('dedupes session-level cost to one row per session_id', () => {
    const sessionCost = {
      input_tokens: 100,
      output_tokens: 50,
      estimated_cost_usd: 0.5,
      source: 'ao-session-cost' as const,
    };
    const rows = [
      row({
        session_id: 'sess-a',
        event_kind: 'started',
        role: 'worker',
        cost: sessionCost,
      }),
      row({
        session_id: 'sess-a',
        event_kind: 'finished',
        role: 'worker',
        timestamp: '2026-05-01T01:00:00.000Z',
        cost: sessionCost,
      }),
    ];
    const billable = selectRowsForCostAggregation(rows);
    expect(billable.size).toBe(1);
    expect([...billable][0]?.event_kind).toBe('finished');

    const report = aggregateChain(rows, 'chain-a');
    expect(report.total_input_tokens).toBe(100);
    expect(report.total_output_tokens).toBe(50);
    expect(report.total_estimated_cost_usd).toBe(0.5);
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
