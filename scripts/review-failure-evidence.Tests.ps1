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
            $stdout = $process.StandardOutput.ReadToEnd()
            $process.WaitForExit()
            $stdout.Trim() | Should -Be "--repo-root|$repoRoot|--base|origin/main"
        }
        finally {
            if ($process -and -not $process.HasExited) {
                $process.Kill() | Out-Null
            }
            if ($process) { $process.Dispose() }
        }
    }
}
