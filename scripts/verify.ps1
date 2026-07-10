[CmdletBinding()]
param(
    [switch]$StrictPrereqs,
    [switch]$TestBackedSmoke
)

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host '[FAIL] orchestrator-pack scripts require PowerShell 7+ (pwsh). Windows PowerShell 5.1 is not supported.'
    Write-Host ("  Detected: {0} ({1})" -f $PSVersionTable.PSVersion, $PSVersionTable.PSEdition)
    Write-Host '  Install: https://aka.ms/powershell'
    exit 1
}

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib/Get-VersionFromText.ps1')
$Root = Split-Path -Parent $PSScriptRoot
$Failures = New-Object System.Collections.Generic.List[string]
$Warnings = New-Object System.Collections.Generic.List[string]

. (Join-Path $PSScriptRoot 'lib/Write-PackCheckLine.ps1')
function Write-Check {
    param(
        [string]$Name,
        [string]$Status,
        [string]$Detail = ''
    )
    Write-PackCheckLine -Name $Name -Status $Status -Detail $Detail
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
    'AGENTS.md',
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
if ($promptFiles.Count -ge 1) {
    Write-Check 'prompts/*.md' 'PASS' (('{0} prompt files found: {1}' -f $promptFiles.Count, (($promptFiles | ForEach-Object { $_.Name }) -join ', ')))
}
else {
    Write-Check 'prompts/*.md' 'FAIL' 'expected at least self_architect_check.md'
    Add-Failure 'Missing prompt markdown files'
}

Write-Host ''
Write-Host '== Plugin contract markers =='
Test-ContractMarkers 'plugins/ao-task-declaration/README.md' @('DD-026', 'DD-027', 'declared_files', 'denylist', 'one amendment', 'baseline')
Test-ContractMarkers 'plugins/ao-scope-guard/README.md' @('DD-024', 'runtime guard', 'git add', 'commit', 'PR-level CI', 'second line')
Test-ContractMarkers 'plugins/ao-token-chain-ledger/README.md' @('chain_id', 'planner', 'reviewer', 'worker', 'per-session cost', 'estimated_cost_usd')
Test-ContractMarkers 'plugins/ao-codex-pr-reviewer/README.md' @('Codex', 'gpt-5.5', 'PR review', 'GitHub Issues', 'no core patch')

Write-Host ''
Write-Host '== Operator adoption example guard (Issue #101) =='
$operatorAdoptionCheck = Join-Path $Root 'scripts/check-operator-adoption-example.ps1'
if (Test-Path -LiteralPath $operatorAdoptionCheck -PathType Leaf) {
    & $operatorAdoptionCheck -ChangedPaths @('AGENTS.md') -PrBody ''
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'operator-adoption/skip-no-example' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Operator adoption guard: expected pass when example not in diff'
    }
    else {
        Write-Check 'operator-adoption/skip-no-example' 'PASS' 'completed'
    }

    & $operatorAdoptionCheck -ChangedPaths @(
        'agent-orchestrator.yaml.example',
        'docs/migration_notes.md'
    ) -PrBody ''
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'operator-adoption/paired-migration-notes' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Operator adoption guard: expected pass when migration_notes in diff'
    }
    else {
        Write-Check 'operator-adoption/paired-migration-notes' 'PASS' 'completed'
    }

    $waiverBody = @"
## Summary

No operator adoption required
"@
    & $operatorAdoptionCheck -ChangedPaths @('agent-orchestrator.yaml.example') -PrBody $waiverBody
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'operator-adoption/waiver-line' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Operator adoption guard: expected pass for exact waiver line'
    }
    else {
        Write-Check 'operator-adoption/waiver-line' 'PASS' 'completed'
    }

    & $operatorAdoptionCheck -ChangedPaths @('agent-orchestrator.yaml.example') -PrBody '## Summary'
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'operator-adoption/missing-pairing' 'FAIL' 'expected failure without migration_notes or waiver'
        Add-Failure 'Operator adoption guard: expected fail when example changes without pairing'
    }
    else {
        Write-Check 'operator-adoption/missing-pairing' 'PASS' 'completed'
    }
}
else {
  Write-Check 'scripts/check-operator-adoption-example.ps1' 'FAIL' 'missing'
  Add-Failure 'Missing operator adoption example guard script (Issue #101)'
}

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
Write-Host '== orchestrator review-run idempotency (Issue #98) =='
$reviewIdempotencyCheck = Join-Path $Root 'scripts/check-orchestrator-review-idempotency.ps1'
if (Test-Path -LiteralPath $reviewIdempotencyCheck -PathType Leaf) {
    & $reviewIdempotencyCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-orchestrator-review-idempotency.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-orchestrator-review-idempotency.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'orchestratorRules must document review-run idempotency (Issue #98)'
    }
}
else {
    Write-Check 'scripts/check-orchestrator-review-idempotency.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing review-run idempotency check script (Issue #98)'
}

Write-Host ''
Write-Host '== orchestrator covered-head review idempotency (Issue #189) =='
$reviewHeadCoverageCheck = Join-Path $Root 'scripts/check-orchestrator-review-head-coverage.ps1'
if (Test-Path -LiteralPath $reviewHeadCoverageCheck -PathType Leaf) {
    & $reviewHeadCoverageCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-orchestrator-review-head-coverage.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-orchestrator-review-head-coverage.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'orchestratorRules must document covered-head idempotency (Issue #189)'
    }
}
else {
    Write-Check 'scripts/check-orchestrator-review-head-coverage.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing covered-head idempotency check script (Issue #189)'
}

Write-Host ''
Write-Host '== orchestrator head-ready review gate (Issue #195) =='
$reviewHeadReadyCheck = Join-Path $Root 'scripts/check-orchestrator-review-head-ready.ps1'
if (Test-Path -LiteralPath $reviewHeadReadyCheck -PathType Leaf) {
    & $reviewHeadReadyCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-orchestrator-review-head-ready.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-orchestrator-review-head-ready.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'orchestratorRules must document head-ready-for-review gate (Issue #195)'
    }
}
else {
    Write-Check 'scripts/check-orchestrator-review-head-ready.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing head-ready review gate check script (Issue #195)'
}

Write-Host ''
Write-Host '== report→head binding without report-stored SHA (Issue #218) =='
$reportBindingCheck = Join-Path $Root 'scripts/check-review-head-ready-report-binding.ps1'
if (Test-Path -LiteralPath $reportBindingCheck -PathType Leaf) {
    & $reportBindingCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-head-ready-report-binding.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-head-ready-report-binding.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Head-ready predicate must bind reports via observable state (Issue #218)'
    }
}
else {
    Write-Check 'scripts/check-review-head-ready-report-binding.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing report→head binding check script (Issue #218)'
}

Write-Host ''
Write-Host '== detached-HEAD PR context (Issue #98) =='
$autoReviewContextCheck = Join-Path $Root 'scripts/check-auto-review-pr-context.ps1'
if (Test-Path -LiteralPath $autoReviewContextCheck -PathType Leaf) {
    & $autoReviewContextCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-auto-review-pr-context.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-auto-review-pr-context.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Get-AutoReviewPrContext must resolve PR by headRefOid (Issue #98)'
    }
}
else {
    Write-Check 'scripts/check-auto-review-pr-context.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing detached-HEAD PR context check script (Issue #98)'
}

Write-Host ''
Write-Host '== review-trigger reconciliation (Issue #163) =='
$sessionPrBindingCheck = Join-Path $Root 'scripts/check-session-pr-binding-sole-path.ps1'
if (Test-Path -LiteralPath $sessionPrBindingCheck -PathType Leaf) {
    & $sessionPrBindingCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-session-pr-binding-sole-path.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-session-pr-binding-sole-path.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Session PR binding sole-path contract failed (Issue #699)'
    }
}
else {
    Write-Check 'scripts/check-session-pr-binding-sole-path.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing session PR binding sole-path check (Issue #699)'
}

$reviewReconcileCheck = Join-Path $Root 'scripts/check-review-trigger-reconcile.ps1'
if (Test-Path -LiteralPath $reviewReconcileCheck -PathType Leaf) {
    & $reviewReconcileCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-trigger-reconcile.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-trigger-reconcile.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'review-trigger reconciliation wiring checks failed (Issue #163)'
    }
}
else {
    Write-Check 'scripts/check-review-trigger-reconcile.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing review-trigger reconciliation check script (Issue #163)'
}

Write-Host ''
Write-Host '== CI-green worker wake (Issue #191) =='
$ciGreenWakeCheck = Join-Path $Root 'scripts/check-ci-green-wake-reconcile.ps1'
if (Test-Path -LiteralPath $ciGreenWakeCheck -PathType Leaf) {
    & $ciGreenWakeCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-ci-green-wake-reconcile.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-ci-green-wake-reconcile.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'CI-green worker wake wiring checks failed (Issue #191)'
    }
}
else {
    Write-Check 'scripts/check-ci-green-wake-reconcile.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing CI-green worker wake check script (Issue #191)'
}


