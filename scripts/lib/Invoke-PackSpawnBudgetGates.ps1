#requires -Version 5.1
<#
  Pack spawn-budget gate implementations (Issues #462 / #480).
#>

. (Join-Path $PSScriptRoot 'Initialize-PackGateCheck.ps1')

function Invoke-AutonomousSpawnBudgetGate {
    param([string]$RepoRoot = '')

    Invoke-PackGateInventoryScript -RepoRoot $RepoRoot -CallerScriptRoot (Split-Path -Parent $PSScriptRoot) -PassLabel 'autonomous spawn budget inventory' -Body {
        param(
            [string]$RepoRoot,
            [System.Collections.Generic.List[string]]$Violations
        )

        $requiredPaths = @(
            'docs/autonomous-spawn-budget.json',
            'docs/autonomous-spawn-budget.mjs',
            'scripts/lib/autonomous-guard-fast-path.sh',
            'scripts/autonomous-spawn-budget.test.ts',
            'scripts/_test-spawn-budget-fixture.ts'
        )

        foreach ($relative in $requiredPaths) {
            $full = Join-Path $RepoRoot $relative
            if (-not (Test-Path -LiteralPath $full)) {
                $Violations.Add("missing $relative")
            }
        }

        $gitShim = Get-Content -LiteralPath (Join-Path $RepoRoot 'scripts/git') -Raw
        $aoShim = Get-Content -LiteralPath (Join-Path $RepoRoot 'scripts/ao') -Raw
        if ($gitShim -notmatch 'autonomous-guard-fast-path\.sh') {
            $Violations.Add('scripts/git must source autonomous-guard-fast-path.sh')
        }
        if ($aoShim -notmatch 'autonomous-guard-fast-path\.sh') {
            $Violations.Add('scripts/ao must source autonomous-guard-fast-path.sh')
        }
        if ($gitShim -notmatch '__ao_autonomous_git_argv_is_read_only') {
            $Violations.Add('scripts/git must use read-only git fast path helper')
        }
        if ($aoShim -notmatch '__ao_autonomous_ao_argv_is_read_fast_path') {
            $Violations.Add('scripts/ao must use read-only ao fast path helper')
        }

        $budgetCli = Join-Path $RepoRoot 'docs/autonomous-spawn-budget.mjs'
        if (Test-Path -LiteralPath $budgetCli) {
            Push-Location $RepoRoot
            try {
                $validate = node --input-type=module -e "import { loadAutonomousSpawnBudget } from './docs/autonomous-spawn-budget.mjs'; const result = loadAutonomousSpawnBudget('.'); if (!result.ok) { console.error(result.reason); process.exit(1); }" 2>&1
                if ($LASTEXITCODE -ne 0) {
                    $Violations.Add("spawn budget manifest validation failed: $validate")
                }
            }
            finally {
                Pop-Location
            }
        }
    }
}

function Invoke-ReviewPipelineSpawnBudgetGate {
    param([string]$RepoRoot = '')

    Invoke-PackGateInventoryScript -RepoRoot $RepoRoot -CallerScriptRoot (Split-Path -Parent $PSScriptRoot) -PassLabel 'review-pipeline spawn budget inventory' -Body {
        param(
            [string]$RepoRoot,
            [System.Collections.Generic.List[string]]$Violations
        )

        $requiredPaths = @(
            'docs/review-pipeline-spawn-budget.json',
            'docs/review-pipeline-spawn-budget.mjs',
            'docs/review-start-repeat-classifier.mjs',
            'scripts/review-pipeline-spawn-budget.test.ts',
            'scripts/review-start-repeat-classifier.test.ts',
            'scripts/generate-review-pipeline-spawn-captures.ts',
            'tests/external-output-references/review-pipeline-spawn-budget/capture-wrapped-positive-uncovered-ready.json',
            'tests/external-output-references/review-pipeline-spawn-budget/capture-wrapped-positive-covered-clean.json',
            'tests/external-output-references/review-pipeline-spawn-budget/storm-baseline.capture.json',
            'tests/external-output-references/review-pipeline-spawn-budget/reduced-post-change.capture.json'
        )

        foreach ($relative in $requiredPaths) {
            $full = Join-Path $RepoRoot $relative
            if (-not (Test-Path -LiteralPath $full)) {
                $Violations.Add("missing $relative")
            }
        }

        Push-Location $RepoRoot
        try {
            $validate = node --input-type=module -e "import { verifyCommittedCaptureReplays } from './docs/review-pipeline-spawn-budget.mjs'; const result = verifyCommittedCaptureReplays('.'); if (!result.ok) { console.error(result.reason); process.exit(1); }" 2>&1
            if ($LASTEXITCODE -ne 0) {
                $Violations.Add("capture replay verification failed: $validate")
            }
        }
        finally {
            Pop-Location
        }
    }
}
