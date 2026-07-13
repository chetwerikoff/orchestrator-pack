export const PROTECTED_SIGNAL_RECEIPT_FILENAME: string;

export interface ProtectedSignalReceiptEntry {
  guard: string;
  signal: string;
  fingerprint: string;
  occurrence?: number;
  reason: string;
  rationale: string;
  anchor?: unknown;
}

export interface ProtectedSignalReceipt {
  entries: ProtectedSignalReceiptEntry[];
  invalid: boolean;
  reason?: string;
  receiptDir?: string;
  receiptPath?: string;
  recordedAt?: string;
  decisionLogPath?: string;
}

export interface ProtectedSignalReceiptOptions {
  receiptDir?: string;
  receiptPath?: string;
  draftPath?: string;
  repoRoot?: string;
}

export interface ProtectedSignalPatternSpec {
  signal: string;
  pattern: RegExp;
}

export interface ProtectedSignalMatch {
  signal: string;
  raw: string;
  fingerprint: string;
  index: number;
  occurrence: number;
}

export function normalizeProtectedSignalSpan(value: unknown): string;

export function fingerprintProtectedSignalSpan(value: unknown): string;

export function loadProtectedSignalReceipt(
  options?: ProtectedSignalReceiptOptions,
): ProtectedSignalReceipt;

export function collectProtectedSignalMatches(
  text: string,
  patternSpecs: ProtectedSignalPatternSpec[],
): ProtectedSignalMatch[];

export function suppressProtectedSignalHits(
  hitSignals: string[],
  matches: ProtectedSignalMatch[],
  receipt: ProtectedSignalReceipt,
  guard: string,
): {
  hits: string[];
  suppressed: Array<{ signal: string; fingerprint: string; occurrence: number }>;
};
