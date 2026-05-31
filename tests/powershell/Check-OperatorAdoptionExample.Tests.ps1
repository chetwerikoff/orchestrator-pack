Describe 'scripts/check-operator-adoption-example.ps1' {
    BeforeAll {
        $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
        $script:CheckScript = Join-Path $script:RepoRoot 'scripts\check-operator-adoption-example.ps1'
    }

    It 'exists at the repository scripts path' {
        Test-Path -LiteralPath $script:CheckScript | Should -Be $true
    }

    It 'passes when example yaml is not in the diff' {
        & $script:CheckScript -ChangedPaths @('prompts/agent_rules.md') -PrBody ''
        $LASTEXITCODE | Should -Be 0
    }

    It 'passes when example and migration_notes both change' {
        & $script:CheckScript -ChangedPaths @(
            'agent-orchestrator.yaml.example',
            'docs/migration_notes.md'
        ) -PrBody ''
        $LASTEXITCODE | Should -Be 0
    }

    It 'passes when example changes with waiver line on its own in PR body' {
        $body = @"
## Summary
Closes #1

No operator adoption required
"@
        & $script:CheckScript -ChangedPaths @('agent-orchestrator.yaml.example') -PrBody $body
        $LASTEXITCODE | Should -Be 0
    }

    It 'fails when example changes without migration_notes or waiver' {
        & $script:CheckScript -ChangedPaths @('agent-orchestrator.yaml.example') -PrBody '## Summary'
        $LASTEXITCODE | Should -Be 1
    }

    It 'fails when waiver line is embedded in a sentence' {
        $body = 'No operator adoption required for this cosmetic comment-only edit.'
        & $script:CheckScript -ChangedPaths @('agent-orchestrator.yaml.example') -PrBody $body
        $LASTEXITCODE | Should -Be 1
    }
}
