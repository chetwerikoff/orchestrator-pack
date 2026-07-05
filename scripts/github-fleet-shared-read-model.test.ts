import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import {
  buildGithubFleetWakeConsumers,
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

const GH_AUDIT_CALL_PATTERNS = [/\bpr list\b/, /\bpr view\b/, /\bpr checks\b/, /branches\/.*\/protection/] as const;


const CONSUMERS = buildGithubFleetWakeConsumers(repoRoot);

function auditLines(auditFile: string): string[] {
  return readFileSync(auditFile, 'utf8').split('\n').filter(Boolean);
}

function countPattern(auditFile: string, pattern: RegExp): number {
  return auditLines(auditFile).filter((line) => pattern.test(line)).length;
}

function warmFleetSnapshot(env: NodeJS.ProcessEnv): void {
  const warm = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', CONSUMERS[0].script], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  expect(warm.status, warm.stderr || warm.stdout).toBe(0);
}

describe.sequential('github-fleet-shared-read-model (Issue #569)', () => {
  let harness: FleetHarness;

  afterEach(() => {
    harness?.cleanup();
  });

  it('AC#1 warm shared snapshot serves five consumers with bounded upstream keys', async () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-warm-');
    warmFleetSnapshot(harness.env);
    const baselineList = countPattern(harness.auditFile, /\bpr list\b/);
    const baselineChecks1 = countPattern(harness.auditFile, /\bpr checks\b.*\b1\b/);
    const baselineChecks2 = countPattern(harness.auditFile, /\bpr checks\b.*\b2\b/);
    const baselineProtection = countPattern(harness.auditFile, /branches\/.*\/protection/);

    const parallel = await Promise.all(
      CONSUMERS.slice(1).map((consumer) => spawnPwsh(consumer.script, repoRoot, harness.env)),
    );
    for (const [index, result] of parallel.entries()) {
      expect(result.status, `consumer ${index}: ${result.stderr || result.stdout}`).toBe(0);
    }

    expect(countPattern(harness.auditFile, /\bpr list\b/)).toBe(baselineList);
    expect(countPattern(harness.auditFile, /\bpr checks\b.*\b1\b/)).toBe(baselineChecks1);
    expect(countPattern(harness.auditFile, /\bpr checks\b.*\b2\b/)).toBe(baselineChecks2);
    expect(countPattern(harness.auditFile, /branches\/.*\/protection/)).toBeLessThanOrEqual(
      baselineProtection + 1,
    );
    expect(countPattern(harness.auditFile, /fleet-cache-audit event=.*_hit/)).toBeGreaterThan(0);
  });

  it('AC#2 CI by head SHA dedupe: one upstream checks populate per unique head in TTL', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-checks-');
    const script = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$head = 'sha1111111111111111111111111111111111111111'
$c1 = Invoke-GhPrChecks -RepoRoot '${packRootEscaped}' -PrNumber 1 -HeadSha $head -Consumer 'consumer-a'
$c2 = Invoke-GhPrChecks -RepoRoot '${packRootEscaped}' -PrNumber 1 -HeadSha $head -Consumer 'consumer-b'
if ($c1.Count -lt 1 -or $c2.Count -lt 1) { throw 'expected checks' }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(countPattern(harness.auditFile, /\bpr checks\b/)).toBe(1);
  });

  it('AC#3 explicit TTL contract per data class', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-ttl-');
    const script = `
$ErrorActionPreference = 'Stop'
. '${fleetCache}'
$contract = Get-GhFleetInventoryCacheTtlContract
if ($contract.prView -ge $contract.branchProtection) { throw 'prView must be shorter than branchProtection' }
if ($contract.ciChecks -ge $contract.branchProtection) { throw 'ciChecks must be shorter than branchProtection' }
if ($contract.negativeLookup -le 0) { throw 'negativeLookup ttl required' }
if ($contract.reviewFreshness -le 0) { throw 'reviewFreshness ttl required' }
Write-Output ($contract | ConvertTo-Json -Compress)
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const contract = JSON.parse(result.stdout.trim()) as Record<string, number>;
    expect(contract.prView).toBe(15);
    expect(contract.ciChecks).toBe(15);
    expect(contract.branchProtection).toBe(300);
    expect(contract.negativeLookup).toBe(30);
  });

  it('AC#4 stale cached PR head blocks downstream bundle action', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-stale-');
    const warmScript = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$null = Invoke-GhFleetCachedPrView -RepoRoot '${packRootEscaped}' -PrNumber 1
Write-Output 'warmed'
`;
    const warm = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', warmScript], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(warm.status).toBe(0);

    const fenceScript = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$open = @([pscustomobject]@{ number = 1; headRefOid = 'sha2222222222222222222222222222222222222222' })
$bundle = Get-GhChecksBundleByPr -RepoRoot '${packRootEscaped}' -OpenPrs $open -MergeRequiredNames { param($p) @($p.contexts) }
if ($bundle.ciChecksByPr.ContainsKey('1')) { throw 'stale head must not populate checks' }
Write-Output 'fenced'
`;
    const fenced = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', fenceScript], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(fenced.status).toBe(0);
    expect(fenced.stdout).toContain('fenced');
    expect(countPattern(harness.auditFile, /\bpr checks\b/)).toBe(0);
  });

  it('AC#5 branch protection TTL warm hit and expiry repopulate', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-protection-');
    harness.env.GH_FLEET_BRANCH_PROTECTION_TTL_SECONDS = '2';
    const script = `
$ErrorActionPreference = 'Stop'
. '${fleetCache}'
$p1 = Invoke-GhFleetCachedBranchProtection -RepoRoot '${packRootEscaped}' -BaseBranch 'main' -Consumer 'warm-a'
$p2 = Invoke-GhFleetCachedBranchProtection -RepoRoot '${packRootEscaped}' -BaseBranch 'main' -Consumer 'warm-b'
if (-not $p1.protection -or -not $p2.protection) { throw 'expected protection payload' }
Start-Sleep -Seconds 3
$p3 = Invoke-GhFleetCachedBranchProtection -RepoRoot '${packRootEscaped}' -BaseBranch 'main' -Consumer 'after-ttl'
if (-not $p3.protection) { throw 'expected repopulated protection' }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(countPattern(harness.auditFile, /branches\/.*\/protection/)).toBe(2);
  });

  it('AC#6 known prNumber scoped populate does not call open pr list', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-scoped-');
    const script = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$rows = @(Invoke-GhOpenPrListForNumbers -RepoRoot '${packRootEscaped}' -PrNumbers @(1) -Consumer 'scoped')
if ($rows.Count -ne 1) { throw 'expected one scoped row' }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(countPattern(harness.auditFile, /\bpr list\b/)).toBe(0);
    expect(countPattern(harness.auditFile, /\bpr view\b/)).toBe(1);
  });

  it('AC#7 negative cache avoids repeated upstream reads in same TTL', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-negative-');
    harness.env.GH_FLEET_TEST_HEAD_BRANCH_NO_PR = '1';
    const script = `
$ErrorActionPreference = 'Stop'
. '${fleetCache}'
$n1 = Invoke-GhFleetCachedPrNumberByHeadBranch -RepoRoot '${packRootEscaped}' -HeadBranch 'feat/no-pr-branch' -Consumer 'neg-a'
$n2 = Invoke-GhFleetCachedPrNumberByHeadBranch -RepoRoot '${packRootEscaped}' -HeadBranch 'feat/no-pr-branch' -Consumer 'neg-b'
if ($null -ne $n1 -or $null -ne $n2) { throw 'expected negative no-pr' }
$r1 = Invoke-GhFleetCachedReviewFreshness -RepoRoot '${packRootEscaped}' -PrNumber 1 -HeadSha 'sha1111111111111111111111111111111111111111' -ReviewActive:$false -Consumer 'neg-c'
$r2 = Invoke-GhFleetCachedReviewFreshness -RepoRoot '${packRootEscaped}' -PrNumber 1 -HeadSha 'sha1111111111111111111111111111111111111111' -ReviewActive:$false -Consumer 'neg-d'
if (-not $r1.negative -or -not $r2.negative) { throw 'expected review negative' }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(countPattern(harness.auditFile, /\bpr list\b.*--head/)).toBe(1);
    expect(countPattern(harness.auditFile, /pulls\/.*\/reviews/)).toBe(0);
  });

  it('AC#8 review-active PR shares one freshness populate per TTL', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-review-');
    const script = `
$ErrorActionPreference = 'Stop'
. '${fleetCache}'
$f1 = Invoke-GhFleetCachedReviewFreshness -RepoRoot '${packRootEscaped}' -PrNumber 1 -HeadSha 'sha1111111111111111111111111111111111111111' -ReviewActive:$true -Consumer 'rev-a'
$f2 = Invoke-GhFleetCachedReviewFreshness -RepoRoot '${packRootEscaped}' -PrNumber 1 -HeadSha 'sha1111111111111111111111111111111111111111' -ReviewActive:$true -Consumer 'rev-b'
if (-not $f1.etag -or $f1.etag -ne $f2.etag) { throw 'expected shared etag' }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(countPattern(harness.auditFile, /pulls\/.*\/reviews/)).toBe(1);
  });

  it('AC#9 single-flight cold populate for concurrent same-key readers', async () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-cold-');
    const worker = `
$ErrorActionPreference = 'Stop'
. '${fleetCache}'
$null = Invoke-GhFleetCachedPrView -RepoRoot '${packRootEscaped}' -PrNumber 2 -Consumer 'cold'
Write-Output 'done'
`;
    const parallel = await spawnPwshParallel(6, worker, repoRoot, harness.env);
    for (const result of parallel) {
      expect(result.status).toBe(0);
    }
    const viewCalls = countPattern(harness.auditFile, /\bpr view\b.*\b2\b/);
    expect(viewCalls).toBeGreaterThanOrEqual(1);
    expect(viewCalls).toBeLessThanOrEqual(2);
  });

  it('AC#11 extends existing Gh-FleetInventoryCache framework', () => {
    const content = readFileSync(join(scriptsDir, 'lib/Gh-FleetInventoryCache.ps1'), 'utf8');
    expect(content).toMatch(/function Invoke-GhFleetCachedDatum/);
    expect(content).toMatch(/function Invoke-GhFleetCachedOpenPrListRaw/);
    expect(content).not.toMatch(/Gh-FleetSharedCache\.ps1/);
  });

  it('AC#12 measurement harness reports at least 5x reduction vs per-consumer reads', async () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-measure-');
    const ghPatterns = [...GH_AUDIT_CALL_PATTERNS];
    const countGhCalls = (auditFile: string) =>
      auditLines(auditFile).filter((line) => ghPatterns.some((pattern) => pattern.test(line))).length;
    const naivePerConsumerCalls = CONSUMERS.length * 5;
    warmFleetSnapshot(harness.env);
    const beforeGh = countGhCalls(harness.auditFile);
    const parallel = await Promise.all(
      CONSUMERS.map((consumer) => spawnPwsh(consumer.script, repoRoot, harness.env)),
    );
    for (const result of parallel) {
      expect(result.status).toBe(0);
    }
    const afterWarmGh = countGhCalls(harness.auditFile) - beforeGh;
    expect(naivePerConsumerCalls / Math.max(afterWarmGh, 1)).toBeGreaterThanOrEqual(5);
  });

  it('AC#13 audit lines include key, consumer, and saved duplicate metadata', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-audit-');
    const script = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$null = Invoke-GhPrChecks -RepoRoot '${packRootEscaped}' -PrNumber 1 -HeadSha 'sha1111111111111111111111111111111111111111' -Consumer 'audit-a'
$null = Invoke-GhPrChecks -RepoRoot '${packRootEscaped}' -PrNumber 1 -HeadSha 'sha1111111111111111111111111111111111111111' -Consumer 'audit-b'
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const audit = auditLines(harness.auditFile).join('\n');
    expect(audit).toMatch(/fleet-cache-audit event=ci_checks_hit/);
    expect(audit).toMatch(/consumer=audit-b/);
    expect(audit).toMatch(/savedDuplicateCalls=/);
  });

  it('AC#14 populate failures are not cached as success for retry', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-fail-');
    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"
joined="$*"
if [[ "$joined" == *"pr checks"* ]] && [[ "\${GH_FLEET_TEST_CHECKS_FAIL:-}" == "1" ]]; then
  echo 'rate limited' >&2
  exit 1
fi
exec ${join(scriptsDir, 'fixtures/github-fleet-cache/fake-gh.sh').replace(/'/g, "'\\''")} "$@"
`,
      { mode: 0o755 },
    );

    const failScript = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
try {
  $null = Invoke-GhPrChecks -RepoRoot '${packRootEscaped}' -PrNumber 1 -HeadSha 'sha1111111111111111111111111111111111111111'
  throw 'expected failure'
}
catch {
  if ($_.Exception.Message -notmatch 'snapshot_populate_failed') { throw }
}
Write-Output 'failed-expected'
`;
    const failEnv = { ...harness.env, GH_FLEET_TEST_CHECKS_FAIL: '1' };
    const fail = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', failScript], {
      cwd: repoRoot,
      env: failEnv,
      encoding: 'utf8',
    });
    expect(fail.status).toBe(0);
    expect(fail.stdout).toContain('failed-expected');
    const checksAfterFail = countPattern(harness.auditFile, /\bpr checks\b/);
    expect(checksAfterFail).toBeGreaterThanOrEqual(1);

    const retryScript = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$checks = Invoke-GhPrChecks -RepoRoot '${packRootEscaped}' -PrNumber 1 -HeadSha 'sha1111111111111111111111111111111111111111'
if ($checks.Count -lt 1) { throw 'expected recovered checks' }
Write-Output 'recovered'
`;
    const retry = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', retryScript], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(retry.status, retry.stderr || retry.stdout).toBe(0);
    expect(retry.stdout).toContain('recovered');
    expect(countPattern(harness.auditFile, /\bpr checks\b/)).toBeGreaterThan(checksAfterFail);
  });

  it('AC#12 measurement regexes use word boundaries (review P2)', () => {
    expect(GH_AUDIT_CALL_PATTERNS[0].test('gh pr list --state open')).toBe(true);
    expect(GH_AUDIT_CALL_PATTERNS[0].test('gh pr listicle')).toBe(false);
    expect(GH_AUDIT_CALL_PATTERNS[1].test('gh pr view 1 --json number')).toBe(true);
    expect(GH_AUDIT_CALL_PATTERNS[2].test('gh pr checks 1 --json name')).toBe(true);
  });

  it('pr view and branch protection tolerate stderr before JSON on exit 0 (review P2)', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-json-stderr-');
    const fakeGh = join(scriptsDir, 'fixtures/github-fleet-cache/fake-gh.sh').replace(/'/g, "'\\''");
    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"
joined="$*"
if [[ "$joined" == *"pr view"* ]]; then
  echo 'gh notice: noisy shim warning' >&2
  echo '{"number":1,"headRefOid":"sha1111111111111111111111111111111111111111","baseRefName":"main","headRefName":"feat/pr-1","state":"OPEN","isDraft":false,"mergeable":"MERGEABLE"}'
  exit 0
fi
if [[ "$joined" == *"branches/"*"/protection"* ]]; then
  echo 'gh api notice: deprecation warning' >&2
  echo '{"required_status_checks":{"contexts":["Verify orchestrator-pack structure"],"checks":[]}}'
  exit 0
fi
exec ${fakeGh} "$@"
`,
      { mode: 0o755 },
    );

    const script = `
$ErrorActionPreference = 'Stop'
. '${fleetCache}'
$view = Invoke-GhFleetCachedPrView -RepoRoot '${packRootEscaped}' -PrNumber 1 -Consumer 'stderr-json'
if (-not $view -or [int]$view.number -ne 1) { throw 'expected pr view from noisy output' }
$protection = Invoke-GhFleetCachedBranchProtection -RepoRoot '${packRootEscaped}' -BaseBranch 'main' -Consumer 'stderr-json'
if (-not $protection.protection) { throw 'expected branch protection from noisy output' }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('ok');
  });

    it('head-branch and review freshness tolerate stderr before payload (review P2)', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-head-review-stderr-');
    const fakeGh = join(scriptsDir, 'fixtures/github-fleet-cache/fake-gh.sh').replace(/'/g, "'\\''");
    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"
joined="$*"
if [[ "$joined" == *"pr list"* && "$joined" == *"--head"* ]]; then
  echo 'gh notice: noisy shim warning' >&2
  echo '[]'
  exit 0
fi
if [[ "$joined" == *"pulls/"*"/reviews"* ]]; then
  echo 'gh api notice: deprecation warning' >&2
  echo '2'
  exit 0
fi
exec ${fakeGh} "$@"
`,
      { mode: 0o755 },
    );

    const script = `
$ErrorActionPreference = 'Stop'
. '${fleetCache}'
$n = Invoke-GhFleetCachedPrNumberByHeadBranch -RepoRoot '${packRootEscaped}' -HeadBranch 'feat/no-pr-branch' -Consumer 'stderr-head'
if ($null -ne $n) { throw 'expected negative head lookup from noisy output' }
$f = Invoke-GhFleetCachedReviewFreshness -RepoRoot '${packRootEscaped}' -PrNumber 1 -HeadSha 'sha1111111111111111111111111111111111111111' -ReviewActive:$true -Consumer 'stderr-review'
if ($f.reviewCount -ne 2) { throw "expected review count 2, got $($f.reviewCount)" }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('ok');
  });

    it('preserves check JSON when gh pr checks exits nonzero (review P1)', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-checks-nonzero-');
    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"
joined="$*"
if [[ "$joined" == *"pr checks"* ]]; then
  echo '[{"name":"Verify","state":"FAILURE","bucket":"fail"}]'
  exit 1
fi
exec ${join(scriptsDir, 'fixtures/github-fleet-cache/fake-gh.sh').replace(/'/g, "'\''")} "$@"
`,
      { mode: 0o755 },
    );

    const script = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$checks = Invoke-GhPrChecks -RepoRoot '${packRootEscaped}' -PrNumber 1 -HeadSha 'sha1111111111111111111111111111111111111111'
