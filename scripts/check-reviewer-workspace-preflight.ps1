#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: stale reviewer workspace preflight (Issue #98).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$preflight = Join-Path $Root 'scripts/reviewer-workspace-preflight.ps1'

if (-not (Test-Path -LiteralPath $preflight -PathType Leaf)) {
    Write-Host "[FAIL] missing $preflight"
    exit 1
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("op98-ws-" + [Guid]::NewGuid().ToString('n'))
$workspaces = Join-Path $tempRoot 'code-reviews\workspaces'
$stale = Join-Path $workspaces 'op-rev-stale-test'
New-Item -ItemType Directory -Path $stale -Force | Out-Null
Set-Content -LiteralPath (Join-Path $stale 'marker.txt') -Value 'stale'

Push-Location -LiteralPath $tempRoot
try {
    git init -q | Out-Null
    git config user.email 'preflight@test.local'
    git config user.name 'preflight-test'
    git add -A 2>$null
    git commit -m 'init' -q 2>$null
}
finally {
    Pop-Location
}

try {
    if (Test-Path -LiteralPath $stale) {
        & $preflight -RepoRoot $tempRoot
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[FAIL] reviewer-workspace-preflight.ps1 exited $LASTEXITCODE"
            exit 1
        }
        if (Test-Path -LiteralPath $stale) {
            Write-Host "[FAIL] stale workspace directory was not removed"
            exit 1
        }
    }
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host '[PASS] reviewer-workspace-preflight removes orphan workspace directories'
exit 0
