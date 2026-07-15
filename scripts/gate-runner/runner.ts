import { resolve } from 'node:path';
import { isDirectExecution } from '#opk-toolchain/baseline-io';
import { aggregateLane, type GateResult } from './contracts.ts';
import { evaluateCensus, loadCensus } from './census.ts';
import { evaluateDeclarativeGate } from './declarative.ts';
import { representativeDeclarativeGates } from './representative-gates.ts';
import { captureSourceSnapshot } from './source-snapshot.ts';
import { evaluateVestigialFleetRetirement, fileTextReader } from './custom/vestigial-fleet-retirement.ts';

export interface GateRunnerReport {
  readonly results: readonly GateResult[];
  readonly aggregate: ReturnType<typeof aggregateLane>;
}

export const registeredGateIds = new Set([
  ...representativeDeclarativeGates.map((gate) => gate.gateId),
  'vestigial-fleet-retirement',
  'gate-census',
]);

function withDynamicLegacyOutput(result: GateResult, files: ReadonlyMap<string, string>): GateResult {
  if (result.gateId !== 'agent-rules-size-budget' || result.status !== 'PASS') return result;
  const text = files.get('AGENTS.md') ?? '';
  return {
    ...result,
    legacyStdout: `[PASS] AGENTS.md size budget (${text.split('\n').length} lines, ${Buffer.byteLength(text, 'utf8')} bytes)\n`,
  };
}

export function runGateRunner(repoRootInput: string): GateRunnerReport {
  const repoRoot = resolve(repoRootInput);
  const snapshot = captureSourceSnapshot(repoRoot);
  const declarative = representativeDeclarativeGates.map((definition) =>
    withDynamicLegacyOutput(evaluateDeclarativeGate(definition, snapshot), snapshot.files),
  );
  const custom = evaluateVestigialFleetRetirement(snapshot, fileTextReader(repoRoot));
  const census = evaluateCensus(loadCensus(repoRoot), snapshot, registeredGateIds);
  const results = [...declarative, custom, census];
  return { results, aggregate: aggregateLane(results) };
}

export function formatGateRunnerReport(report: GateRunnerReport): string {
  const lines = ['== TypeScript gate runner core (Issue #830 / Wave 3.a) =='];
  for (const result of report.results) {
    if (result.legacyStdout) lines.push(result.legacyStdout.trimEnd());
    lines.push(`[${result.status}] ${result.gateId}: ${result.summary}`);
    for (const detail of result.details ?? []) lines.push(` - ${detail}`);
  }
  lines.push(`gate-runner lane: ${report.aggregate.status}; conclusion=${report.aggregate.checkConclusion}; exit=${report.aggregate.exitCode}`);
  return `${lines.join('\n')}\n`;
}

function parseRepoRoot(argv: readonly string[]): string {
  const index = argv.indexOf('--repo-root');
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : resolve(import.meta.dirname, '../..');
}

export async function main(argv: readonly string[]): Promise<number> {
  const report = runGateRunner(parseRepoRoot(argv));
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(formatGateRunnerReport(report));
  return report.aggregate.exitCode;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