Write-Host ''
Write-Host '== Dead-worker reconcile (Issue #593) =='
$deadWorkerCheck = Join-Path $Root 'scripts/check-dead-worker-reconcile.ps1'
if (Test-Path -LiteralPath $deadWorkerCheck -PathType Leaf) {
    & $deadWorkerCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-dead-worker-reconcile.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-dead-worker-reconcile.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Dead-worker reconcile wiring checks failed (Issue #593)'
    }
}
else {
    Write-Check 'scripts/check-dead-worker-reconcile.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing dead-worker reconcile check script (Issue #593)'
}

$respawnPolicyCheck = Join-Path $Root 'scripts/check-autonomous-respawn-policy.ps1'
if (Test-Path -LiteralPath $respawnPolicyCheck -PathType Leaf) {
    & $respawnPolicyCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-autonomous-respawn-policy.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-autonomous-respawn-policy.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Autonomous respawn policy checks failed (Issue #593)'
    }
}
else {
    Write-Check 'scripts/check-autonomous-respawn-policy.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing autonomous respawn policy check script (Issue #593)'
}

Write-Host ''
Write-Host '== CI-failure notification dedup (Issue #283) =='
$ciFailureNotifyCheck = Join-Path $Root 'scripts/check-ci-failure-notification.ps1'
if (Test-Path -LiteralPath $ciFailureNotifyCheck -PathType Leaf) {
    & $ciFailureNotifyCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-ci-failure-notification.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-ci-failure-notification.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'CI-failure notification dedup checks failed (Issue #283)'
    }
}
else {
    Write-Check 'scripts/check-ci-failure-notification.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing CI-failure notification dedup check script (Issue #283)'
}

$ciFailureReconcileCheck = Join-Path $Root 'scripts/check-ci-failure-notification-reconcile.ps1'
if (Test-Path -LiteralPath $ciFailureReconcileCheck -PathType Leaf) {
    & $ciFailureReconcileCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-ci-failure-notification-reconcile.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-ci-failure-notification-reconcile.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'CI-failure notification reconcile checks failed (Issue #342)'
    }
}
else {
    Write-Check 'scripts/check-ci-failure-notification-reconcile.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing CI-failure notification reconcile check script (Issue #342)'
}

Write-Host ''
Write-Host '== first-send review delivery reconcile (Issue #202) =='
$reviewSendCheck = Join-Path $Root 'scripts/check-review-send-reconcile.ps1'
if (Test-Path -LiteralPath $reviewSendCheck -PathType Leaf) {
    & $reviewSendCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-send-reconcile.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-send-reconcile.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'first-send review delivery reconcile checks failed (Issue #202)'
    }
}
else {
    Write-Check 'scripts/check-review-send-reconcile.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing first-send review delivery reconcile check script (Issue #202)'
}

Write-Host ''
Write-Host '== event-driven review wake trigger (Issue #207) =='
$reviewWakeTriggerCheck = Join-Path $Root 'scripts/check-review-wake-trigger.ps1'
if (Test-Path -LiteralPath $reviewWakeTriggerCheck -PathType Leaf) {
    & $reviewWakeTriggerCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-wake-trigger.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-wake-trigger.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'event-driven review wake trigger checks failed (Issue #207)'
    }
}
else {
    Write-Check 'scripts/check-review-wake-trigger.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing event-driven review wake trigger check script (Issue #207)'
}

Write-Host ''
Write-Host '== AO 0.10 review harness + trigger loop (Issue #623) =='
$ao010ReviewTriggerCheck = Join-Path $Root 'scripts/check-ao-0-10-review-trigger.ps1'
if (Test-Path -LiteralPath $ao010ReviewTriggerCheck -PathType Leaf) {
    & $ao010ReviewTriggerCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-ao-0-10-review-trigger.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-ao-0-10-review-trigger.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'AO 0.10 review harness + trigger loop checks failed (Issue #623)'
    }
}
else {
    Write-Check 'scripts/check-ao-0-10-review-trigger.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing AO 0.10 review harness + trigger loop check script (Issue #623)'
}

Write-Host ''
Write-Host '== AO 0.10 harness review bridge + [Pn] contract (Issue #658) =='
$harnessBridgeCheck = Join-Path $Root 'scripts/check-harness-review-bridge.ps1'
if (Test-Path -LiteralPath $harnessBridgeCheck -PathType Leaf) {
    & $harnessBridgeCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-harness-review-bridge.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-harness-review-bridge.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'AO 0.10 harness review bridge checks failed (Issue #658)'
    }
}
else {
    Write-Check 'scripts/check-harness-review-bridge.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing AO 0.10 harness review bridge check script (Issue #658)'
}

$harnessPostSubmitPnCheck = Join-Path $Root 'scripts/check-harness-post-submit-pn-content-shape.ps1'
if (Test-Path -LiteralPath $harnessPostSubmitPnCheck -PathType Leaf) {
    & $harnessPostSubmitPnCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-harness-post-submit-pn-content-shape.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-harness-post-submit-pn-content-shape.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Harness post-submit [Pn] content-shape checks failed (Issue #683)'
    }
}
else {
    Write-Check 'scripts/check-harness-post-submit-pn-content-shape.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing harness post-submit [Pn] content-shape check script (Issue #683)'
}


Write-Host ''
Write-Host '== AO 0.10 review producer data contract (Issue #626) =='
$ao010ReviewProducerCheck = Join-Path $Root 'scripts/check-review-producer-contract.ps1'
if (Test-Path -LiteralPath $ao010ReviewProducerCheck -PathType Leaf) {
    & $ao010ReviewProducerCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-producer-contract.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-producer-contract.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'AO 0.10 review producer data contract checks failed (Issue #626)'
    }
}
else {
    Write-Check 'scripts/check-review-producer-contract.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing AO 0.10 review producer data contract check script (Issue #626)'
}
Write-Host ''
Write-Host '== AO 0.10 stuck review-run reaper (Issue #624) =='
$ao010StuckReaperCheck = Join-Path $Root 'scripts/check-review-stuck-run-reaper.ps1'
if (Test-Path -LiteralPath $ao010StuckReaperCheck -PathType Leaf) {
    & $ao010StuckReaperCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-stuck-run-reaper.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-stuck-run-reaper.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'AO 0.10 stuck review-run reaper checks failed (Issue #624)'
    }
}
else {
    Write-Check 'scripts/check-review-stuck-run-reaper.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing AO 0.10 stuck review-run reaper check script (Issue #624)'
}

Write-Host ''
Write-Host '== AO 0.10 review vocabulary (Issue #625) =='
$review010VocabularyCheck = Join-Path $Root 'scripts/check-review-010-vocabulary.ps1'
if (Test-Path -LiteralPath $review010VocabularyCheck -PathType Leaf) {
    & $review010VocabularyCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-010-vocabulary.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-010-vocabulary.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'AO 0.10 review vocabulary checks failed (Issue #625)'
    }
}
else {
    Write-Check 'scripts/check-review-010-vocabulary.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing AO 0.10 review vocabulary check script (Issue #625)'
}

Write-Host ''
Write-Host '== deferred-head review re-evaluation (Issue #235) =='
$reviewReadyReportStateSeedCheck = Join-Path $Root 'scripts/check-review-ready-report-state-seed.ps1'
$seedSnapshotEconomyCheck = Join-Path $Root 'scripts/check-seed-snapshot-failure-bounded-read-economy.ps1'
if (Test-Path -LiteralPath $seedSnapshotEconomyCheck -PathType Leaf) {
    & $seedSnapshotEconomyCheck
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'scripts/check-seed-snapshot-failure-bounded-read-economy.ps1' 'FAIL' "exit=$LASTEXITCODE"
        $script:VerifyFailed = $true
    }
    else {
        Write-Check 'scripts/check-seed-snapshot-failure-bounded-read-economy.ps1' 'PASS' 'completed'
    }
}
else {
    Write-Check 'scripts/check-seed-snapshot-failure-bounded-read-economy.ps1' 'FAIL' 'missing'
    $script:VerifyFailed = $true
}

if (Test-Path -LiteralPath $reviewReadyReportStateSeedCheck -PathType Leaf) {
    & $reviewReadyReportStateSeedCheck
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'scripts/check-review-ready-report-state-seed.ps1' 'FAIL' "exit=$LASTEXITCODE"
        $script:VerifyFailed = $true
    }
    else {
        Write-Check 'scripts/check-review-ready-report-state-seed.ps1' 'PASS' 'completed'
    }
}
else {
    Write-Check 'scripts/check-review-ready-report-state-seed.ps1' 'FAIL' 'missing'
    $script:VerifyFailed = $true
}

