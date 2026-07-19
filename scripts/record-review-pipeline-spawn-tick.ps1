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
    $runner = Join-Path $PackRoot 'scripts/generate-review-pipeline-spawn-captures.ts'
    . (Join-Path $PackRoot 'scripts/lib/Invoke-TypeScriptCli.ps1')
    $nodeArgs = Get-OpkTypeScriptNodeArguments -ScriptPath $runner
    & node @nodeArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}
