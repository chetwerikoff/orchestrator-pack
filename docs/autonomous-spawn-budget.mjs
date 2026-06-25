/**
 * Autonomous surface spawn-budget contract (Issue #462).
 * Vitest: scripts/autonomous-spawn-budget.test.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const AUTONOMOUS_SPAWN_BUDGET_VERSION = 'autonomous-spawn-budget/v1';
export const AUTONOMOUS_SPAWN_BUDGET_RELATIVE_PATH = 'docs/autonomous-spawn-budget.json';

/**
 * @param {unknown} budget
 */
export function validateAutonomousSpawnBudget(budget) {
  if (!budget || typeof budget !== 'object') {
    return { ok: false, reason: 'spawn_budget_missing_or_unreadable' };
  }
  const version = String(/** @type {{ version?: string }} */ (budget).version ?? '');
  if (version !== AUTONOMOUS_SPAWN_BUDGET_VERSION) {
    return { ok: false, reason: 'spawn_budget_unknown_version' };
  }
  const classes = /** @type {{ classes?: Record<string, unknown> }} */ (budget).classes;
  if (!classes || typeof classes !== 'object') {
    return { ok: false, reason: 'spawn_budget_missing_classes' };
  }
  for (const required of ['noop-shell', 'git-ao-read', 'denied-actions', 'supervisor-child-tick']) {
    if (!classes[required]) {
      return { ok: false, reason: `spawn_budget_missing_class_${required}` };
    }
  }
  return { ok: true, reason: 'spawn_budget_ok' };
}

/**
 * @param {string} packRoot
 */
export function loadAutonomousSpawnBudget(packRoot) {
  const budgetPath = join(packRoot, AUTONOMOUS_SPAWN_BUDGET_RELATIVE_PATH);
  if (!existsSync(budgetPath)) {
    return { ok: false, reason: 'spawn_budget_missing_or_unreadable', budget: null };
  }
  try {
    const budget = JSON.parse(readFileSync(budgetPath, 'utf8'));
    const validated = validateAutonomousSpawnBudget(budget);
    if (!validated.ok) {
      return { ok: false, reason: validated.reason, budget: null };
    }
    return { ok: true, reason: 'spawn_budget_ok', budget };
  } catch {
    return { ok: false, reason: 'spawn_budget_malformed', budget: null };
  }
}

/**
 * @param {object} input
 * @param {string} input.classId
 * @param {number} input.measuredPwshGuardSpawns
 * @param {number} [input.commandCount]
 * @param {number} [input.helperGrowth]
 * @param {object} input.budget
 */
export function evaluateSpawnBudgetClass(input) {
  const classes = /** @type {Record<string, Record<string, unknown>>} */ (
    input.budget?.classes ?? {}
  );
  const spec = classes[input.classId];
  if (!spec) {
    return { ok: false, reason: 'spawn_budget_unknown_class', classId: input.classId };
  }

  if (input.classId === 'noop-shell') {
    const maxGrowth = Number(spec.maxHelperGrowthPerCommand ?? 0);
    const growth = Number(input.helperGrowth ?? 0);
    if (growth > maxGrowth) {
      return {
        ok: false,
        reason: 'noop_shell_helper_growth_exceeded',
        classId: input.classId,
        measured: growth,
        budget: maxGrowth,
      };
    }
    return {
      ok: true,
      reason: 'noop_shell_within_budget',
      classId: input.classId,
      measured: growth,
      budget: maxGrowth,
    };
  }

  if (input.classId === 'git-ao-read' || input.classId === 'supervisor-child-tick') {
    const maxPerCommand = Number(
      spec.maxPwshGuardSpawnsPerCommand ?? spec.maxPwshGuardSpawnsPerTick ?? 0,
    );
    const commandCount = Math.max(1, Number(input.commandCount ?? 1));
    const perCommand = Number(input.measuredPwshGuardSpawns ?? 0) / commandCount;
    if (perCommand > maxPerCommand) {
      return {
        ok: false,
        reason: 'pwsh_guard_spawn_budget_exceeded',
        classId: input.classId,
        measuredPerCommand: perCommand,
        measuredTotal: input.measuredPwshGuardSpawns,
        budgetPerCommand: maxPerCommand,
        commandCount,
      };
    }
    return {
      ok: true,
      reason: 'pwsh_guard_within_budget',
      classId: input.classId,
      measuredPerCommand: perCommand,
      measuredTotal: input.measuredPwshGuardSpawns,
      budgetPerCommand: maxPerCommand,
      commandCount,
    };
  }

  if (input.classId === 'denied-actions') {
    const maxPerDenied = Number(spec.maxPwshGuardSpawnsPerDeniedCommand ?? 1);
    const perCommand = Number(input.measuredPwshGuardSpawns ?? 0);
    if (perCommand > maxPerDenied) {
      return {
        ok: false,
        reason: 'denied_action_guard_budget_exceeded',
        classId: input.classId,
        measured: perCommand,
        budget: maxPerDenied,
      };
    }
    return {
      ok: true,
      reason: 'denied_action_guard_within_budget',
      classId: input.classId,
      measured: perCommand,
      budget: maxPerDenied,
    };
  }

  return { ok: false, reason: 'spawn_budget_unhandled_class', classId: input.classId };
}

/**
 * @param {object} input
 * @param {Record<string, object>} input.measurements
 * @param {object} input.budget
 */
export function formatSpawnBudgetReport(input) {
  const lines = ['autonomous-spawn-budget report:'];
  for (const [classId, measurement] of Object.entries(input.measurements)) {
    const verdict = evaluateSpawnBudgetClass({
      classId,
      budget: input.budget,
      ...measurement,
    });
    lines.push(
      `- ${classId}: status=${verdict.ok ? 'PASS' : 'FAIL'} reason=${verdict.reason} measured=${JSON.stringify(measurement)} budget=${JSON.stringify({
        ...(input.budget.classes?.[classId] ?? {}),
      })}`,
    );
  }
  return lines.join('\n');
}
