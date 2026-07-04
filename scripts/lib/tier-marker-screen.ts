/**
 * Fail-closed red-flag marker screen (Issue #574 vocabulary, Issue #576 gate).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MARKER_HEURISTICS: Record<string, RegExp[]> = {
  'trust-boundary': [
    /\btrust[- ]boundary\b/i,
    /\b(auth(?:entication)?|permission)\b/i,
    /\btouches?\s+auth\b/i,
  ],
  'spawn-capability': [
    /\bspawn\s+grant\b/i,
    /\bcapability\s+grant\b/i,
    /\bgrants?\s+spawn\b/i,
    /\belevated\s+execution\b/i,
    /\bspawn[- ]capability\b/i,
  ],
  'concurrency-state-retry': [
    /\bconcurrency\b/i,
    /\bstate[- ]machine\b/i,
    /\bevent[- ]ordering\b/i,
    /\bretry\s+semantics\b/i,
    /\bshared[- ]machine\s+claim\b/i,
    /\bsingle[- ]winner\b/i,
  ],
  'ci-review-gating': [
    /\brequired\s+CI\b/i,
    /\bbranch\s+protection\b/i,
    /\bmerge\s+authorization\b/i,
    /\bfail[- ]closed\s+(?:required|check)/i,
    /\brequired\s+(?:status\s+)?checks?\s+for\s+merge\b/i,
    /\bci[- ]gate\b/i,
    /\bgating\b/i,
  ],
  'durable-state-evidence': [
    /\bdurable\s+state\b/i,
    /\boperator[- ]visible\s+(?:snapshot|ledger)\b/i,
    /\bprovenance\b/i,
    /\baudit\s+log\b/i,
    /\bevidence\s+ledger\b/i,
    /\bcontract[- ]evidence\s+ledger\b/i,
  ],
  'test-harness-correctness': [
    /\bfixture\s+isolation\b/i,
    /\bself[- ]certifying\s+test\b/i,
    /\blive\s+(?:AO\s+)?session\s+state\b/i,
    /\breal[- ]vs[- ]stub\b/i,
    /\btouching\s+live\s+state\b/i,
  ],
  'crash-recovery': [
    /\bcrash\/recovery\b/i,
    /\borphaned\s+claims?\b/i,
    /\bduplicate\s+execution\b/i,
    /\bliveness\/kill[- ]restart\b/i,
    /\brestart\s+mid[- ]phase\b/i,
  ],
  'external-api-transport': [
    /\bretry\/backoff\b/i,
    /\brate[- ]limit\s+fallback\b/i,
    /\bexternal[- ]API\s+transport\b/i,
    /\bresponse[- ]shape\s+assumptions?\b/i,
    /\bREST\s+wrapper\s+retry\b/i,
  ],
  'shared-contract-dependency': [
    /\bshared[- ]contract\b/i,
    /\bnew\s+contract\b/i,
    /\b≥\s*2\s+future\s+issues\b/i,
    /\b>=\s*2\s+future\s+issues\b/i,
  ],
  'multi-surface': [
    /\bmultiple\s+otherwise[- ]independent\s+surfaces\b/i,
    /\bspans?\s+multiple\s+surfaces\b/i,
    /\bmulti[- ]surface\b/i,
  ],
  ambiguity: [
    /\bgenuine\s+ambiguity\b/i,
    /\bleaves?\s+ambiguity\b/i,
    /\bambiguous\s+scope\b/i,
  ],
};

let cachedMarkerClasses: string[] | null = null;

export function loadMarkerClasses(repoRoot = join(__dirname, '..', '..')): string[] {
  if (cachedMarkerClasses) {
    return cachedMarkerClasses;
  }
  const samplePath = join(
    repoRoot,
    'tests/fixtures/task-complexity-tier-calibration.json',
  );
  const doc = JSON.parse(readFileSync(samplePath, 'utf8')) as { markerClasses?: string[] };
  if (!Array.isArray(doc.markerClasses) || doc.markerClasses.length === 0) {
    throw new Error('task-complexity-tier-calibration.json missing markerClasses');
  }
  cachedMarkerClasses = doc.markerClasses;
  return cachedMarkerClasses;
}

export function resetMarkerClassCache(): void {
  cachedMarkerClasses = null;
}

export interface MarkerScreenResult {
  hits: string[];
  unparseable: boolean;
}

export function screenRedFlagMarkers(
  text: string,
  opts: { repoRoot?: string } = {},
): MarkerScreenResult {
  const markerClasses = loadMarkerClasses(opts.repoRoot);
  const hits: string[] = [];
  for (const markerClass of markerClasses) {
    const patterns = MARKER_HEURISTICS[markerClass];
    if (!patterns) {
      return { hits: [], unparseable: true };
    }
    if (patterns.some((pattern) => pattern.test(text))) {
      hits.push(markerClass);
    }
  }
  return { hits, unparseable: false };
}
