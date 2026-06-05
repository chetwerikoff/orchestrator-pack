#requires -Version 5.1
<#
.SYNOPSIS
  Shared path-existence guard for pack regression check scripts.
#>

function Assert-RequiredPathsExist {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Paths
    )

    foreach ($path in $Paths) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            Write-Host "Missing required file: $path"
            exit 1
        }
    }
}
