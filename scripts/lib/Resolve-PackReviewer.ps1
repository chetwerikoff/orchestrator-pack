#requires -Version 5.1
<#
.SYNOPSIS
  Canonical PACK_REVIEWER selector: gpt | claude | codex (single source of truth).
#>
$Script:PackReviewerEnvVar = 'PACK_REVIEWER'
$Script:PackReviewScriptsRoot = Split-Path -Parent $PSScriptRoot

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
    <#
    .SYNOPSIS
      Windows registry-backed User/Machine layers (decision section N). Non-Win32NT hosts
      stay process-only for review spawn; do not use $IsWindows.
    #>
    param(
        [switch]$HarnessEmulatePersistentLayers
    )

    if ($HarnessEmulatePersistentLayers) {
        return $true
    }

    return ($PSVersionTable.Platform -eq 'Win32NT')
}

function Clear-StalePackReviewerProcessScope {
    <#
    .SYNOPSIS
      Drop process-scoped PACK_REVIEWER when User is configured so global operator choice wins.
      IDE/agent parents often inject process values; AO review dispatch should follow User/Machine.
    #>
    param(
        [hashtable]$OverrideLayers,
        [switch]$HarnessEmulatePersistentLayers
    )

    if (-not (Test-PackReviewerPersistentLayersAvailable -HarnessEmulatePersistentLayers:$HarnessEmulatePersistentLayers)) {
        return
    }

    $userValue = Get-PackReviewerLayerValue -Target 'User' -OverrideLayers $OverrideLayers
    if ([string]::IsNullOrWhiteSpace($userValue)) {
        return
    }

    Remove-Item Env:$Script:PackReviewerEnvVar -ErrorAction SilentlyContinue
}

function Get-PackReviewerSelectorValue {
    <#
    .SYNOPSIS
      Resolves PACK_REVIEWER from process scope, then User/Machine persistent layers.
      Precedence: Process > User > Machine when process is effective; when User is configured
      on a persistent-layer host, stale process scope is ignored (Clear-StalePackReviewerProcessScope
      removes live process env before this runs in production).
    .PARAMETER OverrideLayers
      Optional test hook: keys Process, User, Machine override registry reads for that layer.
  .PARAMETER HarnessEmulatePersistentLayers
      Harness-only: consult User/Machine layers on non-Win32NT hosts.
    #>
    param(
        [hashtable]$OverrideLayers,
        [switch]$HarnessEmulatePersistentLayers
    )

    $persistentAvailable = Test-PackReviewerPersistentLayersAvailable -HarnessEmulatePersistentLayers:$HarnessEmulatePersistentLayers
    $userValue = if ($persistentAvailable) {
        Get-PackReviewerLayerValue -Target 'User' -OverrideLayers $OverrideLayers
    }
    else {
        $null
    }
    $machineValue = if ($persistentAvailable) {
        Get-PackReviewerLayerValue -Target 'Machine' -OverrideLayers $OverrideLayers
    }
    else {
        $null
    }
    $processValue = Get-PackReviewerLayerValue -Target 'Process' -OverrideLayers $OverrideLayers
    $effectiveProcess = if ($persistentAvailable -and -not [string]::IsNullOrWhiteSpace($userValue)) {
        $null
    }
    else {
        $processValue
    }

    if (-not [string]::IsNullOrWhiteSpace($effectiveProcess)) {
        return $effectiveProcess
    }
    if (-not [string]::IsNullOrWhiteSpace($userValue)) {
        return $userValue
    }
    if (-not [string]::IsNullOrWhiteSpace($machineValue)) {
        return $machineValue
    }

    return $null
}

function Get-PackReviewerFromSelector {
    param(
        [hashtable]$OverrideLayers,
        [string]$SelectorValue
    )

    if ([string]::IsNullOrWhiteSpace($SelectorValue)) {
        $SelectorValue = Get-PackReviewerSelectorValue -OverrideLayers $OverrideLayers
    }

    if ([string]::IsNullOrWhiteSpace($SelectorValue)) {
        return $null
    }

    $normalized = $SelectorValue.Trim().ToLowerInvariant()
    if ($Script:PackReviewerWrapperById.ContainsKey($normalized)) {
        return $normalized
    }

    return $null
}

function Get-PackReviewerSelectorErrorMessage {
    param(
        [hashtable]$OverrideLayers,
        [string]$SelectorValue
    )

    if ([string]::IsNullOrWhiteSpace($SelectorValue)) {
        $SelectorValue = Get-PackReviewerSelectorValue -OverrideLayers $OverrideLayers
    }

    if ([string]::IsNullOrWhiteSpace($SelectorValue)) {
        return 'PACK_REVIEWER is not set. Set PACK_REVIEWER to gpt, claude, or codex before running pack review (see docs/reviewer-switch-runbook.md).'
    }

    return ("PACK_REVIEWER has unrecognized value '{0}'. Set PACK_REVIEWER to gpt, claude, or codex." -f $SelectorValue.Trim())
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

function ConvertFrom-PackReviewerOverrideLayersJson {
    param(
        [string]$OverrideLayersJson
    )

    if ([string]::IsNullOrWhiteSpace($OverrideLayersJson)) {
        return $null
    }

    $parsed = ConvertFrom-Json -InputObject $OverrideLayersJson
    $layers = @{}
    foreach ($target in @('Process', 'User', 'Machine')) {
        if ($null -ne $parsed.PSObject.Properties[$target]) {
            $layers[$target] = $parsed.$target
        }
    }
    return $layers
}

function Export-PackReviewerResolutionJson {
    <#
    .SYNOPSIS
      Machine-readable selector resolution for TypeScript callers (Issue #1031).
      PowerShell remains the single selector authority.
    #>
    param(
        [hashtable]$OverrideLayers,
        [switch]$HarnessEmulatePersistentLayers
    )

    if (-not $OverrideLayers) {
        Clear-StalePackReviewerProcessScope -HarnessEmulatePersistentLayers:$HarnessEmulatePersistentLayers
    }

    $selectorValue = Get-PackReviewerSelectorValue -OverrideLayers $OverrideLayers -HarnessEmulatePersistentLayers:$HarnessEmulatePersistentLayers
    $reviewer = Get-PackReviewerFromSelector -OverrideLayers $OverrideLayers -SelectorValue $selectorValue
    $errorMessage = if ($reviewer) {
        $null
    }
    else {
        Get-PackReviewerSelectorErrorMessage -OverrideLayers $OverrideLayers -SelectorValue $selectorValue
    }

    [PSCustomObject]@{
        schema         = 'pack-reviewer-resolution/v1'
        selectorValue  = $selectorValue
        reviewer       = $reviewer
        errorMessage   = $errorMessage
    } | ConvertTo-Json -Compress
}
