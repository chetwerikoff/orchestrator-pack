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
  const normalized = base.normalizeSmokeReport(partial, binding);
  if (!normalized.ok) return normalized;
  return { ok: true, report: bindControlPlaneVerdict(normalized.report) };
}
