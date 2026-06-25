import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');
const scriptsDir = join(repoRoot, 'scripts');
const fakeGh = join(scriptsDir, 'fixtures/github-fleet-cache/fake-gh.sh');

describe('github-fleet-cache stale snapshot safety (Issue #453 AC#6/#7)', () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('serves TTL-valid snapshot without writing supervisor degraded markers (AC#6)', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-fleet-stale-'));
    const auditFile = join(root, 'audit.log');
    writeFileSync(auditFile, '');
    const stateRoot = join(root, 'supervisor-state');
    const progressDir = join(stateRoot, 'progress');
    mkdirSync(progressDir, { recursive: true });
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'gh'), readFileSync(fakeGh));
    chmodSync(join(binDir, 'gh'), 0o755);

    const env = {
      ...process.env,
      AO_SIDE_PROCESS_STATE_DIR: stateRoot,
      GH_FLEET_OPEN_PR_LIST_TTL_SECONDS: '30',
      GH_FLEET_TEST_AUDIT_FILE: auditFile,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    };

    const script = `
$ErrorActionPreference = 'Stop'
. '${join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
$prs = Invoke-GhOpenPrList -RepoRoot '${repoRoot.replace(/'/g, "''")}'
if ($prs[0].headRefOid -ne 'sha1111111111111111111111111111111111111111') { throw 'unexpected cached head' }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(progressDir, 'listener.json'))).toBe(false);
    expect(result.stdout).toContain('ok');
  });

  it('returns cached head within TTL even when upstream list would differ (AC#7 propagation window)', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-fleet-stale-'));
    const auditFile = join(root, 'audit.log');
    writeFileSync(auditFile, '');
    const listJson = join(root, 'list.json');
    writeFileSync(
      listJson,
      JSON.stringify([{ number: 99, headRefOid: 'sha0000000000000000000000000000000000000000', baseRefName: 'main' }]),
    );
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'gh'), readFileSync(fakeGh));
    chmodSync(join(binDir, 'gh'), 0o755);
    const env = {
      ...process.env,
      AO_SIDE_PROCESS_STATE_DIR: join(root, 'supervisor-state'),
      GH_FLEET_OPEN_PR_LIST_TTL_SECONDS: '30',
      GH_FLEET_TEST_AUDIT_FILE: auditFile,
      GH_FLEET_TEST_LIST_JSON: listJson,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    };

    const warmScript = `
$ErrorActionPreference = 'Stop'
. '${join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
$null = Invoke-GhOpenPrList -RepoRoot '${repoRoot.replace(/'/g, "''")}'
Write-Output 'warmed'
`;
    const warm = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', warmScript], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    expect(warm.status).toBe(0);

    writeFileSync(
      listJson,
      JSON.stringify([{ number: 99, headRefOid: 'sha9999999999999999999999999999999999999999', baseRefName: 'main' }]),
    );

    const readScript = `
$ErrorActionPreference = 'Stop'
. '${join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
$prs = Invoke-GhOpenPrList -RepoRoot '${repoRoot.replace(/'/g, "''")}'
Write-Output $prs[0].headRefOid
`;
    const read = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', readScript], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    expect(read.status).toBe(0);
    expect(read.stdout.trim()).toBe('sha0000000000000000000000000000000000000000');
    expect(countListCalls(auditFile)).toBe(1);
  });
});

function countListCalls(auditFile: string): number {
  return readFileSync(auditFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('pr list'))
    .length;
}
