#requires -Version 5.1
& (Join-Path $PSScriptRoot 'lib/Test-WorkerNudgeGateWiring.ps1') @args
exit $LASTEXITCODE
