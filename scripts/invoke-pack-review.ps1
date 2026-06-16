# Reviewer-agnostic AO review entrypoint (Issue #86).
# REVIEW_COMMAND names this script only; PACK_REVIEWER selects claude | codex.
#Requires -Version 5.1
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Resolve-PackReviewer.ps1')
. (Join-Path $PSScriptRoot 'lib/Parse-PackReviewCliArgs.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-AutoReviewPrContext.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-RunLiveness.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-FailureEvidence.ps1')

Clear-StalePackReviewerProcessScope
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

$evidenceHandle = Initialize-ReviewFailureEvidence -RepoRoot $resolvedRoot -WrapperKind $reviewer
if (-not $evidenceHandle.ok -and $env:AO_REVIEW_FAILURE_EVIDENCE_DEBUG) {
    [Console]::Error.WriteLine("review failure evidence not initialized: $($evidenceHandle.reason)")
}

if ($evidenceHandle.ok) {
    Update-ReviewFailureEvidencePhase -Handle $evidenceHandle -Phase 'selector_resolved' | Out-Null
    Update-ReviewFailureEvidencePhase -Handle $evidenceHandle -Phase 'wrapper_resolved' | Out-Null
}

$liveness = Register-ReviewRunLivenessIdentity -RepoRoot $resolvedRoot
if (-not $liveness.ok -and $env:AO_REVIEW_LIVENESS_DEBUG) {
    [Console]::Error.WriteLine("review liveness identity not captured: $($liveness.reason)")
}

$forwardArgs = [System.Collections.Generic.List[string]]::new()
foreach ($arg in $cli.ForwardArgs) {
    $forwardArgs.Add($arg) | Out-Null
}

Add-PackReviewAutoForwardArgs -ForwardArgs $forwardArgs -RepoRoot $resolvedRoot | Out-Null

if ($evidenceHandle.ok) {
    Update-ReviewFailureEvidencePhase -Handle $evidenceHandle -Phase 'arguments_prepared' | Out-Null
}

$wrapperArgs = @('--repo-root', $resolvedRoot, '--base', $cli.Base) + $forwardArgs.ToArray()

try {
    if ($evidenceHandle.ok) {
        $exitCode = Invoke-PackReviewWrapperWithFailureEvidence -WrapperPath $wrapperPath -WrapperArgs $wrapperArgs -EvidenceHandle $evidenceHandle
        if ($exitCode -eq 0 -and $evidenceHandle.ok) {
            Update-ReviewFailureEvidencePhase -Handle $evidenceHandle -Phase 'normal_completion' | Out-Null
        }
        exit $exitCode
    }
    & $wrapperPath @wrapperArgs
    exit $LASTEXITCODE
}
catch {
    if ($evidenceHandle.ok) {
        Update-ReviewFailureEvidencePhase -Handle $evidenceHandle -Phase 'entrypoint_failed_before_wrapper_start' | Out-Null
    }
    throw
}
