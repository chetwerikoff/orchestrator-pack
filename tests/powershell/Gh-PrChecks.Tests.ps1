Describe 'scripts/lib/Gh-PrChecks.ps1' {
    BeforeAll {
        $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
        . (Join-Path $script:RepoRoot 'scripts/lib/Gh-PrChecks.ps1')
    }

    It 'URL-encodes slash-containing branch refs for protection lookup' {
        Get-GhEncodedBranchRef -BranchRef 'release/1.0' | Should -Be 'release%2F1.0'
    }

    It 'leaves simple branch refs unchanged' {
        Get-GhEncodedBranchRef -BranchRef 'main' | Should -Be 'main'
    }
}
