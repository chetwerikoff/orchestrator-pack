#requires -Version 5.1
<#
.SYNOPSIS
  Shared status-line formatter for pack verification and test harness scripts.
#>
function Write-PackCheckLine {
    param(
        [string]$Name,
        [string]$Status,
        [string]$Detail = ''
    )
    $line = ('[{0}] {1}' -f $Status, $Name)
    if ($Detail) { $line = "$line - $Detail" }
    Write-Host $line
}
