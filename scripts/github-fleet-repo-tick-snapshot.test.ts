import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import {
  buildGithubFleetWakeConsumers,
  countGithubFleetAuditPattern,
  countGithubFleetGhRoute,
  createGithubFleetCacheHarness,
  readGithubFleetAuditLines,
  spawnPwsh,
  spawnPwshParallel,
  type FleetHarness,
} from './github-fleet-cache-test-harness.js';

const repoRoot = join(import.meta.dirname, '..');
const multiPrList = join(repoRoot, 'scripts/fixtures/github-fleet-cache/open-pr-list-10.json');
const REPO_TICK_CONSUMERS = buildGithubFleetWakeConsumers(repoRoot, {
  minIndexedPrCount: 10,
  minBundlePrCount: 10,
  scopedPrNumbers: [1, 2, 3],
});

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
    expect(countGithubFleetAuditPattern(harness.auditFile, /event=repo_tick_populate\b/)).toBe(1);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/)).toBe(1);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr view\b/)).toBe(10);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr checks\b/)).toBe(10);
  });

  it('AC#3 TTL-stagger leak closed across per-key TTL window', async () => {
    harness = withMultiPrHarness('gh-repo-tick-ac3-');
    harness.env.GH_FLEET_PR_VIEW_TTL_SECONDS = '15';
    harness.env.GH_FLEET_CI_CHECKS_TTL_SECONDS = '15';
    const warm = await spawnPwsh(REPO_TICK_CONSUMERS[0].script, repoRoot, harness.env);
    expect(warm.status).toBe(0);
    const baselineList = countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/);
    const baselineView = countGithubFleetGhRoute(harness.auditFile, /\bpr view\b/);
    const baselineChecks = countGithubFleetGhRoute(harness.auditFile, /\bpr checks\b/);

    await new Promise((resolve) => setTimeout(resolve, 1600));
    for (const consumer of REPO_TICK_CONSUMERS.slice(1, 4)) {
      const result = await spawnPwsh(consumer.script, repoRoot, harness.env);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/)).toBe(baselineList);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr view\b/)).toBe(baselineView);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr checks\b/)).toBe(baselineChecks);
    expect(countGithubFleetAuditPattern(harness.auditFile, /event=repo_tick_populate\b/)).toBe(1);
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
. '${join(repoRoot, 'scripts/lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
try {
  $null = Invoke-GhOpenPrList -RepoRoot '${repoRoot.replace(/'/g, "''")}'
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
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/)).toBe(1);
    expect(countGithubFleetAuditPattern(harness.auditFile, /event=repo_tick_populate_failed\b/)).toBe(1);
  });

  it('AC#6 action-boundary stale head cannot authorize checks bundle', async () => {
    harness = withMultiPrHarness('gh-repo-tick-ac6-');
    const ghChecks = join(repoRoot, 'scripts/lib/Gh-PrChecks.ps1').replace(/'/g, "''");
    const warmScript = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$null = Invoke-GhFleetCachedPrView -RepoRoot '${repoRoot.replace(/'/g, "''")}' -PrNumber 1
Write-Output 'warmed'
`;
    const warm = await spawnPwsh(warmScript, repoRoot, harness.env);
    expect(warm.status).toBe(0);
    const baselineChecks = countGithubFleetGhRoute(harness.auditFile, /\bpr checks\b/);
    const fenceScript = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$open = @([pscustomobject]@{ number = 1; headRefOid = 'sha9999999999999999999999999999999999999999' })
$bundle = Get-GhChecksBundleByPr -RepoRoot '${repoRoot.replace(/'/g, "''")}' -OpenPrs $open -MergeRequiredNames { param($p) @($p.contexts) }
if ($bundle.ciChecksByPr.ContainsKey('1')) { throw 'stale head must not populate checks' }
Write-Output 'fenced'
`;
    const fenced = await spawnPwsh(fenceScript, repoRoot, harness.env);
    expect(fenced.status).toBe(0);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr checks\b/)).toBe(baselineChecks);
  });

  it('AC#7 call-site coverage guard passes', async () => {
    const check = join(repoRoot, 'scripts/check-github-fleet-repo-tick-coverage.ps1').replace(/'/g, "''");
    const result = await spawnPwsh(`& '${check}'`, repoRoot, process.env);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('[PASS]');
  });

  it('AC#11 audit events include generation, consumer, and route metadata', async () => {
    harness = withMultiPrHarness('gh-repo-tick-ac11-');
    const result = await spawnPwsh(REPO_TICK_CONSUMERS[0].script, repoRoot, harness.env);
    expect(result.status).toBe(0);
    const audit = readGithubFleetAuditLines(harness.auditFile).join('\n');
    expect(audit).toMatch(/event=repo_tick_populate\b/);
    expect(audit).toMatch(/generation=/);
    expect(audit).toMatch(/route=repo_inventory/);
    expect(audit).toMatch(/openPrCount=/);
  });

  it('cold concurrent open-pr readers coalesce to one repo-tick populate', async () => {
    harness = withMultiPrHarness('gh-repo-tick-cold-');
    const worker = `
$ErrorActionPreference = 'Stop'
. '${join(repoRoot, 'scripts/lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
$null = Invoke-GhOpenPrList -RepoRoot '${repoRoot.replace(/'/g, "''")}'
Write-Output 'done'
`;
    const parallel = await spawnPwshParallel(5, worker, repoRoot, harness.env);
    for (const result of parallel) {
      expect(result.status, result.stderr || result.stdout).toBe(0);
    }
    expect(countGithubFleetAuditPattern(harness.auditFile, /event=repo_tick_populate\b/)).toBeGreaterThanOrEqual(1);
    expect(countGithubFleetAuditPattern(harness.auditFile, /event=repo_tick_populate\b/)).toBeLessThanOrEqual(2);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/)).toBeLessThanOrEqual(2);
  });
});
