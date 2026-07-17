#requires -Version 5.1

BeforeAll {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $ScenarioPath = Join-Path $RepoRoot 'tests/issue854-worker-status-binding-cache.mjs'
}

Describe 'Issue #854 worker-status binding cache wiring' {
    It 'runs the Node production-path regression without PowerShell business logic' {
        $output = @(& node $ScenarioPath 2>&1)
        $LASTEXITCODE | Should -Be 0 -Because ($output -join "`n")
        $jsonLine = @(($output -join "`n") -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') })[-1]
        $result = $jsonLine | ConvertFrom-Json
        $result.issue | Should -Be 854
        $result.cacheSource | Should -Be 'push_register'
        $result.usableDerivedStatus | Should -Be 'pr_open'
        $result.winningSource | Should -Be 'github_pr'
        @($result.scenarios) | Should -Contain 'unreadable'
    }
}
