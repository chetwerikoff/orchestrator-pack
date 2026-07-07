#requires -Version 5.1
<#
.SYNOPSIS
  Moved-content guard: deep-dive anchors must not remain in prompts/agent_rules.md (Issue #654).
#>
param(
    [string]$RepoRoot
)

. (Join-Path $PSScriptRoot 'lib/Initialize-PackGateCheck.ps1')
$gate = Initialize-PackGateCheck -RepoRoot $RepoRoot -CallerScriptRoot $PSScriptRoot
$RepoRoot = $gate.RepoRoot

$agentRules = Join-Path $RepoRoot 'prompts/agent_rules.md'
$coworkerDoc = Join-Path $RepoRoot 'docs/coworker-delegation.md'
$tieringDoc = Join-Path $RepoRoot 'docs/tiering.md'

foreach ($path in @($agentRules, $coworkerDoc, $tieringDoc)) {
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "[FAIL] missing required file: $path"
        exit 1
    }
}

$rulesText = Get-Content -LiteralPath $agentRules -Raw
$coworkerText = Get-Content -LiteralPath $coworkerDoc -Raw
$tieringText = Get-Content -LiteralPath $tieringDoc -Raw

$forbiddenInRules = @(
    '## Task complexity tier rubric',
    '## Per-tier draft-review flow',
    '**Worked example.**',
    'git diff <base-ref>...HEAD > /tmp/review.diff'
)

$failures = [System.Collections.Generic.List[string]]::new()
foreach ($pattern in $forbiddenInRules) {
    if ($rulesText.Contains($pattern)) {
        $failures.Add("prompts/agent_rules.md still contains moved deep-dive anchor: $pattern")
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

$preambleMarkers = @(
    'worker-LLM behavioral contract',
    'New CI checks must NOT require mirror phrases'
)

foreach ($pattern in $preambleMarkers) {
    if (-not $rulesText.Contains($pattern)) {
        $failures.Add("prompts/agent_rules.md missing admission-policy marker: $pattern")
    }
}

$stableTitles = @(
    '## Coworker CLI delegation',
    '## RTK read-exploration',
    '## RCA spec discipline'
)

foreach ($title in $stableTitles) {
    if (-not $rulesText.Contains($title)) {
        $failures.Add("prompts/agent_rules.md missing pointer-stable title: $title")
    }
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] agent-rules moved-content guard:'
    foreach ($item in $failures) {
        Write-Host " - $item"
    }
    exit 1
}

Write-Host '[PASS] agent-rules moved-content guard (split layout and preamble markers)'
exit 0
