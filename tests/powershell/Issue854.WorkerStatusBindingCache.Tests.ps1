#requires -Version 5.1

BeforeAll {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $ScenarioPath = Join-Path $RepoRoot 'tests/issue854-worker-status-binding-cache.mjs'
    $NodePath = (Get-Command node -ErrorAction Stop).Source
}

Describe 'Issue #854 worker-status binding cache wiring' {
    It 'runs the Node production-path regression without PowerShell business logic' {
        $output = @(& $NodePath $ScenarioPath 2>&1)
        $exitCode = $LASTEXITCODE
        $exitCode | Should -Be 0 -Because ($output -join "`n")
    }
}
