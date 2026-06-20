#requires -Version 5.1
<#
.SYNOPSIS
  Reviewer contract-mapping prompt/policy contract checks (Issue #362).
#>
param(
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$Root = if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    Split-Path -Parent $PSScriptRoot
} else {
    $RepoRoot
}

$failures = [System.Collections.Generic.List[string]]::new()

$agentRules = Join-Path $Root 'prompts/agent_rules.md'
$codexPrompt = Join-Path $Root 'prompts/codex_review_prompt.md'
$helperPs1 = Join-Path $Root 'scripts/invoke-reviewer-contract-mapping.ps1'
$helperTs = Join-Path $Root 'scripts/invoke-reviewer-contract-mapping.ts'
$library = Join-Path $Root 'scripts/lib/reviewer-contract-mapping.ts'

foreach ($required in @($agentRules, $codexPrompt, $helperPs1, $helperTs, $library)) {
    if (-not (Test-Path -LiteralPath $required)) {
        $failures.Add("missing required file: $required")
    }
}

if ($failures.Count -eq 0) {
    $agentText = Get-Content -LiteralPath $agentRules -Raw
    $codexText = Get-Content -LiteralPath $codexPrompt -Raw

    $requiredAgent = @(
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
    foreach ($phrase in $requiredAgent) {
        if ($agentText -notmatch [regex]::Escape($phrase)) {
            $failures.Add("prompts/agent_rules.md missing phrase: $phrase")
        }
    }

    $requiredCodex = @(
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
    foreach ($phrase in $requiredCodex) {
        if ($codexText -notmatch [regex]::Escape($phrase)) {
            $failures.Add("prompts/codex_review_prompt.md missing phrase: $phrase")
        }
    }

    $forbidden = @(
        'coworker assigns severity',
        'coworker may approve',
        'coworker may reject',
        'positional arguments after --question'
    )
    foreach ($phrase in $forbidden) {
        if ($agentText -match [regex]::Escape($phrase) -or $codexText -match [regex]::Escape($phrase)) {
            $failures.Add("forbidden prompt phrase present: $phrase")
        }
    }
}

Push-Location $Root
try {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        $failures.Add('npm required for reviewer-contract-mapping vitest suite')
    }
    elseif (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules'))) {
        & npm ci --include=dev | Out-Null
        if ($LASTEXITCODE -ne 0) {
            $failures.Add('npm ci failed before reviewer-contract-mapping tests')
        }
    }

    if ($failures.Count -eq 0) {
        & npx vitest run scripts/reviewer-contract-mapping.test.ts
        if ($LASTEXITCODE -ne 0) {
            $failures.Add('scripts/reviewer-contract-mapping.test.ts failed')
        }
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

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] reviewer contract-mapping checks:'
    foreach ($item in $failures) {
        Write-Host " - $item"
    }
    exit 1
}

Write-Host '[PASS] reviewer contract-mapping prompt/policy contracts and fixtures'
exit 0
