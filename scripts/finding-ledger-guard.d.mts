export function parseLedger(ledgerText: string): {
  version: number;
  draft: string | null;
  findings: Array<{
    id: string;
    summary: string;
    type: string;
    disposition: string;
    rejectReason: string;
  }>;
};

export function detectTypedFindingsInCapture(capture: string): Array<{
  id: string;
  type: string;
  anchor: number;
  summary: string;
}>;

export function detectProtectedSignalsInCapture(capture: string): string[];

export function checkFindingLedgerGuard(
  capture: string,
  ledgerText: string,
): {
  ok: boolean;
  errors: string[];
  ledger: ReturnType<typeof parseLedger>;
  captureFindings: ReturnType<typeof detectTypedFindingsInCapture>;
  protectedSignals: string[];
};

export function runCli(argv: string[]): number;

export const PROTECTED_TYPES: Set<string>;
