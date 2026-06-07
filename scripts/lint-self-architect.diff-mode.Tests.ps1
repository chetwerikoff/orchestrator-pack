Describe 'scripts/lint-self-architect.ps1 diff mode' {
    BeforeAll {
        $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
        $script:LintScript = Join-Path $PSScriptRoot 'lint-self-architect.ps1'

        $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
        if ($pwsh) {
            $script:ShellPath = $pwsh.Source
        }
        else {
            $script:ShellPath = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
        }
    }

    It 'passes strict diff mode when changed paths are all outside scan scope' {
        $tempRoot = Join-Path -Path $TestDrive -ChildPath 'lint-diff-out-of-scope'
        $promptDir = Join-Path -Path $tempRoot -ChildPath 'prompts'
        New-Item -ItemType Directory -Path $promptDir -Force | Out-Null

        $sharedBlock = @(
            'Before implementing, staging, or committing, run this short check:',
            '',
            '1. Paired script/template edits: am I changing the same behavior in both a script',
            '   and a template? If yes, extract or generate from one source of truth.',
            '2. Duplicated prompt literals: did I copy a rule/prompt/path string into multiple',
            '   files? If yes, centralize it before continuing.',
            '3. Broad declarations: is the declared scope a whole directory or glob when a',
            '   file-level scope would work? If yes, narrow it or justify it explicitly.',
            '4. New subsystem smell: am I adding a new subsystem for behavior that AO already',
            '   has through config, reactions, session metadata, or plugin slots?',
            '5. Core patch smell: am I about to patch upstream AO core? If yes, stop and use',
            '   plugin/config/prompt/wrapper/hook/CI instead.'
        )

        $firstPath = Join-Path -Path $promptDir -ChildPath 'first.md'
        $secondPath = Join-Path -Path $promptDir -ChildPath 'second.md'
        Set-Content -LiteralPath $firstPath -Value (@('# First', '') + $sharedBlock) -Encoding UTF8
        Set-Content -LiteralPath $secondPath -Value (@('# Second', '') + $sharedBlock) -Encoding UTF8

        Push-Location $tempRoot
        try {
            git init | Out-Null
            git add prompts/first.md prompts/second.md | Out-Null
            git -c user.email='test@example.com' -c user.name='test' commit -m 'base with pre-existing duplicate' | Out-Null
            $baseRef = (git rev-parse HEAD).Trim()

            Set-Content -LiteralPath (Join-Path $tempRoot 'CLAUDE.md') -Value '# Architect rules only' -Encoding UTF8
            git add CLAUDE.md | Out-Null
            git -c user.email='test@example.com' -c user.name='test' commit -m 'touch out-of-scope file' | Out-Null
            $headRef = (git rev-parse HEAD).Trim()

            $rawOutput = & $script:ShellPath -NoProfile -ExecutionPolicy Bypass -File $script:LintScript -RepoRoot $tempRoot -Strict -BaseRef $baseRef -HeadRef $headRef 2>&1
            $exitCode = $LASTEXITCODE
            $output = $rawOutput | Out-String
            $exitCode | Should -Be 0
            $output | Should -Match 'Changed files: 0'
            $output | Should -Match 'Comparison files: 0'
            $output | Should -Not -Match '\[STRICT\]'
        }
        finally {
            Pop-Location
        }
    }

    It 'passes strict diff mode for CLAUDE.md plus excluded declaration snapshot only' {
        $tempRoot = Join-Path -Path $TestDrive -ChildPath 'lint-diff-claude-declaration'
        $promptDir = Join-Path -Path $tempRoot -ChildPath 'prompts'
        $declDir = Join-Path -Path $tempRoot -ChildPath 'docs/declarations'
        New-Item -ItemType Directory -Path $promptDir -Force | Out-Null
        New-Item -ItemType Directory -Path $declDir -Force | Out-Null

        $sharedBlock = @(
            'Before implementing, staging, or committing, run this short check:',
            '',
            '1. Paired script/template edits: am I changing the same behavior in both a script',
            '   and a template? If yes, extract or generate from one source of truth.',
            '2. Duplicated prompt literals: did I copy a rule/prompt/path string into multiple',
            '   files? If yes, centralize it before continuing.',
            '3. Broad declarations: is the declared scope a whole directory or glob when a',
            '   file-level scope would work? If yes, narrow it or justify it explicitly.',
            '4. New subsystem smell: am I adding a new subsystem for behavior that AO already',
            '   has through config, reactions, session metadata, or plugin slots?',
            '5. Core patch smell: am I about to patch upstream AO core? If yes, stop and use',
            '   plugin/config/prompt/wrapper/hook/CI instead.'
        )

        $firstPath = Join-Path -Path $promptDir -ChildPath 'first.md'
        $secondPath = Join-Path -Path $promptDir -ChildPath 'second.md'
        Set-Content -LiteralPath $firstPath -Value (@('# First', '') + $sharedBlock) -Encoding UTF8
        Set-Content -LiteralPath $secondPath -Value (@('# Second', '') + $sharedBlock) -Encoding UTF8

        Push-Location $tempRoot
        try {
            git init | Out-Null
            git add prompts/first.md prompts/second.md | Out-Null
            git -c user.email='test@example.com' -c user.name='test' commit -m 'base with pre-existing duplicate' | Out-Null
            $baseRef = (git rev-parse HEAD).Trim()

            Set-Content -LiteralPath (Join-Path $tempRoot 'CLAUDE.md') -Value '# Architect rules only' -Encoding UTF8
            Set-Content -LiteralPath (Join-Path $declDir 'task.json') -Value '{"files":["CLAUDE.md"]}' -Encoding UTF8
            git add CLAUDE.md docs/declarations/task.json | Out-Null
            git -c user.email='test@example.com' -c user.name='test' commit -m 'declaration-only PR surface' | Out-Null
            $headRef = (git rev-parse HEAD).Trim()

            $rawOutput = & $script:ShellPath -NoProfile -ExecutionPolicy Bypass -File $script:LintScript -RepoRoot $tempRoot -Strict -BaseRef $baseRef -HeadRef $headRef 2>&1
            $exitCode = $LASTEXITCODE
            $output = $rawOutput | Out-String
            $exitCode | Should -Be 0
            $output | Should -Match 'Changed files: 0'
            $output | Should -Match 'Comparison files: 0'
            $output | Should -Not -Match '\[STRICT\]'
        }
        finally {
            Pop-Location
        }
    }

    It 'still performs repository-wide scan when no base reference is supplied' {
        $tempRoot = Join-Path -Path $TestDrive -ChildPath 'lint-full-scan'
        $promptDir = Join-Path -Path $tempRoot -ChildPath 'prompts'
        New-Item -ItemType Directory -Path $promptDir -Force | Out-Null

        $sharedBlock = @(
            'Before implementing, staging, or committing, run this short check:',
            '',
            '1. Paired script/template edits: am I changing the same behavior in both a script',
            '   and a template? If yes, extract or generate from one source of truth.',
            '2. Duplicated prompt literals: did I copy a rule/prompt/path string into multiple',
            '   files? If yes, centralize it before continuing.',
            '3. Broad declarations: is the declared scope a whole directory or glob when a',
            '   file-level scope would work? If yes, narrow it or justify it explicitly.',
            '4. New subsystem smell: am I adding a new subsystem for behavior that AO already',
            '   has through config, reactions, session metadata, or plugin slots?',
            '5. Core patch smell: am I about to patch upstream AO core? If yes, stop and use',
            '   plugin/config/prompt/wrapper/hook/CI instead.'
        )

        $firstPath = Join-Path -Path $promptDir -ChildPath 'first.md'
        $secondPath = Join-Path -Path $promptDir -ChildPath 'second.md'
        Set-Content -LiteralPath $firstPath -Value (@('# First', '') + $sharedBlock) -Encoding UTF8
        Set-Content -LiteralPath $secondPath -Value (@('# Second', '') + $sharedBlock) -Encoding UTF8

        Push-Location $tempRoot
        try {
            git init | Out-Null
            git add prompts/first.md prompts/second.md | Out-Null
            git -c user.email='test@example.com' -c user.name='test' commit -m 'base with duplicate' | Out-Null

            $rawOutput = & $script:ShellPath -NoProfile -ExecutionPolicy Bypass -File $script:LintScript -RepoRoot $tempRoot -Strict 2>&1
            $exitCode = $LASTEXITCODE
            $output = $rawOutput | Out-String
            $exitCode | Should -Be 1
            $output | Should -Match 'duplicate-literal'
            $output | Should -Match 'STRICT'
            $output | Should -Match 'Comparison files: 2'
        }
        finally {
            Pop-Location
        }
    }
}
