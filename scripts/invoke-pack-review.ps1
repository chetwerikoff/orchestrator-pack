# Reviewer-agnostic AO review entrypoint (Issue #86).
# REVIEW_COMMAND names this script only; PACK_REVIEWER selects claude | codex.
#Requires -Version 5.1
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Resolve-PackReviewer.ps1')
. (Join-Path $PSScriptRoot 'lib/Parse-PackReviewCliArgs.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-AutoReviewPrContext.ps1')

$reviewer = Get-PackReviewerFromSelector
if (-not $reviewer) {
    $message = Get-PackReviewerSelectorErrorMessage
    Write-Error $message -ErrorAction Continue
    exit 1
}

$wrapperPath = Get-PackReviewWrapperPathForReviewer -Reviewer $reviewer -ScriptsRoot $PSScriptRoot
if (-not (Test-Path -LiteralPath $wrapperPath -PathType Leaf)) {
    [Console]::Error.WriteLine("Pack review wrapper not found at $wrapperPath (PACK_REVIEWER=$reviewer)")
    exit 1
}

$cli = Split-PackReviewCliArgs -Argv $args
$resolvedRoot = (Resolve-Path -LiteralPath $cli.RepoRoot).Path
$forwardArgs = [System.Collections.Generic.List[string]]::new()
foreach ($arg in $cli.ForwardArgs) {
    $forwardArgs.Add($arg) | Out-Null
}

Add-PackReviewAutoForwardArgs -ForwardArgs $forwardArgs -RepoRoot $resolvedRoot | Out-Null

$wrapperArgs = @('--repo-root', $resolvedRoot, '--base', $cli.Base) + $forwardArgs.ToArray()
& $wrapperPath @wrapperArgs
exit $LASTEXITCODE
