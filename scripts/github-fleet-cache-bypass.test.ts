import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import {
  createGithubFleetCacheHarness,
  spawnPwsh,
  type FleetHarness,
} from './github-fleet-cache-test-harness.js';

const repoRoot = join(import.meta.dirname, '..');
const scriptsDir = join(repoRoot, 'scripts');
const ghChecks = join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''");
const packRootEscaped = repoRoot.replace(/'/g, "''");

const AFFECTED_CHILDREN: Array<{ id: string; invokeScript: string }> = [
  {
    id: 'review-trigger-reconcile',
    invokeScript: `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$null = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot '${packRootEscaped}')
Write-Output 'ok'
`,
  },
  {
    id: 'ci-green-wake-reconcile',
    invokeScript: `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$null = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot '${packRootEscaped}')
Write-Output 'ok'
`,
  },
  {
    id: 'review-finding-delivery-confirm',
    invokeScript: `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
function Get-OpenPrList { return @(Invoke-GhOpenPrList -RepoRoot '${packRootEscaped}') }
$null = ConvertTo-GhOpenPrArray -OpenPrs (Get-OpenPrList)
Write-Output 'ok'
`,
  },
  {
    id: 'ci-failure-notification-reconcile',
    invokeScript: `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$null = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot '${packRootEscaped}')
Write-Output 'ok'
`,
  },
  {
    id: 'ci-failure-notification-reaction',
    invokeScript: `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$null = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot '${packRootEscaped}')
Write-Output 'ok'
`,
  },
];

function countListCalls(auditFile: string): number {
  return readFileSync(auditFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('pr list'))
    .length;
}

function warmOpenPrSnapshot(env: NodeJS.ProcessEnv): void {
  const warm = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', AFFECTED_CHILDREN[0].invokeScript], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  expect(warm.status).toBe(0);
  expect(countListCalls(env.GH_FLEET_TEST_AUDIT_FILE as string)).toBe(1);
}

describe.sequential('github-fleet-cache bypass (Issue #553)', () => {
  let harness: FleetHarness;

  afterEach(() => {
    harness?.cleanup();
  });

  for (const child of AFFECTED_CHILDREN) {
    it(`${child.id} emits zero upstream gh pr list calls under warm shared snapshot`, () => {
      harness = createGithubFleetCacheHarness(`gh-fleet-bypass-${child.id}-`);
      warmOpenPrSnapshot(harness.env);
      const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', child.invokeScript], {
        cwd: repoRoot,
        env: harness.env,
        encoding: 'utf8',
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(countListCalls(harness.auditFile)).toBe(1);
    });
  }

  it('live-regression: parallel affected children share one upstream populate under warm snapshot', async () => {
    harness = createGithubFleetCacheHarness('gh-fleet-bypass-parallel-');
    warmOpenPrSnapshot(harness.env);
    const parallel = await Promise.all(
      AFFECTED_CHILDREN.map((child) => spawnPwsh(child.invokeScript, repoRoot, harness.env)),
    );
    for (const [index, result] of parallel.entries()) {
      expect(result.status, `worker ${index}: ${result.stderr || result.stdout}`).toBe(0);
    }
    expect(countListCalls(harness.auditFile)).toBe(1);
  });

  it('attributes producer REST 403 as snapshot_populate_failed (not child_list_bypass)', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-bypass-403-');
    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"
echo 'gh-wrapper: REST route failed (HTTP 403)' >&2
exit 1
`,
      { mode: 0o755 },
    );

    const producerScript = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
try {
  $null = Invoke-GhOpenPrList -RepoRoot '${packRootEscaped}'
  throw 'expected producer failure'
}
catch {
  if ($_.Exception.Message -notmatch 'snapshot_populate_failed') { throw }
  Write-Output $_.Exception.Message
}
`;
    const first = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', producerScript], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('snapshot_populate_failed');
    expect(first.stdout).not.toContain('child_list_bypass');
    expect(countListCalls(harness.auditFile)).toBe(1);

    const waiterScript = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
try {
  $null = Invoke-GhOpenPrList -RepoRoot '${packRootEscaped}'
  throw 'expected cached producer failure'
}
catch {
  if ($_.Exception.Message -notmatch 'snapshot_populate_failed') { throw }
  Write-Output 'waiter-ok'
}
`;
    const second = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', waiterScript], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('waiter-ok');
    expect(countListCalls(harness.auditFile)).toBe(1);
  });

  it('does not call native GraphQL when REST open-PR list fails', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-bypass-graphql-');
    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"
joined="$*"
if [[ "$joined" == *"api graphql"* ]]; then
  echo 'graphql should not run' >&2
  exit 99
fi
echo 'gh-wrapper: REST route failed (HTTP 403)' >&2
exit 1
`,
      { mode: 0o755 },
    );

    const script = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
try {
  $null = Invoke-GhOpenPrList -RepoRoot '${packRootEscaped}'
  throw 'expected failure'
}
catch {
  if ($_.Exception.Message -notmatch 'snapshot_populate_failed') { throw }
  Write-Output 'no-graphql'
}
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no-graphql');
    const audit = readFileSync(harness.auditFile, 'utf8');
    expect(audit).not.toContain('api graphql');
  });
});
