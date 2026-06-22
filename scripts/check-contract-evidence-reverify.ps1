#requires -Version 5.1
<#
.SYNOPSIS
  Reviewer checkpoint-2 contract-evidence re-verification checks (Issue #376).
#>
param(
    [string]$RepoRoot
)

. (Join-Path $PSScriptRoot 'lib/Initialize-ReviewerPolicyCheck.ps1')
. (Join-Path $PSScriptRoot 'lib/TrustedPackRoot-Common.ps1')
$Root = Initialize-ReviewerPolicyCheckRoot -RepoRoot $RepoRoot -ScriptRoot $PSScriptRoot
$failures = New-ReviewerPolicyCheckFailures

function Initialize-ReverifyCiTrustedPackRoot {
    param(
        [Parameter(Mandatory)]
        [string]$Root
    )

    if (-not [string]::IsNullOrWhiteSpace($env:OPK_TRUSTED_PACK_ROOT) -or -not [string]::IsNullOrWhiteSpace($env:AO_TRUSTED_PACK_ROOT)) {
        return
    }

    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_EVENT_NAME -ne 'pull_request') {
        return
    }

    if ([string]::IsNullOrWhiteSpace($env:GITHUB_BASE_REF)) {
        return
    }

    $launcherRelativePath = 'scripts/launch-contract-evidence-reverify.ps1'
    $runnerTemp = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
        [IO.Path]::GetTempPath()
    } else {
        $env:RUNNER_TEMP
    }
    $trustedRoot = Join-Path $runnerTemp 'opk-trusted-reverify-pack'
    if (Test-Path -LiteralPath (Join-Path $trustedRoot $launcherRelativePath)) {
        $env:OPK_TRUSTED_PACK_ROOT = $trustedRoot
        $env:AO_TRUSTED_PACK_ROOT = $trustedRoot
        return
    }

    Push-Location $Root
    try {
        git fetch --no-tags --prune --no-recurse-submodules --depth=1 origin $env:GITHUB_BASE_REF 2>$null
        if ($LASTEXITCODE -ne 0) {
            return
        }

        $baseSha = (git rev-parse 'FETCH_HEAD' 2>$null).Trim()
        if ([string]::IsNullOrWhiteSpace($baseSha)) {
            return
        }

        if (Test-Path -LiteralPath $trustedRoot) {
            Remove-Item -LiteralPath $trustedRoot -Recurse -Force -ErrorAction SilentlyContinue
        }

        git worktree add --detach $trustedRoot $baseSha 2>$null
        if ($LASTEXITCODE -ne 0) {
            return
        }

        if (Test-Path -LiteralPath (Join-Path $trustedRoot $launcherRelativePath)) {
            $env:OPK_TRUSTED_PACK_ROOT = $trustedRoot
            $env:AO_TRUSTED_PACK_ROOT = $trustedRoot
        }
    }
    finally {
        Pop-Location
    }
}

function Test-LiveReverifyE2eConfigured {
    if ($env:OPK_REVERIFY_E2E_LIVE -eq '1' -or $env:OPK_REVERIFY_E2E_LIVE -eq 'true') {
        return $true
    }
    if (-not [string]::IsNullOrWhiteSpace($env:OPK_REVERIFY_E2E_SESSION)) {
        return $true
    }
    return $false
}

function Test-ReverifyLauncherInCheckout {
    param(
        [Parameter(Mandatory)]
        [string]$Root
    )

    return Test-Path -LiteralPath (Join-Path $Root 'scripts/launch-contract-evidence-reverify.ps1')
}

function Invoke-ReverifyAc13E2eFixture {
    param(
        [Parameter(Mandatory)]
        [string]$Root,
        [System.Collections.Generic.List[string]]$Failures
    )

    Initialize-ReverifyCiTrustedPackRoot -Root $Root
    $env:OPK_REVERIFY_E2E_REQUIRED = '1'
    & node --import tsx scripts/run-reviewer-reverify-e2e-fixture.mjs
    if ($LASTEXITCODE -ne 0) {
        $Failures.Add('run-reviewer-reverify-e2e-fixture.mjs failed (AC#13 reviewer-flow e2e; verify ao CLI, trusted launcher bootstrap, and OPK_REVERIFY_E2E_LIVE/SESSION)')
    }
}

function Invoke-Ac13ReviewerFlowE2e {
    param(
        [Parameter(Mandatory)]
        [string]$Root,
        [System.Collections.Generic.List[string]]$Failures
    )

    if (-not (Test-ReverifyLauncherInCheckout -Root $Root)) {
        $Failures.Add('AC13 blocked: launch-contract-evidence-reverify.ps1 missing from checkout')
        return
    }

    if (Test-LiveReverifyE2eConfigured) {
        Invoke-ReverifyAc13E2eFixture -Root $Root -Failures $Failures
        return
    }

    if (Get-Command ao -ErrorAction SilentlyContinue) {
        $env:OPK_REVERIFY_E2E_LIVE = '1'
        if ([string]::IsNullOrWhiteSpace($env:OPK_REVERIFY_E2E_ALLOW_SPAWN)) {
            $env:OPK_REVERIFY_E2E_ALLOW_SPAWN = '1'
        }
        Invoke-ReverifyAc13E2eFixture -Root $Root -Failures $Failures
        return
    }

    if ($env:GITHUB_ACTIONS -eq 'true') {
        Write-Warning 'AC13 live ao review --execute skipped in CI (ao CLI unavailable); vitest AC13 fixture checks above are authoritative in GITHUB_ACTIONS'
        return
    }

    if ($env:OPK_REVERIFY_E2E_ALLOW_SKIP -eq '1') {
        Write-Warning 'AC13 live reviewer-flow e2e skipped locally (OPK_REVERIFY_E2E_ALLOW_SKIP=1); ao CLI not on PATH'
        return
    }

    Write-Warning 'AC13 live reviewer-flow e2e skipped locally (opt-in): set OPK_REVERIFY_E2E_LIVE=1 and OPK_REVERIFY_E2E_SESSION to exercise ao review --execute'
}

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
        Invoke-Ac13ReviewerFlowE2e -Root $Root -Failures $failures
    }
}
finally {
    Pop-Location
}

Write-ReviewerPolicyCheckResult -Label 'contract-evidence-reverify' -Failures $failures
