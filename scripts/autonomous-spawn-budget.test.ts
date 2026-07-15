import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

describe('autonomous spawn budget contract after shim retirement (Issues #462/#821)', () => {
  const loaded = loadAutonomousSpawnBudget(repoRoot);
  expect(loaded.ok).toBe(true);
  const budget = loaded.budget as Record<string, any>;

  it('keeps the measurement contract and all load-bearing classes', () => {
    expect(budget.version).toBe('autonomous-spawn-budget/v1');
    for (const classId of ['noop-shell', 'git-ao-read', 'denied-actions', 'supervisor-child-tick']) {
      expect(budget.classes[classId]).toBeTruthy();
    }
  });

  it('keeps pure read/mutation classification after process-boundary shims retire', () => {
    expect(isMutatingGitArgv(['config', '--get', 'remote.origin.url'])).toBe(false);
    expect(isMutatingGitArgv(['branch', '--show-current'])).toBe(false);
    expect(isMutatingGitArgv(['branch', 'foo--show-current'])).toBe(true);
    expect(isMutatingGitArgv(['config', 'user.name', '--get'])).toBe(true);
    expect(isAutonomousGitReadFastPath(['status', '--short', '--branch'])).toBe(true);
    expect(isAutonomousAoReadFastPath(['status', '--json', '--reports', 'full'])).toBe(true);
    expect(isAutonomousAoReadFastPath(['review', 'list', '--json'])).toBe(true);
    expect(isAutonomousAoReadFastPath(['send', 'opk-worker', 'ping'])).toBe(false);
    expect(isAutonomousAoReadFastPath(['review', 'run', 'opk-1'])).toBe(false);
  });

  it('keeps bash fast-path classifiers spawn-free and exact-token based', () => {
    const script = [
      `source "${repoRoot}/scripts/lib/autonomous-guard-fast-path.sh"`,
      '__ao_autonomous_git_argv_is_read_only stash list || exit 2',
      '__ao_autonomous_git_argv_is_read_only stash show || exit 3',
      '__ao_autonomous_git_argv_is_read_only stash push && exit 4',
      '__ao_autonomous_git_argv_is_read_only branch --show-current || exit 5',
      '__ao_autonomous_git_argv_is_read_only branch foo--show-current && exit 6',
      '__ao_autonomous_ao_argv_is_read_fast_path status --json || exit 7',
      '__ao_autonomous_ao_argv_is_read_fast_path review list --json || exit 8',
      '__ao_autonomous_ao_argv_is_read_fast_path send opk-worker ping && exit 9',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/bad substitution/i);
  });

  it('evaluates each retained class without invoking the retired interposer', () => {
    expect(evaluateSpawnBudgetClass({ classId: 'noop-shell', helperGrowth: 0, measuredPwshGuardSpawns: 0, budget }).ok).toBe(true);
    expect(evaluateSpawnBudgetClass({ classId: 'git-ao-read', commandCount: 8, measuredPwshGuardSpawns: 0, budget }).ok).toBe(true);
    expect(evaluateSpawnBudgetClass({ classId: 'denied-actions', measuredPwshGuardSpawns: 1, budget }).ok).toBe(true);
    expect(evaluateSpawnBudgetClass({ classId: 'supervisor-child-tick', commandCount: 1, measuredPwshGuardSpawns: 0, budget }).ok).toBe(true);
    expect(evaluateSpawnBudgetClass({ classId: 'missing', measuredPwshGuardSpawns: 0, budget }).reason).toBe('spawn_budget_unknown_class');
  });

  it('formats a deterministic report from supplied measurements', () => {
    const report = formatSpawnBudgetReport({
      budget,
      measurements: {
        'noop-shell': { helperGrowth: 0, measuredPwshGuardSpawns: 0 },
        'git-ao-read': { commandCount: 4, measuredPwshGuardSpawns: 0 },
      },
    });
    expect(report).toContain('autonomous-spawn-budget report:');
    expect(report).toContain('noop-shell: status=PASS');
    expect(report).toContain('git-ao-read: status=PASS');
  });

  it('uses AO_SESSION_ID for trusted pwsh resolution', () => {
    const source = readFileSync(path.join(repoRoot, 'scripts/_resolve-pwsh.sh'), 'utf8');
    expect(source).toContain('AO_SESSION_ID');
  });
});