if ($checks.Count -ne 1) { throw 'expected parsed checks on nonzero exit' }
if ($checks[0].state -ne 'FAILURE') { throw 'expected failure state' }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('ok');
  });

  it('open-pr list snapshot includes headRefName for byHeadRefName index (review P2)', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-head-name-index-');
    const script = `
$ErrorActionPreference = 'Stop'
. '${fleetCache}'
$idx = Get-GhFleetOpenPrIndexes -RepoRoot '${packRootEscaped}'
if (-not $idx.byHeadRefName.ContainsKey('feat/pr-1')) { throw 'expected headRefName index for feat/pr-1' }
if ([int]$idx.byHeadRefName['feat/pr-1'].number -ne 1) { throw 'expected pr 1 via headRefName' }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('ok');
    const listCalls = auditLines(harness.auditFile).filter((line) => /\bpr list\b/.test(line));
    expect(listCalls.some((line) => line.includes('headRefName'))).toBe(true);
  });

    it('bundle resolves missing headRefOid via cached pr view (review P2)', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-number-only-');
    const script = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$open = @([pscustomobject]@{ number = 1 })
$bundle = Get-GhChecksBundleByPr -RepoRoot '${packRootEscaped}' -OpenPrs $open -Consumer 'number-only' -MergeRequiredNames { param($p) @($p.contexts) }
if (-not $bundle.ciChecksByPr.ContainsKey('1')) { throw 'expected checks for number-only open pr' }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('ok');
  });

    it('bundle stale-head gate contains pr view failures per PR (review P2)', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-bundle-view-fail-');
    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"
joined="$*"
if [[ "$joined" == *"pr view 2"* ]] || [[ "$joined" == *"pr view 2 --"* ]]; then
  echo 'transient view miss' >&2
  exit 1
fi
exec ${join(scriptsDir, 'fixtures/github-fleet-cache/fake-gh.sh').replace(/'/g, "'\''")} "$@"
`,
      { mode: 0o755 },
    );

    const script = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$open = @(
  [pscustomobject]@{ number = 1; headRefOid = 'sha1111111111111111111111111111111111111111' }
  [pscustomobject]@{ number = 2; headRefOid = 'sha2222222222222222222222222222222222222222' }
)
$bundle = Get-GhChecksBundleByPr -RepoRoot '${packRootEscaped}' -OpenPrs $open -Consumer 'bundle-view-fail' -MergeRequiredNames { param($p) @($p.contexts) }
if (-not $bundle.ciChecksByPr.ContainsKey('1')) { throw 'expected pr 1 checks' }
if ($bundle.ciChecksByPr.ContainsKey('2')) { throw 'pr 2 view failure must skip checks' }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('ok');
  });

    it('scoped PR refresh skips view misses without aborting batch (review P2)', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-scoped-skip-');
    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"
joined="$*"
if [[ "$joined" == *"pr view 2"* ]] || [[ "$joined" == *"pr view 2 --"* ]]; then
  echo 'transient view miss' >&2
  exit 1
fi
exec ${join(scriptsDir, 'fixtures/github-fleet-cache/fake-gh.sh').replace(/'/g, "'\''")} "$@"
`,
      { mode: 0o755 },
    );

    const script = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$rows = @(Invoke-GhOpenPrListForNumbers -RepoRoot '${packRootEscaped}' -PrNumbers @(1,2) -Consumer 'scoped-skip')
if ($rows.Count -ne 1) { throw "expected one open pr, got $($rows.Count)" }
if ([int]$rows[0].number -ne 1) { throw 'expected pr 1 only' }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('ok');
  });

  it('uncached fail-through enters RepoRoot before upstream pr view (review P2)', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-shared-uncached-cwd-');
    delete harness.env.AO_SIDE_PROCESS_STATE_DIR;
    const otherCwd = join(harness.root, 'other-cwd');
    mkdirSync(otherCwd, { recursive: true });
    const repoRootEscaped = packRootEscaped;
    const cwdProbe = join(harness.root, 'cwd-probe-gh.sh');
    writeFileSync(
      cwdProbe,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$(pwd)" != "${repoRoot.replace(/"/g, '\"')}" ]]; then
  echo "wrong cwd: $(pwd)" >&2
  exit 99
fi
exec ${join(scriptsDir, 'fixtures/github-fleet-cache/fake-gh.sh').replace(/'/g, "'\''")} "$@"
`,
      { mode: 0o755 },
    );
    writeFileSync(join(harness.root, 'bin/gh'), readFileSync(cwdProbe));
    chmodSync(join(harness.root, 'bin/gh'), 0o755);

    const script = `
$ErrorActionPreference = 'Stop'
Push-Location '${otherCwd.replace(/'/g, "''")}'
try {
  New-Item -ItemType Directory -Force -Path (Get-Location).Path | Out-Null
  Remove-Item Env:AO_SIDE_PROCESS_STATE_DIR -ErrorAction SilentlyContinue
  . '${fleetCache}'
  $view = Invoke-GhFleetCachedPrView -RepoRoot '${repoRootEscaped}' -PrNumber 1
  if (-not $view.number) { throw 'expected pr view' }
  Write-Output 'ok'
}
finally {
  Pop-Location
}
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('ok');
  });
});
