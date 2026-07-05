export interface CompletionRecord {
  briefIdentity?: string;
  draftPath?: string;
  authoringEngine?: string;
  selectionBasis?: string;
  tierResult?: string;
  reviewLoopOutcome?: string;
  dispositionStatus?: string;
  disciplineChecks?: string;
  finalStatus?: string;
}

export interface DelegateResult {
  exitCode?: number;
  draftPath?: string;
  completionRecord?: CompletionRecord;
  draftExists?: boolean;
  disciplineChecksPass?: boolean;
}

export function validateCompletionRecord(record: CompletionRecord | null | undefined): {
  ok: boolean;
  errors: string[];
};

export function validateDelegateResult(
  result: DelegateResult,
  options?: { repoRoot?: string },
): {
  ok: boolean;
  errors: string[];
};

export function checkRelocationContractSurfaces(
  repoRoot: string,
  manifestPath?: string,
): {
  ok: boolean;
  errors: string[];
};

export function runCli(argv: string[]): number;
