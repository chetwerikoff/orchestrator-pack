#requires -Version 7.0
<#
.SYNOPSIS
  Regenerate docs/orchestrator-message-map.md from the message catalog (Issue #298).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if (-not $OutputPath) {
    $OutputPath = Join-Path $RepoRoot 'docs/orchestrator-message-map.md'
}

$registryCli = Join-Path $RepoRoot 'docs/orchestrator-message-registry.mjs'
if ($IsWindows -and -not $env:WSL_DISTRO_NAME) {
    throw 'unsupported host: native Windows execution is refused (use Linux/WSL + pwsh 7+)'
}

$generated = & node $registryCli generate-map $RepoRoot
if ($LASTEXITCODE -ne 0) {
    throw "map generation failed with exit $LASTEXITCODE"
}
Set-Content -LiteralPath $OutputPath -Value $generated -Encoding utf8NoBOM -NoNewline
Write-Host "Wrote $OutputPath"
