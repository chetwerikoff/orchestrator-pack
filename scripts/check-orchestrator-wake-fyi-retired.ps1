#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = if ($args.Count -gt 0 -and $args[0]) { (Resolve-Path -LiteralPath $args[0]).Path } else { Split-Path -Parent $PSScriptRoot }

$catalogPath = Join-Path $Root 'scripts/orchestrator-message-catalog.json'
$helperManifestPath = Join-Path $Root 'scripts/orchestrator-message-send-helpers.manifest.json'
$protectedRuntimePath = Join-Path $Root 'scripts/orchestrator-message-protected-runtime.manifest.json'
$auditRootsPath = Join-Path $Root 'scripts/orchestrator-message-audit-roots.manifest.json'
$failures = [System.Collections.Generic.List[string]]::new()

$sourceFiles = @(
    Get-Item -LiteralPath (Join-Path $Root 'scripts/orchestrator-wake-listener.ps1')
    Get-Item -LiteralPath (Join-Path $Root 'scripts/orchestrator-wake-common.ps1')
    Get-Item -LiteralPath (Join-Path $Root 'scripts/orchestrator-wake-heartbeat.ps1')
)

foreach ($file in $sourceFiles) {
    $text = Get-Content -LiteralPath $file.FullName -Raw
    if ($text -match '\bSend-OrchestratorWakeMessage\b') {
        $rel = [IO.Path]::GetRelativePath($Root, $file.FullName).Replace('\', '/')
        $failures.Add("live FYI wake helper reference remains: $rel")
    }
}

if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) {
    $failures.Add('missing orchestrator message catalog')
}
else {
    $catalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
    $entryIds = @($catalog.entries | ForEach-Object { [string]$_.message_class_id })
    foreach ($id in @('orchestrator-wake-webhook', 'orchestrator-wake-heartbeat')) {
        if ($entryIds -contains $id) {
            $failures.Add("retired FYI message class still present: $id")
        }
    }
}

if (Test-Path -LiteralPath $helperManifestPath -PathType Leaf) {
    $manifest = Get-Content -LiteralPath $helperManifestPath -Raw | ConvertFrom-Json
    if (@($manifest.helpers | Where-Object { $_.name -eq 'Send-OrchestratorWakeMessage' }).Count -gt 0) {
        $failures.Add('Send-OrchestratorWakeMessage still registered in send helper manifest')
    }
}

if (Test-Path -LiteralPath $protectedRuntimePath -PathType Leaf) {
    $manifest = Get-Content -LiteralPath $protectedRuntimePath -Raw | ConvertFrom-Json
    if (@($manifest.runtimeSendHelpers) -contains 'scripts/orchestrator-wake-common.ps1') {
        $failures.Add('orchestrator-wake-common.ps1 still listed as runtime send helper')
    }
    if (@($manifest.supervisedEntrypoints) -contains 'scripts/orchestrator-wake-heartbeat.ps1') {
        $failures.Add('orchestrator-wake-heartbeat.ps1 still listed as supervised entrypoint')
    }
}

if (Test-Path -LiteralPath $auditRootsPath -PathType Leaf) {
    $manifest = Get-Content -LiteralPath $auditRootsPath -Raw | ConvertFrom-Json
    if (@($manifest.supervisedProcessScripts) -contains 'scripts/orchestrator-wake-heartbeat.ps1') {
        $failures.Add('orchestrator-wake-heartbeat.ps1 still listed in audit roots manifest')
    }
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] orchestrator wake FYI retirement guard:'
    foreach ($failure in $failures) {
        Write-Host "  - $failure"
    }
    exit 1
}

Write-Host '[PASS] orchestrator FYI wake/heartbeat channel retired.'
exit 0
