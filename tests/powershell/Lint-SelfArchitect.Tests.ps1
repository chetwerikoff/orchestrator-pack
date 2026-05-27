Describe 'scripts/lint-self-architect.ps1' {
    BeforeAll {
        $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
        $script:LintScript = Join-Path $script:RepoRoot 'scripts\lint-self-architect.ps1'
        $script:FixtureRoot = Join-Path $script:RepoRoot 'tests\fixtures\lint-self-architect'

        $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
        if ($pwsh) {
            $script:ShellPath = $pwsh.Source
        }
        else {
            $script:ShellPath = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
        }

        $fixtureRoot = $script:FixtureRoot
        $lintScript = $script:LintScript
        $shellPath = $script:ShellPath
        $script:InvokeLintFixture = {
            param(
                [string]$CaseName,
                [switch]$Strict
            )

            $fixturePath = Join-Path $fixtureRoot $CaseName
            $invokeArgs = @(
                '-NoProfile',
                '-ExecutionPolicy', 'Bypass',
                '-File', $lintScript,
                '-FixtureRoot', $fixturePath
            )
            if ($Strict) { $invokeArgs += '-Strict' }

            $output = & $shellPath @invokeArgs 2>&1 | Out-String
            return [pscustomobject]@{
                ExitCode = $LASTEXITCODE
                Output   = $output
            }
        }.GetNewClosure()
    }

    It 'exists at the repository scripts path' {
        Test-Path -LiteralPath $script:LintScript | Should -Be $true
    }

    It 'duplicate-literal fixture triggers strict duplicate-literal findings' {
        $result = & $script:InvokeLintFixture -CaseName 'duplicate-literal' -Strict
        $result.Output | Should -Match 'duplicate-literal'
        $result.Output | Should -Match 'STRICT'
        $result.ExitCode | Should -Be 1
    }

    It 'paired-edit fixture triggers strict paired-edit-divergence findings' {
        $result = & $script:InvokeLintFixture -CaseName 'paired-edit' -Strict
        $result.Output | Should -Match 'paired-edit-divergence'
        $result.Output | Should -Match 'STRICT'
        $result.ExitCode | Should -Be 1
    }

    It 'negative fixture passes under strict mode' {
        $result = & $script:InvokeLintFixture -CaseName 'negative' -Strict
        $result.Output | Should -Not -Match '\[STRICT\]'
        $result.ExitCode | Should -Be 0
    }

    It 'default mode exits 0 even when strict findings are present' {
        $result = & $script:InvokeLintFixture -CaseName 'duplicate-literal'
        $result.Output | Should -Match 'duplicate-literal'
        $result.ExitCode | Should -Be 0
    }
}
