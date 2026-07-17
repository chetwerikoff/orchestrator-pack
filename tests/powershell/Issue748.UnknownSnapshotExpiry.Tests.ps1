#requires -Version 5.1

BeforeAll {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    . (Join-Path $RepoRoot 'scripts/lib/Review-TriggerReeval-Common.ps1')
    $Issue854ScenarioPath = Join-Path $RepoRoot 'tests/issue854-worker-status-binding-cache.mjs'
    $Issue854NodePath = (Get-Command node -ErrorAction Stop).Source
}

Describe 'Issue #748 unknown PR snapshot retention' {
    It 'retains an already-expired watch and preserves its original deadline' {
        $key = '748:oldhead748'
        $originalExpiry = 1700000300000
        $watchEntries = @{}
        $watchEntries[$key] = @{
            prNumber            = 748
            headSha             = 'oldhead748'
            sessionId           = 'opk-748'
            seedMs              = 1700000000000
            windowExpiresMs     = $originalExpiry
            seedSource          = 'wake_defer'
            deferReason         = 'uncovered_not_ready'
            deferPrimary        = 'no_ready_for_review'
            pollClass           = 'scoped_deferred_head_watch'
            lastObservedReadyMs = $null
            lastEvaluatedMs     = 1700000000000
            status              = 'watching'
        }

        $result = Invoke-ReviewTriggerReevalFilterCli -Subcommand 'planTick' -Payload @{
            watchEntries                  = $watchEntries
            openPrs                       = @()
            reviewRuns                    = @()
            sessions                      = @()
            ciChecksByPr                  = @{}
            requiredCheckNamesByPr        = @{}
            requiredCheckLookupFailedByPr = @{}
            snapshotErrorsByKey           = @{ $key = $true }
            capCycleState                 = @{}
            nowMs                         = 1700000400000
        }

        $action = @($result.actions)[0]
        $action.type | Should -Be 'retain_watch'
        $action.reason | Should -Be 'snapshot_unknown'
        $result.watchEntries[$key].status | Should -Be 'watching'
        $result.watchEntries[$key].windowExpiresMs | Should -Be $originalExpiry
    }
}

Describe 'Issue #854 worker-status binding cache wiring' {
    It 'runs the Node production-path regression without new PowerShell business logic' {
        $output = @(& $Issue854NodePath $Issue854ScenarioPath 2>&1)
        $exitCode = $LASTEXITCODE
        $exitCode | Should -Be 0 -Because ($output -join "`n")
    }
}