$reviewStatusConsumerCheck = Join-Path $Root 'scripts/check-review-status-consumers.ps1'
if (Test-Path -LiteralPath $reviewStatusConsumerCheck -PathType Leaf) {
    & $reviewStatusConsumerCheck
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'scripts/check-review-status-consumers.ps1' 'FAIL' "exit=$LASTEXITCODE"
        $script:VerifyFailed = $true
    }
    else {
        Write-Check 'scripts/check-review-status-consumers.ps1' 'PASS' 'completed'
    }
}
else {
    Write-Check 'scripts/check-review-status-consumers.ps1' 'FAIL' 'missing'
    $script:VerifyFailed = $true
}



Write-Host '== pack worker report contract (Issue #717) =='
foreach ($check in @(
        @{ path = 'scripts/check-agents-report-contract.ps1'; label = 'agents report contract' },
        @{ path = 'scripts/check-no-report-audit-bind.ps1'; label = 'no report-audit bind' }
    )) {
    $full = Join-Path $Root $check.path
    if (Test-Path -LiteralPath $full -PathType Leaf) {
        & $full
        if ($LASTEXITCODE -ne 0) {
            Write-Check $check.path 'FAIL' "exit=$LASTEXITCODE"
            $script:VerifyFailed = $true
        }
        else {
            Write-Check $check.path 'PASS' $check.label
        }
    }
    else {
        Write-Check $check.path 'FAIL' 'missing'
        $script:VerifyFailed = $true
    }
}

Write-Host '== review-cycle cap (Issue #646) =='
$reviewCycleCapCheck = Join-Path $Root 'scripts/check-review-cycle-cap.ps1'
if (Test-Path -LiteralPath $reviewCycleCapCheck -PathType Leaf) {
    & $reviewCycleCapCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-cycle-cap.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-cycle-cap.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'review-cycle cap checks failed (Issue #646)'
    }
}
else {
    Write-Check 'scripts/check-review-cycle-cap.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing review-cycle cap check script (Issue #646)'
}

Write-Host '== merge triage gate (Issue #648) =='
$mergeTriageCheck = Join-Path $Root 'scripts/check-merge-triage-gate.ps1'
if (Test-Path -LiteralPath $mergeTriageCheck -PathType Leaf) {
    & $mergeTriageCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-merge-triage-gate.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-merge-triage-gate.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'merge triage gate checks failed (Issue #648)'
    }
}
else {
    Write-Check 'scripts/check-merge-triage-gate.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing merge triage gate check script (Issue #648)'
}

$reviewTriggerReevalCheck = Join-Path $Root 'scripts/check-review-trigger-reeval.ps1'
if (Test-Path -LiteralPath $reviewTriggerReevalCheck -PathType Leaf) {
    & $reviewTriggerReevalCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-trigger-reeval.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-trigger-reeval.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'deferred-head review re-evaluation checks failed (Issue #235)'
    }
}
else {
    Write-Check 'scripts/check-review-trigger-reeval.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing deferred-head review re-evaluation check script (Issue #235)'
}

Write-Host ''
Write-Host '== review-finding delivery confirmation (Issue #171) =='
$deliveryConfirmCheck = Join-Path $Root 'scripts/check-review-finding-delivery-confirm.ps1'
if (Test-Path -LiteralPath $deliveryConfirmCheck -PathType Leaf) {
    & $deliveryConfirmCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-finding-delivery-confirm.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-finding-delivery-confirm.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'review-finding delivery confirmation checks failed (Issue #171)'
    }
}
else {
    Write-Check 'scripts/check-review-finding-delivery-confirm.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing review-finding delivery confirmation check script (Issue #171)'
}

Write-Host '== scripted review confirmed-delivery gate (Issue #669) =='
$scriptedDeliveryGateCheck = Join-Path $Root 'scripts/check-scripted-review-confirmed-delivery-gate.ps1'
if (Test-Path -LiteralPath $scriptedDeliveryGateCheck -PathType Leaf) {
    & $scriptedDeliveryGateCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-scripted-review-confirmed-delivery-gate.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-scripted-review-confirmed-delivery-gate.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'scripted review confirmed-delivery gate checks failed (Issue #669)'
    }
}
else {
    Write-Check 'scripts/check-scripted-review-confirmed-delivery-gate.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing scripted review confirmed-delivery gate check script (Issue #669)'
}

Write-Host '== review delivery stdout-first guard (Issue #718) =='
$reviewDeliveryStdoutCheck = Join-Path $Root 'scripts/check-review-delivery-no-visibility-poll.ps1'
if (Test-Path -LiteralPath $reviewDeliveryStdoutCheck -PathType Leaf) {
    & pwsh -NoProfile -File $reviewDeliveryStdoutCheck
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'scripts/check-review-delivery-no-visibility-poll.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'review delivery stdout-first guard failed (Issue #718)'
    }
    else {
        Write-Check 'scripts/check-review-delivery-no-visibility-poll.ps1' 'PASS' 'completed'
    }
}
else {
    Write-Check 'scripts/check-review-delivery-no-visibility-poll.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing review delivery stdout-first guard (Issue #718)'
}

Write-Host ''
Write-Host '== worker message submit reconcile (Issue #232) =='
$workerSubmitCheck = Join-Path $Root 'scripts/check-worker-message-submit-reconcile.ps1'
if (Test-Path -LiteralPath $workerSubmitCheck -PathType Leaf) {
    & $workerSubmitCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-worker-message-submit-reconcile.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-worker-message-submit-reconcile.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'worker message submit reconcile checks failed (Issue #232)'
    }
}
else {
    Write-Check 'scripts/check-worker-message-submit-reconcile.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing worker message submit reconcile check script (Issue #232)'
}

Write-Host ''
Write-Host '== side-process state round-trip coverage (Issue #248) =='
$stateCoverageCheck = Join-Path $Root 'scripts/check-side-process-state-coverage.ps1'
if (Test-Path -LiteralPath $stateCoverageCheck -PathType Leaf) {
    & $stateCoverageCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-side-process-state-coverage.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-side-process-state-coverage.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'side-process state coverage checks failed (Issue #248)'
    }
}
else {
    Write-Check 'scripts/check-side-process-state-coverage.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing side-process state coverage check script (Issue #248)'
}

Write-Host ''
Write-Host '== side-process launch-contract guard (Issue #659) =='
$launchContractCheck = Join-Path $Root 'scripts/check-side-process-launch-contract.ps1'
if (Test-Path -LiteralPath $launchContractCheck -PathType Leaf) {
    & $launchContractCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-side-process-launch-contract.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-side-process-launch-contract.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'side-process launch-contract guard failed (Issue #659)'
    }

    & $launchContractCheck -SelfTest
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-side-process-launch-contract.ps1 -SelfTest' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-side-process-launch-contract.ps1 -SelfTest' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'side-process launch-contract guard self-test failed (Issue #659)'
    }
}
else {
    Write-Check 'scripts/check-side-process-launch-contract.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing side-process launch-contract guard (Issue #659)'
}

Write-Host ''
Write-Host '== wake-supervisor fleet doc coverage (Issue #702) =='
$fleetDocCoverageCheck = Join-Path $Root 'scripts/check-wake-supervisor-fleet-doc-coverage.ps1'
if (Test-Path -LiteralPath $fleetDocCoverageCheck -PathType Leaf) {
    & $fleetDocCoverageCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-wake-supervisor-fleet-doc-coverage.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-wake-supervisor-fleet-doc-coverage.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'wake-supervisor fleet doc coverage guard failed (Issue #702)'
    }
}
else {
    Write-Check 'scripts/check-wake-supervisor-fleet-doc-coverage.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing wake-supervisor fleet doc coverage guard (Issue #702)'
}

Write-Host ''
Write-Host '== launch-argv contract inventory (Issue #661) =='
$launchArgvInventoryCheck = Join-Path $Root 'scripts/check-launch-argv-inventory.ps1'
if (Test-Path -LiteralPath $launchArgvInventoryCheck -PathType Leaf) {
    & $launchArgvInventoryCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-launch-argv-inventory.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-launch-argv-inventory.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'launch-argv inventory guard failed (Issue #661)'
    }
}
else {
    Write-Check 'scripts/check-launch-argv-inventory.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing launch-argv inventory guard (Issue #661)'
}

