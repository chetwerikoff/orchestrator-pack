#requires -Version 5.1
<#
.SYNOPSIS
  Reviewer checkpoint-2 contract-evidence re-verification checks (Issue #376).
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
$helperPs1 = Join-Path $Root 'scripts/invoke-contract-evidence-reverify.ps1'
$helperTs = Join-Path $Root 'scripts/invoke-contract-evidence-reverify.ts'
$library = Join-Path $Root 'scripts/lib/contract-evidence-reverify.ts'

foreach ($required in @($agentRules, $codexPrompt, $helperPs1, $helperTs, $library)) {
    if (-not (Test-Path -LiteralPath $required)) {
        $failures.Add("missing required file: $required")
    }
}

if ($failures.Count -eq 0) {
    $agentText = Get-Content -LiteralPath $agentRules -Raw
    $codexText = Get-Content -LiteralPath $codexPrompt -Raw

    $requiredAgent = @(
        'Checkpoint-2 contract-evidence re-verification',
        'candidate evidence only',
        'invoke-contract-evidence-reverify.ps1',
        'producer-verified',
        'verification-mode',
        'never auto-blocks',
        'compared-to-record'
    )
    foreach ($phrase in $requiredAgent) {
        if ($agentText -notmatch [regex]::Escape($phrase)) {
            $failures.Add("prompts/agent_rules.md missing phrase: $phrase")
        }
    }

    $requiredCodex = @(
        'Checkpoint-2 contract-evidence re-verification',
        'candidate evidence only',
        'invoke-contract-evidence-reverify.ps1',
        'producer-verified',
        'independently validate',
        'never auto-blocks'
    )
    foreach ($phrase in $requiredCodex) {
        if ($codexText -notmatch [regex]::Escape($phrase)) {
            $failures.Add("prompts/codex_review_prompt.md missing phrase: $phrase")
        }
    }
}

Push-Location $Root
try {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        $failures.Add('npm required for contract-evidence-reverify vitest suite')
    }
    elseif (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules'))) {
        & npm ci --include=dev | Out-Null
        if ($LASTEXITCODE -ne 0) {
            $failures.Add('npm ci failed before contract-evidence-reverify tests')
        }
    }

    if ($failures.Count -eq 0) {
        & npx vitest run scripts/contract-evidence-reverify.test.ts
        if ($LASTEXITCODE -ne 0) {
            $failures.Add('scripts/contract-evidence-reverify.test.ts failed')
        }
    }

    if ($failures.Count -eq 0) {
        & node --import tsx scripts/run-reviewer-reverify-e2e-fixture.mjs
        if ($LASTEXITCODE -ne 0) {
            $failures.Add('run-reviewer-reverify-e2e-fixture.mjs failed')
        }
    }
}
finally {
    Pop-Location
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] contract-evidence-reverify checks:'
    foreach ($failure in $failures) {
        Write-Host "  - $failure"
    }
    exit 1
}

Write-Host '[PASS] contract-evidence-reverify prompt/policy contracts and fixtures'
exit 0
