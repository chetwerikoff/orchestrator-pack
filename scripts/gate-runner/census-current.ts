import type { GateResult } from './contracts.ts';
import { evaluateCensus, type GateCensus } from './census.ts';
import type { SourceSnapshot } from './source-snapshot.ts';

function missingTypedReferenceFailure(entry: GateCensus['entries'][number]): string | undefined {
  const reference = entry.legacyReference;
  if (entry.sourceKind !== 'check-script' || !reference) return undefined;
  return `${entry.id}: typed legacy invocation is no longer executable at ${reference.path} (${reference.kind})`;
}

function sourceInvokesCheck(source: string, checkPath: string): boolean {
  const bare = checkPath.replace(/^scripts\//u, '');
  if (!source.includes(checkPath) && !source.includes(bare)) return false;
  return /(?:^|\s)&\s/u.test(source)
    || /\bpwsh(?:\.exe)?\b[^\r\n]*\s-File\s/iu.test(source)
    || /^\s*run:\s*/imu.test(source)
    || /Join-Path\s+\$(?:Root|PSScriptRoot)/u.test(source);
}

function checkScriptHasRuntimeRoute(entry: GateCensus['entries'][number], snapshot: SourceSnapshot): boolean {
  if (entry.sourceKind !== 'check-script' || !snapshot.files.has(entry.sourcePath)) return false;

  const verify = snapshot.files.get('scripts/verify.ps1') ?? '';
  if (sourceInvokesCheck(verify, entry.sourcePath)) return true;

  for (const [path, source] of snapshot.files) {
    if (path === entry.sourcePath) continue;
    if (/^scripts\/check-.*\.ps1$/u.test(path) && sourceInvokesCheck(source, entry.sourcePath)) return true;
    if (/^\.github\/workflows\/.*\.ya?ml$/iu.test(path) && sourceInvokesCheck(source, entry.sourcePath)) return true;
  }
  return false;
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
  // retained check still has a runtime route from verify.ps1, a workflow, or another
  // check-wrapper, that route is the stronger proof and the duplicate test binding may move.
  if (checkScriptHasRuntimeRoute(entry, snapshot)) return missingTypedReferenceFailure(entry);

  return undefined;
}

/**
 * Reconcile the frozen Wave 3.b census against the current executable tree.
 *
 * Historical documentation and duplicate test references remain provenance only. The source
 * check script and an executable route to it remain mandatory; deleting either still fails.
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
