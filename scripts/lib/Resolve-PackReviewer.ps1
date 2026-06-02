#requires -Version 5.1
<#
.SYNOPSIS
  Canonical PACK_REVIEWER selector: claude | codex (single source of truth).
#>
$Script:PackReviewerEnvVar = 'PACK_REVIEWER'
$Script:PackReviewScriptsRoot = Split-Path -Parent $PSScriptRoot

$Script:PackReviewerWrapperById = @{
    codex  = 'run-pack-review.ps1'
    claude = 'run-pack-review-claude.ps1'
}

function Test-IsWindowsHost {
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        return $IsWindows
    }

    return ($env:OS -match 'Windows')
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

function Clear-StalePackReviewerProcessScope {
    <#
    .SYNOPSIS
      Drop process-scoped PACK_REVIEWER when User is configured so global operator choice wins.
      IDE/agent parents often inject process values; AO review dispatch should follow User/Machine.
    #>
    $userValue = Get-PackReviewerLayerValue -Target 'User' -OverrideLayers $null
    if ([string]::IsNullOrWhiteSpace($userValue)) {
        return
    }

    Remove-Item Env:$Script:PackReviewerEnvVar -ErrorAction SilentlyContinue
}

function Get-PackReviewerSelectorValue {
    <#
    .SYNOPSIS
      Resolves PACK_REVIEWER from process scope, then Windows User/Machine persistent layers.
      Precedence: Process > User > Machine (User overrides Machine when process is unset).
    .PARAMETER OverrideLayers
      Optional test hook: keys Process, User, Machine override registry reads for that layer.
    #>
    param(
        [hashtable]$OverrideLayers
    )

    foreach ($target in @('Process', 'User', 'Machine')) {
        if ($target -ne 'Process' -and -not (Test-IsWindowsHost)) {
            continue
        }

        $value = Get-PackReviewerLayerValue -Target $target -OverrideLayers $OverrideLayers
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value
        }
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
        return 'PACK_REVIEWER is not set. Set PACK_REVIEWER to claude or codex before running pack review (see docs/reviewer-switch-runbook.md).'
    }

    return ("PACK_REVIEWER has unrecognized value '{0}'. Set PACK_REVIEWER to claude or codex." -f $SelectorValue.Trim())
}

function Get-PackReviewWrapperBasenameForReviewer {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('claude', 'codex')]
        [string]$Reviewer
    )

    return $Script:PackReviewerWrapperById[$Reviewer]
}

function Get-PackReviewWrapperPathForReviewer {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('claude', 'codex')]
        [string]$Reviewer,
        [string]$ScriptsRoot = $Script:PackReviewScriptsRoot
    )

    $basename = Get-PackReviewWrapperBasenameForReviewer -Reviewer $Reviewer
    return (Join-Path $ScriptsRoot $basename)
}
