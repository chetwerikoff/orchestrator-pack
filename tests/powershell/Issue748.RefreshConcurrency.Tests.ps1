#requires -Version 5.1

BeforeAll {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $InvokeAoPath = Join-Path $RepoRoot 'scripts/lib/Invoke-AoCliJson.ps1'
    $SeedEntrypoint = Join-Path $RepoRoot 'scripts/review-ready-report-state-seed.ps1'

    function New-Issue748ConcurrencyTempDirectory {
        $path = Join-Path ([System.IO.Path]::GetTempPath()) ("opk-748-concurrency-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        return $path
    }

    function ConvertTo-Issue748ConcurrencyLiteral {
        param([string]$Value)
        return "'" + $Value.Replace("'", "''") + "'"
    }

    function New-Issue748ConcurrencySession {
        param(
            [string]$SessionId,
            [int]$PrNumber,
            [string]$HeadSha
        )

        return [ordered]@{
            id           = $SessionId
            sessionId    = $SessionId
            name         = $SessionId
            role         = 'worker'
            project      = 'orchestrator-pack'
            status       = 'working'
            activity     = 'working'
            prNumber     = $PrNumber
            ownedHeadSha = $HeadSha
            reports      = @()
        }
    }

    function New-Issue748RefreshRaceScript {
        param(
            [string]$Path,
            [string]$StorePath,
            [string]$ReadyPath,
            [string]$StartPath,
            [string]$DiagnosticPath,
            [string]$Owner,
            [object[]]$Sessions,
            [long]$NowMs = 1700000500000
        )

        $sessionsJson = @($Sessions) | ConvertTo-Json -Compress -Depth 20
        @"
#requires -Version 5.1
`$ErrorActionPreference = 'Stop'
. $(ConvertTo-Issue748ConcurrencyLiteral $InvokeAoPath)
function Invoke-WorkerStatusStoreEviction { param([object[]]`$Sessions,[string]`$StorePath,[long]`$NowMs) return @{ removed = 0; recordCount = @(`$Sessions).Count } }
`$sessions = @($(ConvertTo-Issue748ConcurrencyLiteral $sessionsJson) | ConvertFrom-Json)
`$snapshot = @{ openPrs=@(); reviewRuns=@(); ciChecksByPr=@{}; requiredCheckNamesByPr=@{}; requiredCheckLookupFailedByPr=@{}; degraded=`$false; repoRoot=$(ConvertTo-Issue748ConcurrencyLiteral $RepoRoot) }
Set-Content -LiteralPath $(ConvertTo-Issue748ConcurrencyLiteral $ReadyPath) -Value 'ready' -Encoding utf8
`$deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 10000
while (-not (Test-Path -LiteralPath $(ConvertTo-Issue748ConcurrencyLiteral $StartPath))) {
    if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt `$deadline) { throw 'race start timeout' }
    Start-Sleep -Milliseconds 10
}
`$diagnostic = Invoke-WorkerStatusRefresh -Sessions `$sessions -GithubSnapshot `$snapshot -RepoSlug 'owner/repo' -StorePath $(ConvertTo-Issue748ConcurrencyLiteral $StorePath) -Owner $(ConvertTo-Issue748ConcurrencyLiteral $Owner) -NowMs $NowMs -RepoTickGeneration 1
`$diagnostic | ConvertTo-Json -Compress -Depth 20 | Set-Content -LiteralPath $(ConvertTo-Issue748ConcurrencyLiteral $DiagnosticPath) -Encoding utf8
if (`$diagnostic.outcome -ne 'success') { exit 7 }
"@ | Set-Content -LiteralPath $Path -Encoding utf8
    }

    function Invoke-Issue748RefreshRace {
        param(
            [object[]]$LeftSessions,
            [object[]]$RightSessions
        )

        $dir = New-Issue748ConcurrencyTempDirectory
        try {
            $storePath = Join-Path $dir 'worker-status-store.json'
            $startPath = Join-Path $dir 'start.signal'
            $leftReady = Join-Path $dir 'left.ready'
            $rightReady = Join-Path $dir 'right.ready'
            $leftDiagnostic = Join-Path $dir 'left.diagnostic.json'
            $rightDiagnostic = Join-Path $dir 'right.diagnostic.json'
            $leftScript = Join-Path $dir 'review-ready-report-state-seed-refresh.ps1'
            $rightScript = Join-Path $dir 'dead-worker-reconcile-refresh-fixture.ps1'

            New-Issue748RefreshRaceScript -Path $leftScript -StorePath $storePath -ReadyPath $leftReady `
                -StartPath $startPath -DiagnosticPath $leftDiagnostic -Owner 'review-ready-report-state-seed' `
                -Sessions $LeftSessions
            New-Issue748RefreshRaceScript -Path $rightScript -StorePath $storePath -ReadyPath $rightReady `
                -StartPath $startPath -DiagnosticPath $rightDiagnostic -Owner 'dead-worker-reconcile-fixture' `
                -Sessions $RightSessions

            $pwshPath = (Get-Command pwsh -ErrorAction Stop).Source
            $left = Start-Process -FilePath $pwshPath -ArgumentList @('-NoProfile','-NonInteractive','-File',$leftScript) -PassThru
            $right = Start-Process -FilePath $pwshPath -ArgumentList @('-NoProfile','-NonInteractive','-File',$rightScript) -PassThru
            $readyDeadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 10000
            while (-not ((Test-Path -LiteralPath $leftReady) -and (Test-Path -LiteralPath $rightReady))) {
                if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt $readyDeadline) {
                    throw 'race participants did not become ready'
                }
                Start-Sleep -Milliseconds 10
            }
            Set-Content -LiteralPath $startPath -Value 'start' -Encoding utf8
            $left.WaitForExit()
            $right.WaitForExit()

            $leftResult = if (Test-Path -LiteralPath $leftDiagnostic) {
                Get-Content -LiteralPath $leftDiagnostic -Raw | ConvertFrom-Json
            }
            else { $null }
            $rightResult = if (Test-Path -LiteralPath $rightDiagnostic) {
                Get-Content -LiteralPath $rightDiagnostic -Raw | ConvertFrom-Json
            }
            else { $null }
            $store = if (Test-Path -LiteralPath $storePath) {
                Get-Content -LiteralPath $storePath -Raw | ConvertFrom-Json
            }
            else { $null }
            return @{
                directory       = $dir
                leftExitCode    = $left.ExitCode
                rightExitCode   = $right.ExitCode
                leftDiagnostic  = $leftResult
                rightDiagnostic = $rightResult
                store           = $store
                corruptFiles    = @(Get-ChildItem -LiteralPath $dir -File -Filter '*.corrupt-*' -ErrorAction SilentlyContinue)
            }
        }
        catch {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
            throw
        }
    }
}

Describe 'Issue #748 canonical worker-status refresh matrix' {
    It 'W2 publishes the closed-gate reason in the operator progress surface' {
        $dir = New-Issue748ConcurrencyTempDirectory
        $oldProgressDir = $env:AO_SIDE_PROCESS_PROGRESS_DIR
        $oldKillSwitch = $env:PACK_WORKER_STATUS_STORE_DISABLED
        try {
            $progressDir = Join-Path $dir 'progress'
            New-Item -ItemType Directory -Path $progressDir -Force | Out-Null
            $storePath = Join-Path $dir 'worker-status-store.json'
            $fixturePath = Join-Path $dir 'fixture.json'
            [ordered]@{
                nowMs = 1700000500000
                reviewCommand = 'echo'
                workerStatusRefresh = @{ storePath = $storePath }
                openPrs = @()
                reviewRuns = @()
                sessions = @(New-Issue748ConcurrencySession -SessionId 'opk-748' -PrNumber 748 -HeadSha 'head748')
                ciChecksByPr = @{}
                requiredCheckNamesByPr = @{}
                requiredCheckLookupFailedByPr = @{}
                bindingByKey = @{}
                seededKeys = @()
                deferredScanKeys = @()
                handoffRecords = @{}
                terminalClaimKeys = @()
                watchEntries = @{}
            } | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $fixturePath -Encoding utf8

            $env:AO_SIDE_PROCESS_PROGRESS_DIR = $progressDir
            $env:PACK_WORKER_STATUS_STORE_DISABLED = '1'
            $output = @(& pwsh -NoProfile -NonInteractive -File $SeedEntrypoint `
                -FixturePath $fixturePath -StateDir $dir -Once 2>&1)
            $LASTEXITCODE | Should -Be 0 -Because ($output -join "`n")

            $progressPath = Join-Path $progressDir 'review-ready-report-state-seed.progress.json'
            $progress = Get-Content -LiteralPath $progressPath -Raw | ConvertFrom-Json
            $progress.workerStatusRefresh.outcome | Should -Be 'gate_closed'
            $progress.workerStatusRefresh.reasonCode | Should -Be 'kill_switch_active'
            $progress.workerStatusRefresh.sessionCount | Should -Be 1
            $progress.workerStatusRefresh.gateClosedCount | Should -Be 1
            $progress.workerStatusRefresh.writeAttemptCount | Should -Be 0
        }
        finally {
            $env:AO_SIDE_PROCESS_PROGRESS_DIR = $oldProgressDir
            $env:PACK_WORKER_STATUS_STORE_DISABLED = $oldKillSwitch
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'W3 surfaces one write exception without changing the existing row' {
        $dir = New-Issue748ConcurrencyTempDirectory
        try {
            $storePath = Join-Path $dir 'worker-status-store.json'
            $sentinel = [ordered]@{
                schemaVersion = 1
                lastUpdatedMs = 1700000000000
                generation = 1
                records = @{
                    'opk-748' = @{
                        sessionId = 'opk-748'
                        status = 'pr_open'
                        derivedStatus = 'pr_open'
                        lastUpdatedMs = 1700000000000
                        marker = 'unchanged'
                    }
                }
            }
            $sentinel | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $storePath -Encoding utf8
            $command = @"
. $(ConvertTo-Issue748ConcurrencyLiteral $InvokeAoPath)
function Test-WorkerStatusKillSwitchActive { return `$false }
function Test-WorkerStatusSiblingReadiness { return @{ ok=`$true; workerReportStorePresent=`$true; sessionPrBindingResolverPresent=`$true } }
function Resolve-WorkerReportStoreRepoSlug { param([string]`$RepoSlug) return 'owner/repo' }
function Get-WorkerStatusWriterGenerationVector { param([string]`$SessionId,[long]`$RepoTickGeneration,`$GithubSnapshot) return @{ writerSessionId=`$SessionId; repoTickGeneration=1; reportStoreGeneration=1; journalCursor=1; bindingCacheGeneration=1 } }
function Get-WorkerOsLivenessMap { param([object[]]`$Sessions) return @{} }
function Write-WorkerStatusRow { throw 'redacted-secret-exception' }
function Invoke-WorkerStatusStoreEviction { return @{ removed=0; recordCount=1 } }
`$session = [pscustomobject]@{ id='opk-748'; prNumber=748; ownedHeadSha='head748'; reports=@() }
`$diagnostic = Invoke-WorkerStatusRefresh -Sessions @(`$session) -GithubSnapshot @{ degraded=`$false } -StorePath $(ConvertTo-Issue748ConcurrencyLiteral $storePath) -NowMs 1700000500000
`$diagnostic | ConvertTo-Json -Compress -Depth 20
"@
            $output = @(& pwsh -NoProfile -NonInteractive -Command $command 2>&1)
            $LASTEXITCODE | Should -Be 0 -Because ($output -join "`n")
            $diagnostic = @($output | Where-Object { ([string]$_).Trim().StartsWith('{') })[-1] | ConvertFrom-Json
            $diagnostic.outcome | Should -Be 'partial_failure'
            $diagnostic.exceptionCount | Should -Be 1
            ($diagnostic | ConvertTo-Json -Compress -Depth 20) | Should -Not -Match 'redacted-secret'
            $store = Get-Content -LiteralPath $storePath -Raw | ConvertFrom-Json
            $store.records.'opk-748'.marker | Should -Be 'unchanged'
            $store.records.'opk-748'.status | Should -Be 'pr_open'
        }
        finally {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'W4 serializes overlapping same-session refreshes with success/success and one row' {
        $session = New-Issue748ConcurrencySession -SessionId 'opk-748' -PrNumber 748 -HeadSha 'head748'
        $race = Invoke-Issue748RefreshRace -LeftSessions @($session) -RightSessions @($session)
        try {
            $race.leftExitCode | Should -Be 0 -Because ($race.leftDiagnostic | ConvertTo-Json -Compress -Depth 20)
            $race.rightExitCode | Should -Be 0 -Because ($race.rightDiagnostic | ConvertTo-Json -Compress -Depth 20)
            $race.leftDiagnostic.outcome | Should -Be 'success'
            $race.rightDiagnostic.outcome | Should -Be 'success'
            $keys = @($race.store.records.PSObject.Properties.Name)
            $keys.Count | Should -Be 1
            $keys | Should -Contain 'opk-748'
            $race.corruptFiles.Count | Should -Be 0
        }
        finally {
            Remove-Item -LiteralPath $race.directory -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'W5 preserves both rows during overlapping cross-session refreshes' {
        $leftSession = New-Issue748ConcurrencySession -SessionId 'opk-748-a' -PrNumber 748 -HeadSha 'head748a'
        $rightSession = New-Issue748ConcurrencySession -SessionId 'opk-748-b' -PrNumber 749 -HeadSha 'head748b'
        $race = Invoke-Issue748RefreshRace -LeftSessions @($leftSession) -RightSessions @($rightSession)
        try {
            $race.leftExitCode | Should -Be 0 -Because ($race.leftDiagnostic | ConvertTo-Json -Compress -Depth 20)
            $race.rightExitCode | Should -Be 0 -Because ($race.rightDiagnostic | ConvertTo-Json -Compress -Depth 20)
            $race.leftDiagnostic.outcome | Should -Be 'success'
            $race.rightDiagnostic.outcome | Should -Be 'success'
            $keys = @($race.store.records.PSObject.Properties.Name | Sort-Object)
            $keys.Count | Should -Be 2
            $keys | Should -Contain 'opk-748-a'
            $keys | Should -Contain 'opk-748-b'
            $race.corruptFiles.Count | Should -Be 0
        }
        finally {
            Remove-Item -LiteralPath $race.directory -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'W7 keeps non-owner production reconcilers free of refresh calls' {
        $deadWorker = Get-Content -LiteralPath (Join-Path $RepoRoot 'scripts/dead-worker-reconcile.ps1') -Raw
        $reeval = Get-Content -LiteralPath (Join-Path $RepoRoot 'scripts/review-trigger-reeval.ps1') -Raw
        $deadWorker | Should -Not -Match 'Invoke-WorkerStatusRefresh'
        $reeval | Should -Not -Match 'Invoke-WorkerStatusRefresh'
    }
}
