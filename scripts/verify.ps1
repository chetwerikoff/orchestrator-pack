[CmdletBinding()]
param(
    [switch]$StrictPrereqs
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib/Get-VersionFromText.ps1')
$Root = Split-Path -Parent $PSScriptRoot
$Failures = New-Object System.Collections.Generic.List[string]
$Warnings = New-Object System.Collections.Generic.List[string]

function Write-Check {
    param(
        [string]$Name,
        [string]$Status,
        [string]$Detail = ''
    )
    $line = ('[{0}] {1}' -f $Status, $Name)
    if ($Detail) { $line = "$line - $Detail" }
    Write-Host $line
}

function Add-Failure {
    param([string]$Message)
    $Failures.Add($Message) | Out-Null
}

function Add-Warning {
    param([string]$Message)
    $Warnings.Add($Message) | Out-Null
}

function Test-CommandVersion {
    param(
        [string]$Command,
        [string[]]$VersionArgs = @('--version'),
        [version]$Minimum = $null,
        [switch]$Required,
        [switch]$Optional
    )

    $cmd = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $cmd) {
        $message = "$Command not found"
        if ($Required -and $StrictPrereqs) {
            Write-Check $Command 'FAIL' $message
            Add-Failure $message
        }
        else {
            Write-Check $Command 'WARN' $message
            Add-Warning $message
        }
        return $null
    }

    $output = @(& $Command @VersionArgs 2>&1)
    $exitCode = $LASTEXITCODE
    $text = (($output | Select-Object -First 3) -join ' ').Trim()
    if (-not $text) { $text = "exit=$exitCode" }

    if ($exitCode -ne 0) {
        $message = "$Command version command failed: $text"
        if ($Required -and $StrictPrereqs) {
            Write-Check $Command 'FAIL' $message
            Add-Failure $message
        }
        else {
            Write-Check $Command 'WARN' $message
            Add-Warning $message
        }
        return $null
    }

    $version = Get-VersionFromText $text
    if ($Minimum -and $version -and ($version -lt $Minimum)) {
        $message = "$text; minimum required is $Minimum"
        if ($StrictPrereqs) {
            Write-Check $Command 'FAIL' $message
            Add-Failure "$Command below minimum: $message"
        }
        else {
            Write-Check $Command 'WARN' $message
            Add-Warning "$Command below minimum: $message"
        }
        return $version
    }

    if ($Minimum -and -not $version) {
        Write-Check $Command 'WARN' "$text; could not parse version for minimum $Minimum"
        Add-Warning "$Command version parse failed"
        return $null
    }

    Write-Check $Command 'PASS' $text
    return $version
}

function Test-RequiredFile {
    param([string]$RelativePath)
    $path = Join-Path $Root $RelativePath
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        Write-Check $RelativePath 'PASS' 'present'
    }
    else {
        Write-Check $RelativePath 'FAIL' 'missing'
        Add-Failure "Missing file: $RelativePath"
    }
}

function Test-ContractMarkers {
    param(
        [string]$RelativePath,
        [string[]]$Markers
    )
    $path = Join-Path $Root $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Check $RelativePath 'FAIL' 'missing contract README'
        Add-Failure "Missing contract README: $RelativePath"
        return
    }

    $content = Get-Content -LiteralPath $path -Raw
    $missing = @()
    foreach ($marker in $Markers) {
        if ($content.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            $missing += $marker
        }
    }

    if ($missing.Count -eq 0) {
        Write-Check $RelativePath 'PASS' 'contract markers present'
    }
    else {
        Write-Check $RelativePath 'FAIL' ('missing markers: ' + ($missing -join ', '))
        Add-Failure "Contract $RelativePath missing markers: $($missing -join ', ')"
    }
}

Write-Host '== orchestrator-pack verify =='
Write-Host "Root: $Root"
Write-Host ''

Write-Host '== Tool versions =='
[void](Test-CommandVersion -Command 'node' -Minimum ([version]'20.0.0') -Required)
[void](Test-CommandVersion -Command 'git' -Minimum ([version]'2.25.0') -Required)
[void](Test-CommandVersion -Command 'gh' -Required)
[void](Test-CommandVersion -Command 'npm' -Required)
[void](Test-CommandVersion -Command 'ao' -Optional)
[void](Test-CommandVersion -Command 'cursor' -Optional)
[void](Test-CommandVersion -Command 'codex' -Optional)

