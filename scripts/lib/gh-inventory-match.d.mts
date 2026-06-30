import type { ParsedGhArgv } from './gh-parse-argv.mjs';

export const PR_INFO_FROM_VIEW_FIELDS: readonly string[];

export type InventoryRoute = {
  id: string;
  prNumber?: number;
  prRef?: string;
  branch?: string;
};

export function classifyArgv(argv: string[]): {
  parsed: ParsedGhArgv;
  route: InventoryRoute | null;
};

export function matchInventoryRoute(parsed: ParsedGhArgv): InventoryRoute | null;

export function hasOnlyAllowedFlags(parsed: ParsedGhArgv, allowed: string[]): boolean;
