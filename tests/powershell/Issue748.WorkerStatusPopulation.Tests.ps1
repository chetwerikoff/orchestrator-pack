#requires -Version 5.1

BeforeAll {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $InvokeAoPath = Join-Path $RepoRoot 'scripts/lib/Invoke-AoCliJson.ps1'
    $WatchHelperPath = Join-Path $RepoRoot 'scripts/lib/Record-ReviewTriggerReevalWatch.ps1'
    $ReviewReadyEntrypoint = Join-Path $RepoRoot 'scripts/review-ready-report-state-seed.ps1'
    $ReevalEntrypoint = Join-Path $RepoRoot 'scripts/review-trigger-reeval.ps1'

    function ConvertTo-Issue748PsLiteral {
        param([string]$Value)
        return "'" + $Value.Replace("'", "''") + "'"
    }

    function Invoke-Issue748PwshCommand {
        param([string]$Command)

        $output = @(& pwsh -NoProfile -NonInteractive -Command $Command 2>&1)
        if ($LASTEXITCODE -ne 0) {
            throw "pwsh failed ($LASTEXITCODE)`n$($output -join "`n")"
        }
        return $output
    }

    function Invoke-Issue748PwshFile {
        param(
            [string]$Path,
            [string[]]$Arguments = @()
        )

        $invokeArgs = @('-NoProfile', '-NonInteractive', '-File', $Path) + @($Arguments)
        $output = @(& pwsh @invokeArgs 2>&1)
        if ($LASTEXITCODE -ne 0) {
            throw "pwsh file failed ($LASTEXITCODE)`n$($output -join "`n")"
        }
        return $output
    }

    function ConvertFrom-Issue748LastJson {
        param([object[]]$Output)

        $lines = @(($Output -join "`n") -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') })
        if ($lines.Count -eq 0) {
            throw "no JSON object in output:`n$($Output -join "`n")"
        }
        return ($lines[-1] | ConvertFrom-Json)
    }

    function Invoke-Issue748DiagnosticScenario {
        param(
            [string]$WriteBody,
            [string]$KillSwitch = '$false',
            [string]$Readiness = '@{ ok = $true; workerReportStorePresent = $true; sessionPrBindingResolverPresent = $true }',
            [string]$Sessions = "@([pscustomobject]@{ id = 'good'; reports = @() }, [pscustomobject]@{ id = 'bad'; reports = @() })"
        )

        $command = @"
. $(ConvertTo-Issue748PsLiteral $InvokeAoPath)
function Test-WorkerStatusKillSwitchActive { return $KillSwitch }
function Test-WorkerStatusSiblingReadiness { return $Readiness }
function Resolve-WorkerReportStoreRepoSlug { param([string]`$RepoSlug) return 'owner/repo' }
function Get-WorkerStatusWriterGenerationVector { param([string]`$SessionId,[long]`$RepoTickGeneration,`$GithubSnapshot) return @{ writerSessionId=`$SessionId; repoTickGeneration=`$RepoTickGeneration; reportStoreGeneration=1; journalCursor=1; bindingCacheGeneration=1 } }
function Get-WorkerOsLivenessMap { param([object[]]`$Sessions) return @{} }
function Invoke-WorkerStatusStoreEviction { param([object[]]`$Sessions,[string]`$StorePath,[long]`$NowMs) return @{ removed = 0; recordCount = @(`$Sessions).Count } }
function Write-WorkerStatusRow { param([Alias('Input')][hashtable]`$WriteInput,[hashtable]`$RecomputeInput,[string]`$StorePath,[long]`$NowMs)
$WriteBody
}
`$sessions = $Sessions
`$snapshot = @{ openPrs=@(); reviewRuns=@(); ciChecksByPr=@{}; requiredCheckNamesByPr=@{}; requiredCheckLookupFailedByPr=@{}; degraded=`$false }
`$diagnostic = Invoke-WorkerStatusRefresh -Sessions `$sessions -GithubSnapshot `$snapshot -Owner 'test-owner' -NowMs 1700000000000
`$diagnostic | ConvertTo-Json -Compress -Depth 10
"@
        return ConvertFrom-Issue748LastJson -Output (Invoke-Issue748PwshCommand -Command $command)
    }

    function New-Issue748TempDirectory {
        $path = Join-Path ([System.IO.Path]::GetTempPath()) ("opk-748-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        return $path
    }

    function New-Issue748Watch {
        param(
            [int]$PrNumber = 748,
            [string]$HeadSha = 'oldhead748',
            [string]$SessionId = 'opk-748'
        )

        return [ordered]@{
            prNumber           = $PrNumber
            headSha            = $HeadSha
            sessionId          = $SessionId
            seedMs             = 1700000000000
            windowExpiresMs    = 1700000300000
            seedSource         = 'wake_defer'
            deferReason        = 'uncovered_not_ready'
            deferPrimary       = 'no_ready_for_review'
            pollClass          = 'scoped_deferred_head_watch'
            lastObservedReadyMs = $null
            lastEvaluatedMs    = 1700000000000
            status             = 'watching'
        }
    }

    function Set-Issue748WatchState {
        param(
            [string]$Path,
            [hashtable]$Entries
        )

        [ordered]@{
            watchEntries       = $Entries
            terminalTombstones = @{}
            lastUpdatedMs      = 1
        } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding utf8
    }

    function Start-Issue748PwshScript {
        param([string]$ScriptPath)

        $pwshPath = (Get-Command pwsh -ErrorAction Stop).Source
        return Start-Process -FilePath $pwshPath -ArgumentList @(
            '-NoProfile', '-NonInteractive', '-File', $ScriptPath
        ) -PassThru
    }
}

Describe 'Issue #748 diagnosis and ownership contract' {
    It 'records an honest diagnosis artifact before implementation' {
        $artifactPath = Join-Path $RepoRoot 'tests/fixtures/worker-status/diagnosis-artifact-gate.json'
        $artifact = Get-Content -LiteralPath $artifactPath -Raw | ConvertFrom-Json

        $artifact.issueNumber | Should -Be 748
        $artifact.sanitized | Should -BeTrue
        $artifact.observations.writeResult.reasonCode | Should -Be 'silent_write_outcome'
        $artifact.conclusion.writeDefectReproduced | Should -BeFalse
        $artifact.conclusion.observabilityDefectReproduced | Should -BeTrue
    }

    It 'keeps decision readers pure and has one production refresh owner' {
        $reader = Get-Content -LiteralPath (Join-Path $RepoRoot 'scripts/lib/Get-WorkerStatusDecisionSessions.ps1') -Raw
        $core = ($reader -split 'function Get-WorkerStatusDecisionSessionsCore', 2)[1]
        $core = ($core -split 'function Get-WorkerStatusReadOnlyProjection', 2)[0]
        $core | Should -Not -Match 'Write-WorkerStatusRow'
        $core | Should -Not -Match 'Invoke-WorkerStatusStoreEviction'

        $owner = Get-Content -LiteralPath $ReviewReadyEntrypoint -Raw
        @([regex]::Matches($owner, 'Invoke-WorkerStatusRefresh\s+@refreshParams')).Count | Should -Be 1
        $owner | Should -Match "Owner\s+=\s+'review-ready-report-state-seed'"

        $deadWorker = Get-Content -LiteralPath (Join-Path $RepoRoot 'scripts/dead-worker-reconcile.ps1') -Raw
        $deadWorker | Should -Not -Match 'Invoke-WorkerStatusRefresh'
        $deadWorker | Should -Not -Match 'Write-WorkerStatusRow'
    }

    It 'uses bounded and redacted aggregate diagnostics' {
        $reader = Get-Content -LiteralPath (Join-Path $RepoRoot 'scripts/lib/Get-WorkerStatusDecisionSessions.ps1') -Raw
        $reader | Should -Match '\$Script:WorkerStatusRefreshDetailLimit = 8'
        $reader | Should -Match 'ConvertTo-WorkerStatusRefreshSafeToken'
        $refresh = ($reader -split 'function Invoke-WorkerStatusRefresh', 2)[1]
        $refresh = ($refresh -split 'function New-WorkerStatusDecisionUnknownRows', 2)[0]
        $refresh | Should -Not -Match 'Exception\.Message'
        $refresh | Should -Not -Match 'Out-String'
    }
}

Describe 'Issue #748 worker-status refresh matrix' {
    It 'W1 populates a non-empty store through the real seed entrypoint' {
        $dir = New-Issue748TempDirectory
        try {
            $storePath = Join-Path $dir 'worker-status-store.json'
            $fixturePath = Join-Path $dir 'fixture.json'
            $fixture = [ordered]@{
                nowMs = 1700000000000
                reviewCommand = 'echo'
                workerStatusRefresh = @{ storePath = $storePath }
                openPrs = @([ordered]@{
                    number = 748
                    state = 'OPEN'
                    headRefOid = 'head748'
                    headCommittedAt = '2023-11-14T00:00:00Z'
                })
                reviewRuns = @()
                sessions = @([ordered]@{
                    id = 'opk-748'
                    sessionId = 'opk-748'
                    name = 'opk-748'
                    role = 'worker'
                    project = 'orchestrator-pack'
                    status = 'working'
                    activity = 'working'
                    prNumber = 748
                    ownedHeadSha = 'head748'
                    reports = @([ordered]@{
                        accepted = $true
                        reportState = 'ready_for_review'
                        headSha = 'head748'
                        reportedAt = '2023-11-14T00:00:10Z'
                        prNumber = 748
                    })
                })
                ciChecksByPr = @{ '748' = @([ordered]@{ name = 'scope-guard'; status = 'completed'; conclusion = 'success' }) }
                requiredCheckNamesByPr = @{ '748' = @('scope-guard') }
                requiredCheckLookupFailedByPr = @{ '748' = $false }
                bindingByKey = @{}
                seededKeys = @()
                deferredScanKeys = @()
                handoffRecords = @{}
                terminalClaimKeys = @()
                watchEntries = @{}
            }
            $fixture | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $fixturePath -Encoding utf8

            $output = Invoke-Issue748PwshFile -Path $ReviewReadyEntrypoint -Arguments @(
                '-FixturePath', $fixturePath, '-StateDir', $dir, '-Once', '-DryRun'
            )
            ($output -join "`n") | Should -Match 'worker-status-refresh:'
            ($output -join "`n") | Should -Match 'candidates=1'
            $store = Get-Content -LiteralPath $storePath -Raw | ConvertFrom-Json
            @($store.records.PSObject.Properties.Name) | Should -Contain 'opk-748' -Because (($output -join "`n") + "`nstore=" + ($store | ConvertTo-Json -Compress -Depth 20))
            $row = $store.records.'opk-748'
            $row.derivedStatus | Should -Be 'ready_for_review'
            $row.derivedStatus | Should -Not -BeIn @('unknown', 'stale')
        }
        finally {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'W2 distinguishes a kill-switch closed gate' {
        $diagnostic = Invoke-Issue748DiagnosticScenario -WriteBody "throw 'writer_must_not_run'" -KillSwitch '$true'
        $diagnostic.outcome | Should -Be 'gate_closed'
        $diagnostic.reasonCode | Should -Be 'kill_switch_active'
        $diagnostic.writeAttemptCount | Should -Be 0
        $diagnostic.gateClosedCount | Should -Be 2
    }

    It 'W3 reports the exact missing-sibling gate reason' {
        $diagnostic = Invoke-Issue748DiagnosticScenario `
            -WriteBody "throw 'writer_must_not_run'" `
            -Readiness '@{ ok = $false; workerReportStorePresent = $false; sessionPrBindingResolverPresent = $true }'
        $diagnostic.outcome | Should -Be 'gate_closed'
        $diagnostic.reasonCode | Should -Be 'worker_report_store_missing'
        $diagnostic.writeAttemptCount | Should -Be 0
    }

    It 'W4 aggregates a success and a missing writer result as a partial failure' {
        $diagnostic = Invoke-Issue748DiagnosticScenario `
            -WriteBody "if (`$WriteInput.session.id -eq 'bad') { return `$null }; return @{ ok=`$true }"
        $diagnostic.outcome | Should -Be 'partial_failure'
        $diagnostic.successCount | Should -Be 1 -Because ($diagnostic | ConvertTo-Json -Compress -Depth 20)
        $diagnostic.failureCount | Should -Be 1
        $bad = @($diagnostic.details | Where-Object { $_.sessionId -eq 'bad' })[0]
        $bad.reasonCode | Should -Be 'write_rejected'
    }

    It 'W5 isolates a thrown write and redacts exception text' {
        $diagnostic = Invoke-Issue748DiagnosticScenario `
            -WriteBody "if (`$WriteInput.session.id -eq 'bad') { throw 'super-secret-path-and-command' }; return @{ ok=`$true }"
        $diagnostic.outcome | Should -Be 'partial_failure'
        $diagnostic.successCount | Should -Be 1 -Because ($diagnostic | ConvertTo-Json -Compress -Depth 20)
        $diagnostic.exceptionCount | Should -Be 1
        ($diagnostic | ConvertTo-Json -Compress -Depth 20) | Should -Not -Match 'super-secret'
        $bad = @($diagnostic.details | Where-Object { $_.sessionId -eq 'bad' })[0]
        $bad.reasonCode | Should -Be 'write_exception'
    }

    It 'W6 distinguishes an empty fleet from a closed gate' {
        $diagnostic = Invoke-Issue748DiagnosticScenario -WriteBody 'return @{ ok=$true }' -Sessions '@()'
        $diagnostic.outcome | Should -Be 'empty_fleet'
        $diagnostic.reasonCode | Should -Be 'no_live_sessions'
        $diagnostic.gateClosedCount | Should -Be 0
        $diagnostic.writeAttemptCount | Should -Be 0
    }
}

Describe 'Issue #748 reeval-watch lifecycle' {
    It 'uses one serialized mutation with explicit removals and generation tombstones' {
        $helper = Get-Content -LiteralPath $WatchHelperPath -Raw
        $mutation = ($helper -split 'function Update-ReviewTriggerReevalWatchStateMutation', 2)[1]
        $mutation = ($mutation -split 'function Update-ReviewTriggerReevalWatchStateMerged', 2)[0]
        $mutation | Should -Match 'Invoke-ReviewTriggerReevalWatchStateLocked'
        $mutation | Should -Match 'RemoveWatchKeys'
        $mutation | Should -Match '\$next\.Remove\(\$normalizedKey\)'
        $mutation | Should -Match 'terminalTombstones'
        $mutation | Should -Match 'suppressedIncomingWatchKeys'
        $mutation | Should -Match 'Set-ReviewTriggerReevalWatchState'
    }

    It 'evicts a terminal watch through the real reeval entrypoint' {
        $dir = New-Issue748TempDirectory
        try {
            $watchPath = Join-Path $dir 'review-trigger-reeval-watch.json'
            $key = '748:oldhead748'
            $entries = @{}
            $entries[$key] = New-Issue748Watch
            Set-Issue748WatchState -Path $watchPath -Entries $entries
            $fixturePath = Join-Path $dir 'terminal.json'
            [ordered]@{
                nowMs = 1700000010000
                reviewCommand = 'echo'
                prSnapshotAuthoritative = $true
                openPrs = @()
                reviewRuns = @()
                sessions = @()
                watchEntries = $entries
                ciChecksByPr = @{}
                requiredCheckNamesByPr = @{}
                requiredCheckLookupFailedByPr = @{}
            } | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $fixturePath -Encoding utf8

            $output = Invoke-Issue748PwshFile -Path $ReevalEntrypoint -Arguments @(
                '-FixturePath', $fixturePath, '-StateDir', $dir, '-Once'
            )
            ($output -join "`n") | Should -Match 'terminalEvicted=1'
            $state = Get-Content -LiteralPath $watchPath -Raw | ConvertFrom-Json
            @($state.watchEntries.PSObject.Properties.Name) | Should -Not -Contain $key
            @($state.terminalTombstones.PSObject.Properties.Name) | Should -Contain $key
        }
        finally {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'retains a watch when PR state is unknown' {
        $dir = New-Issue748TempDirectory
        try {
            $watchPath = Join-Path $dir 'review-trigger-reeval-watch.json'
            $key = '748:oldhead748'
            $entries = @{}
            $entries[$key] = New-Issue748Watch
            Set-Issue748WatchState -Path $watchPath -Entries $entries
            $fixturePath = Join-Path $dir 'unknown.json'
            [ordered]@{
                nowMs = 1700000010000
                reviewCommand = 'echo'
                prSnapshotAuthoritative = $false
                openPrs = @()
                reviewRuns = @()
                sessions = @()
                watchEntries = $entries
                ciChecksByPr = @{}
                requiredCheckNamesByPr = @{}
                requiredCheckLookupFailedByPr = @{}
            } | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $fixturePath -Encoding utf8

            $output = Invoke-Issue748PwshFile -Path $ReevalEntrypoint -Arguments @(
                '-FixturePath', $fixturePath, '-StateDir', $dir, '-Once'
            )
            ($output -join "`n") | Should -Match 'unknownRetained=1'
            $state = Get-Content -LiteralPath $watchPath -Raw | ConvertFrom-Json
            @($state.watchEntries.PSObject.Properties.Name) | Should -Contain $key
            $state.watchEntries.$key.status | Should -Be 'watching'
        }
        finally {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'preserves a different newly-recorded watch during concurrent eviction' {
        $dir = New-Issue748TempDirectory
        try {
            $watchPath = Join-Path $dir 'review-trigger-reeval-watch.json'
            $oldKey = '748:oldhead748'
            $newKey = '749:newhead749'
            $entries = @{}
            $entries[$oldKey] = New-Issue748Watch
            Set-Issue748WatchState -Path $watchPath -Entries $entries

            $newWatchJson = (New-Issue748Watch -PrNumber 749 -HeadSha 'newhead749' -SessionId 'opk-749' | ConvertTo-Json -Compress -Depth 20)
            $addScript = Join-Path $dir 'add.ps1'
            $evictScript = Join-Path $dir 'evict.ps1'
            @"
. $(ConvertTo-Issue748PsLiteral $WatchHelperPath)
`$incoming = @{}
`$incoming[$(ConvertTo-Issue748PsLiteral $newKey)] = ($(ConvertTo-Issue748PsLiteral $newWatchJson) | ConvertFrom-Json)
Update-ReviewTriggerReevalWatchStateMerged -Path $(ConvertTo-Issue748PsLiteral $watchPath) -IncomingWatchEntries `$incoming -NowMs 1700000010000 | Out-Null
"@ | Set-Content -LiteralPath $addScript -Encoding utf8
            @"
. $(ConvertTo-Issue748PsLiteral $WatchHelperPath)
Update-ReviewTriggerReevalWatchStateMutation -Path $(ConvertTo-Issue748PsLiteral $watchPath) -IncomingWatchEntries @{} -RemoveWatchKeys @($(ConvertTo-Issue748PsLiteral $oldKey)) -NowMs 1700000010000 | Out-Null
"@ | Set-Content -LiteralPath $evictScript -Encoding utf8

            $addProcess = Start-Issue748PwshScript -ScriptPath $addScript
            $evictProcess = Start-Issue748PwshScript -ScriptPath $evictScript
            $addProcess.WaitForExit()
            $evictProcess.WaitForExit()
            $addProcess.ExitCode | Should -Be 0
            $evictProcess.ExitCode | Should -Be 0

            $state = Get-Content -LiteralPath $watchPath -Raw | ConvertFrom-Json
            @($state.watchEntries.PSObject.Properties.Name) | Should -Not -Contain $oldKey
            @($state.watchEntries.PSObject.Properties.Name) | Should -Contain $newKey
            @($state.terminalTombstones.PSObject.Properties.Name) | Should -Contain $oldKey
            @(Get-ChildItem -LiteralPath $dir -File -Filter '*.corrupt-*' -ErrorAction SilentlyContinue).Count | Should -Be 0
        }
        finally {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'prevents stale same-key resurrection in either race order' {
        $dir = New-Issue748TempDirectory
        try {
            $watchPath = Join-Path $dir 'review-trigger-reeval-watch.json'
            $key = '748:oldhead748'
            $entries = @{}
            $entries[$key] = New-Issue748Watch
            Set-Issue748WatchState -Path $watchPath -Entries $entries

            $watchJson = (New-Issue748Watch | ConvertTo-Json -Compress -Depth 20)
            $recordScript = Join-Path $dir 'record.ps1'
            $terminalScript = Join-Path $dir 'terminal.ps1'
            @"
. $(ConvertTo-Issue748PsLiteral $WatchHelperPath)
`$incoming = @{}
`$incoming[$(ConvertTo-Issue748PsLiteral $key)] = ($(ConvertTo-Issue748PsLiteral $watchJson) | ConvertFrom-Json)
Update-ReviewTriggerReevalWatchStateMerged -Path $(ConvertTo-Issue748PsLiteral $watchPath) -IncomingWatchEntries `$incoming -NowMs 1700000010000 | Out-Null
"@ | Set-Content -LiteralPath $recordScript -Encoding utf8
            @"
. $(ConvertTo-Issue748PsLiteral $WatchHelperPath)
Update-ReviewTriggerReevalWatchStateMutation -Path $(ConvertTo-Issue748PsLiteral $watchPath) -IncomingWatchEntries @{} -RemoveWatchKeys @($(ConvertTo-Issue748PsLiteral $key)) -NowMs 1700000010000 | Out-Null
"@ | Set-Content -LiteralPath $terminalScript -Encoding utf8

            $recordProcess = Start-Issue748PwshScript -ScriptPath $recordScript
            $terminalProcess = Start-Issue748PwshScript -ScriptPath $terminalScript
            $recordProcess.WaitForExit()
            $terminalProcess.WaitForExit()
            $recordProcess.ExitCode | Should -Be 0
            $terminalProcess.ExitCode | Should -Be 0

            $state = Get-Content -LiteralPath $watchPath -Raw | ConvertFrom-Json
            @($state.watchEntries.PSObject.Properties.Name) | Should -Not -Contain $key
            $state.terminalTombstones.$key.observedAtMs | Should -Be 1700000010000
            @(Get-ChildItem -LiteralPath $dir -File -Filter '*.corrupt-*' -ErrorAction SilentlyContinue).Count | Should -Be 0
        }
        finally {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'keeps a terminal tombstone authoritative over a later-stamped same-key record' {
        . $InvokeAoPath
        . $WatchHelperPath
        $dir = New-Issue748TempDirectory
        try {
            $watchPath = Join-Path $dir 'review-trigger-reeval-watch.json'
            $key = '748:oldhead748'
            $entries = @{}
            $entries[$key] = New-Issue748Watch
            Set-Issue748WatchState -Path $watchPath -Entries $entries

            $terminal = Update-ReviewTriggerReevalWatchStateMutation -Path $watchPath `
                -IncomingWatchEntries @{} -RemoveWatchKeys @($key) -NowMs 1700000010000
            @($terminal.terminalizedWatchKeys) | Should -Contain $key

            $laterWatch = New-Issue748Watch
            $laterWatch.seedMs = 1700000015000
            $incoming = @{}
            $incoming[$key] = $laterWatch
            $record = Update-ReviewTriggerReevalWatchStateMerged -Path $watchPath `
                -IncomingWatchEntries $incoming -NowMs 1700000015000

            @($record.suppressedIncomingWatchKeys) | Should -Contain $key
            $state = Get-Content -LiteralPath $watchPath -Raw | ConvertFrom-Json
            @($state.watchEntries.PSObject.Properties.Name) | Should -Not -Contain $key
            @($state.terminalTombstones.PSObject.Properties.Name) | Should -Contain $key
        }
        finally {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'bounds pre-existing corrupt watch artifacts to the newest three' {
        $dir = New-Issue748TempDirectory
        try {
            $watchPath = Join-Path $dir 'review-trigger-reeval-watch.json'
            Set-Issue748WatchState -Path $watchPath -Entries @{}
            0..6 | ForEach-Object {
                Set-Content -LiteralPath ("$watchPath.corrupt-{0:d3}" -f $_) -Value '{broken' -Encoding utf8
            }
            $command = @"
. $(ConvertTo-Issue748PsLiteral $WatchHelperPath)
`$result = Update-ReviewTriggerReevalWatchStateMutation -Path $(ConvertTo-Issue748PsLiteral $watchPath) -IncomingWatchEntries @{} -RemoveWatchKeys @() -NowMs 1700000010000
`$result | ConvertTo-Json -Compress -Depth 8
"@
            $result = ConvertFrom-Issue748LastJson -Output (Invoke-Issue748PwshCommand -Command $command)
            $result.corruptRemoved | Should -BeGreaterOrEqual 4
            @(Get-ChildItem -LiteralPath $dir -File -Filter '*.corrupt-*' -ErrorAction SilentlyContinue).Count | Should -BeLessOrEqual 3
            { Get-Content -LiteralPath $watchPath -Raw | ConvertFrom-Json | Out-Null } | Should -Not -Throw
        }
        finally {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Describe 'Issue #748 PowerShell syntax gate' {
    It 'parses every changed PowerShell entrypoint and helper without errors' {
        $files = @(
            'scripts/lib/Get-WorkerStatusDecisionSessions.ps1',
            'scripts/lib/Record-ReviewTriggerReevalWatch.ps1',
            'scripts/lib/Review-TriggerReeval-Common.ps1',
            'scripts/lib/Review-ReadySeedFixturePayload.ps1',
            'scripts/review-ready-report-state-seed.ps1',
            'scripts/review-trigger-reeval.ps1'
        )
        $failures = @()
        foreach ($relativePath in $files) {
            $path = Join-Path $RepoRoot $relativePath
            $tokens = $null
            $errors = $null
            [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
            if (@($errors).Count -gt 0) {
                $failures += [pscustomobject]@{
                    path = $relativePath
                    errors = @($errors | ForEach-Object { $_.Message })
                }
            }
        }
        $failures | Should -BeNullOrEmpty
    }
}
