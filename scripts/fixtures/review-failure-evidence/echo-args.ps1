#Requires -Version 5.1
param()
$joined = ($args | ForEach-Object { [string]$_ }) -join '|'
[Console]::Out.Write($joined)
exit 0
