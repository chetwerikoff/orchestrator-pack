#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = if ($args.Count -gt 0 -and $args[0]) { (Resolve-Path -LiteralPath $args[0]).Path } else { Split-Path -Parent $PSScriptRoot }

$inventoryPath = Join-Path $Root 'scripts/orchestrator-escalation-emitter-inventory.json'
$catalogPath = Join-Path $Root 'scripts/orchestrator-message-catalog.json'
$failures = [System.Collections.Generic.List[string]]::new()

$matrixClasses = @(
    'escalation-dead-worker-recovery',
    'escalation-claim-store-integrity',
    'escalation-review-trigger-degraded-ci',
    'escalation-submit-adoption',
    'escalation-handoff-envelope',
    'escalation-pipeline-failure',
    'escalation-ci-failure-notify',
    'escalation-ci-green-claim-audit',
    'escalation-ci-green-claim',
    'escalation-gated-nudge',
    'escalation-envelope-ledger',
    'escalation-review-start-claim',
    'escalation-worker-recovery',
    'escalation-worker-degraded-ci-handoff'
)

if (-not (Test-Path -LiteralPath $catalogPath)) {
    $failures.Add("missing catalog: $catalogPath")
}
else {
    $catalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
    $byId = @{}
    foreach ($row in @($catalog.escalationClasses)) {
        if ($row.escalation_class_id) {
            $byId[[string]$row.escalation_class_id] = $row
        }
    }
    foreach ($classId in $matrixClasses) {
        if (-not $byId.ContainsKey($classId)) {
            $failures.Add("matrix class missing from catalog: $classId")
            continue
        }
        $row = $byId[$classId]
        foreach ($field in @('code', 'name', 'owning_process', 'route', 'delivery_guarantee', 'dedupe_owner')) {
            if (-not $row.$field) {
                $failures.Add("${classId}: missing $field")
            }
        }
        if ([string]$row.route -eq 'auto-retry-only') {
            $target = if ($row.promotion_target_class_id) { [string]$row.promotion_target_class_id } elseif ($row.promotes_to) { [string]$row.promotes_to } else { '' }
            if (-not $row.promotion_after_ticks -or -not $target) {
                $failures.Add("${classId}: auto-retry-only requires promotion_after_ticks and promotes_to")
            }
        }
    }
}

if (-not (Test-Path -LiteralPath $inventoryPath)) {
    $failures.Add("missing emitter inventory: $inventoryPath")
}
else {
    $inventory = Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json
    foreach ($entry in @($inventory.emitters)) {
        $rel = [string]$entry.file
        $full = Join-Path $Root ($rel -replace '/', [IO.Path]::DirectorySeparatorChar)
        if (-not (Test-Path -LiteralPath $full)) {
            $failures.Add("inventory file missing: $rel")
            continue
        }
        $text = Get-Content -LiteralPath $full -Raw
        if ($text -notmatch 'Publish-OrchestratorEscalation|Invoke-OrchestratorEscalationEmit') {
            $failures.Add("$rel missing Publish-OrchestratorEscalation adoption at anchor $($entry.anchor)")
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] orchestrator escalation catalog guard:'
    foreach ($f in $failures) { Write-Host "  - $f" }
    exit 1
}

Write-Host '[PASS] orchestrator escalation catalog and emitter inventory OK.'
exit 0
