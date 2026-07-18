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
Write-Host '== TypeScript gate runner core (Issue #830 / Wave 3.a) =='
$gateRunnerPath = Join-Path $Root 'scripts/gate-runner/runner.ts'
$typeScriptCliHelper = Join-Path $Root 'scripts/lib/Invoke-TypeScriptCli.ps1'
if ((Test-Path -LiteralPath $gateRunnerPath -PathType Leaf) -and (Test-Path -LiteralPath $typeScriptCliHelper -PathType Leaf)) {
    try {
        . $typeScriptCliHelper
        $gateRunnerNodeArgs = @(Get-OpkTypeScriptNodeArguments -ScriptPath $gateRunnerPath)
        & node @gateRunnerNodeArgs '--repo-root' $Root
        if ($LASTEXITCODE -eq 0) {
            Write-Check 'gate-runner/core' 'PASS' 'completed'
        }
        else {
            Write-Check 'gate-runner/core' 'FAIL' "exit=$LASTEXITCODE"
            Add-Failure 'TypeScript gate runner core failed (Issue #830)'
        }
    }
    catch {
        Write-Check 'gate-runner/core' 'FAIL' $_.Exception.Message
        Add-Failure 'TypeScript gate runner core could not be dispatched (Issue #830)'
    }
}
else {
    Write-Check 'gate-runner/core' 'FAIL' 'runner or TypeScript CLI helper missing'
    Add-Failure 'Missing TypeScript gate runner core or invocation helper (Issue #830)'
}
Write-Host ''
Write-Host '== REVIEW_COMMAND preflight (Issue #60) =='

Write-Host ''
Write-Host '== orchestrator empty-review trap (Issue #75) =='

Write-Host ''
Write-Host '== orchestrator review-run idempotency (Issue #98) =='

Write-Host ''
Write-Host '== orchestrator covered-head review idempotency (Issue #189) =='

Write-Host ''
Write-Host '== orchestrator head-ready review gate (Issue #195) =='

Write-Host ''
Write-Host '== report→head binding without report-stored SHA (Issue #218) =='

Write-Host ''
Write-Host '== detached-HEAD PR context (Issue #98) =='

Write-Host ''
Write-Host '== review-trigger reconciliation (Issue #163) =='


Write-Host ''
Write-Host '== CI-green worker wake (Issue #191) =='


Write-Host ''
Write-Host '== Dead-worker reconcile (Issue #593) =='


Write-Host ''
Write-Host '== CI-failure notification dedup (Issue #283) =='


Write-Host ''
Write-Host '== first-send review delivery reconcile (Issue #202) =='

Write-Host ''
Write-Host '== event-driven review wake trigger (Issue #207) =='


Write-Host ''
Write-Host '== AO 0.10 review harness + trigger loop (Issue #623) =='

Write-Host ''
Write-Host '== AO 0.10 harness review bridge + [Pn] contract (Issue #658) =='


Write-Host ''
Write-Host '== AO 0.10 review producer data contract (Issue #626) =='
Write-Host ''
Write-Host '== vestigial fleet retirement guard (Issue #745) =='

Write-Host ''
Write-Host '== deferred-head review re-evaluation (Issue #235) =='

if (Test-Path -LiteralPath $reviewReadyReportStateSeedCheck -PathType Leaf) {
    & $reviewReadyReportStateSeedCheck
    if ($LASTEXITCODE -ne 0) {
        $script:VerifyFailed = $true
    }
    else {
    }
}
else {
    $script:VerifyFailed = $true
}


