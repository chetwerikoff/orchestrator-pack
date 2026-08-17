const nonTerminalMasks = ['sink', 'helper-pgid-sink'] as const;

function pairIds(operation: string, masks: readonly string[]): string[] {
  return masks.flatMap((mask) => [
    `cleanup.${operation}.${mask}.completed`,
    `cleanup.${operation}.${mask}.failed`,
  ]);
}

const githubOperations = [
  'matched',
  'predicate-failed',
  'source-unavailable',
  'github_read_deadline',
] as const;

const orcaOperations = [
  'matched',
  'source-unavailable',
  'orca_read_deadline',
] as const;

/** Watch-only cleanup proof corpus. Launch-specific terminal/start fixtures retired with launch.ts. */
export const CLEANUP_FIXTURE_IDS = [
  ...githubOperations.flatMap((operation) => pairIds(`github-pull-request--pr-merged--${operation}`, nonTerminalMasks)),
  ...orcaOperations.flatMap((operation) => pairIds(`orca-terminal--terminal-read--${operation}`, nonTerminalMasks)),
] as const;

export const ACCEPTANCE_SCENARIOS = [
  'WATCH1:finite-watch-catalogue',
  'WATCH2:total-watch-outcome-and-cleanup-algebra',
  'WATCH3:watch-transport-and-zero-coverage-proof',
] as const;

export const ACCEPTANCE_SCENARIO_MAP = [
  { acceptanceId: 'WATCH1', scenarioIds: ['watch-catalogue', 'watch-validation', 'watch-producer-mapping'] },
  { acceptanceId: 'WATCH2', scenarioIds: ['typed-result-schema', 'cleanup-denominator', 'cleanup-precedence'] },
  { acceptanceId: 'WATCH3', scenarioIds: ['fallback-emission', 'transport-failure', 'zero-coverage'] },
] as const;

export const REQUIRED_SCENARIO_IDS = [
  'watch-catalogue',
  'watch-validation',
  'watch-producer-mapping',
  'typed-result-schema',
  'cleanup-denominator',
  'cleanup-precedence',
  'fallback-emission',
  'transport-failure',
  'zero-coverage',
] as const;
