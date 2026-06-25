import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');
const scriptsDir = join(repoRoot, 'scripts');
const fakeGh = join(scriptsDir, 'fixtures/github-fleet-cache/fake-gh.sh');

type FleetHarness = {
  root: string;
  auditFile: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
};

function createFleetHarness(): FleetHarness {
  const root = mkdtempSync(join(tmpdir(), 'gh-fleet-cache-'));
  const auditFile = join(root, 'audit.log');
  writeFileSync(auditFile, '');
  chmodSync(fakeGh, 0o755);
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'gh'), readFileSync(fakeGh));
  chmodSync(join(binDir, 'gh'), 0o755);
  const env = {
    ...process.env,
    AO_SIDE_PROCESS_STATE_DIR: join(root, 'supervisor-state'),
    GH_FLEET_OPEN_PR_LIST_TTL_SECONDS: '30',
    GH_FLEET_TEST_AUDIT_FILE: auditFile,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  };
  return {
    root,
    auditFile,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function countAuditMatches(auditFile: string, pattern: RegExp): number {
  const lines = readFileSync(auditFile, 'utf8').split('\n').filter(Boolean);
  return lines.filter((line) => pattern.test(line)).length;
}

function invokeOpenPrListScript(packRoot: string): string {
  const packRootEscaped = packRoot.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
. '${join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
$prs = Invoke-GhOpenPrList -RepoRoot '${packRootEscaped}'
if (@($prs).Count -lt 1) { throw 'expected PR rows' }
Write-Output "ok:$($prs[0].headRefOid)"
`;
}

describe('github-fleet-cache coalesce (Issue #453 AC#1)', () => {
  let harness: FleetHarness;

  afterEach(() => {
    harness?.cleanup();
  });

  it('cold single reader performs one upstream gh pr list populate', () => {
    harness = createFleetHarness();
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', invokeOpenPrListScript(repoRoot)], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(countAuditMatches(harness.auditFile, /\bpr list\b/)).toBe(1);
  });

  it('warm snapshot serves concurrent readers with zero additional gh pr list calls', () => {
    harness = createFleetHarness();
    const warm = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', invokeOpenPrListScript(repoRoot)], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(warm.status).toBe(0);

    const workerScript = invokeOpenPrListScript(repoRoot).replace('Write-Output', '$null = $prs; Write-Output');
    const parallel = Array.from({ length: 5 }, () =>
      spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', workerScript], {
        cwd: repoRoot,
        env: harness.env,
        encoding: 'utf8',
      }),
    );
    for (const result of parallel) {
      expect(result.status).toBe(0);
    }
    expect(countAuditMatches(harness.auditFile, /\bpr list\b/)).toBe(1);
  });

  it('cold concurrent readers coalesce populate to at most two gh pr list calls', () => {
    harness = createFleetHarness();
    const workerScript = `
$ErrorActionPreference = 'Stop'
. '${join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
$null = Invoke-GhOpenPrList -RepoRoot '${repoRoot.replace(/'/g, "''")}'
Write-Output 'done'
`;
    const parallel = Array.from({ length: 9 }, () =>
      spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', workerScript], {
        cwd: repoRoot,
        env: harness.env,
        encoding: 'utf8',
      }),
    );
    for (const result of parallel) {
      expect(result.status).toBe(0);
    }
    const listCalls = countAuditMatches(harness.auditFile, /\bpr list\b/);
    expect(listCalls).toBeGreaterThanOrEqual(1);
    expect(listCalls).toBeLessThanOrEqual(2);
  });

  it('propagates populate errors to waiters without silent per-child fallback', () => {
    harness = createFleetHarness();
    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"\necho 'rate limited' >&2\nexit 1\n`,
      { mode: 0o755 },
    );

    const workerScript = `
$ErrorActionPreference = 'Stop'
. '${join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
try {
  $null = Invoke-GhOpenPrList -RepoRoot '${repoRoot.replace(/'/g, "''")}'
  throw 'expected failure'
}
catch {
  if ($_.Exception.Message -notmatch 'gh pr list failed') { throw }
  Write-Output 'failed-expected'
}
`;
    const first = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', workerScript], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('failed-expected');

    const second = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', workerScript], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('failed-expected');
    expect(countAuditMatches(harness.auditFile, /\bpr list\b/)).toBe(1);
  });
});
