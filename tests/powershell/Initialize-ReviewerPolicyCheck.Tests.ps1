Describe 'scripts/lib/Initialize-ReviewerPolicyCheck.ps1' {
    BeforeAll {
        $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
        $script:PolicyCheckScript = Join-Path $script:RepoRoot 'scripts/lib/Initialize-ReviewerPolicyCheck.ps1'
        . $script:PolicyCheckScript
    }

    It 'returns an empty failure list that supports Add' {
        $failures = New-ReviewerPolicyCheckFailures
        $null -eq $failures | Should -Be $false
        $failures.Count | Should -Be 0
        $failures.GetType().FullName | Should -Match '^System\.Collections\.Generic\.List`1\[\[System\.String'
        { $failures.Add('example failure') } | Should -Not -Throw
        $failures.Count | Should -Be 1
        $failures[0] | Should -Be 'example failure'
    }
}
