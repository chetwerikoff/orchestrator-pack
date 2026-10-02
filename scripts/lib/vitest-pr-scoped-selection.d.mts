import type {
  ChangedPathManifest,
  PrScopeMode,
  VitestPrScopeSelection,
} from './vitest-heavy-topology.mjs';

export declare function buildChangedPathManifest(
  repoRoot: string,
  baseSha: string,
  headSha: string,
  options?: { maxBytes?: number },
): ChangedPathManifest;

export declare function parseChangedPathManifest(
  raw: string | null | undefined,
): { ok: true; manifest: ChangedPathManifest } | { ok: false; reason: string };

export declare function resolveVitestPrScopeSelection(input: {
  repoRoot: string;
  changedPathManifest: ChangedPathManifest | null;
  discoveredTests: string[];
  heavyFiles: string[];
  prScopeMode?: PrScopeMode;
}): VitestPrScopeSelection;

export declare function parseChangedPathManifestFromEnv(raw?: string | null): ChangedPathManifest | null;

export declare function normalizePrScopeMode(raw?: string | null): PrScopeMode;
