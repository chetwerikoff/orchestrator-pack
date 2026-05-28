# Canonical AO review entrypoint: dependency preflight then pack Codex wrapper.
# Referenced by REVIEW_COMMAND in agent-orchestrator.yaml.example (Issue #60).
#Requires -Version 5.1
param(
    [string]$RepoRoot = '.',
    [string]$Base = 'origin/main'
)

$ErrorActionPreference = 'Stop'

$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
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

    & $reviewScript --repo-root $resolvedRoot --base $Base @args
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
