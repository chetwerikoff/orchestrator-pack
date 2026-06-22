[CmdletBinding()]
param(
    [switch]$StrictPrereqs
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
Write-Host '== Operator adoption example guard (Issue #101) =='
$operatorAdoptionCheck = Join-Path $Root 'scripts/check-operator-adoption-example.ps1'
if (Test-Path -LiteralPath $operatorAdoptionCheck -PathType Leaf) {
    & $operatorAdoptionCheck -ChangedPaths @('prompts/agent_rules.md') -PrBody ''
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
Write-Host '== deferred-head review re-evaluation (Issue #235) =='
$reviewReadyReportStateSeedCheck = Join-Path $Root 'scripts/check-review-ready-report-state-seed.ps1'
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


    Push-Location $Root
    try {
        $contractEvidenceVitestReady = $true
        if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules') -PathType Container)) {
            & npm ci --include=dev
            if ($LASTEXITCODE -ne 0) {
                Write-Check 'contract-evidence/vitest' 'FAIL' "npm ci exit=$LASTEXITCODE"
                Add-Failure 'contract-evidence vitest prerequisites failed (Issue #366)'
                $contractEvidenceVitestReady = $false
            }
        }
        if ($contractEvidenceVitestReady) {
            & npx vitest run scripts/contract-evidence.test.ts
            if ($LASTEXITCODE -ne 0) {
                Write-Check 'contract-evidence/vitest' 'FAIL' "exit=$LASTEXITCODE"
                Add-Failure 'contract-evidence vitest suite failed (Issue #366)'
            }
            else {
                Write-Check 'contract-evidence/vitest' 'PASS' 'completed'
            }
        }
    }
    finally {
        Pop-Location
    }

    $productionManifest = Join-Path $Root 'tests/external-output-references/capture-manifest.json'
    node (Join-Path $Root 'scripts/generate-capture-manifest.mjs') --verify $productionManifest 2>$null
    if ($LASTEXITCODE -ne 0) {
        node -e "import { verifyCaptureManifestIntegrity } from './scripts/contract-evidence.mjs'; const r = verifyCaptureManifestIntegrity(process.cwd(), 'tests/external-output-references/capture-manifest.json'); if (!r.ok) { console.error(r.errors.join('\n')); process.exit(1); }" 
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

Write-Host ''
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
