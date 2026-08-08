import type { LedgerRow } from '../lib/types.js';

export function ledgerTestRow(
  overrides: Partial<LedgerRow> & Pick<LedgerRow, 'event_kind' | 'role'>,
  defaults: Partial<LedgerRow> = {},
): LedgerRow {
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
    ...defaults,
    ...overrides,
  };
}
