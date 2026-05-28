import { computeConvergence, formatConvergenceReport } from './convergence.js';
import { computeFindingSignature } from './finding_signature.js';
import { RECOGNIZED_EVENT_KINDS } from './event_kinds.js';
import type {
  ChainAggregateReport,
  FindingSignatureCount,
  IterationBreakdown,
  LedgerCost,
  LedgerRow,
  MissingDataReport,
  RoleBreakdown,
} from './types.js';

function addNullable(current: number | null, delta: number | null): number | null {
  if (delta === null) {
    return current;
  }
  return (current ?? 0) + delta;
}

function costHasData(cost: LedgerCost): boolean {
  return (
    cost.input_tokens !== null ||
    cost.output_tokens !== null ||
    cost.estimated_cost_usd !== null
  );
}

function accumulateCost(
  totals: { input: number | null; output: number | null; usd: number | null },
  cost: LedgerCost,
): { input: number | null; output: number | null; usd: number | null } {
  if (!costHasData(cost)) {
    return totals;
  }
  return {
    input: addNullable(totals.input, cost.input_tokens),
    output: addNullable(totals.output, cost.output_tokens),
    usd: addNullable(totals.usd, cost.estimated_cost_usd),
  };
}

function signatureForRow(row: LedgerRow): string | null {
  if (!row.finding) {
    return null;
  }
  return row.finding.signature ?? computeFindingSignature(row.finding);
}

function isSessionLevelCostSource(source: LedgerCost['source']): boolean {
  return source === 'ao-session-cost' || source === 'agent-output-parse';
}

function sessionCostSourcePriority(source: LedgerCost['source']): number {
  if (source === 'ao-session-cost') {
    return 3;
  }
  if (source === 'agent-output-parse') {
    return 2;
  }
  return 1;
}

function sessionCostEventKindPriority(eventKind: string): number {
  if (eventKind === 'finished') {
    return 2;
  }
  if (eventKind === 'cost-observed') {
    return 1;
  }
  return 0;
}

function pickSessionCostWinner(a: LedgerRow, b: LedgerRow): LedgerRow {
  const sourceDelta =
    sessionCostSourcePriority(b.cost.source) - sessionCostSourcePriority(a.cost.source);
  if (sourceDelta !== 0) {
    return sourceDelta > 0 ? b : a;
  }
  const kindDelta =
    sessionCostEventKindPriority(b.event_kind) - sessionCostEventKindPriority(a.event_kind);
  if (kindDelta !== 0) {
    return kindDelta > 0 ? b : a;
  }
  return a.timestamp >= b.timestamp ? a : b;
}

/** At most one session-level cost row per session_id; manual-import rows always count. */
export function selectRowsForCostAggregation(rows: LedgerRow[]): Set<LedgerRow> {
  const billable = new Set<LedgerRow>();
  const sessionWinners = new Map<string, LedgerRow>();

  for (const row of rows) {
    if (row.cost.source === 'unavailable' || !costHasData(row.cost)) {
      continue;
    }
    if (row.cost.source === 'manual-import') {
      billable.add(row);
      continue;
    }
    if (!isSessionLevelCostSource(row.cost.source)) {
      billable.add(row);
      continue;
    }
    if (!row.session_id) {
      billable.add(row);
      continue;
    }
    const previous = sessionWinners.get(row.session_id);
    sessionWinners.set(
      row.session_id,
      previous ? pickSessionCostWinner(previous, row) : row,
    );
  }

  for (const row of sessionWinners.values()) {
    billable.add(row);
  }
  return billable;
}

