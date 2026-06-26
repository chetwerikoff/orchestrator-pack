#requires -Version 7.0
BeforeAll {
    $script:RepoRoot = Split-Path -Parent $PSScriptRoot
    $script:LibDir = Join-Path $script:RepoRoot 'scripts/lib'
    $script:FixtureDir = Join-Path $script:RepoRoot 'scripts/fixtures/mechanical-json-state'
    . (Join-Path $script:LibDir 'MechanicalReconcileNode.ps1')
    . (Join-Path $script:LibDir 'Orchestrator-SideProcessHealth.ps1')

    $script:ReflectionKeys = Get-MechanicalJsonReflectionKeys
    $script:ReviewSendDefault = @{ sent = @{}; lastTickMs = $null }
    $script:DeliveryDefault = @{ runs = @{}; lastTickMs = $null }

    function script:New-TempStatePath {
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("mech-state-test-" + [guid]::NewGuid().ToString())
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        return Join-Path $dir 'state.json'
    }

    function script:Test-MapHasNoReflectionKeys {
        param($Map)
        foreach ($key in @($Map.Keys)) {
            if ($script:ReflectionKeys -contains [string]$key) {
                return $false
            }
        }
        return $true
    }
}

Describe 'mechanical transport privacy helpers' {
    It 'reads unix mode via platform stat syntax' {
        if (-not ($IsLinux -or $IsMacOS)) {
            Set-ItResult -Inconclusive -Because 'unix-only stat helper coverage'
            return
        }
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("mech-transport-mode-" + [guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        try {
            Protect-MechanicalTransportPath -Path $dir -Directory | Out-Null
            $file = Join-Path $dir 'mode.payload'
            Write-MechanicalWorkerMessagePayloadFile -Path $file -Content 'secret'
            $mode = Get-MechanicalTransportUnixModeString -Path $file
            $mode | Should -Be '600'
        }
        finally {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Describe 'Mechanical JSON state round-trip' {
    It 'preserves populated map entries without reflection keys (review-send sent)' {
        $path = New-TempStatePath
        $seed = Get-Content -LiteralPath (Join-Path $script:FixtureDir 'clean-sent-populated.json') -Raw |
            ConvertFrom-Json -AsHashtable
        Set-MechanicalJsonStateFile -Path $path -State $seed -DefaultState $script:ReviewSendDefault -JsonDepth 30
        $first = Get-MechanicalJsonStateFile -Path $path -DefaultState $script:ReviewSendDefault
        Set-MechanicalJsonStateFile -Path $path -State $first -DefaultState $script:ReviewSendDefault -JsonDepth 30
        $second = Get-MechanicalJsonStateFile -Path $path -DefaultState $script:ReviewSendDefault

        $second.sent['run-abc'].sessionId | Should -Be 'sess-1'
        Test-MapHasNoReflectionKeys -Map $second.sent | Should -Be $true
    }

    It 'does not mutate script default when returning missing-file state' {
        $path = New-TempStatePath
        $sharedDefault = @{ sent = @{}; lastTickMs = $null }
        $first = Get-MechanicalJsonStateFile -Path $path -DefaultState $sharedDefault
        $first.sent['run-mut'] = @{ sessionId = 'sess-mut' }
        $first['_recovery'] = @{ fenceTrusted = $false; reason = 'synthetic' }
        $first.lastTickMs = 99999

        $second = Get-MechanicalJsonStateFile -Path $path -DefaultState $sharedDefault
        $second.sent.Count | Should -Be 0
        $second.ContainsKey('_recovery') | Should -Be $false
        $second.lastTickMs | Should -Be $null
        $sharedDefault.sent.Count | Should -Be 0
        $sharedDefault.ContainsKey('_recovery') | Should -Be $false
        $sharedDefault.lastTickMs | Should -Be $null
    }

    It 'writes clean genesis from default hashtable maps' {
        $path = New-TempStatePath
        $state = Get-MechanicalJsonStateFile -Path $path -DefaultState $script:ReviewSendDefault
        Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $script:ReviewSendDefault -JsonDepth 30
        $written = Get-MechanicalJsonStateFile -Path $path -DefaultState $script:ReviewSendDefault

        Test-MapHasNoReflectionKeys -Map $written.sent | Should -Be $true
        $written.sent.Count | Should -Be 0
    }

    It 'self-heals corrupt seven-key blob on read/write' {
        $path = New-TempStatePath
        Copy-Item -LiteralPath (Join-Path $script:FixtureDir 'corrupt-seven-key-runs.json') -Destination $path
        $healed = Get-MechanicalJsonStateFile -Path $path -DefaultState $script:DeliveryDefault -ActionTracking
        Set-MechanicalJsonStateFile -Path $path -State $healed -DefaultState $script:DeliveryDefault -JsonDepth 30
        $final = Get-MechanicalJsonStateFile -Path $path -DefaultState $script:DeliveryDefault

        Test-MapHasNoReflectionKeys -Map $final.runs | Should -Be $true
        $final.runs.Count | Should -Be 0
    }

    It 'does not inject reflection keys for partial missing map field' {
        $path = New-TempStatePath
        Copy-Item -LiteralPath (Join-Path $script:FixtureDir 'partial-missing-sent.json') -Destination $path
        $state = Get-MechanicalJsonStateFile -Path $path -DefaultState $script:ReviewSendDefault
        Set-MechanicalJsonStateFile -Path $path -State $state -DefaultState $script:ReviewSendDefault -JsonDepth 30
        $final = Get-MechanicalJsonStateFile -Path $path -DefaultState $script:ReviewSendDefault

        Test-MapHasNoReflectionKeys -Map $final.sent | Should -Be $true
        $final.sent.Count | Should -Be 0
    }

    It 'fails closed on unparseable action-tracking state without backup' {
        $path = New-TempStatePath
        Copy-Item -LiteralPath (Join-Path $script:FixtureDir 'unparseable-truncated.json') -Destination $path
        $state = Get-MechanicalJsonStateFile -Path $path -DefaultState $script:ReviewSendDefault -ActionTracking

        Test-MechanicalJsonStateFencesTrusted -State $state | Should -Be $false
        Test-Path -LiteralPath $path | Should -Be $true
        $again = Get-MechanicalJsonStateFile -Path $path -DefaultState $script:ReviewSendDefault -ActionTracking
        Test-MechanicalJsonStateFencesTrusted -State $again | Should -Be $false
    }

    It 'throws when tick helpers assert untrusted fences' {
        $untrusted = @{
            sent      = @{}
            lastTickMs = $null
            _recovery = @{
                fenceTrusted = $false
                reason       = 'unparseable_no_backup'
            }
        }
        { Assert-MechanicalJsonStateFencesTrusted -State $untrusted } | Should -Throw '*STATE FENCES UNTRUSTED*'
    }

    It 'restores action-tracking state from backup after unparseable write' {
        $path = New-TempStatePath
        $good = Get-Content -LiteralPath (Join-Path $script:FixtureDir 'clean-sent-populated.json') -Raw |
            ConvertFrom-Json -AsHashtable
        Set-MechanicalJsonStateFile -Path $path -State $good -DefaultState $script:ReviewSendDefault -JsonDepth 30
        Set-Content -LiteralPath $path -Value '{"sent":{' -Encoding utf8 -NoNewline

        $state = Get-MechanicalJsonStateFile -Path $path -DefaultState $script:ReviewSendDefault -ActionTracking
        Test-MechanicalJsonStateFencesTrusted -State $state | Should -Be $true
        $state.sent['run-abc'].sessionId | Should -Be 'sess-1'
        Test-Path -LiteralPath $path | Should -Be $true
        $again = Get-MechanicalJsonStateFile -Path $path -DefaultState $script:ReviewSendDefault -ActionTracking
        $again.sent['run-abc'].sessionId | Should -Be 'sess-1'
    }

    It 'keeps untrusted backup fail-closed when main file becomes unparseable' {
        $path = New-TempStatePath
        $untrusted = @{
            sent       = @{}
            lastTickMs = $null
            _recovery  = @{
                fenceTrusted = $false
                reason       = 'unparseable_no_backup'
            }
        }
        Set-MechanicalJsonStateFile -Path $path -State $untrusted -DefaultState $script:ReviewSendDefault -JsonDepth 30
        $backupPath = Get-MechanicalJsonStateBackupPath -Path $path
        Copy-Item -LiteralPath $path -Destination $backupPath -Force
        Set-Content -LiteralPath $path -Value '{"sent":{' -Encoding utf8 -NoNewline

        $state = Get-MechanicalJsonStateFile -Path $path -DefaultState $script:ReviewSendDefault -ActionTracking
        Test-MechanicalJsonStateFencesTrusted -State $state | Should -Be $false
        Get-MechanicalJsonStateRecoveryReason -State $state | Should -Be 'unparseable_no_backup'
    }

    It 'does not overwrite a trusted backup when persisting untrusted recovery' {
        $path = New-TempStatePath
        $good = Get-Content -LiteralPath (Join-Path $script:FixtureDir 'clean-sent-populated.json') -Raw |
            ConvertFrom-Json -AsHashtable
        Set-MechanicalJsonStateFile -Path $path -State $good -DefaultState $script:ReviewSendDefault -JsonDepth 30
        $backupPath = Get-MechanicalJsonStateBackupPath -Path $path
        $untrusted = @{
            sent       = @{}
            lastTickMs = $null
            _recovery  = @{
                fenceTrusted = $false
                reason       = 'unparseable_no_backup'
            }
        }
        Set-MechanicalJsonStateFile -Path $path -State $untrusted -DefaultState $script:ReviewSendDefault -JsonDepth 30

        $backup = Get-Content -LiteralPath $backupPath -Raw | ConvertFrom-Json -AsHashtable
        $backup.sent['run-abc'].sessionId | Should -Be 'sess-1'
        $backup.ContainsKey('_recovery') | Should -Be $false
    }
}

Describe 'side process progress pid rollover' {
    BeforeAll {
        . (Join-Path $script:LibDir 'Orchestrator-SideProcessProgress.ps1')
    }

    function script:New-TempProgressDir {
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("side-progress-test-" + [guid]::NewGuid().ToString())
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        return $dir
    }

    It 'discards prior process recentOutcomes when pid changes' {
        $dir = New-TempProgressDir
        $previous = $env:AO_SIDE_PROCESS_PROGRESS_DIR
        $env:AO_SIDE_PROCESS_PROGRESS_DIR = $dir
        try {
            $path = Join-Path $dir 'test-child.progress.json'
            @{
                childId        = 'test-child'
                pid            = 1
                recentOutcomes = @('error', 'error')
                lastProgressMs = 1000
                phase          = 'tick_error'
            } | ConvertTo-Json -Compress | Set-Content -LiteralPath $path -Encoding utf8 -NoNewline

            Write-OrchestratorSideProcessTickError -ChildId 'test-child' -ErrorMessage 'new process error'
            $read = Read-OrchestratorSideProcessProgress -ChildId 'test-child'
            @($read.recentOutcomes) | Should -Be @('error')
            [int]$read.pid | Should -Be $PID
        }
        finally {
            if ($null -eq $previous) {
                Remove-Item Env:AO_SIDE_PROCESS_PROGRESS_DIR -ErrorAction SilentlyContinue
            }
            else {
                $env:AO_SIDE_PROCESS_PROGRESS_DIR = $previous
            }
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'does not copy recentOutcomes on poll when pid changes' {
        $dir = New-TempProgressDir
        $previous = $env:AO_SIDE_PROCESS_PROGRESS_DIR
        $env:AO_SIDE_PROCESS_PROGRESS_DIR = $dir
        try {
            $path = Join-Path $dir 'test-child.progress.json'
            @{
                childId        = 'test-child'
                pid            = 1
                recentOutcomes = @('error', 'error', 'error')
                lastProgressMs = 1000
                phase          = 'tick_error'
                lastError      = 'old process failure'
            } | ConvertTo-Json -Compress | Set-Content -LiteralPath $path -Encoding utf8 -NoNewline

            Write-OrchestratorSideProcessProgress -ChildId 'test-child' -Phase 'poll'
            $read = Read-OrchestratorSideProcessProgress -ChildId 'test-child'
            $read.PSObject.Properties.Name | Should -Not -Contain 'recentOutcomes'
            [int]$read.pid | Should -Be $PID
            $read.phase | Should -Be 'poll'
        }
        finally {
            if ($null -eq $previous) {
                Remove-Item Env:AO_SIDE_PROCESS_PROGRESS_DIR -ErrorAction SilentlyContinue
            }
            else {
                $env:AO_SIDE_PROCESS_PROGRESS_DIR = $previous
            }
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'preserves recentOutcomes for the same pid' {
        $dir = New-TempProgressDir
        $previous = $env:AO_SIDE_PROCESS_PROGRESS_DIR
        $env:AO_SIDE_PROCESS_PROGRESS_DIR = $dir
        try {
            $path = Join-Path $dir 'test-child.progress.json'
            @{
                childId        = 'test-child'
                pid            = $PID
                recentOutcomes = @('error', 'error')
                lastProgressMs = 1000
                phase          = 'tick_error'
            } | ConvertTo-Json -Compress | Set-Content -LiteralPath $path -Encoding utf8 -NoNewline

            Write-OrchestratorSideProcessTickError -ChildId 'test-child' -ErrorMessage 'third error'
            $read = Read-OrchestratorSideProcessProgress -ChildId 'test-child'
            @($read.recentOutcomes) | Should -Be @('error', 'error', 'error')
        }
        finally {
            if ($null -eq $previous) {
                Remove-Item Env:AO_SIDE_PROCESS_PROGRESS_DIR -ErrorAction SilentlyContinue
            }
            else {
                $env:AO_SIDE_PROCESS_PROGRESS_DIR = $previous
            }
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Describe 'review trigger reeval watch fail-closed' {
    BeforeAll {
        . (Join-Path $script:LibDir 'Record-ReviewTriggerReevalWatch.ps1')
        $script:ReevalWatchDefault = @{ watchEntries = @{}; lastUpdatedMs = $null }
    }

    function script:New-TempWatchPath {
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("reeval-watch-test-" + [guid]::NewGuid().ToString())
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        return Join-Path $dir 'review-trigger-reeval-watch.json'
    }

    It 'fails closed when watch state is untrusted' {
        $path = New-TempWatchPath
        Copy-Item -LiteralPath (Join-Path $script:FixtureDir 'unparseable-truncated.json') -Destination $path
        $state = Get-ReviewTriggerReevalWatchState -Path $path
        Test-MechanicalJsonStateFencesTrusted -State $state | Should -Be $false
        { Assert-MechanicalJsonStateFencesTrusted -State $state -Context 'review reeval side effects' } |
            Should -Throw '*STATE FENCES UNTRUSTED*'
    }
}

Describe 'supervisor side-effect drain exemption' {
    BeforeAll {
        . (Join-Path $script:LibDir 'Orchestrator-SideProcessSupervisor.ps1')
    }

    function script:New-TempSupervisorStateRoot {
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("wake-sup-test-" + [guid]::NewGuid().ToString())
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        return $dir
    }

    It 'defers stalled health while a side-effect lock is held' {
        $stateRoot = New-TempSupervisorStateRoot
        $paths = Get-OrchestratorWakeSupervisorPaths -StateRoot $stateRoot
        New-Item -ItemType Directory -Path $paths.ProgressDir -Force | Out-Null
        $oldMs = [DateTimeOffset]::UtcNow.AddMinutes(-10).ToUnixTimeMilliseconds()
        $progress = @{
            childId        = 'ci-green-wake-reconcile'
            phase          = 'side_effect'
            pid            = 99999
            lastProgressMs = $oldMs
        }
        $progressPath = Join-Path $paths.ProgressDir 'ci-green-wake-reconcile.progress.json'
        $progress | ConvertTo-Json -Compress | Set-Content -LiteralPath $progressPath -Encoding utf8 -NoNewline
        '{"owner":"test"}' | Set-Content -LiteralPath $paths.'ci-green-wake-reconcileLock' -Encoding utf8 -NoNewline

        $entry = Get-OrchestratorWakeSupervisorChildEntry -ChildId 'ci-green-wake-reconcile'
        $health = Get-OrchestratorSideProcessHealthVerdict -ChildEntry $entry -Paths $paths -ChildAlive $true `
            -Progress $progress -ChildPid 99999 -StallThresholdMs 60000 -ChildStartedMs $oldMs
        $health.Status | Should -Be 'stalled'

        if ($health.Status -eq 'stalled' -and (Test-OrchestratorWakeSupervisorSideEffectInFlight -Paths $paths -ChildId 'ci-green-wake-reconcile')) {
            $health.Status = 'working'
            $health.Reason = ''
        }

        $health.Status | Should -Be 'working'
    }
}

Describe 'supervisor health classification' {
    It 'reports stalled when alive child has no current progress past grace window' {
        $startedMs = [DateTimeOffset]::UtcNow.AddMinutes(-5).ToUnixTimeMilliseconds()
        $verdict = Get-OrchestratorSideProcessHealthVerdict -ChildEntry @{ RequiresOrchestratorSession = $false } `
            -Paths @{} -SupervisorPhase 'running' -ChildAlive $true -Progress $null -ChildPid 42 `
            -StallThresholdMs 60000 -ChildStartedMs $startedMs

        $verdict.Status | Should -Be 'stalled'
        $verdict.Reason | Should -Be 'no progress heartbeat'
    }

    It 'reports stalled when progress belongs to a prior process' {
        $startedMs = [DateTimeOffset]::UtcNow.AddMinutes(-5).ToUnixTimeMilliseconds()
        $staleProgress = [pscustomobject]@{
            pid            = 1
            lastProgressMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            phase          = 'tick_success'
        }
        $verdict = Get-OrchestratorSideProcessHealthVerdict -ChildEntry @{ RequiresOrchestratorSession = $false } `
            -Paths @{} -SupervisorPhase 'running' -ChildAlive $true -Progress $staleProgress -ChildPid 42 `
            -StallThresholdMs 60000 -ChildStartedMs $startedMs

        $verdict.Status | Should -Be 'stalled'
        $verdict.Reason | Should -Be 'stale progress from prior process'
    }

    It 'treats legacy sparse poll heartbeats as fresh for non-seed children' {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $progress = @{
            childId        = 'ci-green-wake-reconcile'
            phase          = 'poll'
            pid            = $PID
            lastProgressMs = $nowMs
        }
        $freshness = Get-OrchestratorSideProcessProgressFreshnessVerdict -Progress $progress `
            -ChildPid $PID -StallThresholdMs 20000 -NowMs $nowMs -ChildId 'ci-green-wake-reconcile'
        $freshness.Fresh | Should -Be $true
        $freshness.Status | Should -Be 'fresh'
    }
}

Describe 'supervisor bounded recovery' {
    It 'allows exactly maxAttempts recovery restarts before terminal escalation' {
        $max = 3
        $restartAttempts = @()
        for ($prior = 0; $prior -lt 10; $prior++) {
            if (Test-OrchestratorSideProcessRecoveryShouldEscalate -PriorRecoveryAttempts $prior -MaxAttempts $max) {
                break
            }
            $restartAttempts += ($prior + 1)
        }

        $restartAttempts | Should -Be @(1, 2, 3)
    }

    It 'performs one recovery restart when maxAttempts is 1' {
        Test-OrchestratorSideProcessRecoveryShouldEscalate -PriorRecoveryAttempts 0 -MaxAttempts 1 | Should -Be $false
        Test-OrchestratorSideProcessRecoveryShouldEscalate -PriorRecoveryAttempts 1 -MaxAttempts 1 | Should -Be $true
    }
}
