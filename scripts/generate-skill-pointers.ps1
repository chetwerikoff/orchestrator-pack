[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/Skill-Pointer.ps1')
Initialize-SkillPointerScript -ScriptLeafName 'generate-skill-pointers.ps1'

$Root = Resolve-SkillPointerRepoRoot -RepoRoot $RepoRoot

$config = Get-SkillPointerConfig -Root $Root
$expected = Get-ExpectedSkillPointerMap -Root $Root -Config $config
Write-SkillPointers -Root $Root -ExpectedMap $expected

Write-Host ("[PASS] Generated {0} skill pointer file(s)." -f $expected.Count)
exit 0
