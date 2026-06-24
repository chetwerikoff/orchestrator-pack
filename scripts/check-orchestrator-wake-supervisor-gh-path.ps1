#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: wake-supervisor children prepend pack scripts/ for gh REST shim (Issue #447).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$supervisorLib = Join-Path $Root 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1'
$testChild = Join-Path $Root 'scripts/orchestrator-wake-supervisor-test-child.ps1'

if (-not (Test-Path -LiteralPath $supervisorLib -PathType Leaf)) {
    Write-Host 'Missing required file: scripts/lib/Orchestrator-SideProcessSupervisor.ps1'
    exit 1
}

$libText = Get-Content -LiteralPath $supervisorLib -Raw
$requiredPatterns = @(
    @{ Path = $supervisorLib; Pattern = 'function Get-OrchestratorSideProcessPackScriptsDir' },
    @{ Path = $supervisorLib; Pattern = 'function Merge-OrchestratorSideProcessPackScriptsPath' },
    @{ Path = $supervisorLib; Pattern = 'function New-OrchestratorWakeSupervisorChildEnvironment' },
    @{ Path = $supervisorLib; Pattern = 'PATH\s*=\s*\(Merge-OrchestratorSideProcessPackScriptsPath\)' },
    @{ Path = $supervisorLib; Pattern = 'New-OrchestratorWakeSupervisorChildEnvironment -Paths \$Paths -Entry \$entry' },
    @{ Path = $supervisorLib; Pattern = "export PATH=\{0\}:\$\{\{PATH:-\}\}" },
    @{ Path = $testChild; Pattern = 'ghCommandPath' }
)

foreach ($item in $requiredPatterns) {
    if (-not (Test-Path -LiteralPath $item.Path -PathType Leaf)) {
        Write-Host "Missing required file: $($item.Path)"
        exit 1
    }
    $text = if ($item.Path -eq $supervisorLib) { $libText } else { Get-Content -LiteralPath $item.Path -Raw }
    if ($text -notmatch $item.Pattern) {
        Write-Host "Pattern not found in $($item.Path): $($item.Pattern)"
        exit 1
    }
}

Write-Host '[PASS] wake-supervisor child gh PATH prepend (Issue #447)'
exit 0
