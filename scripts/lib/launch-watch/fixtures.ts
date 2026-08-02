const terminalMasks = ['terminal', 'terminal-sink', 'terminal-helper-pgid-sink'] as const;
const nonTerminalMasks = ['sink', 'helper-pgid-sink'] as const;

function pairIds(operation: string, masks: readonly string[]): string[] {
  return masks.flatMap((mask) => [
    `cleanup.${operation}.${mask}.completed`,
    `cleanup.${operation}.${mask}.failed`,
  ]);
}

const terminalOperations = [
  'terminal_create_timeout',
  'terminal_create_invalid_response_shape',
  'terminal_create_dispatched_thrown',
  'terminal_create_dispatched_nonzero',
  'terminal_create_dispatched_ok_false_with_valid_handle',
  'target_post_create_mismatch',
  'target_post_create_read_failed',
  'launch_deadline_binding_verification_with_handle',
] as const;

const noTerminalOperations = [
  'terminal_create_empty',
  'terminal_create_malformed',
  'terminal_create_missing_handle',
  'terminal_create_dispatched_ok_false_without_valid_handle',
] as const;

const launchSinkOperations = [
  'refresh',
  'worktree-current',
  'target-read',
  'target-refusal',
  'trust',
  'process-creation-failure-before-dispatch',
] as const;

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

export const CLEANUP_FIXTURE_IDS = [
  ...terminalOperations.flatMap((operation) => pairIds(operation, terminalMasks)),
  ...noTerminalOperations.flatMap((operation) => pairIds(operation, nonTerminalMasks)),
  ...launchSinkOperations.flatMap((operation) => pairIds(operation, nonTerminalMasks)),
  ...githubOperations.flatMap((operation) => pairIds(`github-pull-request--pr-merged--${operation}`, nonTerminalMasks)),
  ...orcaOperations.flatMap((operation) => pairIds(`orca-terminal--terminal-read--${operation}`, nonTerminalMasks)),
] as const;

export const ACCEPTANCE_SCENARIOS = [
  'AC1:frozen-revision-binding-and-containment',
  'AC2:request-validation-and-command-preservation',
  'AC3:independent-worktree-trust-and-terminal-binding',
  'AC4:finite-watch-catalogue',
  'AC5:total-outcome-and-cleanup-algebra',
  'AC6:deadline-and-transport-semantics',
  'AC7:recommended-safe-path-documentation',
  'AC8:scope-and-zero-coverage-proof',
] as const;

export type ImplementationEvidence = {
  readonly acceptanceId: string;
  readonly scenarioIds: readonly string[];
  readonly fixtureIds?: readonly string[];
  readonly redThenGreen: boolean;
};

export const IMPLEMENTATION_EVIDENCE: readonly ImplementationEvidence[] = [
  { acceptanceId: 'AC1', scenarioIds: ['stale-target', 'remote-advance-after-fetch', 'target-race', 'typed-outcome'], redThenGreen: true },
  { acceptanceId: 'AC2', scenarioIds: ['launch-request-validation', 'command-encoding', 'deadline-budget'], redThenGreen: true },
  { acceptanceId: 'AC3', scenarioIds: ['worktree-binding', 'trust-marker', 'terminal-create-binding'], redThenGreen: true },
  { acceptanceId: 'AC4', scenarioIds: ['watch-catalogue', 'watch-validation', 'watch-producer-mapping'], redThenGreen: true },
  { acceptanceId: 'AC5', scenarioIds: ['typed-result-schema', 'cleanup-denominator', 'cleanup-precedence'], fixtureIds: CLEANUP_FIXTURE_IDS, redThenGreen: true },
  { acceptanceId: 'AC6', scenarioIds: ['deadline-barrier', 'fallback-emission', 'transport-failure'], redThenGreen: true },
  { acceptanceId: 'AC7', scenarioIds: ['recommended-safe-path', 'direct-path-boundary'], redThenGreen: true },
  { acceptanceId: 'AC8', scenarioIds: ['scope-check', 'zero-coverage'], redThenGreen: true },
];

export const REQUIRED_SCENARIO_IDS = IMPLEMENTATION_EVIDENCE.flatMap((entry) => entry.scenarioIds);
