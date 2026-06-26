/**
 * Shared JSON manifest loader for spawn-budget modules.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} packRoot
 * @param {string} relativePath
 * @param {(budget: unknown) => { ok: boolean, reason: string }} validate
 * @param {{ okReason: string, malformedReason?: string, missingReason?: string }} options
 */
export function loadPackSpawnBudgetManifest(packRoot, relativePath, validate, options) {
  const budgetPath = join(packRoot, relativePath);
  if (!existsSync(budgetPath)) {
    return {
      ok: false,
      reason: options.missingReason ?? 'spawn_budget_missing_or_unreadable',
      budget: null,
    };
  }
  try {
    const budget = JSON.parse(readFileSync(budgetPath, 'utf8'));
    const validated = validate(budget);
    if (!validated.ok) {
      return { ok: false, reason: validated.reason, budget: null };
    }
    return { ok: true, reason: options.okReason, budget };
  } catch {
    return {
      ok: false,
      reason: options.malformedReason ?? 'spawn_budget_malformed',
      budget: null,
    };
  }
}
