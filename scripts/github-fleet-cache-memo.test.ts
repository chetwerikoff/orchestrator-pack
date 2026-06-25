import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');
const scriptsDir = join(repoRoot, 'scripts');
const fakeGh = join(scriptsDir, 'fixtures/github-fleet-cache/fake-gh.sh');

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'gh-fleet-memo-'));
  const auditFile = join(root, 'audit.log');
  writeFileSync(auditFile, '');
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
    auditFile,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function commitLookupCount(auditFile: string): number {
  return readFileSync(auditFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('commits/sha1111111111111111111111111111111111111111')).length;
}

describe('github-fleet-cache memo (Issue #453 AC#2)', () => {
  let harness: ReturnType<typeof createHarness>;

  afterEach(() => {
    harness?.cleanup();
  });

  it('reuses SHA memo without a second gh api commits call', () => {
    harness = createHarness();
    const script = `
$ErrorActionPreference = 'Stop'
. '${join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
$first = Invoke-GhOpenPrList -RepoRoot '${repoRoot.replace(/'/g, "''")}'
$second = Invoke-GhOpenPrList -RepoRoot '${repoRoot.replace(/'/g, "''")}'
if (-not $first[0].headCommittedAt) { throw 'missing headCommittedAt on first read' }
if (-not $second[0].headCommittedAt) { throw 'missing headCommittedAt on second read' }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(commitLookupCount(harness.auditFile)).toBe(1);
  });

  it('coalesces concurrent commit lookups for the same new SHA to at most two upstream calls', () => {
    harness = createHarness();
    const worker = `
$ErrorActionPreference = 'Stop'
. '${join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
$null = Invoke-GhOpenPrList -RepoRoot '${repoRoot.replace(/'/g, "''")}'
Write-Output 'done'
`;
    const parallel = Array.from({ length: 5 }, () =>
      spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', worker], {
        cwd: repoRoot,
        env: harness.env,
        encoding: 'utf8',
      }),
    );
    for (const result of parallel) {
      expect(result.status).toBe(0);
    }
    const sha1Lookups = commitLookupCount(harness.auditFile);
    expect(sha1Lookups).toBeGreaterThanOrEqual(1);
    expect(sha1Lookups).toBeLessThanOrEqual(2);
  });
});
