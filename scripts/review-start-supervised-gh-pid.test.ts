import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';

const lifecycleHelperPath = path.join(repoRoot, 'scripts/lib/Review-StartClaimLifecycle.ps1');
const claimHelperPath = path.join(repoRoot, 'scripts/lib/Review-StartClaim.ps1');
const guardPath = path.join(repoRoot, 'scripts/check-powershell-pid-param-static.ps1');
const fullSha = '943b6cefbc6071f785d99b0eaf745bd579644d85';

function listPs1Files(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      entries.push(...listPs1Files(full));
      continue;
    }
    if (name.endsWith('.ps1')) {
      entries.push(full);
    }
  }
  return entries;
}

describe('review-start-supervised-gh-pid', () => {
  it('stop-helper-binds-without-pid-collision', () => {
    const script = `
      . ${psString(lifecycleHelperPath)}
      $result = Stop-ReviewStartSupervisedGhChild -ProcessId 999999
      $result | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.stopped).toBe(false);
    expect(result.reason).toBe('not_running');
  });

  it('all Stop-ReviewStartSupervisedGhChild callsites use -ProcessId', () => {
    const scriptsRoot = path.join(repoRoot, 'scripts');
    const offenders: string[] = [];
    for (const file of listPs1Files(scriptsRoot)) {
      const content = readFileSync(file, 'utf8');
      if (/Stop-ReviewStartSupervisedGhChild\s+-Pid\b/i.test(content)) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reconcile-ownership-loss-cleanup-no-pid-bind-error', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'supervised-gh-pid-cleanup-'));
    try {
      const script = `
        . ${psString(claimHelperPath)}
        . ${psString(lifecycleHelperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $first = Acquire-ReviewStartClaim -PrNumber 534 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $first.claim.activeInfraPause = @{
          startedMonotonicMs = 30_000_000
          supervisedGhPid    = 999999
        }
        try {
          Invoke-ReviewStartClaimOwnershipLossCleanup -ClaimResult $first
          @{ ok = $true } | ConvertTo-Json -Compress
        }
        catch {
          @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
        }
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('static guard passes on scripts tree', () => {
    const result = spawnSync('pwsh', ['-NoProfile', '-File', guardPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[PASS]');
  });

  it('static guard fails on reintroduced $Pid parameter declaration', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pid-param-guard-'));
    const fixtureFile = path.join(dir, 'bad-helper.ps1');
    try {
      writeFileSync(fixtureFile, 'function Bad-Helper { param([int]$Pid) }\n', 'utf8');
      const result = spawnSync('pwsh', ['-NoProfile', '-File', guardPath, '-ScriptsRoot', dir], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('[FAIL]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
