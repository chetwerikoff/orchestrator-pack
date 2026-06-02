#Requires -Version 5.1
# PACK_REVIEWER persistent-env fallback (Issue #106).
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$entrypoint = Join-Path $Root 'scripts/invoke-pack-review.ps1'
$resolverPath = Join-Path $Root 'scripts/lib/Resolve-PackReviewer.ps1'
$precedenceFixture = Join-Path $Root 'tests/fixtures/pack-reviewer-selector/precedence-user-over-machine.json'

if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    Write-Host '[FAIL] scripts/invoke-pack-review.ps1 not found'
    exit 1
}

. $resolverPath

function Get-SavedPackReviewerUserValue {
    return [Environment]::GetEnvironmentVariable($Script:PackReviewerEnvVar, 'User')
}

function Set-PackReviewerUserValue {
    param([AllowNull()][string]$Value)

    [Environment]::SetEnvironmentVariable($Script:PackReviewerEnvVar, $Value, 'User')
}

function Invoke-EntrypointCapture {
    param([string]$RepoRoot)

    $output = & $entrypoint --repo-root $RepoRoot --base origin/main 2>&1 | Out-String
    return @{
        ExitCode = $LASTEXITCODE
        Output   = $output
    }
}

if (-not (Test-Path -LiteralPath $precedenceFixture -PathType Leaf)) {
    Write-Host "[FAIL] missing fixture $precedenceFixture"
    exit 1
}

$fixture = Get-Content -LiteralPath $precedenceFixture -Raw | ConvertFrom-Json
$overrideLayers = @{
    Process = $fixture.layers.process
    User    = $fixture.layers.user
    Machine = $fixture.layers.machine
}
$resolved = Get-PackReviewerFromSelector -OverrideLayers $overrideLayers
if ($resolved -ne $fixture.expectedReviewer) {
    Write-Host ("[FAIL] fixture precedence: expected {0}, got {1}" -f $fixture.expectedReviewer, $resolved)
    exit 1
}

$allUnset = @{
    Process = $null
    User    = $null
    Machine = $null
}
if ($null -ne (Get-PackReviewerFromSelector -OverrideLayers $allUnset)) {
    Write-Host '[FAIL] resolver must be unset when all PACK_REVIEWER layers are empty (override probe)'
    exit 1
}

$invalidUser = @{
    Process = $null
    User    = 'not-a-reviewer'
    Machine = $null
}
if ($null -ne (Get-PackReviewerFromSelector -OverrideLayers $invalidUser)) {
    Write-Host '[FAIL] unrecognized User PACK_REVIEWER must not resolve to a reviewer (override probe)'
    exit 1
}
$invalidMessage = Get-PackReviewerSelectorErrorMessage -OverrideLayers $invalidUser
if ($invalidMessage -notmatch "unrecognized value 'not-a-reviewer'") {
    Write-Host "[FAIL] unrecognized User value must use existing message (got: $invalidMessage)"
    exit 1
}

function Test-PackReviewerUserScopeWritable {
    $probeName = "PACK_REVIEWER_PROBE_$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
    try {
        [Environment]::SetEnvironmentVariable($probeName, '1', 'User')
        $read = [Environment]::GetEnvironmentVariable($probeName, 'User')
        [Environment]::SetEnvironmentVariable($probeName, $null, 'User')
        return ($read -eq '1')
    }
    catch {
        return $false
    }
}

if (-not (Test-PackReviewerUserScopeWritable)) {
    Write-Host '[PASS] PACK_REVIEWER resolver fixture checks (persistent User scope unavailable; process-only)'
    exit 0
}

$machineValue = [Environment]::GetEnvironmentVariable($Script:PackReviewerEnvVar, 'Machine')
if (-not [string]::IsNullOrWhiteSpace($machineValue)) {
    Write-Host "[SKIP] entrypoint fail-closed probe: Machine PACK_REVIEWER is set ($machineValue); cannot clear without elevation"
}
else {
    $savedUser = Get-SavedPackReviewerUserValue
    try {
        Set-PackReviewerUserValue -Value $null
        Remove-Item Env:PACK_REVIEWER -ErrorAction SilentlyContinue

        $captured = Invoke-EntrypointCapture -RepoRoot $Root
        if ($captured.ExitCode -eq 0) {
            Write-Host '[FAIL] invoke-pack-review.ps1 must fail closed when PACK_REVIEWER is unset in all layers'
            exit 1
        }
        if ($captured.ExitCode -ne 0 -and $captured.Output -notmatch 'PACK_REVIEWER is not set') {
            $expected = Get-PackReviewerSelectorErrorMessage -OverrideLayers $allUnset
            if ($captured.Output -notmatch [regex]::Escape($expected)) {
                Write-Host '[FAIL] unset selector must fail closed (exit non-zero and unset message)'
                Write-Host $captured.Output
                exit 1
            }
        }
    }
    finally {
        Set-PackReviewerUserValue -Value $savedUser
        if ($null -ne $savedUser) {
            $env:PACK_REVIEWER = $savedUser
        }
        else {
            Remove-Item Env:PACK_REVIEWER -ErrorAction SilentlyContinue
        }
    }
}

$savedUser = Get-SavedPackReviewerUserValue
try {
    Set-PackReviewerUserValue -Value 'claude'
    Remove-Item Env:PACK_REVIEWER -ErrorAction SilentlyContinue

    $resolved = Get-PackReviewerFromSelector
    if ($resolved -ne 'claude') {
        Write-Host "[FAIL] User-level PACK_REVIEWER=claude must resolve to claude (got $resolved)"
        exit 1
    }

    $captured = Invoke-EntrypointCapture -RepoRoot $Root
    if ($captured.Output -match 'PACK_REVIEWER is not set') {
        Write-Host '[FAIL] User-level selector must not emit PACK_REVIEWER is not set'
        Write-Host $captured.Output
        exit 1
    }
    if ($captured.ExitCode -eq 0) {
        Write-Host '[PASS] User-level fallback resolves claude (entrypoint reached wrapper dispatch)'
    }
    else {
        $wrapperPath = Get-PackReviewWrapperPathForReviewer -Reviewer 'claude' -ScriptsRoot (Join-Path $Root 'scripts')
        if (-not (Test-Path -LiteralPath $wrapperPath -PathType Leaf)) {
            Write-Host "[FAIL] expected claude wrapper at $wrapperPath for fallback smoke"
            exit 1
        }
        Write-Host '[PASS] User-level fallback resolves claude (non-zero exit from wrapper preflight is acceptable)'
    }

    Set-PackReviewerUserValue -Value 'not-a-reviewer'
    Remove-Item Env:PACK_REVIEWER -ErrorAction SilentlyContinue

    $captured = Invoke-EntrypointCapture -RepoRoot $Root
    if ($captured.ExitCode -eq 0) {
        Write-Host '[FAIL] invoke-pack-review.ps1 must fail closed for unrecognized User PACK_REVIEWER'
        exit 1
    }
    if ($captured.Output -notmatch 'unrecognized value') {
        Write-Host '[FAIL] unrecognized User PACK_REVIEWER must emit unrecognized-value message'
        Write-Host $captured.Output
        exit 1
    }
}
finally {
    Set-PackReviewerUserValue -Value $savedUser
    if ($null -ne $savedUser) {
        $env:PACK_REVIEWER = $savedUser
    }
    else {
        Remove-Item Env:PACK_REVIEWER -ErrorAction SilentlyContinue
    }
}

Write-Host '[PASS] PACK_REVIEWER persistent-env fallback checks (Issue #106)'
exit 0
