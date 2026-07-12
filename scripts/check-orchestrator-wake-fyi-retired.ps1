#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = if ($args.Count -gt 0 -and $args[0]) { (Resolve-Path -LiteralPath $args[0]).Path } else { Split-Path -Parent $PSScriptRoot }

$catalogPath = Join-Path $Root 'scripts/orchestrator-message-catalog.json'
$helperManifestPath = Join-Path $Root 'scripts/orchestrator-message-send-helpers.manifest.json'
$protectedRuntimePath = Join-Path $Root 'scripts/orchestrator-message-protected-runtime.manifest.json'
$auditRootsPath = Join-Path $Root 'scripts/orchestrator-message-audit-roots.manifest.json'
$listenerPath = Join-Path $Root 'scripts/orchestrator-wake-listener.ps1'
$failures = [System.Collections.Generic.List[string]]::new()

if (Test-Path -LiteralPath $listenerPath -PathType Leaf) {
    $failures.Add('retired orchestrator-wake-listener.ps1 entrypoint still exists')
}

$sourceFiles = @(
    Join-Path $Root 'scripts/orchestrator-wake-common.ps1'
    Join-Path $Root 'scripts/orchestrator-wake-heartbeat.ps1'
)
foreach ($path in $sourceFiles) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    $text = Get-Content -LiteralPath $path -Raw
    if ($text -match '\bSend-OrchestratorWakeMessage\b') {
        $rel = [IO.Path]::GetRelativePath($Root, $path).Replace('\', '/')
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
    if (@($catalog.escalationClasses | Where-Object { [string]$_.owning_process -eq 'listener' }).Count -gt 0) {
        $failures.Add('retired listener still owns an escalation class')
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
    foreach ($retiredPath in @('scripts/orchestrator-wake-heartbeat.ps1', 'scripts/orchestrator-wake-listener.ps1')) {
        if (@($manifest.supervisedEntrypoints) -contains $retiredPath) {
            $failures.Add("$retiredPath still listed as supervised entrypoint")
        }
        if (@($manifest.prerequisiteDeclaredPaths) -contains $retiredPath) {
            $failures.Add("$retiredPath still listed as protected prerequisite path")
        }
    }
}

if (Test-Path -LiteralPath $auditRootsPath -PathType Leaf) {
    $manifest = Get-Content -LiteralPath $auditRootsPath -Raw | ConvertFrom-Json
    foreach ($retiredPath in @('scripts/orchestrator-wake-heartbeat.ps1', 'scripts/orchestrator-wake-listener.ps1')) {
        if (@($manifest.supervisedProcessScripts) -contains $retiredPath) {
            $failures.Add("$retiredPath still listed in audit roots manifest")
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] orchestrator wake FYI/listener retirement guard:'
    foreach ($failure in $failures) { Write-Host "  - $failure" }
    exit 1
}

Write-Host '[PASS] orchestrator FYI wake, heartbeat, and listener channels retired.'
exit 0