Write-Host ''
Write-Host '== GitHub CLI auth =='
if (Get-Command gh -ErrorAction SilentlyContinue) {
    $authOutput = @(& gh auth status 2>&1)
    $authExit = $LASTEXITCODE
    if ($authExit -eq 0) {
        Write-Check 'gh auth status' 'PASS' 'authenticated'
    }
    else {
        $firstLine = (($authOutput | Select-Object -First 1) -join ' ').Trim()
        if (-not $firstLine) { $firstLine = 'not authenticated or unable to check auth status' }
        if ($StrictPrereqs) {
            Write-Check 'gh auth status' 'FAIL' $firstLine
            Add-Failure 'gh CLI is not authenticated'
        }
        else {
            Write-Check 'gh auth status' 'WARN' $firstLine
            Add-Warning 'gh CLI is not authenticated'
        }
    }
}
else {
    if ($StrictPrereqs) {
        Write-Check 'gh auth status' 'FAIL' 'gh not found'
        Add-Failure 'gh CLI not found; cannot check auth'
    }
    else {
        Write-Check 'gh auth status' 'WARN' 'gh not found'
        Add-Warning 'gh CLI not found; cannot check auth'
    }
}

Write-Host ''
Write-Host '== Pack structure =='
$requiredFiles = @(
    'README.md',
    '.gitignore',
    '.gitattributes',
    'docs/migration_notes.md',
    'docs/architecture.md',
    'docs/github_issues_cursor_codex_setup.md',
    'docs/repository_policy.md',
    'prompts/self_architect_check.md',
    'prompts/agent_rules.md',
    'plugins/README.md',
    'plugins/ao-task-declaration/README.md',
    'plugins/ao-scope-guard/README.md',
    'plugins/ao-token-chain-ledger/README.md',
    'plugins/ao-codex-pr-reviewer/README.md',
    'scripts/bootstrap.ps1',
    'scripts/verify.ps1',
    'scripts/check-reusable.ps1',
    'scripts/install-git-hooks.ps1',
    'scripts/lint-self-architect.ps1',
    'scripts/lint-self-architect.config.json',
    'agent-orchestrator.yaml.example',
    '.github/workflows/scope-guard.yml'
)
foreach ($file in $requiredFiles) { Test-RequiredFile $file }

Write-Host ''
Write-Host '== Prompt files =='
$promptDir = Join-Path $Root 'prompts'
$promptFiles = @()
if (Test-Path -LiteralPath $promptDir -PathType Container) {
    $promptFiles = @(Get-ChildItem -LiteralPath $promptDir -Filter '*.md' -File -ErrorAction SilentlyContinue)
}
if ($promptFiles.Count -ge 2) {
    Write-Check 'prompts/*.md' 'PASS' (('{0} prompt files found: {1}' -f $promptFiles.Count, (($promptFiles | ForEach-Object { $_.Name }) -join ', ')))
}
else {
    Write-Check 'prompts/*.md' 'FAIL' 'expected at least agent_rules.md and self_architect_check.md'
    Add-Failure 'Missing prompt markdown files'
}

Write-Host ''
Write-Host '== Plugin contract markers =='
Test-ContractMarkers 'plugins/ao-task-declaration/README.md' @('DD-026', 'DD-027', 'declared_files', 'denylist', 'one amendment', 'baseline')
Test-ContractMarkers 'plugins/ao-scope-guard/README.md' @('DD-024', 'runtime guard', 'git add', 'commit', 'PR-level CI', 'second line')
Test-ContractMarkers 'plugins/ao-token-chain-ledger/README.md' @('chain_id', 'planner', 'reviewer', 'worker', 'per-session cost', 'estimated_cost_usd')
Test-ContractMarkers 'plugins/ao-codex-pr-reviewer/README.md' @('Codex', 'gpt-5.5', 'PR review', 'GitHub Issues', 'no core patch')

Write-Host ''
Write-Host '== orchestratorRules quote safety =='
$rulesQuoteCheck = Join-Path $Root 'scripts/check-orchestrator-rules-quotes.ps1'
if (Test-Path -LiteralPath $rulesQuoteCheck -PathType Leaf) {
    & $rulesQuoteCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-orchestrator-rules-quotes.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-orchestrator-rules-quotes.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'orchestratorRules literal must not contain double-quote characters'
    }
}
else {
    Write-Check 'scripts/check-orchestrator-rules-quotes.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing orchestratorRules quote-safety check script'
}

Write-Host ''
Write-Host '== REVIEW_COMMAND preflight (Issue #60) =='
$reviewPreflightCheck = Join-Path $Root 'scripts/check-review-command-preflight.ps1'
if (Test-Path -LiteralPath $reviewPreflightCheck -PathType Leaf) {
    & $reviewPreflightCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-command-preflight.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-command-preflight.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'REVIEW_COMMAND must include dependency preflight (Issue #60)'
    }
}
else {
    Write-Check 'scripts/check-review-command-preflight.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing REVIEW_COMMAND preflight check script'
}

