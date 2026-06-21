function Initialize-ReviewerPolicyCheckRoot {
    param(
        [string]$RepoRoot,
        [string]$ScriptRoot
    )

    if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
        return (Split-Path -Parent $ScriptRoot)
    }

    return $RepoRoot
}

function New-ReviewerPolicyCheckFailures {
    return [System.Collections.Generic.List[string]]::new()
}

function Test-ReviewerPolicyRequiredFiles {
    param(
        [string]$Root,
        [string[]]$RequiredPaths,
        [System.Collections.Generic.List[string]]$Failures
    )

    foreach ($required in $RequiredPaths) {
        if (-not (Test-Path -LiteralPath $required)) {
            $Failures.Add("missing required file: $required")
        }
    }
}

function Get-ReviewerPolicyPromptTexts {
    param([string]$Root)

    return @{
        AgentRules = Get-Content -LiteralPath (Join-Path $Root 'prompts/agent_rules.md') -Raw
        CodexPrompt = Get-Content -LiteralPath (Join-Path $Root 'prompts/codex_review_prompt.md') -Raw
    }
}

function Test-ReviewerPolicyPromptPhrases {
    param(
        [string]$Label,
        [string]$Text,
        [string[]]$RequiredPhrases,
        [System.Collections.Generic.List[string]]$Failures
    )

    foreach ($phrase in $RequiredPhrases) {
        if ($Text -notmatch [regex]::Escape($phrase)) {
            $Failures.Add("${Label} missing phrase: $phrase")
        }
    }
}

function Invoke-ReviewerPolicyVitestSuite {
    param(
        [string]$Root,
        [string]$TestFile,
        [System.Collections.Generic.List[string]]$Failures
    )

    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        $Failures.Add('npm required for reviewer policy vitest suite')
        return
    }

    if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules'))) {
        & npm ci --include=dev | Out-Null
        if ($LASTEXITCODE -ne 0) {
            $Failures.Add('npm ci failed before reviewer policy tests')
            return
        }
    }

    & npx vitest run $TestFile
    if ($LASTEXITCODE -ne 0) {
        $Failures.Add("$TestFile failed")
    }
}

function Write-ReviewerPolicyCheckResult {
    param(
        [string]$Label,
        [System.Collections.Generic.List[string]]$Failures
    )

    if ($Failures.Count -gt 0) {
        Write-Host "[FAIL] $Label checks:"
        foreach ($failure in $Failures) {
            Write-Host "  - $failure"
        }
        exit 1
    }

    Write-Host "[PASS] $Label prompt/policy contracts and fixtures"
    exit 0
}
