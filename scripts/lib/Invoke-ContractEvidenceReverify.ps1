#requires -Version 5.1
<#
.SYNOPSIS
  Trusted-base implementation for checkpoint-2 contract-evidence re-verification (Issue #376).

  Prefer launch-contract-evidence-reverify.ps1 from trusted pack root; this script
  dot-sources the shared core for direct lib-path invocation.
#>
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Contract-EvidenceReverify-Core.ps1')
Invoke-ContractEvidenceReverifyCore @args
exit $LASTEXITCODE
