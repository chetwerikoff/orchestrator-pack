import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import {
  createGithubFleetCacheHarness,
  spawnPwsh,
  spawnPwshParallel,
  type FleetHarness,
} from './github-fleet-cache-test-harness.js';

const repoRoot = join(import.meta.dirname, '..');
const scriptsDir = join(repoRoot, 'scripts');
const ghChecks = join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''");
const fleetCache = join(scriptsDir, 'lib/Gh-FleetInventoryCache.ps1').replace(/'/g, "''");
const packRootEscaped = repoRoot.replace(/'/g, "''");
const multiPrList = join(scriptsDir, 'fixtures/github-fleet-cache/open-pr-list-10.json');

const REPO_TICK_CONSUMERS: Array<{ id: string; script: string }> = [
  {
    id: 'review-trigger-reconcile',
    script: `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$open = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot '${packRootEscaped}')
$bundle = Get-GhChecksBundleByPr -RepoRoot '${packRootEscaped}' -OpenPrs $open -Consumer 'review-trigger-reconcile' -MergeRequiredNames { param($p) @($p.contexts) }
if ($bundle.ciChecksByPr.Count -lt 1) { throw 'missing checks bundle' }
Write-Output 'ok'
`,
  },
  {
    id: 'ci-green-wake-reconcile',
    script: `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$open = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot '${packRootEscaped}')
$bundle = Get-GhChecksBundleByPr -RepoRoot '${packRootEscaped}' -OpenPrs $open -Consumer 'ci-green-wake-reconcile' -MergeRequiredNames { param($p) @($p.contexts) }
if ($bundle.requiredCheckNamesByPr.Count -lt 1) { throw 'missing required checks' }
Write-Output 'ok'
`,
  },
  {
    id: 'review-send-reconcile',
    script: `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$open = ConvertTo-GhOpenPrArray -OpenPrs (Invoke-GhOpenPrList -RepoRoot '${packRootEscaped}')
$bundle = Get-GhChecksBundleByPr -RepoRoot '${packRootEscaped}' -OpenPrs $open -Consumer 'review-send-reconcile' -MergeRequiredNames { param($p) @($p.contexts) }
if (-not $bundle.ciChecksByPr['1']) { throw 'missing pr1 checks' }
Write-Output 'ok'
`,
  },
  {
    id: 'review-finding-delivery-confirm',
    script: `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$scoped = @(Invoke-GhOpenPrListForNumbers -RepoRoot '${packRootEscaped}' -PrNumbers @(1,2,3) -Consumer 'review-finding-delivery-confirm')
if ($scoped.Count -lt 3) { throw 'expected scoped pr rows' }
Write-Output 'ok'
`,
  },
  {
    id: 'ci-failure-notification-reconcile',
    script: `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$idx = Get-GhFleetOpenPrIndexes -RepoRoot '${packRootEscaped}'
if ($idx.byNumber.Count -lt 10) { throw 'expected pr index' }
$bundle = Get-GhChecksBundleByPr -RepoRoot '${packRootEscaped}' -OpenPrs $idx.prs -Consumer 'ci-failure-notification-reconcile' -MergeRequiredNames { param($p) @($p.contexts) }
if ($bundle.ciChecksByPr.Count -lt 10) { throw 'expected all pr checks' }
Write-Output 'ok'
`,
  },
];

function auditLines(auditFile: string): string[] {
  return readFileSync(auditFile, 'utf8').split('\n').filter(Boolean);
}

function countPattern(auditFile: string, pattern: RegExp): number {
  return auditLines(auditFile).filter((line) => pattern.test(line)).length;
}

function countGhRoute(auditFile: string, route: RegExp): number {
  return auditLines(auditFile).filter((line) => !line.startsWith('fleet-cache-audit') && route.test(line)).length;
}

function withMultiPrHarness(prefix: string): FleetHarness {
  const harness = createGithubFleetCacheHarness(prefix);
  harness.env.GH_FLEET_TEST_LIST_JSON = multiPrList;
  harness.env.GH_FLEET_REPO_TICK_INTERVAL_SECONDS = '30';
  harness.env.GH_FLEET_PR_VIEW_TTL_SECONDS = '15';
  harness.env.GH_FLEET_CI_CHECKS_TTL_SECONDS = '15';
  return harness;
}

describe.sequential('github-fleet-repo-tick-snapshot (Issue #583)', () => {
  let harness: FleetHarness;

  afterEach(() => {
    harness?.cleanup();
  });

  it('AC#1 staggered consumers over 10 PRs consume one repo-tick generation', async () => {
    harness = withMultiPrHarness('gh-repo-tick-ac1-');
    const scripts = REPO_TICK_CONSUMERS.map((c) => c.script);
    for (const [index, script] of scripts.entries()) {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      const result = await spawnPwsh(script, repoRoot, harness.env);
      expect(result.status, `consumer ${index}: ${result.stderr || result.stdout}`).toBe(0);
    }
    expect(countPattern(harness.auditFile, /event=repo_tick_populate\b/)).toBe(1);
    expect(countGhRoute(harness.auditFile, /\bpr list\b/)).toBe(1);
    expect(countGhRoute(harness.auditFile, /\bpr view\b/)).toBe(10);
    expect(countGhRoute(harness.auditFile, /\bpr checks\b/)).toBe(10);
  });

  it('AC#3 TTL-stagger leak closed across per-key TTL window', async () => {
    harness = withMultiPrHarness('gh-repo-tick-ac3-');
    harness.env.GH_FLEET_PR_VIEW_TTL_SECONDS = '15';
    harness.env.GH_FLEET_CI_CHECKS_TTL_SECONDS = '15';
    const warm = await spawnPwsh(REPO_TICK_CONSUMERS[0].script, repoRoot, harness.env);
    expect(warm.status).toBe(0);
    const baselineList = countGhRoute(harness.auditFile, /\bpr list\b/);
    const baselineView = countGhRoute(harness.auditFile, /\bpr view\b/);
    const baselineChecks = countGhRoute(harness.auditFile, /\bpr checks\b/);

    await new Promise((resolve) => setTimeout(resolve, 1600));
    for (const consumer of REPO_TICK_CONSUMERS.slice(1, 4)) {
      const result = await spawnPwsh(consumer.script, repoRoot, harness.env);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    expect(countGhRoute(harness.auditFile, /\bpr list\b/)).toBe(baselineList);
    expect(countGhRoute(harness.auditFile, /\bpr view\b/)).toBe(baselineView);
    expect(countGhRoute(harness.auditFile, /\bpr checks\b/)).toBe(baselineChecks);
    expect(countPattern(harness.auditFile, /event=repo_tick_populate\b/)).toBe(1);
  });

  it('AC#4 populate failure is not cached as success and waiters do not bypass', async () => {
    harness = withMultiPrHarness('gh-repo-tick-ac4-');
    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"\necho 'rate limited' >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    const failScript = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
try {
  $null = Invoke-GhOpenPrList -RepoRoot '${packRootEscaped}'
  throw 'expected failure'
} catch {
  if ($_.Exception.Message -notmatch 'snapshot_populate_failed') { throw }
  Write-Output 'failed-expected'
}
`;
    const first = await spawnPwsh(failScript, repoRoot, harness.env);
    expect(first.status).toBe(0);
    const second = await spawnPwsh(failScript, repoRoot, harness.env);
    expect(second.status).toBe(0);
    expect(countGhRoute(harness.auditFile, /\bpr list\b/)).toBe(1);
    expect(countPattern(harness.auditFile, /event=repo_tick_populate_failed\b/)).toBe(1);
  });

  it('AC#6 action-boundary stale head cannot authorize checks bundle', async () => {
    harness = withMultiPrHarness('gh-repo-tick-ac6-');
    const warmScript = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$null = Invoke-GhFleetCachedPrView -RepoRoot '${packRootEscaped}' -PrNumber 1
Write-Output 'warmed'
`;
    const warm = await spawnPwsh(warmScript, repoRoot, harness.env);
    expect(warm.status).toBe(0);
    const baselineChecks = countGhRoute(harness.auditFile, /\bpr checks\b/);
    const fenceScript = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$open = @([pscustomobject]@{ number = 1; headRefOid = 'sha9999999999999999999999999999999999999999' })
$bundle = Get-GhChecksBundleByPr -RepoRoot '${packRootEscaped}' -OpenPrs $open -MergeRequiredNames { param($p) @($p.contexts) }
if ($bundle.ciChecksByPr.ContainsKey('1')) { throw 'stale head must not populate checks' }
Write-Output 'fenced'
`;
    const fenced = await spawnPwsh(fenceScript, repoRoot, harness.env);
    expect(fenced.status).toBe(0);
    expect(countGhRoute(harness.auditFile, /\bpr checks\b/)).toBe(baselineChecks);
  });

  it('AC#7 call-site coverage guard passes', async () => {
    const check = join(scriptsDir, 'check-github-fleet-repo-tick-coverage.ps1');
    const result = await spawnPwsh(`& '${check.replace(/'/g, "''")}'`, repoRoot, process.env);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('[PASS]');
  });

  it('AC#11 audit events include generation, consumer, and route metadata', async () => {
    harness = withMultiPrHarness('gh-repo-tick-ac11-');
    const result = await spawnPwsh(REPO_TICK_CONSUMERS[0].script, repoRoot, harness.env);
    expect(result.status).toBe(0);
    const audit = readFileSync(harness.auditFile, 'utf8');
    expect(audit).toMatch(/event=repo_tick_populate\b/);
    expect(audit).toMatch(/generation=/);
    expect(audit).toMatch(/route=repo_inventory/);
    expect(audit).toMatch(/openPrCount=/);
  });

  it('cold concurrent open-pr readers coalesce to one repo-tick populate', async () => {
    harness = withMultiPrHarness('gh-repo-tick-cold-');
    const worker = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$null = Invoke-GhOpenPrList -RepoRoot '${packRootEscaped}'
Write-Output 'done'
`;
    const parallel = await spawnPwshParallel(5, worker, repoRoot, harness.env);
    for (const result of parallel) {
      expect(result.status, result.stderr || result.stdout).toBe(0);
    }
    expect(countPattern(harness.auditFile, /event=repo_tick_populate\b/)).toBeGreaterThanOrEqual(1);
    expect(countPattern(harness.auditFile, /event=repo_tick_populate\b/)).toBeLessThanOrEqual(2);
    expect(countGhRoute(harness.auditFile, /\bpr list\b/)).toBeLessThanOrEqual(2);
  });
});
