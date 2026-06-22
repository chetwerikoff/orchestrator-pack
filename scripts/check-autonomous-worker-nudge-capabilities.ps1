#requires -Version 5.1
& (Join-Path $PSScriptRoot 'check-autonomous-worker-nudge-capabilities-core.ps1') @args
exit $LASTEXITCODE
