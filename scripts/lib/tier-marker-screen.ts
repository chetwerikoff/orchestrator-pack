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
    /\btrust[- ]boundary\s+surfaces?\b/i,
    /\b(?:auth(?:entication)?|permission)\s+surfaces?\b/i,
    /\b(?:auth(?:entication)?|permission)\b/i,
    /\btouches?\s+(?:auth|permission)\b/i,
  ],
  'spawn-capability': [
    /\bspawn\s+grant\b/i,
    /\bspawn\s+grants?\b/i,
    /\bcapability\s+grant\b/i,
    /\bgrants?\s+(?:spawn|capabilit(?:y|ies))\b/i,
    /\belevated\s+execution\b/i,
    /\bspawn[- ]capabilit(?:y|ies)\b/i,
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
    /\brequired\s+checks?\b/i,
    /\bbranch\s+protection\b/i,
    /\bmerge\s+authorization\b/i,
    /\bfail[- ]closed\s+(?:required|check|aggregation)\b/i,
    /\bfail[- ]closed\s+check\s+aggregation\b/i,
    /\brequired\s+(?:status\s+)?checks?\s+for\s+merge\b/i,
    /\bci[- ]gate\b/i,
    /\breview\s+gating\b/i,
    /\bgating\b/i,
  ],
  'durable-state-evidence': [
    /\bdurable\s+state\b/i,
    /\bmutates?\s+(?:durable\s+state|evidence|provenance)\b/i,
    /\boperator[- ]visible\s+(?:snapshot|ledger|state)\b/i,
    /\boperator[- ]visible\s+state\s+mutation\b/i,
    /\bprovenance\b/i,
    /\baudit\s+log\b/i,
    /\bevidence\s+ledger\b/i,
    /\bcontract[- ]evidence\s+ledger\b/i,
    /\bledgers?\b/i,
  ],
  'test-harness-correctness': [
    /\bfixture\s+isolation\b/i,
    /\bself[- ]certifying\s+tests?\b/i,
    /\blive\s+(?:AO\s+)?session\s+state\b/i,
    /\breal[- ]vs[- ]stub\s+binar(?:y|ies)\b/i,
    /\bprove(?:s|d)?\s+the\s+wrong\s+thing\b/i,
    /\btouch(?:ing|es)?\s+live\s+state\b/i,
  ],
  'crash-recovery': [
    /\bcrash\/recovery\b/i,
    /\borphaned\s+(?:claims?|processes?)\b/i,
    /\bstuck\s+(?:or\s+)?orphaned\b/i,
    /\bduplicate\s+execution\b/i,
    /\bliveness\b/i,
    /\bkill[- ]restart\b/i,
    /\bliveness\/kill[- ]restart\b/i,
    /\brestart\s+mid[- ]phase\b/i,
    /\bthresholds?\s+(?:and\s+)?timeouts?\b/i,
  ],
  'external-api-transport': [
    /\bretry\/backoff\b/i,
    /\bretry\s+semantics\b/i,
    /\bfallback\b/i,
    /\brate[- ]limit\b/i,
    /\brate[- ]limit\s+fallback\b/i,
    /\btimeout\s+semantics\b/i,
    /\btimeout\b/i,
    /\bexternal[- ]API\s+transport\b/i,
    /\btransport\s+behavior\b/i,
    /\bresponse[- ]shape\s+assumptions?\b/i,
    /\bREST\s+wrapper\s+retry\b/i,
  ],
  'shared-contract-dependency': [
    /\bshared[- ]contract\b/i,
    /\bintroduces?\s+a\s+new\s+contract\b/i,
    /\bnew\s+contract\b[^.\n]{0,80}(?:≥|>=)\s*2\s+future\s+issues\b/i,
    /\b≥\s*2\s+future\s+issues\b/i,
    /\b>=\s*2\s+future\s+issues\b/i,
  ],
  'multi-surface': [
    /\bmultiple\s+otherwise[- ]independent\s+surfaces\b/i,
    /\bspans?\s+multiple\s+(?:otherwise[- ]independent\s+)?surfaces\b/i,
    /\bmulti[- ]surface\b/i,
  ],
  ambiguity: [
    /\bgenuine\s+ambiguity\b/i,
    /\bgenuine\s+ambiguity\s+in\b/i,
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
