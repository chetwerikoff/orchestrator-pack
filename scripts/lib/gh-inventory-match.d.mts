import type { ParsedGhArgv } from './gh-parse-argv.mjs';

export function classifyArgv(argv: string[]): {
  parsed: ParsedGhArgv;
  route: { id: string; prNumber?: number; branch?: string } | null;
};

export function matchInventoryRoute(parsed: ParsedGhArgv): {
  id: string;
  prNumber?: number;
  branch?: string;
} | null;
