#requires -Version 5.1
<#
  Canonical reconcile checks-bundle resolver shared by report-driven reconcilers
  and the autonomous claimed review-start path (Issue #335).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Gh-PrChecks.ps1')

function Get-ReconcileChecksByPr {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $false)]
        [AllowEmptyCollection()]
        [AllowNull()]
        [array]$OpenPrs,
        [string]$PackRoot = ''
    )

    if (-not $PackRoot) {
        $PackRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }
    $ciGreenWakeFilterCli = Join-Path $PackRoot 'docs/ci-green-wake-reconcile.mjs'

    return Get-GhChecksBundleByPr -RepoRoot $RepoRoot -OpenPrs (ConvertTo-GhOpenPrArray -OpenPrs $OpenPrs) `
        -MergeRequiredNames {
            param($payload)
            Invoke-MechanicalNodeFilterCli -FilterCliPath $ciGreenWakeFilterCli -Subcommand 'merge-required-names' `
                -Payload $payload -Label 'ci-green-wake-reconcile' -JsonDepth 20
        } `
        -ProtectionLookupWarningTemplate 'warn: branch protection lookup failed PR #{0} (exit {1}); treating required CI as degraded'
}
