#requires -Version 5.1
<#
  CI drift guard for autonomous respawn policy (Issue #593).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
$RepoRoot = if ($RepoRoot) { $RepoRoot } else { Split-Path -Parent $PSScriptRoot }
$policyPath = Join-Path $RepoRoot 'docs/autonomous-respawn-policy.json'
$violations = [System.Collections.Generic.List[string]]::new()

if (-not (Test-Path -LiteralPath $policyPath)) {
    $violations.Add('missing docs/autonomous-respawn-policy.json')
}
else {
    try {
        $policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
        if ($policy.version -ne 'autonomous-respawn-policy/v1') {
            $violations.Add('respawn policy version must be autonomous-respawn-policy/v1')
        }
        if ($policy.allowReconcileDeadWorkerRespawn -ne $false) {
            $violations.Add('respawn policy must default allowReconcileDeadWorkerRespawn=false')
        }
        foreach ($key in @('maxAttempts', 'backoffMs', 'concurrency', 'shutdownSuppressionWindowMs')) {
            if ($null -eq $policy.$key) {
                $violations.Add("respawn policy missing configured bound: $key")
            }
        }
    }
    catch {
        $violations.Add("respawn policy malformed: $_")
    }
}

if ($violations.Count -gt 0) {
    Write-Host 'autonomous respawn policy guard failed:'
    $violations | ForEach-Object { Write-Host " - $_" }
    exit 1
}

Write-Host '[PASS] autonomous respawn policy inventory'
exit 0
