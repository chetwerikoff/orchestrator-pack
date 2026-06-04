[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host '[FAIL] scripts/check-skill-pointer-drift.ps1 requires PowerShell 7+ (pwsh).'
    exit 1
}

. (Join-Path $PSScriptRoot 'lib/Skill-Pointer.ps1')

$Root = $RepoRoot
if (-not $Root) {
    $Root = Split-Path -Parent $PSScriptRoot
}

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
