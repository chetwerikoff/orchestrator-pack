/** Shared worker-session + CI check fixtures for reconcile contract tests. */
export const packGreenCiChecks = [
  { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
  { name: 'PR scope guard', state: 'SUCCESS' },
  { name: 'Run pack contract tests', state: 'SUCCESS' },
  { name: 'Self-architect lint', state: 'SUCCESS' },
];

export const packRedCiChecks = [
  { name: 'Verify orchestrator-pack structure', state: 'FAILURE' },
  { name: 'PR scope guard', state: 'SUCCESS' },
  { name: 'Run pack contract tests', state: 'SUCCESS' },
  { name: 'Self-architect lint', state: 'SUCCESS' },
];

export function liveWorker(overrides: Record<string, unknown> = {}) {
  return {
    name: 'op-worker',
    role: 'worker',
    prNumber: 42,
    ownedHeadSha: 'abc123',
    status: 'fixing_ci',
    activity: 'idle',
    runtime: 'alive',
    reports: [],
    ...overrides,
  };
}
