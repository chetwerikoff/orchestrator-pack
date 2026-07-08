#requires -Version 5.1
<#
.SYNOPSIS
  Fail-closed aggregate for Issue #487/#556 CI pipeline split.
  Consumes upstream job results for the current workflow run and head SHA only.
#>
[CmdletBinding()]
param(
    [string]$TypecheckResult = $env:TYPECHECK_RESULT,
    [string]$VitestLightResult = $env:VITEST_LIGHT_RESULT,
    [string]$VitestHeavyResult = $env:VITEST_HEAVY_RESULT,
    [string]$PesterResult = $env:PESTER_RESULT,
    [string]$VitestTopologyPlanResult = $env:VITEST_TOPOLOGY_PLAN_RESULT,
    [string]$HeadSha = $env:GITHUB_SHA,
    [string]$RunId = $env:GITHUB_RUN_ID
)

$ErrorActionPreference = 'Stop'

$failures = [System.Collections.Generic.List[string]]::new()

function Test-JobResult {
    param(
        [string]$Name,
        [string]$Result
    )
    if (-not $Result) {
        $failures.Add("$Name result missing") | Out-Null
        return
    }
    switch ($Result) {
        'success' { return }
        'skipped' { $failures.Add("$Name unexpectedly skipped") | Out-Null }
        'cancelled' { $failures.Add("$Name cancelled") | Out-Null }
        'failure' { $failures.Add("$Name failed") | Out-Null }
        default { $failures.Add("$Name inconclusive ($Result)") | Out-Null }
    }
}

if (-not $HeadSha) {
    $failures.Add('GITHUB_SHA missing (current-head binding)') | Out-Null
}
if (-not $RunId) {
    $failures.Add('GITHUB_RUN_ID missing (current-run binding)') | Out-Null
}

Test-JobResult -Name 'typecheck' -Result $TypecheckResult
Test-JobResult -Name 'vitest-light' -Result $VitestLightResult
Test-JobResult -Name 'vitest-heavy-shards' -Result $VitestHeavyResult
Test-JobResult -Name 'pester' -Result $PesterResult
Test-JobResult -Name 'vitest-topology-plan' -Result $VitestTopologyPlanResult

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] full-regression aggregate:'
    foreach ($item in $failures) {
        Write-Host " - $item"
    }
    exit 1
}

Write-Host "[PASS] full-regression aggregate sha=$HeadSha run=$RunId"
exit 0
