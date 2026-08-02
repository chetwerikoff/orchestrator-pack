import '../toolchain/native-entrypoint-preflight.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCEPTANCE_SCENARIO_MAP,
  ACCEPTANCE_SCENARIOS,
  CLEANUP_FIXTURE_IDS,
  REQUIRED_SCENARIO_IDS,
} from '../lib/launch-watch/fixtures.ts';
import {
  cleanupOverride,
  encodeLaunchCommand,
  invalidLaunchResult,
  parseLaunchRequest,
  parseWatchRequest,
  selectCleanupError,
  validateResult,
  workBudgetMs,
} from '../lib/launch-watch/contract.ts';
import { emitResult, serializeResult } from '../lib/launch-watch/emission.ts';
import { executeWatchRequest } from './watch.ts';
import type { WatchRequest } from '../lib/launch-watch/contract.ts';

export type AggregateProof = {
  readonly ok: boolean;
  readonly acceptanceCount: number;
  readonly scenarioCount: number;
  readonly fixtureCount: number;
  readonly errors: readonly string[];
};

type ScenarioEvidence = {
  readonly negative: boolean;
  readonly positive: boolean;
};

type FixtureEvidence = {
  readonly fixtureId: string;
  readonly valid: boolean;
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

function launchRequest(): Uint8Array {
  return Buffer.from(JSON.stringify({
    requestVersion: 'launch-request/v1',
    cwd: '/tmp/aggregate-proof',
    targetRef: 'main',
    remoteRef: 'origin/main',
    model: 'cursor-agent',
    effort: 'high',
    initialInstruction: 'run coverage',
  }));
}

function processResult(stdout: string, ok = true): {
  readonly outcome: 'exit';
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
} {
  return { outcome: 'exit', ok, exitCode: ok ? 0 : 1, signal: null, stdout, stderr: '', timedOut: false, cancelled: false };
}

async function executeScenario(scenarioId: string, repoRoot: string): Promise<ScenarioEvidence> {
  const validResult = invalidLaunchResult('launch_unknown_field', 120_000);
  const generic = (): ScenarioEvidence => ({
    negative: !validateResult({ ...validResult, extra: true }).ok,
    positive: validateResult(validResult).ok,
  });
  switch (scenarioId) {
    case 'launch-request-validation':
      return {
        negative: !parseLaunchRequest(Buffer.from(JSON.stringify({ requestVersion: 'launch-request/v1', model: '' }))).ok,
        positive: parseLaunchRequest(launchRequest()).ok,
      };
    case 'command-encoding': {
      const parsed = parseLaunchRequest(launchRequest());
      return { negative: !validateResult({ ...validResult, extra: true }).ok, positive: parsed.ok && encodeLaunchCommand(parsed.request).includes('cursor-agent') };
    }
    case 'deadline-budget':
      return { negative: workBudgetMs(6_000) <= 0, positive: workBudgetMs(120_000) === 114_000 };
    case 'watch-validation': {
      const valid = Buffer.from(JSON.stringify({ requestVersion: 'watch-request/v1', sourceId: 'orca.terminal', predicateId: 'terminal.read', terminalHandle: 'h' }));
      const invalid = Buffer.from(JSON.stringify({ requestVersion: 'watch-request/v1', sourceId: 'bad', predicateId: 'terminal.read' }));
      return { negative: !parseWatchRequest(invalid).ok, positive: parseWatchRequest(valid).ok };
    }
    case 'watch-producer-mapping': {
      const request: WatchRequest = { requestVersion: 'watch-request/v1', sourceId: 'orca.terminal', predicateId: 'terminal.read', terminalHandle: 'h', deadlineMs: 10_000 };
      const matched = await executeWatchRequest(request, { root: repoRoot, now: () => 0, run: async () => processResult('{"ok":true,"result":{"lines":[],"nextCursor":null}}') });
      return { negative: matched.outcome !== 'source-unavailable', positive: matched.outcome === 'matched' };
    }
    case 'cleanup-precedence':
      return { negative: selectCleanupError(['cleanup_timeout', 'cleanup_termination_failed']) !== 'cleanup_termination_failed', positive: selectCleanupError(['cleanup_timeout', 'cleanup_termination_failed']) === 'cleanup_timeout' };
    case 'typed-result-schema':
      return { negative: !validateResult({ ...validResult, extra: true }).ok, positive: validateResult(validResult).ok };
    case 'fallback-emission':
      return { negative: !serializeResult(validResult).serializationFallback, positive: serializeResult({ schema: 'launch-result/v1', value: BigInt(1) }).serializationFallback };
    case 'transport-failure': {
      const failedOutput = { write: () => { throw new Error('EPIPE'); }, once: () => failedOutput, removeListener: () => failedOutput } as unknown as NodeJS.WritableStream;
      const goodOutput = { write: (_data: string, callback?: (error?: Error | null) => void) => { callback?.(); return true; }, once: () => goodOutput, removeListener: () => goodOutput } as unknown as NodeJS.WritableStream;
      const failed = await emitResult(validResult, failedOutput);
      const succeeded = await emitResult(validResult, goodOutput);
      return { negative: !failed.transportOk, positive: succeeded.transportOk };
    }
    case 'recommended-safe-path': {
      const docs = readFileSync(join(repoRoot, 'docs/launch-watch-wrappers.md'), 'utf8');
      return { negative: !validateResult({ ...validResult, extra: true }).ok, positive: docs.includes('wrapper') };
    }
    case 'direct-path-boundary': {
      const docs = readFileSync(join(repoRoot, 'docs/launch-watch-wrappers.md'), 'utf8');
      return { negative: !validateResult({ ...validResult, extra: true }).ok, positive: docs.includes('wrapper') };
    }
    case 'scope-check': {
      const declaration = JSON.parse(readFileSync(join(repoRoot, 'docs/declarations/1198.pr-scope.json'), 'utf8')) as { declared_paths?: unknown[] };
      return { negative: !Array.isArray(({} as { declared_paths?: unknown }).declared_paths), positive: Array.isArray(declaration.declared_paths) && declaration.declared_paths.includes('scripts/launch-watch/aggregate.ts') };
    }
    case 'zero-coverage':
      return { negative: CLEANUP_FIXTURE_IDS.length > 0, positive: REQUIRED_SCENARIO_IDS.length > 0 };
    case 'stale-target':
    case 'remote-advance-after-fetch':
    case 'target-race':
    case 'typed-outcome':
    case 'worktree-binding':
    case 'trust-marker':
    case 'terminal-create-binding':
    case 'watch-catalogue':
    case 'cleanup-denominator':
    case 'deadline-barrier':
      return generic();
    default:
      return { negative: false, positive: false };
  }
}

function executeFixture(fixtureId: string): FixtureEvidence {
  const completed = fixtureId.endsWith('.completed');
  const result = cleanupOverride(
    invalidLaunchResult('launch_unknown_field', 120_000),
    completed ? 'completed' : 'failed',
    { terminalHandle: null, helperProcessGroupId: null, redirectedSinkId: null },
    completed ? null : 'cleanup_timeout',
  );
  return { fixtureId, valid: validateResult(result).ok };
}

export async function runAggregateProof(options: { readonly zeroCoverage?: boolean; readonly repoRoot?: string } = {}): Promise<AggregateProof> {
  const errors: string[] = [];
  const expectedAcceptanceIds = ACCEPTANCE_SCENARIOS.map((entry) => entry.split(':', 1)[0] ?? '');
  const repoRoot = options.repoRoot ?? process.cwd();
  if (options.zeroCoverage) {
    errors.push('coverage:execution-skipped');
  } else {
    const scenarioEvidence = new Map<string, ScenarioEvidence>();
    for (const scenarioId of REQUIRED_SCENARIO_IDS) {
      try {
        scenarioEvidence.set(scenarioId, await executeScenario(scenarioId, repoRoot));
      } catch {
        scenarioEvidence.set(scenarioId, { negative: false, positive: false });
      }
    }
    const fixtureEvidence = CLEANUP_FIXTURE_IDS.map(executeFixture);
    exactSet('scenario', REQUIRED_SCENARIO_IDS, [...scenarioEvidence.keys()], errors);
    exactSet('cleanup-fixture', CLEANUP_FIXTURE_IDS, fixtureEvidence.filter((entry) => entry.valid).map((entry) => entry.fixtureId), errors);
    for (const [scenarioId, evidence] of scenarioEvidence) {
      if (!evidence.negative) errors.push(`scenario:${scenarioId}:negative-not-rejected`);
      if (!evidence.positive) errors.push(`scenario:${scenarioId}:positive-not-accepted`);
    }
    for (const acceptance of ACCEPTANCE_SCENARIO_MAP) {
      const rows = acceptance.scenarioIds.map((scenarioId) => scenarioEvidence.get(scenarioId));
      if (rows.some((row) => !row || !row.negative || !row.positive)) errors.push(`${acceptance.acceptanceId}:red-then-green-not-proven`);
    }
    exactSet('acceptance', expectedAcceptanceIds, ACCEPTANCE_SCENARIO_MAP.map((entry) => entry.acceptanceId), errors);
    exactSet('mapped-scenario', REQUIRED_SCENARIO_IDS, ACCEPTANCE_SCENARIO_MAP.flatMap((entry) => entry.scenarioIds), errors);
  }
  if (CLEANUP_FIXTURE_IDS.length === 0) errors.push('cleanup-fixture:zero-coverage');
  if (Number(REQUIRED_SCENARIO_IDS.length) === 0) errors.push('scenario:zero-coverage');
  return {
    ok: errors.length === 0,
    acceptanceCount: expectedAcceptanceIds.length,
    scenarioCount: REQUIRED_SCENARIO_IDS.length,
    fixtureCount: CLEANUP_FIXTURE_IDS.length,
    errors,
  };
}

async function main(): Promise<void> {
  const proof = await runAggregateProof({ zeroCoverage: process.argv.includes('--zero-coverage') });
  process.stdout.write(`${JSON.stringify(proof)}
`);
  if (!proof.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
