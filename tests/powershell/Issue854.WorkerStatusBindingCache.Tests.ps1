#requires -Version 5.1

BeforeAll {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $WorkerStatusCli = Join-Path $RepoRoot 'scripts/lib/worker-status-store.mjs'

    function New-Issue854TempDirectory {
        $path = Join-Path ([System.IO.Path]::GetTempPath()) ("opk-854-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        return $path
    }

    function Invoke-Issue854WorkerStatusCli {
        param(
            [Parameter(Mandatory = $true)]
            [string]$Subcommand,
            [Parameter(Mandatory = $true)]
            [hashtable]$Payload
        )

        $inputJson = $Payload | ConvertTo-Json -Compress -Depth 30
        $output = @($inputJson | & node $WorkerStatusCli $Subcommand 2>&1)
        if ($LASTEXITCODE -ne 0) {
            throw "worker-status CLI failed ($LASTEXITCODE)`n$($output -join "`n")"
        }
        $jsonLines = @(($output -join "`n") -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') })
        if ($jsonLines.Count -eq 0) {
            throw "worker-status CLI emitted no JSON`n$($output -join "`n")"
        }
        return ($jsonLines[-1] | ConvertFrom-Json)
    }

    function Set-Issue854BindingCache {
        param(
            [Parameter(Mandatory = $true)]
            [string]$Path,
            [long]$NowMs,
            [bool]$Superseded = $false,
            [long]$AgeMs = 1000
        )

        $record = [ordered]@{
            schemaVersion = 1
            sessionId = 'orchestrator-pack-137'
            prNumber = 887
            issueNumber = 874
            headSha = 'head887'
            repoSlug = 'chetwerikoff/orchestrator-pack'
            source = 'push_register'
            lastUpdatedMs = $NowMs - $AgeMs
            superseded = $Superseded
        }
        $records = [ordered]@{}
        $records['chetwerikoff/orchestrator-pack|session:orchestrator-pack-137'] = $record
        $records['chetwerikoff/orchestrator-pack|pr:887'] = $record
        [ordered]@{
            schemaVersion = 1
            lastUpdatedMs = $NowMs - $AgeMs
            generation = 45
            records = $records
        } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding UTF8
    }

    function New-Issue854ResolvePayload {
        param(
            [Parameter(Mandatory = $true)]
            [string]$CachePath,
            [long]$NowMs
        )

        return @{
            session = @{
                id = 'orchestrator-pack-137'
                sessionId = 'orchestrator-pack-137'
                role = 'worker'
                status = 'working'
                issueId = 874
                displayName = '874'
            }
            openPrs = @(@{
                number = 887
                state = 'OPEN'
                headRefOid = 'head887'
                headRefName = 'ao/orchestrator-pack-137/worker-status-cache'
            })
            bindingCachePath = $CachePath
            nowMs = $NowMs
        }
    }
}

Describe 'Issue #854 worker-status binding cache wiring' {
    It 'resolves the existing push-register record before dead AO correlation heuristics' {
        $dir = New-Issue854TempDirectory
        try {
            $nowMs = 1700000000000
            $cachePath = Join-Path $dir 'pr-session-binding-cache.json'
            Set-Issue854BindingCache -Path $cachePath -NowMs $nowMs

            $binding = Invoke-Issue854WorkerStatusCli -Subcommand 'resolveSessionBinding' `
                -Payload (New-Issue854ResolvePayload -CachePath $cachePath -NowMs $nowMs)

            $binding.ok | Should -BeTrue
            $binding.prNumber | Should -Be 887
            $binding.headSha | Should -Be 'head887'
            $binding.bindingSource | Should -Be 'binding_cache:push_register'
            $binding.bindingCacheGeneration | Should -Be 45

            $fused = Invoke-Issue854WorkerStatusCli -Subcommand 'fuse' -Payload @{
                session = @{ id = 'orchestrator-pack-137'; status = 'working' }
                binding = @{
                    ok = [bool]$binding.ok
                    prNumber = [int]$binding.prNumber
                    headSha = [string]$binding.headSha
                    bindingSource = [string]$binding.bindingSource
                }
                github = @{
                    prOpen = $true
                    headSha = 'head887'
                    reviewRuns = @()
                    ciChecks = @()
                    requiredCheckNames = @()
                    requiredCheckLookupFailed = $false
                }
                nowMs = $nowMs
            }
            $fused.derivedStatus | Should -Be 'pr_open'
            $fused.winningSource | Should -Be 'github_pr'
            $fused.winningSource | Should -Not -Be 'degraded'
        }
        finally {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'does not revive a TTL-expired cache record' {
        $dir = New-Issue854TempDirectory
        try {
            $nowMs = 1700000000000
            $cachePath = Join-Path $dir 'pr-session-binding-cache.json'
            Set-Issue854BindingCache -Path $cachePath -NowMs $nowMs -AgeMs (8 * 24 * 60 * 60 * 1000)

            $binding = Invoke-Issue854WorkerStatusCli -Subcommand 'resolveSessionBinding' `
                -Payload (New-Issue854ResolvePayload -CachePath $cachePath -NowMs $nowMs)

            $binding.ok | Should -BeFalse
            $binding.reason | Should -Be 'binding_miss'
            $binding.bindingSource | Should -Not -Match '^binding_cache:'
        }
        finally {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'does not revive a superseded cache record' {
        $dir = New-Issue854TempDirectory
        try {
            $nowMs = 1700000000000
            $cachePath = Join-Path $dir 'pr-session-binding-cache.json'
            Set-Issue854BindingCache -Path $cachePath -NowMs $nowMs -Superseded $true

            $binding = Invoke-Issue854WorkerStatusCli -Subcommand 'resolveSessionBinding' `
                -Payload (New-Issue854ResolvePayload -CachePath $cachePath -NowMs $nowMs)

            $binding.ok | Should -BeFalse
            $binding.reason | Should -Be 'binding_miss'
        }
        finally {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'surfaces an unreadable cache instead of collapsing it into a generic miss' {
        $dir = New-Issue854TempDirectory
        try {
            $nowMs = 1700000000000
            $cachePath = Join-Path $dir 'pr-session-binding-cache.json'
            Set-Content -LiteralPath $cachePath -Value '{not-json' -Encoding UTF8

            $binding = Invoke-Issue854WorkerStatusCli -Subcommand 'resolveSessionBinding' `
                -Payload (New-Issue854ResolvePayload -CachePath $cachePath -NowMs $nowMs)

            $binding.ok | Should -BeFalse
            $binding.reason | Should -Be 'binding_cache_read_failed'
        }
        finally {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
