#requires -Version 5.1
<#
.SYNOPSIS
  Guard the #1248 hard cut from the retired PowerShell stdout-delivery path to the TypeScript delivery authority.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$retired = @(
    'scripts/lib/Invoke-ScriptedReviewStdoutDelivery.ps1',
    'scripts/lib/Invoke-ScriptedReviewPostSubmitDelivery.ps1'
)
foreach ($relativePath in $retired) {
    $path = Join-Path $Root $relativePath
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        Write-Host "$relativePath must remain absent after the #1248 PowerShell hard cut"
        exit 1
    }
}

$deliveryPath = Join-Path $Root 'scripts/lib/pack-review-delivery.ts'
if (-not (Test-Path -LiteralPath $deliveryPath -PathType Leaf)) {
    Write-Host 'TypeScript pack-review delivery authority is missing'
    exit 1
}

$delivery = Get-Content -LiteralPath $deliveryPath -Raw
$requiredMarkers = @(
    'deliverPackReviewVerdict',
    'writeRequiredStatus',
    'notifyWorker',
    'journalOutcome'
)
foreach ($marker in $requiredMarkers) {
    if ($delivery -notmatch [regex]::Escape($marker)) {
        Write-Host "pack-review-delivery.ts is missing required delivery marker: $marker"
        exit 1
    }
}

$forbidden = @(
    'submit_visibility_timeout',
    'Wait-ScriptedReviewSubmittedRun',
    'find-submitted-run',
    'resolve-submit-visibility-config',
    'journaled-worker-send.ps1',
    'Get-AoSessionReviewsJson'
)
foreach ($token in $forbidden) {
    if ($delivery -match [regex]::Escape($token)) {
        Write-Host "pack-review-delivery.ts must not reference retired visibility or PowerShell delivery token: $token"
        exit 1
    }
}

Write-Host '[PASS] review delivery is TypeScript-owned with no retired visibility polling or PowerShell bridge'
exit 0
