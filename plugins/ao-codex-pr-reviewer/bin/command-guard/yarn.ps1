#requires -Version 5.1
& "$PSScriptRoot\_invoke-guard.ps1" yarn @args
exit $LASTEXITCODE
