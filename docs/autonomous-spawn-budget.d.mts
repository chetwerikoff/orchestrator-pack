export declare const AUTONOMOUS_SPAWN_BUDGET_VERSION: string;
export declare const AUTONOMOUS_SPAWN_BUDGET_RELATIVE_PATH: string;

export interface SpawnBudgetValidation {
  ok: boolean;
  reason: string;
}

export interface SpawnBudgetLoadResult {
  ok: boolean;
  reason: string;
  budget: Record<string, unknown> | null;
}

export interface SpawnBudgetClassVerdict {
  ok: boolean;
  reason: string;
  classId?: string;
  measured?: number;
  measuredPerCommand?: number;
  measuredTotal?: number;
  budget?: number;
  budgetPerCommand?: number;
  commandCount?: number;
  helperGrowth?: number;
}

export declare function validateAutonomousSpawnBudget(budget: unknown): SpawnBudgetValidation;
export declare function loadAutonomousSpawnBudget(packRoot: string): SpawnBudgetLoadResult;
export declare function evaluateSpawnBudgetClass(input: {
  classId: string;
  measuredPwshGuardSpawns?: number;
  commandCount?: number;
  helperGrowth?: number;
  budget: Record<string, unknown>;
}): SpawnBudgetClassVerdict;
export declare function formatSpawnBudgetReport(input: {
  measurements: Record<string, Record<string, unknown>>;
  budget: Record<string, unknown>;
}): string;
