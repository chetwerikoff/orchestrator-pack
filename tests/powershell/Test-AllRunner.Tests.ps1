Describe 'scripts/test-all.ps1' {
    BeforeAll {
        $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
        $script:TestAllScript = Join-Path $script:RepoRoot 'scripts/test-all.ps1'
    }

    It 'exists at the repository scripts path' {
        Test-Path -LiteralPath $script:TestAllScript | Should -Be $true
    }

    It 'declares SkipNpm and SkipPester switches' {
        $content = Get-Content -LiteralPath $script:TestAllScript -Raw
        $content | Should -Match '\[switch\]\$SkipNpm'
        $content | Should -Match '\[switch\]\$SkipPester'
    }

    It 'is invokable without running full tracks in this smoke test' {
        # Run in a child process: test-all.ps1 uses exit, which would terminate
        # the Pester host when invoked with the call operator in-process.
        $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
        if ($pwsh) {
            $shell = $pwsh.Source
        }
        else {
            $shell = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
        }
        & $shell -NoProfile -ExecutionPolicy Bypass -File $script:TestAllScript -SkipNpm -SkipPester
        $LASTEXITCODE | Should -Be 0
    }
}

Describe 'scripts/verify.ps1' {
    BeforeAll {
        $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
        $script:VerifyScript = Join-Path $script:RepoRoot 'scripts/verify.ps1'
    }

    It 'exists for pack structure verification' {
        Test-Path -LiteralPath $script:VerifyScript | Should -Be $true
    }
}
