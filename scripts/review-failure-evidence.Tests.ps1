#Requires -Version 5.1
BeforeAll {
    $Script:FixtureRoot = Join-Path $PSScriptRoot 'fixtures/review-failure-evidence'
    . (Join-Path $PSScriptRoot 'lib/Review-FailureEvidence.ps1')
}

Describe 'Get-PackReviewWrapperProcessStartInfo' {
    It 'preserves wrapper arguments that contain spaces' {
        $echoScript = Join-Path $Script:FixtureRoot 'echo-args.ps1'
        $repoRoot = '/tmp/path with spaces/repo'
        $psi = Get-PackReviewWrapperProcessStartInfo -PwshPath (Get-Command pwsh).Source -WrapperPath $echoScript -WrapperArgs @(
            '--repo-root', $repoRoot, '--base', 'origin/main'
        )
        $process = [System.Diagnostics.Process]::Start($psi)
        try {
            $streams = Read-PackReviewProcessStreams -Process $process
            $streams.Stdout.Trim() | Should -Be "--repo-root|$repoRoot|--base|origin/main"
        }
        finally {
            if ($process -and -not $process.HasExited) {
                $process.Kill() | Out-Null
            }
            if ($process) { $process.Dispose() }
        }
    }

    It 'uses quoted Arguments fallback when ArgumentList is unavailable' {
        $supportsArgumentList = Test-PackReviewProcessStartInfoSupportsArgumentList
        $echoScript = Join-Path $Script:FixtureRoot 'echo-args.ps1'
        $repoRoot = 'C:\path with spaces\repo'
        $psi = Get-PackReviewWrapperProcessStartInfo -PwshPath (Get-Command pwsh).Source -WrapperPath $echoScript -WrapperArgs @(
            '--repo-root', $repoRoot
        )
        if ($supportsArgumentList) {
            $psi.ArgumentList.Count | Should -BeGreaterThan 0
        }
        else {
            $psi.Arguments | Should -Match 'path with spaces'
        }
    }
}

Describe 'Read-PackReviewProcessStreams' {
    It 'drains stderr and stdout concurrently without deadlock' {
        $script = Join-Path $Script:FixtureRoot 'fill-stderr-then-stdout.ps1'
        $psi = Get-PackReviewWrapperProcessStartInfo -PwshPath (Get-Command pwsh).Source -WrapperPath $script -WrapperArgs @()
        $process = [System.Diagnostics.Process]::Start($psi)
        try {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $streams = Read-PackReviewProcessStreams -Process $process
            $sw.Stop()
            $sw.Elapsed.TotalSeconds | Should -BeLessThan 10
            $streams.Stdout.Trim() | Should -Be 'stdout-done'
            $streams.Stderr | Should -Match 'stderr-line-'
        }
        finally {
            if ($process -and -not $process.HasExited) {
                $process.Kill() | Out-Null
            }
            if ($process) { $process.Dispose() }
        }
    }
}
