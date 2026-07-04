import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export type FleetHarness = {
  root: string;
  auditFile: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
};

export type PwshResult = Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr'>;

export function spawnPwsh(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<PwshResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

export async function spawnPwshParallel(
  count: number,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<PwshResult[]> {
  return Promise.all(Array.from({ length: count }, () => spawnPwsh(command, cwd, env)));
}

export type GithubFleetWakeConsumer = { id: string; script: string };

export type GithubFleetWakeConsumerOptions = {
  minIndexedPrCount?: number;
  minBundlePrCount?: number;
  scopedPrNumbers?: number[];
};

export function buildGithubFleetWakeConsumers(
  packRoot: string,
  options: GithubFleetWakeConsumerOptions = {},
): GithubFleetWakeConsumer[] {
  const ghChecks = join(packRoot, 'scripts/lib/Gh-PrChecks.ps1').replace(/'/g, "''");
  const packRootEscaped = packRoot.replace(/'/g, "''");
  const minIndexedPrCount = options.minIndexedPrCount ?? 2;
  const minBundlePrCount = options.minBundlePrCount ?? 2;
  const scopedPrNumbers = options.scopedPrNumbers ?? [1, 2];
  const scopedLiteral = `@(${scopedPrNumbers.join(',')})`;

  return [
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
$scoped = @(Invoke-GhOpenPrListForNumbers -RepoRoot '${packRootEscaped}' -PrNumbers ${scopedLiteral} -Consumer 'review-finding-delivery-confirm')
if ($scoped.Count -lt ${scopedPrNumbers.length}) { throw 'expected scoped pr rows' }
Write-Output 'ok'
`,
    },
    {
      id: 'ci-failure-notification-reconcile',
      script: `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$idx = Get-GhFleetOpenPrIndexes -RepoRoot '${packRootEscaped}'
if ($idx.byNumber.Count -lt ${minIndexedPrCount}) { throw 'expected pr index' }
$bundle = Get-GhChecksBundleByPr -RepoRoot '${packRootEscaped}' -OpenPrs $idx.prs -Consumer 'ci-failure-notification-reconcile' -MergeRequiredNames { param($p) @($p.contexts) }
if ($bundle.ciChecksByPr.Count -lt ${minBundlePrCount}) { throw 'expected pr checks bundle' }
Write-Output 'ok'
`,
    },
    {
      id: 'review-ready-report-state-seed',
      script: `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$null = Get-GhFleetRepoTickSnapshotIfConsumable -RepoRoot '${packRootEscaped}' -Consumer 'review-ready-report-state-seed' -DataClass 'github_snapshot'
$open = @(Invoke-GhOpenPrListForNumbers -RepoRoot '${packRootEscaped}' -PrNumbers ${scopedLiteral} -Consumer 'review-ready-report-state-seed')
if ($open.Count -lt ${scopedPrNumbers.length}) { throw 'expected scoped pr rows' }
$bundle = Get-GhChecksBundleByPr -RepoRoot '${packRootEscaped}' -OpenPrs $open -Consumer 'review-ready-report-state-seed' -MergeRequiredNames { param($p) @($p.contexts) }
if ($bundle.ciChecksByPr.Count -lt ${scopedPrNumbers.length}) { throw 'expected checks bundle' }
Write-Output 'ok'
`,
    },
  ];
}

export function readGithubFleetAuditLines(auditFile: string): string[] {
  return readFileSync(auditFile, 'utf8').split('\n').filter(Boolean);
}

export function countGithubFleetAuditPattern(auditFile: string, pattern: RegExp): number {
  return readGithubFleetAuditLines(auditFile).filter((line) => pattern.test(line)).length;
}

export function countGithubFleetGhRoute(auditFile: string, route: RegExp): number {
  return readGithubFleetAuditLines(auditFile).filter(
    (line) => !line.startsWith('fleet-cache-audit') && route.test(line),
  ).length;
}

export function createGithubFleetCacheHarness(prefix = 'gh-fleet-cache-'): FleetHarness {
  const repoRoot = join(import.meta.dirname, '..');
  const fakeGh = join(repoRoot, 'scripts/fixtures/github-fleet-cache/fake-gh.sh');
  const root = mkdtempSync(join(tmpdir(), prefix));
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
    GH_FLEET_PR_VIEW_TTL_SECONDS: '15',
    GH_FLEET_CI_CHECKS_TTL_SECONDS: '15',
    GH_FLEET_BRANCH_PROTECTION_TTL_SECONDS: '300',
    GH_FLEET_NEGATIVE_LOOKUP_TTL_SECONDS: '30',
    GH_FLEET_REVIEW_FRESHNESS_TTL_SECONDS: '30',
    GH_FLEET_REPO_TICK_INTERVAL_SECONDS: '30',
    GH_FLEET_REPO_TICK_STALE_SERVE_SECONDS: '30',
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
