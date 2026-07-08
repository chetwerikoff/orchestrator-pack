#requires -Version 5.1
<#
.SYNOPSIS
  Moved-content guard: deep-dive anchors must not remain in AGENTS.md (Issue #678).
#>
param(
    [string]$RepoRoot
)

. (Join-Path $PSScriptRoot 'lib/Initialize-PackGateCheck.ps1')
$gate = Initialize-PackGateCheck -RepoRoot $RepoRoot -CallerScriptRoot $PSScriptRoot
$RepoRoot = $gate.RepoRoot

$agentsMd = Join-Path $RepoRoot 'AGENTS.md'
$coworkerDoc = Join-Path $RepoRoot 'docs/coworker-delegation.md'
$tieringDoc = Join-Path $RepoRoot 'docs/tiering.md'
$scriptOwnedDoc = Join-Path $RepoRoot 'docs/script-owned-review-pipeline.md'

foreach ($path in @($agentsMd, $coworkerDoc, $tieringDoc, $scriptOwnedDoc)) {
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "[FAIL] missing required file: $path"
        exit 1
    }
}

$agentsText = Get-Content -LiteralPath $agentsMd -Raw
$coworkerText = Get-Content -LiteralPath $coworkerDoc -Raw
$tieringText = Get-Content -LiteralPath $tieringDoc -Raw
$scriptOwnedText = Get-Content -LiteralPath $scriptOwnedDoc -Raw

$forbiddenInAgents = @(
    '## Task complexity tier rubric',
    '## Per-tier draft-review flow',
    '**Worked example.**',
    'git diff <base-ref>...HEAD > /tmp/review.diff',
    '## Script-owned review pipeline (documentation)'
)

$failures = [System.Collections.Generic.List[string]]::new()
foreach ($pattern in $forbiddenInAgents) {
    if ($agentsText.Contains($pattern)) {
        $failures.Add("AGENTS.md still contains moved deep-dive anchor: $pattern")
    }
}

$requiredInCoworker = @(
    'PR diff recipe',
    'git diff <base-ref>...HEAD > /tmp/review.diff',
    'Root-cause work must read ~900 lines'
)

foreach ($pattern in $requiredInCoworker) {
    if (-not $coworkerText.Contains($pattern)) {
        $failures.Add("docs/coworker-delegation.md missing required content: $pattern")
    }
}

$requiredInTiering = @(
    '## Task complexity tier rubric',
    '### Red-flag markers (any one → T3)',
    '## Per-tier draft-review flow',
    '### Per-tier pipeline (ceilings, not quotas)'
)

foreach ($pattern in $requiredInTiering) {
    if (-not $tieringText.Contains($pattern)) {
        $failures.Add("docs/tiering.md missing required content: $pattern")
    }
}

$requiredInScriptOwned = @(
    '## Event-driven review trigger',
    '## Orchestrator review-run coverage',
    '## Head ready for review',
    'event-driven review trigger'
)

foreach ($pattern in $requiredInScriptOwned) {
    if (-not $scriptOwnedText.Contains($pattern)) {
        $failures.Add("docs/script-owned-review-pipeline.md missing required content: $pattern")
    }
}

$stableTitles = @(
    '## Coworker CLI delegation',
    '## RTK read-exploration',
    '## RCA spec discipline'
)

foreach ($title in $stableTitles) {
    if (-not $agentsText.Contains($title)) {
        $failures.Add("AGENTS.md missing pointer-stable title: $title")
    }
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] AGENTS.md moved-content guard:'
    foreach ($item in $failures) {
        Write-Host " - $item"
    }
    exit 1
}

Write-Host '[PASS] AGENTS.md moved-content guard (split layout and stable titles)'
exit 0
