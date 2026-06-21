#requires -Version 5.1
<#
.SYNOPSIS
  Reviewer checkpoint-2 contract-evidence re-verification checks (Issue #376).
#>
param(
    [string]$RepoRoot
)

. (Join-Path $PSScriptRoot 'lib/Initialize-ReviewerPolicyCheck.ps1')
$Root = Initialize-ReviewerPolicyCheckRoot -RepoRoot $RepoRoot -ScriptRoot $PSScriptRoot
$failures = New-ReviewerPolicyCheckFailures

$requiredPaths = @(
    (Join-Path $Root 'prompts/agent_rules.md'),
    (Join-Path $Root 'prompts/codex_review_prompt.md'),
    (Join-Path $Root 'scripts/invoke-contract-evidence-reverify.ps1'),
    (Join-Path $Root 'scripts/invoke-contract-evidence-reverify.ts'),
    (Join-Path $Root 'scripts/lib/contract-evidence-reverify.ts')
)
Test-ReviewerPolicyRequiredFiles -Root $Root -RequiredPaths $requiredPaths -Failures $failures

if ($failures.Count -eq 0) {
    $prompts = Get-ReviewerPolicyPromptTexts -Root $Root
    Test-ReviewerPolicyPromptPhrases -Label 'prompts/agent_rules.md' -Text $prompts.AgentRules -Failures $failures -RequiredPhrases @(
        'Checkpoint-2 contract-evidence re-verification',
        'candidate evidence only',
        'invoke-contract-evidence-reverify.ps1',
        'producer-verified',
        'verification-mode',
        'never auto-blocks',
        'compared-to-record'
    )
    Test-ReviewerPolicyPromptPhrases -Label 'prompts/codex_review_prompt.md' -Text $prompts.CodexPrompt -Failures $failures -RequiredPhrases @(
        'Checkpoint-2 contract-evidence re-verification',
        'candidate evidence only',
        'invoke-contract-evidence-reverify.ps1',
        'producer-verified',
        'independently validate',
        'never auto-blocks'
    )
}

Push-Location $Root
try {
    if ($failures.Count -eq 0) {
        Invoke-ReviewerPolicyVitestSuite -Root $Root -TestFile 'scripts/contract-evidence-reverify.test.ts' -Failures $failures
    }

    if ($failures.Count -eq 0) {
        if (Get-Command ao -ErrorAction SilentlyContinue) {
            & node --import tsx scripts/run-reviewer-reverify-e2e-fixture.mjs
            if ($LASTEXITCODE -ne 0) {
                $failures.Add('run-reviewer-reverify-e2e-fixture.mjs failed')
            }
        }
        else {
            Write-Host 'SKIP run-reviewer-reverify-e2e-fixture.mjs: ao CLI not on PATH (AC#13 requires AO --execute reviewer path locally)'
        }
    }
}
finally {
    Pop-Location
}

Write-ReviewerPolicyCheckResult -Label 'contract-evidence-reverify' -Failures $failures
