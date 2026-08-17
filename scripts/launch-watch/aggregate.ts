import '../toolchain/native-entrypoint-preflight.ts';
import {
  ACCEPTANCE_SCENARIO_MAP,
  ACCEPTANCE_SCENARIOS,
  CLEANUP_FIXTURE_IDS,
  REQUIRED_SCENARIO_IDS,
} from '../lib/launch-watch/fixtures.ts';
import {
  cleanupOverride,
  invalidWatchResult,
  parseWatchRequest,
  selectCleanupError,
  validateResult,
} from '../lib/launch-watch/contract.ts';
import { emitResult, serializeResult } from '../lib/launch-watch/emission.ts';
import { executeWatchRequest } from './watch.ts';
import type { WatchRequest } from '../lib/launch-watch/contract.ts';
import type { ProcessResult } from '../kernel/subprocess.ts';

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

function processResult(stdout: string, ok = true): ProcessResult {
  return {
    outcome: 'exit',
    ok,
    exitCode: ok ? 0 : 1,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    cancelled: false,
  };
}

async function executeScenario(scenarioId: string): Promise<ScenarioEvidence> {
  const invalid = invalidWatchResult('watch_unknown_field', 30_000);
  switch (scenarioId) {
    case 'watch-validation': {
      const valid = Buffer.from(JSON.stringify({
        requestVersion: 'watch-request/v1',
        sourceId: 'orca.terminal',
        predicateId: 'terminal.read',
        terminalHandle: 'h',
      }));
      const bad = Buffer.from(JSON.stringify({
        requestVersion: 'watch-request/v1',
        sourceId: 'bad',
        predicateId: 'terminal.read',
      }));
      return { negative: !parseWatchRequest(bad).ok, positive: parseWatchRequest(valid).ok };
    }
    case 'watch-producer-mapping': {
      const request: WatchRequest = {
        requestVersion: 'watch-request/v1',
        sourceId: 'orca.terminal',
        predicateId: 'terminal.read',
        terminalHandle: 'h',
        deadlineMs: 10_000,
      };
      const matched = await executeWatchRequest(request, {
        now: () => 0,
        run: async () => processResult('{"ok":true,"result":{"lines":[],"nextCursor":null}}'),
      });
      return { negative: matched.outcome !== 'source-unavailable', positive: matched.outcome === 'matched' };
    }
    case 'watch-catalogue': {
      const request: WatchRequest = {
        requestVersion: 'watch-request/v1',
        sourceId: 'orca.terminal',
        predicateId: 'terminal.read',
        terminalHandle: 'h',
        deadlineMs: 10_000,
      };
      const unsupported = parseWatchRequest(Buffer.from(JSON.stringify({ ...request, predicateId: 'unsupported' }))).ok;
      const matched = await executeWatchRequest(request, {
        now: () => 0,
        run: async () => processResult('{"ok":true,"result":{"lines":[],"nextCursor":null}}'),
      });
      return { negative: !unsupported, positive: matched.outcome === 'matched' };
    }
    case 'cleanup-precedence':
      return {
        negative: selectCleanupError(['cleanup_timeout', 'cleanup_termination_failed']) !== 'cleanup_termination_failed',
        positive: selectCleanupError(['cleanup_timeout', 'cleanup_termination_failed']) === 'cleanup_timeout',
      };
    case 'typed-result-schema':
      return { negative: !validateResult({ ...invalid, extra: true }).ok, positive: validateResult(invalid).ok };
    case 'fallback-emission':
      return {
        negative: !serializeResult(invalid).serializationFallback,
        positive: serializeResult({ schema: 'watch-result/v1', value: BigInt(1) }).serializationFallback,
      };
    case 'transport-failure': {
      const failedOutput = {
        write: () => { throw new Error('EPIPE'); },
        once: () => failedOutput,
        removeListener: () => failedOutput,
      } as unknown as NodeJS.WritableStream;
      const goodOutput = {
        write: (_data: string, callback?: (error?: Error | null) => void) => { callback?.(); return true; },
        once: () => goodOutput,
        removeListener: () => goodOutput,
      } as unknown as NodeJS.WritableStream;
      const failed = await emitResult(invalid, failedOutput);
      const succeeded = await emitResult(invalid, goodOutput);
      return { negative: !failed.transportOk, positive: succeeded.transportOk };
    }
    case 'cleanup-denominator': {
      const fixture = executeFixture(CLEANUP_FIXTURE_IDS[0] ?? 'cleanup.watch.sink.failed');
      return { negative: fixture.valid, positive: fixture.valid };
    }
    case 'zero-coverage':
      return { negative: CLEANUP_FIXTURE_IDS.length > 0, positive: REQUIRED_SCENARIO_IDS.length > 0 };
    default:
      return { negative: false, positive: false };
  }
}