Write-Host ''
Write-Host '== review bulk-send / stuck-open diagnostic (Issue #140) =='
$bulkSendDiagCheck = Join-Path $Root 'scripts/check-review-bulk-send-diagnose.ps1'
if (Test-Path -LiteralPath $bulkSendDiagCheck -PathType Leaf) {
    & $bulkSendDiagCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-bulk-send-diagnose.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-bulk-send-diagnose.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'review bulk-send diagnostic checks failed (Issue #140)'
    }
}
else {
    Write-Check 'scripts/check-review-bulk-send-diagnose.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing review bulk-send diagnostic check script (Issue #140)'
}

Write-Host ''
Write-Host '== terminal mux flood detection (Issue #173) =='
$fleetHygieneCheck = Join-Path $Root 'scripts/check-fleet-hygiene-sentinel.ps1'
if (Test-Path -LiteralPath $fleetHygieneCheck) {
    & pwsh -NoProfile -File $fleetHygieneCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-fleet-hygiene-sentinel.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-fleet-hygiene-sentinel.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'fleet hygiene sentinel static guard failed (Issue #711)'
    }
}
else {
    Write-Check 'scripts/check-fleet-hygiene-sentinel.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing fleet hygiene sentinel static guard (Issue #711)'
}

$cursorAgentTuiShimCheck = Join-Path $Root 'scripts/check-cursor-agent-tui-shim.ps1'
if (Test-Path -LiteralPath $cursorAgentTuiShimCheck -PathType Leaf) {
    & pwsh -NoProfile -File $cursorAgentTuiShimCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-cursor-agent-tui-shim.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-cursor-agent-tui-shim.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'cursor-agent TUI shim fixture checks failed (Issue #725)'
    }
}
else {
    Write-Check 'scripts/check-cursor-agent-tui-shim.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing cursor-agent TUI shim check script (Issue #725)'
}

$terminalFloodCheck = Join-Path $Root 'scripts/check-terminal-flood-detect.ps1'
if (Test-Path -LiteralPath $terminalFloodCheck -PathType Leaf) {
    & $terminalFloodCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-terminal-flood-detect.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-terminal-flood-detect.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'terminal mux flood detection checks failed (Issue #173)'
    }
}
else {
    Write-Check 'scripts/check-terminal-flood-detect.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing terminal flood detection check script (Issue #173)'
}

Write-Host ''
Write-Host '== review-ready worker stuck guard (Issue #174) =='
$stuckGuardCheck = Join-Path $Root 'scripts/check-review-ready-stuck-guard.ps1'
if (Test-Path -LiteralPath $stuckGuardCheck -PathType Leaf) {
    & $stuckGuardCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-ready-stuck-guard.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-ready-stuck-guard.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'review-ready worker stuck guard checks failed (Issue #174)'
    }
}
else {
    Write-Check 'scripts/check-review-ready-stuck-guard.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing review-ready worker stuck guard check script (Issue #174)'
}

Write-Host ''
Write-Host '== reviewer workspace preflight (Issue #98) =='
$reviewerWorkspaceCheck = Join-Path $Root 'scripts/check-reviewer-workspace-preflight.ps1'
if (Test-Path -LiteralPath $reviewerWorkspaceCheck -PathType Leaf) {
    & $reviewerWorkspaceCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-reviewer-workspace-preflight.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-reviewer-workspace-preflight.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'reviewer-workspace-preflight must clear orphan directories (Issue #98)'
    }
}
else {
    Write-Check 'scripts/check-reviewer-workspace-preflight.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing reviewer workspace preflight check script (Issue #98)'
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
Write-Host '== PACK_REVIEWER selector and entrypoint (Issue #86) =='
$selectorCheck = Join-Path $Root 'scripts/check-pack-reviewer-selector.ps1'
if (Test-Path -LiteralPath $selectorCheck -PathType Leaf) {
    & $selectorCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-pack-reviewer-selector.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-pack-reviewer-selector.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'PACK_REVIEWER selector and invoke-pack-review entrypoint checks failed (Issue #86)'
    }
}
else {
    Write-Check 'scripts/check-pack-reviewer-selector.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing PACK_REVIEWER selector check script (Issue #86)'
}

Write-Host ''
Write-Host '== PACK_REVIEWER persistent-env fallback (Issue #106) =='
$persistentEnvCheck = Join-Path $Root 'scripts/check-pack-reviewer-persistent-env.ps1'
if (Test-Path -LiteralPath $persistentEnvCheck -PathType Leaf) {
    & $persistentEnvCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-pack-reviewer-persistent-env.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-pack-reviewer-persistent-env.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'PACK_REVIEWER persistent-env fallback checks failed (Issue #106)'
    }
}
else {
    Write-Check 'scripts/check-pack-reviewer-persistent-env.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing PACK_REVIEWER persistent-env check script (Issue #106)'
}

Write-Host ''
Write-Host '== Strict review gate fixtures (Issue #79) =='
$strictGate = Join-Path $Root 'scripts/invoke-pack-review-strict-gate.ps1'
$aoCommandCheck = Join-Path $Root 'scripts/check-review-command-not-ao.ps1'
if ((Test-Path -LiteralPath $strictGate -PathType Leaf) -and
    (Test-Path -LiteralPath $aoCommandCheck -PathType Leaf)) {
    & $strictGate
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/invoke-pack-review-strict-gate.ps1' 'PASS' 'fixture gate completed'
    }
    else {
        Write-Check 'scripts/invoke-pack-review-strict-gate.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Strict review gate failed on committed fixtures (Issue #79)'
    }

    & $aoCommandCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-command-not-ao.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-command-not-ao.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Example REVIEW_COMMAND must not use .ao/ as canonical path (Issue #79)'
    }
}
else {
    Write-Check 'strict review gate scripts' 'FAIL' 'missing gate or .ao check'
    Add-Failure 'Missing strict review gate scripts (Issue #79)'
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
Write-Host '== Orchestrator launch-failure detection (Issue #91) =='
$orchLaunchCheck = Join-Path $Root 'scripts/check-orchestrator-launch-failure.ps1'
$orchLaunchFixtureDir = Join-Path $Root 'tests/fixtures/orchestrator-launch-failure'
if ((Test-Path -LiteralPath $orchLaunchCheck -PathType Leaf) -and
    (Test-Path -LiteralPath $orchLaunchFixtureDir -PathType Container)) {
    $orchFixtureCases = @(
        @{ Name = 'signature-a'; File = 'signature-a-pty.txt'; ExpectMatch = $true },
        @{ Name = 'signature-b'; File = 'signature-b-pty.txt'; ExpectMatch = $true },
        @{ Name = 'healthy-pty'; File = 'healthy-pty.txt'; ExpectMatch = $false }
    )
    foreach ($case in $orchFixtureCases) {
        $fixturePath = Join-Path $orchLaunchFixtureDir $case.File
        if ($case.ExpectMatch) {
            & $orchLaunchCheck -FixturePath $fixturePath -ExpectMatch
        }
        else {
            & $orchLaunchCheck -FixturePath $fixturePath -ExpectNoMatch
        }
        if ($LASTEXITCODE -ne 0) {
            Write-Check "orchestrator-launch-failure/$($case.Name)" 'FAIL' "exit=$LASTEXITCODE"
            Add-Failure "Orchestrator launch-failure fixture check failed: $($case.File)"
        }
        else {
            Write-Check "orchestrator-launch-failure/$($case.Name)" 'PASS' 'completed'
        }
    }
}
else {
    Write-Check 'scripts/check-orchestrator-launch-failure.ps1' 'FAIL' 'missing script or fixtures'
    Add-Failure 'Missing orchestrator launch-failure check or fixtures'
}

Write-Host ''
Write-Host '== Coworker RTK passthrough static guard (Issue #145) =='
$rtkPassthroughCheck = Join-Path $Root 'scripts/check-rtk-passthrough-static.ps1'
if (Test-Path -LiteralPath $rtkPassthroughCheck -PathType Leaf) {
    & $rtkPassthroughCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-rtk-passthrough-static.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-rtk-passthrough-static.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'RTK passthrough static guard failed (Issue #145)'
    }
}
else {
    Write-Check 'scripts/check-rtk-passthrough-static.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing RTK passthrough static guard script (Issue #145)'
}

Write-Host ''
Write-Host '== gh wrapper static guards (Issue #431) =='
$ghWrapperCheck = Join-Path $Root 'scripts/check-gh-wrapper.ps1'
if (Test-Path -LiteralPath $ghWrapperCheck -PathType Leaf) {
    & $ghWrapperCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-gh-wrapper.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-gh-wrapper.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'gh wrapper wiring check failed (Issue #431)'
    }
}
else {
    Write-Check 'scripts/check-gh-wrapper.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing gh wrapper check script (Issue #431)'
}

