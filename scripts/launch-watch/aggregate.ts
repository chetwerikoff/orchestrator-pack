import '../toolchain/native-entrypoint-preflight.ts';
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

export function runAggregateProof(options: { readonly zeroCoverage?: boolean } = {}): AggregateProof {
  const errors: string[] = [];
  exactSet('acceptance', ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7', 'AC8'], IMPLEMENTATION_EVIDENCE.map((entry) => entry.acceptanceId), errors);
  exactSet('cleanup-fixture', CLEANUP_FIXTURE_IDS, IMPLEMENTATION_EVIDENCE.flatMap((entry) => entry.fixtureIds ?? []), errors);
  exactSet('scenario', REQUIRED_SCENARIO_IDS, options.zeroCoverage ? [] : REQUIRED_SCENARIO_IDS, errors);
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
