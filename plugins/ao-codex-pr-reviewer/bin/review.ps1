#!/usr/bin/env pwsh
# AO / GitHub Actions entrypoint for the Codex PR reviewer wrapper.
$ErrorActionPreference = 'Stop'

$BinDir = $PSScriptRoot
$ReviewTs = Join-Path $BinDir 'review.ts'

if (-not (Test-Path -LiteralPath $ReviewTs)) {
    Write-Error "review.ts not found at $ReviewTs"
}

node --import tsx $ReviewTs @args
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
