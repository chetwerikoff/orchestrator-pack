#requires -Version 7.0
<#
.SYNOPSIS
  CI guard for orchestrator message registry audit, overlap check, and map drift (Issue #298).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

$registryCli = Join-Path $RepoRoot 'docs/orchestrator-message-registry.mjs'
$mapPath = Join-Path $RepoRoot 'docs/orchestrator-message-map.md'
$failures = New-Object System.Collections.Generic.List[string]

if ($IsWindows -and -not $env:WSL_DISTRO_NAME) {
    $failures.Add('unsupported host: native Windows execution is refused (use Linux/WSL + pwsh 7+)')
}
elseif ($PSVersionTable.PSEdition -eq 'Desktop') {
    $failures.Add('unsupported host: Windows PowerShell is refused (use pwsh 7+ on Linux/WSL)')
}

if (-not (Test-Path -LiteralPath $registryCli -PathType Leaf)) {
    $failures.Add("missing registry cli: $registryCli")
}

if ($failures.Count -eq 0) {
    $auditJson = & node $registryCli audit $RepoRoot 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        $failures.Add("registration audit failed: $auditJson")
    }

    $generated = & node $registryCli generate-map $RepoRoot 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        $failures.Add("map generation failed: $generated")
    }
    elseif (-not (Test-Path -LiteralPath $mapPath -PathType Leaf)) {
        $failures.Add("missing committed map: $mapPath")
    }
    else {
        $committed = Get-Content -LiteralPath $mapPath -Raw
        if ($committed -ne $generated) {
            $failures.Add('committed orchestrator message map differs from regenerated output')
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] orchestrator message registry guard:'
    foreach ($f in $failures) { Write-Host "  - $f" }
    exit 1
}

Write-Host '[PASS] orchestrator message registry audit and committed map OK.'
exit 0
