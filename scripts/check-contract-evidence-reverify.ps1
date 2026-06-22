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
    (Join-Path $Root 'scripts/launch-contract-evidence-reverify.ps1'),
    (Join-Path $Root 'scripts/invoke-contract-evidence-reverify.ts'),
    (Join-Path $Root 'scripts/lib/contract-evidence-reverify.ts'),
    (Join-Path $Root 'scripts/contract-evidence-reverify-production-commands.json'),
    (Join-Path $Root 'scripts/bound-issue-snapshot-cli.ts'),
    (Join-Path $Root 'scripts/resolve-bound-issue-snapshot.ps1'),
    (Join-Path $Root 'scripts/lib/reverify-bound-issue-snapshot.ts'),
    (Join-Path $Root 'scripts/lib/reverify-allowlist-config.ts'),
    (Join-Path $Root 'scripts/lib/reviewer-ts-cli.ts'),
    (Join-Path $Root 'scripts/invoke-reviewer-contract-mapping.ps1')
)
Test-ReviewerPolicyRequiredFiles -Root $Root -RequiredPaths $requiredPaths -Failures $failures

if ($failures.Count -eq 0) {
    $prompts = Get-ReviewerPolicyPromptTexts -Root $Root
    Test-ReviewerPolicyPromptPhrases -Label 'prompts/agent_rules.md' -Text $prompts.AgentRules -Failures $failures -RequiredPhrases @(
        'Checkpoint-2 contract-evidence re-verification',
        'candidate evidence only',
        'launch-contract-evidence-reverify.ps1',
        'ReviewTargetRoot',
        'resolve-bound-issue-snapshot.ps1',
        'producer-verified',
        'verification-mode',
        'never auto-blocks',
        'compared-to-record'
    )
    Test-ReviewerPolicyPromptPhrases -Label 'prompts/codex_review_prompt.md' -Text $prompts.CodexPrompt -Failures $failures -RequiredPhrases @(
        'Checkpoint-2 contract-evidence re-verification',
        'candidate evidence only',
        'launch-contract-evidence-reverify.ps1',
        'ReviewTargetRoot',
        'resolve-bound-issue-snapshot.ps1',
        'producer-verified',
        'independently validate',
        'never auto-blocks'
    )
}

Push-Location $Root
try {
    if ($failures.Count -eq 0) {
        Invoke-ReviewerPolicyVitestSuite -Root $Root -TestFile 'scripts/reverify-allowlist-config.test.ts' -Failures $failures
    }

    if ($failures.Count -eq 0) {
        Invoke-ReviewerPolicyVitestSuite -Root $Root -TestFile 'scripts/reverify-bound-issue-snapshot.test.ts' -Failures $failures
    }

    if ($failures.Count -eq 0) {
        Invoke-ReviewerPolicyVitestSuite -Root $Root -TestFile 'scripts/contract-evidence-reverify.test.ts' -Failures $failures
    }

    if ($failures.Count -eq 0) {
        $liveE2e = ($env:OPK_REVERIFY_E2E_LIVE -eq '1') -or (-not [string]::IsNullOrWhiteSpace($env:OPK_REVERIFY_E2E_SESSION))
        if (-not $liveE2e) {
            Write-Host 'SKIP run-reviewer-reverify-e2e-fixture.mjs: set OPK_REVERIFY_E2E_LIVE=1 (and OPK_REVERIFY_E2E_SESSION) for live AC#13 e2e'
        }
        elseif (-not (Get-Command ao -ErrorAction SilentlyContinue)) {
            Write-Host 'SKIP run-reviewer-reverify-e2e-fixture.mjs: ao CLI not on PATH (AC#13 requires AO --execute reviewer path locally)'
        }
        else {
            & node --import tsx scripts/run-reviewer-reverify-e2e-fixture.mjs
            if ($LASTEXITCODE -ne 0) {
                $failures.Add('run-reviewer-reverify-e2e-fixture.mjs failed')
            }
        }
    }
}
finally {
    Pop-Location
}

Write-ReviewerPolicyCheckResult -Label 'contract-evidence-reverify' -Failures $failures
