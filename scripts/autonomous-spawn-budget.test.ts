import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import {
  mandatoryReadCommands,
  runAutonomousSurfaceCommand,
  runGitRepoSpawnBudgetCase,
  runMandatoryReadCommandMix,
  runNoopShellFixture,
  runSupervisorChildTick,
  simulateLegacyGuardPerCommand,
  withSpawnBudgetPack,
} from './_test-spawn-budget-fixture.js';
import { repoRoot } from './_test-pwsh-helpers.js';

describe('autonomous spawn budget contract (Issue #462)', () => {
  const budgetLoad = loadAutonomousSpawnBudget(repoRoot);
  expect(budgetLoad.ok).toBe(true);
  const budget = budgetLoad.budget as Record<string, any>;
  const classes = budget.classes as Record<string, Record<string, unknown>>;

  it('loads spawn budget manifest with mandatory load-bearing classes', () => {
    expect(budget.version).toBe('autonomous-spawn-budget/v1');
    expect(classes['noop-shell']).toBeTruthy();
    expect(classes['git-ao-read']).toBeTruthy();
    expect(classes['denied-actions']).toBeTruthy();
    expect(classes['supervisor-child-tick']).toBeTruthy();
  });

  it('classifies mandatory incident read shapes as read fast-path eligible', () => {
    expect(isMutatingGitArgv(['config', '--get', 'remote.origin.url'])).toBe(false);
    expect(isMutatingGitArgv(['branch', '--show-current'])).toBe(false);
    expect(isAutonomousGitReadFastPath(['status', '--short', '--branch'])).toBe(true);
    expect(isAutonomousAoReadFastPath(['status', '--json', '--reports', 'full'])).toBe(true);
    expect(isAutonomousAoReadFastPath(['review', 'list', '--json'])).toBe(true);
    expect(isAutonomousAoReadFastPath(['send', 'opk-worker', 'ping'])).toBe(false);
    expect(isAutonomousAoReadFastPath(['review', 'run', 'opk-1'])).toBe(false);
  });

  it('bash fast path classifies git stash list/show without bad substitution', () => {
    const script = [
      `source "${repoRoot}/scripts/lib/autonomous-guard-fast-path.sh"`,
      '__ao_autonomous_git_argv_is_read_only stash list || exit 2',
      '__ao_autonomous_git_argv_is_read_only stash show || exit 3',
      '__ao_autonomous_git_argv_is_read_only stash push && exit 4',
      'exit 0',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/bad substitution/i);
  });

  it('resolve_system_git scans PATH outside pack scripts before bare git fallback', () => {
    const externalBin = mkdtempSync(path.join(tmpdir(), 'external-git-bin-'));
    const externalGit = path.join(externalBin, 'git');
    writeFileSync(externalGit, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$0"\n');
    chmodSync(externalGit, 0o755);
    const scriptsDir = path.join(repoRoot, 'scripts');
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          `source "${scriptsDir}/_resolve-system-git.sh"`,
          `PATH="${externalBin}:${scriptsDir}"`,
          'resolved="$(resolve_system_git)"',
          '[[ "${resolved}" != git ]] || exit 3',
          'exit 0',
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
  });

  it('load-bearing A: no-op shell fixture has no per-command helper growth', () => {
    withSpawnBudgetPack(({ pack }) => {
      const auditFile = `${pack.packRoot}/noop-audit.jsonl`;
      const small = runNoopShellFixture(pack, 5, auditFile);
      const large = runNoopShellFixture(pack, 100, auditFile);
      expect(small.result.status).toBe(0);
      expect(large.result.status).toBe(0);
      const growth = large.helperGrowth - small.helperGrowth;
      const verdict = evaluateSpawnBudgetClass({
        classId: 'noop-shell',
        budget,
        helperGrowth: growth,
      });
      expect(verdict.ok).toBe(true);
      expect(growth).toBe(0);
    });
  });

  it('load-bearing B: mandatory read-only git/ao mix eliminates per-command pwsh guard startup', () => {
    runGitRepoSpawnBudgetCase(({ pack, auditFile, repoDir }) => {
      const repetitions = Number(classes['git-ao-read'].repetitionsPerCommand ?? 8);
      const measured = runMandatoryReadCommandMix(pack, auditFile, repoDir, repetitions);
      const legacyTotal = simulateLegacyGuardPerCommand(
        measured.commandCount,
        Number(budget.legacyPerCommandPwshGuardSpawns ?? 1),
      );
      expect(measured.pwshGuardSpawns).toBeLessThan(legacyTotal);
      const verdict = evaluateSpawnBudgetClass({
        classId: 'git-ao-read',
        budget,
        measuredPwshGuardSpawns: measured.pwshGuardSpawns,
        commandCount: measured.commandCount,
      });
      expect(verdict.ok).toBe(true);
      expect(measured.pwshGuardSpawns).toBe(0);
    });
  });

  it('load-bearing C: denied git and ao actions remain fail-closed after read fast paths', () => {
    runGitRepoSpawnBudgetCase(({ pack, auditFile, repoDir }) => {
      const deniedGit = runAutonomousSurfaceCommand(
        pack,
        ['git', 'branch', '-m', 'blocked-spawn-budget'],
        { AO_AUTONOMOUS_GUARD_SPAWN_AUDIT_FILE: auditFile },
        repoDir,
      );
      expect(deniedGit.status).toBe(93);
      expect(deniedGit.pwshGuardSpawns).toBeGreaterThan(0);

      const deniedAo = runAutonomousSurfaceCommand(
        pack,
        ['ao', 'send', 'opk-worker', 'blocked-spawn-budget'],
        { AO_AUTONOMOUS_GUARD_SPAWN_AUDIT_FILE: auditFile },
        repoDir,
      );
      expect(deniedAo.status).toBe(93);
      expect(deniedAo.pwshGuardSpawns).toBeGreaterThan(0);
    });
  });

  it('load-bearing D: supervisor child tick stays within bounded pwsh guard budget', () => {
    runGitRepoSpawnBudgetCase(({ pack, auditFile, repoDir }) => {
      const measured = runSupervisorChildTick(pack, auditFile, repoDir);
      const verdict = evaluateSpawnBudgetClass({
        classId: 'supervisor-child-tick',
        budget,
        measuredPwshGuardSpawns: measured.pwshGuardSpawns,
        commandCount: measured.commandCount,
      });
      expect(verdict.ok).toBe(true);
      expect(measured.pwshGuardSpawns).toBe(0);
    });
  });

  it('reports per-class measured counts and derived budgets', () => {
    const report = formatSpawnBudgetReport({
      budget,
      measurements: {
        'noop-shell': { helperGrowth: 0 },
        'git-ao-read': { measuredPwshGuardSpawns: 0, commandCount: mandatoryReadCommands.length },
        'supervisor-child-tick': { measuredPwshGuardSpawns: 0, commandCount: 6 },
      },
    });
    expect(report).toContain('noop-shell');
    expect(report).toContain('git-ao-read');
    expect(report).toContain('supervisor-child-tick');
    expect(report).toContain('status=PASS');
  });

  it('fails synthetic per-command fork amplifier regression fixture', () => {
    const amplified = evaluateSpawnBudgetClass({
      classId: 'git-ao-read',
      budget,
      measuredPwshGuardSpawns: mandatoryReadCommands.length,
      commandCount: mandatoryReadCommands.length,
    });
    expect(amplified.ok).toBe(false);
    expect(amplified.reason).toBe('pwsh_guard_spawn_budget_exceeded');
  });
});
