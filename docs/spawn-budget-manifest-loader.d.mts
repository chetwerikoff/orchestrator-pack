export interface SpawnBudgetManifestLoadResult {
  ok: boolean;
  reason: string;
  budget: Record<string, unknown> | null;
}

export declare function loadPackSpawnBudgetManifest(
  packRoot: string,
  relativePath: string,
  validate: (budget: unknown) => { ok: boolean; reason: string },
  options: {
    okReason: string;
    malformedReason?: string;
    missingReason?: string;
  },
): SpawnBudgetManifestLoadResult;
