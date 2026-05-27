export type ChainIdSource = 'ao' | 'issue' | 'pr' | 'wrapper_generated' | 'manual';
export type ParentSessionIdSource = 'ao' | 'inferred' | 'unavailable' | 'manual';
export type CostSource =
  | 'ao-session-cost'
  | 'agent-output-parse'
  | 'manual-import'
  | 'unavailable';

export interface StructuredFinding {
  type: string;
  code: string;
  severity: string;
  path: string | null;
  summary: string;
  details?: string;
  suggested_fix?: string;
  source: string;
  signature?: string;
}

export interface LedgerCost {
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  source: CostSource;
}

export interface LedgerRow {
  chain_id: string;
  chain_id_source: ChainIdSource;
  iteration_id: string | null;
  session_id: string | null;
  parent_session_id: string | null;
  parent_session_id_source: ParentSessionIdSource;
  task_id: string;
  event_kind: string;
  role: string;
  timestamp: string;
  finding: StructuredFinding | null;
  reaction: Record<string, unknown> | null;
  cost: LedgerCost;
}

export interface RoleBreakdown {
  role: string;
  event_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  cost_rows: number;
  unavailable_cost_rows: number;
}

export interface IterationBreakdown {
  iteration_id: string;
  event_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  unavailable_cost_rows: number;
}

export interface MissingDataReport {
  total_rows: number;
  unavailable_cost_rows: number;
  sessions_without_cost: string[];
  iterations_without_cost: string[];
}

export interface FindingSignatureCount {
  signature: string;
  count: number;
  type: string;
  code: string;
  path: string | null;
}

export interface ChainAggregateReport {
  chain_id: string;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_estimated_cost_usd: number | null;
  by_role: RoleBreakdown[];
  by_iteration: IterationBreakdown[];
  by_event_kind: Record<string, number>;
  unknown_event_kinds: string[];
  finding_signatures: FindingSignatureCount[];
  missing_data: MissingDataReport;
}
