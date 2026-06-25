import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { psString, repoRoot, runPwsh } from './supervisor-recovery.test-helpers.js';

const scriptsDir = path.join(repoRoot, 'scripts');
const libDir = path.join(scriptsDir, 'lib');

function expectPwshOk(script: string): void {
  const result = runPwsh(script);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('ok');
  expect(result.stderr ?? '').not.toMatch(/Cannot bind argument to parameter 'OpenPrs'/i);
}

describe('supervisor-child-openprs-null (Issue #450 C4)', () => {
  it('Get-GhChecksBundleByPr tolerates null and empty OpenPrs', () => {
    const ghChecks = path.join(libDir, 'Gh-PrChecks.ps1').replace(/'/g, "''");
    for (const openPrsExpr of ['$null', '@()']) {
      const script = `
$ErrorActionPreference = 'Stop'
. '${ghChecks}'
$bundle = Get-GhChecksBundleByPr -RepoRoot ${psString(scriptsDir)} -OpenPrs ${openPrsExpr} -MergeRequiredNames { param($p) @{ names = @(); lookupFailed = $false } }
if (@($bundle.ciChecksByPr.Keys).Count -ne 0) { throw 'expected empty ciChecksByPr' }
Write-Output 'ok'
`;
      expectPwshOk(script);
    }
  });

  it('Get-ReconcileChecksByPr tolerates null OpenPrs', () => {
    const reconcileChecks = path.join(libDir, 'Get-ReconcileChecksByPr.ps1').replace(/'/g, "''");
    const script = `
$ErrorActionPreference = 'Stop'
. '${reconcileChecks}'
$bundle = Get-ReconcileChecksByPr -RepoRoot ${psString(scriptsDir)} -OpenPrs $null
if (@($bundle.ciChecksByPr.Keys).Count -ne 0) { throw 'expected empty ciChecksByPr' }
Write-Output 'ok'
`;
    expectPwshOk(script);
  });

  it('Get-ReviewReadyReportStateSeedTerminalClaimKeys tolerates null OpenPrs', () => {
    const seedLib = path.join(libDir, 'Invoke-ReviewReadyReportStateSeed.ps1').replace(/'/g, "''");
    const script = `
$ErrorActionPreference = 'Stop'
. '${seedLib}'
$keys = Get-ReviewReadyReportStateSeedTerminalClaimKeys -Namespace 'test' -OpenPrs $null
if (@($keys).Count -ne 0) { throw 'expected empty keys' }
Write-Output 'ok'
`;
    expectPwshOk(script);
  });

  const ghFedChildren: Array<{ id: string; script: string }> = [
    {
      id: 'listener',
      script: `
$ErrorActionPreference = 'Stop'
. '${path.join(libDir, 'Gh-PrChecks.ps1').replace(/'/g, "''")}'
$openPrs = ConvertTo-GhOpenPrArray -OpenPrs $null
if (@($openPrs).Count -ne 0) { throw 'expected empty openPrs' }
Write-Output 'ok'
`,
    },
    {
      id: 'review-trigger-reconcile',
      script: `
$ErrorActionPreference = 'Stop'
. '${path.join(libDir, 'Get-ReconcileChecksByPr.ps1').replace(/'/g, "''")}'
$bundle = Get-ReconcileChecksByPr -RepoRoot ${psString(scriptsDir)} -OpenPrs $null
Write-Output 'ok'
`,
    },
    {
      id: 'review-trigger-reeval',
      script: `
$ErrorActionPreference = 'Stop'
. '${path.join(libDir, 'Gh-PrChecks.ps1').replace(/'/g, "''")}'
$openPrs = ConvertTo-GhOpenPrArray -OpenPrs $null
$bundle = Get-GhChecksBundleByPr -RepoRoot ${psString(scriptsDir)} -OpenPrs $openPrs -MergeRequiredNames { param($p) @() }
Write-Output 'ok'
`,
    },
    {
      id: 'review-ready-report-state-seed',
      script: `
$ErrorActionPreference = 'Stop'
. '${path.join(libDir, 'Invoke-ReviewReadyReportStateSeed.ps1').replace(/'/g, "''")}'
$keys = Get-ReviewReadyReportStateSeedTerminalClaimKeys -Namespace 'test' -OpenPrs $null
Write-Output 'ok'
`,
    },
    {
      id: 'ci-green-wake-reconcile',
      script: `
$ErrorActionPreference = 'Stop'
. '${path.join(libDir, 'Get-ReconcileChecksByPr.ps1').replace(/'/g, "''")}'
$bundle = Get-ReconcileChecksByPr -RepoRoot ${psString(scriptsDir)} -OpenPrs $null
Write-Output 'ok'
`,
    },
    {
      id: 'review-send-reconcile',
      script: `
$ErrorActionPreference = 'Stop'
. '${path.join(libDir, 'Gh-PrChecks.ps1').replace(/'/g, "''")}'
$openPrs = ConvertTo-GhOpenPrArray -OpenPrs $null
Write-Output 'ok'
`,
    },
    {
      id: 'review-finding-delivery-confirm',
      script: `
$ErrorActionPreference = 'Stop'
. '${path.join(libDir, 'Gh-PrChecks.ps1').replace(/'/g, "''")}'
$openPrs = ConvertTo-GhOpenPrArray -OpenPrs $null
Write-Output 'ok'
`,
    },
    {
      id: 'ci-failure-notification-reconcile',
      script: `
$ErrorActionPreference = 'Stop'
. '${path.join(libDir, 'Get-ReconcileChecksByPr.ps1').replace(/'/g, "''")}'
$bundle = Get-ReconcileChecksByPr -RepoRoot ${psString(scriptsDir)} -OpenPrs $null
Write-Output 'ok'
`,
    },
    {
      id: 'ci-failure-notification-reaction',
      script: `
$ErrorActionPreference = 'Stop'
. '${path.join(libDir, 'Gh-PrChecks.ps1').replace(/'/g, "''")}'
$openPrs = ConvertTo-GhOpenPrArray -OpenPrs $null
Write-Output 'ok'
`,
    },
  ];

  for (const child of ghFedChildren) {
    it(`${child.id} inventory entry survives null OpenPrs`, () => {
      expectPwshOk(child.script);
    });

    it(`${child.id} inventory entry survives empty OpenPrs`, () => {
      const emptyScript = child.script.replace(/\$null/g, '@()');
      expectPwshOk(emptyScript);
    });
  }
});
