#requires -Version 5.1
<#
  Review-pipeline spawn budget gate implementation (Issue #480).
#>

function Invoke-ReviewPipelineSpawnBudgetGate {
    param(
        [string]$RepoRoot = ''
    )

    . (Join-Path $PSScriptRoot 'Initialize-PackGateCheck.ps1')
    $gate = Initialize-PackGateCheck -RepoRoot $RepoRoot -CallerScriptRoot (Split-Path -Parent $PSScriptRoot)
    $RepoRoot = $gate.RepoRoot
    $violations = $gate.Violations

    $requiredPaths = @(
        'docs/review-pipeline-spawn-budget.json',
        'docs/review-pipeline-spawn-budget.mjs',
        'docs/review-start-repeat-classifier.mjs',
        'scripts/review-pipeline-spawn-budget.test.ts',
        'scripts/review-start-repeat-classifier.test.ts',
        'scripts/generate-review-pipeline-spawn-captures.ts',
        'tests/external-output-references/review-pipeline-spawn-budget/storm-baseline.capture.json',
        'tests/external-output-references/review-pipeline-spawn-budget/reduced-post-change.capture.json'
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

    Write-PackGateCheckResult -Label 'review-pipeline spawn budget inventory' -Violations $violations
}
