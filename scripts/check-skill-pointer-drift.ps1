[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/Skill-Pointer.ps1')
Initialize-SkillPointerScript -ScriptLeafName 'check-skill-pointer-drift.ps1'

$Root = Resolve-SkillPointerRepoRoot -RepoRoot $RepoRoot

$config = Get-SkillPointerConfig -Root $Root
$failures = Test-SkillPointerDrift -Root $Root -Config $config

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] Skill pointer drift detected:'
    foreach ($failure in $failures) {
        Write-Host "  - $failure"
    }
    exit 1
}

Write-Host '[PASS] Skill pointers match canonical sources (no drift).'
exit 0
