#requires -Version 5.1
<#
.SYNOPSIS
  Optional batched Vitest smoke path for verify.ps1 (Issue #488).

  Default verify.ps1 is structural/read-only. Full Vitest regression ownership
  lives in scripts/test-all.ps1 and the CI test-vitest matrix. Invoke this
  helper only via verify.ps1 -TestBackedSmoke for local smoke/debug.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

$SmokeFiles = @(
    'scripts/gh-wrapper.test.ts',
    'scripts/github-fleet-cache-coalesce.test.ts',
    'scripts/github-fleet-cache-memo.test.ts',
    'scripts/github-fleet-cache-bypass-guard.test.ts',
    'scripts/github-fleet-cache-stale-snapshot.test.ts',
    'scripts/contract-evidence.test.ts',
    'scripts/autonomous-spawn-policy.test.ts',
    'scripts/autonomous-spawn-worktree-gate.test.ts',
    'scripts/autonomous-spawn-budget.test.ts',
    'scripts/review-pipeline-spawn-budget.test.ts',
    'scripts/review-start-repeat-classifier.test.ts',
    'scripts/autonomous-orchestrator-interposer.test.ts'
)

. (Join-Path $PSScriptRoot 'lib/Write-PackCheckLine.ps1')

Write-Host '== verify test-backed smoke (Issue #488) =='
Write-Host 'Ownership: full regression remains scripts/test-all.ps1 / CI test-vitest lane.'
Write-Host ''

$selected = @()
foreach ($rel in $SmokeFiles) {
    $path = Join-Path $RepoRoot $rel
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $selected += $rel
    }
    else {
        Write-PackCheckLine "verify-smoke/$rel" 'FAIL' 'missing'
        exit 1
    }
}

Push-Location $RepoRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'node_modules') -PathType Container)) {
        Write-Host 'Installing npm dependencies once for test-backed smoke...'
        & npm ci --include=dev
        if ($LASTEXITCODE -ne 0) {
            Write-PackCheckLine 'verify-smoke/npm-preflight' 'FAIL' "npm ci exit=$LASTEXITCODE"
            exit 1
        }
    }
    else {
        Write-PackCheckLine 'verify-smoke/npm-preflight' 'PASS' 'node_modules present'
    }

    $previousCi = $env:CI
    $env:CI = 'true'
    try {
        & npx vitest run @selected
        if ($LASTEXITCODE -ne 0) {
            Write-PackCheckLine 'verify-smoke/vitest' 'FAIL' "exit=$LASTEXITCODE"
            exit 1
        }
        Write-PackCheckLine 'verify-smoke/vitest' 'PASS' ("batched files={0}" -f $selected.Count)
    }
    finally {
        if ($null -ne $previousCi) { $env:CI = $previousCi } else { Remove-Item Env:CI -ErrorAction SilentlyContinue }
    }
}
finally {
    Pop-Location
}

exit 0
