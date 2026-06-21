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

    It 'marks archive checkout trusted roots as disposable for cleanup' {
        $content = Get-Content -LiteralPath $script:ResolveTrustedPackRootScript -Raw
        $content | Should -Match 'DisposableTrustedRoot\s*=\s*\$true'
        $content | Should -Match 'New-TrustedPackArchiveCheckout'
        $content | Should -Match 'DisposableTrustedRoot\s*=\s*\$false'
    }

    It 'invoke wrapper cleans up disposable trusted archive checkouts in finally' {
        $invokeScript = Join-Path $script:RepoRoot 'scripts/invoke-contract-evidence-reverify.ps1'
        $content = Get-Content -LiteralPath $invokeScript -Raw
        $content | Should -Match 'DisposableTrustedRoot'
        $content | Should -Match 'Remove-Item -LiteralPath \$trustedBaseRoot -Recurse -Force'
        $content | Should -Match 'finally'
    }

    It 'invoke wrapper loads bootstrap helpers from trusted base instead of PR checkout' {
        $invokeScript = Join-Path $script:RepoRoot 'scripts/invoke-contract-evidence-reverify.ps1'
        $content = Get-Content -LiteralPath $invokeScript -Raw
        $content | Should -Not -Match '\. \(Join-Path \$PSScriptRoot ''lib/Resolve-TrustedPackRoot\.ps1''\)'
        $content | Should -Not -Match '\. \(Join-Path \$PSScriptRoot ''lib/Ensure-ReverifyWorkspaceDeps\.ps1''\)'
        $content | Should -Match 'Import-TrustedReverifyBootstrapModule'
        $content | Should -Match 'git archive origin/main'
        $content | Should -Match 'Import-TrustedReverifyBootstrap'
    }

    It 'bootstrap import module dot-sources helpers from resolved trusted root' {
        $bootstrapScript = Join-Path $script:RepoRoot 'scripts/lib/Import-TrustedReverifyBootstrap.ps1'
        $content = Get-Content -LiteralPath $bootstrapScript -Raw
        $content | Should -Match 'function Import-TrustedReverifyBootstrap'
        $content | Should -Match 'scripts/lib/Resolve-TrustedPackRoot\.ps1'
        $content | Should -Match 'scripts/lib/Ensure-ReverifyWorkspaceDeps\.ps1'
        $content | Should -Not -Match '\$PSScriptRoot'
    }
}
