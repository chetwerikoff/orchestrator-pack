export const GATE_STATUSES = ['PASS', 'FAIL', 'SKIP'] as const;
export const EVIDENCE_CLASSES = ['static-source', 'capture-schema', 'fixture', 'live-adoption'] as const;
export const EVIDENCE_STATES = ['present', 'missing', 'unreachable'] as const;

export type GateStatus = (typeof GATE_STATUSES)[number];
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];
export type EvidenceState = (typeof EVIDENCE_STATES)[number];

export interface EvidenceObservation {
  readonly class: EvidenceClass;
  readonly state: EvidenceState;
  readonly source: string;
  readonly detail?: string;
}

export interface GateResult {
  readonly gateId: string;
  readonly status: GateStatus;
  readonly summary: string;
  readonly evidence: readonly EvidenceObservation[];
  readonly details?: readonly string[];
  readonly reason?: string;
  readonly allowSkip?: boolean;
  readonly legacyStdout?: string;
}

export interface LaneAggregate {
  readonly status: GateStatus;
  readonly green: boolean;
  readonly exitCode: number;
  readonly checkConclusion: 'success' | 'failure';
  readonly failures: readonly GateResult[];
  readonly skipped: readonly GateResult[];
}

function observedClasses(observations: readonly EvidenceObservation[]): Set<EvidenceClass> {
  return new Set(observations.map((observation) => observation.class));
}

export function missingRequiredEvidence(
  required: readonly EvidenceClass[],
  observations: readonly EvidenceObservation[],
): EvidenceObservation[] {
  const classes = observedClasses(observations);
  const missing = required
    .filter((evidenceClass) => !classes.has(evidenceClass))
    .map((evidenceClass): EvidenceObservation => ({
      class: evidenceClass,
      state: 'missing',
      source: '<undeclared>',
      detail: 'required evidence class was not supplied',
    }));
  return [...observations.filter((observation) => observation.state !== 'present'), ...missing];
}

export function passGate(
  gateId: string,
  summary: string,
  required: readonly EvidenceClass[],
  evidence: readonly EvidenceObservation[],
  options: Pick<GateResult, 'details' | 'legacyStdout'> = {},
): GateResult {
  const unavailable = missingRequiredEvidence(required, evidence);
  if (unavailable.length > 0) {
    return skipGate(
      gateId,
      `${summary} Required evidence is missing or unreachable.`,
      evidence,
      unavailable.map((item) => `${item.class}: ${item.state} (${item.source})${item.detail ? ` — ${item.detail}` : ''}`),
      false,
      options.legacyStdout,
    );
  }
  return { gateId, status: 'PASS', summary, evidence, ...options };
}

export function failGate(
  gateId: string,
  summary: string,
  evidence: readonly EvidenceObservation[],
  details: readonly string[] = [],
  legacyStdout?: string,
): GateResult {
  return { gateId, status: 'FAIL', summary, evidence, details, legacyStdout };
}

export function skipGate(
  gateId: string,
  summary: string,
  evidence: readonly EvidenceObservation[],
  details: readonly string[] = [],
  allowSkip = false,
  legacyStdout?: string,
): GateResult {
  return { gateId, status: 'SKIP', summary, reason: summary, evidence, details, allowSkip, legacyStdout };
}

export function aggregateLane(results: readonly GateResult[]): LaneAggregate {
  if (results.length === 0) {
    return {
      status: 'SKIP',
      green: false,
      exitCode: 1,
      checkConclusion: 'failure',
      failures: [],
      skipped: [],
    };
  }

  const failures = results.filter((result) => result.status === 'FAIL');
  const skipped = results.filter((result) => result.status === 'SKIP');
  if (failures.length > 0) {
    return { status: 'FAIL', green: false, exitCode: 1, checkConclusion: 'failure', failures, skipped };
  }
  if (skipped.length === 0) {
    return { status: 'PASS', green: true, exitCode: 0, checkConclusion: 'success', failures: [], skipped: [] };
  }

  const onlyAllowedSkips = skipped.every((result) => result.allowSkip === true);
  return {
    status: 'SKIP',
    green: false,
    exitCode: onlyAllowedSkips ? 0 : 1,
    checkConclusion: onlyAllowedSkips ? 'success' : 'failure',
    failures: [],
    skipped,
  };
}