export function aggregateChain(rows: LedgerRow[], chainId: string): ChainAggregateReport {
  const chainRows = rows.filter((row) => row.chain_id === chainId);
  const billableCostRows = selectRowsForCostAggregation(chainRows);

  const byRole = new Map<string, RoleBreakdown>();
  const byIteration = new Map<string, IterationBreakdown>();
  const byEventKind: Record<string, number> = {};
  const unknownEventKinds = new Set<string>();
  const signatureCounts = new Map<string, FindingSignatureCount>();

  let totalInput: number | null = null;
  let totalOutput: number | null = null;
  let totalUsd: number | null = null;
  let unavailableCostRows = 0;

  for (const row of chainRows) {
    byEventKind[row.event_kind] = (byEventKind[row.event_kind] ?? 0) + 1;
    if (!RECOGNIZED_EVENT_KINDS.has(row.event_kind)) {
      unknownEventKinds.add(row.event_kind);
    }

    const roleKey = row.role;
    const roleEntry =
      byRole.get(roleKey) ??
      ({
        role: roleKey,
        event_count: 0,
        input_tokens: null,
        output_tokens: null,
        estimated_cost_usd: null,
        cost_rows: 0,
        unavailable_cost_rows: 0,
      } satisfies RoleBreakdown);
    roleEntry.event_count += 1;

    const iterationKey = row.iteration_id ?? '(none)';
    const iterationEntry =
      byIteration.get(iterationKey) ??
      ({
        iteration_id: iterationKey,
        event_count: 0,
        input_tokens: null,
        output_tokens: null,
        estimated_cost_usd: null,
        unavailable_cost_rows: 0,
      } satisfies IterationBreakdown);
    iterationEntry.event_count += 1;

    if (row.cost.source === 'unavailable' || !costHasData(row.cost)) {
      unavailableCostRows += 1;
      roleEntry.unavailable_cost_rows += 1;
      iterationEntry.unavailable_cost_rows += 1;
    } else if (billableCostRows.has(row)) {
      roleEntry.cost_rows += 1;
      const roleTotals = accumulateCost(
        {
          input: roleEntry.input_tokens,
          output: roleEntry.output_tokens,
          usd: roleEntry.estimated_cost_usd,
        },
        row.cost,
      );
      roleEntry.input_tokens = roleTotals.input;
      roleEntry.output_tokens = roleTotals.output;
      roleEntry.estimated_cost_usd = roleTotals.usd;

      const iterTotals = accumulateCost(
        {
          input: iterationEntry.input_tokens,
          output: iterationEntry.output_tokens,
          usd: iterationEntry.estimated_cost_usd,
        },
        row.cost,
      );
      iterationEntry.input_tokens = iterTotals.input;
      iterationEntry.output_tokens = iterTotals.output;
      iterationEntry.estimated_cost_usd = iterTotals.usd;

      const chainTotals = accumulateCost(
        { input: totalInput, output: totalOutput, usd: totalUsd },
        row.cost,
      );
      totalInput = chainTotals.input;
      totalOutput = chainTotals.output;
      totalUsd = chainTotals.usd;
    }

    byRole.set(roleKey, roleEntry);
    byIteration.set(iterationKey, iterationEntry);

    const signature = signatureForRow(row);
    if (signature && row.finding) {
      const existing = signatureCounts.get(signature);
      if (existing) {
        existing.count += 1;
      } else {
        signatureCounts.set(signature, {
          signature,
          count: 1,
          type: row.finding.type,
          code: row.finding.code,
          path: row.finding.path,
        });
      }
    }
  }

  const sessionsWithBillableCost = new Set<string>();
  const iterationsWithBillableCost = new Set<string>();
  for (const row of billableCostRows) {
    if (row.session_id) {
      sessionsWithBillableCost.add(row.session_id);
    }
    if (row.iteration_id) {
      iterationsWithBillableCost.add(row.iteration_id);
    }
  }

  const sessionsSeen = new Set(
    chainRows.map((row) => row.session_id).filter((id): id is string => Boolean(id)),
  );
  const iterationsSeen = new Set(
    chainRows.map((row) => row.iteration_id).filter((id): id is string => Boolean(id)),
  );

  const missing_data: MissingDataReport = {
    total_rows: chainRows.length,
    unavailable_cost_rows: unavailableCostRows,
    sessions_without_cost: [...sessionsSeen]
      .filter((sessionId) => !sessionsWithBillableCost.has(sessionId))
      .sort(),
    iterations_without_cost: [...iterationsSeen]
      .filter((iterationId) => !iterationsWithBillableCost.has(iterationId))
      .sort(),
  };

  const baseReport = {
    chain_id: chainId,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_estimated_cost_usd: totalUsd,
    by_role: [...byRole.values()].sort((a, b) => a.role.localeCompare(b.role)),
    by_iteration: [...byIteration.values()].sort((a, b) =>
      a.iteration_id.localeCompare(b.iteration_id),
    ),
    by_event_kind: byEventKind,
    unknown_event_kinds: [...unknownEventKinds].sort(),
    finding_signatures: [...signatureCounts.values()].sort((a, b) =>
      b.count - a.count || a.signature.localeCompare(b.signature),
    ),
    missing_data,
  };

  return {
    ...baseReport,
    convergence: computeConvergence(chainRows, chainId, { missingData: missing_data }),
  };
}

export function formatChainReport(report: ChainAggregateReport): string {
  const lines: string[] = [
    `Chain report: ${report.chain_id}`,
    '',
    'Totals',
    `  input_tokens: ${report.total_input_tokens ?? 'null'}`,
    `  output_tokens: ${report.total_output_tokens ?? 'null'}`,
    `  estimated_cost_usd: ${report.total_estimated_cost_usd ?? 'null'}`,
    '',
    'By role',
  ];

  for (const role of report.by_role) {
    lines.push(
      `  ${role.role}: events=${role.event_count} in=${role.input_tokens ?? 'null'} out=${role.output_tokens ?? 'null'} usd=${role.estimated_cost_usd ?? 'null'} unavailable_cost_rows=${role.unavailable_cost_rows}`,
    );
  }

  lines.push('', 'By iteration');
  for (const iteration of report.by_iteration) {
    lines.push(
      `  ${iteration.iteration_id}: events=${iteration.event_count} in=${iteration.input_tokens ?? 'null'} out=${iteration.output_tokens ?? 'null'} usd=${iteration.estimated_cost_usd ?? 'null'} unavailable=${iteration.unavailable_cost_rows}`,
    );
  }

  lines.push('', 'By event_kind');
  for (const [kind, count] of Object.entries(report.by_event_kind).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push(`  ${kind}: ${count}`);
  }

  if (report.unknown_event_kinds.length > 0) {
    lines.push('', 'Unknown event_kind (preserved)');
    for (const kind of report.unknown_event_kinds) {
      lines.push(`  ${kind}`);
    }
  }

  lines.push('', 'Finding signature recurrence');
  if (report.finding_signatures.length === 0) {
    lines.push('  (none)');
  } else {
    for (const entry of report.finding_signatures) {
      lines.push(
        `  ${entry.signature.slice(0, 12)}… count=${entry.count} type=${entry.type} code=${entry.code} path=${entry.path ?? 'null'}`,
      );
    }
  }

  lines.push('', 'Missing data');
  lines.push(`  total_rows: ${report.missing_data.total_rows}`);
  lines.push(`  unavailable_cost_rows: ${report.missing_data.unavailable_cost_rows}`);
  lines.push(
    `  sessions_without_cost: ${report.missing_data.sessions_without_cost.join(', ') || '(none)'}`,
  );
  lines.push(
    `  iterations_without_cost: ${report.missing_data.iterations_without_cost.join(', ') || '(none)'}`,
  );

  lines.push('', formatConvergenceReport(report.convergence));

  return lines.join('\n');
}
