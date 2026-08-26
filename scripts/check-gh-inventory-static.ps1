#requires -Version 5.1
<#
.SYNOPSIS
  Static guard: GitHub read forms in pack scripts and agent-facing rule surfaces
  are covered by the tracked REST inventory, and bounded production read surfaces
  do not select ambient gh as their executable.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$GuardScript = Join-Path $Root 'scripts/lib/gh-inventory-static-guard.mjs'
$InventoryScript = Join-Path $Root 'scripts/lib/graphql-quota-github-read-inventory.mjs'

function Invoke-GhInventoryGuard {
    param(
        [string]$FilePath,
        [ValidateSet('reconcile', 'rules', 'transport')]
        [string]$Mode
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { return @() }

    $output = & node $GuardScript $FilePath --mode $Mode 2>&1
    if ($LASTEXITCODE -eq 0) { return @() }

    try {
        return @($output | ConvertFrom-Json)
    }
    catch {
        throw "gh inventory guard failed for ${FilePath}: $output"
    }
}

function Test-TransportGuardFixtures {
    $fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("opk-gh-transport-guard-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
    try {
        $ambientFixture = Join-Path $fixtureRoot 'ambient.ts'
        $multilineAmbientFixture = Join-Path $fixtureRoot 'ambient-multiline.ts'
        $boundFixture = Join-Path $fixtureRoot 'bound.ts'
        Set-Content -LiteralPath $ambientFixture -Encoding UTF8 -NoNewline -Value "runProcess({ command: 'gh', args: ['pr', 'view', '1'] });"
        Set-Content -LiteralPath $multilineAmbientFixture -Encoding UTF8 -NoNewline -Value @"
runProcess({
  command:
    'gh',
  args: ['pr', 'view', '1'],
});
"@
        Set-Content -LiteralPath $boundFixture -Encoding UTF8 -NoNewline -Value "const argv = ['gh', 'pr', 'view', '1']; runProcess({ command: resolveTrackedGhWrapper(), args: argv.slice(1) });"

        $ambient = @(Invoke-GhInventoryGuard -FilePath $ambientFixture -Mode 'transport')
        if ($ambient.Count -ne 1 -or $ambient[0].command -ne "command: 'gh'") {
            throw "transport guard negative fixture did not reject ambient gh exactly once"
        }
        $multilineAmbient = @(Invoke-GhInventoryGuard -FilePath $multilineAmbientFixture -Mode 'transport')
        if ($multilineAmbient.Count -ne 1 -or $multilineAmbient[0].command -ne "command: 'gh'") {
            throw "transport guard multiline negative fixture did not reject ambient gh exactly once"
        }
        $bound = @(Invoke-GhInventoryGuard -FilePath $boundFixture -Mode 'transport')
        if ($bound.Count -ne 0) {
            throw "transport guard positive fixture rejected already-bound semantic gh argv"
        }
    }
    finally {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$reconcileRoots = @(
    (Join-Path $Root 'scripts/lib/Gh-PrChecks.ps1'),
    (Join-Path $Root 'scripts/pr-scope-check.ps1'),
    (Join-Path $Root 'scripts/lib/Get-AutoReviewPrContext.ps1'),
    (Join-Path $Root 'scripts/worker-smoke-run.ts')
)

$ruleSurfaceRoots = @(
    (Join-Path $Root 'AGENTS.md'),
    (Join-Path $Root 'CLAUDE.md'),
    (Join-Path $Root 'prompts/investigate_root_cause.md'),
    (Join-Path $Root 'docs/pack-review-waiver-merge-runbook.md')
)

$transportRoots = @(
    (Join-Path $Root 'scripts/lib/pack-gpt-reviewer.ts'),
    (Join-Path $Root 'scripts/pack-review-runner.ts'),
    (Join-Path $Root 'scripts/lib/pack-gpt-source-comment.ts'),
    (Join-Path $Root 'scripts/lib/worker-smoke-core-base.ts'),
    (Join-Path $Root 'scripts/invoke-reviewer-contract-mapping.ts'),
    (Join-Path $Root 'plugins/codex-pr-reviewer/lib/scope_context.ts'),
    (Join-Path $Root 'scripts/lib/create-issue-stage-record-gh.ts'),
    (Join-Path $Root 'scripts/publish-issue-body-sync.ts'),
    (Join-Path $Root 'scripts/pr2-foundation/post-review-smoke.ts')
)

$violations = @()
foreach ($file in $reconcileRoots) {
    $violations += Invoke-GhInventoryGuard -FilePath $file -Mode 'reconcile'
}
foreach ($file in $ruleSurfaceRoots) {
    $violations += Invoke-GhInventoryGuard -FilePath $file -Mode 'rules'
}
foreach ($file in $transportRoots) {
    $violations += Invoke-GhInventoryGuard -FilePath $file -Mode 'transport'
}

# github-review-reconciliation is a mixed surface: Issue #1623 binds its actor/review
# reads to tracked scripts/gh but explicitly leaves the existing POST/PUT write
# semantics unchanged. Any additional ambient selector therefore fails the guard.
$reconciliationPath = Join-Path $Root 'scripts/lib/github-review-reconciliation.ts'
if (Test-Path -LiteralPath $reconciliationPath -PathType Leaf) {
    $reconciliationText = Get-Content -LiteralPath $reconciliationPath -Raw
    $ambientPattern = '(?m)\b(?:command\s*:\s*[''\"]gh[''\"]|execFileSync\s*\(\s*[''\"]gh[''\"]|execFile\s*\(\s*[''\"]gh[''\"]|spawnSync\s*\(\s*[''\"]gh[''\"]|spawn\s*\(\s*[''\"]gh[''\"]|ghApiJson\s*\(\s*[''\"]gh[''\"])'
    $postWritePattern = '(?s)command\s*:\s*[''\"]gh[''\"].{0,240}?args\s*:\s*\[\s*[''\"]api[''\"]\s*,\s*[''\"]--method[''\"]\s*,\s*[''\"]POST[''\"].{0,240}?repos/\$\{options\.repoSlug\}/pulls/\$\{options\.prNumber\}/reviews'
    $dismissWritePattern = '(?s)command\s*:\s*[''\"]gh[''\"].{0,320}?[''\"]--method[''\"]\s*,\s*[''\"]PUT[''\"].{0,320}?repos/\$\{options\.repoSlug\}/pulls/\$\{options\.prNumber\}/reviews/\$\{reviewId\}/dismissals'
    $ambientCount = [regex]::Matches($reconciliationText, $ambientPattern).Count
    $postWriteCount = [regex]::Matches($reconciliationText, $postWritePattern).Count
    $dismissWriteCount = [regex]::Matches($reconciliationText, $dismissWritePattern).Count
    if ($ambientCount -ne 2 -or $postWriteCount -ne 1 -or $dismissWriteCount -ne 1) {
        $violations += [pscustomobject]@{
            file = $reconciliationPath
            command = 'ambient gh executable selection outside the existing review POST/PUT write paths'
            line = "ambient=$ambientCount post=$postWriteCount dismiss=$dismissWriteCount"
        }
    }
}

# worker-smoke-run is a mixed surface: Issue #1623 binds reads to tracked scripts/gh
# but explicitly leaves the existing PR-comment POST write semantics unchanged. The
# only ambient selection may therefore live in the dedicated write helper, and that
# helper may be referenced only by publishPrComment's existing POST path.
$workerSmokePath = Join-Path $Root 'scripts/worker-smoke-run.ts'
if (Test-Path -LiteralPath $workerSmokePath -PathType Leaf) {
    $workerSmokeText = Get-Content -LiteralPath $workerSmokePath -Raw
    $ambientPattern = '(?m)\b(?:command\s*:\s*[''\"]gh[''\"]|execFileSync\s*\(\s*[''\"]gh[''\"]|execFile\s*\(\s*[''\"]gh[''\"]|spawnSync\s*\(\s*[''\"]gh[''\"]|spawn\s*\(\s*[''\"]gh[''\"]|ghApiJson\s*\(\s*[''\"]gh[''\"])'
    $knownWritePattern = '(?s)function\s+runSmokeGhWriteSync\s*\([^)]*\).*?command\s*:\s*[''\"]gh[''\"].*?\n\}'
    $knownPublishPattern = '(?s)export\s+function\s+publishPrComment\s*\([^)]*\).*?runSmokeGhWriteSync\s*\(\s*\[\s*[''\"]api[''\"].*?repos/\$\{TRUSTED_REPOSITORY_SLUG\}/issues/\$\{String\(prNumber\)\}/comments.*?--method[''\"]\s*,\s*[''\"]POST[''\"]'
    $ambientCount = [regex]::Matches($workerSmokeText, $ambientPattern).Count
    $knownWriteCount = [regex]::Matches($workerSmokeText, $knownWritePattern).Count
    $knownPublishCount = [regex]::Matches($workerSmokeText, $knownPublishPattern).Count
    $writeHelperReferences = [regex]::Matches($workerSmokeText, '\brunSmokeGhWriteSync\s*\(').Count
    if ($ambientCount -ne 1 -or $knownWriteCount -ne 1 -or $knownPublishCount -ne 1 -or $writeHelperReferences -ne 2) {
        $violations += [pscustomobject]@{
            file = $workerSmokePath
            command = 'ambient gh executable selection outside the one existing PR-comment POST write helper'
            line = "ambient=$ambientCount knownWrite=$knownWriteCount publish=$knownPublishCount helperRefs=$writeHelperReferences"
        }
    }
}

# pack-review-delivery owns an existing explicit GitHub status POST. Issue #1623
# does not authorize changing write-path behavior. Keep that one write selectable
# through native gh, but fail if this mixed surface ever gains another ambient gh
# executable selection (which would include a newly introduced read bypass).
$deliveryPath = Join-Path $Root 'scripts/lib/pack-review-delivery.ts'
if (Test-Path -LiteralPath $deliveryPath -PathType Leaf) {
    $deliveryText = Get-Content -LiteralPath $deliveryPath -Raw
    $ambientPattern = '(?m)\b(?:command\s*:\s*[''\"]gh[''\"]|execFileSync\s*\(\s*[''\"]gh[''\"]|execFile\s*\(\s*[''\"]gh[''\"]|spawnSync\s*\(\s*[''\"]gh[''\"]|spawn\s*\(\s*[''\"]gh[''\"]|ghApiJson\s*\(\s*[''\"]gh[''\"])'
    $knownWritePattern = '(?s)command\s*:\s*[''\"]gh[''\"].{0,240}?args\s*:\s*\[\s*[''\"]api[''\"]\s*,\s*[''\"]--method[''\"]\s*,\s*[''\"]POST[''\"].{0,240}?repos/\$\{options\.repoSlug\}/statuses/\$\{options\.headSha\}'
    $ambientCount = [regex]::Matches($deliveryText, $ambientPattern).Count
    $knownWriteCount = [regex]::Matches($deliveryText, $knownWritePattern).Count
    if ($ambientCount -gt 0 -and ($ambientCount -ne 1 -or $knownWriteCount -ne 1)) {
        $violations += [pscustomobject]@{
            file = $deliveryPath
            command = 'ambient gh executable selection outside the one explicit required-status POST write'
            line = "ambient=$ambientCount knownWrite=$knownWriteCount"
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Host '[FAIL] GitHub read inventory / tracked transport guard:'
    foreach ($item in $violations) {
        if ($item.line) {
            Write-Host "$($item.file): $($item.command) :: $($item.line)"
        }
        else {
            Write-Host "$($item.file): $($item.command)"
        }
    }
    exit 1
}

Test-TransportGuardFixtures

$inventoryOutput = & node $InventoryScript validate $Root 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host '[FAIL] GitHub read inventory completeness:'
    Write-Host $inventoryOutput
    exit 1
}

Write-Host '[PASS] GitHub read inventory static guard'
exit 0