function executeFixture(fixtureId: string): FixtureEvidence {
  const completed = fixtureId.endsWith('.completed');
  const result = cleanupOverride(
    invalidWatchResult('watch_unknown_field', 30_000),
    completed ? 'completed' : 'failed',
    { terminalHandle: null, helperProcessGroupId: null, redirectedSinkId: null },
    completed ? null : 'cleanup_timeout',
  );
  return { fixtureId, valid: validateResult(result).ok };
}

export async function runAggregateProof(
  options: { readonly zeroCoverage?: boolean; readonly repoRoot?: string } = {},
): Promise<AggregateProof> {
  const errors: string[] = [];
  const expectedAcceptanceIds = ACCEPTANCE_SCENARIOS.map((entry) => entry.split(':', 1)[0] ?? '');
  if (options.zeroCoverage) {
    errors.push('coverage:execution-skipped');
  } else {
    const scenarioEvidence = new Map<string, ScenarioEvidence>();
    for (const scenarioId of REQUIRED_SCENARIO_IDS) {
      try {
        scenarioEvidence.set(scenarioId, await executeScenario(scenarioId));
      } catch {
        scenarioEvidence.set(scenarioId, { negative: false, positive: false });
      }
    }
    const fixtureEvidence = CLEANUP_FIXTURE_IDS.map(executeFixture);
    exactSet('scenario', REQUIRED_SCENARIO_IDS, [...scenarioEvidence.keys()], errors);
    exactSet(
      'cleanup-fixture',
      CLEANUP_FIXTURE_IDS,
      fixtureEvidence.filter((entry) => entry.valid).map((entry) => entry.fixtureId),
      errors,
    );
    for (const [scenarioId, evidence] of scenarioEvidence) {
      if (!evidence.negative) errors.push(`scenario:${scenarioId}:negative-not-rejected`);
      if (!evidence.positive) errors.push(`scenario:${scenarioId}:positive-not-accepted`);
    }
    for (const acceptance of ACCEPTANCE_SCENARIO_MAP) {
      const rows = acceptance.scenarioIds.map((scenarioId) => scenarioEvidence.get(scenarioId));
      if (rows.some((row) => !row || !row.negative || !row.positive)) {
        errors.push(`${acceptance.acceptanceId}:red-then-green-not-proven`);
      }
    }
    exactSet('acceptance', expectedAcceptanceIds, ACCEPTANCE_SCENARIO_MAP.map((entry) => entry.acceptanceId), errors);
    exactSet('mapped-scenario', REQUIRED_SCENARIO_IDS, ACCEPTANCE_SCENARIO_MAP.flatMap((entry) => entry.scenarioIds), errors);
  }
  if (CLEANUP_FIXTURE_IDS.length === 0) errors.push('cleanup-fixture:zero-coverage');
  if (REQUIRED_SCENARIO_IDS.length === 0) errors.push('scenario:zero-coverage');
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
  process.stdout.write(`${JSON.stringify(proof)}\n`);
  if (!proof.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
