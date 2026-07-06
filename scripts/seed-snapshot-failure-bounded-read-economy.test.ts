import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import {
  countGithubFleetAuditPattern,
  countGithubFleetGhRoute,
  createGithubFleetCacheHarness,
  spawnPwsh,
  type FleetHarness,
} from './github-fleet-cache-test-harness.js';

const repoRoot = join(import.meta.dirname, '..');
const economyLib = join(repoRoot, 'scripts/lib/Gh-FleetSeedSnapshotReadEconomy.ps1').replace(/'/g, "''");
const ghChecks = join(repoRoot, 'scripts/lib/Gh-PrChecks.ps1').replace(/'/g, "''");
const fleetCache = join(repoRoot, 'scripts/lib/Gh-FleetInventoryCache.ps1').replace(/'/g, "''");
const multiPrList = join(repoRoot, 'scripts/fixtures/github-fleet-cache/open-pr-list-10.json');
const tracked95Fixture = join(repoRoot, 'scripts/fixtures/seed-snapshot-failure/tracked-95.json');
const openPrList95 = join(repoRoot, 'scripts/fixtures/seed-snapshot-failure/open-pr-list-95.json');
const SEED_WORKER_COUNT = 5;
const PRODUCTION_HOURLY_BUDGET = 150;
const CANDIDATE_HEAD_COUNT = 95;

function withSeedHarness(prefix: string): FleetHarness {
  const harness = createGithubFleetCacheHarness(prefix);
  harness.env.GH_FLEET_TEST_LIST_JSON = multiPrList;
  harness.env.GH_FLEET_REPO_TICK_INTERVAL_SECONDS = '30';
  harness.env.GH_FLEET_PR_VIEW_TTL_SECONDS = '15';
  harness.env.GH_FLEET_CI_CHECKS_TTL_SECONDS = '15';
  harness.env.GH_FLEET_SEED_SNAPSHOT_HOURLY_READ_BUDGET = '150';
  return harness;
}

function openPrsScript(trackedLiteral: string, nowMs = 1_700_000_000_000): string {
  return `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
. '${economyLib}'
$open = @(Resolve-ReviewReadyReportStateSeedOpenPrs -RepoRoot '${repoRoot.replace(/'/g, "''")}' -TrackedPrNumbers ${trackedLiteral} -NowMs ${nowMs})
Write-Output (@($open).Count)
`;
}

describe.sequential('seed snapshot failure bounded read economy (Issue #609)', () => {
  let harness: FleetHarness;

  afterEach(() => {
    harness?.cleanup();
  });

  it('fresh shared snapshot uses one list-shaped read for tracked coverage', async () => {
    harness = withSeedHarness('seed-econ-fresh-');
    const tracked = '@(1,2,3)';
    const result = await spawnPwsh(openPrsScript(tracked), repoRoot, harness.env);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(Number(result.stdout.trim())).toBe(3);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/)).toBe(1);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr view\b/)).toBe(0);
    expect(countGithubFleetAuditPattern(harness.auditFile, /event=seed_snapshot_state\b/)).toBeGreaterThan(0);
  });

  it('populate-failing snapshot does not fan out per-head live reads', async () => {
    harness = withSeedHarness('seed-econ-popfail-');
    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"
joined="$*"
case "$joined" in
  *"pr list"*) echo 'rate limited' >&2; exit 1 ;;
  *"pr view"*) echo 'rate limited' >&2; exit 1 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    const tracked = '@(1,2,3,4,5)';
    const first = await spawnPwsh(openPrsScript(tracked), repoRoot, harness.env);
    expect(first.status, first.stderr || first.stdout).toBe(0);
    const listCallsAfterFirst = countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/);
    const viewCallsAfterFirst = countGithubFleetGhRoute(harness.auditFile, /\bpr view\b/);
    expect(listCallsAfterFirst).toBeLessThanOrEqual(2);
    expect(viewCallsAfterFirst).toBe(0);

    const second = await spawnPwsh(openPrsScript(tracked, 1_700_000_060_000), repoRoot, harness.env);
    expect(second.status, second.stderr || second.stdout).toBe(0);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/)).toBe(listCallsAfterFirst);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr view\b/)).toBe(0);
    expect(countGithubFleetAuditPattern(harness.auditFile, /event=seed_snapshot_degraded_serve\b/)).toBeGreaterThan(0);
  });

  it('stale snapshot serves bounded stale cache without per-head fan-out', async () => {
    harness = withSeedHarness('seed-econ-stale-');
    harness.env.GH_FLEET_OPEN_PR_LIST_TTL_SECONDS = '2';
    harness.env.GH_FLEET_SEED_SNAPSHOT_OPEN_PR_LIST_STALE_SERVE_SECONDS = '30';
    const warm = await spawnPwsh(openPrsScript('@(1,2)'), repoRoot, harness.env);
    expect(warm.status).toBe(0);
    const baselineList = countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/);
    const baselineView = countGithubFleetGhRoute(harness.auditFile, /\bpr view\b/);

    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"
joined="$*"
case "$joined" in
  *"pr list"*) echo 'rate limited' >&2; exit 1 ;;
  *"pr view"*) echo 'rate limited' >&2; exit 1 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const stale = await spawnPwsh(openPrsScript('@(1,2,3)', 1_700_000_120_000), repoRoot, harness.env);
    expect(stale.status, stale.stderr || stale.stdout).toBe(0);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/)).toBeLessThanOrEqual(baselineList + 1);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr view\b/)).toBe(baselineView);
    expect(countGithubFleetAuditPattern(harness.auditFile, /event=seed_snapshot_state\b.*state=stale/)).toBeGreaterThan(0);
  });

  it('stale cache issues commit lookups only for tracked PRs', async () => {
    harness = withSeedHarness('seed-econ-stale-commit-');
    harness.env.GH_FLEET_OPEN_PR_LIST_TTL_SECONDS = '2';
    harness.env.GH_FLEET_SEED_SNAPSHOT_OPEN_PR_LIST_STALE_SERVE_SECONDS = '30';
    const warm = await spawnPwsh(openPrsScript('@(1)'), repoRoot, harness.env);
    expect(warm.status, warm.stderr || warm.stdout).toBe(0);

    const clearMemoScript = `
$ErrorActionPreference = 'Stop'
. '${fleetCache}'
$cacheRoot = Get-GhFleetInventoryCacheRoot
if ($cacheRoot) {
  $repoSlug = Resolve-GhFleetRepoSlug -RepoRoot '${repoRoot.replace(/'/g, "''")}'
  $repoKey = Get-GhFleetCacheKeyHash -Text $repoSlug
  $memoDir = Join-Path (Join-Path $cacheRoot 'commit-memo') $repoKey
  if (Test-Path -LiteralPath $memoDir) { Remove-Item -LiteralPath $memoDir -Recurse -Force }
}
Write-Output 'cleared-memo'
`;
    const cleared = await spawnPwsh(clearMemoScript, repoRoot, harness.env);
    expect(cleared.status, cleared.stderr || cleared.stdout).toBe(0);
    const commitsBeforeStale = countGithubFleetGhRoute(harness.auditFile, /commits\//);

    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"
joined="$*"
case "$joined" in
  *"pr list"*) echo 'rate limited' >&2; exit 1 ;;
  *"pr view"*) echo 'rate limited' >&2; exit 1 ;;
  *"commits/"*) echo '2024-06-03T12:00:00Z' ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const stale = await spawnPwsh(openPrsScript('@(1,2)', 1_700_000_120_000), repoRoot, harness.env);
    expect(stale.status, stale.stderr || stale.stdout).toBe(0);
    const commitDelta =
      countGithubFleetGhRoute(harness.auditFile, /commits\//) - commitsBeforeStale;
    expect(commitDelta).toBeLessThanOrEqual(2);
    expect(commitDelta).toBeLessThan(10);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/)).toBeLessThanOrEqual(2);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr view\b/)).toBe(0);
  });

  it('stale cache with zero tracked matches serves empty without repair read', async () => {
    harness = withSeedHarness('seed-econ-stale-empty-');
    harness.env.GH_FLEET_REPO_TICK_INTERVAL_SECONDS = '1';
    harness.env.GH_FLEET_OPEN_PR_LIST_TTL_SECONDS = '2';
    harness.env.GH_FLEET_SEED_SNAPSHOT_OPEN_PR_LIST_STALE_SERVE_SECONDS = '30';
    const warm = await spawnPwsh(openPrsScript('@(1,2)'), repoRoot, harness.env);
    expect(warm.status, warm.stderr || warm.stdout).toBe(0);
    const baselineList = countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/);

    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"
joined="$*"
case "$joined" in
  *"pr list"*) echo 'rate limited' >&2; exit 1 ;;
  *"pr view"*) echo 'rate limited' >&2; exit 1 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const stale = await spawnPwsh(openPrsScript('@(99)', 1_700_000_120_000), repoRoot, harness.env);
    expect(stale.status, stale.stderr || stale.stdout).toBe(0);
    expect(Number(stale.stdout.trim())).toBe(0);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/)).toBe(baselineList);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr view\b/)).toBe(0);
    expect(
      countGithubFleetAuditPattern(harness.auditFile, /event=seed_snapshot_degraded_serve\b.*mode=stale_cache\b/),
    ).toBeGreaterThan(0);
  });

  it('absent snapshot defers to shared repair window without per-head fan-out', async () => {
    harness = withSeedHarness('seed-econ-absent-');
    const inventoryCache = join(repoRoot, 'scripts/lib/Gh-FleetInventoryCache.ps1').replace(/'/g, "''");
    const repoTick = join(repoRoot, 'scripts/lib/Gh-FleetRepoTickSnapshot.ps1').replace(/'/g, "''");
    const clearScript = `
$ErrorActionPreference = 'Stop'
. '${inventoryCache}'
. '${repoTick}'
$paths = Get-GhFleetRepoTickPaths -RepoRoot '${repoRoot.replace(/'/g, "''")}'
if ($paths -and (Test-Path -LiteralPath $paths.Dir)) { Remove-Item -LiteralPath $paths.Dir -Recurse -Force }
$cacheRoot = Get-GhFleetInventoryCacheRoot
if ($cacheRoot) {
  $repoSlug = Resolve-GhFleetRepoSlug -RepoRoot '${repoRoot.replace(/'/g, "''")}'
  $queryId = Get-GhFleetOpenPrListQueryIdentity
  $cacheKey = Get-GhFleetCacheKeyHash -Text "$repoSlug|$queryId"
  $openListPaths = Get-GhFleetOpenPrListSnapshotPaths -CacheRoot $cacheRoot -CacheKey $cacheKey
  if (Test-Path -LiteralPath $openListPaths.Dir) { Remove-Item -LiteralPath $openListPaths.Dir -Recurse -Force }
}
Write-Output 'cleared'
`;
    const cleared = await spawnPwsh(clearScript, repoRoot, harness.env);
    expect(cleared.status).toBe(0);

    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"
joined="$*"
case "$joined" in
  *"pr list"*) echo 'transport down' >&2; exit 1 ;;
  *"pr view"*) echo 'transport down' >&2; exit 1 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );

    const absent = await spawnPwsh(openPrsScript('@(1,2,3)'), repoRoot, harness.env);
    expect(absent.status, absent.stderr || absent.stdout).toBe(0);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr view\b/)).toBe(0);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/)).toBeLessThanOrEqual(2);
    expect(countGithubFleetAuditPattern(harness.auditFile, /event=seed_snapshot_state\b.*state=absent/)).toBeGreaterThan(0);
  });

  it('negative results suppress repeated reads across ticks', async () => {
    harness = withSeedHarness('seed-econ-negative-');
    const tracked = '@(1,2,99)';
    const first = await spawnPwsh(openPrsScript(tracked), repoRoot, harness.env);
    expect(first.status).toBe(0);
    expect(Number(first.stdout.trim())).toBe(2);
    const baselineList = countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/);
    const baselineView = countGithubFleetGhRoute(harness.auditFile, /\bpr view\b/);
    const second = await spawnPwsh(openPrsScript(tracked, 1_700_000_030_000), repoRoot, harness.env);
    expect(second.status).toBe(0);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/)).toBe(baselineList);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr view\b/)).toBe(baselineView);
  });

  it('rate-limit refusal is not immediately retried before cooldown', async () => {
    harness = withSeedHarness('seed-econ-rate-');
    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"
joined="$*"
case "$joined" in
  *"pr list"*) echo 'API rate limit exceeded x-ratelimit-reset=4102444800' >&2; exit 1 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    const tracked = '@(1,2)';
    const first = await spawnPwsh(openPrsScript(tracked), repoRoot, harness.env);
    expect(first.status).toBe(0);
    const listAfterFirst = countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/);
    const second = await spawnPwsh(openPrsScript(tracked, 1_700_000_005_000), repoRoot, harness.env);
    expect(second.status).toBe(0);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/)).toBe(listAfterFirst);
    expect(countGithubFleetAuditPattern(harness.auditFile, /event=seed_snapshot_degraded_serve\b.*repair_suppressed/)).toBeGreaterThan(0);
  });

  it('non-JSON populate failure is classified without poisoning shared snapshot', async () => {
    harness = withSeedHarness('seed-econ-nonjson-');
    const listFixture = openPrList95.replace(/'/g, "''");
    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"
joined="$*"
case "$joined" in
  *"pr list"*)
    echo '/usr/share/bashdb/debugger-support.db: No such file or directory' >&2
    cat '${listFixture}'
  ;;
  *"pr view"*) echo 'should-not-run' >&2; exit 1 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    const script = `
$ErrorActionPreference = 'Stop'
. '${fleetCache}'
Push-Location -LiteralPath '${repoRoot.replace(/'/g, "''")}'
try {
  $rows = @(Invoke-GhFleetFetchOpenPrListUpstream -FailureKind 'snapshot_populate_failed')
  if ($rows.Count -ne 5) { throw "expected 5 rows got $($rows.Count)" }
  Write-Output 'non-json-ok'
}
finally {
  Pop-Location
}
`;
    const result = await spawnPwsh(script, repoRoot, harness.env);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('non-json-ok');
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr view\b/)).toBe(0);
  });

  it('95-head candidate set cannot produce 95 live head lookups per tick', async () => {
    harness = withSeedHarness('seed-econ-95head-');
    harness.env.GH_FLEET_TEST_LIST_JSON = openPrList95;
    const trackedMeta = JSON.parse(readFileSync(tracked95Fixture, 'utf8')) as {
      trackedPrNumbers: number[];
    };
    const trackedLiteral = `@(${trackedMeta.trackedPrNumbers.join(',')})`;
    const result = await spawnPwsh(openPrsScript(trackedLiteral), repoRoot, harness.env);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(Number(result.stdout.trim())).toBe(5);
    expect(countGithubFleetGhRoute(harness.auditFile, /\bpr list\b/)).toBe(1);
    const viewCalls = countGithubFleetGhRoute(harness.auditFile, /\bpr view\b/);
    expect(viewCalls).toBe(0);
  });

  it('shared hourly repair budget caps aggregate reads across five workers (AC#7)', async () => {
    harness = withSeedHarness('seed-econ-budget-prove-');
    const probeBudget = 12;
    const tickCadenceMs = 5_000;
    harness.env.GH_FLEET_SEED_SNAPSHOT_HOURLY_READ_BUDGET = String(probeBudget);
    const baseNowMs = 1_700_000_000_000;
    const budgetProbeScript = `
$ErrorActionPreference = 'Stop'
. '${fleetCache}'
. '${economyLib}'
$repo = '${repoRoot.replace(/'/g, "''")}'
$baseNow = ${baseNowMs}
$workerCount = ${SEED_WORKER_COUNT}
$allowed = 0
$deniedHourly = 0
for ($worker = 0; $worker -lt $workerCount; $worker++) {
  $nowMs = $baseNow + ($worker * ${tickCadenceMs})
  $gate = Test-GhFleetSeedSnapshotRepairAllowed -RepoRoot $repo -NowMs $nowMs -RequestedReads 1
  if ($gate.allowed) {
    Record-GhFleetSeedSnapshotRepairAttempt -Paths $gate.paths -State $gate.state -NowMs $nowMs -Outcome 'budget_probe_ok' -ReadCount 1
    $allowed++
  }
  elseif ($gate.reason -eq 'hourly_budget') {
    $deniedHourly++
  }
}
for ($i = 0; $i -lt ${probeBudget + 3}; $i++) {
  $nowMs = $baseNow + (($workerCount + $i) * ${tickCadenceMs})
  $gate = Test-GhFleetSeedSnapshotRepairAllowed -RepoRoot $repo -NowMs $nowMs -RequestedReads 1
  if ($gate.allowed) {
    Record-GhFleetSeedSnapshotRepairAttempt -Paths $gate.paths -State $gate.state -NowMs $nowMs -Outcome 'budget_probe_ok' -ReadCount 1
    $allowed++
  }
  elseif ($gate.reason -eq 'hourly_budget') {
    $deniedHourly++
  }
}
Write-Output ("$allowed|$deniedHourly")
`;
    const probe = await spawnPwsh(budgetProbeScript, repoRoot, harness.env);
    expect(probe.status, probe.stderr || probe.stdout).toBe(0);
    const [allowedReads, deniedHourly] = probe.stdout.trim().split('|').map(Number);
    expect(allowedReads).toBe(probeBudget);
    expect(deniedHourly).toBeGreaterThan(0);
    expect(allowedReads).toBeLessThanOrEqual(PRODUCTION_HOURLY_BUDGET);

    const contractScript = `
$ErrorActionPreference = 'Stop'
. '${economyLib}'
[pscustomobject](Get-GhFleetSeedSnapshotReadEconomyContract) | ConvertTo-Json -Compress
`;
    const contractResult = await spawnPwsh(contractScript, repoRoot, {
      ...harness.env,
      GH_FLEET_SEED_SNAPSHOT_HOURLY_READ_BUDGET: String(PRODUCTION_HOURLY_BUDGET),
    });
    expect(contractResult.status).toBe(0);
    const contract = JSON.parse(contractResult.stdout.trim()) as { hourlyReadBudget: number };
    expect(contract.hourlyReadBudget).toBe(PRODUCTION_HOURLY_BUDGET);

    const trackedMeta = JSON.parse(readFileSync(tracked95Fixture, 'utf8')) as {
      trackedPrNumbers: number[];
    };
    expect(trackedMeta.trackedPrNumbers.length).toBe(CANDIDATE_HEAD_COUNT);
    expect(SEED_WORKER_COUNT * Math.ceil(3_600_000 / tickCadenceMs)).toBeGreaterThan(PRODUCTION_HOURLY_BUDGET);
  });

});
