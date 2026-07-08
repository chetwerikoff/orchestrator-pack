#requires -Version 5.1
<#
.SYNOPSIS
  Trusted-pack AO 0.10 harness bridge for Codex [Pn] findings (Issue #658).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RunId,
    [string]$RepoRoot = (Get-Location).Path,
    [string]$Base = 'origin/main',
    [int]$Issue = 0,
    [int]$PrNumber = 0,
    [string]$PrBodyFile = '',
    [string]$Model = '',
    [ValidateSet('', 'codex-local', 'codex-github-action')][string]$Source = '',
    [string]$TrustedBaseRoot = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Resolve-TrustedPackRoot.ps1')

$trusted = Resolve-TrustedPackRoot -ReviewTargetRoot $RepoRoot -TrustedBaseRoot $TrustedBaseRoot `
    -BootstrapCheckerRelativePath 'scripts/harness-review-bridge.ts'
$bridge = Join-Path $trusted.Path 'scripts/harness-review-bridge.ts'
$mapper = Join-Path $trusted.Path 'plugins/ao-codex-pr-reviewer/lib/review_jsonl.ts'
$prompt = Join-Path $trusted.Path 'prompts/codex_review_prompt.md'
foreach ($required in @($bridge, $mapper, $prompt)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "missing trusted harness asset: $required"
    }
}

$args = @($bridge, '--run-id', $RunId, '--repo-root', $RepoRoot, '--base', $Base)
if ($Issue -gt 0) { $args += @('--issue', [string]$Issue) }
if ($PrNumber -gt 0) { $args += @('--pr-number', [string]$PrNumber) }
if ($PrBodyFile) { $args += @('--pr-body-file', $PrBodyFile) }
if ($Model) { $args += @('--model', $Model) }
if ($Source) { $args += @('--source', $Source) }

Push-Location $trusted.Path
try {
    & node --import tsx @args
    exit $LASTEXITCODE
}
finally {
    Pop-Location
    if ($trusted.DisposableTrustedRoot) {
        Remove-Item -LiteralPath $trusted.Path -Recurse -Force -ErrorAction SilentlyContinue
    }
}