$ghInventoryCheck = Join-Path $Root 'scripts/check-gh-inventory-static.ps1'
if (Test-Path -LiteralPath $ghInventoryCheck -PathType Leaf) {
    & $ghInventoryCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-gh-inventory-static.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-gh-inventory-static.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'gh inventory static guard failed (Issue #431)'
    }
}
else {
    Write-Check 'scripts/check-gh-inventory-static.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing gh inventory static guard (Issue #431)'
}

Write-Host ''
Write-Host '== PowerShell $Pid parameter static guard (Issue #534) =='
$powershellPidParamCheck = Join-Path $Root 'scripts/check-powershell-pid-param-static.ps1'
if (Test-Path -LiteralPath $powershellPidParamCheck -PathType Leaf) {
    & $powershellPidParamCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-powershell-pid-param-static.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-powershell-pid-param-static.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'PowerShell $Pid parameter static guard failed (Issue #534)'
    }
}
else {
    Write-Check 'scripts/check-powershell-pid-param-static.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing PowerShell $Pid parameter static guard (Issue #534)'
}

Write-Check 'verify-runtime/gh-wrapper-vitest' 'SKIP' 'owned by scripts/check-gh-wrapper.ps1 + full Vitest lane (Issue #488)'


Write-Host ''
Write-Host '== wake-supervisor gh PATH guard (Issue #447) =='
$wakeSupervisorGhPathCheck = Join-Path $Root 'scripts/check-orchestrator-wake-supervisor-gh-path.ps1'
if (Test-Path -LiteralPath $wakeSupervisorGhPathCheck -PathType Leaf) {
    & $wakeSupervisorGhPathCheck
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'scripts/check-orchestrator-wake-supervisor-gh-path.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'wake-supervisor gh PATH guard failed (Issue #447)'
    }
    else {
        Write-Check 'scripts/check-orchestrator-wake-supervisor-gh-path.ps1' 'PASS' 'completed'
    }
}
else {
    Write-Check 'scripts/check-orchestrator-wake-supervisor-gh-path.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing wake-supervisor gh PATH guard (Issue #447)'
}

Write-Host ''

Write-Host ''
Write-Host '== github fleet inventory cache (Issue #453) =='
$fleetCacheBypassCheck = Join-Path $Root 'scripts/check-github-fleet-cache-bypass.ps1'
if (Test-Path -LiteralPath $fleetCacheBypassCheck -PathType Leaf) {
    & $fleetCacheBypassCheck
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'scripts/check-github-fleet-cache-bypass.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'github fleet cache bypass guard failed (Issue #453)'
    }
    else {
        Write-Check 'scripts/check-github-fleet-cache-bypass.ps1' 'PASS' 'completed'
    }
}
else {
    Write-Check 'scripts/check-github-fleet-cache-bypass.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing github fleet cache bypass guard (Issue #453)'
}

Write-Check 'verify-runtime/github-fleet-cache-vitest' 'SKIP' 'owned by check-github-fleet-cache-bypass.ps1 + full Vitest lane (Issue #488)'

Write-Host ''
Write-Host '== audit retention guarded dot-source (Issue #610) =='
$auditRetentionGuardedDotSourceCheck = Join-Path $Root 'scripts/check-audit-retention-guarded-dotsource.ps1'
if (Test-Path -LiteralPath $auditRetentionGuardedDotSourceCheck -PathType Leaf) {
    & $auditRetentionGuardedDotSourceCheck
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'scripts/check-audit-retention-guarded-dotsource.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'audit retention guarded dot-source regression failed (Issue #610)'
    }
    else {
        Write-Check 'scripts/check-audit-retention-guarded-dotsource.ps1' 'PASS' 'completed'
    }
}
else {
    Write-Check 'scripts/check-audit-retention-guarded-dotsource.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing audit retention guarded dot-source regression (Issue #610)'
}

Write-Host '== github fleet shared API governor (Issue #585) =='
$governorChokepointCheck = Join-Path $Root 'scripts/check-gh-governor-chokepoint-inventory.ps1'
if (Test-Path -LiteralPath $governorChokepointCheck -PathType Leaf) {
    & $governorChokepointCheck -AllowWrapperOnlySlice
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'scripts/check-gh-governor-chokepoint-inventory.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'github fleet governor chokepoint inventory guard failed (Issue #585)'
    }
    else {
        Write-Check 'scripts/check-gh-governor-chokepoint-inventory.ps1' 'PASS' 'completed'
    }
}
else {
    Write-Check 'scripts/check-gh-governor-chokepoint-inventory.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing github fleet governor chokepoint inventory guard (Issue #585)'
}

Write-Host '== github fleet repo-tick snapshot (Issue #583) =='
$repoTickCoverageCheck = Join-Path $Root 'scripts/check-github-fleet-repo-tick-coverage.ps1'
if (Test-Path -LiteralPath $repoTickCoverageCheck -PathType Leaf) {
    & $repoTickCoverageCheck
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'scripts/check-github-fleet-repo-tick-coverage.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'github fleet repo-tick coverage guard failed (Issue #583)'
    }
    else {
        Write-Check 'scripts/check-github-fleet-repo-tick-coverage.ps1' 'PASS' 'completed'
    }
}
else {
    Write-Check 'scripts/check-github-fleet-repo-tick-coverage.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing github fleet repo-tick coverage guard (Issue #583)'
}




Write-Host '== Draft discipline guards (Issue #221) =='
$draftDisciplineCheck = Join-Path $Root 'scripts/check-draft-discipline.ps1'
$draftDisciplineFixtureDir = Join-Path $Root 'tests/fixtures/draft-discipline'
if ((Test-Path -LiteralPath $draftDisciplineCheck -PathType Leaf) -and
    (Test-Path -LiteralPath $draftDisciplineFixtureDir -PathType Container)) {
    $positiveCases = @(
        @{ Name = 'negative-only-action'; Draft = 'negative-only-action.md'; ExpectPass = $false },
        @{ Name = 'positive-present-action'; Draft = 'positive-present-action.md'; ExpectPass = $true },
        @{ Name = 'external-input-no-provenance'; Draft = 'external-input-no-provenance.md'; ExpectPass = $false },
        @{ Name = 'synonym-record-only-backstop'; Draft = 'synonym-record-only-backstop.md'; ExpectPass = $false }
    )
    foreach ($case in $positiveCases) {
        $draftPath = Join-Path $draftDisciplineFixtureDir $case.Draft
        & $draftDisciplineCheck -Command positive-outcome -DraftPath $draftPath
        $passed = $LASTEXITCODE -eq 0
        if ($passed -ne $case.ExpectPass) {
            Write-Check "draft-discipline/positive/$($case.Name)" 'FAIL' "expected pass=$($case.ExpectPass) got pass=$passed"
            Add-Failure "Draft discipline positive-outcome fixture failed: $($case.Draft)"
        }
        else {
            Write-Check "draft-discipline/positive/$($case.Name)" 'PASS' 'completed'
        }
    }

    $parkedCases = @(
        @{ Name = 'defer-without-block'; Draft = 'defer-without-block.md'; Mock = $null; ExpectPass = $false },
        @{ Name = 'parked-valid'; Draft = 'parked-valid.md'; Mock = 'parked-valid-issues.json'; ExpectPass = $true },
        @{ Name = 'parked-vague-cause'; Draft = 'parked-vague-cause.md'; Mock = 'parked-placeholder-issue.json'; ExpectPass = $false },
        @{ Name = 'parked-word-overlap'; Draft = 'parked-word-overlap.md'; Mock = 'parked-word-overlap.json'; ExpectPass = $false },
        @{ Name = 'parked-dual-deferral'; Draft = 'parked-dual-deferral.md'; Mock = 'parked-valid-issues.json'; ExpectPass = $false }
    )
    foreach ($case in $parkedCases) {
        $draftPath = Join-Path $draftDisciplineFixtureDir $case.Draft
        if ($case.Mock) {
            $mockPath = Join-Path $draftDisciplineFixtureDir $case.Mock
            & $draftDisciplineCheck -Command parked-root -DraftPath $draftPath -MockIssuesPath $mockPath
        }
        else {
            & $draftDisciplineCheck -Command parked-root -DraftPath $draftPath
        }
        $passed = $LASTEXITCODE -eq 0
        if ($passed -ne $case.ExpectPass) {
            Write-Check "draft-discipline/parked/$($case.Name)" 'FAIL' "expected pass=$($case.ExpectPass) got pass=$passed"
            Add-Failure "Draft discipline parked-root fixture failed: $($case.Draft)"
        }
        else {
            Write-Check "draft-discipline/parked/$($case.Name)" 'PASS' 'completed'
        }
    }


    $contractCases = @(
        @{ Name = 'grounded-pass'; Draft = 'contract-evidence/grounded-pass.md'; ExpectPass = $true },
        @{ Name = 'explicit-none'; Draft = 'contract-evidence/explicit-none.md'; ExpectPass = $true },
        @{ Name = 'absent-block'; Draft = 'contract-evidence/absent-block.md'; ExpectPass = $false },
        @{ Name = 'missing-manifest-entry'; Draft = 'contract-evidence/missing-manifest-entry.md'; ExpectPass = $false },
        @{ Name = 'producer-mismatch'; Draft = 'contract-evidence/producer-mismatch.md'; ExpectPass = $false },
        @{ Name = 'new-external-gh'; Draft = 'contract-evidence/new-external-gh.md'; ExpectPass = $false },
        @{ Name = 'legacy-grandfather'; Draft = 'contract-evidence/legacy-grandfather.md'; ExpectPass = $true }
    )
    $fixtureManifest = Join-Path $Root 'tests/fixtures/contract-evidence/capture-manifest.json'
    $fixtureLegacy = Join-Path $draftDisciplineFixtureDir 'contract-evidence/legacy-list.json'
    foreach ($case in $contractCases) {
        $draftPath = Join-Path $draftDisciplineFixtureDir $case.Draft
        & $draftDisciplineCheck -Command contract-evidence -DraftPath $draftPath -RepoRoot $Root -ManifestPath $fixtureManifest -LegacyListPath $fixtureLegacy
        $passed = $LASTEXITCODE -eq 0
        if ($passed -ne $case.ExpectPass) {
            Write-Check "draft-discipline/contract/$($case.Name)" 'FAIL' "expected pass=$($case.ExpectPass) got pass=$passed"
            Add-Failure "Draft discipline contract-evidence fixture failed: $($case.Draft)"
        }
        else {
            Write-Check "draft-discipline/contract/$($case.Name)" 'PASS' 'completed'
        }
    }


    Write-Check 'verify-runtime/contract-evidence-vitest' 'SKIP' 'owned by draft discipline fixtures + full Vitest lane (Issue #488)'

    $productionManifest = Join-Path $Root 'tests/external-output-references/capture-manifest.json'
    node (Join-Path $Root 'scripts/generate-capture-manifest.mjs') --verify $productionManifest 2>$null
    if ($LASTEXITCODE -ne 0) {
        node -e "import { verifyCaptureManifestIntegrity } from './scripts/contract-evidence-validator.mjs'; const r = verifyCaptureManifestIntegrity(process.cwd(), 'tests/external-output-references/capture-manifest.json'); if (!r.ok) { console.error(r.errors.join('\n')); process.exit(1); }" 
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'contract-evidence/manifest-integrity' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Capture manifest integrity check failed (Issue #366)'
    }
    else {
        Write-Check 'contract-evidence/manifest-integrity' 'PASS' 'completed'
    }

    & $draftDisciplineCheck -Command surfaces -RepoRoot $Root
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'draft-discipline/surfaces' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'RCA spec discipline surface consistency check failed (Issue #221)'
    }
    else {
        Write-Check 'draft-discipline/surfaces' 'PASS' 'completed'
    }
}
else {
    Write-Check 'scripts/check-draft-discipline.ps1' 'FAIL' 'missing script or fixtures'
    Add-Failure 'Missing draft discipline check or fixtures (Issue #221)'
}

