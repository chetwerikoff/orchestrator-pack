#requires -Version 5.1
<#
.SYNOPSIS
  Emit pack-reviewer-resolution/v1 JSON for TypeScript selector consumers.
#>
[CmdletBinding()]
param(
    [string]$OverrideLayersJson,
    [switch]$HarnessEmulatePersistentLayers
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/Resolve-PackReviewer.ps1')

$overrideLayers = ConvertFrom-PackReviewerOverrideLayersJson -OverrideLayersJson $OverrideLayersJson
Export-PackReviewerResolutionJson -OverrideLayers $overrideLayers -HarnessEmulatePersistentLayers:$HarnessEmulatePersistentLayers
