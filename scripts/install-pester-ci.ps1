#requires -Version 5.1
<#
.SYNOPSIS
  Install Pester 5+ once per CI runner (cache-friendly) without weakening version requirements.
#>
[CmdletBinding()]
param(
    [version]$MinimumVersion = '5.0.0'
)

$ErrorActionPreference = 'Stop'

$existing = Get-Module -ListAvailable -Name Pester |
    Where-Object { $_.Version -ge $MinimumVersion } |
    Sort-Object Version -Descending |
    Select-Object -First 1

if ($existing) {
    Import-Module Pester -MinimumVersion $MinimumVersion -ErrorAction Stop
    Write-Host "Pester already available: $($existing.Version)"
    exit 0
}

Write-Host "Installing Pester >= $MinimumVersion (cache miss)..."
Install-Module -Name Pester -MinimumVersion $MinimumVersion -Force -Scope CurrentUser -AllowClobber -SkipPublisherCheck
Import-Module Pester -MinimumVersion $MinimumVersion -ErrorAction Stop
Write-Host "Pester installed: $((Get-Module Pester).Version)"
exit 0
