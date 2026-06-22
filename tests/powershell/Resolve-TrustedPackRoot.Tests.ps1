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
        $commonScript = Join-Path $script:RepoRoot 'scripts/lib/TrustedPackRoot-Common.ps1'
        $commonContent = Get-Content -LiteralPath $commonScript -Raw
        $content | Should -Match 'TrustedPackRoot-Common\.ps1'
        $commonContent | Should -Match 'function Test-TrustedMainWorktreeEligible'
        $commonContent | Should -Match 'git status --porcelain'
        $commonContent | Should -Match 'git rev-parse HEAD'
        $commonContent | Should -Match 'git rev-parse \$BaseRef'
        $content | Should -Match 'Test-TrustedMainWorktreeEligible -MainWorktreePath'
    }

    It 'marks archive checkout trusted roots as disposable for cleanup' {
        $content = Get-Content -LiteralPath $script:ResolveTrustedPackRootScript -Raw
        $content | Should -Match 'DisposableTrustedRoot\s*=\s*\$true'
        $content | Should -Match 'New-TrustedOriginMainArchiveCheckout'
        $content | Should -Match 'DisposableTrustedRoot\s*=\s*\$false'
    }

    It 'trusted launcher refuses execution from the PR checkout' {
        $launcherScript = Join-Path $script:RepoRoot 'scripts/launch-contract-evidence-reverify.ps1'
        $content = Get-Content -LiteralPath $launcherScript -Raw
        $content | Should -Match 'Assert-LauncherInvokedOutsideReviewTarget'
        $content | Should -Match 'refusing PR-checkout launcher'
        $content | Should -Match 'ReviewTargetRoot'
    }

    It 'shared trusted-root helpers reject overrides inside the review target' {
        $commonScript = Join-Path $script:RepoRoot 'scripts/lib/TrustedPackRoot-Common.ps1'
        $content = Get-Content -LiteralPath $commonScript -Raw
        $content | Should -Match 'function Test-PathInsideReviewTarget'
        $content | Should -Match 'function Assert-TrustedRootOverrideEligible'
        $content | Should -Match 'refusing trusted-root override'
        $content | Should -Match 'git rev-parse HEAD'
        $content | Should -Match 'git rev-parse \$BaseRef'

        $launcherScript = Join-Path $script:RepoRoot 'scripts/launch-contract-evidence-reverify.ps1'
        $launcherContent = Get-Content -LiteralPath $launcherScript -Raw
        $launcherContent | Should -Match 'Assert-TrustedRootOverrideEligible'

        $resolveScript = Join-Path $script:RepoRoot 'scripts/lib/Resolve-TrustedPackRoot.ps1'
        $resolveContent = Get-Content -LiteralPath $resolveScript -Raw
        $resolveContent | Should -Match 'Assert-TrustedRootOverrideEligible'

        $bootstrapScript = Join-Path $script:RepoRoot 'scripts/lib/Import-TrustedReverifyBootstrap.ps1'
        $bootstrapContent = Get-Content -LiteralPath $bootstrapScript -Raw
        $bootstrapContent | Should -Match 'Assert-TrustedRootOverrideEligible'
    }

    It 'PR-checkout invoke wrapper refuses direct execution' {
        $invokeScript = Join-Path $script:RepoRoot 'scripts/invoke-contract-evidence-reverify.ps1'
        $content = Get-Content -LiteralPath $invokeScript -Raw
        $content | Should -Match 'launch-contract-evidence-reverify\.ps1'
        $content | Should -Match 'exit 2'
        $content | Should -Not -Match 'Resolve-TrustedReverifyInvokeScript'
    }

    It 'preserves disposable bootstrap archive roots instead of re-validating them as overrides' {
        $implementationScript = Join-Path $script:RepoRoot 'scripts/lib/Contract-EvidenceReverify-Core.ps1'
        $content = Get-Content -LiteralPath $implementationScript -Raw
        $content | Should -Match 'if \(\$disposableScriptBootstrapRoot\)'
        $content | Should -Match 'DisposableTrustedRoot\s*=\s*\$true'
        $content | Should -Match 'scripts/invoke-contract-evidence-reverify\.ts'
        $content | Should -Not -Match 'Resolve-TrustedPackRunner -ReviewTargetRoot \$reviewTargetRoot -TrustedBaseRoot \$scriptBootstrap\.BootstrapRoot'
    }

    It 'trusted implementation cleans up disposable trusted archive checkouts in finally' {
        $implementationScript = Join-Path $script:RepoRoot 'scripts/lib/Contract-EvidenceReverify-Core.ps1'
        $content = Get-Content -LiteralPath $implementationScript -Raw
        $content | Should -Match 'DisposableTrustedRoot'
        $content | Should -Match 'Remove-Item -LiteralPath \$effectiveTrustedBaseRoot -Recurse -Force'
        $content | Should -Match 'finally'
        $content | Should -Not -Match '\$trustedBaseRoot = \$null'
    }

    It 'trusted implementation loads bootstrap helpers from immutable base' {
        $implementationScript = Join-Path $script:RepoRoot 'scripts/lib/Contract-EvidenceReverify-Core.ps1'
        $content = Get-Content -LiteralPath $implementationScript -Raw
        $content | Should -Match 'Import-TrustedReverifyBootstrap'
        $content | Should -Not -Match '\. \(Join-Path \$PSScriptRoot ''Resolve-TrustedPackRoot\.ps1''\)'
        $content | Should -Not -Match '\. \(Join-Path \$PSScriptRoot ''Ensure-ReverifyWorkspaceDeps\.ps1''\)'
    }

    It 'trusted launcher invokes shared core directly' {
        $launcherScript = Join-Path $script:RepoRoot 'scripts/launch-contract-evidence-reverify.ps1'
        $content = Get-Content -LiteralPath $launcherScript -Raw
        $content | Should -Match 'Contract-EvidenceReverify-Core\.ps1'
        $content | Should -Match 'Invoke-ContractEvidenceReverifyCore @PSBoundParameters'
    }

    It 'ao review command bootstrap archives launcher and core helpers from origin/main only' {
        $aoReviewCommand = Join-Path $script:RepoRoot 'scripts/run-reviewer-reverify-ao-review-command.ps1'
        $content = Get-Content -LiteralPath $aoReviewCommand -Raw
        $content | Should -Match 'bootstrapArchivePaths'
        $content | Should -Match 'Contract-EvidenceReverify-Core\.ps1'
        $content | Should -Match 'Import-TrustedReverifyBootstrap\.ps1'
        $content | Should -Match 'git archive origin/main -- @bootstrapArchivePaths'
        $content | Should -Not -Match "GitRef 'HEAD'"
        $content | Should -Not -Match 'git worktree add --detach'
    }

    It 'bootstrap import module dot-sources helpers from resolved trusted root' {
        $bootstrapScript = Join-Path $script:RepoRoot 'scripts/lib/Import-TrustedReverifyBootstrap.ps1'
        $content = Get-Content -LiteralPath $bootstrapScript -Raw
        $content | Should -Match 'function Import-TrustedReverifyBootstrap'
        $content | Should -Match 'scripts/lib/Resolve-TrustedPackRoot\.ps1'
        $content | Should -Match 'scripts/lib/Ensure-ReverifyWorkspaceDeps\.ps1'
        $content | Should -Not -Match "\. \(Join-Path \`$PSScriptRoot 'Resolve-TrustedPackRoot\.ps1'\)"
    }
}
