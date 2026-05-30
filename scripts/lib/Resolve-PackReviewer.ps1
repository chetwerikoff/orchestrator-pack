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

function Get-PackReviewerFromSelector {
    param(
        [string]$SelectorValue = $env:PACK_REVIEWER
    )

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
  param([string]$SelectorValue = $env:PACK_REVIEWER)

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
