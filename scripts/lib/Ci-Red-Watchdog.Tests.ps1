#requires -Version 7.0

Describe 'CI-red delivery watchdog (Issue #755)' {
    It 'passes deterministic Node acceptance self-test' {
        $selfTest = Join-Path $PSScriptRoot 'ci-red-watchdog-selftest.mjs'
        Test-Path -LiteralPath $selfTest -PathType Leaf | Should -BeTrue

        $output = @(& node $selfTest 2>&1)
        $exitCode = $LASTEXITCODE
        foreach ($line in $output) { Write-Host $line }

        $exitCode | Should -Be 0
        ($output -join "`n") | Should -Match 'CI-red watchdog self-test'
    }
}
