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
  hasCaptureId: boolean;
  type: string;
  anchor: number;
  summary: string;
}>;

export interface FindingLedgerGuardOptions {
  draftPath?: string;
  repoRoot?: string;
  receiptDir?: string;
  receiptPath?: string;
  receipt?: import('./lib/protected-signal-receipt.mjs').ProtectedSignalReceipt;
  consumedReceiptEntries?: Set<string>;
}

export function detectProtectedSignalsInCapture(
  capture: string,
  options?: FindingLedgerGuardOptions,
): string[];

export function detectUntypedFindingsInCapture(capture: string): Array<{
  id: string;
  hasCaptureId: boolean;
  type: string;
  anchor: number;
  summary: string;
}>;

export function stripMarkdownFencedCodeBlocks(text: string): string;

export function extractFindingsScanText(capture: string): string;

export function mergeCaptureFindings(captures: string[]): {
  findings: ReturnType<typeof detectTypedFindingsInCapture>;
  errors: string[];
};

export function checkFindingLedgerGuard(
  captureOrCaptures: string | string[],
  ledgerText: string,
  options?: FindingLedgerGuardOptions,
): {
  ok: boolean;
  errors: string[];
  ledger: ReturnType<typeof parseLedger>;
  captureFindings: ReturnType<typeof detectTypedFindingsInCapture>;
  protectedSignals: string[];
};

export function runCli(argv: string[]): number;

export const PROTECTED_TYPES: Set<string>;
