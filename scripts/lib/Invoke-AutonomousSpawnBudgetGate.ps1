#requires -Version 5.1
<#
  Autonomous spawn budget gate implementation (Issue #462).
#>

function Invoke-AutonomousSpawnBudgetGate {
    param(
        [string]$RepoRoot = ''
    )

    . (Join-Path $PSScriptRoot 'Initialize-PackGateCheck.ps1')
    $gate = Initialize-PackGateCheck -RepoRoot $RepoRoot -CallerScriptRoot (Split-Path -Parent $PSScriptRoot)
    $RepoRoot = $gate.RepoRoot
    $violations = $gate.Violations

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
            $violations.Add("missing $relative")
        }
    }

    $gitShim = Get-Content -LiteralPath (Join-Path $RepoRoot 'scripts/git') -Raw
    $aoShim = Get-Content -LiteralPath (Join-Path $RepoRoot 'scripts/ao') -Raw
    if ($gitShim -notmatch 'autonomous-guard-fast-path\.sh') {
        $violations.Add('scripts/git must source autonomous-guard-fast-path.sh')
    }
    if ($aoShim -notmatch 'autonomous-guard-fast-path\.sh') {
        $violations.Add('scripts/ao must source autonomous-guard-fast-path.sh')
    }
    if ($gitShim -notmatch '__ao_autonomous_git_argv_is_read_only') {
        $violations.Add('scripts/git must use read-only git fast path helper')
    }
    if ($aoShim -notmatch '__ao_autonomous_ao_argv_is_read_fast_path') {
        $violations.Add('scripts/ao must use read-only ao fast path helper')
    }

    $budgetCli = Join-Path $RepoRoot 'docs/autonomous-spawn-budget.mjs'
    if (Test-Path -LiteralPath $budgetCli) {
        Push-Location $RepoRoot
        try {
            $validate = node --input-type=module -e "import { loadAutonomousSpawnBudget } from './docs/autonomous-spawn-budget.mjs'; const result = loadAutonomousSpawnBudget('.'); if (!result.ok) { console.error(result.reason); process.exit(1); }" 2>&1
            if ($LASTEXITCODE -ne 0) {
                $violations.Add("spawn budget manifest validation failed: $validate")
            }
        }
        finally {
            Pop-Location
        }
    }

    Write-PackGateCheckResult -Label 'autonomous spawn budget inventory' -Violations $violations
}
