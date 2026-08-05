import * as base from './worker-smoke-core-base.ts';

export * from './worker-smoke-core-base.ts';

function bindControlPlaneVerdict(report: base.SmokeReport): base.SmokeReport {
  let diagnostic = report.controlPlaneDiagnostic;
  Object.defineProperty(report, 'controlPlaneDiagnostic', {
    enumerable: true,
    configurable: true,
    get: () => diagnostic,
    set: (value: base.SmokeControlPlaneDiagnostic | undefined) => {
      diagnostic = value;
      if (value) {
        report.result = 'BLOCKED';
        report.nonPassCause = value.cause;
      }
    },
  });
  if (diagnostic) {
    report.result = 'BLOCKED';
    report.nonPassCause = diagnostic.cause;
  }
  return report;
}

export function normalizeSmokeReport(
  partial: Partial<base.SmokeReport>,
  binding: { issueNumber: number; prNumber: number; headSha: string },
): ReturnType<typeof base.normalizeSmokeReport> {
  const smokeSupervisorProcess = process.argv[1]?.endsWith('/worker-smoke-run.ts') === true;
  const supervisorPendingPass = partial.result === 'PASS'
    && (partial.terminalCleanup === 'pending'
      || (partial.terminalCleanup === '' && smokeSupervisorProcess))
    && partial.producer === base.SMOKE_REPORT_PRODUCER
    && Boolean(partial.terminalHandle?.trim())
    && Boolean(partial.orcaExecutable?.trim());
  const normalized = base.normalizeSmokeReport(
    supervisorPendingPass
      ? { ...partial, terminalCleanup: 'closed_owned_handle' }
      : partial,
    binding,
  );
  if (!normalized.ok) return normalized;
  if (supervisorPendingPass) {
    normalized.report.terminalCleanup = 'pending';
  }
  return { ok: true, report: bindControlPlaneVerdict(normalized.report) };
}
