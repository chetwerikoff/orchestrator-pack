#requires -Version 7.0
<#
.SYNOPSIS
  Dead-argv bypass scan for AO session/status reads (Issue #619 AC#9).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$InScopeRelativePaths = @(
    'scripts/lib/Invoke-AoCliJson.ps1',
    'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
    'scripts/orchestrator-wake-supervisor.ps1',
    'scripts/wait-orchestrator-launch.ps1',
    'scripts/lib/Autonomous-ClaimPrResumeGate.ps1',
    'scripts/orchestrator-wake-listener.ps1',
    'scripts/lib/Worker-Recovery.ps1',
    'scripts/dead-worker-reconcile.ps1',
    'scripts/lib/Worker-NudgeClaim.ps1',
    'scripts/lib/Get-ClaimedReviewStartSnapshot.ps1',
    'scripts/invoke-gated-worker-nudge.ps1',
    'scripts/lib/Invoke-ReviewWakeTrigger.ps1',
    'scripts/ci-failure-notification-reaction.ps1',
    'scripts/ci-failure-notification-reconcile.ps1',
    'scripts/ci-green-wake-reconcile.ps1',
    'scripts/check-ci-failure-notification-adoption.ps1'
)

$AllowlistedRelativePaths = @(
    'scripts/lib/Invoke-AoCliJson.ps1',
    'scripts/check-ao-cli-argv-shape.ps1',
    'scripts/check-ao-dead-argv-bypass.ps1',
    'scripts/check-ao-session-adapter-project-filter.ps1',
    'scripts/check-ao-0-10-cli-capture-redaction.ps1',
    'scripts/check-contract-evidence-reverify.ps1',
    'scripts/generate-review-pipeline-spawn-captures.ts',
    'scripts/lib/Get-RtkMissedSavingsInventory.ps1',
    'scripts/lib/reverify-e2e-fixture-session.ts'
)

$ForbiddenPatterns = @(
    "ao\s+status\b[^\n\r]*--reports",
    "ao\s+status\b[^\n\r]*-p\b",
    "@\(\s*'status'\s*,\s*'--json'\s*,\s*'--reports'",
    "@\(\s*'status'\s*,\s*'--json'\s*\)[^\n\r]*-p",
    "(?<!Get-Ao)\bao\s+session\s+ls\b",
    "(?<!Get-Ao)\bao\s+orchestrator\s+ls\b",
    "(?<!Get-Ao)\bao\s+session\s+get\b"
)

$violations = New-Object System.Collections.Generic.List[string]

foreach ($rel in $InScopeRelativePaths) {
    $path = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $violations.Add("$rel :: missing in-scope file")
        continue
    }
    if ($AllowlistedRelativePaths -contains $rel) {
        continue
    }

    $lines = Get-Content -LiteralPath $path
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($line -match '^\s*#') { continue }
        if ($line -match 'return\s+".*ao (status|session|orchestrator)|Write-Host.*ao (status|session|orchestrator)|operator.*ao (status|session|orchestrator)') { continue }
        foreach ($pattern in $ForbiddenPatterns) {
            if ($line -match $pattern) {
                $violations.Add("$rel`:$($i + 1): $line")
            }
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Host '[FAIL] dead-argv bypass scan (Issue #619):'
    foreach ($v in $violations) { Write-Host "  - $v" }
    exit 1
}

Write-Host '[PASS] dead-argv bypass scan (Issue #619)'
exit 0
