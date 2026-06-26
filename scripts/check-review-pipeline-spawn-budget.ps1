#requires -Version 5.1
<#
  CI drift guard for orchestrator review-pipeline aggregate spawn budget (Issue #480).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Autonomous-GateCommon.ps1')

$RepoRoot = Resolve-PackGateRepoRoot -RepoRoot $RepoRoot -CallerScriptRoot $PSScriptRoot
$violations = [System.Collections.Generic.List[string]]::new()

$requiredPaths = @(
    'docs/review-pipeline-spawn-budget.json',
    'docs/review-pipeline-spawn-budget.mjs',
    'docs/review-start-repeat-classifier.mjs',
    'scripts/review-pipeline-spawn-budget.test.ts',
    'scripts/review-start-repeat-classifier.test.ts',
    'scripts/generate-review-pipeline-spawn-captures.ts',
    'tests/fixtures/review-pipeline-spawn-budget/storm-baseline.capture.json',
    'tests/fixtures/review-pipeline-spawn-budget/reduced-post-change.capture.json'
)

foreach ($relative in $requiredPaths) {
    $full = Join-Path $RepoRoot $relative
    if (-not (Test-Path -LiteralPath $full)) {
        $violations.Add("missing $relative")
    }
}

Push-Location $RepoRoot
try {
    $validate = node --input-type=module -e "import { verifyCommittedCaptureReplays } from './docs/review-pipeline-spawn-budget.mjs'; const result = verifyCommittedCaptureReplays('.'); if (!result.ok) { console.error(result.reason); process.exit(1); }" 2>&1
    if ($LASTEXITCODE -ne 0) {
        $violations.Add("capture replay verification failed: $validate")
    }
}
finally {
    Pop-Location
}

if ($violations.Count -gt 0) {
    Write-Host 'review-pipeline spawn budget guard failed:'
    $violations | ForEach-Object { Write-Host " - $_" }
    exit 1
}

Write-Host '[PASS] review-pipeline spawn budget inventory'
exit 0
