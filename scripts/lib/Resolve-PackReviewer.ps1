#requires -Version 5.1
<#
.SYNOPSIS
  PowerShell compatibility shim for PACK_REVIEWER selector (Issue #86 / #1031).
  Selector authority lives in scripts/lib/resolve-pack-reviewer.ts.
#>
$Script:PackReviewScriptsRoot = Split-Path -Parent $PSScriptRoot
$Script:PackReviewRepoRoot = Split-Path -Parent $Script:PackReviewScriptsRoot

$Script:PackReviewerWrapperById = @{
    codex  = 'run-pack-review.ps1'
    claude = 'run-pack-review-claude.ps1'
    gpt    = 'run-pack-review-gpt.ts'
}

function Invoke-PackReviewerResolutionExport {
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
    $stdout = & $argv[0] $argv[1..($argv.Length - 1)]
    $json = (($stdout | Out-String).Trim())
    if ([string]::IsNullOrWhiteSpace($json)) {
        throw 'PACK_REVIEWER resolution export returned empty stdout.'
    }
    return $json | ConvertFrom-Json
}

function Get-PackReviewerSelectorValue {
    return (Invoke-PackReviewerResolutionExport).selectorValue
}

function Get-PackReviewerFromSelector {
    param(
        [string]$SelectorValue,
        [switch]$UnusedCompatibilitySwitch
    )

    return (Invoke-PackReviewerResolutionExport).reviewer
}

function Get-PackReviewerSelectorErrorMessage {
    param(
        [string]$SelectorValue
    )

    $resolution = Invoke-PackReviewerResolutionExport
    if ($resolution.errorMessage) {
        return $resolution.errorMessage
    }
    return 'No reviewer authority is configured. Set a persistent reviewer or PACK_REVIEWER to gpt, claude, or codex.'
}

function Get-PackReviewWrapperBasenameForReviewer {
    param(
        [Parameter(Mandatory)]
        [string]$Reviewer
    )

    return $Script:PackReviewerWrapperById[$Reviewer]
}

function Get-PackReviewWrapperPathForReviewer {
    param(
        [Parameter(Mandatory)]
        [string]$Reviewer,
        [string]$ScriptsRoot = $Script:PackReviewScriptsRoot
    )

    $basename = Get-PackReviewWrapperBasenameForReviewer -Reviewer $Reviewer
    return (Join-Path $ScriptsRoot $basename)
}
