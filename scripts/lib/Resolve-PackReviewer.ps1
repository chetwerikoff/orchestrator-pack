#requires -Version 5.1
<#
.SYNOPSIS
  PowerShell compatibility shim for PACK_REVIEWER selector (Issue #86 / #1031).
  Selector authority lives in scripts/lib/resolve-pack-reviewer.ts.
#>
$Script:PackReviewerEnvVar = 'PACK_REVIEWER'
$Script:PackReviewBoundReviewerEnvVar = 'PACK_REVIEW_BOUND_REVIEWER'
$Script:PackReviewScriptsRoot = Split-Path -Parent $PSScriptRoot
$Script:PackReviewRepoRoot = Split-Path -Parent $Script:PackReviewScriptsRoot

$Script:PackReviewerWrapperById = @{
    codex  = 'run-pack-review.ps1'
    claude = 'run-pack-review-claude.ps1'
    gpt    = 'run-pack-review-gpt.ts'
}

function Get-PackReviewerLayerValue {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('Process', 'User', 'Machine')]
        [string]$Target,
        [hashtable]$OverrideLayers
    )

    if ($OverrideLayers -and $OverrideLayers.ContainsKey($Target)) {
        return $OverrideLayers[$Target]
    }

    return [Environment]::GetEnvironmentVariable($Script:PackReviewerEnvVar, $Target)
}

function Test-PackReviewerPersistentLayersAvailable {
    param([switch]$HarnessEmulatePersistentLayers)
    if ($HarnessEmulatePersistentLayers) { return $true }
    return ($PSVersionTable.Platform -eq 'Win32NT')
}

function Clear-StalePackReviewerProcessScope {
    param(
        [hashtable]$OverrideLayers,
        [switch]$HarnessEmulatePersistentLayers
    )

    if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Script:PackReviewBoundReviewerEnvVar, 'Process'))) {
        return
    }

    if (-not (Test-PackReviewerPersistentLayersAvailable -HarnessEmulatePersistentLayers:$HarnessEmulatePersistentLayers)) {
        return
    }

    $userValue = Get-PackReviewerLayerValue -Target 'User' -OverrideLayers $OverrideLayers
    if ([string]::IsNullOrWhiteSpace($userValue)) {
        return
    }

    Remove-Item Env:$Script:PackReviewerEnvVar -ErrorAction SilentlyContinue
}

function Invoke-PackReviewerResolutionExport {
    param(
        [hashtable]$OverrideLayers,
        [switch]$HarnessEmulatePersistentLayers,
        [switch]$SkipStaleClear
    )

    if (-not $SkipStaleClear -and -not $OverrideLayers) {
        Clear-StalePackReviewerProcessScope -HarnessEmulatePersistentLayers:$HarnessEmulatePersistentLayers
    }

    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) {
        throw 'OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required for PACK_REVIEWER resolution.'
    }

    $launcher = Join-Path $Script:PackReviewRepoRoot 'scripts/lib/Invoke-TypeScriptCli.ts'
    $exportScript = Join-Path $Script:PackReviewRepoRoot 'scripts/export-pack-reviewer-resolution.ts'
    $argv = @(
        $node.Path,
        '--experimental-strip-types',
        $launcher,
        '--script', $exportScript,
        '--'
    )
    if ($OverrideLayers) {
        $argv += '--override-layers-json'
        $argv += ($OverrideLayers | ConvertTo-Json -Compress)
    }
    if ($HarnessEmulatePersistentLayers) {
        $argv += '--harness-emulate-persistent-layers'
    }

    $stdout = & $argv[0] $argv[1..($argv.Length - 1)]
    $json = (($stdout | Out-String).Trim())
    if ([string]::IsNullOrWhiteSpace($json)) {
        throw 'PACK_REVIEWER resolution export returned empty stdout.'
    }
    return $json | ConvertFrom-Json
}

function Get-PackReviewerSelectorValue {
    param(
        [hashtable]$OverrideLayers,
        [switch]$HarnessEmulatePersistentLayers
    )

    return (Invoke-PackReviewerResolutionExport -OverrideLayers $OverrideLayers -HarnessEmulatePersistentLayers:$HarnessEmulatePersistentLayers).selectorValue
}

function Get-PackReviewerFromSelector {
    param(
        [hashtable]$OverrideLayers,
        [string]$SelectorValue,
        [switch]$HarnessEmulatePersistentLayers
    )

    if (-not [string]::IsNullOrWhiteSpace($SelectorValue)) {
        $normalized = $SelectorValue.Trim().ToLowerInvariant()
        if ($Script:PackReviewerWrapperById.ContainsKey($normalized)) {
            return $normalized
        }
        return $null
    }

    return (Invoke-PackReviewerResolutionExport -OverrideLayers $OverrideLayers -HarnessEmulatePersistentLayers:$HarnessEmulatePersistentLayers).reviewer
}

function Get-PackReviewerSelectorErrorMessage {
    param(
        [hashtable]$OverrideLayers,
        [string]$SelectorValue,
        [switch]$HarnessEmulatePersistentLayers
    )

    if (-not [string]::IsNullOrWhiteSpace($SelectorValue)) {
        $reviewer = Get-PackReviewerFromSelector -SelectorValue $SelectorValue
        if ($reviewer) { return $null }
        return ("PACK_REVIEWER has unrecognized value '{0}'. Set PACK_REVIEWER to gpt, claude, or codex." -f $SelectorValue.Trim())
    }

    $resolution = Invoke-PackReviewerResolutionExport -OverrideLayers $OverrideLayers -HarnessEmulatePersistentLayers:$HarnessEmulatePersistentLayers
    if ($resolution.errorMessage) {
        return $resolution.errorMessage
    }
    return 'PACK_REVIEWER is not set. Set PACK_REVIEWER to gpt, claude, or codex before running pack review (see docs/reviewer-switch-runbook.md).'
}

function Get-PackReviewWrapperBasenameForReviewer {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('claude', 'codex', 'gpt')]
        [string]$Reviewer
    )

    return $Script:PackReviewerWrapperById[$Reviewer]
}

function Get-PackReviewWrapperPathForReviewer {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('claude', 'codex', 'gpt')]
        [string]$Reviewer,
        [string]$ScriptsRoot = $Script:PackReviewScriptsRoot
    )

    $basename = Get-PackReviewWrapperBasenameForReviewer -Reviewer $Reviewer
    return (Join-Path $ScriptsRoot $basename)
}
