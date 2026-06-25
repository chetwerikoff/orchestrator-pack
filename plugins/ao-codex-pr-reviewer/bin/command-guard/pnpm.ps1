#requires -Version 5.1
& "$PSScriptRoot\_invoke-guard.ps1" pnpm @args
exit $LASTEXITCODE
