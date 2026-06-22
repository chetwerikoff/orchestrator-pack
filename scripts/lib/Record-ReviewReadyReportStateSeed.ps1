#requires -Version 5.1
<#
.SYNOPSIS
  Persist report-state poll binding and seed dedupe state (Issue #391).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')

$Script:ReviewReadyReportStateSeedCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-ready-report-state-seed.mjs'

function Get-ReviewReadyReportStateSeedStatePath {
    param([string]$StateRoot = '')

    if ($StateRoot) {
        return Join-Path $StateRoot 'review-ready-report-state-seed-state.json'
    }
    if ($env:AO_REPORT_STATE_SEED_STATE) {
        return $env:AO_REPORT_STATE_SEED_STATE
    }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-review-ready-report-state-seed-state.json'
}

function Invoke-ReviewReadyReportStateSeedCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewReadyReportStateSeedCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'review-ready-report-state-seed' -JsonDepth 30
}

$Script:ReviewReadyReportStateSeedDefaultState = @{
    bindingByKey     = @{}
    seededKeys       = @()
    deferredScanKeys = @()
    githubSnapshot   = $null
    lastUpdatedMs    = $null
}

function Get-ReviewReadyReportStateSeedState {
    param([string]$Path)

    return Get-MechanicalJsonStateFile -Path $Path -DefaultState $Script:ReviewReadyReportStateSeedDefaultState -ActionTracking
}

function Set-ReviewReadyReportStateSeedState {
    param(
        [string]$Path,
        [object]$State
    )

    Set-MechanicalJsonStateFile -Path $Path -State $State -DefaultState $Script:ReviewReadyReportStateSeedDefaultState -JsonDepth 30
}

function Get-ReviewReadyReportStateSeedLockPath {
    param([string]$StatePath)

    $dir = Split-Path -Parent $StatePath
    if (-not $dir) {
        return Join-Path ([System.IO.Path]::GetTempPath()) 'review-ready-report-state-seed.lock'
    }
    return Join-Path $dir 'review-ready-report-state-seed.lock'
}

function Update-ReviewReadyReportStateSeedStateLocked {
    param(
        [string]$Path,
        [scriptblock]$Mutator,
        [long]$NowMs
    )

    $lockPath = Get-ReviewReadyReportStateSeedLockPath -StatePath $Path
    Invoke-OrchestratorSideEffectFenced -LockPath $lockPath -Metadata @{
        purpose = 'review-ready-report-state-seed-state'
    } -Action {
        $current = Get-ReviewReadyReportStateSeedState -Path $Path
        Assert-MechanicalJsonStateFencesTrusted -State $current -Context 'report-state seed state'
        $next = & $Mutator $current
        Set-ReviewReadyReportStateSeedState -Path $Path -State @{
            bindingByKey     = $next.bindingByKey
            seededKeys       = @($next.seededKeys)
            deferredScanKeys = @($next.deferredScanKeys)
            githubSnapshot   = $next.githubSnapshot
            lastUpdatedMs    = $NowMs
        }
        return $next
    } | Out-Null
}