$draftAuthorRelocationCheck = Join-Path $Root 'scripts/check-draft-author-relocation-contract.ps1'
if (Test-Path -LiteralPath $draftAuthorRelocationCheck -PathType Leaf) {
    & $draftAuthorRelocationCheck -RepoRoot $Root
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-draft-author-relocation-contract.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-draft-author-relocation-contract.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Draft-author relocation contract surface guard failed (Issue #579)'
    }
}
else {
    Write-Check 'scripts/check-draft-author-relocation-contract.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing draft-author relocation contract guard (Issue #579)'
}

Write-Host ''
Write-Host ''
Write-Host '== AO 0.10 session/status adapter guards (Issue #619) =='
$aoArgvShapeCheck = Join-Path $Root 'scripts/check-ao-cli-argv-shape.ps1'
if (Test-Path -LiteralPath $aoArgvShapeCheck -PathType Leaf) {
    & $aoArgvShapeCheck
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'scripts/check-ao-cli-argv-shape.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'AO 0.10 argv-shape guard failed (Issue #619)'
    }
    else {
        & $aoArgvShapeCheck -SelfTest
        if ($LASTEXITCODE -ne 0) {
            Write-Check 'scripts/check-ao-cli-argv-shape.ps1' 'FAIL' "self-test exit=$LASTEXITCODE"
            Add-Failure 'AO 0.10 argv-shape guard self-test failed (Issue #619)'
        }
        else {
            Write-Check 'scripts/check-ao-cli-argv-shape.ps1' 'PASS' 'completed'
        }
    }
}
else {
    Write-Check 'scripts/check-ao-cli-argv-shape.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing AO 0.10 argv-shape guard (Issue #619)'
}

$aoCaptureRedactionCheck = Join-Path $Root 'scripts/check-ao-0-10-cli-capture-redaction.ps1'
if (Test-Path -LiteralPath $aoCaptureRedactionCheck -PathType Leaf) {
    & $aoCaptureRedactionCheck
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'scripts/check-ao-0-10-cli-capture-redaction.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'AO 0.10 capture redaction gate failed (Issue #619/#637)'
    }
    else {
        $aoCaptureRedactionSelfTest = Join-Path $Root 'scripts/check-ao-capture-redaction-selftest.ps1'
        if (Test-Path -LiteralPath $aoCaptureRedactionSelfTest -PathType Leaf) {
            & $aoCaptureRedactionSelfTest
            if ($LASTEXITCODE -ne 0) {
                Write-Check 'scripts/check-ao-capture-redaction-selftest.ps1' 'FAIL' "self-test exit=$LASTEXITCODE"
                Add-Failure 'AO capture redaction self-test failed (Issue #637)'
            }
            else {
                Write-Check 'scripts/check-ao-0-10-cli-capture-redaction.ps1' 'PASS' 'completed'
            }
        }
        else {
            Write-Check 'scripts/check-ao-capture-redaction-selftest.ps1' 'FAIL' 'missing'
            Add-Failure 'Missing AO capture redaction self-test (Issue #637)'
        }
    }
}
else {
    Write-Check 'scripts/check-ao-0-10-cli-capture-redaction.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing AO 0.10 capture redaction gate (Issue #619/#637)'
}

foreach ($check in @(
        @{ Path = 'scripts/check-ao-dead-argv-bypass.ps1'; Label = 'dead-argv bypass scan (Issue #619)' },
        @{ Path = 'scripts/check-ao-session-adapter-project-filter.ps1'; Label = 'session adapter project filter (Issue #619)' }
    )) {
    $checkPath = Join-Path $Root $check.Path
    if (Test-Path -LiteralPath $checkPath -PathType Leaf) {
        & $checkPath
        if ($LASTEXITCODE -ne 0) {
            Write-Check $check.Path 'FAIL' "exit=$LASTEXITCODE"
            Add-Failure ($check.Label + ' failed')
        }
        else {
            Write-Check $check.Path 'PASS' 'completed'
        }
    }
    else {
        Write-Check $check.Path 'FAIL' 'missing'
        Add-Failure ('Missing ' + $check.Label)
    }
}

Write-Host '== External-output fixture shape guard (Issue #223) =='
$externalOutputShapeGuard = Join-Path $Root 'scripts/check-external-output-shape-guard.ps1'
if (Test-Path -LiteralPath $externalOutputShapeGuard -PathType Leaf) {
    & $externalOutputShapeGuard
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-external-output-shape-guard.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-external-output-shape-guard.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'External-output fixture shape guard failed (Issue #223)'
    }
}
else {
    Write-Check 'scripts/check-external-output-shape-guard.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing external-output fixture shape guard script (Issue #223)'
}

Write-Host ''
Write-Host '== Task complexity tier calibration consistency (Issue #574) =='
$tierCalibrationCheck = Join-Path $Root 'scripts/check-tier-calibration-consistency.ps1'
if (Test-Path -LiteralPath $tierCalibrationCheck -PathType Leaf) {
    & $tierCalibrationCheck
    if ($LASTEXITCODE -eq 0) {
        & $tierCalibrationCheck -SelfTest
        if ($LASTEXITCODE -eq 0) {
            Write-Check 'scripts/check-tier-calibration-consistency.ps1' 'PASS' 'completed'
        }
        else {
            Write-Check 'scripts/check-tier-calibration-consistency.ps1' 'FAIL' "self-test exit=$LASTEXITCODE"
            Add-Failure 'Task complexity tier calibration self-test failed (Issue #574)'
        }
    }
    else {
        Write-Check 'scripts/check-tier-calibration-consistency.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Task complexity tier calibration consistency check failed (Issue #574)'
    }
}
else {
    Write-Check 'scripts/check-tier-calibration-consistency.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing task complexity tier calibration check script (Issue #574)'
}

