import '../toolchain/native-entrypoint-preflight.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLEANUP_FIXTURE_IDS, ACCEPTANCE_SCENARIOS, IMPLEMENTATION_EVIDENCE, REQUIRED_SCENARIO_IDS } from '../lib/launch-watch/fixtures.ts';

export type AggregateProof = {
  readonly ok: boolean;
  readonly acceptanceCount: number;
  readonly scenarioCount: number;
  readonly fixtureCount: number;
  readonly errors: readonly string[];
};

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) result.push(value);
    seen.add(value);
  }
  return result;
}

function exactSet(label: string, expected: readonly string[], actual: readonly string[], errors: string[]): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  for (const value of expectedSet) if (!actualSet.has(value)) errors.push(`${label}:missing:${value}`);
  for (const value of actualSet) if (!expectedSet.has(value)) errors.push(`${label}:extra:${value}`);
  for (const value of duplicates(actual)) errors.push(`${label}:duplicate:${value}`);
}

function discoverExecutableCoverage(repoRoot: string): {
  readonly acceptanceIds: readonly string[];
  readonly scenarioIds: readonly string[];
  readonly fixtureIds: readonly string[];
} {
  const testSources = ['scripts/launch-watch/launch-watch.test.ts', 'scripts/launch-watch/watch.test.ts']
    .map((relativePath) => {
      try { return readFileSync(join(repoRoot, relativePath), 'utf8'); } catch { return ''; }
    })
    .join('\n');
  return {
    acceptanceIds: testSources.includes('ACCEPTANCE_SCENARIOS.map') ? ACCEPTANCE_SCENARIOS.map((entry) => entry.split(':', 1)[0] ?? '') : [],
    scenarioIds: testSources.includes('REQUIRED_SCENARIO_IDS.map') ? REQUIRED_SCENARIO_IDS : [],
    fixtureIds: testSources.includes('CLEANUP_FIXTURE_IDS.map') ? CLEANUP_FIXTURE_IDS : [],
  };
}

export function runAggregateProof(options: { readonly zeroCoverage?: boolean; readonly repoRoot?: string } = {}): AggregateProof {
  const errors: string[] = [];
  const expectedAcceptanceIds = ACCEPTANCE_SCENARIOS.map((entry) => entry.split(':', 1)[0] ?? '');
  const discovered = options.zeroCoverage
    ? { acceptanceIds: [], scenarioIds: [], fixtureIds: [] }
    : discoverExecutableCoverage(options.repoRoot ?? process.cwd());
  exactSet('acceptance', expectedAcceptanceIds, discovered.acceptanceIds, errors);
  exactSet('cleanup-fixture', CLEANUP_FIXTURE_IDS, discovered.fixtureIds, errors);
  exactSet('scenario', REQUIRED_SCENARIO_IDS, discovered.scenarioIds, errors);
  exactSet('implementation-acceptance', expectedAcceptanceIds, IMPLEMENTATION_EVIDENCE.map((entry) => entry.acceptanceId), errors);
  exactSet('implementation-scenario', REQUIRED_SCENARIO_IDS, IMPLEMENTATION_EVIDENCE.flatMap((entry) => entry.scenarioIds), errors);
  exactSet('implementation-fixture', CLEANUP_FIXTURE_IDS, IMPLEMENTATION_EVIDENCE.flatMap((entry) => entry.fixtureIds ?? []), errors);
  if (CLEANUP_FIXTURE_IDS.length === 0) errors.push('cleanup-fixture:zero-coverage');
  if (options.zeroCoverage || REQUIRED_SCENARIO_IDS.length === 0) errors.push('scenario:zero-coverage');
  for (const entry of IMPLEMENTATION_EVIDENCE) {
    if (!entry.redThenGreen) errors.push(`${entry.acceptanceId}:missing-red-then-green`);
    if (entry.scenarioIds.length === 0) errors.push(`${entry.acceptanceId}:zero-coverage`);
  }
  return {
    ok: errors.length === 0,
    acceptanceCount: 8,
    scenarioCount: REQUIRED_SCENARIO_IDS.length,
    fixtureCount: CLEANUP_FIXTURE_IDS.length,
    errors,
  };
}

async function main(): Promise<void> {
  const proof = runAggregateProof({ zeroCoverage: process.argv.includes('--zero-coverage') });
  process.stdout.write(`${JSON.stringify(proof)}\n`);
  if (!proof.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
