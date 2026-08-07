# Reviewer-neutral pack review entrypoint (Issue #86).
# PACK_REVIEWER selects gpt | claude | codex.
#Requires -Version 5.1
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Resolve-PackReviewer.ps1')
. (Join-Path $PSScriptRoot 'lib/Parse-PackReviewCliArgs.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-AutoReviewPrContext.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-FailureEvidence.ps1')

$resolution = Invoke-PackReviewerResolutionExport
$reviewer = $resolution.reviewer
if (-not $reviewer) {
    $message = if ($resolution.errorMessage) {
        $resolution.errorMessage
    }
    else {
        'No reviewer authority is configured. Set a persistent reviewer or PACK_REVIEWER to gpt, claude, or codex.'
    }
    Write-Error $message -ErrorAction Continue
    exit 1
}

$wrapperPath = Get-PackReviewWrapperPathForReviewer -Reviewer $reviewer -ScriptsRoot $PSScriptRoot
if (-not (Test-Path -LiteralPath $wrapperPath -PathType Leaf)) {
    [Console]::Error.WriteLine("Pack review wrapper not found at $wrapperPath (PACK_REVIEWER=$reviewer)")
    exit 1
}

$packRoot = Split-Path -Parent $PSScriptRoot
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$typeScriptLauncher = Join-Path $packRoot 'scripts/lib/Invoke-TypeScriptCli.ts'
$wrapperIsTypeScript = $wrapperPath -like '*.ts'
if ($wrapperIsTypeScript -and -not $node) {
    [Console]::Error.WriteLine('OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required to run TypeScript pack review wrappers.')
    exit 1
}

$cli = Split-PackReviewCliArgs -Argv $args
$resolvedRoot = (Resolve-Path -LiteralPath $cli.RepoRoot).Path

$evidenceHandle = Initialize-ReviewFailureEvidence -RepoRoot $resolvedRoot -WrapperKind $reviewer
if (-not $evidenceHandle.ok -and $env:OPK_REVIEW_FAILURE_EVIDENCE_DEBUG) {
    [Console]::Error.WriteLine("review failure evidence not initialized: $($evidenceHandle.reason)")
}

if ($evidenceHandle.ok) {
    Update-ReviewFailureEvidencePhase -Handle $evidenceHandle -Phase 'selector_resolved' | Out-Null
    Update-ReviewFailureEvidencePhase -Handle $evidenceHandle -Phase 'wrapper_resolved' | Out-Null
}

$forwardArgs = [System.Collections.Generic.List[string]]::new()
foreach ($arg in $cli.ForwardArgs) {
    $forwardArgs.Add($arg) | Out-Null
}

Add-PackReviewAutoForwardArgs -ForwardArgs $forwardArgs -RepoRoot $resolvedRoot | Out-Null

# Carry-over transport is an environment contract consumed by review_core.
# Do not reinterpret the bundle path as the reviewer source selector.

# Codex-only auto-forward flags must not reach the browser GPT adapter.
if ($reviewer -eq 'gpt') {
    for ($index = $forwardArgs.Count - 1; $index -ge 0; $index--) {
        if ($forwardArgs[$index] -eq '--source') {
            if (($index + 1) -lt $forwardArgs.Count) {
                $forwardArgs.RemoveAt($index + 1)
            }
            $forwardArgs.RemoveAt($index)
        }
    }
}

if ($evidenceHandle.ok) {
    Update-ReviewFailureEvidencePhase -Handle $evidenceHandle -Phase 'arguments_prepared' | Out-Null
}

$wrapperArgs = @('--repo-root', $resolvedRoot, '--base', $cli.Base) + $forwardArgs.ToArray()

function Invoke-PackReviewTypeScriptWrapper {
    param(
        [string]$NodePath,
        [string]$LauncherPath,
        [string]$ScriptPath,
        [string[]]$ScriptArgs
    )

    $argv = @('--experimental-strip-types', $LauncherPath, '--script', $ScriptPath, '--') + $ScriptArgs
    & $NodePath @argv
    return $LASTEXITCODE
}

try {
    if ($wrapperIsTypeScript) {
        if ($evidenceHandle.ok) {
            Update-ReviewFailureEvidencePhase -Handle $evidenceHandle -Phase 'wrapper_started' | Out-Null
        }
        $exitCode = Invoke-PackReviewTypeScriptWrapper -NodePath $node.Source -LauncherPath $typeScriptLauncher -ScriptPath $wrapperPath -ScriptArgs $wrapperArgs
        if ($evidenceHandle.ok) {
            if ($exitCode -eq 0) {
                Update-ReviewFailureEvidencePhase -Handle $evidenceHandle -Phase 'normal_completion' | Out-Null
            }
            Update-ReviewFailureEvidencePhase -Handle $evidenceHandle -Phase 'wrapper_exited' | Out-Null
        }
        exit $exitCode
    }

    if ($evidenceHandle.ok) {
        $wrapperResult = Invoke-PackReviewWrapperWithFailureEvidence -WrapperPath $wrapperPath -WrapperArgs $wrapperArgs -EvidenceHandle $evidenceHandle
        if ($wrapperResult.exitCode -eq 0 -and $evidenceHandle.ok) {
            Update-ReviewFailureEvidencePhase -Handle $evidenceHandle -Phase 'normal_completion' | Out-Null
        }
        exit $wrapperResult.exitCode
    }

    $wrapperResult = Invoke-PackReviewWrapperWithFailureEvidence -WrapperPath $wrapperPath -WrapperArgs $wrapperArgs -EvidenceHandle $null
    exit $wrapperResult.exitCode
}
catch {
    if ($evidenceHandle.ok) {
        Update-ReviewFailureEvidencePhase -Handle $evidenceHandle -Phase 'entrypoint_failed_before_wrapper_start' | Out-Null
    }
    throw
}
