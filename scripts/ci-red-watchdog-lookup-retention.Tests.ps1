#requires -Version 7.0

BeforeAll {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
    . (Join-Path $PSScriptRoot 'lib/Ci-Red-Watchdog.ps1')
}

Describe 'CI-red watchdog lookup retention reconcile integration' {
    It 'runs retention for an authoritative empty open-PR snapshot without a checks bundle' {
        $storeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ci-red-empty-open-prs-{0}" -f [guid]::NewGuid().ToString('n'))
        $previousStateDir = $env:AO_CI_RED_WATCHDOG_STATE_DIR
        try {
            New-Item -ItemType Directory -Path $storeDir -Force | Out-Null
            $env:AO_CI_RED_WATCHDOG_STATE_DIR = $storeDir
            $headSha = 'a' * 40
            $record = Invoke-CiRedWatchdogCli -Command 'record-lookup-failure' -Payload @{
                storeDir = $storeDir
                lookup = @{
                    repo = 'acme/repo'
                    prNumber = 849
                    requiredCheckContext = 'ci'
                    headSha = $headSha
                }
                reason = 'check_runs_unavailable'
                nowMs = 1000
                config = @{
                    maxAttempts = 2
                    backoffMs = @(1)
                    episodeLifetimeMs = 60000
                }
            }
            $record.action | Should -Be 'defer'

            Mock Get-CiRedWatchdogRepoSlug { 'acme/repo' }
            $result = Invoke-CiRedWatchdogLookupRetention -RepoRoot $RepoRoot -WorkerState @{
                sessions = @()
                openPrs = @()
            }
            $result.ok | Should -BeTrue
            $result.reason | Should -Be 'authoritative_lookup_retention_applied'

            $ledger = Invoke-CiRedWatchdogCli -Command 'inspect-ledger' -Payload @{ storeDir = $storeDir }
            @($ledger.lookupFailures.PSObject.Properties).Count | Should -Be 0
            @($ledger.history | Where-Object {
                $_.key -eq 'lookup:retention' -and
                $_.reason -eq 'authoritative_pr_terminal' -and
                [int]$_.metadata.prNumber -eq 849 -and
                [string]$_.metadata.headSha -eq $headSha
            }).Count | Should -Be 1
        }
        finally {
            if ($null -eq $previousStateDir) {
                Remove-Item Env:AO_CI_RED_WATCHDOG_STATE_DIR -ErrorAction SilentlyContinue
            }
            else {
                $env:AO_CI_RED_WATCHDOG_STATE_DIR = $previousStateDir
            }
            Remove-Item -LiteralPath $storeDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'keeps maintenance before candidate checks-bundle gating in the reconcile tick' {
        $path = Join-Path $PSScriptRoot 'ci-failure-notification-reconcile.ps1'
        $tokens = $null
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
        @($errors).Count | Should -Be 0
        $tick = $ast.Find({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq 'Invoke-CiFailureNotificationTick'
        }, $true)
        $tick | Should -Not -BeNullOrEmpty
        $source = $tick.Extent.Text
        $retentionIndex = $source.IndexOf('Invoke-CiRedWatchdogLookupRetention')
        $checksGateIndex = $source.IndexOf('if ($openPrs.Count -gt 0)')
        $retentionIndex | Should -BeGreaterOrEqual 0
        $checksGateIndex | Should -BeGreaterThan $retentionIndex
    }

    It 'passes the CI-red watchdog self-test command' {
        Push-Location $RepoRoot
        try {
            $output = @(& node (Join-Path $RepoRoot 'scripts/lib/ci-red-watchdog-selftest.mjs') 2>&1)
            $exitCode = $LASTEXITCODE
        }
        finally {
            Pop-Location
        }
        $exitCode | Should -Be 0 -Because ($output -join "`n")
        ($output -join "`n") | Should -Match '\[PASS\] CI-red watchdog self-test \([0-9]+ cases\)'
    }
}
