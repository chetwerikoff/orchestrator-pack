#requires -Version 5.1
<#
  Record real-main review-pipeline spawn captures (Issue #480).
  Delegates to scripts/generate-review-pipeline-spawn-captures.ts
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
$PackRoot = if ($RepoRoot) { $RepoRoot } else { Split-Path -Parent $PSScriptRoot }
Push-Location $PackRoot
try {
    & npx tsx (Join-Path $PackRoot 'scripts/generate-review-pipeline-spawn-captures.ts')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}
