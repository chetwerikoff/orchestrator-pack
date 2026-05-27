Describe 'scripts/test-all.ps1' {
    BeforeAll {
        $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
        $script:TestAllScript = Join-Path $script:RepoRoot 'scripts\test-all.ps1'
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
        { & $script:TestAllScript -SkipNpm -SkipPester } | Should -Not -Throw
        $LASTEXITCODE | Should -Be 0
    }
}

Describe 'scripts/verify.ps1' {
    BeforeAll {
        $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
        $script:VerifyScript = Join-Path $script:RepoRoot 'scripts\verify.ps1'
    }

    It 'exists for pack structure verification' {
        Test-Path -LiteralPath $script:VerifyScript | Should -Be $true
    }
}
