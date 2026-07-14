#requires -Version 7.0

Describe 'CI-red delivery watchdog (Issue #755)' {
    BeforeAll {
        . (Join-Path $PSScriptRoot 'Ci-Red-Watchdog.ps1')
    }

    It 'passes deterministic Node acceptance self-test' {
        $selfTest = Join-Path $PSScriptRoot 'ci-red-watchdog-selftest.mjs'
        Test-Path -LiteralPath $selfTest -PathType Leaf | Should -BeTrue

        $output = @(& node $selfTest 2>&1)
        $exitCode = $LASTEXITCODE
        foreach ($line in $output) { Write-Host $line }

        $exitCode | Should -Be 0
        ($output -join "`n") | Should -Match 'CI-red watchdog self-test'
    }

    It 'treats AO working plus idle activity as quiescent' {
        $worker = Resolve-CiRedWatchdogWorker -Sessions @(
            @{
                role = 'worker'
                prNumber = 755
                headSha = 'abc123'
                sessionId = 'worker-755'
                generation = 'gen-1'
                status = 'working'
                activity = 'idle'
                lastActivityAtMs = 1800000000000
            }
        ) -PrNumber 755 -HeadSha 'abc123' -NowMs 1800000060000

        $worker.ok | Should -BeTrue
        $worker.alive | Should -BeTrue
        $worker.quiescent | Should -BeTrue
    }

    It 'treats AO working plus ready activity as quiescent' {
        $worker = Resolve-CiRedWatchdogWorker -Sessions @(
            @{
                role = 'worker'
                prNumber = 755
                headSha = 'abc123'
                sessionId = 'worker-755'
                generation = 'gen-1'
                status = 'working'
                activity = 'ready'
                lastActivityAtMs = 1800000000000
            }
        ) -PrNumber 755 -HeadSha 'abc123' -NowMs 1800000060000

        $worker.ok | Should -BeTrue
        $worker.quiescent | Should -BeTrue
    }
}
