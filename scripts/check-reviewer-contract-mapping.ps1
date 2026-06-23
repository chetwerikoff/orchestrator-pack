#requires -Version 5.1
<#
.SYNOPSIS
  Reviewer contract-mapping prompt/policy contract checks (Issue #362).
#>
param(
    [string]$RepoRoot
)

. (Join-Path $PSScriptRoot 'lib/Initialize-ReviewerPolicyCheck.ps1')
$Root = Initialize-ReviewerPolicyCheckRoot -RepoRoot $RepoRoot -ScriptRoot $PSScriptRoot
$failures = New-ReviewerPolicyCheckFailures
$helperPs1 = Join-Path $Root 'scripts/invoke-reviewer-contract-mapping.ps1'

$requiredPaths = @(
    (Join-Path $Root 'prompts/agent_rules.md'),
    (Join-Path $Root 'prompts/codex_review_prompt.md'),
    $helperPs1,
    (Join-Path $Root 'scripts/invoke-reviewer-contract-mapping.ts'),
    (Join-Path $Root 'scripts/lib/reviewer-contract-mapping.ts')
)
Test-ReviewerPolicyRequiredFiles -Root $Root -RequiredPaths $requiredPaths -Failures $failures

if ($failures.Count -eq 0) {
    $prompts = Get-ReviewerPolicyPromptTexts -Root $Root
    Test-ReviewerPolicyPromptPhrases -Label 'prompts/agent_rules.md' -Text $prompts.AgentRules -Failures $failures -RequiredPhrases @(
        'Contract-mapping pass (reviewers only)',
        'candidate evidence',
        'direct diff inspection',
        'invoke-reviewer-contract-mapping.ps1',
        '-LedgerFile',
        '-InvokeCoworker',
        'mapping_pending',
        'skipped_no_spec',
        'ambiguous_spec',
        'artifact_prep_failed',
        'skipped_input_limit',
        'stale_head',
        'stale_spec',
        '--paths',
        'untrusted data'
    )
    Test-ReviewerPolicyPromptPhrases -Label 'prompts/codex_review_prompt.md' -Text $prompts.CodexPrompt -Failures $failures -RequiredPhrases @(
        'Contract-mapping pass',
        'candidate evidence',
        'independently validate',
        'Do not make final review judgments',
        'invoke-reviewer-contract-mapping.ps1',
        '-LedgerFile',
        '-InvokeCoworker',
        'mapping_pending',
        'artifact_prep_failed',
        '--paths',
        'untrusted data'
    )

    foreach ($phrase in @(
            'coworker assigns severity',
            'coworker may approve',
            'coworker may reject',
            'positional arguments after --question'
        )) {
        if ($prompts.AgentRules -match [regex]::Escape($phrase) -or $prompts.CodexPrompt -match [regex]::Escape($phrase)) {
            $failures.Add("forbidden prompt phrase present: $phrase")
        }
    }
}

Push-Location $Root
try {
    if ($failures.Count -eq 0) {
        Invoke-ReviewerPolicyVitestSuite -Root $Root -TestFile 'scripts/reviewer-contract-mapping.test.ts' -Failures $failures
    }

    if ($failures.Count -eq 0) {
        $fixtureDiff = Join-Path $Root 'scripts/fixtures/reviewer-contract-mapping/large.diff'
        $fixtureIssue = Join-Path $Root 'scripts/fixtures/reviewer-contract-mapping/issue-with-acceptance.md'
        $tempBody = Join-Path ([System.IO.Path]::GetTempPath()) ("op362-prbody-" + [Guid]::NewGuid().ToString('n') + '.md')
        Set-Content -LiteralPath $tempBody -Value "Closes #362`n"
        try {
            $integrationOutput = & $helperPs1 -DiffFile $fixtureDiff -IssueFile $fixtureIssue -PrBodyFile $tempBody -ExplicitIssue 362 -PreflightOnly 2>&1 | Out-String
            if ($LASTEXITCODE -ne 0) {
                $failures.Add('invoke-reviewer-contract-mapping.ps1 integration fixture failed')
            }
            else {
                try {
                    $integration = $integrationOutput | ConvertFrom-Json
                }
                catch {
                    $integration = $null
                }
                if (-not $integration) {
                    $failures.Add('invoke-reviewer-contract-mapping.ps1 integration fixture did not return JSON')
                }
                elseif ($integration.status -ne 'mapping_pending') {
                    $failures.Add("invoke-reviewer-contract-mapping.ps1 integration fixture expected mapping_pending, got $($integration.status)")
                }
                elseif (-not $integration.shouldInvokeCoworker) {
                    $failures.Add('invoke-reviewer-contract-mapping.ps1 integration fixture expected shouldInvokeCoworker=true')
                }
                elseif (-not $integration.coworkerArgv -or $integration.coworkerArgv.Count -eq 0) {
                    $failures.Add('invoke-reviewer-contract-mapping.ps1 integration fixture expected invocable coworkerArgv')
                }
            }
        }
        finally {
            Remove-Item -LiteralPath $tempBody -Force -ErrorAction SilentlyContinue
        }
    }
}
finally {
    Pop-Location
}

Write-ReviewerPolicyCheckResult -Label 'reviewer contract-mapping' -Failures $failures
