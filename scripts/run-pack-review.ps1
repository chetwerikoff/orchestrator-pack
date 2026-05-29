# Canonical AO review entrypoint: dependency preflight then pack Codex wrapper.
# Referenced by REVIEW_COMMAND in agent-orchestrator.yaml.example (Issue #60).
# Accepts the same CLI-style flags as review.ps1 (--repo-root, --base).
#Requires -Version 5.1
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Parse-PackReviewCliArgs.ps1')
. (Join-Path $PSScriptRoot 'lib/Get-AutoReviewPrContext.ps1')

$cli = Split-PackReviewCliArgs -Argv $args
$resolvedRoot = (Resolve-Path -LiteralPath $cli.RepoRoot).Path

$forwardArgs = [System.Collections.Generic.List[string]]::new()
foreach ($arg in $cli.ForwardArgs) {
    $forwardArgs.Add($arg) | Out-Null
}

Add-PackReviewAutoForwardArgs -ForwardArgs $forwardArgs -RepoRoot $resolvedRoot | Out-Null

Push-Location -LiteralPath $resolvedRoot
try {
    npm ci --include=dev
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    $reviewScript = Join-Path $PSScriptRoot '..\plugins\ao-codex-pr-reviewer\bin\review.ps1'
    if (-not (Test-Path -LiteralPath $reviewScript -PathType Leaf)) {
        Write-Error "Pack review wrapper not found at $reviewScript"
    }

    $forward = $forwardArgs.ToArray()
    if ($forward.Count -gt 0) {
        & $reviewScript --repo-root $resolvedRoot --base $cli.Base @forward
    }
    else {
        & $reviewScript --repo-root $resolvedRoot --base $cli.Base
    }
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
