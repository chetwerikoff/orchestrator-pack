import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');

describe('github-fleet-cache bypass guard (Issue #453 AC#3)', () => {
  it('passes registry-aware static guard', () => {
    const check = path.join(repoRoot, 'scripts/check-github-fleet-cache-bypass.ps1');
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', check], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[PASS]');
  });
});
