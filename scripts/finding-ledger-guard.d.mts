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

export function detectProtectedSignalsInCapture(capture: string): string[];

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
): {
  ok: boolean;
  errors: string[];
  ledger: ReturnType<typeof parseLedger>;
  captureFindings: ReturnType<typeof detectTypedFindingsInCapture>;
  protectedSignals: string[];
};

export function runCli(argv: string[]): number;

export const PROTECTED_TYPES: Set<string>;
