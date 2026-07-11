#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$Root = if ($args.Count -gt 0 -and $args[0]) { (Resolve-Path -LiteralPath $args[0]).Path } else { Split-Path -Parent $PSScriptRoot }

$failures = [System.Collections.Generic.List[string]]::new()

$runbook = Get-Content -LiteralPath (Join-Path $Root 'docs/orchestrator-wake-runbook.md') -Raw
if ($runbook -match 'orchestrator-wake-heartbeat\.ps1|heartbeat backstop|listener and heartbeat|Start \(heartbeat|wake heartbeat\.reconcile') {
    $failures.Add('orchestrator-wake-runbook.md still documents heartbeat as an active orchestrator-turn path')
}
if ($runbook -notmatch 'escalation-router') {
    $failures.Add('orchestrator-wake-runbook.md must document escalation-router as the remaining orchestrator liveness path')
}

$fleet = Get-Content -LiteralPath (Join-Path $Root 'docs/wake-supervisor-fleet-operator-reference.md') -Raw
if ($fleet -match '\| `heartbeat` \||### heartbeat|orchestrator-wake-heartbeat\.ps1') {
    $failures.Add('wake-supervisor-fleet-operator-reference.md still lists heartbeat as a managed child')
}
if ($fleet -notmatch 'escalation-router') {
    $failures.Add('wake-supervisor-fleet-operator-reference.md must document escalation-router as the orchestrator-facing liveness child')
}

$migration = Get-Content -LiteralPath (Join-Path $Root 'docs/migration_notes.md') -Raw
if ($migration -notmatch 'Issue #721') {
    $failures.Add('migration_notes.md must include Issue #721 operator adoption guidance')
}
if ($migration -notmatch 'escalation-router poll') {
    $failures.Add('migration_notes.md must state escalation-router poll is the orchestrator liveness path after heartbeat retirement')
}
if ($migration -match 'manual listener \+ heartbeat pair|listener and heartbeat in separate terminals|orchestrator-wake-heartbeat\.ps1 -DryRun -Once|heartbeat still delivers periodic orchestrator turns|Status` shows listener and\s+heartbeat running|all registry-managed side-processes \(listener,\s*heartbeat|restart wake listener/heartbeat if used|\(and heartbeat if used\)') {
    $failures.Add('migration_notes.md still contains active operator prose that treats heartbeat as a live orchestrator-turn path')
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] orchestrator wake heartbeat retirement guard:'
    foreach ($failure in $failures) {
        Write-Host "  - $failure"
    }
    exit 1
}

Write-Host '[PASS] heartbeat event-silence contract retired from active operator docs.'
exit 0
