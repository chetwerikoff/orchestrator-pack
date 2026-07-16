import type { CiRedWatchdogLedger } from './ci-red-watchdog-ledger.mjs';

export interface CiRedLookupOpenPrSnapshot {
  available: boolean;
  repo: string;
  openPrs: Array<{
    repo?: string;
    prNumber?: number;
    number?: number;
    headSha?: string;
    headRefOid?: string;
  }>;
}

export function pruneCiRedWatchdogLookupFailures(input?: {
  storeDir?: string;
  snapshot?: CiRedLookupOpenPrSnapshot;
  nowMs?: number;
  actor?: string;
  config?: Record<string, unknown>;
}): {
  ok: boolean;
  pruned: boolean;
  historyCompacted: boolean;
  reason: string;
  removedKeys: string[];
  ledger: CiRedWatchdogLedger;
};
