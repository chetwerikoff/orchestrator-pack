#requires -Version 5.1
<#
.SYNOPSIS
  Meta-check: read-delegation audit CI workflow actually gates PRs (Issue #309 AC13).
#>
param(
    [string]$RepoRoot
)

. (Join-Path $PSScriptRoot 'lib/Read-DelegationCheck-Common.ps1')
$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-ReadDelegationCheckRepoRoot -RepoRoot $RepoRoot -ScriptRoot $PSScriptRoot

$workflowPath = Join-Path $RepoRoot '.github/workflows/read-delegation-audit.yml'
if (-not (Test-Path -LiteralPath $workflowPath)) {
    Write-Host '[FAIL] missing .github/workflows/read-delegation-audit.yml'
    exit 1
}

$workflow = Get-Content -LiteralPath $workflowPath -Raw
$failures = [System.Collections.Generic.List[string]]::new()

if ($workflow -notmatch '(?m)^on:\s*$') {
    $failures.Add('workflow missing on: trigger block')
}
if ($workflow -notmatch 'pull_request') {
    $failures.Add('workflow missing pull_request trigger')
}
if ($workflow -match 'continue-on-error:\s*true') {
    $failures.Add('audit job uses continue-on-error')
}
if ($workflow -match 'if:\s*false') {
    $failures.Add('audit job has unconditional skip (if: false)')
}

Push-Location $RepoRoot
try {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'npm required for negative self-test'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'node_modules'))) {
        & npm ci --include=dev | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    }

    $negativeFixture = @'
import { describe, it, expect } from "vitest";
describe("negative self-test", () => {
  it("must fail for CI gate proof", () => {
    expect(true).toBe(false);
  });
});
'@
    $negativePath = Join-Path $RepoRoot 'scripts/read-delegation-audit-negative-selftest.ts'
    [System.IO.File]::WriteAllText(
        $negativePath,
        $negativeFixture,
        [System.Text.UTF8Encoding]::new($false)
    )
    try {
        & npx vitest run $negativePath 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $failures.Add('negative self-test unexpectedly passed — workflow cannot prove failure propagation')
        }
    }
    finally {
        Remove-Item -LiteralPath $negativePath -Force -ErrorAction SilentlyContinue
    }
}
finally {
    Pop-Location
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] read-delegation audit CI gate meta-check:'
    foreach ($item in $failures) {
        Write-Host " - $item"
    }
    exit 1
}

Write-Host '[PASS] read-delegation audit CI gate is present and enforces fixture failures.'
exit 0
