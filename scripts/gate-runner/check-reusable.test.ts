import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import { runProcess } from '#opk-kernel/subprocess';
import { evaluateTrackedPaths, formatReusablePackReport, runReusablePackGate } from './reusable-pack.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const entryPath = resolve(repoRoot, 'scripts/gate-runner/reusable-pack.ts');

describe('reusable-pack policy', () => {
  it('passes allowed tracked files', () => {
    const evaluation = evaluateTrackedPaths([
      'README.md',
      'scripts/check-reusable.ps1',
      '.github/workflows/scope-guard.yml',
      'tests/powershell/Test-AllRunner.Tests.ps1',
    ]);

    expect(evaluation.violations).toEqual([]);
    expect(evaluation.gate.status).toBe('PASS');
  });

  it('fails forbidden and non-allowlisted files', () => {
    const evaluation = evaluateTrackedPaths([
      'agent-orchestrator.yaml',
      'notes/private-plan.md',
      '.env',
    ]);

    expect(evaluation.gate.status).toBe('FAIL');
    expect(evaluation.violations).toEqual([
      'agent-orchestrator.yaml :: forbidden local/runtime/secret/upstream artifact pattern',
      'notes/private-plan.md :: not in reusable pack allowlist',
      '.env :: forbidden local/runtime/secret/upstream artifact pattern',
    ]);
  });

  it('keeps exception-only files out of the forbidden bucket without auto-allowing them', () => {
    const evaluation = evaluateTrackedPaths(['.env.example', 'agent-orchestrator.yaml.example']);
    expect(evaluation.gate.status).toBe('FAIL');
    expect(evaluation.violations).toEqual(['.env.example :: not in reusable pack allowlist']);
  });

  it('formats a human-readable failure report', () => {
    const evaluation = evaluateTrackedPaths(['.env']);
    const report = formatReusablePackReport(evaluation);
    expect(report).toContain('== reusable repository content guard ==');
    expect(report).toContain('[FAIL] Non-reusable files are tracked or would be pushed.');
    expect(report).toContain('- .env :: forbidden local/runtime/secret/upstream artifact pattern');
  });
});

describe('reusable-pack gate CLI', () => {
  let sandboxRoot = '';

  beforeEach(() => {
    if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true });
    sandboxRoot = mkdtempSync(join(tmpdir(), 'opk-reusable-pack-'));
  });

  it('passes against the current tracked repository', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ['--experimental-strip-types', entryPath, '--repo-root', repoRoot],
      cwd: repoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[PASS] All tracked files match reusable-pack policy.');
  });

  it('fails a temporary repository with a forbidden tracked file', async () => {
    writeFileSync(join(sandboxRoot, 'README.md'), '# temp\n');
    writeFileSync(join(sandboxRoot, '.env'), 'SECRET=1\n');
    await runProcess({
      command: 'git',
      args: ['init'],
      cwd: sandboxRoot,
      inheritParentEnv: true,
      allowEmptyStdout: true,
    });
    await runProcess({
      command: 'git',
      args: ['add', 'README.md', '.env'],
      cwd: sandboxRoot,
      inheritParentEnv: true,
      allowEmptyStdout: true,
    });

    const result = await runProcess({
      command: process.execPath,
      args: ['--experimental-strip-types', entryPath, '--repo-root', sandboxRoot],
      cwd: sandboxRoot,
      inheritParentEnv: true,
      allowEmptyStdout: false,
    });

    expect(result.stdout).toContain('[FAIL] Non-reusable files are tracked or would be pushed.');
    expect(result.stdout).toContain('.env :: forbidden local/runtime/secret/upstream artifact pattern');
  });

  it('returns an allowed skip when git is unavailable and --allow-no-git is set', async () => {
    writeFileSync(join(sandboxRoot, 'README.md'), '# temp\n');
    const result = await runProcess({
      command: process.execPath,
      args: ['--experimental-strip-types', entryPath, '--repo-root', sandboxRoot, '--allow-no-git'],
      cwd: sandboxRoot,
      env: { PATH: '' },
      inheritParentEnv: false,
      allowEmptyStdout: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[SKIP] git not found; cannot inspect tracked files.');
  });

  it('observes the current repository state via the library entrypoint', async () => {
    const evaluation = await runReusablePackGate({ repoRoot });
    expect(evaluation.gate.status).toBe('PASS');
    expect(evaluation.trackedFiles.length).toBeGreaterThan(50);
  });
});
