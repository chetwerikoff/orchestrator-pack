import type {
  ReviewEpisodeDerivationAuthorityV1,
  ReviewEpisodeStateV1,
  StageCompletenessReceiptV1,
  VerifiedRelayEvidenceV1,
} from './lib/stage-completeness-core.ts';

export interface ProtectedActivationState { authority: string; signal: string; whyNow: string; }
export interface ProtectedOccurrenceState {
  occurrenceId: string;
  architectPending: boolean;
  architectRequired: boolean;
  protectedActivation: ProtectedActivationState | null;
}
export interface FindingLedgerRow {
  id: string; summary: string; type: string; disposition: string; rejectReason: string;
  defectDisposition: string; remedyDisposition: string; occurrences: string[];
  persistentMachinery: string; cheapestSufficientAlternative: string; stakesPrice: string; tradeIn: string;
  proposalOutcome: string; proposalReason: string; simplificationCutCandidate: boolean;
  architectPending: boolean; architectRequired: boolean; protectedActivation: ProtectedActivationState | null;
  protectedOccurrences: ProtectedOccurrenceState[];
}
export function parseLedger(ledgerText: string): {
  version: number; draft: string | null; counts: Record<string, unknown> | null; findings: FindingLedgerRow[];
};
export interface CaptureFinding { id: string; hasCaptureId: boolean; type: string; anchor: number; summary: string; }
export function detectTypedFindingsInCapture(capture: string): CaptureFinding[];
export interface FindingLedgerGuardOptions {
  draftPath?: string; repoRoot?: string; receiptDir?: string; receiptPath?: string;
  receipt?: import('./lib/protected-signal-receipt.mjs').ProtectedSignalReceipt;
  consumedReceiptEntries?: Set<string>; reviewEconomics?: boolean;
  phase?: 'pre-lens' | 'final-acceptance'; adoptionTimestampMs?: number; issueRevision?: string;
  stageTerminalConfirmed?: boolean; enforceT3PreLensTopology?: boolean;
  captureMetadata?: Array<{ name: string; timestampMs: number; captureIdentity?: string }>;
  rawCodexResults?: unknown[]; stageReceipts?: StageCompletenessReceiptV1[];
  verifiedRelayEvidence?: VerifiedRelayEvidenceV1[]; episodeAuthority?: ReviewEpisodeDerivationAuthorityV1;
}
export function detectProtectedSignalsInCapture(capture: string, options?: FindingLedgerGuardOptions): string[];
export function detectUntypedFindingsInCapture(capture: string): CaptureFinding[];
export function stripMarkdownFencedCodeBlocks(text: string): string;
export function maskDelimitedMarkdownQuotes(text: string): string;
export function extractFindingsScanText(capture: string, stage?: string | null): string;
export function mergeCaptureFindings(captures: string[]): { findings: CaptureFinding[]; errors: string[] };
export function checkFindingLedgerGuard(captureOrCaptures: string | string[], ledgerText: string, options?: FindingLedgerGuardOptions): {
  ok: boolean; errors: string[]; ledger: ReturnType<typeof parseLedger>; captureFindings: CaptureFinding[]; protectedSignals: string[];
  episodeState?: ReviewEpisodeStateV1;
  economicsCounts?: { rawFindingCount: number; distinctFindingCount: number; processedDistinctCount: number };
  simplificationAggregate?: { simplificationClean: boolean; noFindings: boolean; candidateOccurrences: string[] } | null;
};
export function runCli(argv: string[]): number;
export const PROTECTED_TYPES: Set<string>;
