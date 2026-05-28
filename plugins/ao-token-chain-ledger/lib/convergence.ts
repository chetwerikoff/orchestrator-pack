import { computeFindingSignature } from './finding_signature.js';
import type {
  ConvergenceFinalState,
  ConvergenceReport,
  ConvergenceReportConfig,
  IterationBlockingFindings,
  LedgerRow,
  MissingDataReport,
  RepeatedSignatureReport,
  StructuredFinding,
} from './types.js';

const DEFAULT_REPEATED_SIGNATURE_ITERATION_THRESHOLD = 2;

function signatureForFinding(finding: StructuredFinding): string {
  return finding.signature ?? computeFindingSignature(finding);
}

function isBlockingFinding(finding: StructuredFinding): boolean {
  return finding.severity === 'blocking';
}

function isScopeViolation(finding: StructuredFinding): boolean {
  return finding.type === 'scope-violation';
}

function isCiFailureFinding(finding: StructuredFinding): boolean {
  return finding.type === 'ci' && isBlockingFinding(finding);
}

function reactionIndicatesCiFailure(reaction: Record<string, unknown> | null): boolean {
  if (!reaction) {
    return false;
  }
  const trigger = reaction.trigger ?? reaction.name ?? reaction.kind ?? reaction.event;
  const normalized = String(trigger).toLowerCase().replace(/_/g, '-');
  return normalized === 'ci-failed' || normalized.includes('ci-failed');
}

