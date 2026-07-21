Describe 'scripts/lint-self-architect.ps1' {
    BeforeAll {
        $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
        $script:LintScript = Join-Path $script:RepoRoot 'scripts/lint-self-architect.ps1'
        $script:FixtureRoot = Join-Path $script:RepoRoot 'tests/fixtures/lint-self-architect'

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

            $rawOutput = & $shellPath @invokeArgs 2>&1
            $exitCode = $LASTEXITCODE
            return [pscustomobject]@{
                ExitCode = $exitCode
                Output   = ($rawOutput | Out-String)
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

    It 'detects duplicate when an untracked file copies a tracked prompt' {
        $tempRoot = Join-Path -Path $TestDrive -ChildPath 'lint-untracked-copy'
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

        $existingPath = Join-Path -Path $promptDir -ChildPath 'existing.md'
        Set-Content -LiteralPath $existingPath -Value (@('# Existing prompt', '') + $sharedBlock) -Encoding UTF8

        Push-Location $tempRoot
        try {
            git init | Out-Null
            git add prompts/existing.md | Out-Null
            git -c user.email='test@example.com' -c user.name='test' commit -m 'base' | Out-Null

            $newPath = Join-Path -Path $promptDir -ChildPath 'new-copy.md'
            Set-Content -LiteralPath $newPath -Value (@('# New copy', '') + $sharedBlock) -Encoding UTF8

            $rawOutput = & $script:ShellPath -NoProfile -ExecutionPolicy Bypass -File $script:LintScript -RepoRoot $tempRoot -Strict -WithWorkingTree 2>&1
            $exitCode = $LASTEXITCODE
            $output = $rawOutput | Out-String
            $exitCode | Should -Be 1
            $output | Should -Match 'duplicate-literal'
            $output | Should -Match 'STRICT'
        }
        finally {
            Pop-Location
        }
    }

    It 'detects duplicate when a PR introduces the same block in two new files' {
        $tempRoot = Join-Path -Path $TestDrive -ChildPath 'lint-pr-only-duplicate'
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
            git -c user.email='test@example.com' -c user.name='test' commit --allow-empty -m 'base' | Out-Null
            $baseRef = (git rev-parse HEAD).Trim()
            git add prompts/first.md prompts/second.md | Out-Null
            git -c user.email='test@example.com' -c user.name='test' commit -m 'add duplicate prompts' | Out-Null
            $headRef = (git rev-parse HEAD).Trim()

            $rawOutput = & $script:ShellPath -NoProfile -ExecutionPolicy Bypass -File $script:LintScript -RepoRoot $tempRoot -Strict -BaseRef $baseRef -HeadRef $headRef 2>&1
            $exitCode = $LASTEXITCODE
            $output = $rawOutput | Out-String
            $exitCode | Should -Be 1
            $output | Should -Match 'duplicate-literal'
            $output | Should -Match 'STRICT'
        }
        finally {
            Pop-Location
        }
    }

    It 'detects duplicate when a PR copies from a changed file that already had the block' {
        $tempRoot = Join-Path -Path $TestDrive -ChildPath 'lint-changed-source-copy'
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

        $sourcePath = Join-Path -Path $promptDir -ChildPath 'source.md'
        Set-Content -LiteralPath $sourcePath -Value (@('# Source', '') + $sharedBlock) -Encoding UTF8

        Push-Location $tempRoot
        try {
            git init | Out-Null
            git add prompts/source.md | Out-Null
            git -c user.email='test@example.com' -c user.name='test' commit -m 'base' | Out-Null
            $baseRef = (git rev-parse HEAD).Trim()

            Set-Content -LiteralPath $sourcePath -Value (@('# Source', 'Unrelated edit.', '') + $sharedBlock) -Encoding UTF8
            $copyPath = Join-Path -Path $promptDir -ChildPath 'copy.md'
            Set-Content -LiteralPath $copyPath -Value (@('# Copy', '') + $sharedBlock) -Encoding UTF8
            git add prompts/source.md prompts/copy.md | Out-Null
            git -c user.email='test@example.com' -c user.name='test' commit -m 'copy block to second file' | Out-Null
            $headRef = (git rev-parse HEAD).Trim()

            $rawOutput = & $script:ShellPath -NoProfile -ExecutionPolicy Bypass -File $script:LintScript -RepoRoot $tempRoot -Strict -BaseRef $baseRef -HeadRef $headRef 2>&1
            $exitCode = $LASTEXITCODE
            $output = $rawOutput | Out-String
            $exitCode | Should -Be 1
            $output | Should -Match 'duplicate-literal'
            $output | Should -Match 'STRICT'
        }
        finally {
            Pop-Location
        }
    }

    It 'does not flag pre-existing duplicates when a file is only renamed' {
        $tempRoot = Join-Path -Path $TestDrive -ChildPath 'lint-rename-only'
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
            git -c user.email='test@example.com' -c user.name='test' commit -m 'base' | Out-Null
            $baseRef = (git rev-parse HEAD).Trim()

            git mv prompts/first.md prompts/first-renamed.md | Out-Null
            Set-Content -LiteralPath $secondPath -Value (@('# Second', 'Unrelated edit.') + $sharedBlock) -Encoding UTF8
            git add -A | Out-Null
            git -c user.email='test@example.com' -c user.name='test' commit -m 'rename and touch second' | Out-Null
            $headRef = (git rev-parse HEAD).Trim()

            $rawOutput = & $script:ShellPath -NoProfile -ExecutionPolicy Bypass -File $script:LintScript -RepoRoot $tempRoot -Strict -BaseRef $baseRef -HeadRef $headRef 2>&1
            $exitCode = $LASTEXITCODE
            $output = $rawOutput | Out-String
            $exitCode | Should -Be 0
            $output | Should -Not -Match 'duplicate-literal'
        }
        finally {
            Pop-Location
        }
    }


    # Issue #941 exact migration-pair suppressions.
    It 'suppresses only an exact configured migration pair and reactivates on a third file' {
        $tempRoot = Join-Path -Path $TestDrive -ChildPath 'lint-exact-migration-pair'
        $scriptsDir = Join-Path -Path $tempRoot -ChildPath 'scripts'
        New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null

        $sharedBlock = @(1..12 | ForEach-Object { "migration-line-$($_)" })
        Set-Content -LiteralPath (Join-Path $scriptsDir 'legacy.mjs') -Value $sharedBlock -Encoding UTF8
        Set-Content -LiteralPath (Join-Path $scriptsDir 'terminalized.ts') -Value $sharedBlock -Encoding UTF8

        $configPath = Join-Path $tempRoot 'lint-config.json'
        @{
            scanPaths = @('scripts/**')
            excludePaths = @()
            scriptExtensions = @('.mjs', '.ts')
            templateExtensions = @()
            duplicateLiteralMinLines = 10
            suppressions = @(
                @{
                    rule = 'duplicate-literal'
                    files = @('scripts/legacy.mjs', 'scripts/terminalized.ts')
                }
            )
        } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configPath -Encoding UTF8

        $rawOutput = & $script:ShellPath -NoProfile -ExecutionPolicy Bypass -File $script:LintScript -FixtureRoot $tempRoot -ConfigPath $configPath -Strict 2>&1
        $exitCode = $LASTEXITCODE
        $output = $rawOutput | Out-String
        $exitCode | Should -Be 0
        $output | Should -Not -Match '\[STRICT\]'

        Set-Content -LiteralPath (Join-Path $scriptsDir 'third.ts') -Value $sharedBlock -Encoding UTF8
        $rawOutput = & $script:ShellPath -NoProfile -ExecutionPolicy Bypass -File $script:LintScript -FixtureRoot $tempRoot -ConfigPath $configPath -Strict 2>&1
        $exitCode = $LASTEXITCODE
        $output = $rawOutput | Out-String
        $exitCode | Should -Be 1
        $output | Should -Match 'duplicate-literal'
        $output | Should -Match '\[STRICT\]'
    }

    It 'does not let a broader configured file set suppress a smaller finding set' {
        $tempRoot = Join-Path -Path $TestDrive -ChildPath 'lint-suppression-cardinality'
        $scriptsDir = Join-Path -Path $tempRoot -ChildPath 'scripts'
        New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null

        $sharedBlock = @(1..12 | ForEach-Object { "cardinality-line-$($_)" })
        Set-Content -LiteralPath (Join-Path $scriptsDir 'first.ts') -Value $sharedBlock -Encoding UTF8
        Set-Content -LiteralPath (Join-Path $scriptsDir 'second.ts') -Value $sharedBlock -Encoding UTF8

        $configPath = Join-Path $tempRoot 'lint-config.json'
        @{
            scanPaths = @('scripts/**')
            excludePaths = @()
            scriptExtensions = @('.ts')
            templateExtensions = @()
            duplicateLiteralMinLines = 10
            suppressions = @(
                @{
                    rule = 'duplicate-literal'
                    files = @('scripts/first.ts', 'scripts/second.ts', 'scripts/absent.ts')
                }
            )
        } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configPath -Encoding UTF8

        $rawOutput = & $script:ShellPath -NoProfile -ExecutionPolicy Bypass -File $script:LintScript -FixtureRoot $tempRoot -ConfigPath $configPath -Strict 2>&1
        $exitCode = $LASTEXITCODE
        $output = $rawOutput | Out-String
        $exitCode | Should -Be 1
        $output | Should -Match 'duplicate-literal'
        $output | Should -Match '\[STRICT\]'
    }

    It 'checks suppressions before novelty reads and shares one base-file cache' {
        $source = Get-Content -LiteralPath $script:LintScript -Raw -Encoding UTF8
        $start = $source.IndexOf('function Find-DuplicateLiteralFindings')
        $end = $source.IndexOf('function Find-HeuristicDuplicateFindings')
        $start | Should -BeGreaterOrEqual 0
        $end | Should -BeGreaterThan $start
        $body = $source.Substring($start, $end - $start)

        $suppressionIndex = $body.IndexOf('if (Test-Suppressed -Config $Config -Rule $rule -Files $files) { continue }')
        $noveltyIndex = $body.IndexOf('if ($requireIntroduced)')
        $suppressionIndex | Should -BeGreaterOrEqual 0
        $suppressionIndex | Should -BeLessThan $noveltyIndex
        ([regex]::Matches($body, '\$baseLinesCache\s*=\s*@\{\}')).Count | Should -Be 1
    }

    It 'declares exactly the sixteen Issue 923 migration pairs without wildcards' {
        $configPath = Join-Path $script:RepoRoot 'scripts/lint-self-architect.config.json'
        $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $suppressions = @($config.suppressions | Where-Object { $_.rule -eq 'duplicate-literal' })
        $suppressions.Count | Should -Be 16

        $expectedLegacy = @(
            'docs/ao-0-10-review-api.mjs',
            'docs/autonomous-review-retry.mjs',
            'docs/events-optional-consumer-signal-recovery.d.mts',
            'docs/events-optional-consumer-signal-recovery.mjs',
            'docs/orchestrator-wake-filter.mjs',
            'docs/review-bulk-send-diagnose.mjs',
            'docs/review-finding-delivery-confirm.mjs',
            'docs/review-head-ready.mjs',
            'docs/review-producer-contract.mjs',
            'docs/review-send-reconcile.mjs',
            'docs/review-trigger-reconcile.mjs',
            'docs/review-wake-trigger.mjs',
            'docs/reviewer-failure-evidence-markers.mjs',
            'docs/worker-iteration-cycle.mjs',
            'docs/worker-message-dispatch-observe.mjs',
            'docs/worker-report-store.mjs'
        )
        $actualLegacy = @()
        foreach ($entry in $suppressions) {
            @($entry.files).Count | Should -Be 2
            ($entry.files -join "`n") | Should -Not -Match '[*?\[\]]'
            $legacy = @($entry.files | Where-Object { $_ -like 'docs/*.mjs' -or $_ -like 'docs/*.d.mts' })
            $terminalized = @($entry.files | Where-Object { $_ -like 'scripts/pr2-foundation/terminalized/*.ts' })
            $legacy.Count | Should -Be 1
            $terminalized.Count | Should -Be 1
            $actualLegacy += $legacy[0]
        }
        @(Compare-Object -ReferenceObject ($expectedLegacy | Sort-Object) -DifferenceObject ($actualLegacy | Sort-Object)).Count | Should -Be 0
    }



    It 'builds sliding windows without quadratic array concatenation' {
        $source = Get-Content -LiteralPath $script:LintScript -Raw -Encoding UTF8
        $start = $source.IndexOf('function Get-SlidingBlocks')
        $end = $source.IndexOf('function Get-RenameMap')
        $start | Should -BeGreaterOrEqual 0
        $end | Should -BeGreaterThan $start
        $body = $source.Substring($start, $end - $start)

        $body | Should -Match 'System\.Collections\.Generic\.List\[object\]'
        $body | Should -Match '\$blocks\.Add\('
        $body | Should -Not -Match '\$blocks\s*\+='
        $body | Should -Match 'return \$blocks\.ToArray\(\)'
    }

}
