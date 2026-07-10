#requires -Version 5.1
<#
  verify.ps1 hook: fixture-based cursor-agent TUI shim checks (Issue #725). Regenerated launch-argv inventory ships with shim PRs.
  Uses isolated temp HOME — never mutates operator ~/.local/bin.
#>
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$modulePath = Join-Path $Root 'scripts/lib/Cursor-Agent-TuiShim.ps1'
$shimSource = Join-Path $Root 'scripts/cursor-agent-tui-shim.sh'
$testFile = Join-Path $Root 'scripts/cursor-agent-tui-shim.test.ts'

foreach ($path in @($modulePath, $shimSource, $testFile)) {
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "missing required file: $path"
        exit 1
    }
}

Push-Location $Root
try {
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules') -PathType Container)) {
        & npm ci --include=dev
        if ($LASTEXITCODE -ne 0) {
            Write-Host "npm ci failed exit=$LASTEXITCODE"
            exit 1
        }
    }

    & npx vitest run scripts/cursor-agent-tui-shim.test.ts
    if ($LASTEXITCODE -ne 0) {
        Write-Host "cursor-agent-tui-shim vitest failed exit=$LASTEXITCODE"
        exit 1
    }
}
finally {
    Pop-Location
}

Write-Host 'cursor-agent TUI shim check passed'
exit 0
