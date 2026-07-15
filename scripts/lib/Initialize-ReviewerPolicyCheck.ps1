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
    # Unary comma preserves the empty list; without it PowerShell enumerates the
    # return value and an empty List[string] becomes $null for the caller.
    return ,[System.Collections.Generic.List[string]]::new()
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
        AgentRules = Get-Content -LiteralPath (Join-Path $Root 'AGENTS.md') -Raw
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

    if ($IsWindows -or $env:OS -eq 'Windows_NT' -or -not (Get-Command bash -ErrorAction SilentlyContinue)) {
        & node (Join-Path $Root 'scripts/run-vitest-with-harness.mjs') 'run' $TestFile
    }
    else {
        Push-Location $Root
        try {
            $minimalEnvArgs = @(
                '-i',
                "PATH=$env:PATH",
                "HOME=$env:HOME",
                "TMPDIR=$env:TMPDIR",
                "TEMP=$env:TEMP",
                "TMP=$env:TMP",
                "OPK_REAL_PWSH=$env:OPK_REAL_PWSH"
            )
            & env @minimalEnvArgs bash '-lc' "node scripts/run-vitest-with-harness.mjs run '$TestFile'"
        }
        finally {
            Pop-Location
        }
    }
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
