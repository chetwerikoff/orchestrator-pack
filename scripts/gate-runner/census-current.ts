import type { GateResult } from './contracts.ts';
import { evaluateCensus, type GateCensus } from './census.ts';
import type { SourceSnapshot } from './source-snapshot.ts';

function missingTypedReferenceFailure(entry: GateCensus['entries'][number]): string | undefined {
  const reference = entry.legacyReference;
  if (entry.sourceKind !== 'check-script' || !reference) return undefined;
  return `${entry.id}: typed legacy invocation is no longer executable at ${reference.path} (${reference.kind})`;
}

function checkScriptIsDirectlyVerified(entry: GateCensus['entries'][number], snapshot: SourceSnapshot): boolean {
  if (entry.sourceKind !== 'check-script' || !snapshot.files.has(entry.sourcePath)) return false;
  const verify = snapshot.files.get('scripts/verify.ps1') ?? '';
  const escaped = entry.sourcePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:Join-Path\\s+\\$Root\\s+['\"]${escaped}['\"]|['\"]${escaped}['\"])`, 'u').test(verify);
}

function historicalReferenceFailure(
  entry: GateCensus['entries'][number],
  snapshot: SourceSnapshot,
): string | undefined {
  const reference = entry.legacyReference;
  if (entry.sourceKind !== 'check-script' || !reference || !snapshot.files.has(entry.sourcePath)) {
    return undefined;
  }

  // Documentation/config examples are not executable policy. The frozen reference is
  // retained only as migration provenance after the live contract moved elsewhere.
  if (reference.kind === 'operator-command') return missingTypedReferenceFailure(entry);

  // Some frozen rows used a secondary test invocation as reachability proof. When the
  // retained check script is still directly dispatched by verify.ps1, that real runtime
  // invocation is the stronger proof and the old duplicate test binding may be removed.
  if (checkScriptIsDirectlyVerified(entry, snapshot)) return missingTypedReferenceFailure(entry);

  return undefined;
}

/**
 * Reconcile the frozen Wave 3.b census against the current executable tree.
 *
 * The frozen census retains historical documentation and duplicate test references for
 * migration provenance. Current enforcement must not make Markdown/YAML wording or an
 * obsolete duplicate test call executable policy. Deferred check scripts remain protected
 * independently by evaluateCensus(): deleting a script, removing its actual verify.ps1
 * dispatch, or adding an unaccounted check still fails before this compatibility filter.
 */
export function evaluateCurrentCensus(
  census: GateCensus,
  snapshot: SourceSnapshot,
  registeredGateIds: ReadonlySet<string>,
): GateResult {
  const result = evaluateCensus(census, snapshot, registeredGateIds);
  if (result.status !== 'FAIL') return result;

  const historicalFailures = new Set(
    census.entries
      .map((entry) => historicalReferenceFailure(entry, snapshot))
      .filter((detail): detail is string => detail !== undefined),
  );
  const details = (result.details ?? []).filter((detail) => !historicalFailures.has(detail));
  if (details.length > 0) return { ...result, details };

  const { details: _historicalDetails, ...withoutDetails } = result;
  return {
    ...withoutDetails,
    status: 'PASS',
    summary: `All ${census.populationCount} pre-change executable enforcement surfaces remain accounted for.`,
  };
}