Write-Host ''
Write-Host '== Coworker delegation threshold drift (Issue #255) =='
$coworkerThresholdDriftCheck = Join-Path $Root 'scripts/check-coworker-delegation-threshold-drift.ps1'
if (Test-Path -LiteralPath $coworkerThresholdDriftCheck -PathType Leaf) {
    & $coworkerThresholdDriftCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-coworker-delegation-threshold-drift.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-coworker-delegation-threshold-drift.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Coworker delegation threshold drift check failed (Issue #255)'
    }
}
else {
    Write-Check 'scripts/check-coworker-delegation-threshold-drift.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing coworker delegation threshold drift check script (Issue #255)'
}

Write-Host ''
Write-Host '== AGENTS.md delivery guards (Issue #678) =='
foreach ($check in @(
        @{ Path = 'scripts/check-agent-rules-line-budget.ps1'; Label = 'AGENTS.md size budget (Issue #678)' },
        @{ Path = 'scripts/check-agent-rules-moved-content.ps1'; Label = 'AGENTS.md moved-content guard (Issue #678)' },
        @{ Path = 'scripts/check-agent-rules-grep-inventory.ps1'; Label = 'AGENTS.md live-ref guard (Issue #678)' }
    )) {
    $scriptPath = Join-Path $Root $check.Path
    if (Test-Path -LiteralPath $scriptPath -PathType Leaf) {
        & $scriptPath
        if ($LASTEXITCODE -eq 0) {
            Write-Check $check.Path 'PASS' 'completed'
        }
        else {
            Write-Check $check.Path 'FAIL' "exit=$LASTEXITCODE"
            Add-Failure ($check.Label + ' failed')
        }
    }
    else {
        Write-Check $check.Path 'FAIL' 'missing'
        Add-Failure ('Missing ' + $check.Label + ' script')
    }
}

$reviewerContractMappingCheck = Join-Path $Root 'scripts/check-reviewer-contract-mapping.ps1'
if (Test-Path -LiteralPath $reviewerContractMappingCheck -PathType Leaf) {
    & $reviewerContractMappingCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-reviewer-contract-mapping.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-reviewer-contract-mapping.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Reviewer contract-mapping prompt/policy check failed (Issue #362)'
    }
}
else {
    Write-Check 'scripts/check-reviewer-contract-mapping.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing reviewer contract-mapping check script (Issue #362)'
}

$contractEvidenceReverifyCheck = Join-Path $Root 'scripts/check-contract-evidence-reverify.ps1'
if (Test-Path -LiteralPath $contractEvidenceReverifyCheck -PathType Leaf) {
    & $contractEvidenceReverifyCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-contract-evidence-reverify.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-contract-evidence-reverify.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Contract-evidence reverify prompt/policy check failed (Issue #376)'
    }
}
else {
    Write-Check 'scripts/check-contract-evidence-reverify.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing contract-evidence reverify check script (Issue #376)'
}

Write-Host ''
Write-Host '== Skill pointer drift (Issue #156) =='
$skillPointerDriftCheck = Join-Path $Root 'scripts/check-skill-pointer-drift.ps1'
if (Test-Path -LiteralPath $skillPointerDriftCheck -PathType Leaf) {
    & $skillPointerDriftCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-skill-pointer-drift.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-skill-pointer-drift.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Skill pointer drift check failed (Issue #156)'
    }
}
else {
    Write-Check 'scripts/check-skill-pointer-drift.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing skill pointer drift check script (Issue #156)'
}

Write-Host ''
Write-Host '== Review run recovery registration (Issue #287) =='
$reviewRunRecoveryCheck = Join-Path $Root 'scripts/check-review-run-recovery.ps1'
if (Test-Path -LiteralPath $reviewRunRecoveryCheck -PathType Leaf) {
    & $reviewRunRecoveryCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-run-recovery.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-run-recovery.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Review run recovery registration/config check failed (Issue #287)'
    }
}
else {
    Write-Check 'scripts/check-review-run-recovery.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing review run recovery check script (Issue #287)'
}

Write-Host ''
Write-Host '== Orchestrator message registry (Issue #298) =='
$messageRegistryCheck = Join-Path $Root 'scripts/check-orchestrator-message-registry.ps1'
if (Test-Path -LiteralPath $messageRegistryCheck -PathType Leaf) {
    & $messageRegistryCheck $Root
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-orchestrator-message-registry.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-orchestrator-message-registry.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Orchestrator message registry audit/map check failed (Issue #298)'
    }
}
else {
    Write-Check 'scripts/check-orchestrator-message-registry.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing orchestrator message registry check script (Issue #298)'
}

Write-Host ''
Write-Host '== Orchestrator escalation contract (Issue #641) =='
$escalationEmitterCheck = Join-Path $Root 'scripts/check-orchestrator-escalation-emitters.ps1'
if (Test-Path -LiteralPath $escalationEmitterCheck -PathType Leaf) {
    & $escalationEmitterCheck $Root
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-orchestrator-escalation-emitters.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-orchestrator-escalation-emitters.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Orchestrator escalation emitter guard failed (Issue #641)'
    }
}
else {
    Write-Check 'scripts/check-orchestrator-escalation-emitters.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing orchestrator escalation emitter check script (Issue #641)'
}

$escalationCatalogCheck = Join-Path $Root 'scripts/check-orchestrator-escalation-catalog.ps1'
if (Test-Path -LiteralPath $escalationCatalogCheck -PathType Leaf) {
    & $escalationCatalogCheck $Root
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-orchestrator-escalation-catalog.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-orchestrator-escalation-catalog.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Orchestrator escalation catalog guard failed (Issue #641)'
    }
}
else {
    Write-Check 'scripts/check-orchestrator-escalation-catalog.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing orchestrator escalation catalog check script (Issue #641)'
}

Write-Host ''
Write-Host '== Reviewer failure evidence registration (Issue #312) =='
$reviewerFailureEvidenceCheck = Join-Path $Root 'scripts/check-reviewer-failure-evidence.ps1'
if (Test-Path -LiteralPath $reviewerFailureEvidenceCheck -PathType Leaf) {
    & $reviewerFailureEvidenceCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-reviewer-failure-evidence.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-reviewer-failure-evidence.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Reviewer failure evidence registration/config check failed (Issue #312)'
    }
}
else {
    Write-Check 'scripts/check-reviewer-failure-evidence.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing reviewer failure evidence check script (Issue #312)'
}

Write-Host ''
Write-Host '== orchestrator claimed review-start gate (Issue #318) =='
$orchestratorClaimedGateCheck = Join-Path $Root 'scripts/check-orchestrator-claimed-review-run.ps1'
if (Test-Path -LiteralPath $orchestratorClaimedGateCheck -PathType Leaf) {
    & $orchestratorClaimedGateCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-orchestrator-claimed-review-run.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-orchestrator-claimed-review-run.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Orchestrator claimed review-start gate wiring failed (Issue #318)'
    }
}
else {
    Write-Check 'scripts/check-orchestrator-claimed-review-run.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing orchestrator claimed review-start gate check (Issue #318)'
}

$autonomousCapabilityCheck = Join-Path $Root 'scripts/check-autonomous-review-start-capabilities.ps1'
if (Test-Path -LiteralPath $autonomousCapabilityCheck -PathType Leaf) {
    & $autonomousCapabilityCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-autonomous-review-start-capabilities.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-autonomous-review-start-capabilities.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Autonomous review-start capability inventory drift (Issue #318)'
    }
}
else {
    Write-Check 'scripts/check-autonomous-review-start-capabilities.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing autonomous review-start capability check (Issue #318)'
}

$envelopeLedgerStarterCheck = Join-Path $Root 'scripts/check-review-start-envelope-ledger-starter-surfaces.ps1'
if (Test-Path -LiteralPath $envelopeLedgerStarterCheck -PathType Leaf) {
    & $envelopeLedgerStarterCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-start-envelope-ledger-starter-surfaces.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-start-envelope-ledger-starter-surfaces.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Review-start envelope ledger starter-surface supervised gh guard failed (Issue #516)'
    }
}
else {
    Write-Check 'scripts/check-review-start-envelope-ledger-starter-surfaces.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing review-start envelope ledger starter-surface guard (Issue #516)'
}

