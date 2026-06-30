export function validateResidualOwnership(): string[];
export function scanInventorySurfaces(
  repoRoot: string,
): Array<{ file: string; command: string; line?: string }>;
export function validatePackGhReadInventoryCompleteness(repoRoot: string): {
  unclassified: Array<{ file: string; command: string; line?: string }>;
  residualErrors: string[];
  ok: boolean;
};
export function listInventoryRows(): unknown[];
export { isClassifiedGhReadCommand } from './gh-inventory-static-guard.mjs';
