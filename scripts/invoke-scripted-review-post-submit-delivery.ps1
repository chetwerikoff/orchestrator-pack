#requires -Version 5.1
<#
.SYNOPSIS
  Pack scripted PR-review post-submit delivery seam (Issue #669).

.DESCRIPTION
  Called after ao review submit in the scripted review path. Forwards stdin and CLI
  arguments to scripted-review-confirmed-delivery-gate.ps1.
#>
$ErrorActionPreference = 'Stop'
$gateScript = Join-Path $PSScriptRoot 'scripted-review-confirmed-delivery-gate.ps1'
if (-not (Test-Path -LiteralPath $gateScript -PathType Leaf)) {
    throw "Missing $gateScript"
}

$payload = [Console]::In.ReadToEnd()
if ($null -eq $payload) { $payload = '' }

$payload | pwsh -NoProfile -File $gateScript @args
exit $LASTEXITCODE
