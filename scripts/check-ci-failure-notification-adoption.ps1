#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$liveYaml = Join-Path $Root 'agent-orchestrator.yaml'
if (-not (Test-Path -LiteralPath $liveYaml -PathType Leaf)) {
    Write-Host '[SKIP] live agent-orchestrator.yaml not present — adoption gate requires operator checkout'
    exit 0
}

function Get-YamlWithoutOrchestratorRules {
    param([string]$Raw)
    $lines = $Raw -split "`n"
    $out = New-Object System.Collections.Generic.List[string]
    $skip = $false
    foreach ($line in $lines) {
        if ($line -match '^\s+orchestratorRules:\s*\|\s*$') {
            $skip = $true
            continue
        }
        if ($skip) {
            if ($line -match '^\S') {
                $skip = $false
                $out.Add($line)
            }
            continue
        }
        $out.Add($line)
    }
    return ($out -join "`n")
}

$raw = Get-Content -LiteralPath $liveYaml -Raw
$executableYaml = Get-YamlWithoutOrchestratorRules -Raw $raw

$reactionScript = Join-Path $Root 'scripts/ci-failure-notification-reaction.ps1'
$reconcileScript = Join-Path $Root 'scripts/ci-failure-notification-reconcile.ps1'
$registryPath = Join-Path $Root 'scripts/orchestrator-side-process-registry.json'
$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json

$reconcileRaw = if (Test-Path -LiteralPath $reconcileScript -PathType Leaf) {
    Get-Content -LiteralPath $reconcileScript -Raw
} else { '' }
$workerStateOk = ($registry.requiredChildIds -contains 'ci-failure-notification-reconcile') -and
    ($reconcileRaw -match 'Get-AoStatusSessions')
$dispatchOk = ($reconcileRaw -match 'Register-WorkerMessageDispatch') -and
    (Test-Path -LiteralPath (Join-Path $Root 'scripts/lib/Record-WorkerMessageDispatch.ps1') -PathType Leaf)
$reactionRecordOk = (Test-Path -LiteralPath $reactionScript -PathType Leaf) -and
    ($registry.requiredChildIds -contains 'ci-failure-notification-reaction') -and
    ($executableYaml -match '(?m)^reactions:\s*[\s\S]*?\bci-failed\s*:') -and
    ($executableYaml -match 'ci-failure-notification-reaction\.ps1')

$result = @{
    workerStateInputConfigured = [bool]$workerStateOk
    durableSubmitAckConfigured = [bool]$dispatchOk
    reactionRecordConfigured   = [bool]$reactionRecordOk
} | ConvertTo-Json -Compress
$output = $result | pwsh -NoProfile -File (Join-Path $Root 'scripts/ci-failure-notification.ps1') -Mode init-gate 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host $output
    exit 1
}
$gate = ($output | Out-String).Trim() | ConvertFrom-Json
if (-not $gate.ok -or -not $gate.reactionEnabled) {
    Write-Host "[FAIL] live YAML ci-failed adoption gate (Issue #342): ok=$($gate.ok) reactionEnabled=$($gate.reactionEnabled)"
    if ($gate.errors) {
        foreach ($err in @($gate.errors)) {
            Write-Host "  - $err"
        }
    }
    exit 1
}
Write-Host '[PASS] live YAML ci-failed adoption gate (Issue #342)'
