export declare const defaultRepoRoot: string;

export declare const workerRpcPatterns: RegExp[];

export type { HeavyTopologyArtifact, HeavyTopologyPolicy } from './vitest-heavy-topology.mjs';

import type { HeavyTopologyArtifact, HeavyTopologyPolicy } from './vitest-heavy-topology.mjs';

export interface LanesConfig {
  lightMaxWorkers: number;
  heavyDefaultRuntimeMs: number;
  heavyTopology: HeavyTopologyPolicy;
  heavyForkPoolMinRuntimeMs: number;
  heavyPerTestIsolate: string[];
  classification: Record<string, string>;
}

export interface HeavyShardAssignment {
  shard: number;
  files: string[];
  totalRuntimeMs: number;
}

export interface LanePlanSuccess {
  ok: true;
  discovered: string[];
  config: LanesConfig;
  light: string[];
  heavy: string[];
  heavyShards: HeavyShardAssignment[];
  runtimeHistory: Record<string, number>;
  topology: HeavyTopologyArtifact;
}

export interface LanePlanFailure {
  ok: false;
  errors: string[];
  discovered: string[];
  config?: LanesConfig;
}

export type LanePlan = LanePlanSuccess | LanePlanFailure;

export declare function resolveRepoRoot(repoRoot?: string): string;
export declare function lanesConfigPath(repoRoot?: string): string;
export declare function runtimeHistoryPath(repoRoot?: string): string;
export declare function discoverVitestFiles(repoRoot?: string): string[];
export declare function loadLanesConfig(repoRoot?: string): LanesConfig;
export declare function loadRuntimeHistory(repoRoot?: string): Record<string, number>;
export declare function validateClassification(
  discoveredFiles: string[],
  classification: Record<string, string>,
): string[];
export declare function partitionByLane(
  discoveredFiles: string[],
  classification: Record<string, string>,
): { light: string[]; heavy: string[] };
export declare function resolveHeavyRuntimeMs(
  file: string,
  runtimeHistory: Record<string, number>,
  defaultRuntimeMs: number,
): number;
export declare function resolveHeavyFilePool(
  file: string,
  runtimeHistory: Record<string, number>,
  defaultRuntimeMs: number,
  forkPoolMinRuntimeMs: number,
): 'forks' | 'threads';
export declare function enumerateVitestFileTestTitles(filePath: string): string[];
export interface HeavyFileRunPlan {
  mode: 'file' | 'tests';
  pool: 'forks' | 'threads';
  tests?: string[];
}
export declare function resolveHeavyFileRunPlan(
  file: string,
  config: LanesConfig,
  runtimeHistory: Record<string, number>,
  repoRoot?: string,
): HeavyFileRunPlan;
export declare function assignHeavyShards(
  heavyFiles: string[],
  runtimeHistory: Record<string, number>,
  shardCount: number,
  defaultRuntimeMs: number,
): HeavyShardAssignment[];
export declare function buildLanePlan(
  repoRoot?: string,
  options?: { changedFiles?: string[]; preTopologyMeasurements?: Record<string, number> },
): LanePlan;
export declare function scanWorkerRpcSignatures(text: string): RegExp[];
