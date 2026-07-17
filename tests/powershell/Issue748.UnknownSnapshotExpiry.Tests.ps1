#requires -Version 5.1

BeforeAll {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    . (Join-Path $RepoRoot 'scripts/lib/Review-TriggerReeval-Common.ps1')
    . (Join-Path $RepoRoot 'scripts/lib/Orchestrator-SideEffectFence.ps1')
    . (Join-Path $RepoRoot 'scripts/lib/WorkerStatusStore.ps1')
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
    It 'runs the shared binding resolver regression' {
        $output = @(& $Issue854NodePath $Issue854ScenarioPath 2>&1)
        $exitCode = $LASTEXITCODE
        $exitCode | Should -Be 0 -Because ($output -join "`n")
    }

    It 'Major-3: threads WriteInput.repoSlug through Write-WorkerStatusRow (non-checkout cwd, no env slug)' {
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("opk-854-bridge-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $stateDir = Join-Path $dir 'state-dir'
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
        $cachePath = Join-Path $dir 'authoritative-pr-session-binding-cache.json'
        $staleStateCachePath = Join-Path $stateDir 'pr-session-binding-cache.json'
        $storePath = Join-Path $dir 'worker-status-store.json'
        $repo = 'chetwerikoff/orchestrator-pack'
        $sessionId = 'orchestrator-pack-137'
        $prNumber = 887
        $unrelatedPr = 869
        $headSha = 'head887'
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $record = [ordered]@{
            schemaVersion = 1
            sessionId = $sessionId
            prNumber = $prNumber
            issueNumber = 874
            headSha = $headSha
            repoSlug = $repo
            source = 'push_register'
            lastUpdatedMs = $nowMs - 1000
            superseded = $false
        }
        $records = [ordered]@{}
        $records["$repo|session:$sessionId"] = $record
        $records["$repo|pr:$prNumber"] = $record
        $cache = [ordered]@{
            schemaVersion = 1
            lastUpdatedMs = $record.lastUpdatedMs
            generation = 45
            records = $records
        }
        [System.IO.File]::WriteAllText(
            $cachePath,
            (($cache | ConvertTo-Json -Compress -Depth 10) + "`n"),
            [System.Text.UTF8Encoding]::new($false)
        )
        $staleRecord = [ordered]@{
            schemaVersion = 1
            sessionId = 'orchestrator-pack-999'
            prNumber = 999
            issueNumber = 999
            headSha = 'stalehead'
            repoSlug = $repo
            source = 'push_register'
            lastUpdatedMs = $nowMs - 1000
            superseded = $false
        }
        $staleRecords = [ordered]@{}
        $staleRecords["$repo|session:orchestrator-pack-999"] = $staleRecord
        $staleRecords["$repo|pr:999"] = $staleRecord
        [System.IO.File]::WriteAllText(
            $staleStateCachePath,
            (([ordered]@{
                schemaVersion = 1
                lastUpdatedMs = $staleRecord.lastUpdatedMs
                generation = 1
                records = $staleRecords
            } | ConvertTo-Json -Compress -Depth 10) + "`n"),
            [System.Text.UTF8Encoding]::new($false)
        )

        $oldBindingCache = $env:AO_PR_SESSION_BINDING_CACHE
        $oldStateDir = $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR
        $oldSideEffectDir = $env:AO_SIDE_PROCESS_STATE_DIR
        $oldGithubRepository = $env:GITHUB_REPOSITORY
        $oldAoRepoSlug = $env:AO_REPO_SLUG
        $oldLocation = Get-Location
        try {
            $env:AO_PR_SESSION_BINDING_CACHE = $cachePath
            $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR = $stateDir
            $env:AO_SIDE_PROCESS_STATE_DIR = $dir
            Remove-Item Env:GITHUB_REPOSITORY -ErrorAction SilentlyContinue
            Remove-Item Env:AO_REPO_SLUG -ErrorAction SilentlyContinue
            Set-Location $env:TEMP

            $openPrs = @(
                @{
                    number = $unrelatedPr
                    state = 'OPEN'
                    headRefOid = 'head869'
                    headRefName = 'agent/issue-862-review-delivery-outcome'
                },
                @{
                    number = $prNumber
                    state = 'OPEN'
                    headRefOid = $headSha
                    headRefName = "ao/$sessionId/root"
                }
            )
            $result = Write-WorkerStatusRow -WriteInput @{
                repoSlug = $repo
                session = [pscustomobject]@{
                    id = $sessionId
                    sessionId = $sessionId
                    role = 'worker'
                    status = 'working'
                    issueId = 874
                    displayName = '874'
                    branch = "ao/$sessionId/root"
                }
                reports = @()
                githubSnapshot = @{
                    openPrs = @(
                        [pscustomobject]@{
                            number = $unrelatedPr
                            state = 'OPEN'
                            headRefOid = 'head869'
                            headRefName = 'agent/issue-862-review-delivery-outcome'
                        },
                        [pscustomobject]@{
                            number = $prNumber
                            state = 'OPEN'
                            headRefOid = $headSha
                            headRefName = "ao/$sessionId/root"
                        }
                    )
                    reviewRuns = @()
                    ciChecksByPr = @{ "$prNumber" = @() }
                    requiredCheckNamesByPr = @{ "$prNumber" = @() }
                    requiredCheckLookupFailedByPr = @{ "$prNumber" = $false }
                    degraded = $false
                }
                osLiveness = @{ status = 'working'; dead = $false }
                writerGenerationVector = @{
                    writerSessionId = 'issue-854-pester'
                    repoTickGeneration = 10
                    reportStoreGeneration = 20
                    journalCursor = 30
                    bindingCacheGeneration = 0
                }
            } -StorePath $storePath -NowMs $nowMs

            $result.ok | Should -BeTrue -Because ($result | ConvertTo-Json -Compress -Depth 20)
            $result.row.sessionId | Should -Be $sessionId
            $result.row.repoSlug | Should -Be $repo
            $result.row.derivedStatus | Should -Be 'pr_open'
            $result.row.winningSource | Should -Be 'github_pr'
            [long]$result.row.generationVector.bindingCacheGeneration | Should -Be 45
            [long]$result.row.sourceGeneration.bindingCacheGeneration | Should -Be 45

            $stored = Get-Content -LiteralPath $storePath -Raw -Encoding UTF8 | ConvertFrom-Json
            $stored.records.$sessionId.derivedStatus | Should -Be 'pr_open'
            $stored.records.$sessionId.winningSource | Should -Be 'github_pr'
        }
        finally {
            Set-Location $oldLocation
            if ($null -eq $oldBindingCache) { Remove-Item Env:AO_PR_SESSION_BINDING_CACHE -ErrorAction SilentlyContinue }
            else { $env:AO_PR_SESSION_BINDING_CACHE = $oldBindingCache }
            if ($null -eq $oldStateDir) { Remove-Item Env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR -ErrorAction SilentlyContinue }
            else { $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR = $oldStateDir }
            if ($null -eq $oldSideEffectDir) { Remove-Item Env:AO_SIDE_PROCESS_STATE_DIR -ErrorAction SilentlyContinue }
            else { $env:AO_SIDE_PROCESS_STATE_DIR = $oldSideEffectDir }
            if ($null -eq $oldGithubRepository) { Remove-Item Env:GITHUB_REPOSITORY -ErrorAction SilentlyContinue }
            else { $env:GITHUB_REPOSITORY = $oldGithubRepository }
            if ($null -eq $oldAoRepoSlug) { Remove-Item Env:AO_REPO_SLUG -ErrorAction SilentlyContinue }
            else { $env:AO_REPO_SLUG = $oldAoRepoSlug }
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'Get-WorkerStatusWriterGenerationVector seeds bindingCacheGeneration from cache only' {
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("opk-854-genvec-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $stateDir = Join-Path $dir 'state-dir'
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
        $cachePath = Join-Path $dir 'authoritative-pr-session-binding-cache.json'
        $storePath = Join-Path $dir 'worker-status-store.json'
        $repo = 'chetwerikoff/orchestrator-pack'
        $sessionId = 'orchestrator-pack-137'
        $prNumber = 887
        $headSha = 'head887'
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $githubSnapshot = @{
            openPrs = @(
                [pscustomobject]@{
                    number = $prNumber
                    state = 'OPEN'
                    headRefOid = $headSha
                    headRefName = "ao/$sessionId/root"
                    headCommittedAt = '2025-01-15T12:00:00Z'
                }
            )
            reviewRuns = @()
            ciChecksByPr = @{ "$prNumber" = @() }
            requiredCheckNamesByPr = @{ "$prNumber" = @() }
            requiredCheckLookupFailedByPr = @{ "$prNumber" = $false }
            degraded = $false
        }

        $oldBindingCache = $env:AO_PR_SESSION_BINDING_CACHE
        $oldStateDir = $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR
        $oldSideEffectDir = $env:AO_SIDE_PROCESS_STATE_DIR
        try {
            $env:AO_PR_SESSION_BINDING_CACHE = $cachePath
            $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR = $stateDir
            $env:AO_SIDE_PROCESS_STATE_DIR = $dir

            $missVector = Get-WorkerStatusWriterGenerationVector -SessionId $sessionId -RepoTickGeneration 10 -GithubSnapshot $githubSnapshot
            [long]$missVector.bindingCacheGeneration | Should -Be 0

            $miss = Write-WorkerStatusRow -WriteInput @{
                repoSlug = $repo
                session = [pscustomobject]@{
                    id = $sessionId
                    sessionId = $sessionId
                    role = 'worker'
                    status = 'working'
                    issueId = 874
                    displayName = '874'
                    branch = "ao/$sessionId/root"
                }
                reports = @()
                githubSnapshot = $githubSnapshot
                osLiveness = @{ status = 'working'; dead = $false }
                writerGenerationVector = $missVector
            } -StorePath $storePath -NowMs $nowMs
            $miss.ok | Should -BeTrue
            $miss.row.winningSource | Should -Be 'github_pr'
            $miss.row.derivedStatus | Should -Be 'pr_open'
            [long]$miss.row.generationVector.bindingCacheGeneration | Should -Be 0

            $record = [ordered]@{
                schemaVersion = 1
                sessionId = $sessionId
                prNumber = $prNumber
                issueNumber = 874
                headSha = $headSha
                repoSlug = $repo
                source = 'push_register'
                lastUpdatedMs = $nowMs - 1000
                superseded = $false
            }
            $records = [ordered]@{}
            $records["$repo|session:$sessionId"] = $record
            $records["$repo|pr:$prNumber"] = $record
            [System.IO.File]::WriteAllText(
                $cachePath,
                (([ordered]@{
                    schemaVersion = 1
                    lastUpdatedMs = $record.lastUpdatedMs
                    generation = 48
                    records = $records
                } | ConvertTo-Json -Compress -Depth 10) + "`n"),
                [System.Text.UTF8Encoding]::new($false)
            )

            $hitVector = Get-WorkerStatusWriterGenerationVector -SessionId $sessionId -RepoTickGeneration 10 -GithubSnapshot $githubSnapshot
            [long]$hitVector.bindingCacheGeneration | Should -Be 48

            $hit = Write-WorkerStatusRow -WriteInput @{
                repoSlug = $repo
                session = [pscustomobject]@{
                    id = $sessionId
                    sessionId = $sessionId
                    role = 'worker'
                    status = 'working'
                    issueId = 874
                    displayName = '874'
                    branch = "ao/$sessionId/root"
                }
                reports = @()
                githubSnapshot = $githubSnapshot
                osLiveness = @{ status = 'working'; dead = $false }
                writerGenerationVector = $hitVector
            } -StorePath $storePath -NowMs ($nowMs + 1)
            $hit.ok | Should -BeTrue
            $hit.row.winningSource | Should -Be 'github_pr'
            $hit.row.derivedStatus | Should -Be 'pr_open'
            [long]$hit.row.generationVector.bindingCacheGeneration | Should -Be 48
        }
        finally {
            if ($null -eq $oldBindingCache) { Remove-Item Env:AO_PR_SESSION_BINDING_CACHE -ErrorAction SilentlyContinue }
            else { $env:AO_PR_SESSION_BINDING_CACHE = $oldBindingCache }
            if ($null -eq $oldStateDir) { Remove-Item Env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR -ErrorAction SilentlyContinue }
            else { $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR = $oldStateDir }
            if ($null -eq $oldSideEffectDir) { Remove-Item Env:AO_SIDE_PROCESS_STATE_DIR -ErrorAction SilentlyContinue }
            else { $env:AO_SIDE_PROCESS_STATE_DIR = $oldSideEffectDir }
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    Describe 'Get-WorkerStatusPrSessionBindingCachePath parity with Node resolver' {
        BeforeAll {
            function script:Assert-WorkerStatusBindingCachePathParity {
                param(
                    [string]$ExpectedPath = ''
                )

                $psPath = Get-WorkerStatusPrSessionBindingCachePath
                $nodeScript = @"
import { resolvePrSessionBindingCachePath } from '$($RepoRoot -replace "'", "''")/docs/pr-session-binding-cache.mjs';
console.log(resolvePrSessionBindingCachePath(process.env));
"@
                $nodePath = (& $Issue854NodePath --input-type=module -e $nodeScript | Out-String).Trim()
                $psPath | Should -Be $nodePath
                if ($ExpectedPath) {
                    $psPath | Should -Be $ExpectedPath
                }
                return $psPath
            }
        }

        It 'selects explicit AO_PR_SESSION_BINDING_CACHE when set' {
            $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("opk-854-cachepath-explicit-" + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            $explicitCachePath = Join-Path $dir 'explicit-binding-cache.json'
            [System.IO.File]::WriteAllText(
                $explicitCachePath,
                ((@{ schemaVersion = 1; generation = 11; records = @{}; lastUpdatedMs = 1 } | ConvertTo-Json -Compress) + "`n"),
                [System.Text.UTF8Encoding]::new($false)
            )

            $oldBindingCache = $env:AO_PR_SESSION_BINDING_CACHE
            $oldSeedState = $env:AO_REPORT_STATE_SEED_STATE
            try {
                $env:AO_PR_SESSION_BINDING_CACHE = $explicitCachePath
                Remove-Item Env:AO_REPORT_STATE_SEED_STATE -ErrorAction SilentlyContinue

                Assert-WorkerStatusBindingCachePathParity -ExpectedPath $explicitCachePath | Out-Null

                $vector = Get-WorkerStatusWriterGenerationVector -SessionId 'orchestrator-pack-137' -RepoTickGeneration 1 -GithubSnapshot @{ openPrs = @() }
                [long]$vector.bindingCacheGeneration | Should -Be 11
            }
            finally {
                if ($null -eq $oldBindingCache) { Remove-Item Env:AO_PR_SESSION_BINDING_CACHE -ErrorAction SilentlyContinue }
                else { $env:AO_PR_SESSION_BINDING_CACHE = $oldBindingCache }
                if ($null -eq $oldSeedState) { Remove-Item Env:AO_REPORT_STATE_SEED_STATE -ErrorAction SilentlyContinue }
                else { $env:AO_REPORT_STATE_SEED_STATE = $oldSeedState }
                Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        It 'selects seed-state parent directory for absolute AO_REPORT_STATE_SEED_STATE' {
            $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("opk-854-cachepath-" + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            $seedDir = Join-Path $dir 'seed-state'
            $wakeDir = Join-Path $dir 'wake-supervisor'
            New-Item -ItemType Directory -Path $seedDir -Force | Out-Null
            New-Item -ItemType Directory -Path $wakeDir -Force | Out-Null
            $seedStatePath = Join-Path $seedDir 'report-seed-state.json'
            $resolverCachePath = Join-Path $seedDir 'pr-session-binding-cache.json'
            $decoyCachePath = Join-Path $wakeDir 'pr-session-binding-cache.json'
            [System.IO.File]::WriteAllText($seedStatePath, '{}' + "`n", [System.Text.UTF8Encoding]::new($false))
            [System.IO.File]::WriteAllText(
                $resolverCachePath,
                ((@{ schemaVersion = 1; generation = 77; records = @{}; lastUpdatedMs = 1 } | ConvertTo-Json -Compress) + "`n"),
                [System.Text.UTF8Encoding]::new($false)
            )
            [System.IO.File]::WriteAllText(
                $decoyCachePath,
                ((@{ schemaVersion = 1; generation = 1; records = @{}; lastUpdatedMs = 1 } | ConvertTo-Json -Compress) + "`n"),
                [System.Text.UTF8Encoding]::new($false)
            )

            $oldBindingCache = $env:AO_PR_SESSION_BINDING_CACHE
            $oldSeedState = $env:AO_REPORT_STATE_SEED_STATE
            $oldWakeDir = $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR
            try {
                Remove-Item Env:AO_PR_SESSION_BINDING_CACHE -ErrorAction SilentlyContinue
                $env:AO_REPORT_STATE_SEED_STATE = $seedStatePath
                $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR = $wakeDir

                Assert-WorkerStatusBindingCachePathParity -ExpectedPath $resolverCachePath | Out-Null

                $vector = Get-WorkerStatusWriterGenerationVector -SessionId 'orchestrator-pack-137' -RepoTickGeneration 1 -GithubSnapshot @{ openPrs = @() }
                [long]$vector.bindingCacheGeneration | Should -Be 77
            }
            finally {
                if ($null -eq $oldBindingCache) { Remove-Item Env:AO_PR_SESSION_BINDING_CACHE -ErrorAction SilentlyContinue }
                else { $env:AO_PR_SESSION_BINDING_CACHE = $oldBindingCache }
                if ($null -eq $oldSeedState) { Remove-Item Env:AO_REPORT_STATE_SEED_STATE -ErrorAction SilentlyContinue }
                else { $env:AO_REPORT_STATE_SEED_STATE = $oldSeedState }
                if ($null -eq $oldWakeDir) { Remove-Item Env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR -ErrorAction SilentlyContinue }
                else { $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR = $oldWakeDir }
                Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        It 'selects current directory for relative AO_REPORT_STATE_SEED_STATE bare filename' {
            $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("opk-854-cachepath-relative-" + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            $seedStatePath = Join-Path $dir 'seed-state.json'
            $resolverCachePath = Join-Path $dir 'pr-session-binding-cache.json'
            [System.IO.File]::WriteAllText($seedStatePath, '{}' + "`n", [System.Text.UTF8Encoding]::new($false))
            [System.IO.File]::WriteAllText(
                $resolverCachePath,
                ((@{ schemaVersion = 1; generation = 88; records = @{}; lastUpdatedMs = 1 } | ConvertTo-Json -Compress) + "`n"),
                [System.Text.UTF8Encoding]::new($false)
            )

            $oldBindingCache = $env:AO_PR_SESSION_BINDING_CACHE
            $oldSeedState = $env:AO_REPORT_STATE_SEED_STATE
            $oldLocation = Get-Location
            try {
                Set-Location -LiteralPath $dir
                Remove-Item Env:AO_PR_SESSION_BINDING_CACHE -ErrorAction SilentlyContinue
                $env:AO_REPORT_STATE_SEED_STATE = 'seed-state.json'

                $parityPath = Assert-WorkerStatusBindingCachePathParity
                $parityPath | Should -Be 'pr-session-binding-cache.json'
                (Join-Path $dir $parityPath) | Should -Be $resolverCachePath

                $vector = Get-WorkerStatusWriterGenerationVector -SessionId 'orchestrator-pack-137' -RepoTickGeneration 1 -GithubSnapshot @{ openPrs = @() }
                [long]$vector.bindingCacheGeneration | Should -Be 88
            }
            finally {
                Set-Location -LiteralPath $oldLocation
                if ($null -eq $oldBindingCache) { Remove-Item Env:AO_PR_SESSION_BINDING_CACHE -ErrorAction SilentlyContinue }
                else { $env:AO_PR_SESSION_BINDING_CACHE = $oldBindingCache }
                if ($null -eq $oldSeedState) { Remove-Item Env:AO_REPORT_STATE_SEED_STATE -ErrorAction SilentlyContinue }
                else { $env:AO_REPORT_STATE_SEED_STATE = $oldSeedState }
                Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        It 'selects home-default path when no overrides are set' {
            $homeDefaultPath = Join-Path $HOME '.local/state/orchestrator-pack-wake-supervisor/pr-session-binding-cache.json'

            $oldBindingCache = $env:AO_PR_SESSION_BINDING_CACHE
            $oldSeedState = $env:AO_REPORT_STATE_SEED_STATE
            try {
                Remove-Item Env:AO_PR_SESSION_BINDING_CACHE -ErrorAction SilentlyContinue
                Remove-Item Env:AO_REPORT_STATE_SEED_STATE -ErrorAction SilentlyContinue

                Assert-WorkerStatusBindingCachePathParity -ExpectedPath $homeDefaultPath | Out-Null
            }
            finally {
                if ($null -eq $oldBindingCache) { Remove-Item Env:AO_PR_SESSION_BINDING_CACHE -ErrorAction SilentlyContinue }
                else { $env:AO_PR_SESSION_BINDING_CACHE = $oldBindingCache }
                if ($null -eq $oldSeedState) { Remove-Item Env:AO_REPORT_STATE_SEED_STATE -ErrorAction SilentlyContinue }
                else { $env:AO_REPORT_STATE_SEED_STATE = $oldSeedState }
            }
        }
    }
}