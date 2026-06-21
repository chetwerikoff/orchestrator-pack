Describe 'scripts/lib/Resolve-TrustedPackRoot.ps1' {
    BeforeAll {
        $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
        $script:ResolveTrustedPackRootScript = Join-Path $script:RepoRoot 'scripts/lib/Resolve-TrustedPackRoot.ps1'
    }

    It 'exists at the repository scripts path' {
        Test-Path -LiteralPath $script:ResolveTrustedPackRootScript | Should -Be $true
    }

    It 'requires clean main worktree at BaseRef before using the main-worktree shortcut' {
        $content = Get-Content -LiteralPath $script:ResolveTrustedPackRootScript -Raw
        $content | Should -Match 'function Test-TrustedMainWorktreeEligible'
        $content | Should -Match 'git status --porcelain'
        $content | Should -Match 'git rev-parse HEAD'
        $content | Should -Match 'git rev-parse \$BaseRef'
        $content | Should -Match 'Test-TrustedMainWorktreeEligible -MainWorktreePath'
    }
}
