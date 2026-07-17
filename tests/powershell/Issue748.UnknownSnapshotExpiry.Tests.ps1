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

    It 'writes a usable row through the real Write-WorkerStatusRow bridge' {
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("opk-854-bridge-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $cachePath = Join-Path $dir 'pr-session-binding-cache.json'
        $storePath = Join-Path $dir 'worker-status-store.json'
        $repo = 'chetwerikoff/orchestrator-pack'
        $sessionId = 'orchestrator-pack-137'
        $prNumber = 887
        $headSha = 'head887'
        $nowMs = 1700000000000
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

        $oldBindingCache = $env:AO_PR_SESSION_BINDING_CACHE
        $oldStateDir = $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR
        $oldSideEffectDir = $env:AO_SIDE_PROCESS_STATE_DIR
        try {
            $env:AO_PR_SESSION_BINDING_CACHE = $cachePath
            $env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR = $dir
            $env:AO_SIDE_PROCESS_STATE_DIR = $dir

            $result = Write-WorkerStatusRow -RecomputeInput @{
                session = [pscustomobject]@{
                    id = $sessionId
                    sessionId = $sessionId
                    role = 'worker'
                    status = 'working'
                    issueId = 874
                    displayName = '874'
                }
                reports = @()
                githubSnapshot = @{
                    openPrs = @([pscustomobject]@{
                        number = $prNumber
                        state = 'OPEN'
                        headRefOid = $headSha
                        headRefName = "ao/$sessionId/worker-status-cache"
                    })
                    reviewRuns = @()
                    ciChecksByPr = @{ "$prNumber" = @() }
                    requiredCheckNamesByPr = @{ "$prNumber" = @() }
                    requiredCheckLookupFailedByPr = @{ "$prNumber" = $false }
                    degraded = $false
                }
                osLiveness = @{ status = 'working' }
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
            [long]$result.row.generationVector.githubGeneration | Should -Be 45
            [long]$result.row.sourceGeneration.bindingCacheGeneration | Should -Be 45

            $stored = Get-Content -LiteralPath $storePath -Raw -Encoding UTF8 | ConvertFrom-Json
            $stored.records.$sessionId.derivedStatus | Should -Be 'pr_open'
            $stored.records.$sessionId.winningSource | Should -Be 'github_pr'
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
}