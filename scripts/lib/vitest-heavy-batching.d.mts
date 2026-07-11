export const DEFAULT_NON_ISOLATE_FILE_BATCH_SIZE: number;
export const DEFAULT_ISOLATE_TEST_BATCH_SIZE: number;
export const HEAVY_BATCHING_REDUCTION_TARGET: {
  representativeShard: string;
  minimumInvocationReductionPercent: number;
  minimumBootTimeReductionPercent: number;
  bootAttributionMethod: string;
  wallTimeNoiseTolerancePercent: number;
};

export type HeavyFilePlan = {
  file: string;
  mode: 'file' | 'tests';
  pool: string;
  tests?: string[];
};

export type HeavyInvocationUnit = {
  kind: 'file' | 'test';
  file: string;
  pool: string;
  testPattern: string | null;
  label: string;
  batchable: boolean;
};

export type HeavyInvocationBatch = {
  label: string;
  pool: string;
  files: string[];
  testPattern: string | null;
  members: HeavyInvocationUnit[];
};

export function parsePositiveInteger(value: unknown, fallback: number): number;
export function buildHeavyInvocationUnits(filePlans: HeavyFilePlan[]): HeavyInvocationUnit[];
export function groupHeavyInvocationUnits(
  units: HeavyInvocationUnit[],
  options?: {
    nonIsolateFileBatchSize?: number;
    isolateTestBatchSize?: number;
  },
): HeavyInvocationBatch[];
export function materializeBatch(batch: {
  pool: string;
  members: HeavyInvocationUnit[];
  maxSize?: number;
}): HeavyInvocationBatch;
export function countBaselineInvocations(units: HeavyInvocationUnit[]): number;
export function countBatchedInvocations(batches: HeavyInvocationBatch[]): number;
export function validateHeavyBatchReportPayload(
  payload: unknown,
  plannedMembers: HeavyInvocationUnit[],
  repoRoot: string,
): { ok: boolean; errors: string[] };
export function validateHeavyBatchReportFile(
  reportPath: string,
  plannedMembers: HeavyInvocationUnit[],
  repoRoot: string,
): { ok: boolean; errors: string[] };
