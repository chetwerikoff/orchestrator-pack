import {
  createSmokeControlPlaneDiagnostic,
  normalizeSmokeReport,
  SMOKE_REPORT_PRODUCER,
} from './worker-smoke-core.ts';

export function registerWorkerSmokeControlPlaneRegressionTests(input: {
  expect: typeof import('vitest').expect;
  it: typeof import('vitest').it;
}): void {
  const { expect, it } = input;

  it('keeps a cleanup channel failure BLOCKED after a child PASS', () => {
    const normalized = normalizeSmokeReport({
      result: 'PASS',
      scenarios: [{
        action: 'run declared smoke scenario',
        expected: 'pass',
        observed: 'pass',
        outcome: 'pass',
      }],
      trackedFilesUnmodified: true,
      terminalCleanup: 'closed_owned_handle',
      producer: SMOKE_REPORT_PRODUCER,
      orcaExecutable: 'orca',
      terminalHandle: 'term_owned',
    }, {
      issueNumber: 1138,
      prNumber: 1163,
      headSha: 'c'.repeat(40),
    });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    const diagnostic = createSmokeControlPlaneDiagnostic({
      terminalAcquired: true,
      operation: 'terminal_close',
      outcomeCategory: 'recognized_control_plane_code',
      controlPlaneCode: 'channel_control_overwritten',
    });
    expect(diagnostic).toBeDefined();
    normalized.report.controlPlaneDiagnostic = diagnostic;

    expect(normalized.report.result).toBe('BLOCKED');
    expect(normalized.report.nonPassCause).toBe('orca_control_plane_lost_mid_smoke');
  });
}