Write-Host ''
Write-Host '== orchestrator empty-review trap (Issue #75) =='
$emptyTrapCheck = Join-Path $Root 'scripts/check-orchestrator-review-empty-trap.ps1'
if (Test-Path -LiteralPath $emptyTrapCheck -PathType Leaf) {
    & $emptyTrapCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-orchestrator-review-empty-trap.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-orchestrator-review-empty-trap.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'orchestratorRules must document empty-review trap (Issue #75)'
    }
}
else {
    Write-Check 'scripts/check-orchestrator-review-empty-trap.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing empty-review trap check script'
}

Write-Host ''
Write-Host '== run-pack-review CLI args (Issue #60) =='
$runPackReviewArgsCheck = Join-Path $Root 'scripts/check-run-pack-review-args.ps1'
if (Test-Path -LiteralPath $runPackReviewArgsCheck -PathType Leaf) {
    & $runPackReviewArgsCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-run-pack-review-args.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-run-pack-review-args.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'run-pack-review.ps1 must parse --repo-root and --base'
    }
}
else {
    Write-Check 'scripts/check-run-pack-review-args.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing run-pack-review args check script'
}

Write-Host ''
Write-Host '== Worker launch-failure detection (Issue #63) =='
$launchFailureCheck = Join-Path $Root 'scripts/check-worker-launch-failure.ps1'
$launchFixtureDir = Join-Path $Root 'tests/fixtures/worker-launch-failure'
if ((Test-Path -LiteralPath $launchFailureCheck -PathType Leaf) -and
    (Test-Path -LiteralPath $launchFixtureDir -PathType Container)) {
    $fixtureCases = @(
        @{ Name = 'signature-a'; File = 'signature-a-pty.txt'; ExpectMatch = $true },
        @{ Name = 'signature-b'; File = 'signature-b-pty.txt'; ExpectMatch = $true },
        @{ Name = 'healthy-pty'; File = 'healthy-pty.txt'; ExpectMatch = $false }
    )
    foreach ($case in $fixtureCases) {
        $fixturePath = Join-Path $launchFixtureDir $case.File
        if ($case.ExpectMatch) {
            & $launchFailureCheck -FixturePath $fixturePath -ExpectMatch
        }
        else {
            & $launchFailureCheck -FixturePath $fixturePath -ExpectNoMatch
        }
        if ($LASTEXITCODE -ne 0) {
            Write-Check "worker-launch-failure/$($case.Name)" 'FAIL' "exit=$LASTEXITCODE"
            Add-Failure "Worker launch-failure fixture check failed: $($case.File)"
        }
        else {
            Write-Check "worker-launch-failure/$($case.Name)" 'PASS' 'completed'
        }
    }
    $quoteDense = Join-Path $launchFixtureDir 'quote-dense-issue-body.md'
    if (Test-Path -LiteralPath $quoteDense -PathType Leaf) {
        & $launchFailureCheck -FixturePath $quoteDense -ExpectNoMatch
        if ($LASTEXITCODE -ne 0) {
            Write-Check 'worker-launch-failure/quote-dense-body' 'FAIL' 'quote-dense body falsely matched launch failure'
            Add-Failure 'Quote-dense fixture must not trigger launch-failure detection'
        }
        else {
            Write-Check 'worker-launch-failure/quote-dense-body' 'PASS' 'no false positive on quotes'
        }
    }
}
else {
    Write-Check 'scripts/check-worker-launch-failure.ps1' 'FAIL' 'missing script or fixtures'
    Add-Failure 'Missing worker launch-failure check or fixtures'
}

Write-Host ''
Write-Host '== Reusable repository policy =='
$reusableCheck = Join-Path $Root 'scripts/check-reusable.ps1'
if (Test-Path -LiteralPath $reusableCheck -PathType Leaf) {
    & $reusableCheck -AllowNoGit
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-reusable.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-reusable.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Reusable repository policy check failed'
    }
}
else {
    Write-Check 'scripts/check-reusable.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing reusable repository policy check script'
}

Write-Host ''
Write-Host '== Summary =='
if ($Warnings.Count -gt 0) {
    Write-Host 'Warnings / missing non-strict prerequisites:'
    foreach ($warning in $Warnings) { Write-Host "- $warning" }
}
else {
    Write-Host 'Warnings: none'
}

if ($Failures.Count -gt 0) {
    Write-Host 'Failures:'
    foreach ($failure in $Failures) { Write-Host "- $failure" }
    exit 1
}

Write-Host 'Pack verification completed.'
exit 0
