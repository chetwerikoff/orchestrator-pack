import type { GateResult } from './contracts.ts';
import { evaluateCensus, type GateCensus } from './census.ts';
import type { SourceSnapshot } from './source-snapshot.ts';

function operatorDocumentationFailure(entry: GateCensus['entries'][number]): string | undefined {
  const reference = entry.legacyReference;
  if (entry.sourceKind !== 'check-script' || reference?.kind !== 'operator-command') return undefined;
  return `${entry.id}: typed legacy invocation is no longer executable at ${reference.path} (operator-command)`;
}

/**
 * Reconcile the frozen Wave 3.b census against the current executable tree.
 *
 * The frozen census retains historical operator-command references for migration
 * provenance. Those references used to prove a gate by requiring an exact command in
 * Markdown or YAML. Current enforcement must not make documentation wording executable
 * policy. Deferred check scripts remain protected independently by evaluateCensus():
 * deleting the actual scripts still fails before this compatibility filter is applied.
 */
export function evaluateCurrentCensus(
  census: GateCensus,
  snapshot: SourceSnapshot,
  registeredGateIds: ReadonlySet<string>,
): GateResult {
  const result = evaluateCensus(census, snapshot, registeredGateIds);
  if (result.status !== 'FAIL') return result;

  const historicalOperatorFailures = new Set(
    census.entries
      .filter((entry) => snapshot.files.has(entry.sourcePath))
      .map(operatorDocumentationFailure)
      .filter((detail): detail is string => detail !== undefined),
  );
  const details = (result.details ?? []).filter((detail) => !historicalOperatorFailures.has(detail));
  if (details.length > 0) return { ...result, details };

  return {
    ...result,
    status: 'PASS',
    summary: `All ${census.populationCount} pre-change executable enforcement surfaces remain accounted for.`,
    details: undefined,
  };
}
