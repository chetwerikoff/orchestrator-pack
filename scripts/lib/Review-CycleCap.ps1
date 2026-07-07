#requires -Version 5.1
<#
  Pack-owned per-tier PR review-cycle cap state (Issue #646).
  Consumes pre-fetched review run rows from Get-AoReviewRuns (#611 read model).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

$Script:ReviewCycleCapFilterCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-cycle-cap.mjs'

function Get-ReviewCycleCapStateRoot {
    if ($env:ORCHESTRATOR_PACK_REVIEW_CYCLE_CAP_STATE) {
        return $env:ORCHESTRATOR_PACK_REVIEW_CYCLE_CAP_STATE
    }
    return Join-Path $HOME '.local/state/orchestrator-pack-review-cycle-cap'
}

function Get-ReviewCycleCapStatePath {
    param([string]$ProjectId = 'orchestrator-pack')

    $project = [string]$ProjectId
    if (-not $project) { $project = 'orchestrator-pack' }
    return Join-Path (Get-ReviewCycleCapStateRoot) "$project.json"
}

function Get-ReviewCycleCapState {
    param([string]$Path = '')

    $resolved = if ($Path) { $Path } else { Get-ReviewCycleCapStatePath }
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        return @{}
    }
    return Get-Content -LiteralPath $resolved -Raw | ConvertFrom-Json -AsHashtable
}

function Set-ReviewCycleCapState {
    param(
        [string]$Path = '',
        [object]$State
    )

    $resolved = if ($Path) { $Path } else { Get-ReviewCycleCapStatePath }
    $normalized = if ($State -is [System.Collections.IDictionary]) {
        Copy-MechanicalJsonMap -Map $State
    }
    else {
        Copy-MechanicalJsonMap -Map ($State | ConvertTo-Json -Depth 30 -Compress | ConvertFrom-Json)
    }
    $dir = Split-Path -Parent $resolved
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    ($normalized | ConvertTo-Json -Depth 30 -Compress) | Set-Content -LiteralPath $resolved -Encoding utf8NoBOM
}

function Invoke-ReviewCycleCapFilterCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewCycleCapFilterCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'review-cycle-cap' -JsonDepth 30
}

function Evaluate-ReviewCycleCapGate {
    param([hashtable]$Payload)

    return Invoke-ReviewCycleCapFilterCli -Subcommand 'evaluateGate' -Payload $Payload
}
