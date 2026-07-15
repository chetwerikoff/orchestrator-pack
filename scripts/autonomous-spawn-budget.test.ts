import { describe, expect, it } from 'vitest';
import {
  evaluateSpawnBudgetClass,
  formatSpawnBudgetReport,
  loadAutonomousSpawnBudget,
} from '../docs/autonomous-spawn-budget.mjs';
import {
  isAutonomousAoReadFastPath,
  isAutonomousGitReadFastPath,
  isMutatingGitArgv,
} from '../docs/autonomous-orchestrator-boundary.mjs';
import { repoRoot } from './_test-pwsh-helpers.js';

describe('autonomous spawn budget contract (Issue #462 / #821)', () => {
  const budgetLoad = loadAutonomousSpawnBudget(repoRoot);
  expect(budgetLoad.ok).toBe(true);
  const budget = budgetLoad.budget as Record<string, any>;
  const classes = budget.classes as Record<string, Record<string, unknown>>;

  it('loads the four load-bearing direct-gate classes', () => {
    expect(budget.version).toBe('autonomous-spawn-budget/v1');
    expect(Object.keys(classes).sort()).toEqual([
      'denied-actions',
      'git-ao-read',
      'noop-shell',
      'supervisor-child-tick',
    ]);
  });

  it('classifies mandatory direct git and AO reads without a shim process', () => {
    expect(isMutatingGitArgv(['config', '--get', 'remote.origin.url'])).toBe(false);
    expect(isMutatingGitArgv(['branch', '--show-current'])).toBe(false);
    expect(isAutonomousGitReadFastPath(['status', '--short', '--branch'])).toBe(true);
    expect(isAutonomousAoReadFastPath(['status', '--json', '--reports', 'full'])).toBe(true);
    expect(isAutonomousAoReadFastPath(['review', 'list', '--json'])).toBe(true);
    expect(isAutonomousAoReadFastPath(['send', 'opk-worker', 'ping'])).toBe(false);
  });

  it('keeps direct reads and supervisor ticks at zero PowerShell guard spawns', () => {
    expect(evaluateSpawnBudgetClass({
      classId: 'git-ao-read',
      measuredPwshGuardSpawns: 0,
      commandCount: 6,
      budget,
    }).ok).toBe(true);
    expect(evaluateSpawnBudgetClass({
      classId: 'supervisor-child-tick',
      measuredPwshGuardSpawns: 0,
      commandCount: 6,
      budget,
    }).ok).toBe(true);
  });

  it('fails when a direct read regresses to per-command PowerShell spawning', () => {
    const verdict = evaluateSpawnBudgetClass({
      classId: 'git-ao-read',
      measuredPwshGuardSpawns: 1,
      commandCount: 1,
      budget,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('pwsh_guard_spawn_budget_exceeded');
  });

  it('keeps denied actions bounded and shell no-ops helper-free', () => {
    expect(evaluateSpawnBudgetClass({
      classId: 'denied-actions',
      measuredPwshGuardSpawns: 1,
      budget,
    }).ok).toBe(true);
    expect(evaluateSpawnBudgetClass({
      classId: 'denied-actions',
      measuredPwshGuardSpawns: 2,
      budget,
    }).ok).toBe(false);
    expect(evaluateSpawnBudgetClass({
      classId: 'noop-shell',
      measuredPwshGuardSpawns: 0,
      helperGrowth: 0,
      budget,
    }).ok).toBe(true);
  });

  it('formats bounded evidence for every retained class', () => {
    const report = formatSpawnBudgetReport({
      budget,
      measurements: {
        'noop-shell': { measuredPwshGuardSpawns: 0, helperGrowth: 0 },
        'git-ao-read': { measuredPwshGuardSpawns: 0, commandCount: 6 },
        'denied-actions': { measuredPwshGuardSpawns: 1 },
        'supervisor-child-tick': { measuredPwshGuardSpawns: 0, commandCount: 6 },
      },
    });
    expect(report).toContain('status=PASS');
    expect(report).not.toContain('status=FAIL');
  });
});
