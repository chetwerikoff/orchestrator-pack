#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = if ($args.Count -gt 0 -and $args[0]) { (Resolve-Path -LiteralPath $args[0]).Path } else { Split-Path -Parent $PSScriptRoot }

$inventoryPath = Join-Path $Root 'scripts/orchestrator-escalation-emitter-inventory.json'
$failures = [System.Collections.Generic.List[string]]::new()

if (-not (Test-Path -LiteralPath $inventoryPath)) {
    Write-Host "[FAIL] missing inventory: $inventoryPath"
    exit 1
}

$inventory = Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json
foreach ($entry in @($inventory.emitters)) {
    $rel = [string]$entry.file
    $full = Join-Path $Root ($rel -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $full)) {
        $failures.Add("missing file: $rel")
        continue
    }
    $text = Get-Content -LiteralPath $full -Raw
    if ($text -notmatch 'Publish-OrchestratorEscalation|Invoke-OrchestratorEscalationEmit') {
        $failures.Add("${rel}: no shared publish call (anchor: $($entry.anchor))")
    }
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] orchestrator escalation emitter guard:'
    foreach ($f in $failures) { Write-Host "  - $f" }
    exit 1
}

Write-Host '[PASS] orchestrator escalation emitters use shared publish entry point.'
exit 0
