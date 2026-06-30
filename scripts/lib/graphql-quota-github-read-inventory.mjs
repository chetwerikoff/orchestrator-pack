/**
 * GraphQL quota recurrence closure — GitHub read shape inventory (Issue #549).
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import inventory from './graphql-quota-github-read-inventory.json' with { type: 'json' };
import {
  isClassifiedGhReadCommand,
  scanFileForViolations,
} from './gh-inventory-static-guard.mjs';

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url));

export { isClassifiedGhReadCommand };

/**
 * @returns {string[]}
 */
export function validateResidualOwnership() {
  /** @type {string[]} */
  const errors = [];
  for (const row of inventory.rows) {
    if (row.ownerClass !== 'accepted_upstream_residual') {
      continue;
    }
    if (!row.ownerIssue && !row.policy) {
      errors.push(`residual row ${row.id} missing ownerIssue or policy`);
    }
  }
  return errors;
}

/**
 * @param {string} repoRoot
 */
export function scanInventorySurfaces(repoRoot) {
  /** @type {{ file: string, command: string, line?: string }[]} */
  const violations = [];
  for (const [mode, relPaths] of Object.entries(inventory.scanSurfaces)) {
    for (const rel of relPaths) {
      const filePath = join(repoRoot, rel);
      if (!existsSync(filePath)) {
        continue;
      }
      violations.push(...scanFileForViolations(filePath, /** @type {'reconcile' | 'rules'} */ (mode)));
    }
  }
  return violations;
}

/**
 * @param {string} repoRoot
 */
export function validatePackGhReadInventoryCompleteness(repoRoot) {
  const violations = scanInventorySurfaces(repoRoot);
  const residualErrors = validateResidualOwnership();
  return {
    unclassified: violations,
    residualErrors,
    ok: violations.length === 0 && residualErrors.length === 0,
  };
}

export function listInventoryRows() {
  return inventory.rows;
}

function main() {
  const subcommand = process.argv[2];
  const repoRoot = process.argv[3] ? resolve(process.argv[3]) : resolve(MODULE_DIR, '../..');

  if (subcommand === 'validate') {
    const result = validatePackGhReadInventoryCompleteness(repoRoot);
    if (!result.ok) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ ok: true, rowCount: inventory.rows.length }, null, 2));
    process.exit(0);
  }

  if (subcommand === 'rows') {
    process.stdout.write(`${JSON.stringify(inventory.rows, null, 2)}\n`);
    process.exit(0);
  }

  process.stderr.write('usage: graphql-quota-github-read-inventory.mjs <validate|rows> [repoRoot]\n');
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
