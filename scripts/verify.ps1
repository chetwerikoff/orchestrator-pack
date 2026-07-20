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
[void](Test-CommandVersion -Command 'node' -Minimum ([version]'22.0.0') -Required)
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
$typeScriptCliHelper = Join-Path $Root 'scripts/lib/Invoke-TypeScriptCli.ts'
if ((Test-Path -LiteralPath $gateRunnerPath -PathType Leaf) -and (Test-Path -LiteralPath $typeScriptCliHelper -PathType Leaf)) {
    try {
        $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $node) { throw 'OPK_NODE_RUNTIME_MISSING: Node.js 22.x is required to run TypeScript entrypoints.' }
        $nodeVersion = ((& $node.Source '--version' 2>&1 | Out-String).Trim())
        if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') { throw "OPK_NODE_RUNTIME_UNSUPPORTED: Node.js 22.x is required; running $nodeVersion. Install/use Node 22 and run npm run check:node-major." }
        $typeScriptLauncher = $typeScriptCliHelper
        $gateRunnerNodeArgs = @('--experimental-strip-types', $typeScriptLauncher, '--script', $gateRunnerPath, '--')
        & $node.Source @gateRunnerNodeArgs '--repo-root' $Root
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
        @{ Path = 'scripts/check-ao-dead-argv-bypass.ps1'; Label = 'dead-argv bypass scan (Issue #619)' }
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
