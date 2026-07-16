import { resolve } from 'node:path';
import { isDirectExecution } from '#opk-toolchain/baseline-io';
import { aggregateLane, type GateResult } from './contracts.ts';
import { evaluateCensus, loadCensus } from './census.ts';
import { evaluateDeclarativeGate } from './declarative.ts';
import { representativeDeclarativeGates } from './representative-gates.ts';
import { captureSourceSnapshot } from './source-snapshot.ts';
import { evaluateAoCaptureRedaction, fileCaptureReader } from './custom/ao-capture-redaction.ts';
import { extensionGateRegistrations } from './extensions.ts';
import {
  selectGateRegistrations,
  validateGateRegistrations,
  type GateEvaluationContext,
  type GateRegistration,
} from './registry.ts';

export interface GateRunnerReport {
  readonly results: readonly GateResult[];
  readonly aggregate: ReturnType<typeof aggregateLane>;
}

function withDynamicLegacyOutput(result: GateResult, files: ReadonlyMap<string, string>): GateResult {
  if (result.gateId !== 'agent-rules-size-budget' || result.status !== 'PASS') return result;
  const text = files.get('AGENTS.md') ?? '';
  return {
    ...result,
    legacyStdout: `[PASS] AGENTS.md size budget (${text.split('\n').length} lines, ${Buffer.byteLength(text, 'utf8')} bytes)\n`,
  };
}

const builtInGateRegistrations: readonly GateRegistration[] = [
  ...representativeDeclarativeGates.map((definition): GateRegistration => ({
    gateId: definition.gateId,
    evaluate: ({ snapshot }) => withDynamicLegacyOutput(evaluateDeclarativeGate(definition, snapshot), snapshot.files),
  })),
  {
    gateId: 'ao-capture-redaction',
    evaluate: ({ repoRoot }) => evaluateAoCaptureRedaction(fileCaptureReader(repoRoot)),
  },
];

export const gateRegistrations: readonly GateRegistration[] = [
  ...builtInGateRegistrations,
  ...extensionGateRegistrations,
];
validateGateRegistrations(gateRegistrations);

export const registeredGateIds = new Set([
  ...gateRegistrations.map((registration) => registration.gateId),
  'gate-census',
]);

export function runGateRunner(repoRootInput: string, requestedGateIds?: readonly string[]): GateRunnerReport {
  const repoRoot = resolve(repoRootInput);
  const snapshot = captureSourceSnapshot(repoRoot);
  const context: GateEvaluationContext = { repoRoot, snapshot };
  const selected = selectGateRegistrations(gateRegistrations, requestedGateIds);
  const results = selected.map((registration) => registration.evaluate(context));
  if (requestedGateIds === undefined || requestedGateIds.length === 0 || requestedGateIds.includes('gate-census')) {
    results.push(evaluateCensus(loadCensus(repoRoot), snapshot, registeredGateIds));
  }
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

function argumentValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]!);
  }
  return values;
}

function requiredArgumentValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (value === undefined || value.trim().length === 0) {
      throw new Error(`${name} requires a non-empty value`);
    }
    values.push(value);
  }
  return values;
}

function parseRepoRoot(argv: readonly string[]): string {
  return argumentValues(argv, '--repo-root')[0] ?? resolve(import.meta.dirname, '../..');
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const selected = requiredArgumentValues(argv, '--gate');
    const report = runGateRunner(parseRepoRoot(argv), selected.length > 0 ? selected : undefined);
    if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(formatGateRunnerReport(report));
    return report.aggregate.exitCode;
  } catch (error) {
    process.stderr.write(`[FAIL] gate-runner dispatch: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
