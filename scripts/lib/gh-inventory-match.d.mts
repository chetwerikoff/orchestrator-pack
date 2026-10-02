import type { ParsedGhArgv } from './gh-parse-argv.mjs';

export const PR_INFO_FROM_VIEW_FIELDS: readonly string[];

export type InventoryRoute = {
  id: string;
  prNumber?: number;
  prRef?: string;
  branch?: string;
  repoSlug?: string;
  runId?: number;
  jobId?: number;
  headSha?: string;
  includeAppId?: boolean;
};

export interface InventoryMatchOptions {
  targetAuthorization?: { repository: string; defaultBranch: string };
}

export function classifyArgv(argv: string[], options?: InventoryMatchOptions): {
  parsed: ParsedGhArgv;
  route: InventoryRoute | null;
};

export function matchInventoryRoute(parsed: ParsedGhArgv, options?: InventoryMatchOptions): InventoryRoute | null;

export function hasOnlyAllowedFlags(parsed: ParsedGhArgv, allowed: string[]): boolean;

export function isUnsupportedHighLevelRead(parsed: ParsedGhArgv): boolean;
