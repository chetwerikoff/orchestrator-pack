#requires -Version 7.0

BeforeAll {
    $script:RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $script:Variants = Join-Path $script:RepoRoot 'tests/external-output-references/variants/opk-json-producers'
    function script:New-WaveBTempDirectory {
        $path = Join-Path ([System.IO.Path]::GetTempPath()) ('opk-wave-b-' + [guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        return $path
    }
    function script:Assert-BytesEqual {
        param([string]$ActualPath, [string]$ExpectedPath)
        [Convert]::ToHexString([IO.File]::ReadAllBytes($ActualPath)) |
            Should -Be ([Convert]::ToHexString([IO.File]::ReadAllBytes($ExpectedPath)))
    }
}

Describe 'Wave B PowerShell compatibility wrappers' {
    It 'preserves sanctioned-kill CLI argv and artifact bytes' {
        $temp = New-WaveBTempDirectory
        try {
            $path = Join-Path $temp 'kills.json'
            $output = & (Join-Path $script:RepoRoot 'scripts/record-sanctioned-worker-kill.ps1') `
                -SessionId 'opk-831-worker' -IssueNumber 831 -PrNumber 832 -KillKind manual `
                -TimestampMs 1784102400000 -Path $path
            $LASTEXITCODE | Should -Be 0
            ($output | Out-String | ConvertFrom-Json).healthy | Should -BeTrue
            Assert-BytesEqual -ActualPath $path -ExpectedPath (Join-Path $script:Variants 'sanctioned-worker-kill-record/single.json')
        }
        finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'preserves sanctioned-kill library functions without PowerShell JSON emission' {
        $temp = New-WaveBTempDirectory
        try {
            . (Join-Path $script:RepoRoot 'scripts/lib/Sanctioned-Worker-Kill-Record.ps1')
            $path = Join-Path $temp 'kills.json'
            $surface = Add-SanctionedWorkerKillRecord -SessionId 'opk-831-worker' -IssueNumber 831 `
                -PrNumber 832 -KillKind manual -TimestampMs 1784102400000 -Path $path
            $surface.healthy | Should -BeTrue
            (Read-SanctionedWorkerKillSurface -Path $path).records.Count | Should -Be 1
            Assert-BytesEqual -ActualPath $path -ExpectedPath (Join-Path $script:Variants 'sanctioned-worker-kill-record/single.json')
        }
        finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'preserves RTK inventory argv, stdout, and JSON artifact' {
        $temp = New-WaveBTempDirectory
        try {
            $outputPath = Join-Path $temp 'inventory.json'
            $stdout = & (Join-Path $script:RepoRoot 'scripts/invoke-rtk-discover-inventory.ps1') `
                -SinceDays 30 -Limit 50 `
                -DiscoverFixture (Join-Path $script:Variants 'rtk-discover-inventory/discover-input.json') `
                -NowMs 1767225600123 -OutputJson $outputPath
            $LASTEXITCODE | Should -Be 0
            ($stdout | Out-String) | Should -Match '# RTK missed-savings inventory'
            Assert-BytesEqual -ActualPath $outputPath -ExpectedPath (Join-Path $script:Variants 'rtk-discover-inventory/inventory.json')
        }
        finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'preserves worker-status report argv and JSON stdout shape' {
        $stdout = & (Join-Path $script:RepoRoot 'scripts/show-worker-status-report.ps1') -Json `
            -SessionListsFixture (Join-Path $script:Variants 'worker-status-report/session-lists.json') `
            -StorePath (Join-Path $script:Variants 'worker-status-report/store.json') `
            -NowMs 1767225600123
        $LASTEXITCODE | Should -Be 0
        $actual = $stdout | Out-String | ConvertFrom-Json -Depth 20
        $expected = Get-Content -LiteralPath (Join-Path $script:Variants 'worker-status-report/report.json') -Raw |
            ConvertFrom-Json -Depth 20
        ($actual | ConvertTo-Json -Depth 20 -Compress) | Should -Be ($expected | ConvertTo-Json -Depth 20 -Compress)
    }

    It 'keeps the read-delegation Stop hook fail-open when its module is absent' {
        $temp = New-WaveBTempDirectory
        try {
            { '{}' | & (Join-Path $script:RepoRoot 'scripts/invoke-read-delegation-audit-stop.ps1') -RepoRoot $temp } |
                Should -Not -Throw
            $LASTEXITCODE | Should -Be 0
        }
        finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
