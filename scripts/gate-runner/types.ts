export const GATE_STATUSES = ['PASS', 'FAIL', 'SKIP'] as const;
export const EVIDENCE_CLASSES = ['static-source', 'capture-schema', 'fixture', 'live-adoption'] as const;

export type GateStatus = (typeof GATE_STATUSES)[number];
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export interface GateResult {
  readonly gateId: string;
  readonly status: GateStatus;
  readonly summary: string;
  readonly evidence: readonly EvidenceClass[];
  readonly details?: readonly string[];
  readonly allowSkip?: boolean;
}

export interface LaneAggregate {
  readonly status: GateStatus;
  readonly green: boolean;
  readonly exitCode: number;
  readonly failures: readonly GateResult[];
  readonly skipped: readonly GateResult[];
}

export function aggregateLane(results: readonly GateResult[]): LaneAggregate {
  const failures = results.filter((result) => result.status === 'FAIL');
  if (failures.length > 0) {
    return {
      status: 'FAIL',
      green: false,
      exitCode: 1,
      failures,
      skipped: results.filter((result) => result.status === 'SKIP'),
    };
  }

  const skipped = results.filter((result) => result.status === 'SKIP');
  if (skipped.length === 0) {
    return {
      status: 'PASS',
      green: true,
      exitCode: 0,
      failures: [],
      skipped: [],
    };
  }

  const onlyAllowedSkips = skipped.every((result) => result.allowSkip === true);
  return {
    status: 'SKIP',
    green: false,
    exitCode: onlyAllowedSkips ? 0 : 1,
    failures: [],
    skipped,
  };
}