Write-Host '== no report-audit bind contract (Issue #717) =='
foreach ($check in @(
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

Write-Host '== merge triage gate (Issue #648) =='


Write-Host ''
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

Write-Host ''
Write-Host '== side-process state round-trip coverage (Issue #248) =='

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


Write-Host ''
Write-Host '== review bulk-send / stuck-open diagnostic (Issue #140) =='

Write-Host ''
Write-Host '== terminal mux flood detection (Issue #173) =='


Write-Host ''
Write-Host '== review-ready worker stuck guard (Issue #174) =='

Write-Host ''
Write-Host '== reviewer workspace preflight (Issue #98) =='

Write-Host ''
Write-Host '== run-pack-review CLI args (Issue #60) =='

Write-Host ''
Write-Host '== PACK_REVIEWER selector and entrypoint (Issue #86) =='

Write-Host ''
Write-Host '== PACK_REVIEWER persistent-env fallback (Issue #106) =='

Write-Host ''
Write-Host '== Strict review gate fixtures (Issue #79) =='
$strictGate = Join-Path $Root 'scripts/invoke-pack-review-strict-gate.ps1'
if (Test-Path -LiteralPath $strictGate -PathType Leaf) {
    & $strictGate
    if ($LASTEXITCODE -eq 0) {
        Write-Check 'scripts/invoke-pack-review-strict-gate.ps1' 'PASS' 'fixture gate completed'
    }
    else {
        Write-Check 'scripts/invoke-pack-review-strict-gate.ps1' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'Strict review gate failed on committed fixtures (Issue #79)'
    }
}
else {
    Write-Check 'strict review gate scripts' 'FAIL' 'missing gate'
    Add-Failure 'Missing strict review gate script (Issue #79)'
}

Write-Host ''
Write-Host '== Worker launch-failure detection (Issue #63) =='
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
    Add-Failure 'Missing worker launch-failure check or fixtures'
}

Write-Host ''
Write-Host '== Orchestrator launch-failure detection (Issue #91) =='
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
    Add-Failure 'Missing orchestrator launch-failure check or fixtures'
}

Write-Host ''
Write-Host '== Coworker RTK passthrough static guard (Issue #145) =='

Write-Host ''
Write-Host '== gh wrapper static guards (Issue #431) =='

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


Write-Host ''
Write-Host '== wake-supervisor gh PATH guard (Issue #447) =='

Write-Host ''

Write-Host '== CI job timeout walls (Issue #730) =='
$ciJobTimeoutCheck = Join-Path $Root 'scripts/check-ci-job-timeouts.mjs'
if (Test-Path -LiteralPath $ciJobTimeoutCheck -PathType Leaf) {
    & node $ciJobTimeoutCheck
    if ($LASTEXITCODE -ne 0) {
        Write-Check 'scripts/check-ci-job-timeouts.mjs' 'FAIL' "exit=$LASTEXITCODE"
        Add-Failure 'CI job timeout wall structural check failed (Issue #730)'
    }
    else {
        Write-Check 'scripts/check-ci-job-timeouts.mjs' 'PASS' 'completed'
    }
}
else {
    Write-Check 'scripts/check-ci-job-timeouts.mjs' 'FAIL' 'missing'
    Add-Failure 'Missing CI job timeout wall structural check (Issue #730)'
}

Write-Host ''

Write-Host ''
Write-Host '== github fleet inventory cache (Issue #453) =='

Write-Check 'verify-runtime/github-fleet-cache-vitest' 'SKIP' 'owned by check-github-fleet-cache-bypass.ps1 + full Vitest lane (Issue #488)'

Write-Host ''
Write-Host '== audit retention guarded dot-source (Issue #610) =='

Write-Host '== github fleet shared API governor (Issue #585) =='

Write-Host '== github fleet repo-tick snapshot (Issue #583) =='


Write-Host '== Draft discipline guards (Issue #221) =='
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
    Add-Failure 'Missing draft discipline check or fixtures (Issue #221)'
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

foreach ($check in @(
        @{ Path = 'scripts/check-ao-dead-argv-bypass.ps1'; Label = 'dead-argv bypass scan (Issue #619)' },
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


Write-Host ''
Write-Host '== Task complexity tier calibration consistency (Issue #574) =='


Write-Host ''
Write-Host '== Skill pointer drift (Issue #156) =='

Write-Host ''
Write-Host '== Orchestrator message registry (Issue #298) =='

Write-Host ''
Write-Host '== Orchestrator escalation contract (Issue #641) =='


Write-Host ''
Write-Host '== Reviewer failure evidence registration (Issue #312) =='

Write-Host ''
Write-Host '== orchestrator claimed review-start gate (Issue #318) =='


Write-Check 'verify-runtime/ao-spawn-shape-vitest' 'SKIP' 'owned by check-ao-spawn-shape.ps1 + full Vitest lane (Issue #488)'


Write-Check 'verify-runtime/autonomous-spawn-worktree-vitest' 'SKIP' 'owned by full Vitest lane (Issue #488)'


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
