import * as base from './worker-smoke-core-base.ts';
export {
  inspectSmokeProgress,
  observeSmokeCancellationAcknowledgement,
  writeSmokeCancelRequest,
} from './worker-smoke-lifecycle-base.ts';

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

function invalidSmokeReport(
  partial: Partial<base.SmokeReport>,
  binding: { issueNumber: number; prNumber: number; headSha: string },
  reason: string,
): base.SmokeReport {
  return bindControlPlaneVerdict({
    result: 'FAIL',
    issueNumber: binding.issueNumber,
    prNumber: binding.prNumber,
    headSha: binding.headSha,
    scenarios: partial.scenarios?.length
      ? partial.scenarios
      : [{
          action: 'normalize sealed smoke report',
          expected: 'valid pack-owned report',
          observed: reason,
          outcome: 'fail',
        }],
    limitations: [...(partial.limitations ?? []), `normalization:${reason}`],
    trackedFilesUnmodified: false,
    terminalCleanup: partial.terminalCleanup ?? 'not_recorded',
    environmentNotes: partial.environmentNotes ?? [],
    producer: base.SMOKE_REPORT_PRODUCER,
    orcaExecutable: partial.orcaExecutable,
    terminalHandle: partial.terminalHandle,
    nonPassCause: 'missing_agent_report',
  });
}

export function normalizeSmokeReport(
  partial: Partial<base.SmokeReport>,
  binding: { issueNumber: number; prNumber: number; headSha: string },
): ({ ok: true; report: base.SmokeReport } | { ok: false; reason: string; report: base.SmokeReport }) {
  const normalized = base.normalizeSmokeReport(partial, binding);
  if (!normalized.ok) {
    return {
      ...normalized,
      report: invalidSmokeReport(partial, binding, normalized.reason),
    };
  }
  return { ok: true, report: bindControlPlaneVerdict(normalized.report) };
}

/**
 * Preserve the current sealed-report field name while exposing the direct
 * parsed report to runtime-neutral callers. This is not a runtime compatibility
 * protocol; it is an in-process typed view over the canonical sealed artifact.
 */
export function observeSmokeCompletionEvidence(
  runBinding: base.SmokeRunBinding,
  priorState: base.SmokeCompletionObservationState = base.createSmokeCompletionObservationState(),
): ReturnType<typeof base.observeSmokeCompletionEvidence> & {
  observation: base.SmokeCompletionEvidenceObservation & {
    partial?: Partial<base.SmokeReport> | null;
  };
} {
  const observed = base.observeSmokeCompletionEvidence(runBinding, priorState);
  return {
    ...observed,
    observation: {
      ...observed.observation,
      partial: observed.observation.parsedReport,
    },
  };
}
