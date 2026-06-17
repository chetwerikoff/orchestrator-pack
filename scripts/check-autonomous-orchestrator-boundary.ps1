#requires -Version 5.1
& (Join-Path $PSScriptRoot 'check-autonomous-capabilities.ps1') -Boundary @args
exit $LASTEXITCODE
