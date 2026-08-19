Describe 'scripts/lib/Ci-Failure-Notification-Common.ps1 Get-RepoIdentity slug isolation (Issue #685)' {
    BeforeAll {
        $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
        $script:Lib = Join-Path $script:RepoRoot 'scripts/lib/Ci-Failure-Notification-Common.ps1'
        . $script:Lib
        function New-GhErrorRecord([string]$Message) {
            [System.Management.Automation.ErrorRecord]::new(
                [System.Exception]::new($Message),
                'gh',
                [System.Management.Automation.ErrorCategory]::NotSpecified,
                $null)
        }
    }

    It 'returns the slug for a plain identity string at exit 0' {
        ConvertTo-RepoSlugFromGhOutput -Raw 'chetwerikoff/orchestrator-pack' |
            Should -Be 'chetwerikoff/orchestrator-pack'
    }

    It 'returns the slug without throwing when the merged 2>&1 stream contains a non-string ErrorRecord' {
        $stream = @((New-GhErrorRecord 'gh: a stderr warning'), 'chetwerikoff/orchestrator-pack')
        { ConvertTo-RepoSlugFromGhOutput -Raw $stream } | Should -Not -Throw
        ConvertTo-RepoSlugFromGhOutput -Raw $stream | Should -Be 'chetwerikoff/orchestrator-pack'
    }

    It 'returns exactly the slug (no warning text) when a string warning line rides alongside it' {
        $stream = @('warning: A new release of gh is available: 2.0.0', 'chetwerikoff/orchestrator-pack')
        ConvertTo-RepoSlugFromGhOutput -Raw $stream | Should -Be 'chetwerikoff/orchestrator-pack'
    }

    It 'trims surrounding whitespace from the slug' {
        ConvertTo-RepoSlugFromGhOutput -Raw "  chetwerikoff/orchestrator-pack`n" |
            Should -Be 'chetwerikoff/orchestrator-pack'
    }

    It 'no longer uses the fragile [string]$raw.Trim() form (regression guard)' {
        (Get-Content -LiteralPath $script:Lib -Raw) | Should -Not -Match '\[string\]\$raw\.Trim\(\)'
    }
}
