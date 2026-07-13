#requires -Version 7.0
<#
.SYNOPSIS
  Dead-argv bypass scan for AO session/status reads (Issue #619 AC#9) and journaled send transport (Issue #640 AC#7).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$SessionStatusInScopeRelativePaths = @(
    'scripts/lib/Invoke-AoCliJson.ps1',
    'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
    'scripts/orchestrator-wake-supervisor.ps1',
    'scripts/wait-orchestrator-launch.ps1',
    'scripts/lib/Autonomous-ClaimPrResumeGate.ps1',
    'scripts/lib/Worker-Recovery.ps1',
    'scripts/dead-worker-reconcile.ps1',
    'scripts/lib/Worker-NudgeClaim.ps1',
    'scripts/lib/Get-ClaimedReviewStartSnapshot.ps1',
    'scripts/invoke-gated-worker-nudge.ps1',
    'scripts/lib/Invoke-ReviewWakeTrigger.ps1',
    'scripts/ci-failure-notification-reconcile.ps1',
    'scripts/ci-green-wake-reconcile.ps1',
    'scripts/check-ci-failure-notification-adoption.ps1'
)

$SendTransportInScopeRelativePaths = @(
    'scripts/journaled-worker-send.ps1',
    'scripts/lib/Invoke-WorkerMessageSendAdoptionPreflight.ps1',
    'scripts/worker-message-send-adoption-preflight.ps1',
    'scripts/invoke-gated-worker-nudge.ps1',
    'scripts/ci-failure-notification-reconcile.ps1',
    'scripts/ci-green-wake-reconcile.ps1'
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

$SessionStatusForbiddenPatterns = @(
    "ao\s+status\b[^\n\r]*--reports",
    "ao\s+status\b[^\n\r]*-p\b",
    "@\(\s*'status'\s*,\s*'--json'\s*,\s*'--reports'",
    "@\(\s*'status'\s*,\s*'--json'\s*\)[^\n\r]*-p",
    "(?<!Get-Ao)\bao\s+session\s+ls\b",
    "(?<!Get-Ao)\bao\s+orchestrator\s+ls\b",
    "(?<!Get-Ao)\bao\s+session\s+get\b"
)

$SendTransportForbiddenPatterns = @(
    "@\(\s*'send'\s*,\s*\`$",
    "@\(\s*'send'\s*,\s*\[",
    "@\(\s*'send'\s*,\s*'[^-]",
    "@\(\s*'send'\s*,\s*'[^']+'\s*,\s*'--file'",
    "'--file'\s*,\s*\`$payloadFile",
    "'--no-wait'",
    "'--timeout'"
)

$violations = New-Object System.Collections.Generic.List[string]

function Test-DeadArgvBypassLines {
    param(
        [string]$RelativePath,
        [string[]]$Patterns
    )

    $path = Join-Path $Root $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $violations.Add("$RelativePath :: missing in-scope file")
        return
    }
    if ($AllowlistedRelativePaths -contains $RelativePath) {
        return
    }

    $lines = Get-Content -LiteralPath $path
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($line -match '^\s*#') { continue }
        if ($line -match 'return\s+".*ao (status|session|orchestrator|send)|Write-Host.*ao (status|session|orchestrator|send)|operator.*ao (status|session|orchestrator|send)') { continue }
        foreach ($pattern in $Patterns) {
            if ($line -match $pattern) {
                $violations.Add("$RelativePath`:$($i + 1): $line")
            }
        }
    }
}

foreach ($rel in $SessionStatusInScopeRelativePaths) {
    Test-DeadArgvBypassLines -RelativePath $rel -Patterns $SessionStatusForbiddenPatterns
}

foreach ($rel in $SendTransportInScopeRelativePaths) {
    Test-DeadArgvBypassLines -RelativePath $rel -Patterns $SendTransportForbiddenPatterns
}

if ($violations.Count -gt 0) {
    Write-Host '[FAIL] dead-argv bypass scan (Issues #619 / #640):'
    foreach ($v in $violations) { Write-Host "  - $v" }
    exit 1
}

Write-Host '[PASS] dead-argv bypass scan (Issues #619 / #640)'
exit 0
