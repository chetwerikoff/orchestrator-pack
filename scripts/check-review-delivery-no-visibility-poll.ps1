#requires -Version 5.1
<#
.SYNOPSIS
  Guard: submit_visibility_timeout retired from review delivery critical path (Issue #718 AC#2).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$targets = @(
    (Join-Path $Root 'scripts/lib/Invoke-ScriptedReviewPostSubmitDelivery.ps1'),
    (Join-Path $Root 'scripts/lib/Invoke-ScriptedReviewStdoutDelivery.ps1'),
    (Join-Path $Root 'scripts/invoke-pack-review.ps1')
)

$forbidden = @(
    'submit_visibility_timeout',
    'Wait-ScriptedReviewSubmittedRun',
    'find-submitted-run',
    'resolve-submit-visibility-config'
)

foreach ($path in $targets) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required file: $path"
        exit 1
    }
    $text = Get-Content -LiteralPath $path -Raw
    foreach ($token in $forbidden) {
        if ($text -match [regex]::Escape($token)) {
            Write-Host "$path must not reference retired visibility oracle token: $token"
            exit 1
        }
    }
}

$postSubmit = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Invoke-ScriptedReviewPostSubmitDelivery.ps1') -Raw
if ($postSubmit -notmatch 'Invoke-ScriptedReviewStdoutDelivery') {
    Write-Host 'Invoke-ScriptedReviewPostSubmitDelivery.ps1 must route through stdout-first delivery'
    exit 1
}

$stdoutLib = Get-Content -LiteralPath (Join-Path $Root 'scripts/lib/Invoke-ScriptedReviewStdoutDelivery.ps1') -Raw
if ($stdoutLib -notmatch 'journaled-worker-send\.ps1') {
    Write-Host 'Invoke-ScriptedReviewStdoutDelivery.ps1 must send via journaled-worker-send'
    exit 1
}
if ($stdoutLib -match 'Get-AoSessionReviewsJson') {
    Write-Host 'Invoke-ScriptedReviewStdoutDelivery.ps1 must not poll session reviews on critical path'
    exit 1
}

Write-Host '[PASS] review delivery visibility poll retired (Issue #718)'
exit 0
