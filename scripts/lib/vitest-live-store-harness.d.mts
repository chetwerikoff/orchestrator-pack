export const OPK_VITEST_HARNESS_MARKER: string;
export const OPK_VITEST_HARNESS_ROOT: string;
export const repoRoot: string;
export const inventoryPath: string;
export const liveStoreInventory: {
  schemaVersion: number;
  stores: Array<Record<string, unknown>>;
  liveRoots?: Array<Record<string, unknown>>;
};
export function expandInventoryTemplate(value: unknown, env?: NodeJS.ProcessEnv): string;
export function canonicalizeStorePath(candidate: unknown): string;
export function classifyLiveStorePath(candidate: unknown, env?: NodeJS.ProcessEnv): { storeId: string; reason: string } | null;
export function assertHarnessWritePathSafe(candidate: unknown, operation?: string, env?: NodeJS.ProcessEnv): void;
export function createHarnessRoot(baseRoot?: string): string;
export function applyOpkVitestHarnessEnv(rootDir?: string, env?: NodeJS.ProcessEnv): {
  root: string;
  wake: string;
  state: string;
  operatorInbox: string;
  healthSpool: string;
  aoBase: string;
  transport: string;
};
export function startLiveStoreGuard(env?: NodeJS.ProcessEnv): { stop(): void };
export function cleanupHarnessRoot(root: string): void;
