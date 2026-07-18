#requires -Version 5.1

BeforeAll {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $InvokeAoPath = Join-Path $RepoRoot 'scripts/lib/Invoke-AoCliJson.ps1'
    $WorkerReportPath = Join-Path $RepoRoot 'scripts/lib/WorkerReportStore.ps1'
    $WorkerRecoveryPath = Join-Path $RepoRoot 'scripts/lib/Worker-Recovery.ps1'
    $WorkerStatusNodePath = Join-Path $RepoRoot 'scripts/lib/worker-status-store.mjs'
    $WorkerStatusPsPath = Join-Path $RepoRoot 'scripts/lib/WorkerStatusStore.ps1'
    $ResolverDeclarationPath = Join-Path $RepoRoot 'docs/session-pr-binding-resolver.d.mts'
    $CacheDeclarationPath = Join-Path $RepoRoot 'docs/pr-session-binding-cache.d.mts'
    $NodeMatrixPath = Join-Path $PSScriptRoot 'Issue857.PrSessionBindingContract.Node.mjs'

    . $InvokeAoPath
    . $WorkerReportPath
}

Describe 'Issue #857 PowerShell binding dispatch' {
    It 'executes all ten Node contract matrix cells' {
        $output = & node $NodeMatrixPath 2>&1
        $LASTEXITCODE | Should -Be 0 -Because ($output -join "`n")
        ($output -join "`n") | Should -Match 'Issue #857 Node contract matrix: PASS'
    }

    It 'structurally eliminates per-session detail fanout' {
        $script:sessionGetCalls = 0
        function Get-AoSessionGetJson {
            $script:sessionGetCalls += 1
            throw 'per-session detail call must not execute'
        }

        $sessions = 1..5 | ForEach-Object {
            [pscustomobject]@{
                id = "worker-$_"
                sessionId = "worker-$_"
                role = 'worker'
                status = 'working'
                branch = "issue-$_"
                prs = @("https://github.com/chetwerikoff/orchestrator-pack/pull/$_")
            }
        }

        foreach ($row in $sessions) {
            (Test-AoSessionRowNeedsSessionGetDetail -Row $row) | Should -BeFalse
        }
        $details = Build-AoSessionDetailsById -Sessions $sessions -Project 'orchestrator-pack'
        $details.Count | Should -Be 0
        $script:sessionGetCalls | Should -Be 0
    }

    It 'routes the worker-report bridge through the Node binding contract' {
        $script:capturedWorkerReportPayload = $null
        function Get-AoStatusSessionsIncludingTerminated {
            return @([pscustomobject]@{
                id = 'worker-857'
                sessionId = 'worker-857'
                role = 'worker'
                status = 'working'
                branch = 'agent/issue-857-binding-contract-v2'
                prs = @('https://github.com/chetwerikoff/orchestrator-pack/pull/896')
            })
        }
        function Invoke-GhOpenPrList {
            return @([pscustomobject]@{
                number = 896
                state = 'OPEN'
                headRefName = 'agent/issue-857-binding-contract-v2'
                headRefOid = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
                repoSlug = 'chetwerikoff/orchestrator-pack'
            })
        }
        function Resolve-WorkerReportStoreRepoSlug { return 'chetwerikoff/orchestrator-pack' }
        function Invoke-WorkerReportStoreCli {
            param([string]$Subcommand, [hashtable]$Payload)
            $Subcommand | Should -Be 'resolveTrustedBinding'
            $script:capturedWorkerReportPayload = $Payload
            return @{
                ok = $true
                sessionId = 'worker-857'
                prNumber = 896
                headSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
                bindingSource = 'live_prs'
            }
        }

        $result = Resolve-PackWorkerReportTrustedBinding -SessionId 'worker-857' `
            -RepoSlug 'chetwerikoff/orchestrator-pack' `
            -WorktreeHeadSha 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

        $result.ok | Should -BeTrue
        $result.prNumber | Should -Be 896
        @($script:capturedWorkerReportPayload.session.prs).Count | Should -Be 1
        $script:capturedWorkerReportPayload.session.PSObject.Properties.Name | Should -Not -Contain 'displayName'
        $script:capturedWorkerReportPayload.session.PSObject.Properties.Name | Should -Not -Contain 'prNumber'
    }

    It 'keeps recovery cleanup on the shared binding bridge' {
        $text = Get-Content -LiteralPath $WorkerRecoveryPath -Raw -Encoding UTF8
        $text | Should -Match 'Resolve-PackWorkerReportTrustedBinding'
        $text | Should -Not -Match '\$Session\.prNumber'
    }

    It 'keeps worker-status minimal, contract-bound, and compatible with issue 891' {
        $statusNodeText = Get-Content -LiteralPath $WorkerStatusNodePath -Raw -Encoding UTF8
        $statusPsText = Get-Content -LiteralPath $WorkerStatusPsPath -Raw -Encoding UTF8
        $reportText = Get-Content -LiteralPath $WorkerReportPath -Raw -Encoding UTF8
        $invokeText = Get-Content -LiteralPath $InvokeAoPath -Raw -Encoding UTF8

        $statusNodeText | Should -Match 'resolvePrSessionBindingForConsumer'
        $statusNodeText | Should -Not -Match '(?i)\bsession\.prNumber\b'
        $statusNodeText | Should -Not -Match '(?i)\bsession\.displayName\b'
        $statusPsText | Should -Not -Match '(?i)\$(?:session|Session)\.prNumber\b'
        $statusPsText | Should -Not -Match '(?i)\$(?:session|Session)\.displayName\b'
        $statusPsText | Should -Match "-Subcommand 'resolveBindingCachePath'"
        $reportText | Should -Not -Match '\$session\.prNumber'
        $invokeText | Should -Match 'return \$false'
    }

    It 'keeps declaration surfaces synchronized with the post-displayName contract' {
        $resolverDeclaration = Get-Content -LiteralPath $ResolverDeclarationPath -Raw -Encoding UTF8
        $cacheDeclaration = Get-Content -LiteralPath $CacheDeclarationPath -Raw -Encoding UTF8
        $aoSessionBlock = [regex]::Match(
            $resolverDeclaration,
            'export interface AoSession\s*\{[\s\S]*?\n\}',
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
        ).Value

        $resolverDeclaration | Should -Not -Match "'display_name'"
        $aoSessionBlock | Should -Not -Match '\bprNumber\??\s*:'
        $aoSessionBlock | Should -Not -Match '\bdisplayName\??\s*:'
        $cacheDeclaration | Should -Match 'resolveSessionPrBindingForConsumer'
        $cacheDeclaration | Should -Match 'PR_SESSION_BINDING_FAIL_CLOSED_REASONS'
    }
}
