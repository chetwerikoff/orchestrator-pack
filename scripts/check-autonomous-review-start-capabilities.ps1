#requires -Version 5.1
& (Join-Path $PSScriptRoot 'check-autonomous-capabilities.ps1') -ReviewStart @args
exit $LASTEXITCODE
