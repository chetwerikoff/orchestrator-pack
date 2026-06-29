export declare const ENVELOPE_LEDGER_VERSION: string;
export declare const DEFAULT_CONSECUTIVE_FAILURE_ESCALATE_THRESHOLD: number;
export declare const INFRA_TRANSPORT_FAILURE_CLASS: string;
export declare const COUNTED_TERMINAL_OUTCOMES: readonly string[];

export declare function normalizeLedgerHeadSha(headSha: string): string;
export declare function ledgerKeyForPrHead(prNumber: number, headSha: string): string;
export declare function isCountedTerminal(input?: object): { counted: boolean; failureClass: string };
export declare function shouldResetLedger(input?: object): boolean;
export declare function emptyEnvelopeLedger(ledger?: Record<string, unknown> | null): {
  schemaVersion: string;
  entries: Record<string, Record<string, unknown>>;
};
export declare function applyLedgerReset(input?: object): {
  ledger: ReturnType<typeof emptyEnvelopeLedger>;
  changed: boolean;
  reason?: string;
};
export declare function applyLedgerTerminal(input?: object): Record<string, unknown>;
export declare function markLedgerEscalated(input?: object): Record<string, unknown>;
export declare function evaluateLedgerEscalation(input?: object): Record<string, unknown>;
