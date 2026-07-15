import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = join(repoRoot, 'scripts/graphify/check-graphify-no-installer.ps1');

function runGuard(targetRoot: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(
      'pwsh',
      ['-NoProfile', '-File', scriptPath, '-RepoRoot', targetRoot],
      { encoding: 'utf8' },
    );
    return { code: 0, stdout };
  } catch (error: any) {
    return { code: error.status ?? 1, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

describe('check-graphify-no-installer guard (Issue #833 AC#1/AC#7)', () => {
  it('passes against the real repo tree', () => {
    const result = runGuard(repoRoot);
    expect(result.stdout).toContain('[PASS]');
    expect(result.code).toBe(0);
  });

  it('fails when a leaf wrapper bypasses Invoke-GraphifyCommand with a direct install call', () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'graphify-no-installer-negreg-'));
    try {
      mkdirSync(join(scratchRoot, 'scripts/graphify/lib'), { recursive: true });
      cpSync(
        join(repoRoot, 'scripts/graphify/lib/Resolve-GraphifyEnv.ps1'),
        join(scratchRoot, 'scripts/graphify/lib/Resolve-GraphifyEnv.ps1'),
      );
      cpSync(
        join(repoRoot, 'scripts/graphify/refresh-graph.ps1'),
        join(scratchRoot, 'scripts/graphify/refresh-graph.ps1'),
      );
      cpSync(
        join(repoRoot, 'scripts/graphify/query-graph.ps1'),
        join(scratchRoot, 'scripts/graphify/query-graph.ps1'),
      );
      cpSync(
        join(repoRoot, 'scripts/graphify/query-graph.mjs'),
        join(scratchRoot, 'scripts/graphify/query-graph.mjs'),
      );
      // Injected regression: a leaf script that bypasses the guard entirely.
      writeFileSync(
        join(scratchRoot, 'scripts/graphify/build-graph.ps1'),
        "$exe = 'graphify'\n& $exe 'install' '--platform' 'cursor'\n",
      );

      const result = runGuard(scratchRoot);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain('[FAIL]');
      expect(result.stdout).toContain('build-graph.ps1');
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it('fails when the enforcement file drops the extract/update allowlist', () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'graphify-no-installer-negreg-'));
    try {
      for (const rel of [
        'scripts/graphify/build-graph.ps1',
        'scripts/graphify/refresh-graph.ps1',
        'scripts/graphify/query-graph.ps1',
        'scripts/graphify/query-graph.mjs',
      ]) {
        mkdirSync(join(scratchRoot, dirname(rel)), { recursive: true });
        cpSync(join(repoRoot, rel), join(scratchRoot, rel));
      }
      mkdirSync(join(scratchRoot, 'scripts/graphify/lib'), { recursive: true });
      writeFileSync(
        join(scratchRoot, 'scripts/graphify/lib/Resolve-GraphifyEnv.ps1'),
        "function Invoke-GraphifyCommand {\n  param([string]$Subcommand)\n}\n",
      );

      const result = runGuard(scratchRoot);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain('[FAIL]');
      expect(result.stdout).toContain('ValidateSet');
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });
});
