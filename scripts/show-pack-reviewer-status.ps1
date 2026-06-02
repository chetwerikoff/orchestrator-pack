#requires -Version 5.1
<#
.SYNOPSIS
  Show PACK_REVIEWER layers and the value pack review would use.
.PARAMETER Expected
  If set (codex | claude), exit 0 only when effective reviewer matches.
#>
[CmdletBinding()]
param(
    [ValidateSet('codex', 'claude')]
    [string]$Expected
)

$ErrorActionPreference = 'Stop'

# Cursor/agent parent shells may inject process-scoped PACK_REVIEWER; report User-first effective value.
Remove-Item Env:PACK_REVIEWER -ErrorAction SilentlyContinue

$libRoot = Join-Path $PSScriptRoot 'lib'
. (Join-Path $libRoot 'Resolve-PackReviewer.ps1')

function Get-LayerDisplayValue {
    param([string]$Target)
    $value = [Environment]::GetEnvironmentVariable('PACK_REVIEWER', $Target)
    if ([string]::IsNullOrWhiteSpace($value)) {
        return '(not set)'
    }
    return $value
}

$processRaw = [Environment]::GetEnvironmentVariable('PACK_REVIEWER', 'Process')
$userRaw = [Environment]::GetEnvironmentVariable('PACK_REVIEWER', 'User')
$machineRaw = [Environment]::GetEnvironmentVariable('PACK_REVIEWER', 'Machine')
$effective = Get-PackReviewerFromSelector
$wrapper = if ($effective) { Get-PackReviewWrapperBasenameForReviewer -Reviewer $effective } else { '(none)' }

Write-Host 'PACK_REVIEWER layers (Windows: Process overrides User overrides Machine):'
Write-Host ('  Process:  {0}' -f (Get-LayerDisplayValue -Target 'Process'))
Write-Host ('  User:     {0}' -f (Get-LayerDisplayValue -Target 'User'))
Write-Host ('  Machine:  {0}' -f (Get-LayerDisplayValue -Target 'Machine'))
Write-Host ''
Write-Host ('Effective (invoke-pack-review.ps1): {0}' -f ($(if ($effective) { $effective } else { '(fail-closed — not set)' })))
Write-Host ('Wrapper:                            {0}' -f $wrapper)

$warnings = @()
if (-not [string]::IsNullOrWhiteSpace($processRaw) -and -not [string]::IsNullOrWhiteSpace($userRaw)) {
    $p = $processRaw.Trim().ToLowerInvariant()
    $u = $userRaw.Trim().ToLowerInvariant()
    if ($p -ne $u) {
        $warnings += "Process ($processRaw) overrides User ($userRaw) — global User is ignored until Process is cleared."
    }
}
if ($warnings.Count -gt 0) {
    Write-Host ''
    Write-Host 'Warnings:'
    foreach ($w in $warnings) {
        Write-Host "  ! $w"
    }
}

if ($Expected) {
    if ($effective -eq $Expected) {
        Write-Host ''
        Write-Host "[PASS] Effective reviewer is $Expected."
        exit 0
    }

    Write-Host ''
    Write-Host "[FAIL] Expected $Expected but effective is $(if ($effective) { $effective } else { 'unset' })."
    exit 1
}

if (-not $effective) {
    exit 1
}

exit 0
