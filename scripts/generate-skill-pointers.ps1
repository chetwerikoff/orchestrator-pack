[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host '[FAIL] scripts/generate-skill-pointers.ps1 requires PowerShell 7+ (pwsh).'
    exit 1
}

. (Join-Path $PSScriptRoot 'lib/Skill-Pointer.ps1')

$Root = $RepoRoot
if (-not $Root) {
    $Root = Split-Path -Parent $PSScriptRoot
}

$config = Get-SkillPointerConfig -Root $Root
$expected = Get-ExpectedSkillPointerMap -Root $Root -Config $config
Write-SkillPointers -Root $Root -ExpectedMap $expected

Write-Host ("[PASS] Generated {0} skill pointer file(s)." -f $expected.Count)
exit 0
