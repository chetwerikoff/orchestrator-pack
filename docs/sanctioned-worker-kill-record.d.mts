export interface SanctionedWorkerKillRecord {
  sessionId: string;
  issueNumber: number;
  prNumber: number;
  killKind: string;
  timestampMs: number;
}

export interface SanctionedWorkerKillSurface {
  healthy: boolean;
  reason?: string;
  detail?: string;
  records: SanctionedWorkerKillRecord[];
}

export declare function normalizeSanctionedWorkerKillRecord(
  row?: Record<string, unknown>,
  nowMs?: number,
): SanctionedWorkerKillRecord;

export declare function readSanctionedWorkerKillSurface(path: string): SanctionedWorkerKillSurface;

export declare function appendSanctionedWorkerKillRecord(
  path: string,
  record: Record<string, unknown>,
  nowMs?: number,
): SanctionedWorkerKillSurface;
