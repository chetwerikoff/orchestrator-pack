export declare const REPORT_STATE_SEED_START_REASON: 'report_state_seed';
export declare const REPORT_STATE_POLL_CLASS: 'report_state_poll';
export declare const REPORT_STATE_SEED_TO_START_MAX_MS: 30000;
export declare const DEFAULT_REPORT_STATE_POLL_TICK_CAPACITY: 20;

export declare function reportStateSeedDedupeKey(input: Record<string, unknown>): string;
export declare function pollBindingStateKey(input: Record<string, unknown>): string;
export declare function isAcceptedReadyForReviewReport(report: Record<string, unknown>): boolean;
export declare function evaluatePollReportBinding(input: Record<string, unknown>): {
  binds: boolean;
  reason: string;
};
export declare function updatePollBindingStateEntry(input: Record<string, unknown>): Record<string, unknown>;
export declare function hasTerminalHandoffOutcome(input: Record<string, unknown>): {
  terminal: boolean;
  reason: string;
};
export declare function resolveOpenPrForRepoAndNumber(
  openPrs: Array<Record<string, unknown>>,
  repoSlug: string,
  prNumber: number,
  supervisedRepoSlug?: string,
): Record<string, unknown> | null;
export declare function planReportStatePollTick(input: Record<string, unknown>): Record<string, unknown>;
export declare function seedWatchFromReportStatePoll(input: Record<string, unknown>): {
  watchEntries: Record<string, object>;
  seededKeys: string[];
};
