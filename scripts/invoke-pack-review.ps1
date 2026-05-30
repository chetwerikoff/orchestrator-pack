# Reviewer-agnostic AO review entrypoint (Issue #86).
# REVIEW_COMMAND names this script only; PACK_REVIEWER selects claude | codex.
#Requires -Version 5.1
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Resolve-PackReviewer.ps1')

$reviewer = Get-PackReviewerFromSelector
if (-not $reviewer) {
    $message = Get-PackReviewerSelectorErrorMessage
    [Console]::Error.WriteLine($message)
    exit 1
}

$wrapperPath = Get-PackReviewWrapperPathForReviewer -Reviewer $reviewer -ScriptsRoot $PSScriptRoot
if (-not (Test-Path -LiteralPath $wrapperPath -PathType Leaf)) {
    [Console]::Error.WriteLine("Pack review wrapper not found at $wrapperPath (PACK_REVIEWER=$reviewer)")
    exit 1
}

& $wrapperPath @args
exit $LASTEXITCODE