$autonomousBoundaryCheck = Join-Path $Root 'scripts/check-autonomous-orchestrator-boundary.ps1'
if (Test-Path -LiteralPath $autonomousBoundaryCheck -PathType Leaf) {
    & $autonomousBoundaryCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-autonomous-orchestrator-boundary.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-autonomous-orchestrator-boundary.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Autonomous orchestrator spawn/git boundary inventory drift (Issue #324)'
    }
}
else {
    Write-Check 'scripts/check-autonomous-orchestrator-boundary.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing autonomous orchestrator spawn/git boundary check (Issue #324)'
}

$autonomousSpawnPolicyCheck = Join-Path $Root 'scripts/check-autonomous-spawn-policy.ps1'
if (Test-Path -LiteralPath $autonomousSpawnPolicyCheck -PathType Leaf) {
    & $autonomousSpawnPolicyCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-autonomous-spawn-policy.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-autonomous-spawn-policy.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Autonomous orchestrator spawn policy drift (Issue #458)'
    }
}
else {
    Write-Check 'scripts/check-autonomous-spawn-policy.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing autonomous orchestrator spawn policy check (Issue #458)'
}

Write-Check 'verify-runtime/autonomous-spawn-policy-vitest' 'SKIP' 'owned by check-autonomous-spawn-policy.ps1 + full Vitest lane (Issue #488)'


$aoSpawnShapeCheck = Join-Path $Root 'scripts/check-ao-spawn-shape.ps1'
if (Test-Path -LiteralPath $aoSpawnShapeCheck -PathType Leaf) {
    & $aoSpawnShapeCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-ao-spawn-shape.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-ao-spawn-shape.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'AO 0.10.x runnable ao spawn shape guard failed (Issue #589)'
    }
}
else {
    Write-Check 'scripts/check-ao-spawn-shape.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing AO 0.10.x runnable ao spawn shape check (Issue #589)'
}

Write-Check 'verify-runtime/ao-spawn-shape-vitest' 'SKIP' 'owned by check-ao-spawn-shape.ps1 + full Vitest lane (Issue #488)'


Write-Check 'verify-runtime/autonomous-spawn-worktree-vitest' 'SKIP' 'owned by full Vitest lane (Issue #488)'


$autonomousSpawnBudgetCheck = Join-Path $Root 'scripts/check-autonomous-spawn-budget.ps1'
if (Test-Path -LiteralPath $autonomousSpawnBudgetCheck -PathType Leaf) {
    & $autonomousSpawnBudgetCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-autonomous-spawn-budget.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-autonomous-spawn-budget.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Autonomous spawn budget guard failed (Issue #462)'
    }
}
else {
    Write-Check 'scripts/check-autonomous-spawn-budget.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing autonomous spawn budget check (Issue #462)'
}

Write-Check 'verify-runtime/autonomous-spawn-budget-vitest' 'SKIP' 'owned by check-autonomous-spawn-budget.ps1 + full Vitest lane (Issue #488)'


$reviewPipelineSpawnBudgetCheck = Join-Path $Root 'scripts/check-review-pipeline-spawn-budget.ps1'
if (Test-Path -LiteralPath $reviewPipelineSpawnBudgetCheck -PathType Leaf) {
    & $reviewPipelineSpawnBudgetCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-review-pipeline-spawn-budget.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-review-pipeline-spawn-budget.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Review-pipeline spawn budget guard failed (Issue #480)'
    }
}
else {
    Write-Check 'scripts/check-review-pipeline-spawn-budget.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing review-pipeline spawn budget check (Issue #480)'
}

Write-Check 'verify-runtime/review-pipeline-spawn-budget-vitest' 'SKIP' 'owned by check-review-pipeline-spawn-budget.ps1 + full Vitest lane (Issue #488)'


Write-Check 'verify-runtime/autonomous-interposer-vitest' 'SKIP' 'owned by boundary checks + full Vitest lane (Issue #488)'


$orchestratorGatePreflight = Join-Path $Root 'scripts/orchestrator-review-start-preflight.ps1'
if (Test-Path -LiteralPath $orchestratorGatePreflight -PathType Leaf) {
    & $orchestratorGatePreflight -FixtureMode
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/orchestrator-review-start-preflight.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/orchestrator-review-start-preflight.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Orchestrator review-start gate preflight failed (Issue #318)'
    }
}
else {
    Write-Check 'scripts/orchestrator-review-start-preflight.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing orchestrator review-start gate preflight (Issue #318)'
}


Write-Host '== command-runtime bootstrap (Issue #532) =='
$commandRuntimeWiring = Join-Path $Root 'scripts/check-command-runtime-bootstrap.ps1'
if (Test-Path -LiteralPath $commandRuntimeWiring -PathType Leaf) {
    & $commandRuntimeWiring
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-command-runtime-bootstrap.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-command-runtime-bootstrap.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Command-runtime bootstrap wiring failed (Issue #532)'
    }
}
else {
    Write-Check 'scripts/check-command-runtime-bootstrap.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing command-runtime bootstrap wiring check (Issue #532)'
}

$commandRuntimeForbidden = Join-Path $Root 'scripts/check-command-runtime-forbidden-workaround.ps1'
if (Test-Path -LiteralPath $commandRuntimeForbidden -PathType Leaf) {
    & $commandRuntimeForbidden
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-command-runtime-forbidden-workaround.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-command-runtime-forbidden-workaround.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Command-runtime forbidden-workaround guard failed (Issue #532)'
    }
}
else {
    Write-Check 'scripts/check-command-runtime-forbidden-workaround.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing command-runtime forbidden-workaround guard (Issue #532)'
}

$commandRuntimePreflight = Join-Path $Root 'scripts/orchestrator-command-runtime-preflight.ps1'
if (Test-Path -LiteralPath $commandRuntimePreflight -PathType Leaf) {
    & $commandRuntimePreflight -FixtureMode
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/orchestrator-command-runtime-preflight.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/orchestrator-command-runtime-preflight.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Command-runtime bootstrap preflight failed (Issue #532)'
    }
}
else {
    Write-Check 'scripts/orchestrator-command-runtime-preflight.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing command-runtime bootstrap preflight (Issue #532)'
}

Write-Host '== worker nudge gate (Issue #384) =='
$workerNudgeGateCheck = Join-Path $Root 'scripts/check-worker-nudge-gate.ps1'
if (Test-Path -LiteralPath $workerNudgeGateCheck -PathType Leaf) {
    & $workerNudgeGateCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-worker-nudge-gate.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-worker-nudge-gate.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Worker nudge gate wiring failed (Issue #384)'
    }
}
else {
    Write-Check 'scripts/check-worker-nudge-gate.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing worker nudge gate check (Issue #384)'
}

$workerNudgeCapabilityCheck = Join-Path $Root 'scripts/check-autonomous-worker-nudge-capabilities.ps1'
if (Test-Path -LiteralPath $workerNudgeCapabilityCheck -PathType Leaf) {
    & $workerNudgeCapabilityCheck
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/check-autonomous-worker-nudge-capabilities.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/check-autonomous-worker-nudge-capabilities.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Autonomous worker-nudge capability inventory drift (Issue #384)'
    }
}
else {
    Write-Check 'scripts/check-autonomous-worker-nudge-capabilities.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing autonomous worker-nudge capability check (Issue #384)'
}

$workerNudgePreflight = Join-Path $Root 'scripts/worker-nudge-gate-preflight.ps1'
if (Test-Path -LiteralPath $workerNudgePreflight -PathType Leaf) {
    & $workerNudgePreflight -FixtureMode
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/worker-nudge-gate-preflight.ps1' 'PASS' 'completed'
    }
    else {
        Write-Check 'scripts/worker-nudge-gate-preflight.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Worker nudge gate preflight failed (Issue #384)'
    }
}
else {
    Write-Check 'scripts/worker-nudge-gate-preflight.ps1' 'FAIL' 'missing'
    Add-Failure 'Missing worker nudge gate preflight (Issue #384)'
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

if ($TestBackedSmoke) {
    Write-Host ''
    $smokeScript = Join-Path $Root 'scripts/invoke-verify-test-backed-smoke.ps1'
    if (-not (Test-Path -LiteralPath $smokeScript -PathType Leaf)) {
        Write-Check 'verify-runtime/test-backed-smoke' 'FAIL' 'missing helper'
        Add-Failure 'Missing invoke-verify-test-backed-smoke.ps1 (Issue #488)'
    }
    else {
        & $smokeScript -RepoRoot $Root
        if ($LASTEXITCODE -ne 0) {
            Write-Check 'verify-runtime/test-backed-smoke' 'FAIL' "exit=$LASTEXITCODE"
            Add-Failure 'verify.ps1 -TestBackedSmoke failed (Issue #488)'
        }
        else {
            Write-Check 'verify-runtime/test-backed-smoke' 'PASS' 'batched smoke completed'
        }
    }
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
