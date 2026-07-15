export declare const PRE_TOPOLOGY_MAX_FILES: number;
export declare const PRE_TOPOLOGY_MAX_CONCURRENCY: number;
export declare const PRE_TOPOLOGY_MEASUREMENT_ESTIMATES: Readonly<Record<string, number>>;
export declare const PRE_TOPOLOGY_TIMEOUT_MS: number;

export declare function requiresExclusiveFleetMeasurement(file: string): boolean;
export declare function shouldMeasurePreTopology(
  repoRoot: string,
  options?: {
    preTopologyMeasurements?: Record<string, number> | null;
  },
): boolean;
export declare function resolvePreTopologyMeasurementTargets(
  result: {
    topology?: {
      unresolvedGuardWeights?: Array<{
        file?: string | null;
        reason?: string | null;
      }>;
    };
  },
  options?: {
    maxFiles?: number;
  },
): string[];
export declare function resolvePreTopologyMeasurementPlan(
  result: {
    config?: {
      classification?: Record<string, string>;
    };
    lanesConfig?: {
      classification?: Record<string, string>;
    };
    topology?: {
      unresolvedGuardWeights?: Array<{
        file?: string | null;
        reason?: string | null;
      }>;
    };
  },
  options?: {
    maxFiles?: number;
  },
): {
  targets: string[];
  measurements: Record<string, number>;
  allTargets: string[];
};
export declare function measurePreTopologyFiles(
  repoRoot: string,
  files: string[],
  options?: {
    timeoutMs?: number;
    maxConcurrency?: number;
  },
): Promise<Record<string, number>>;