function orderedIterationIds(rows: LedgerRow[]): string[] {
  const firstSeen = new Map<string, string>();
  for (const row of rows) {
    if (!row.iteration_id) {
      continue;
    }
    const previous = firstSeen.get(row.iteration_id);
    if (!previous || row.timestamp < previous) {
      firstSeen.set(row.iteration_id, row.timestamp);
    }
  }
  return [...firstSeen.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
    .map(([iterationId]) => iterationId);
}

function rowsForIteration(rows: LedgerRow[], iterationId: string): LedgerRow[] {
  return rows.filter((row) => row.iteration_id === iterationId);
}

function iterationHasScopeViolation(rows: LedgerRow[]): boolean {
  return rows.some(
    (row) => row.event_kind === 'finding' && row.finding && isScopeViolation(row.finding),
  );
}

function iterationHasCiFailure(rows: LedgerRow[]): boolean {
  if (
    rows.some(
      (row) => row.event_kind === 'finding' && row.finding && isCiFailureFinding(row.finding),
    )
  ) {
    return true;
  }
  return rows.some(
    (row) => row.event_kind === 'reaction' && reactionIndicatesCiFailure(row.reaction),
  );
}

function iterationBlockingFindingCount(rows: LedgerRow[]): number {
  return rows.filter(
    (row) => row.event_kind === 'finding' && row.finding && isBlockingFinding(row.finding),
  ).length;
}

export function isIterationConverged(rows: LedgerRow[]): boolean {
  return (
    iterationBlockingFindingCount(rows) === 0 &&
    !iterationHasScopeViolation(rows) &&
    !iterationHasCiFailure(rows)
  );
}

function detectRepeatedSignatures(rows: LedgerRow[]): RepeatedSignatureReport[] {
  const bySignature = new Map<string, Map<string, number>>();

  for (const row of rows) {
    if (row.event_kind !== 'finding' || !row.finding || !row.iteration_id) {
      continue;
    }
    const signature = signatureForFinding(row.finding);
    const perIteration = bySignature.get(signature) ?? new Map<string, number>();
    perIteration.set(row.iteration_id, (perIteration.get(row.iteration_id) ?? 0) + 1);
    bySignature.set(signature, perIteration);
  }

  return [...bySignature.entries()]
    .map(([signature, perIteration]) => {
      const iterations = [...perIteration.keys()].sort();
      const occurrence_count = [...perIteration.values()].reduce((sum, count) => sum + count, 0);
      return { signature, iterations, occurrence_count };
    })
    .filter((entry) => entry.iterations.length >= 2)
    .sort(
      (a, b) =>
        b.iterations.length - a.iterations.length ||
        b.occurrence_count - a.occurrence_count ||
        a.signature.localeCompare(b.signature),
    );
}

function computeFinalState(
  rows: LedgerRow[],
  iterationIds: string[],
): ConvergenceFinalState {
  if (rows.some((row) => row.event_kind === 'escalation')) {
    return 'escalated';
  }

  const lastIterationId = iterationIds.at(-1);
  if (!lastIterationId) {
    return 'abandoned';
  }

  if (isIterationConverged(rowsForIteration(rows, lastIterationId))) {
    return 'converged';
  }

  return 'abandoned';
}

function buildAnalyticalWarnings(
  repeatedSignatures: RepeatedSignatureReport[],
  config: ConvergenceReportConfig,
): string[] {
  const threshold =
    config.repeated_signature_iteration_threshold ??
    DEFAULT_REPEATED_SIGNATURE_ITERATION_THRESHOLD;
  const warnings: string[] = [];

  for (const entry of repeatedSignatures) {
    if (entry.iterations.length >= threshold) {
      warnings.push(
        `signature ${entry.signature.slice(0, 12)}… recurred across ${entry.iterations.length} iterations (${entry.iterations.join(', ')})`,
      );
    }
  }

  return warnings;
}

export function computeConvergence(
  rows: LedgerRow[],
  chainId: string,
  options: {
    missingData: MissingDataReport;
    config?: ConvergenceReportConfig;
  },
): ConvergenceReport {
  const chainRows = rows.filter((row) => row.chain_id === chainId);
  const iterationIds = orderedIterationIds(chainRows);
  const repeated_signatures = detectRepeatedSignatures(chainRows);
  const config = options.config ?? {};

  const blocking_findings_by_iteration: IterationBlockingFindings[] = iterationIds.map(
    (iteration_id) => ({
      iteration_id,
      blocking_findings: iterationBlockingFindingCount(rowsForIteration(chainRows, iteration_id)),
    }),
  );

  return {
    chain_id: chainId,
    total_iterations: iterationIds.length,
    blocking_findings_by_iteration,
    repeated_signatures,
    final_state: computeFinalState(chainRows, iterationIds),
    missing_cost_summary: options.missingData,
    analytical_warnings: buildAnalyticalWarnings(repeated_signatures, config),
  };
}

export function formatConvergenceReport(report: ConvergenceReport): string {
  const lines: string[] = [
    'Convergence',
    `  final_state: ${report.final_state}`,
    `  total_iterations: ${report.total_iterations}`,
    '',
    'Blocking findings by iteration',
  ];

  if (report.blocking_findings_by_iteration.length === 0) {
    lines.push('  (none)');
  } else {
    for (const entry of report.blocking_findings_by_iteration) {
      lines.push(`  ${entry.iteration_id}: ${entry.blocking_findings}`);
    }
  }

  lines.push('', 'Repeated signatures across iterations');
  if (report.repeated_signatures.length === 0) {
    lines.push('  (none)');
  } else {
    for (const entry of report.repeated_signatures) {
      lines.push(
        `  ${entry.signature.slice(0, 12)}… iterations=[${entry.iterations.join(', ')}] occurrences=${entry.occurrence_count}`,
      );
    }
  }

  lines.push('', 'Missing cost summary');
  lines.push(`  unavailable_cost_rows: ${report.missing_cost_summary.unavailable_cost_rows}`);
  lines.push(
    `  sessions_without_cost: ${report.missing_cost_summary.sessions_without_cost.join(', ') || '(none)'}`,
  );
  lines.push(
    `  iterations_without_cost: ${report.missing_cost_summary.iterations_without_cost.join(', ') || '(none)'}`,
  );

  if (report.analytical_warnings.length > 0) {
    lines.push('', 'Analytical warnings');
    for (const warning of report.analytical_warnings) {
      lines.push(`  ${warning}`);
    }
  }

  return lines.join('\n');
}
