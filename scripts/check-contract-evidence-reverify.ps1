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

function Add-NpmGlobalBinToPath {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        return
    }

    $npmPrefix = (& npm prefix -g 2>$null).Trim()
    if ([string]::IsNullOrWhiteSpace($npmPrefix)) {
        return
    }

    $npmBin = Join-Path $npmPrefix 'bin'
    if (-not (Test-Path -LiteralPath $npmBin)) {
        return
    }

    $pathParts = @()
    if (-not [string]::IsNullOrWhiteSpace($env:PATH)) {
        $pathParts = $env:PATH -split [IO.Path]::PathSeparator
    }
    if ($pathParts -notcontains $npmBin) {
        $env:PATH = (@($npmBin) + $pathParts) -join [IO.Path]::PathSeparator
    }
}

function Ensure-GhAuthForReverifyE2e {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        return $false
    }

    & gh auth status 2>$null
    if ($LASTEXITCODE -eq 0) {
        return $true
    }

    $token = $env:GITHUB_TOKEN
    if ([string]::IsNullOrWhiteSpace($token)) {
        return $false
    }

    $savedGhToken = $env:GH_TOKEN
    $env:GH_TOKEN = $null
    try {
        $token | & gh auth login --with-token 2>$null
        return $LASTEXITCODE -eq 0
    }
    finally {
        if ($null -ne $savedGhToken) {
            $env:GH_TOKEN = $savedGhToken
        }
    }
}

function Write-ReverifyCiAgentOrchestratorYaml {
    param(
        [Parameter(Mandatory)]
        [string]$Root
    )

    $yamlPath = Join-Path $Root 'agent-orchestrator.yaml'
    if (Test-Path -LiteralPath $yamlPath) {
        return
    }

    $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
    $repoSlug = if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_REPOSITORY)) {
        $env:GITHUB_REPOSITORY
    } else {
        'chetwerikoff/orchestrator-pack'
    }
    $port = 3000 + ([Math]::Abs($resolvedRoot.GetHashCode()) % 500)

    @"
port: $port
defaults:
  runtime: process
  agent: opencode
projects:
  orchestrator-pack:
    repo: $repoSlug
    path: $resolvedRoot
    defaultBranch: main
    sessionPrefix: opk
    runtime: process
    agent: opencode
"@ | Set-Content -LiteralPath $yamlPath -Encoding utf8NoBOM
}

function Ensure-AoDaemonForReverifyE2e {
    param(
        [Parameter(Mandatory)]
        [string]$Root
    )

    if (-not (Get-Command ao -ErrorAction SilentlyContinue)) {
        return $false
    }

    $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
    & ao session ls 2>$null
    if ($LASTEXITCODE -eq 0) {
        return $true
    }

    & ao start $resolvedRoot --no-dashboard 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $false
    }

    foreach ($delaySeconds in @(2, 3, 5)) {
        Start-Sleep -Seconds $delaySeconds
        & ao session ls 2>$null
        if ($LASTEXITCODE -eq 0) {
            return $true
        }
    }

    return $false
}

function Ensure-AoCliForReverifyE2e {
    Add-NpmGlobalBinToPath
    if (Get-Command ao -ErrorAction SilentlyContinue) {
        return $true
    }
    if ($env:GITHUB_ACTIONS -ne 'true') {
        return $false
    }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        return $false
    }

    $npmGlobalRoot = if (-not [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
        Join-Path $env:RUNNER_TEMP 'npm-global'
    } else {
        Join-Path ([IO.Path]::GetTempPath()) 'opk-reverify-npm-global'
    }
    if (-not (Test-Path -LiteralPath $npmGlobalRoot)) {
        New-Item -ItemType Directory -Path $npmGlobalRoot -Force | Out-Null
    }
    $env:npm_config_prefix = $npmGlobalRoot
    Add-NpmGlobalBinToPath

    & npm install -g '@aoagents/ao' 2>$null
    Add-NpmGlobalBinToPath
    return $null -ne (Get-Command ao -ErrorAction SilentlyContinue)
}

function Initialize-ReverifyCiAoFixtureEnvironment {
    param(
        [Parameter(Mandatory)]
        [string]$Root
    )

    if ($env:GITHUB_ACTIONS -ne 'true') {
        return
    }

    Ensure-AoCliForReverifyE2e | Out-Null
    Ensure-GhAuthForReverifyE2e | Out-Null
    Write-ReverifyCiAgentOrchestratorYaml -Root $Root
    Ensure-AoDaemonForReverifyE2e -Root $Root | Out-Null
}

function Invoke-ReverifyAc13E2eFixture {
    param(
        [Parameter(Mandatory)]
        [string]$Root,
        [System.Collections.Generic.List[string]]$Failures
    )

    Initialize-ReverifyCiTrustedPackRoot -Root $Root
    Initialize-ReverifyCiAoFixtureEnvironment -Root $Root
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

    if ($env:GITHUB_ACTIONS -eq 'true') {
        if (-not (Get-Command ao -ErrorAction SilentlyContinue)) {
            Write-Warning 'AC13 live ao review --execute skipped in CI (ao CLI unavailable); vitest AC13 fixture checks above are authoritative in GITHUB_ACTIONS'
            return
        }
        $env:OPK_REVERIFY_E2E_LIVE = '1'
        if ([string]::IsNullOrWhiteSpace($env:OPK_REVERIFY_E2E_ALLOW_SPAWN)) {
            $env:OPK_REVERIFY_E2E_ALLOW_SPAWN = '1'
        }
        Invoke-ReverifyAc13E2eFixture -Root $Root -Failures $Failures
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
